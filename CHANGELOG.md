# Changelog

## [0.1.0]

- 初版：在 Pi fullscreen 中用鼠标新建、恢复和管理隔离 Worktree。不同 Local 会话可以并行开发，同一 Local checkout 一次只预览一个任务。
- 可将待验收改动写入原 checkout，不暂存、不提交；可撤回预览，或只提交任务改动。写入前保存恢复记录，状态不明时停止自动操作。
- 支持在原 Worktree 返修、解决与 Local 已提交版本的冲突，以及从已结束的对话续接新任务。交付后默认安全清理，也可保留 Worktree。
