# pi-worktree-preview

[![npm 月下载量](https://img.shields.io/npm/dm/pi-worktree-preview?label=npm%20downloads)](https://www.npmjs.com/package/pi-worktree-preview)

用 Pi 在隔离的 Git Worktree 里并行开发。改完直接在原项目目录预览和测试：满意就提交，不满意就撤回。不用切分支，也不用手动暂存。

- **Pi 终端**：用鼠标新建 Worktree、预览、返修和提交。
- **Pi RPC 客户端**：用斜杠命令操作，也可[接入已有的 Worktree](#接入已有的-worktree)，不必重开任务。

## 快速开始

需要 Pi 1.5.2 或兼容版本，以及已有初始提交的 Git 分支。请先配置 Pi 模型和 Git 提交身份。

```sh
pi install npm:pi-worktree-preview
cd /path/to/your/repo
pi
```

Pi 默认使用 fullscreen。在支持鼠标的终端里，直接运行 `pi` 就能点击 Worktree 按钮。如果你把 Pi 设置成了 regular，可用 `/worktree-preview` 打开菜单并用键盘操作；想用鼠标时，再用 `pi --tui-mode fullscreen` 启动。

也可从 [GitHub](https://github.com/wloops/pi-worktree-preview/releases) 安装：`pi install git:github.com/wloops/pi-worktree-preview@v0.2.3`。切换安装来源前，先用 `pi list` 找到旧入口，再用 `pi remove <旧入口>` 移除，避免重复加载。

1. **新建 Worktree**：勾选编辑器上方的复选框，再发送任务。可以先在原对话讨论；新会话自动带上当前分支的聊天上下文，但目录仍从发送时的 `HEAD` 创建，不复制未提交的文件（聊天里已经出现的内容仍会带上）。这条消息只发到新会话。
2. **待验收**：Agent 用任务对话的语言拟定提交标题，必要时补充正文，并标记要交付的文件，不改项目目录。清单里有无关文件，可在 **⋯ 更多 → 调整交付清单** 移除。提交前可滚动查看标题、正文和文件清单。
3. **预览改动**：把改动写入原项目目录，不暂存、不提交。可直接在原目录测试，或点 **打开项目目录检查**。
4. **撤回预览** 或 **确认提交**：撤回恢复预览前的状态；提交只带本次任务改动，可选择清理或保留 Worktree。

## 其他常用操作

默认界面为简体中文。在 **⋯ 更多 → 显示语言** 可切换 **English**，也可运行 `/worktree-preview-language en`；用 `zh` 切回。设置会保存，当前会话立即生效，其他已开的 Pi 会话重新加载扩展后生效。它只影响本扩展的显示，不设置 Pi、聊天或 Git 提交的语言。

| 想做什么 | 怎么做 |
| --- | --- |
| 并行开发或恢复任务 | 每个原对话可开一个任务；同一项目一次只能有一份预览。运行 `pi -r`，按 `Tab` 切到 **All**，在 **Threaded** 视图下可从原对话下面直接恢复新建且目录仍在的 Worktree。也可恢复原对话后点 **进入 / 恢复 Worktree**（旧任务也适用）；已清理的任务从 **任务历史** 打开。 |
| 继续修改 | 在 Worktree 里直接说要改什么。若已预览，确认 **撤回预览，继续返修** 后，Agent 接着处理，不用重发。 |
| 解决预览冲突 | 如果冲突来自项目目录的新提交，可点 **让 Agent 解决冲突**，解决后重新标记待验收，再预览。如果是与未提交改动冲突，预览不会写入文件；先对比项目原目录与 Worktree 两边的改动。 |
| 直接提交或放弃 | 待验收时可从 **⋯ 更多** 跳过预览直接提交。**放弃任务** 只在对应 Worktree 的菜单里；若已预览，先撤回。 |
| 续接已结束的对话 | 提交后可留在原任务对话，也可从 **任务历史** 打开。提问不新建；明确要求修改时，Agent 才从项目目录最新 `HEAD` 开新 Worktree，不带旧目录的未提交文件。 |

## 接入已有的 Worktree

外部接入和下文的独立斜杠命令需要 v0.2.0 或更新版本。

已经在外部 Worktree（例如 T3 Code 创建的 Worktree）里工作？在**该 Worktree 的 Pi 对话**里操作：

1. **接入**：运行 `/worktree-preview-adopt`。插件识别目标 checkout 和共同分叉基点，登记当前改动，不写入两边的工作目录。
2. **核对并预览**：运行 `/worktree-preview-status` 查看文件，再运行 `/worktree-preview-preview` 并确认。预览写入目标目录，不暂存、不提交。默认清单包含所有检测到的改动，包括未忽略的新文件；如只交付部分，可先运行 `/worktree-preview-adopt 1,3` 保留第 1、3 项，或在 fullscreen TUI 里用 **⋯ 更多 → 调整交付清单**。
3. **返修或提交**：需要改就直接在同一对话里说。已预览时，确认 **撤回预览，继续返修** 后，Agent 接着处理同一条消息；未预览时可直接返修。改完重新标记待验收，不用重新接入。验收通过就运行 `/worktree-preview-commit`；想撤回用 `/worktree-preview-rollback`。

**遇到提交冲突（v0.2.2 起）**：在接入任务的源 Worktree 对话选择 **让 Agent 解决冲突**。Agent 在独立目录处理，原外部 Worktree 和目标 checkout 都不变。解决后会重新标记待验收，由你再次预览；目标目录的未提交内容不会带入。处理被中断时可用 **继续解决冲突** 或 `/worktree-preview-recover`。独立冲突目录保留在插件数据目录中，便于检查，不会自动清理。

**外部 Worktree 由原客户端管理。** 返修可以增删交付文件、提交或切换源分支，不用重新接入；Agent 按当前任务重新列清单，不自动带入无关文件。已有预览不会随源改动自动更新，先撤回再预览新版。插件不会拦截外部会话的工具、切换源分支或删除源目录；放弃只解除登记。外部任务需先预览再确认提交。

<details>
<summary>手动指定目标、基点和交付文件</summary>

共同分叉基点不一定等于任务实际开工点。接入前请核对目标、基点和清单；自动识别不适用时，可以显式指定：

```text
/worktree-preview-adopt {"source":"/path/to/external-worktree","target":"/path/to/project","base":"<完整基点提交 OID>","title":"提交标题","files":["src/example.ts"]}
```

源和目标必须是同一仓库的两个独立 checkout；`base` 必须是两边 `HEAD` 的唯一共同分叉基点（用 `git merge-base --all <目标 HEAD> <源 HEAD>` 核对）。文件用仓库相对路径，重命名列出新旧路径。从目标对话接入时，插件只在该对话提供验收操作，不把它当作源 Worktree 的返修对话。

</details>

## 斜杠命令

输入 `/worktree-preview-` 查找独立命令，或运行 `/worktree-preview help`。原来的 `/worktree-preview <操作>` 仍可用。

| 命令 | 用途 |
| --- | --- |
| `/worktree-preview-new` | 下一条任务消息发到新 Worktree |
| `/worktree-preview-status` | 查看任务状态、目标和交付清单 |
| `/worktree-preview-adopt` | 接入已有 Worktree；加 `1,3` 可缩小现有清单 |
| `/worktree-preview-resume` | 进入关联的 Worktree 对话 |
| `/worktree-preview-back` | 返回原对话 |
| `/worktree-preview-preview` | 发起预览 |
| `/worktree-preview-recover` | 继续已获确认的外部冲突处理 |
| `/worktree-preview-rollback` | 发起撤回 |
| `/worktree-preview-commit` | 发起提交已预览的改动 |
| `/worktree-preview-discard` | 发起放弃任务或解除外部登记 |
| `/worktree-preview-confirm <确认码>` | 仅用于文本确认（同一对话、单次有效、5 分钟过期） |
| `/worktree-preview-cancel` | 取消文本确认或下次新建 |
| `/worktree-preview-language [zh\|en]` | 查看或切换本扩展的显示语言 |

RPC 确认用的是 **Pi 原生 `select`**（支持的客户端可显示为 Ask），不依赖 T3 Code。取消或超时不执行。确认只显示摘要，完整文件清单用 `status` 查看。不支持 Ask 的客户端可用 `/worktree-preview-preview --text` 等命令索取确认码，再运行 `/worktree-preview-confirm <确认码>`。命令模式中，自建任务提交或放弃后会回到原对话。

**验证范围：** 已用真实 Pi fullscreen 和 RPC 跑通。已核对 T3 Code Nightly 的命令与 Ask 接口，尚未在 T3 Code 或 Paseo 界面做端到端验证。

<details>
<summary>RPC 客户端接入说明</summary>

用 `get_commands` 列出命令，通过 `prompt` 原样发送。收到 `extension_ui_request` 的 `select` 后，应显示提问并回传 `extension_ui_response`，不要等 `prompt` 回执才处理。`setStatus` 显示简短结果和下一步，`notify` 发送完整结果；以 `worktree-preview ok:` 或 `error:` 为准。

</details>

## 安全与限制

- **只交付验收清单。** 预览、撤回、提交和放弃都需用户确认。撤回或提交前会检查分支、索引和预览路径；保留无关的未暂存改动，发现影响验收的变化就停止。验收时不要让别的进程同时写项目目录。
- **中断不自动重试。** 写入前会保留恢复记录，默认在 `~/.pi/agent/worktree-preview/tasks.json`。状态不明时先备份项目目录和 Worktree，不要删记录或锁来强行继续。
- **清理不等于强删。** 安全检查不通过时保留 Worktree。强删会永久删除整个隔离目录，包括未交付文件，且需要另行确认。
- Worktree 隔离的是目录，不是安全沙箱；历史对话只读，检查的是当前项目目录，不是历史快照。支持 macOS/Linux（在 macOS 验证），不支持 `--no-session`、稀疏检出、子模块或嵌套仓库。暂不预览 `.gitignore` / `.gitattributes`；提交不运行 Git 钩子、不签名、不推送。

## 开发验证

```sh
npm ci
npm run check
npm test
# 使用真实 Pi、临时 Git 仓库和离线测试模型；fullscreen 测试另需 Python pyte
python3 test/pi-rpc-smoke.py
python3 test/pi-smoke.py
```

Git 合并与验收引擎移植自 [dsh-git-worktree](https://github.com/wloops/dsh-git-worktree)，采用 [MIT 许可](LICENSE)。
