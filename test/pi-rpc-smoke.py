#!/usr/bin/env python3
"""Real Pi RPC client with a deterministic model and native select replies."""
import ast
import os
import json
from pathlib import Path
import queue
import re
import subprocess
import tempfile
import threading
import time
import uuid

# Reuse the same deterministic model as the fullscreen smoke without importing pyte.
ROOT = Path(__file__).resolve().parents[1]
PROVIDER = next(ast.literal_eval(node.value) for node in ast.parse((ROOT / 'test/pi-smoke.py').read_text()).body
                if isinstance(node, ast.Assign) and any(isinstance(name, ast.Name) and name.id == 'PROVIDER' for name in node.targets))
NAME = '/worktree-preview'


class PiRPC:
    def __init__(self, cwd, agent, provider, session=None):
        self.events = queue.Queue()
        self.inbox = []
        self.process = subprocess.Popen([
            'pi', '--mode', 'rpc', '--no-mcp', '-ns', '-np', '-na', '-ne', '-e', str(ROOT / 'src/index.ts'),
            '-e', str(provider), '--provider', 'wtp-smoke', '--model', 'model',
            *(['--session', str(session)] if session else []),
        ], cwd=cwd, env={**os.environ, 'PI_CODING_AGENT_DIR': str(agent)},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
        def listen():
            for line in self.process.stdout:
                try:
                    self.events.put(json.loads(line))
                except ValueError:
                    self.events.put({'stdout': line})
            self.events.put(None)
        threading.Thread(target=listen, daemon=True).start()

    def send(self, kind, **values):
        identifier = str(uuid.uuid4())
        self.write({'type': kind, 'id': identifier, **values})
        return identifier

    def write(self, event):
        self.process.stdin.write(json.dumps(event) + '\n')
        self.process.stdin.flush()

    def wait(self, match, timeout=45):
        deadline = time.monotonic() + timeout
        while True:
            for i, event in enumerate(self.inbox):
                if match(event):
                    return self.inbox.pop(i)
            try:
                event = self.events.get(timeout=max(0, deadline - time.monotonic()))
            except queue.Empty:
                raise AssertionError(f'Missing RPC event. Last events: {self.inbox[-20:]}') from None
            if event is None:
                raise AssertionError(f'Pi RPC exited: {self.process.stderr.read()} {self.inbox[-20:]}')
            assert not (event.get('type') == 'extension_ui_request' and event.get('method') in {
                'confirm', 'input', 'editor',
            }), event
            self.inbox.append(event)

    def reply(self, identifier):
        event = self.wait(lambda e: e.get('type') == 'response' and e.get('id') == identifier)
        assert event['success'], event
        return event.get('data')

    def notice(self, kind):
        prefix = f'worktree-preview {kind}: '
        event = self.wait(lambda e: e.get('method') == 'notify' and e.get('message', '').startswith(prefix))
        return event['message'][len(prefix):]

    def command(self, args, kind='ok', legacy=False):
        separator = ' ' if legacy or args == 'help' else '-'
        identifier = self.send('prompt', message=f'{NAME}{separator}{args}')
        assert self.reply(identifier)['disposition'] == 'handled'
        return self.notice(kind)

    def state(self):
        return self.reply(self.send('get_state'))

    def status(self):
        return json.loads(self.command('status'))

    def status_line(self, contains):
        return self.wait(lambda e: e.get('method') == 'setStatus' and e.get('statusKey') == 'worktree-preview'
                         and contains in e.get('statusText', ''))

    def challenge(self, verb):
        name, _, rest = verb.partition(' ')
        detail = self.command(f'{name} --text {rest}'.strip(), 'confirm')
        return re.search(r'/worktree-preview-confirm ([a-f0-9-]+)', detail)[1], detail

    def ask(self, args, *, cancel_label='取消'):
        identifier = self.send('prompt', message=f'{NAME}-{args}')
        dialog = self.wait(lambda e: e.get('type') == 'extension_ui_request' and e.get('method') == 'select')
        assert dialog['options'][0] == cancel_label and len(dialog['options']) == 2 and dialog['timeout'] == 300_000, dialog
        assert not any(e.get('id') == identifier and e.get('type') == 'response' for e in self.inbox)
        return identifier, dialog

    def answer(self, request, *, choice=None, cancel=False, kind='ok'):
        identifier, dialog = request
        result = {'cancelled': True} if cancel else {'value': dialog['options'][1] if choice is None else choice}
        self.write({'type': 'extension_ui_response', 'id': dialog['id'], **result})
        assert self.reply(identifier)['disposition'] == 'handled'
        return self.notice(kind)

    def act(self, args):
        return self.answer(self.ask(args))

    def start_turn(self, message):
        identifier = self.send('prompt', message=message)
        assert self.reply(identifier)['disposition'] == 'started'

    def finish_turn(self, text):
        self.wait(lambda e: e.get('type') == 'agent_settled')
        self.wait(lambda e: e.get('type') == 'message_end' and e.get('message', {}).get('role') == 'assistant'
                  and any(c.get('text') == text for c in e['message'].get('content', [])))

    def revision_ask(self):
        request = self.wait(lambda e: e.get('method') == 'select')
        assert request['options'] == ['取消', '撤回预览，继续返修'] and request['timeout'] == 300_000, request
        return request

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        self.process.stdout.close()
        self.process.stderr.close()


def git(cwd, *args):
    return subprocess.check_output(['git', '-C', str(cwd), *args], text=True,
                                   env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0'}).strip()


def main():
    with tempfile.TemporaryDirectory(prefix='pi-wtp-rpc-') as folder:
        root = Path(folder).resolve()
        provider = root / 'offline.ts'
        provider.write_text(PROVIDER)
        (root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
        repo, agent = root / 'target with spaces', root / 'agent'
        repo.mkdir()
        agent.mkdir()
        git(repo, 'init', '-q', '-b', 'main')
        git(repo, 'config', 'user.name', 'RPC Test')
        git(repo, 'config', 'user.email', 'rpc@example.invalid')
        target_file = repo / 'task.txt'
        target_file.write_text('base\n')
        git(repo, 'add', '.')
        git(repo, 'commit', '-m', 'base')
        head = git(repo, 'rev-parse', 'HEAD')
        record = agent / 'worktree-preview/tasks.json'
        with PiRPC(repo, agent, provider) as pi:
            pi.start_turn('Edit in an ordinary conversation.')
            pi.finish_turn('Write succeeded.')
            ordinary = repo / 'ordinary.txt'
            assert ordinary.read_text() == 'ordinary edit' and not record.exists()
            ordinary.unlink()
            # A resumed model can remember the old tool name even when it is
            # not declared; the miscall must not affect its next normal write.
            pi.start_turn('Old transcript mistakenly calls revision.')
            pi.finish_turn('Write succeeded.')
            assert ordinary.read_text() == 'ordinary edit' and not record.exists()
            assert not any(e.get('method') == 'select' for e in pi.inbox)
            ordinary.unlink()
            origin = pi.state()
            verbs = ['new', 'status', 'resume', 'back', 'preview', 'recover', 'rollback', 'commit', 'discard', 'adopt', 'confirm', 'cancel', 'language']
            available = pi.reply(pi.send('get_commands'))['commands']
            extensions = {cmd['name']: cmd for cmd in available if cmd['source'] == 'extension'}
            assert 'worktree-preview' in extensions
            assert all(extensions[f'worktree-preview-{verb}']['description'] for verb in verbs)
            help_lines = pi.command('help').splitlines()
            assert [line.split()[0] for line in help_lines[1:]] == [f'{NAME}-{verb}' for verb in verbs]
            assert pi.command('status', legacy=True) == pi.command('status')
            pi.command('new')
            assert pi.status()['armed'] and not record.exists()
            pi.command('cancel')
            assert not pi.status()['armed']
            pi.command('new')
            sent = 'Edit task.txt and mark ready.'
            assert pi.reply(pi.send('prompt', message=sent))['disposition'] == 'handled'
            pi.notice('ok')
            pi.wait(lambda e: e.get('type') == 'agent_settled')
            current = pi.status()
            assert current['phase'] == 'ready' and not current['external'], current
            isolated = Path(current['source'])
            child = pi.state()
            assert child['sessionId'] != origin['sessionId']
            contents = target_file.read_text(), (isolated / 'task.txt').read_text()
            assert contents == ('base\n', 'task edit\n'), (contents, current)
            assert pi.command('language') == '显示语言：简体中文'
            assert '用法' in pi.command('language fr', 'error')
            assert pi.command('language en') == 'Display language: English'
            assert pi.status() == current  # Protocol keys, paths and review stay unchanged.
            available = pi.reply(pi.send('get_commands'))['commands']
            descriptions = {c['name']: c.get('description') for c in available if c['source'] == 'extension'}
            assert descriptions['worktree-preview'] == 'Open the Worktree menu; use help to list commands'
            assert descriptions['worktree-preview-preview'] == 'Start previewing changes'
            request = pi.ask('preview', cancel_label='Cancel')
            assert 'Preview changes?' in request[1]['title'], request[1]
            assert pi.answer(request, cancel=True) == 'The operation was not performed.'
            assert target_file.read_text() == 'base\n' and git(repo, 'rev-parse', 'HEAD') == head
            with PiRPC(repo, agent, provider) as visitor:
                assert visitor.command('language') == 'Display language: English'
            assert pi.command('language zh') == '显示语言：简体中文'
            def user_messages(state):
                return [m for line in Path(state['sessionFile']).read_text().splitlines()
                        if (m := json.loads(line).get('message', {})).get('role') == 'user']
            assert not any(sent in json.dumps(m) for m in user_messages(origin))
            assert sum(sent in json.dumps(m) for m in user_messages(child)) == 1
            # Visiting a managed checkout in another native session holds its
            # cleanup lease, but does not bind the conversation to that task.
            with PiRPC(isolated, agent, provider) as visitor:
                assert visitor.state()['sessionId'] != child['sessionId']
                visitor.start_turn('Edit in an ordinary conversation.')
                visitor.finish_turn('Write succeeded.')
                ordinary = isolated / 'ordinary.txt'
                assert ordinary.read_text() == 'ordinary edit'
                ordinary.unlink()
            pi.command('back')
            assert pi.state()['sessionId'] == origin['sessionId']
            pi.start_turn('Edit in an ordinary conversation.')
            pi.finish_turn('Write succeeded.')
            ordinary = repo / 'ordinary.txt'
            assert ordinary.read_text() == 'ordinary edit'
            ordinary.unlink()
            pi.command('resume')
            assert pi.state()['sessionId'] == child['sessionId']
            token, detail = pi.challenge('preview')
            assert 'task.txt' in detail and str(repo) in detail and target_file.read_text() == 'base\n'
            assert pi.command('language en') == 'Display language: English'
            assert pi.command('language zh') == '显示语言：简体中文'
            with PiRPC(repo, agent, provider) as unrelated:
                assert unrelated.status()['phase'] == 'none'
                unrelated.command(f'confirm {token}', 'error')
            pi.command(f'confirm {token}')
            assert git(repo, 'rev-parse', 'HEAD') == head and target_file.read_text() == 'task edit\n'
            pi.command(f'confirm {token}', 'error')
            pi.act('rollback')
            assert target_file.read_text() == 'base\n'
            cancelled = pi.ask('preview')
            assert target_file.read_text() == 'base\n'
            assert '未执行' in pi.answer(cancelled, cancel=True)
            assert target_file.read_text() == 'base\n'
            request = pi.ask('preview')
            assert request[1]['id'] != cancelled[1]['id']
            pi.write({'type': 'extension_ui_response', 'id': cancelled[1]['id'], 'value': '预览'})
            assert '未执行' in pi.answer(request, choice='不是批准选项')
            assert target_file.read_text() == 'base\n'
            pi.act('preview')
            pi.act('commit')
            assert pi.state()['sessionId'] == origin['sessionId']
            assert not isolated.exists() and git(repo, 'log', '-1', '--format=%s') == 'Isolated smoke change'
            pi.command('new')
            assert pi.reply(pi.send('prompt', message='/var/folders/pi-clipboard-regression.png Open a task to discard.'))['disposition'] == 'handled'
            pi.notice('ok')
            pi.wait(lambda e: e.get('type') == 'agent_settled')
            discarded = Path(pi.status()['source'])
            pi.act('discard')
            assert not discarded.exists() and pi.status()['phase'] == 'discarded'
        print('PASS real Pi RPC: command-only new/back/resume, single-use approval, preview/rollback/commit/discard', flush=True)

        source = root / 'external source with spaces'
        git(repo, 'worktree', 'add', '-b', 'external', '--', str(source))
        base = git(repo, 'rev-parse', 'HEAD')
        source_file = source / 'task.txt'
        subdir = source / 'subdir'
        subdir.mkdir()
        source_file.write_text('external change\n')
        (source / 'source only.txt').write_text('do not deliver\n')
        git(source, 'add', 'source only.txt')
        source_status = git(source, 'status', '--porcelain=v1')
        req = json.dumps({'source': str(source), 'target': str(repo), 'base': base,
                          'title': 'Adopt selected external change', 'files': ['task.txt']})
        # Start from an external cwd as a real RPC client would. That exact Pi
        # session becomes the owner, without changing its cwd or parent.
        # Reproduce clients that wrap read/edit under their usual names. Use
        # the actual Pi implementations so both path resolution and edits are real.
        provider = root / 'offline-with-client-tools.ts'
        provider.write_text(PROVIDER.replace('export default function(pi) {', '''
import { createReadToolDefinition, createEditToolDefinition } from '@earendil-works/pi-coding-agent';
export default function(pi) {
  pi.registerTool(createReadToolDefinition(process.cwd()));
  pi.registerTool(createEditToolDefinition(process.cwd()));
''', 1))
        with PiRPC(repo, agent, provider) as pi:
            assert 'linked Worktree' in pi.command('adopt', 'error')
            pi.act(f'adopt {req}')
            pi.start_turn('Try to write during review.')
            pi.finish_turn('Write succeeded.')
            assert (repo / 'forbidden.txt').read_text() == 'must not be written'
            pi.start_turn('Edit in an ordinary conversation.')
            pi.finish_turn('Write succeeded.')
            shell = pi.reply(pi.send('bash', command='rm forbidden.txt ordinary.txt', excludeFromContext=True))
            assert shell['exitCode'] == 0
            assert not (repo / 'forbidden.txt').exists() and target_file.read_text() == 'task edit\n'
            pi.act('discard')
        with PiRPC(subdir, agent, provider) as pi:
            origin = pi.state()
            listing = pi.command('adopt')
            pi.status_line(f'下一步：{NAME}-preview')
            assert str(source) in listing and str(repo) in listing and base in listing
            assert '可直接运行' in listing and '-confirm' not in listing
            assert pi.state()['sessionId'] == origin['sessionId']
            assert pi.status()['phase'] == 'ready' and pi.status()['ready'] == ['source only.txt', 'task.txt']
            assert target_file.read_text() == 'task edit\n' and git(source, 'status', '--porcelain=v1') == source_status
            number = re.search(r'(?m)^([0-9]+)\. "task.txt"$', listing)[1]
            request = pi.ask('preview')
            detail = request[1]['title']
            assert all(s in detail for s in (str(source), str(repo), base, '涉及 2 个文件。'))
            assert 'task.txt' not in detail and 'source only.txt' not in detail
            assert request[1]['options'] == ['取消', '预览']
            assert not (repo / 'source only.txt').exists()
            pi.answer(request)
            pi.status_line('改动已写入项目目录')
            assert target_file.read_text() == 'external change\n' and (repo / 'source only.txt').is_file()
            pi.act('rollback')
            assert target_file.read_text() == 'task edit\n' and not (repo / 'source only.txt').exists()
            with PiRPC(source, agent, provider) as other:
                other.command(f'adopt {number}', 'error')
                other.start_turn('Edit in an ordinary conversation.')
                other.finish_turn('Write succeeded.')
                ordinary = source / 'ordinary.txt'
                assert ordinary.read_text() == 'ordinary edit'
                ordinary.unlink()
            pi.command('adopt 99', 'error')
            source_file.write_text('drift before narrowing\n')
            pi.command(f'adopt {number}', 'error')
            source_file.write_text('external change\n')
            token, _ = pi.challenge('preview')
            pi.command(f'adopt {number}')
            pi.command(f'confirm {token}', 'error')
            assert pi.status()['ready'] == ['task.txt']
            token, detail = pi.challenge('preview')
            assert 'task.txt' in detail and 'source only.txt' not in detail
            pi.command('cancel')
            pi.command(f'confirm {token}', 'error')
            assert target_file.read_text() == 'task edit\n'
            pi.act('discard')
            token, detail = pi.challenge(f'adopt {req}')
            assert 'Adopt selected external change' in detail
            assert 'task.txt' in detail and 'source only.txt' not in detail
            source_file.write_text('drift during confirmation\n')
            pi.command(f'confirm {token}', 'error')
            assert pi.status()['phase'] == 'discarded'
            assert target_file.read_text() == 'task edit\n'
            source_file.write_text('external change\n')
            request = pi.ask(f'adopt {req}')
            assert 'Adopt selected external change' in request[1]['title']
            assert '涉及 1 个文件。' in request[1]['title'] and 'task.txt' not in request[1]['title']
            source_file.write_text('drift during native Ask\n')
            pi.answer(request, kind='error')
            assert pi.status()['phase'] == 'discarded' and target_file.read_text() == 'task edit\n'
            source_file.write_text('external change\n')
            pi.act(f'adopt {req}')
            assert pi.state()['sessionId'] == origin['sessionId']
            assert pi.status()['phase'] == 'ready' and pi.status()['external']
            pi.command('resume', 'error')
            pi.act('discard')
            assert pi.status()['phase'] == 'discarded' and source.exists()
            pi.act(f'adopt {req}')
            pi.act('preview')
            assert target_file.read_text() == 'external change\n'
            assert not (repo / 'source only.txt').exists()
            pi.act('rollback')
            assert target_file.read_text() == 'task edit\n'
            pi.start_turn('Revise before preview external.')
            pi.finish_turn('Revision ready.')
            assert not any(e.get('method') == 'select' for e in pi.inbox)
            assert pi.status()['phase'] == 'ready'
            assert source_file.read_text() == 'ready revision\n' and target_file.read_text() == 'task edit\n'
            pi.act('preview')
            previewed = pi.status()
            pi.start_turn('Explain the external change.')
            pi.finish_turn('Explained without edits.')
            assert pi.status() == previewed
            assert target_file.read_text() == 'ready revision\n'
            pi.start_turn('Revise while previewed external.')
            ask = pi.revision_ask()
            assert str(repo) in ask['title'] and '涉及 1 个文件' in ask['title'] and 'task.txt' not in ask['title']
            pi.write({'type': 'extension_ui_response', 'id': ask['id'], 'cancelled': True})
            pi.finish_turn('Revision stopped.')
            assert pi.status() == previewed and source_file.read_text() == 'ready revision\n'
            pi.start_turn('Revise after Local drift external.')
            ask = pi.revision_ask()
            target_file.write_text('user edited preview\n')
            pi.write({'type': 'extension_ui_response', 'id': ask['id'], 'value': ask['options'][1]})
            pi.finish_turn('Revision blocked by Local drift.')
            assert pi.status() == previewed and source_file.read_text() == 'ready revision\n'
            assert target_file.read_text() == 'user edited preview\n'
            target_file.write_text('ready revision\n')
            # A normal source branch and HEAD change must not invalidate the task.
            git(source, 'switch', '-c', 'external-revision')
            git(source, 'commit', '--allow-empty', '-m', 'Source checkpoint', '--only')
            source_head = git(source, 'rev-parse', 'HEAD')
            prompt = 'Revise with a new file external.'
            pi.inbox.clear()
            pi.start_turn(prompt)
            ask = pi.revision_ask()
            assert target_file.read_text() == 'ready revision\n'
            for kind in ('steer', 'follow_up'):
                assert pi.reply(pi.send(kind, message='Do not enqueue this.'))['disposition'] == 'handled'
            assert target_file.read_text() == 'ready revision\n' and source_file.read_text() == 'ready revision\n'
            pi.write({'type': 'extension_ui_response', 'id': ask['id'], 'value': ask['options'][1]})
            pi.finish_turn('Revision ready.')
            def event_index(match):
                return next(i for i, e in enumerate(pi.inbox) if match(e))
            assert event_index(lambda e: e.get('statusText') == 'Worktree 返修中') < event_index(
                lambda e: e.get('type') == 'tool_execution_end' and e.get('toolName') == 'worktree_begin_revision') < event_index(
                lambda e: e.get('type') == 'tool_execution_start' and e.get('toolName') == 'read') < event_index(
                lambda e: e.get('type') == 'tool_execution_end' and e.get('toolName') == 'edit' and not e.get('isError')) < event_index(
                lambda e: e.get('type') == 'tool_execution_end' and e.get('toolName') == 'bash' and not e.get('isError')) < event_index(
                lambda e: e.get('type') == 'tool_execution_end' and e.get('toolName') == 'worktree_ready_for_review')
            transcript = Path(pi.state()['sessionFile']).read_text()
            assert transcript.count(prompt) == 1 and 'Do not enqueue this.' not in transcript
            ready = pi.status()
            assert ready['phase'] == 'ready' and ready['id'] == previewed['id'] and ready['ready'] == ['new revision.txt', 'task.txt']
            assert source_file.read_text() == 'previewed revision\n' and target_file.read_text() == 'task edit\n'
            assert (source / 'new revision.txt').read_text() == 'new in revision\n'
            assert not (repo / 'source only.txt').exists() and not (repo / 'new revision.txt').exists()
            (source / 'new revision.txt').write_text('refreshed revision\n')
            pi.start_turn('Refresh external delivery list.')
            pi.finish_turn('Worktree ready.')
            assert pi.status()['id'] == ready['id'] and pi.status()['ready'] == ready['ready']
            pi.act('preview')
            assert (repo / 'new revision.txt').read_text() == 'refreshed revision\n'
            pi.act('commit')
            assert pi.state()['sessionId'] == origin['sessionId']
            assert pi.status()['phase'] == 'delivered'
            pi.start_turn('Edit in an ordinary conversation.')
            pi.finish_turn('Write succeeded.')
            ordinary = subdir / 'ordinary.txt'
            assert ordinary.read_text() == 'ordinary edit'
            ordinary.unlink()
        assert git(source, 'symbolic-ref', 'HEAD') == 'refs/heads/external-revision'
        assert git(source, 'rev-parse', 'HEAD') == source_head and source_file.read_text() == 'previewed revision\n'
        assert git(source, 'status', '--porcelain=v1') == source_status + '\n?? "new revision.txt"'
        assert git(repo, 'show', '-1', '--format=%s', '--name-only') == 'Isolated smoke change\n\nnew revision.txt\ntask.txt'
        print('PASS real Pi RPC: native Ask, same-turn revision adds a file after source branch/HEAD change; only reviewed files delivered', flush=True)

        conflict_source = root / "conflict source's checkout"
        git(repo, 'worktree', 'add', '-b', 'external-conflict', '--', str(conflict_source))
        (conflict_source / 'task.txt').write_text('external conflict\n')
        (conflict_source / 'not for delivery.txt').write_text('private\n')
        with PiRPC(conflict_source, agent, provider) as pi:
            pi.command('adopt')
            pi.command('adopt 2')
            assert pi.status()['ready'] == ['task.txt']
            old_review = json.loads(record.read_text())['tasks'][-1]['review']['id']
            source_index = (Path(git(conflict_source, 'rev-parse', '--absolute-git-dir')) / 'index').read_bytes()
            target_file.write_text('committed conflict\n')
            git(repo, 'commit', '-am', 'upstream conflict')
            upstream = git(repo, 'rev-parse', 'HEAD')

            def conflict_ask():
                identifier, first = pi.ask('preview')
                pi.write({'type': 'extension_ui_response', 'id': first['id'], 'value': first['options'][1]})
                second = pi.wait(lambda e: e.get('method') == 'select' and e.get('id') != first['id'])
                assert second['options'] == ['取消', '让 Agent 解决冲突'], second
                return identifier, second

            assert pi.answer(conflict_ask(), cancel=True) == '未执行操作。'
            token, _ = pi.challenge('preview')
            challenge = pi.command(f'confirm {token}', 'confirm')
            assert '预览冲突' in challenge
            recovery_token = re.search(r'/worktree-preview-confirm ([a-f0-9-]+)', challenge)[1]
            assert token != recovery_token
            pi.command('cancel')
            pi.command(f'confirm {recovery_token}', 'error')
            assert json.loads(record.read_text())['tasks'][-1]['review']['id'] == old_review
            assert target_file.read_text() == 'committed conflict\n'
            pause = provider.with_name('pause-recovery')
            pause.touch()
            pi.answer(conflict_ask())
            pi.finish_turn('Conflict recovery paused.')
            pending = pi.status()
            assert pending['phase'] == 'working' and pending['conflict']['files'] == ['task.txt']
            assert Path(pending['conflict']['directory']).is_dir()
            pause.unlink()
            pi.command('recover')
            pi.finish_turn('Conflict resolved in private workspace.')
            ready = json.loads(record.read_text())['tasks'][-1]
            assert ready['phase'] == 'ready' and ready['review']['id'] != old_review and ready['resolution']
            assert target_file.read_text() == 'committed conflict\n' and git(repo, 'rev-parse', 'HEAD') == upstream
            pi.act('preview')
            assert target_file.read_text() == 'resolved independently\n' and not (repo / 'not for delivery.txt').exists()
            pi.act('commit')
            assert pi.status()['phase'] == 'delivered' and git(repo, 'diff', 'HEAD^', 'HEAD', '--name-only') == 'task.txt'
            assert (conflict_source / 'task.txt').read_text() == 'external conflict\n'
            assert (Path(git(conflict_source, 'rev-parse', '--absolute-git-dir')) / 'index').read_bytes() == source_index
        print('PASS real Pi RPC: external committed conflict, native Ask cancel/resolve, re-review and explicit preview/commit', flush=True)


if __name__ == '__main__':
    main()
