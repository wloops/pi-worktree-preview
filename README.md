# pi-worktree-preview

[![npm 月下载量](https://img.shields.io/npm/dm/pi-worktree-preview?label=npm%20downloads)](https://www.npmjs.com/package/pi-worktree-preview)

用 Pi 在隔离的 Git Worktree 里并行开发。改完直接在原项目目录预览和测试：满意就提交，不满意就撤回。不用切分支，也不用手动暂存。

## 快速开始

需要 Pi 1.5.2 或兼容版本，以及已有初始提交的 Git 分支。请先配置 Pi 模型和 Git 提交身份。

```sh
pi install npm:pi-worktree-preview
cd /path/to/your/repo
pi
```

Pi 默认使用 fullscreen。在支持鼠标的终端里，直接运行 `pi` 就能点击 Worktree 按钮。如果你把 Pi 设置成了 regular，可用 `/worktree-preview` 打开菜单并用键盘操作；想用鼠标时，再用 `pi --tui-mode fullscreen` 启动。

也可从 [GitHub](https://github.com/wloops/pi-worktree-preview/releases) 安装：`pi install git:github.com/wloops/pi-worktree-preview@v0.1.5`。切换安装来源前，先用 `pi list` 找到旧入口，再用 `pi remove <旧入口>` 移除，避免重复加载。

1. **新建 Worktree**：勾选编辑器上方的复选框，再发送任务。可以先在原对话讨论；新会话自动带上当前分支的聊天上下文，但目录仍从发送时的 `HEAD` 创建，不复制未提交的文件（聊天里已经出现的内容仍会带上）。这条消息只发到新会话。
2. **待验收**：Agent 用任务对话的语言拟定提交标题，必要时补充正文，并标记要交付的文件，不改项目目录。清单里有无关文件，可在 **⋯ 更多 → 调整交付清单** 移除。提交前可滚动查看标题、正文和文件清单。
3. **预览改动**：把改动写入原项目目录，不暂存、不提交。可直接在原目录测试，或点 **打开项目目录检查**。
4. **撤回预览** 或 **确认提交**：撤回恢复预览前的状态；提交只带本次任务改动，可选择清理或保留 Worktree。

## 其他常用操作

| 想做什么 | 怎么做 |
| --- | --- |
| 并行开发或恢复任务 | 每个原对话可开一个任务；同一项目一次只能有一份预览。运行 `pi -r`，按 `Tab` 切到 **All**，在 **Threaded** 视图下可从原对话下面直接恢复新建且目录仍在的 Worktree。也可恢复原对话后点 **进入 / 恢复 Worktree**（旧任务也适用）；已清理的任务从 **任务历史** 打开。 |
| 继续修改 | 在 Worktree 里直接说要改什么。若已预览，确认 **撤回预览，继续返修** 后，Agent 接着处理，不用重发。 |
| 解决预览冲突 | 如果冲突来自项目目录的新提交，可点 **让 Agent 解决冲突**，解决后重新标记待验收，再预览。未提交改动留在原目录，需自行处理。 |
| 直接提交或放弃 | 待验收时可从 **⋯ 更多** 跳过预览直接提交。**放弃任务** 只在对应 Worktree 的菜单里；若已预览，先撤回。 |
| 续接已结束的对话 | 提交后可留在原任务对话，也可从 **任务历史** 打开。提问不新建；明确要求修改时，Agent 才从项目目录最新 `HEAD` 开新 Worktree，不带旧目录的未提交文件。 |

## 不用 TUI：命令和外部 Worktree

输入 `/worktree-preview-` 查找独立命令，也可发送 `/worktree-preview help` 查看列表：

| 命令 | 用途 |
| --- | --- |
| `/worktree-preview-new` | 下一条任务消息发到新 Worktree |
| `/worktree-preview-status` | 查看任务状态 |
| `/worktree-preview-resume` | 进入关联的 Worktree 对话 |
| `/worktree-preview-back` | 返回原对话 |
| `/worktree-preview-preview` | 发起预览 |
| `/worktree-preview-rollback` | 发起撤回 |
| `/worktree-preview-commit` | 发起提交已预览的改动 |
| `/worktree-preview-discard` | 发起放弃任务或解除外部登记 |
| `/worktree-preview-confirm <确认码>` | 仅用于文本确认（同一对话、单次有效、5 分钟过期） |
| `/worktree-preview-cancel` | 取消文本确认或下次新建 |

RPC 客户端默认用原生 Ask 让你核对再确认，取消或超时不会执行。不支持弹出提问的客户端可用 `/worktree-preview-preview --text` 等命令索取确认码。原来的 `/worktree-preview <操作>` 仍可用。命令模式从插件新建的 Worktree 提交或放弃后返回原对话。

### 接入 T3 Code 等客户端已有的 Worktree

1. 在**外部 Worktree 的 Pi 对话**里运行 `/worktree-preview-adopt`，无需参数。插件从 Git 识别主 checkout 和唯一共同分叉基点，登记当前相对起点的改动；不改源目录或目标目录的文件。
2. 运行 `/worktree-preview-preview` 或点击「预览改动」。Ask 只显示目标、起点和文件数；想看完整清单可先运行 `/worktree-preview-status`。**确认后**才写入目标目录，不暂存、不提交。

默认纳入所有检测到的改动（包括未跟踪且未忽略的文件）。如果只交付一部分，预览前用「更多 → 调整交付清单」，或发送 `/worktree-preview-adopt 1,3` 只保留当前清单中对应的编号。

共同分叉基点不一定等于任务实际开工点。如果无法自动识别、要指定另一个目标或要自定义提交标题，可在源或目标的 Pi 对话里用 JSON 显式接入并确认：

```text
/worktree-preview-adopt {"source":"/path/to/external-worktree","target":"/path/to/project","base":"<完整起点提交 OID>","title":"提交标题","files":["src/example.ts"]}
```

确认后只登记，不写入 checkout。两个目录须是同一 Git 仓库下的独立 checkout；`base` 必须等于两个 `HEAD` 的唯一共同分叉基点（用 `git merge-base --all <目标 HEAD> <源 HEAD>` 核对）。`files` 只填写本任务的确切仓库相对路径，重命名须列出新旧路径。然后仍可预览、撤回或提交；放弃只解除登记，已预览时须先撤回。外部 Worktree **不支持跳过预览或自动返修**，插件不切换或删除源目录；需要更新清单时，先撤回（如有）并解除登记，再接入。

RPC 客户端用 `get_commands` 列出命令、通过 `prompt` 原样发送。收到 `extension_ui_request` 的 `select` 后应先显示提问并回传 `extension_ui_response`，无需等待 `prompt` 回执。简短结果和下一步通过 `setStatus` 显示，完整结果通过 `notify` 发送；以 `worktree-preview ok:` 或 `error:` 为准。已验证真实 Pi RPC；T3 Code Nightly 的适配支持已核对，尚未在 T3 Code / Paseo 界面完成端到端操作。

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
