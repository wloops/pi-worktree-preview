#!/usr/bin/env python3
"""Real Pi RPC client; deliberately does not implement extension UI dialogs."""
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
        self.process.stdin.write(json.dumps({'type': kind, 'id': identifier, **values}) + '\n')
        self.process.stdin.flush()
        return identifier

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
                'select', 'confirm', 'input', 'editor',
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

    def challenge(self, args):
        detail = self.command(args, 'confirm')
        return re.search(r'/worktree-preview-confirm ([a-f0-9-]+)', detail)[1], detail

    def act(self, args):
        token, _ = self.challenge(args)
        return self.command(f'confirm {token}')

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
            origin = pi.state()
            verbs = ['new', 'status', 'resume', 'back', 'preview', 'rollback', 'commit', 'discard', 'adopt', 'confirm', 'cancel']
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
            pi.wait(lambda e: e.get('type') == 'agent_end')
            current = pi.status()
            assert current['phase'] == 'ready' and not current['external'], current
            isolated = Path(current['source'])
            child = pi.state()
            assert child['sessionId'] != origin['sessionId']
            contents = target_file.read_text(), (isolated / 'task.txt').read_text()
            assert contents == ('base\n', 'task edit\n'), (contents, current)
            def user_messages(state):
                return [m for line in Path(state['sessionFile']).read_text().splitlines()
                        if (m := json.loads(line).get('message', {})).get('role') == 'user']
            assert not any(sent in json.dumps(m) for m in user_messages(origin))
            assert sum(sent in json.dumps(m) for m in user_messages(child)) == 1
            pi.command('back')
            assert pi.state()['sessionId'] == origin['sessionId']
            pi.command('resume')
            assert pi.state()['sessionId'] == child['sessionId']
            token, detail = pi.challenge('preview')
            assert 'task.txt' in detail and str(repo) in detail and target_file.read_text() == 'base\n'
            with PiRPC(repo, agent, provider) as unrelated:
                assert unrelated.status()['phase'] == 'none'
                unrelated.command(f'confirm {token}', 'error')
            pi.command(f'confirm {token}')
            assert git(repo, 'rev-parse', 'HEAD') == head and target_file.read_text() == 'task edit\n'
            pi.command(f'confirm {token}', 'error')
            pi.act('rollback')
            assert target_file.read_text() == 'base\n'
            pi.act('preview')
            pi.act('commit')
            assert pi.state()['sessionId'] == origin['sessionId']
            assert not isolated.exists() and git(repo, 'log', '-1', '--format=%s') == 'Isolated smoke change'
            pi.command('new')
            assert pi.reply(pi.send('prompt', message='/var/folders/pi-clipboard-regression.png Open a task to discard.'))['disposition'] == 'handled'
            pi.notice('ok')
            pi.wait(lambda e: e.get('type') == 'agent_end')
            discarded = Path(pi.status()['source'])
            pi.act('discard')
            assert not discarded.exists() and pi.status()['phase'] == 'discarded'
        print('PASS real Pi RPC: command-only new/back/resume, single-use approval, preview/rollback/commit/discard', flush=True)

        source = root / 'external source with spaces'
        git(repo, 'worktree', 'add', '-b', 'external', '--', str(source))
        base = git(repo, 'rev-parse', 'HEAD')
        source_file = source / 'task.txt'
        source_file.write_text('external change\n')
        (source / 'source only.txt').write_text('do not deliver\n')
        git(source, 'add', 'source only.txt')
        source_status = git(source, 'status', '--porcelain=v1')
        req = json.dumps({'source': str(source), 'target': str(repo), 'base': base,
                          'title': 'Adopt selected external change', 'files': ['task.txt']})
        # Start from an external cwd as a real RPC client would. That exact Pi
        # session becomes the owner, without changing its cwd or parent.
        with PiRPC(repo, agent, provider) as pi:
            assert 'linked Worktree' in pi.command('adopt', 'error')
        with PiRPC(source, agent, provider) as pi:
            origin = pi.state()
            listing = pi.command('adopt')
            assert str(source) in listing and str(repo) in listing and base in listing
            assert '可直接运行' in listing and '-confirm' not in listing
            assert pi.state()['sessionId'] == origin['sessionId']
            assert pi.status()['phase'] == 'ready' and pi.status()['ready'] == ['source only.txt', 'task.txt']
            assert target_file.read_text() == 'task edit\n' and git(source, 'status', '--porcelain=v1') == source_status
            number = re.search(r'(?m)^([0-9]+)\. "task.txt"$', listing)[1]
            token, detail = pi.challenge('preview')
            assert all(s in detail for s in (str(source), str(repo), base, 'task.txt', 'source only.txt'))
            assert not (repo / 'source only.txt').exists()
            pi.command(f'confirm {token}')
            assert target_file.read_text() == 'external change\n' and (repo / 'source only.txt').is_file()
            pi.act('rollback')
            assert target_file.read_text() == 'task edit\n' and not (repo / 'source only.txt').exists()
            with PiRPC(source, agent, provider) as other:
                other.command(f'adopt {number}', 'error')
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
            pi.act('preview')
            pi.act('commit')
            assert pi.state()['sessionId'] == origin['sessionId']
            assert pi.status()['phase'] == 'delivered'
        assert git(source, 'symbolic-ref', 'HEAD') == 'refs/heads/external'
        assert git(source, 'rev-parse', 'HEAD') == base and source_file.read_text() == 'external change\n'
        assert git(source, 'status', '--porcelain=v1') == source_status
        assert git(repo, 'show', '-1', '--format=%s', '--name-only') == 'Adopt selected external change\n\ntask.txt'
        print('PASS real Pi RPC: adopt → preview, optional narrowing, stale checks, JSON fallback, source preserved', flush=True)


if __name__ == '__main__':
    main()
