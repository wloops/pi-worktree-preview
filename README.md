# pi-worktree-preview

[![npm 月下载量](https://img.shields.io/npm/dm/pi-worktree-preview?label=npm%20downloads)](https://www.npmjs.com/package/pi-worktree-preview)

用 Pi 在隔离的 Git Worktree 里并行开发。改完直接在原项目目录预览和测试：满意就提交，不满意就撤回。不用切分支，也不用手动暂存。

## 快速开始

需要 Pi 1.5.2 或兼容版本、支持鼠标的终端，以及已有初始提交的 Git 分支。请先配置 Pi 模型和 Git 提交身份。

```sh
pi install npm:pi-worktree-preview
cd /path/to/your/repo
pi --tui-mode fullscreen
```

也可从 [GitHub](https://github.com/wloops/pi-worktree-preview/releases) 安装：`pi install git:github.com/wloops/pi-worktree-preview@v0.1.3`。切换安装来源前，先用 `pi list` 找到旧入口，再用 `pi remove <旧入口>` 移除，避免重复加载。

1. **新建 Worktree**：勾选编辑器上方的复选框，发送任务。发送时才创建目录，消息只发到新会话。
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

## 安全与限制

- **只交付验收清单。** 预览、撤回、提交和放弃都需点击确认。撤回或提交前会检查分支、索引和预览路径；保留无关的未暂存改动，发现影响验收的变化就停止。验收时不要让别的进程同时写项目目录。
- **中断不自动重试。** 写入前会保留恢复记录，默认在 `~/.pi/agent/worktree-preview/tasks.json`。状态不明时先备份项目目录和 Worktree，不要删记录或锁来强行继续。
- **清理不等于强删。** 安全检查不通过时保留 Worktree。强删会永久删除整个隔离目录，包括未交付文件，且需要另行确认。
- Worktree 隔离的是目录，不是安全沙箱；历史对话只读，检查的是当前项目目录，不是历史快照。支持 macOS/Linux（在 macOS 验证），不支持 `--no-session`、稀疏检出、子模块或嵌套仓库。暂不预览 `.gitignore` / `.gitattributes`；提交不运行 Git 钩子、不签名、不推送。

## 开发验证

```sh
npm ci
npm run check
npm test
# 需要 pi 和 Python pyte；使用临时 Git 仓库与离线测试模型
python3 test/pi-smoke.py
```

Git 合并与验收引擎移植自 [dsh-git-worktree](https://github.com/wloops/dsh-git-worktree)，采用 [MIT 许可](LICENSE)。
