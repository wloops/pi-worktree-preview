#!/usr/bin/env python3
"""Exercise the installed Pi fullscreen UI over a real PTY. pip install pyte."""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time

import pyte

ROOT = Path(__file__).resolve().parents[1]
COLS, ROWS = 110, 35
# Use a deterministic offline provider, but run the real agent, bash tool, and review tool.
PROVIDER = '''
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export default function(pi) {
  const veto = fileURLToPath(new URL('./veto-switch', import.meta.url));
  pi.on('session_before_switch', () => existsSync(veto) ? { cancel: true } : undefined);
  pi.registerProvider("wtp-smoke", {
    baseUrl: "http://127.0.0.1:1", apiKey: "offline-test", api: "wtp-stub",
    models: [{ id: "model", name: "Offline Smoke", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.at(-1);
      const task = context.messages.findLast(message => message.role === "user")?.content;
      const text = typeof task === "string" ? task : task?.find(part => part.type === "text")?.text;
      const step = last?.role !== "toolResult" ? (text === "Local only." || text === "Open a task to discard." ? 3 : 0) : last.toolName === "bash" ? 1 : 2;
      const tool = step === 0 ? {type:"toolCall",id:"test_bash",name:"bash",arguments:{command:"printf 'task edit\\\\n' > task.txt"}} :
        {type:"toolCall",id:"test_ready",name:"worktree_ready_for_review",arguments:{commitMessage:"Isolated smoke change"}};
      const msg = {role:"assistant", content: step < 2 ? [tool] : [{type:"text",text:step === 3 ? "Acknowledged without edits." : "Worktree ready."}],
        api:model.api, provider:model.provider, model:model.id, stopReason:step < 2 ? "toolUse" : "stop",
        usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},timestamp:Date.now()};
      queueMicrotask(() => { stream.push({type:"start",partial:msg});
        if (step < 2) stream.push({type:"toolcall_end",contentIndex:0,toolCall:tool,partial:msg});
        stream.push({type:"done",reason:msg.stopReason,message:msg}); stream.end(); });
      return stream;
    }
  });
}
'''


