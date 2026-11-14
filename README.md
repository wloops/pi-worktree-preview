# pi-worktree-preview

在隔离的 Git Worktree 里用 Pi 完成任务，再回到原 checkout 预览、测试和验收。不需要复制文件、切换 Local 分支或手动暂存。

## 最短试用

需要 Pi 1.5.2、较新的 Git（已验证 2.55）、支持鼠标的终端，以及有初始提交、位于普通分支的 Git checkout。请先配好 `git config user.name` 和 `user.email`，以及 Pi 模型。

```sh
cd /path/to/your/repo
pi --tui-mode fullscreen -e /path/to/pi-worktree-preview/src/index.ts
```

1. 勾选编辑器上方的 **[ ] 新建 Worktree**，输入任务并发送。勾选本身不会创建目录；发送时才创建隔离 Worktree、切换到新会话，并只把这条消息发到新会话。再次点击可取消勾选；斜杠命令和 `!` shell 命令不会触发创建。退出 Pi 后，重新从同一 Local 启动，点 **工作树操作 → 进入 / 恢复 Worktree** 即可继续原会话。
2. Agent 调用工具标记 **待验收**（也可从菜单手动标记）。这一步不改 Local。点击 **工作树操作 → 返回 Local**。
3. 点击 **工作树操作 → 预览到 Local → 执行预览到 Local**。直接在原目录检查、运行、测试。预览不暂存、不提交。
4. 在操作菜单里点击并确认 **撤回预览** 或 **确认提交**。前者还原预览前的文件状态，可再次预览；后者只提交本次任务，不把 Local 原有的暂存、未暂存或未跟踪改动混入。尚未预览的任务也可以点击 **放弃任务**。

每次写入或放弃都需要单独确认。也可用方向键与 Enter 操作；`/worktree-preview` 是菜单的键盘备用入口。若希望始终启用，可运行 `pi install /path/to/pi-worktree-preview`，再用 `pi --tui-mode fullscreen` 启动。

## 安全边界与限制

- 一个 Local checkout 同时只有一个进行中的任务。隔离目录从 Local 当时的 `HEAD` 建立，不复制 Local 的未提交改动和忽略文件。会话使用 Pi 原生持久化；不支持 `--no-session`。Worktree 隔离的是工作目录，不是安全沙箱。
- 预览前会检查冲突和待验收快照；撤回、提交前重新检查 Local 的 `HEAD`、索引和工作区。可可靠分离的同文件改动可共存；冲突或漂移则停止。不支持直接把在 Local 预览上做的修订提交回任务；请先将 Local 恢复到准确的预览状态，再撤回并在 Worktree 中修改。
- 预览、撤回、提交前会在 Pi 配置目录 `worktree-preview/` 写入恢复记录（默认 `~/.pi/agent/worktree-preview/tasks.json`），并保留所需的 Git 快照或索引副本。中断后不自动重放或抢占残留锁。若工作台提示已停止，先备份 Local、Worktree 和恢复记录，再人工检查；不要直接删除锁、记录或 `refs/pi-worktree-preview/` 来强行继续。
- 交付或放弃后，仅在校验通过时移除隔离 Worktree；忽略文件（包括构建产物）、特殊文件或后续改动会使 Worktree 被保留。Pi 会话历史不删除。保留的路径会出现在通知或工作台中。
- 当前实现面向 macOS/Linux（已在 macOS 实测）。不支持 sparse checkout、submodule、嵌套仓库、特殊索引条目或影响快照的内容转换/合并属性。交付使用 Git plumbing，不运行提交钩子、不签名、不推送。预览/撤回是多文件操作，不是原子交换；操作时不要让其他进程同时修改同一 checkout（例如自动格式化、构建写回或其他 Git 命令）。

## 验证

```sh
npm ci
npm run check
npm test
# 安装 pyte 后，另用真实 Pi fullscreen + PTY 的鼠标测试（需要 pi 在 PATH）：
python3 test/pi-smoke.py
```

`test/pi-smoke.py` 在临时 Git 仓库和临时 Pi 配置中运行，使用离线测试模型，无需 API 密钥；覆盖鼠标创建、恢复、取消确认、预览、撤回、提交及放弃。Git 合并与验收引擎移植自 [`dsh-git-worktree`](https://github.com/wloops/dsh-git-worktree)，保留 MIT 许可。
