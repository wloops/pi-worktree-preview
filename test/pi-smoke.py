#!/usr/bin/env python3
"""Exercise the installed Pi fullscreen UI over a real PTY. pip install pyte."""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shlex
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time

import pyte

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = os.environ.get('PI_WORKTREE_PREVIEW_PACKAGE')
COLS, ROWS = 110, 35
# Use a deterministic offline provider, but run the real agent, bash tool, and review tool.
PROVIDER = '''
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export default function(pi) {
  const veto = fileURLToPath(new URL('./veto-switch', import.meta.url));
  const slowVeto = fileURLToPath(new URL('./slow-veto-switch', import.meta.url));
  pi.on('session_before_switch', async () => {
    if (existsSync(slowVeto)) await new Promise(resolve => setTimeout(resolve, 700));
    if (existsSync(veto)) return { cancel: true };
  });
  pi.registerCommand('smoke-session-id', {
    handler: async (_args, ctx) => ctx.ui.notify(`Smoke session ${ctx.sessionManager.getSessionId()}`, 'info'),
  });
  pi.registerProvider("wtp-smoke", {
    baseUrl: "http://127.0.0.1:1", apiKey: "offline-test", api: "wtp-stub",
    models: [{ id: "model", name: "Offline Smoke", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.at(-1);
      const task = context.messages.findLast(message => message.role === "user")?.content;
      const text = typeof task === "string" ? task : task?.find(part => part.type === "text")?.text;
      const tool = (name, args = {}) => ({type:"toolCall",id:`test_${name}`,name,arguments:args});
      const say = (text) => [{type:"text",text}];
      const revision = text?.startsWith("Revise ");
      const recover = text?.startsWith("只在当前 detached Worktree 解决冲突") && text.match(/--no-overwrite-ignore ([0-9a-f]{40,64})/);
      const revise = () => tool("worktree_begin_revision");
      const badWrite = () => tool("write", {path:"forbidden.txt",content:"must not be written"});
      const runtime = text === "Edit with runtime state." || text === "Edit with overbroad review.";
      const extra = text === "Edit many files." ? Array.from({length: 32}, (_, i) => `extra-${String(i + 1).padStart(2, '0')}.txt`) : [];
      const edit = () => tool("bash", {command:`printf '${revision ? (text === "Revise before preview." ? "ready revision" : "previewed revision") : "task edit"}\\\\n' > task.txt${runtime ? " && mkdir -p .pi && printf isolated > .pi/loops.json" : ""}${extra.map(path => ` && touch ${path}`).join('')}`});
      let content;
      if (last?.role === "toolResult") {
        switch (last.toolName) {
          case "bash": content = last.isError ? say("Worktree command failed.") : [tool("worktree_ready_for_review", {
            commitMessage:"Isolated smoke change", files: text === "Edit with overbroad review." ? ["task.txt", ".pi/loops.json"] : ["task.txt", ...extra],
          })]; break;
          case "read": content = say("Explained without edits."); break;
          case "write": content = say(last.isError ? "Write was blocked." : "Unexpected write."); break;
          case "worktree_begin_revision": content = last.isError ? say(text === "Revise after Local drift." ? "Revision blocked by Local drift." : "Revision stopped.") : [edit()]; break;
          default: content = say(last.isError ? "Review failed." : recover ? "Conflict resolved in Worktree." : revision ? "Revision ready." : "Worktree ready.");
        }
      } else if (recover) content = [tool('bash', {command: `git add -- task.txt && git commit -m checkpoint &&
        (git -c merge.renames=false -c merge.directoryRenames=false merge --no-edit --no-overwrite-ignore ${recover[1]}; test $? -eq 1) &&
        test "$(git rev-parse MERGE_HEAD)" = ${recover[1]} && printf 'merged task\\\\n' > task.txt && git add -- task.txt && git commit -m resolve`})];
      else if (revision) content = [revise()];
      else if (text === "Try a parallel write.") content = [revise(), badWrite()];
      else if (text === "Try to write during review.") content = [badWrite()];
      else if (text === "Explain the change.") content = [tool("read", {path:"task.txt"})];
      else if (text?.startsWith("Follow up from ")) {
        const previous = text.endsWith("delivery.") ? "Edit task.txt and mark ready." : "/var/folders/pi-clipboard-regression.png Open a task to discard.";
        const inherited = context.messages.some(message => message.role === 'user' &&
          (typeof message.content === 'string' ? message.content === previous : message.content.some(part => part.type === 'text' && part.text === previous)));
        const boundary = context.messages.some(message => message.role === 'user' &&
          Array.isArray(message.content) && message.content.some(part => part.type === 'text' && part.text.includes('Only conversation history was inherited')));
        content = say(inherited && boundary ? "Received follow-up with original context." : "Missing inherited context.");
      }
      else if (text === "Local only." || text === "/var/folders/pi-clipboard-regression.png Open a task to discard.") content = say("Acknowledged without edits.");
      else if (text?.trim() === "Registered Worktree prompt.") content = say("Expanded Worktree template.");
      else if (text?.includes('Worktree skill marker.') && text.endsWith('smoke argument')) content = say("Expanded Worktree skill.");
      else content = [edit()];
      const tools = content[0].type === "toolCall";
      const msg = {role:"assistant", content, api:model.api, provider:model.provider, model:model.id, stopReason:tools ? "toolUse" : "stop",
        usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},timestamp:Date.now()};
      queueMicrotask(() => { stream.push({type:"start",partial:msg});
        if (tools) content.forEach((toolCall,contentIndex) => stream.push({type:"toolcall_end",contentIndex,toolCall,partial:msg}));
        stream.push({type:"done",reason:msg.stopReason,message:msg}); stream.end(); });
      return stream;
    }
  });
}
'''