class Pi:
    def __init__(self, cwd, agent, provider, theme='dark', cols=COLS, rows=ROWS):
        self.screen = pyte.Screen(cols, rows)
        self.stream = pyte.ByteStream(self.screen)
        (agent / 'settings.json').write_text(json.dumps({'theme': theme}))
        self.pid, self.fd = pty.fork()
        if not self.pid:
            os.chdir(cwd)
            os.environ.update(PI_CODING_AGENT_DIR=str(agent), TERM='xterm-256color', COLORTERM='truecolor')
            os.execvp('pi', ['pi', '--tui-mode', 'fullscreen', '-ne', '--no-mcp', '-ns', '-np', '-na',
                             '--provider', 'wtp-smoke', '--model', 'model', '-e', str(ROOT / 'src/index.ts'), '-e', str(provider)])
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

    def dump(self):
        return '\n'.join(line.rstrip() for line in self.screen.display)

    def read(self, wait=.2):
        if select.select([self.fd], [], [], wait)[0]:
            data = os.read(self.fd, 65536)
            # pyte doesn't implement OSC 66 (text sizing), which isn't needed here.
            self.stream.feed(re.sub(rb'\x1b\]66;[^\x07]*(?:\x07|\x1b\\)', b'', data))

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
        self.click_at(*self.until(text))

    def click_at(self, x, y):
        self.send(f'\x1b[<0;{x};{y}M'.encode())
        time.sleep(.04)
        self.send(f'\x1b[<0;{x};{y}m'.encode())

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
        provider = base / 'offline.ts'
        provider.write_text(PROVIDER)
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

        def task():
            return json.loads(state_path.read_text())['tasks'][-1]

        kickoff = 'Edit task.txt and mark ready.'
        git('switch', '--detach', '--quiet')
        with Pi(local, agent, provider) as pi:
            pi.click('[ ] 新建 Worktree')
            pi.until('[x] 新建 Worktree')
            pi.send(b'Do not send this to Local.\r')
            pi.until('消息未发送到 Local')
            pi.until('Do not send this to Local.')
            assert not state_path.exists()
            assert (local / 'task.txt').read_text() == 'base\n'
        git('switch', '--quiet', 'main')
        with Pi(local, agent, provider) as pi:
            pi.click('[ ] 新建 Worktree')
            pi.until('[x] 新建 Worktree')
            assert not state_path.exists(), 'checking must not create anything'
            pi.click('[x] 新建 Worktree')
            pi.until('[ ] 新建 Worktree')
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
        for theme, cols, rows in [('light', 110, 35), ('dark', 42, 11)]:
            with Pi(local, agent, provider, theme, cols, rows) as pi:
                pi.until('Local · 待验收')
                pi.click('[ 工作树操作 ]')
                _, border_y = pi.until('╭───')
                border_x = pi.screen.display[border_y - 1].index('╭')
                right_x = pi.screen.display[border_y - 1].index('╮', border_x)
                title_x, title_y = pi.until('Worktree 预览工作台')
                title = pi.screen.buffer[title_y - 1]
                assert title[title_x - 1].bold and title[title_x - 1].bg == {'light': 'dee8fa', 'dark': '253651'}[theme]
                _, cancel_y = pi.until('[ 关闭 ]')
                cancel = pi.screen.buffer[cancel_y - 1]
                assert cancel[border_x + 1].bg == cancel[right_x - 1].bg != 'default'
                assert cancel[border_x + 1].bg != title[title_x - 1].bg
                pi.click_at(border_x + 1, cancel_y)  # clicking the frame must not close the panel
                pi.send(b'\x1b[A\x1b[A\r')
                pi.until('确认：预览到 Local')
                pi.click('[ 取消 ]')
                assert git('rev-parse', 'HEAD') == head and task()['phase'] == 'ready'
        print('real Pi: opaque framed panels with highlighted selection in light and narrow dark terminals', flush=True)
        for root, value in [(local, 'Local loop'), (first_path, 'Worktree loop')]:
            (root / '.pi').mkdir(exist_ok=True)
            (root / '.pi/loops.json').write_text(value)
        baseline = git('status', '--porcelain')
        with Pi(local, agent, provider) as pi:
            pi.until('Local · 待验收')
            pi.click('[ 工作树操作 ]')
            pi.click('[ 进入 / 恢复 Worktree ]')
            pi.until('Worktree · 待验收')
            pi.until('Worktree ready.')
            pi.click('[ 预览到 Local ]')
            pi.until('确认：预览到 Local')
            pi.click('[ 取消 ]')
            pi.until_gone('确认：预览到 Local')
            assert (local / 'task.txt').read_text() == 'base\n'
            pi.click('[ 预览到 Local ]')
            pi.click('[ 执行预览到 Local ]')
            pi.until('Worktree · 已预览')
            assert (local / 'task.txt').read_text() == 'task edit\n'
            assert git('rev-parse', 'HEAD') == head
            (local / '.pi/loops.json').write_text('Local loop edited after preview')
            pi.click('[ 撤回预览 ]')
            pi.click('[ 执行撤回预览 ]')
            pi.until('Worktree · 待验收')
            assert git('status', '--porcelain') == baseline
            pi.click('[ 预览到 Local ]')
            pi.click('[ 执行预览到 Local ]')
            pi.until('Worktree · 已预览')
            pi.click('[ 打开 Local 检查 ]')
            pi.until('Local · 已预览')
            pi.until('[ 撤回预览 ]')
            pi.until('[ 确认提交 ]')
            pi.click('[ 工作树操作 ]')
            pi.click('[ 进入 / 恢复 Worktree ]')
            pi.until('Worktree · 已预览')
            veto = base / 'veto-switch'
            veto.touch()
            pi.click('[ 确认提交 ]')
            pi.click('[ 提交并清理 Worktree（默认） ]')
            pi.until('Pi 取消了切换，未提交。')
            assert git('rev-parse', 'HEAD') == head and task()['phase'] == 'previewed' and first_path.is_dir()
            veto.unlink()
            (local / '.pi/loops.json').write_text('Local loop edited before finalizing')
            pi.click('[ 确认提交 ]')
            pi.click('[ 提交并清理 Worktree（默认） ]')
            pi.until('Local · 已交付')
            assert git('show', '--format=', '--name-only') == 'task.txt'
            assert git('status', '--porcelain') == baseline
            assert task()['cleanup']['status'] == 'retained' and not task()['cleanup'].get('requested')
            assert (first_path / '.pi/loops.json').read_text() == 'Worktree loop'
            assert (local / '.pi/loops.json').read_text() == 'Local loop edited before finalizing'
            print('real Pi: Worktree preview and rollback stay put; vetoed switch; task-only commit preserves both late .pi/loops.json files', flush=True)
            pi.click('[ ] 新建 Worktree')
            pi.until('[x] 新建 Worktree')
            pi.send(b'Open a task to discard.\r')
            pi.until('Worktree · 进行中')
            pi.until('Acknowledged without edits.')
            second_path = Path(task()['isolatedPath'])
            (second_path / 'discard.txt').write_text('discarded')
            pi.click('[ 工作树操作 ]')
            pi.click('[ 返回 Local ]')
            pi.until('Local · 进行中')
            pi.click('[ 工作树操作 ]')
            pi.click('[ 放弃任务 ]')
            pi.click('[ 执行放弃任务 ]')
            pi.until('Local · 已放弃')
            assert not second_path.exists()
            assert not (local / 'discard.txt').exists()
            print('real Pi: discarded an unpreviewed task with safe cleanup', flush=True)

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
            pi.click('[ ] 新建 Worktree')
            pi.until('[x] 新建 Worktree')
            pi.send(kickoff.encode() + b'\r')
            pi.until('Worktree ready.', 40)
            pi.click('[ 预览到 Local ]')
            pi.click('[ 执行预览到 Local ]')
            pi.until('Worktree · 已预览')
            assert not index.exists()
            pi.click('[ 确认提交 ]')
            pi.click('[ 提交并保留 Worktree ]')
            pi.until('Local · 已交付')
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
            pi.click('[ 已保留的 Worktree ]')
            pi.click(f'[ {task_id} · Isolated smoke change ]')
            pi.until('Worktree · 已交付')
            pi.until('Worktree ready.')
            pi.click('[ 工作树操作 ]')
            pi.click('[ 返回 Local ]')
            pi.until('Local · 已交付')
            print('real Pi: explicit retention with absent Local index; environment and session reopen after restart', flush=True)


if __name__ == '__main__':
    main()
