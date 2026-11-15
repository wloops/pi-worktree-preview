# pi-worktree-preview

在隔离的 Git Worktree 里用 Pi 并行开发，把改动直接预览到原 checkout，运行测试后再撤回或提交。不需要复制文件、切换 Local 分支或手动暂存。

A Pi fullscreen extension for parallel Git worktrees and reversible previews in your original checkout. Develop in separate sessions, review one task at a time, and commit only its changes.

## 安装与试用

需要 Pi 1.5.2 或兼容版本、较新的 Git（已验证 2.55）、支持鼠标的终端，以及有初始提交、位于普通分支的 Git checkout。请先配置 Git 提交身份（`user.name`、`user.email`）和 Pi 模型。

从 [npm](https://www.npmjs.com/package/pi-worktree-preview) 安装：

```sh
pi install npm:pi-worktree-preview
cd /path/to/your/repo
pi --tui-mode fullscreen
```

也可以从 GitHub 安装固定版本：`pi install git:github.com/wloops/pi-worktree-preview@v0.1.1`。两种安装方式任选其一。

若已经从源码目录安装过，请先用 `pi list` 和 `pi remove /path/to/pi-worktree-preview` 移除旧入口，避免同时加载两份扩展。源码开发时也可直接运行 `pi --tui-mode fullscreen -e /path/to/pi-worktree-preview/src/index.ts`。

1. 勾选编辑器上方的 **[ ] 新建 Worktree**，输入任务并发送。勾选本身不会创建目录；发送时才创建隔离 Worktree、切换到新会话，并只把这条消息发到新会话。再次点击可取消勾选。`/skill:…` 和提示词模板也是任务输入，会先切进 Worktree 再展开；Pi 界面命令（如 `/settings`）、扩展命令和 `!` shell 命令由 Pi 直接处理，不触发创建。退出 Pi 后，用 Pi 的会话选择器（`pi --resume`）恢复创建任务的那条 Local 会话，再点 **⋯ 更多 → 进入 / 恢复 Worktree**，也可直接恢复原 Worktree 会话。
2. Agent 提供本次任务的文件清单并标记 **待验收**（也可从菜单手动勾选）。这一步只锁定清单内当时的内容，不改 Local。若误把运行状态或其他无关文件列入，可点 **⋯ 更多 → 调整交付清单**，取消勾选后保存。预览冲突面板也有这个入口；保存不会更新保留文件的内容，也不会自动重试预览。
3. 在 Worktree 编辑器旁点击 **预览到 Local → 预览**。预览不暂存、不提交，也不会自动切换会话。想在 Pi 里对原目录运行测试时，再点 **打开 Local 检查**；仍可从 Local 的操作菜单回 Worktree。如果 Local 的新提交与任务冲突，点 **让 Agent 解决冲突**：回到原 Worktree，仅合并确认时的 Local `HEAD`，解决后重新标记待验收。新版本仍需你重新点击预览；Local 的未提交改动不会被搬进 Worktree。
4. 想返修时，在原 Worktree 会话直接发送修改要求。未预览时，Agent 开始返修前会作废旧验收，无需确认。已预览时，Agent 会显示 **撤回预览，继续返修**；点一次，Local 撤回成功后 Agent 会接着处理刚才的要求，无需重发。取消或撤回失败则不开始修改；单纯提问不会作废验收。若只想恢复 Local、不需要返修，两边的 **撤回预览** 仍可单独执行，保留旧验收。
5. 两边都能直接点击 **确认提交**。确认框提供 **提交并安全清理** 或 **提交并保留**。两者都只提交任务改动、保留 Local 原有改动；选择清理时，安全检查不通过仍会保留目录。从 Worktree 确认提交时，会先切到原 Local 会话；切换被取消则不提交。主动保留或未通过清理检查的环境，可以在 Local 点 **⋯ 更多 → 已保留的 Worktree** 恢复会话检查或发起清理；任务已结束，不会继续交付，也不会定时删除。尚未预览的任务仍可在 Local 菜单里放弃。
   若不需要先在 Local 检查，待验收时在任一绑定会话点 **⋯ 更多 → 跳过预览，直接提交** 并确认。它只交付冻结清单，不会进入「已预览」，也没有可撤回的预览。Local 原有暂存或未提交改动若与清单路径重叠，直接提交会停止；可改用预览检查。遇到合并冲突时，也可通过预览入口查看冲突处理选项。
6. 任务已交付或放弃后，在 Local 点击 **任务历史** 并选中任务，Pi 消息区会立即显示旧对话。此时只是查看历史，不创建 Worktree；不想继续可点击 **返回 Local**。发送第一条后续要求时，才从 Local 当前分支的 `HEAD` 新建隔离目录并继承对话。不带入旧任务的未提交改动，也不改动原会话。旧 Worktree 已清理仍可续接，只要原 Pi 会话文件还在。

编辑器上方的操作条只在任务所属的 Local 或 Worktree 会话显示该任务的阶段和操作。需要并行开发时，在同一个 checkout 新开一个 Local 对话，勾选 **[ ] 新建 Worktree** 后发送任务。每个 Local 对话只显示自己的进行中任务；其他任务即使正在预览，也不影响新建或修改隔离 Worktree。已结束任务的历史和保留目录仍可从同一 checkout 查看。每次写入或放弃都需要单独确认；确认框初始选中取消，避免直接按 Enter 误执行。面板详情过长时，可用滚轮或 Page Up / Page Down 查看。强删确认需要终端完整显示警告和目标路径。`/worktree-preview` 是菜单的键盘备用入口。

创建或切换 Worktree，以及实际执行预览、撤回、提交和清理时，编辑器旁会显示当前操作的转圈提示。等待你点确认时不转圈；完成、失败或取消后提示自动消失。

## 安全边界与限制

- 每个 Local 会话同时只绑定一个进行中任务；同一个 checkout 的不同 Local 会话可以并行开发和标记待验收。一个 Local checkout 同时只接受一份预览：先撤回或提交当前预览，才能预览或直接提交另一个任务。如果存在未解决的 Local 写入恢复记录，则停止该 checkout 的自动验收。隔离目录从 Local 当时的 `HEAD` 建立，不复制 Local 的未提交改动和忽略文件，默认位于 `~/.pi/agent/worktree-preview/worktrees/<任务 UUID>/`（可随 `PI_CODING_AGENT_DIR` 改变）。会话使用 Pi 原生持久化；不支持 `--no-session`。Worktree 隔离的是工作目录，不是安全沙箱。待验收或已预览时，Agent 可以读取和讨论，但内置编辑、写入和 shell 工具需等返修开始后才开放；其他扩展和外部进程不受这个限制。
- 预览只合并标记待验收时明确列出的文件和内容，不按目录或扩展名自动排除文件。Worktree 中清单内的工作区内容、文件类型或索引条目有变化时，需重新标记。清单外的改动不会参与合并；工作树有未纳入交付的改动时，提交后保留 Worktree。旧版待验收记录在无法证明原快照时也需重新标记。
- 只由 Local 未提交改动引发的冲突，请先在 Local 自行处理再重试。如果同时有已提交和未提交的冲突，只把已提交部分交给 Agent；未提交部分依然可能阻止下次预览。不支持把含清单外改动、复杂目录或重命名冲突的 Worktree 直接交给自动恢复。Agent 被中断时，可回到原 Worktree，通过 **⋯ 更多 → 让 Agent 继续解决冲突** 继续；不会自动预览或写入 Local。
- 撤回、提交前重新检查 Local 的分支、`HEAD`、整个索引和预览涉及的路径。无关的未暂存改动（包括其他扩展写的状态文件）会保留，不阻止验收。预览路径或索引发生变化则停止。不支持直接把在 Local 预览上做的修订提交回任务；请先将受影响的路径恢复到预览状态，再撤回并在 Worktree 中修改。
- 预览、撤回、提交前会在 Pi 配置目录 `worktree-preview/` 写入恢复记录（默认 `~/.pi/agent/worktree-preview/tasks.json`），并保留所需的 Git 快照或索引副本。中断后不自动重放或抢占残留锁。若工作台提示已停止，先备份 Local、Worktree 和恢复记录，再人工检查；不要直接删除锁、记录或 `refs/pi-worktree-preview/` 来强行继续。
- 默认在交付或放弃后，仅在校验通过时移除隔离 Worktree。如果只是因为后续改动、忽略文件（包括构建产物）或空目录而无法安全清理，会再问是否强删，默认保留。强删永久删除整个隔离目录（含未交付文件），不修改 Local 工作区、提交或 Pi 会话历史；点确认后会再次核对，确认期间有变化、身份不匹配、Git 操作未结束、目录已锁定、存在恢复记录、嵌套仓库、特殊文件或其他受管 Pi 会话占用时不删除。扩展无法确认所有外部进程是否在使用目录，检查和删除也不是原子操作；请先关闭其他相关会话和写入进程。保留的路径会出现在通知或工作台中。
- 当前实现面向 macOS/Linux（已在 macOS 实测）。不支持 sparse checkout、submodule、嵌套仓库、特殊索引条目或影响快照的内容转换/合并属性。暂不预览 `.gitignore` 或 `.gitattributes` 的改动，因为它们可能改变其他文件的快照结果。交付使用 Git plumbing，不运行提交钩子、不签名、不推送。预览、撤回和直接提交不是原子交换；操作时不要让其他进程同时修改同一 checkout（例如自动格式化、构建写回或其他 Git 命令）。直接提交一旦开始写入，若不能确认完成，会保留恢复记录，不自动回滚文件、分支或索引。

## 验证

```sh
npm ci
npm run check
npm test
# 安装 pyte 后，另用真实 Pi fullscreen + PTY 的鼠标测试（需要 pi 在 PATH）：
python3 test/pi-smoke.py
```

`test/pi-smoke.py` 在临时 Git 仓库和临时 Pi 配置中运行，使用离线测试模型，无需 API 密钥；覆盖首条消息创建时保留原 Local 会话、不同 Local 会话的并行 Worktree 与单份 Local 预览、鼠标创建、恢复、取消确认、预览、撤回、同一轮对话中的返修、预览后提交和菜单直接提交、放弃、从已结束会话续接新任务，以及保留后强删和双 Pi 会话占用保护。Git 合并与验收引擎移植自 [`dsh-git-worktree`](https://github.com/wloops/dsh-git-worktree)，保留 MIT 许可。