class Pi:
    def __init__(self, cwd, agent, provider, theme='dark', cols=COLS, rows=ROWS, session=None, git_bin=None):
        self.screen = pyte.Screen(cols, rows)
        self.stream = pyte.ByteStream(self.screen)
        settings_path = agent / 'settings.json'
        settings = json.loads(settings_path.read_text()) if settings_path.exists() else {}
        settings_path.write_text(json.dumps({**settings, 'theme': theme}))
        self.pid, self.fd = pty.fork()
        if not self.pid:
            os.chdir(cwd)
            os.environ.update(PI_CODING_AGENT_DIR=str(agent), TERM='xterm-256color', COLORTERM='truecolor')
            if git_bin:
                os.environ['PATH'] = str(git_bin) + os.pathsep + os.environ['PATH']
            extension = [] if PACKAGE else ['-ne', '-e', str(ROOT / 'src/index.ts')]
            os.execvp('pi', ['pi', '--tui-mode', 'fullscreen', '--no-mcp', '-ns', '-np', '-na',
                             '--provider', 'wtp-smoke', '--model', 'model', *extension, '-e', str(provider),
                             '--prompt-template', str(provider.with_name('smoke-task.md')),
                             '--skill', str(provider.with_name('smoke-worktree') / 'SKILL.md'),
                             *(['--session', str(session)] if session else [])])
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

    def dump(self):
        return '\n'.join(line.rstrip() for line in self.screen.display)

    def read(self, wait=.2):
        if select.select([self.fd], [], [], wait)[0]:
            data = os.read(self.fd, 65536)
            # pyte doesn't implement OSC 66 (text sizing), which isn't needed here.
            self.stream.feed(re.sub(rb'\x1b\]66;[^\x07]*(?:\x07|\x1b\\)', b'', data))
            return True
        return False

    def until(self, text, timeout=20):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            for y, line in enumerate(self.screen.display):
                if text in line:
                    # pyte.display omits trailing cells of wide glyphs. Translate
                    # the string index back to a terminal column for SGR mouse events.
                    remaining = line.index(text)
                    for x in range(self.screen.columns):
                        cell = self.screen.buffer[y][x].data
                        if remaining == 0 and cell:
                            return x + 1, y + 1
                        remaining -= len(cell)
                    raise AssertionError(f'No terminal cell for {text!r}')
            self.read()
        raise AssertionError(f'Missing {text!r}:\n{self.dump()}')

    def until_gone(self, text, timeout=20):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if text not in self.dump():
                return
            self.read()
        raise AssertionError(f'Still showing {text!r}:\n{self.dump()}')

    def send(self, data):
        os.write(self.fd, data)

    def click(self, text):
        self.until(text)
        # A label can arrive in an intermediate render before Pi settles layout.
        # Drain the frame before measuring mouse coordinates.
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline and self.read(.12):
            pass
        self.click_at(*self.until(text))

    def click_at(self, x, y):
        self.send(f'\x1b[<0;{x};{y}M'.encode())
        time.sleep(.04)
        self.send(f'\x1b[<0;{x};{y}m'.encode())

    def resize(self, cols, rows):
        self.screen.resize(lines=rows, columns=cols)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

    def __enter__(self):
        return self

    def __exit__(self, *_):
        try:
            self.send(b'\x04')
            for _ in range(30):
                if os.waitpid(self.pid, os.WNOHANG)[0]:
                    return
                try:
                    self.read(.1)
                except OSError:
                    time.sleep(.05)
            os.kill(self.pid, signal.SIGKILL)
            os.waitpid(self.pid, 0)
        finally:
            os.close(self.fd)


