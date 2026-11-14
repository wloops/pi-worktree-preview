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
export default function(pi) {
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
    def __init__(self, cwd, agent, provider):
        self.screen = pyte.Screen(COLS, ROWS)
        self.stream = pyte.ByteStream(self.screen)
        self.pid, self.fd = pty.fork()
        if not self.pid:
            os.chdir(cwd)
            os.environ.update(PI_CODING_AGENT_DIR=str(agent), TERM='xterm-256color', COLORTERM='truecolor')
            os.execvp('pi', ['pi', '--tui-mode', 'fullscreen', '-ne', '--no-mcp', '-ns', '-np', '-na',
                             '--provider', 'wtp-smoke', '--model', 'model', '-e', str(ROOT / 'src/index.ts'), '-e', str(provider)])
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))

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
                    return line.index(text) + 1, y + 1
            self.read()
        raise AssertionError(f'Missing {text!r}:\n{self.dump()}')

    def send(self, data):
        os.write(self.fd, data)

    def click(self, text):
        x, y = self.until(text)
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
            return subprocess.check_output(['git', '-C', str(local), *args], text=True).strip()

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
        baseline = git('status', '--porcelain')
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
        with Pi(local, agent, provider) as pi:
            pi.until('Local · 待验收')
            pi.click('[ 工作树操作 ]')
            pi.click('[ 进入 / 恢复 Worktree ]')
            pi.until('Worktree · 待验收')
            pi.until('Worktree ready.')
            pi.click('[ 工作树操作 ]')
            pi.click('[ 返回 Local ]')
            pi.until('Local · 待验收')
            pi.click('[ 工作树操作 ]')
            pi.click('[ 预览到 Local ]')
            pi.click('[ 取消 ]')
            assert (local / 'task.txt').read_text() == 'base\n'
            pi.click('[ 工作树操作 ]')
            pi.click('[ 预览到 Local ]')
            pi.click('[ 执行预览到 Local ]')
            pi.until('Local · 已预览')
            assert (local / 'task.txt').read_text() == 'task edit\n'
            assert git('rev-parse', 'HEAD') == head
            pi.click('[ 工作树操作 ]')
            pi.click('[ 撤回预览 ]')
            pi.click('[ 执行撤回预览 ]')
            pi.until('Local · 待验收')
            assert git('status', '--porcelain') == baseline
            pi.click('[ 工作树操作 ]')
            pi.click('[ 预览到 Local ]')
            pi.click('[ 执行预览到 Local ]')
            pi.until('Local · 已预览')
            pi.click('[ 工作树操作 ]')
            pi.click('[ 确认提交 ]')
            pi.click('[ 执行确认提交 ]')
            pi.until('Local · 已交付')
            assert git('show', '--format=', '--name-only') == 'task.txt'
            assert git('status', '--porcelain') == baseline
            assert not first_path.exists()
            print('real Pi: resumed transcript, canceled, previewed, rolled back, re-previewed and committed only task', flush=True)
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


if __name__ == '__main__':
    main()