def main():
    with tempfile.TemporaryDirectory(prefix='pi-wtp-smoke-') as folder:
        base = Path(folder).resolve()
        local = base / 'local'
        local.mkdir()
        agent = base / 'agent'
        agent.mkdir()
        if PACKAGE:
            subprocess.run(['pi', 'install', PACKAGE], cwd=base, check=True,
                           env={**os.environ, 'PI_CODING_AGENT_DIR': str(agent)})
        provider = base / 'offline.ts'
        provider.write_text(PROVIDER)
        provider.with_name('smoke-task.md').write_text('Registered Worktree prompt.\n')
        skill_dir = provider.with_name('smoke-worktree')
        skill_dir.mkdir()
        (skill_dir / 'SKILL.md').write_text('---\nname: smoke-worktree\ndescription: Verify skill routing.\n---\nWorktree skill marker.\n')
        # Test extension imports resolve through Pi's extension loader; this link keeps offline
        # provider imports resolvable even when pi is launched from an isolated agent profile.
        (base / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)

        def git(*args):
            return subprocess.check_output(['git', '-C', str(local), *args], text=True,
                                           env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0'}).strip()

        git('init', '-q', '-b', 'main')
        git('config', 'user.name', 'Smoke Test')
        git('config', 'user.email', 'smoke@example.invalid')
        (local / 'task.txt').write_text('base\n')
        (local / 'user.txt').write_text('original\n')
        git('add', '.')
        git('commit', '-m', 'base')
        head = git('rev-parse', 'HEAD')
        (local / 'user.txt').write_text('staged by user\n')
        git('add', 'user.txt')
        (local / 'user.txt').write_text('edited by user\n')
        state_path = agent / 'worktree-preview/tasks.json'

        def tasks():
            return json.loads(state_path.read_text())['tasks']

        def task():
            return tasks()[-1]

        kickoff = 'Edit task.txt and mark ready.'
        git('switch', '--detach', '--quiet')
        with Pi(local, agent, provider) as pi:
            pi.click('[ ] 新建 Worktree')
            pi.until('[x] 新建 Worktree')
            pi.send(b'Do not send this to Local.\r')
            pi.until('消息未发送')
            pi.until('Do not send this to Local.')
            assert not state_path.exists()
            assert (local / 'task.txt').read_text() == 'base\n'
        git('switch', '--quiet', 'main')
        with Pi(local, agent, provider) as pi:
            create_x, create_y = pi.until('[ ] 新建 Worktree')
            assert pi.screen.buffer[create_y - 1][create_x - 1].bg == '4669a3'
            pi.click('[ ] 新建 Worktree')
            create_x, create_y = pi.until('[x] 新建 Worktree')
            assert pi.screen.buffer[create_y - 1][create_x - 1].bg == '294f94'
            assert not state_path.exists(), 'checking must not create anything'
            pi.click('[x] 新建 Worktree')
            create_x, create_y = pi.until('[ ] 新建 Worktree')
            assert pi.screen.buffer[create_y - 1][create_x - 1].bg == '4669a3'
            pi.send(b'Local only.\r')
            pi.until('Acknowledged without edits.')
            assert not state_path.exists(), 'unchecked send must stay in Local'
            pi.send(kickoff.encode())
            pi.click('[ ] 新建 Worktree')
            pi.until('[x] 新建 Worktree')
            assert not state_path.exists()
            pi.send(b'\r')
            pi.until('Worktree · 待验收', 40)
            pi.until('Worktree ready.')
            first_path = Path(task()['isolatedPath'])
            assert first_path.is_dir()
            assert Path(task()['isolatedSession']['file']).read_text().count(kickoff) == 1
            assert kickoff not in Path(task()['localSession']['file']).read_text()
            deadline = time.monotonic() + 25
            while task()['phase'] != 'ready' and time.monotonic() < deadline:
                pi.read()
            assert task()['phase'] == 'ready', pi.dump()
            assert (first_path / 'task.txt').read_text() == 'task edit\n'
            assert (local / 'task.txt').read_text() == 'base\n'
        print('real Pi: checkbox delayed creation; unchecked send stayed Local; checked draft sent only once in Worktree', flush=True)
        origin = task()['localSession']['file']
        with Pi(local, agent, provider) as unrelated:
            before = tasks()
            unrelated.until('[ ] 新建 Worktree')
            assert '待验收' not in unrelated.dump() and '[ 预览改动 ]' not in unrelated.dump()
            unrelated.click('[ ] 新建 Worktree')
            unrelated.until('[x] 新建 Worktree')
            assert tasks() == before
            unrelated.click('[x] 新建 Worktree')
            unrelated.until('[ ] 新建 Worktree')
            unrelated.send(b'/worktree-preview\r')
            unrelated.until('Worktree · 更多')
            assert '待验收' not in unrelated.dump() and '[ 进入 / 恢复 Worktree ]' not in unrelated.dump()
            assert '[ 预览改动 ]' not in unrelated.dump() and '[ 放弃任务 ]' not in unrelated.dump()
            unrelated.until('[ 下次发送时新建 Worktree ]')
            unrelated.send(b'\x1b')
            unrelated.until_gone('Worktree · 更多')
            unrelated.send(b'Local only.\r')
            unrelated.until('Acknowledged without edits.')
            assert tasks() == before
        print('real Pi: fresh Local shows the create checkbox without exposing another session’s active task', flush=True)
        for theme, cols, rows in [('light', 110, 35), ('dark', 42, 11)]:
            with Pi(local, agent, provider, theme, cols, rows, session=origin) as pi:
                pi.until('项目目录 · Worktree 待验收')
                action_x, action_y = pi.until('[ 预览改动 ]')
                assert '预览只写入项目目录' not in pi.dump()
                primary = pi.screen.buffer[action_y - 1][action_x - 1]
                assert primary.bold and primary.bg == {'light': '274c97', 'dark': '305ba6'}[theme]
                more_x, more_y = pi.until('⋯ 更多')
                assert more_x > cols - 12
                if cols == 110:
                    assert more_y == action_y
                pi.click('⋯ 更多')
                pi.until('Worktree · 更多')
                pi.send(b'\r')  # Enter closes the menu by default.
                pi.until_gone('Worktree · 更多')
                assert git('rev-parse', 'HEAD') == head and task()['phase'] == 'ready'
                pi.click('⋯ 更多')
                _, border_y = pi.until('╭───')
                border_x = pi.screen.display[border_y - 1].index('╭')
                right_x = pi.screen.display[border_y - 1].index('╮', border_x)
                title_x, title_y = pi.until('Worktree · 更多')
                title = pi.screen.buffer[title_y - 1]
                assert title[title_x - 1].bold and title[title_x - 1].bg == {'light': 'dee8fa', 'dark': '253651'}[theme]
                _, cancel_y = pi.until('[ 关闭 ]')
                cancel = pi.screen.buffer[cancel_y - 1]
                assert cancel[border_x + 1].bg == cancel[right_x - 1].bg != 'default'
                assert cancel[border_x + 1].bg != title[title_x - 1].bg
                assert '当前目录：' not in pi.dump()
                pi.click_at(border_x + 1, cancel_y)  # the frame is not a button
                pi.click_at(right_x - 1, cancel_y)  # neither is the trailing space
                pi.until('▸ [ 关闭 ]')  # Closing remains selected after frame clicks.
                pi.send(b'\x1b[B')  # Wrap from the last (close) to the first (preview) action.
                pi.until('▸ [ 预览改动 ]')
                pi.send(b'\r')
                pi.until('预览改动？')
                lead_x, lead_y = pi.until('改动写入项目目录，不暂存、不提交。')
                assert pi.screen.buffer[lead_y - 1][lead_x - 1].bold
                _, confirm_y = pi.until('[ 预览 ]')
                _, cancel_y = pi.until('▸ [ 取消 ]')
                assert confirm_y == cancel_y
                pi.send(b'\x1b[D')
                pi.until('▸ [ 预览 ]')
                pi.send(b'\x1b[C')
                pi.until('▸ [ 取消 ]')
                pi.send(b'\r')  # Enter also cancels a confirmation by default.
                pi.until_gone('预览改动？')
                assert git('rev-parse', 'HEAD') == head and task()['phase'] == 'ready'
        print('real Pi: phase and primary-action contrast, hit targets and keyboard cancellation in light and narrow dark terminals', flush=True)
        with Pi(local, agent, provider, session=origin) as pi:
            pi.until('项目目录 · Worktree 待验收')
            pi.click('⋯ 更多')
            pi.click('[ 进入 / 恢复 Worktree ]')
            pi.until('Worktree · 待验收')
            pi.until('Worktree ready.')
            review_id = task()['review']['id']
            isolated_session = Path(task()['isolatedSession']['file'])
            pi.send(b'Explain the change.\r')
            pi.until('Explained without edits.')
            assert task()['review']['id'] == review_id
            pi.send(b'Try a parallel write.\r')
            pi.until('Write was blocked.')
            assert task()['review']['id'] == review_id and not (first_path / 'forbidden.txt').exists()
            pi.send(b'Revise before preview.\r')
            pi.until('Revision ready.')
            assert '返修前需撤回项目目录的预览' not in pi.dump()
            assert task()['phase'] == 'ready' and task()['review']['id'] != review_id
            assert (first_path / 'task.txt').read_text() == 'ready revision\n'
            assert (local / 'task.txt').read_text() == 'base\n'
            pi.click('[ 预览改动 ]')
            pi.click('[ 预览 ]')
            pi.until('Worktree · 已预览')
            preview_task = task()
            pi.send(b'Try to write during review.\r')
            pi.until('Write was blocked.')
            assert task() == preview_task and not (first_path / 'forbidden.txt').exists()

            pi.send(b'Revise but cancel.\r')
            pi.until('返修前需撤回项目目录的预览')
            assert task() == preview_task and (local / 'task.txt').read_text() == 'ready revision\n'
            pi.click('[ 取消 ]')
            pi.until('Revision stopped.')
            assert task() == preview_task and (first_path / 'task.txt').read_text() == 'ready revision\n'

            (local / 'task.txt').write_text('Local user edit\n')
            pi.send(b'Revise after Local drift.\r')
            pi.click('[ 撤回预览，继续返修 ]')
            pi.until('Revision blocked by Local drift.')
            assert task() == preview_task and (first_path / 'task.txt').read_text() == 'ready revision\n'
            assert (local / 'task.txt').read_text() == 'Local user edit\n'
            (local / 'task.txt').write_text('ready revision\n')

            pi.send(b'Revise after preview.\r')
            pi.click('[ 撤回预览，继续返修 ]')
            # No second user message: the blocked tool returns to the same agent run.
            pi.until('Worktree · 待验收', 35)
            assert task()['review']['id'] != preview_task['review']['id'] and 'receipt' not in task()
            assert (local / 'task.txt').read_text() == 'base\n'
            assert (first_path / 'task.txt').read_text() == 'previewed revision\n'
            requests = [entry['message'] for line in isolated_session.read_text().splitlines()
                        if (entry := json.loads(line)).get('message', {}).get('role') == 'user']
            assert [m['content'][0]['text'] for m in requests].count('Revise after preview.') == 1
            assert requests[-1]['content'][0]['text'] == 'Revise after preview.'
            print('real Pi: discussion keeps review; revisions resume the same agent turn; rollback cancellation preserves preview', flush=True)

            for root, value in [(local, 'Local loop'), (first_path, 'Worktree loop')]:
                (root / '.pi').mkdir(exist_ok=True)
                (root / '.pi/loops.json').write_text(value)
            baseline = git('status', '--porcelain')
            pi.click('[ 预览改动 ]')
            pi.until('预览改动？')
            pi.click('[ 取消 ]')
            pi.until_gone('预览改动？')
            assert (local / 'task.txt').read_text() == 'base\n'
            pi.click('[ 预览改动 ]')
            pi.click('[ 预览 ]')
            pi.until('Worktree · 已预览')
            assert (local / 'task.txt').read_text() == 'previewed revision\n'
            assert git('rev-parse', 'HEAD') == head
            (local / '.pi/loops.json').write_text('Local loop edited after preview')
            pi.click('[ 撤回预览 ]')
            pi.until('只还原本次预览。')
            pi.click('[ 撤回 ]')
            pi.until('Worktree · 待验收')
            assert git('status', '--porcelain') == baseline
            pi.click('[ 预览改动 ]')
            pi.click('[ 预览 ]')
            pi.until('Worktree · 已预览')
            pi.click('[ 打开项目目录检查 ]')
            pi.until('项目目录 · Worktree 已预览')
            pi.until('[ 撤回预览 ]')
            pi.until('[ 确认提交 ]')
            pi.click('⋯ 更多')
            pi.click('[ 进入 / 恢复 Worktree ]')
            pi.until('Worktree · 已预览')
            veto = base / 'veto-switch'
            veto.touch()
            pi.click('[ 确认提交 ]')
            pi.until('只提交任务改动。')
            pi.until('提交标题：Isolated smoke change')
            pi.until('• "task.txt"')
            assert '• ".pi/loops.json"' not in pi.dump()
            pi.click('[ 提交并安全清理 ]')
            pi.until('Pi 取消了切换，未提交。')
            assert git('rev-parse', 'HEAD') == head and task()['phase'] == 'previewed' and first_path.is_dir()
            veto.unlink()
            (local / 'task.txt').write_text('edited after preview\n')
            pi.click('[ 确认提交 ]')
            pi.click('[ 提交并安全清理 ]')
            pi.until('[ 回到 Worktree ]')
            pi.until('自预览后已变化')
            pi.until('Revision ready.')
            assert git('rev-parse', 'HEAD') == head and task()['phase'] == 'previewed' and first_path.is_dir()
            pi.send(b'Keep this unsent draft.\r')
            pi.until('目前不能从此处继续')
            assert 'Keep this unsent draft.' not in isolated_session.read_text()
            assert 'Keep this unsent draft.' not in Path(task()['localSession']['file']).read_text()
            assert (local / 'task.txt').read_text() == 'edited after preview\n'
            pi.click('[ 回到 Worktree ]')
            pi.until('Worktree · 已预览')
            pi.until('Keep this unsent draft.')
            pi.send(b'\x15')  # clear the restored draft
            (local / 'task.txt').write_text('previewed revision\n')
            (local / '.pi/loops.json').write_text('Local loop edited before finalizing')
            pi.click('[ 确认提交 ]')
            pi.click('[ 提交并安全清理 ]')
            pi.until('未能安全清理 Worktree')
            pi.click('[ 保留 Worktree ]')
            pi.until('已交付 · 发送后在新 Worktree 继续')
            pi.until('Revision ready.')
            assert '[ ] 新建 Worktree' not in pi.dump()
            pi.click('[ 返回原对话 ]')
            pi.until('项目目录 · Worktree 已交付')
            assert git('show', '--format=', '--name-only') == 'task.txt'
            assert git('status', '--porcelain') == baseline
            assert task()['cleanup']['status'] == 'retained' and not task()['cleanup'].get('requested')
            assert (first_path / '.pi/loops.json').read_text() == 'Worktree loop'
            assert (local / '.pi/loops.json').read_text() == 'Local loop edited before finalizing'
            delivered_head = git('rev-parse', 'HEAD')
            first_id = task()['id'][:8]
            def inspect_removal():
                pi.click('⋯ 更多')
                pi.click('[ 已保留的 Worktree ]')
                pi.click(f'[ {first_id} · Isolated smoke change ]')
                pi.click('[ 检查并清理… ]')

            assert '[ 已保留的 Worktree ]' not in pi.dump()
            pi.click('[ ] 新建 Worktree')
            pi.until('[x] 新建 Worktree')
            pi.click('[x] 新建 Worktree')
            pi.until('[ ] 新建 Worktree')
            with Pi(local, agent, provider) as other:
                other.click('⋯ 更多')
                other.click('[ 已保留的 Worktree ]')
                other.click(f'[ {first_id} · Isolated smoke change ]')
                other.click('[ 恢复会话检查 ]')
                other.until('Worktree · 已交付')
                inspect_removal()
                pi.until('另一个 Pi 会话正在使用此 Worktree')
                assert first_path.is_dir()
                other.click('⋯ 更多')
                other.click('[ 返回原对话 ]')
                other.until('项目目录 · Worktree 已交付')
                inspect_removal()
                pi.until('强删将永久移除此目录')
                pi.until('目标目录：')
                pi.until(str(first_path)[:24])
                pi.until('[ 确认强删 Worktree ]')
                pi.resize(42, 8)
                pi.until('终端太小 · Esc 关闭')
                assert '[ 确认强删 Worktree ]' not in pi.dump()
                pi.send(b'\x1b[A\r')  # Up + Enter cannot bypass a hidden warning/target.
                pi.until_gone('终端太小 · Esc 关闭')
                assert first_path.is_dir()
                pi.resize(COLS, ROWS)
                inspect_removal()
                x, y = pi.until('[ 确认强删 Worktree ]')
                pi.send(f'\x1b[<0;{x};{y}M'.encode())
                pi.read(.2)
                assert first_path.is_dir()
                pi.send(f'\x1b[<32;{x};{y + 1}M\x1b[<0;{x};{y + 1}m'.encode())
                pi.read(.2)
                assert first_path.is_dir()
                pi.click('[ 确认强删 Worktree ]')
            pi.until('Worktree 已删除')
            assert not first_path.exists()
            assert git('rev-parse', 'HEAD') == delivered_head and git('status', '--porcelain') == baseline
            print('real Pi: protected retention, blocked removal while another Pi used it, then explicit force removal', flush=True)

            first = task()
            first_history = isolated_session.read_bytes()
            history_views = agent / 'worktree-preview/history-views'
            pi.click('[ 任务历史 ]')
            pi.click(f'[ {first_id} · 已交付 · Isolated smoke change ]')
            pi.until('历史对话 · 发送后在新 Worktree 继续')
            pi.until('Revise after preview.')  # actually rendered by Pi, before the next send
            pi.until('Revision ready.')
            assert tasks() == [first] and not first_path.exists()
            assert len(list(history_views.glob('*.jsonl'))) == 1
            assert isolated_session.read_bytes() == first_history
            assert git('rev-parse', 'HEAD') == delivered_head and git('status', '--porcelain') == baseline
            # Advance Local while viewing: the new base must be resolved on send.
            (local / 'new-base.txt').write_text('current Local commit\n')
            git('add', 'new-base.txt')
            git('commit', '--only', '-m', 'Advance Local before follow-up', '--', 'new-base.txt')
            follow_head = git('rev-parse', 'HEAD')
            pi.send(b'Follow up from delivery.\r')
            pi.until('Received follow-up with original context.', 35)
            follow = task()
            assert not list(history_views.glob('*.jsonl'))
            follow_path = Path(follow['isolatedPath'])
            child = Path(follow['isolatedSession']['file'])
            header = json.loads(child.read_text().splitlines()[0])
            assert len(tasks()) == 2 and tasks()[0] == first and follow['followUpOf'] == first['id']
            assert header['parentSession'] == str(isolated_session) and header['cwd'] == str(follow_path)
            assert header['id'] != first['isolatedSession']['id'] and isolated_session.read_bytes() == first_history
            assert child.read_text().count('Follow up from delivery.') == 1
            assert 'Follow up from delivery.' not in Path(follow['localSession']['file']).read_text()
            assert follow['baseOid'] == follow_head and follow_path != first_path
            assert (follow_path / 'task.txt').read_text() == 'previewed revision\n'
            assert (follow_path / 'new-base.txt').read_text() == 'current Local commit\n'
            assert (follow_path / 'user.txt').read_text() == 'original\n' and not (follow_path / '.pi/loops.json').exists()
            pi.click('⋯ 更多')
            pi.click('[ 返回原对话 ]')
            pi.until('项目目录 · Worktree 进行中')
            pi.click('⋯ 更多')
            pi.click('[ 放弃任务 ]')
            pi.click('[ 放弃 ]')
            pi.until('项目目录 · Worktree 已放弃')
            assert not follow_path.exists()
            print('real Pi: history rendered before creating a Worktree; follow-up used HEAD at send time', flush=True)

            pi.click('[ ] 新建 Worktree')
            pi.until('[x] 新建 Worktree')
            before = tasks()
            pi.send(b'/smoke-session-id\r')
            pi.until('Smoke session')
            pi.until('[x] 新建 Worktree')
            assert tasks() == before
            image_prompt = '/var/folders/pi-clipboard-regression.png Open a task to discard.'
            pi.send(image_prompt.encode() + b'\r')
            pi.until('Worktree · 进行中')
            pi.until('Acknowledged without edits.')
            second_path = Path(task()['isolatedPath'])
            assert Path(task()['isolatedSession']['file']).read_text().count(image_prompt) == 1
            assert image_prompt not in Path(task()['localSession']['file']).read_text()
            (second_path / 'discard.txt').write_text('discarded')
            pi.click('⋯ 更多')
            pi.click('[ 返回原对话 ]')
            pi.until('项目目录 · Worktree 进行中')
            pi.click('⋯ 更多')
            pi.click('[ 放弃任务 ]')
            pi.click('[ 放弃 ]')
            pi.until('项目目录 · Worktree 已放弃')
            assert not second_path.exists()
            assert not (local / 'discard.txt').exists()
            print('real Pi: extension command stayed Local; path-prefixed read-only request went to Worktree, then safely discarded', flush=True)

            discarded = task()
            discarded_id = discarded['id'][:8]
            old_file = Path(discarded['isolatedSession']['file'])
            old_history = old_file.read_bytes()
            before = tasks()
            pi.click('[ 任务历史 ]')
            pi.click(f'[ {discarded_id} · 已放弃 · Worktree ]')
            pi.until('历史对话 · 发送后在新 Worktree 继续')
            pi.until('Open a task to discard.')
            pi.send(b'!touch shell-from-history.txt\r')
            pi.until('请返回原对话再执行 shell')
            assert not (local / 'shell-from-history.txt').exists() and tasks() == before
            pi.click('[ 返回原对话 ]')
            pi.until('[ ] 新建 Worktree')
            assert tasks() == before and old_file.read_bytes() == old_history
            assert not list(history_views.glob('*.jsonl'))
            pi.click('[ 任务历史 ]')
            pi.click(f'[ {discarded_id} · 已放弃 · Worktree ]')
            pi.until('历史对话 · 发送后在新 Worktree 继续')
            old_file.unlink()
            pi.send(b'Follow up from discard.\r')
            pi.until('原 Pi 会话文件已不存在')
            pi.until('Follow up from discard.')  # original draft restored
            pi.until('历史对话 · 发送后在新 Worktree 继续')
            assert tasks() == before
            damaged = old_history + b'{partial record'
            old_file.write_bytes(damaged)
            pi.send(b'\r')
            pi.until('原 Pi 会话内容已损坏')
            assert tasks() == before and old_file.read_bytes() == damaged
            without_newline = old_history.rstrip(b'\n')
            old_file.write_bytes(without_newline)
            pi.send(b'\r')
            pi.until('Received follow-up with original context.', 35)
            next_task = task()
            assert tasks()[:-1] == before and next_task['followUpOf'] == discarded['id']
            assert next_task['baseOid'] == follow_head and git('rev-parse', 'HEAD') == follow_head
            assert old_file.read_bytes() == without_newline and not second_path.exists()
            assert not (Path(next_task['isolatedPath']) / 'discard.txt').exists()
            assert 'Follow up from discard.' not in Path(next_task['localSession']['file']).read_text()
            print('real Pi: discarded history survived cleanup; missing source stopped safely and retried without sending to Local', flush=True)

        local = base / 'empty-local'
        local.mkdir()
        git('init', '-q', '-b', 'main')
        git('config', 'user.name', 'Smoke Test')
        git('config', 'user.email', 'smoke@example.invalid')
        git('commit', '--allow-empty', '-m', 'empty base')
        head = git('rev-parse', 'HEAD')
        index = local / '.git/index'
        index.unlink(missing_ok=True)  # Some Git versions materialize an empty index.
        (local / 'private.txt').write_text('untracked Local content\n')
        with Pi(local, agent, provider) as pi:
            pi.until('[ ] 新建 Worktree')
            pi.send(b'/smoke-session-id\r')
            pi.until('Smoke session ')
            original_id = re.search(r'Smoke session ([a-f0-9-]+)', pi.dump()).group(1)
            before = tasks()
            assert not list(agent.rglob(f'*{original_id}*.jsonl'))
            veto = base / 'veto-switch'
            veto.touch()
            pi.click('[ ] 新建 Worktree')
            pi.until('[x] 新建 Worktree')
            pi.send(kickoff.encode() + b'\r')
            pi.until('Pi 取消了保存原对话')
            assert tasks() == before and not list(agent.rglob(f'*{original_id}*.jsonl'))
            assert kickoff in pi.dump()
            veto.unlink()
            pi.click('[ ] 新建 Worktree')
            pi.until('[x] 新建 Worktree')
            pi.send(b'\r')
            pi.until('Worktree ready.', 40)
            assert task()['localSession']['id'] == original_id
            assert kickoff not in Path(task()['localSession']['file']).read_text()
            pi.click('[ 预览改动 ]')
            pi.click('[ 预览 ]')
            pi.until('Worktree · 已预览')
            assert not index.exists()
            pi.click('[ 确认提交 ]')
            pi.click('[ 提交并保留 ]')
            pi.until('已交付 · 发送后在新 Worktree 继续')
            pi.until('Worktree ready.')
            assert index.is_file()
            assert git('rev-parse', 'HEAD^') == head
            assert git('show', '--format=', '--name-only') == 'task.txt'
            assert git('status', '--porcelain') == '?? private.txt'
            retained_path = Path(task()['isolatedPath'])
            task_id = task()['id'][:8]
            assert task()['cleanup']['requested'] is True
            assert (retained_path / 'task.txt').read_text() == 'task edit\n'
        # Session navigation is read-only and must not require the original branch
        # or a clean Git-operation state in the retained environment.
        git('switch', '-qc', 'inspect-retained')
        isolated_git_dir = Path(task()['isolated']['gitDir'])
        (isolated_git_dir / 'CHERRY_PICK_HEAD').write_text(head + '\n')
        with Pi(local, agent, provider) as pi:
            pi.click('⋯ 更多')
            pi.click('[ 已保留的 Worktree ]')
            pi.click(f'[ {task_id} · Isolated smoke change ]')
            pi.click('[ 恢复会话检查 ]')
            pi.until('Worktree · 已交付')
            pi.until('Worktree ready.')
            pi.click('⋯ 更多')
            pi.click('[ 返回原对话 ]')
            pi.until('项目目录 · Worktree 已交付')
            print('real Pi: explicit retention with absent Local index; environment and session reopen after restart', flush=True)

        local = base / 'conflict-local'
        local.mkdir()
        git('init', '-q', '-b', 'main')
        git('config', 'user.name', 'Smoke Test')
        git('config', 'user.email', 'smoke@example.invalid')
        (local / 'task.txt').write_text('base\n')
        git('add', '.')
        git('commit', '-m', 'base')
        with Pi(local, agent, provider) as pi:
            pi.click('[ ] 新建 Worktree')
            pi.until('[x] 新建 Worktree')
            pi.send(kickoff.encode() + b'\r')
            pi.until('Worktree ready.', 40)
            previous = task()['review']['id']
            (local / 'task.txt').write_text('committed upstream\n')
            git('commit', '-am', 'upstream')
            head = git('rev-parse', 'HEAD')
            (local / 'untracked.txt').write_text('private\n')
            pi.click('[ 预览改动 ]')
            pi.click('[ 预览 ]')
            pi.until('预览冲突 · 项目目录未修改')
            pi.click('[ 关闭 ]')
            assert task()['review']['id'] == previous
            assert git('status', '--porcelain') == '?? untracked.txt'
            pi.click('⋯ 更多')
            pi.click('[ 返回原对话 ]')
            pi.until('项目目录 · Worktree 待验收')
            pi.click('[ 预览改动 ]')
            pi.click('[ 预览 ]')
            pi.click('[ 让 Agent 解决冲突 ]')
            pi.until('Conflict resolved in Worktree.', 45)
            assert task()['phase'] == 'ready'
            assert task()['review']['id'] != previous
            assert task()['baseOid'] == head
            assert git('rev-parse', 'HEAD') == head
            assert git('status', '--porcelain') == '?? untracked.txt'
            assert (local / 'task.txt').read_text() == 'committed upstream\n'
            pi.click('[ 预览改动 ]')
            pi.click('[ 预览 ]')
            pi.until('Worktree · 已预览')
            assert (local / 'task.txt').read_text() == 'merged task\n'
            print('real Pi: cancelled conflict recovery, then approved from Local; Agent resolved in original Worktree and re-reviewed', flush=True)

        for broad in (False, True):
            local = base / ('narrow-local' if broad else 'explicit-local')
            local.mkdir()
            git('init', '-q', '-b', 'main')
            git('config', 'user.name', 'Smoke Test')
            git('config', 'user.email', 'smoke@example.invalid')
            (local / 'task.txt').write_text('base\n')
            git('add', '.')
            git('commit', '-m', 'base')
            (local / '.pi').mkdir()
            (local / '.pi/loops.json').write_text('local')
            with Pi(local, agent, provider) as pi:
                pi.click('[ ] 新建 Worktree')
                pi.until('[x] 新建 Worktree')
                pi.send(b'Edit with overbroad review.\r' if broad else b'Edit with runtime state.\r')
                pi.until('Worktree ready.', 40)
                original = task()['review']
                assert original['files'] == (['.pi/loops.json', 'task.txt'] if broad else ['task.txt'])
                pi.click('[ 预览改动 ]')
                pi.click('[ 预览 ]')
                if broad:
                    pi.until('预览冲突 · 项目目录未修改')
                    pi.click('[ 调整交付清单 ]')
                    pi.click('[ [x] ".pi/loops.json" ]')
                    pi.until('[ [ ] ".pi/loops.json" ]')
                    pi.click('[ 保存交付清单 ]')
                    pi.until('已更新交付清单')
                    assert task()['review']['id'] != original['id']
                    assert task()['review']['files'] == ['task.txt']
                    assert (local / 'task.txt').read_text() == 'base\n'
                    pi.click('[ 预览改动 ]')
                    pi.click('[ 预览 ]')
                pi.until('Worktree · 已预览')
                assert (local / 'task.txt').read_text() == 'task edit\n'
                assert (local / '.pi/loops.json').read_text() == 'local'
                pi.click('[ 确认提交 ]')
                pi.click('[ 提交并保留 ]')
                pi.until('已交付 · 发送后在新 Worktree 继续')
                pi.until('Worktree ready.')
                delivered = task()
                assert git('show', '--format=', '--name-only') == 'task.txt'
                assert delivered['cleanup']['status'] == 'retained'
                assert (Path(delivered['isolatedPath']) / '.pi/loops.json').read_text() == 'isolated'
        print('real Pi: explicit review and mouse narrowing after conflict preserve unrelated runtime state in both checkouts', flush=True)

        local = base / 'parallel-local'
        local.mkdir()
        git('init', '-q', '-b', 'main')
        git('config', 'user.name', 'Smoke Test')
        git('config', 'user.email', 'smoke@example.invalid')
        (local / 'task.txt').write_text('base\n')
        git('add', '.')
        git('commit', '-m', 'base')
        with Pi(local, agent, provider) as first:
            first.click('[ ] 新建 Worktree')
            first.until('[x] 新建 Worktree')
            first.send(kickoff.encode() + b'\r')
            first.until('Worktree ready.', 40)
            first_task = task()
            first.click('[ 预览改动 ]')
            first.click('[ 预览 ]')
            first.until('Worktree · 已预览')
            with Pi(local, agent, provider) as second:
                second.click('[ ] 新建 Worktree')
                second.until('[x] 新建 Worktree')
                second.send(kickoff.encode() + b'\r')
                second.until('Worktree ready.', 40)
                second_task = task()
                assert first_task['localSession']['id'] != second_task['localSession']['id']
                assert first_task['isolatedPath'] != second_task['isolatedPath']
                assert (local / 'task.txt').read_text() == 'task edit\n'
                before = tasks()
                second.click('[ 预览改动 ]')
                second.click('[ 预览 ]')
                second.until('正在预览另一个任务')
                assert tasks() == before
                first.click('[ 撤回预览 ]')
                first.click('[ 撤回 ]')
                first.until('Worktree · 待验收')
                assert (local / 'task.txt').read_text() == 'base\n'
                second.click('[ 预览改动 ]')
                second.click('[ 预览 ]')
                second.until('Worktree · 已预览')
                assert task()['phase'] == 'previewed'
                assert (local / 'task.txt').read_text() == 'task edit\n'
        print('real Pi: parallel Worktrees from different Local sessions; Local preview held and released independently', flush=True)

        # Pause a real Git preflight until the PTY has observed multiple spinner frames.
        # The wrapper is used by Pi only; verification commands from Python use real Git.
        git_bin = base / 'slow-git-bin'
        git_bin.mkdir()
        gate = base / 'pause-apply-check'
        real_git = shlex.quote(shutil.which('git'))
        wrapper = git_bin / 'git'
        wrapper.write_text(f'''#!/bin/sh
case " $* " in
  *" apply --check "*)
    count=0
    while [ -f {shlex.quote(str(gate))} ] && [ "$count" -lt 200 ]; do
      sleep .05
      count=$((count + 1))
    done
    ;;
esac
exec {real_git} "$@"
''')
        wrapper.chmod(0o755)
        for from_worktree in (True, False):
            local = base / ('direct-from-worktree' if from_worktree else 'direct-from-local')
            local.mkdir()
            git('init', '-q', '-b', 'main')
            git('config', 'user.name', 'Smoke Test')
            git('config', 'user.email', 'smoke@example.invalid')
            (local / 'task.txt').write_text('base\n')
            (local / 'user.txt').write_text('user base\n')
            git('add', '.')
            git('commit', '-m', 'base')
            head = git('rev-parse', 'HEAD')
            (local / 'user.txt').write_text('my staged edit\n')
            git('add', 'user.txt')
            (local / 'user.txt').write_text('my unstaged edit\n')
            staged = git('diff', '--cached')
            unstaged = git('diff')
            with Pi(local, agent, provider, git_bin=git_bin) as pi:
                pi.click('[ ] 新建 Worktree')
                pi.until('[x] 新建 Worktree')
                pi.send((kickoff if from_worktree else 'Edit many files.').encode() + b'\r')
                pi.until('Worktree ready.', 40)
                before = task()
                isolated = Path(before['isolatedPath'])
                if not from_worktree:
                    pi.click('⋯ 更多')
                    pi.click('[ 返回原对话 ]')
                    pi.until('项目目录 · Worktree 待验收')
                assert '跳过预览，直接提交' not in pi.dump(), 'direct commit is menu-only'
                pi.click('⋯ 更多')
                pi.click('[ 跳过预览，直接提交 ]')
                pi.until('跳过预览，直接提交？')
                pi.until('写入项目目录并提交。')
                pi.until('提交标题：Isolated smoke change')
                if from_worktree:
                    pi.until('项目目录 · 1 个文件')
                else:
                    pi.until('项目目录 · 33 个文件')
                    pi.until('• "extra-01.txt"')
                    assert '• "task.txt"' not in pi.dump()
                    pi.click('详情 1–')
                pi.until('• "task.txt"')
                assert '• "user.txt"' not in pi.dump()
                assert '正在直接提交' not in pi.dump()
                pi.send(b'\r')  # Cancel is preselected.
                pi.until_gone('跳过预览，直接提交？')
                assert git('rev-parse', 'HEAD') == head and task() == before
                assert (local / 'task.txt').read_text() == 'base\n'
                if from_worktree:
                    veto = base / 'veto-switch'
                    slow_veto = base / 'slow-veto-switch'
                    veto.touch()
                    slow_veto.touch()
                    pi.click('⋯ 更多')
                    pi.click('[ 跳过预览，直接提交 ]')
                    pi.click('[ 提交并安全清理 ]')
                    pi.until('正在切换提交环境')
                    pi.until('Pi 取消了切换，未提交。')
                    pi.until_gone('正在切换提交环境')
                    assert git('rev-parse', 'HEAD') == head and task() == before
                    assert (local / 'task.txt').read_text() == 'base\n'
                    veto.unlink()
                    slow_veto.unlink()
                pi.click('⋯ 更多')
                pi.click('[ 跳过预览，直接提交 ]')
                gate.touch()
                try:
                    pi.click('[ 提交并安全清理 ]' if from_worktree else '[ 提交并保留 ]')
                    pi.until('正在直接提交')
                    frame = next(line for line in pi.screen.display if '正在直接提交' in line)
                    end = time.monotonic() + 3
                    while frame in pi.screen.display and time.monotonic() < end:
                        pi.read(.15)
                    assert frame not in pi.screen.display and '正在直接提交' in pi.dump(), pi.dump()
                    assert git('rev-parse', 'HEAD') == head
                    if from_worktree:
                        assert '[ 回到 Worktree ]' not in pi.dump() and '[ 返回原对话 ]' not in pi.dump()
                        pi.send(b'Do not send during delivery.\r')
                        pi.until('消息未发送')
                        assert 'Do not send during delivery.' not in Path(before['localSession']['file']).read_text()
                finally:
                    gate.unlink()
                pi.until('已交付 · 发送后在新 Worktree 继续' if from_worktree else '项目目录 · Worktree 已交付')
                pi.until_gone('正在直接提交')
                done = task()
                assert done['phase'] == 'delivered' and not done.get('receipt') and not done.get('journal')
                assert done['cleanup']['status'] == ('done' if from_worktree else 'retained')
                assert isolated.is_dir() != from_worktree
                assert git('rev-parse', 'HEAD^') == head
                assert git('log', '-1', '--format=%s') == 'Isolated smoke change'
                assert git('show', '--format=', '--name-only').splitlines() == (
                    ['task.txt'] if from_worktree else [*(f'extra-{i:02}.txt' for i in range(1, 33)), 'task.txt'])
                assert (local / 'task.txt').read_text() == 'task edit\n'
                assert git('diff', '--cached') == staged and git('diff') == unstaged
                if from_worktree:
                    pi.until('Worktree ready.')
                    pi.until('Do not send during delivery.')  # blocked input was restored to the editor
                    assert 'Do not send during delivery.' not in Path(done['isolatedSession']['file']).read_text()
                    pi.send(b'\x15')  # clear the unsent draft before entering a shell command
                    source = Path(done['isolatedSession']['file'])
                    saved = source.read_bytes()
                    pi.send(b'!touch forbidden-in-history\r')
                    pi.until('请返回原对话再执行 shell')
                    assert not (local / 'forbidden-in-history').exists()
                    (local / 'latest.txt').write_text('post-delivery HEAD\n')
                    git('add', 'latest.txt')
                    git('commit', '--only', '-m', 'Advance project before continuation', '--', 'latest.txt')
                    latest = git('rev-parse', 'HEAD')
                    pi.send(b'Follow up from delivery.\r')
                    pi.until('Received follow-up with original context.', 35)
                    next_task = task()
                    assert next_task['followUpOf'] == done['id'] and next_task['baseOid'] == latest
                    assert not isolated.exists() and source.read_bytes() == saved
                    assert (Path(next_task['isolatedPath']) / 'latest.txt').read_text() == 'post-delivery HEAD\n'
                    assert (Path(next_task['isolatedPath']) / 'user.txt').read_text() == 'user base\n'
                    assert Path(next_task['isolatedSession']['file']).read_text().count('Follow up from delivery.') == 1
                    assert 'Follow up from delivery.' not in Path(next_task['localSession']['file']).read_text()
        print('real Pi: direct commit from either side; Worktree transcript remains, and follow-up uses latest HEAD after cleanup', flush=True)

        for prompt, response, expanded in [
            (b'/smoke-task', 'Expanded Worktree template.', 'Registered Worktree prompt.'),
            (b'/skill:smoke-worktree smoke argument', 'Expanded Worktree skill.', 'Worktree skill marker.'),
        ]:
            with Pi(local, agent, provider) as pi:
                pi.click('[ ] 新建 Worktree')
                pi.until('[x] 新建 Worktree')
                before = len(tasks())
                pi.send(prompt + b'\r')
                pi.until('Worktree · 进行中', 40)
                pi.until(response)
                assert len(tasks()) == before + 1
                assert expanded in Path(task()['isolatedSession']['file']).read_text()
                assert expanded not in Path(task()['localSession']['file']).read_text()
        print('real Pi: template and skill prompts were expanded only after switching to Worktree', flush=True)


if __name__ == '__main__':
    main()
