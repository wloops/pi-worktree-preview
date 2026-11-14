import type { MessageCatalog, Translator } from './core.ts'

export const hostMessages = {
  "gitExitedWithCode": {
    "zh": "git 命令退出码为 {p0}",
    "en": "git exited with code {p0}"
  },
  "theLocalBranchHasChangedPreviewCannotBeRolled": {
    "zh": "Local branch 已变化，不能自动撤回 Preview",
    "en": "The Local branch has changed. Preview cannot be rolled back automatically."
  },
  "localHEADIsNotASafeFastForwardFrom": {
    "zh": "Local HEAD 不是 Preview 基线的安全快进，不能自动撤回",
    "en": "Local HEAD is not a safe fast-forward from the Preview base. Automatic rollback is not allowed."
  },
  "newLocalCommitsConflictWithPrePreviewLocalChanges": {
    "zh": "Local 新提交与 Preview 前的本地修改冲突，无法安全撤回：{p0}",
    "en": "New Local commits conflict with pre-Preview local changes. Safe rollback is not possible: {p0}"
  },
  "newLocalCommitsConflictWithThePreviewTaskChanges": {
    "zh": "Local 新提交与 Preview 任务增量冲突，无法安全撤回：{p0}",
    "en": "New Local commits conflict with the Preview task changes. Safe rollback is not possible: {p0}"
  },
  "newLocalCommitsAlreadyContainSomeOrAllPreview": {
    "zh": "Local 新提交已经包含部分或全部 Preview 增量，不能通过撤回工作区改动来改写已提交历史",
    "en": "New Local commits already contain some or all Preview changes. Rolling back workspace changes cannot rewrite committed history."
  },
  "localHasAdditionalChangesInThePreviewAreaSafe": {
    "zh": "Local 在 Preview 区域出现额外修改，无法安全撤回：{p0}",
    "en": "Local has additional changes in the Preview area. Safe rollback is not possible: {p0}"
  },
  "localIsNotOnANormalBranchATask": {
    "zh": "Local 当前不是普通分支，不能自动创建任务提交",
    "en": "Local is not on a normal branch. A task commit cannot be created automatically."
  },
  "theLocalBranchHasChangedThePreviewCommitCannot": {
    "zh": "Local branch 已变化，不能完成 Preview 提交",
    "en": "The Local branch has changed. The Preview commit cannot be finalized."
  },
  "localHEADIsNotASafeFastForwardFrom281": {
    "zh": "Local HEAD 不是 Preview 基线的安全快进，不能完成 Preview 提交",
    "en": "Local HEAD is not a safe fast-forward from the Preview base. The Preview commit cannot be finalized."
  },
  "localHasAdditionalChangesInThePreviewAreaA": {
    "zh": "Local 在 Preview 区域出现额外修改，无法可靠提交：{p0}",
    "en": "Local has additional changes in the Preview area. A reliable commit is not possible: {p0}"
  },
  "previewTaskChangesCannotBeReliablySeparatedFromThe": {
    "zh": "Preview 任务增量无法与最新 Local HEAD 可靠拆分：{p0}",
    "en": "Preview task changes cannot be reliably separated from the latest Local HEAD: {p0}"
  },
  "previewTaskChangesAreAlreadyInLocalHEADNo": {
    "zh": "Preview 任务增量已经进入 Local HEAD；不会创建重复或空提交",
    "en": "Preview task changes are already in Local HEAD. No duplicate or empty commit will be created."
  },
  "thePreviewCommitCannotBeReliablySeparatedFromLocal": {
    "zh": "Preview 提交与 Local staged 修改无法可靠分离：{p0}",
    "en": "The Preview commit cannot be reliably separated from Local staged changes: {p0}"
  },
  "invalidSessionBaseOIDFormat": {
    "zh": "Session Base OID 格式无效",
    "en": "Invalid Session Base OID format."
  },
  "localAndIsolatedDoNotBelongToTheSame": {
    "zh": "Local 与 Isolated 不属于同一 Git 仓库",
    "en": "Local and Isolated do not belong to the same Git repository."
  },
  "theLocalAndIsolatedProjectSubdirectoriesDoNotMatch": {
    "zh": "Local 与 Isolated 的项目子目录不一致",
    "en": "The Local and Isolated project subdirectories do not match."
  },
  "isolatedContainsChangesOutsideTheProjectRootAReview": {
    "zh": "Isolated 包含项目根目录外的变更，不能准备验收",
    "en": "Isolated contains changes outside the project root. A review cannot be prepared."
  },
  "isolatedContainsChangesOutsideTheProjectRootApplyWas": {
    "zh": "Isolated 包含项目根目录外的变更，已拒绝 Apply",
    "en": "Isolated contains changes outside the project root. Apply was rejected."
  },
  "localChangedAfterPlanningRecalculateThePlan": {
    "zh": "Local 在 plan 后发生变化，请重新计算",
    "en": "Local changed after planning. Recalculate the plan."
  },
  "isolatedChangedAfterPlanningRecalculateThePlan": {
    "zh": "Isolated 在 plan 后发生变化，请重新计算",
    "en": "Isolated changed after planning. Recalculate the plan."
  },
  "thePreviewPlanIsMissingAlreadyUsedOrModified": {
    "zh": "Preview plan 不存在、已使用或已被修改",
    "en": "The Preview plan is missing, already used, or modified."
  },
  "invalidPreviewIdentity": {
    "zh": "Preview identity 无效",
    "en": "Invalid Preview identity."
  },
  "thePreviewPlanSGitRepositoryIdentityHasChanged": {
    "zh": "Preview plan 的 Git 仓库身份已变化",
    "en": "The Preview plan's Git repository identity has changed."
  },
  "thePersistentPreviewSnapshotDoesNotMatchTheReviewed": {
    "zh": "Preview 持久快照与审核 plan 不一致",
    "en": "The persistent Preview snapshot does not match the reviewed plan."
  },
  "localChangedBeforePreviewWroteItsChangesRecalculateThe": {
    "zh": "Local 在 Preview 写入前发生变化，请重新计算",
    "en": "Local changed before Preview wrote its changes. Recalculate the plan."
  },
  "theLocalSnapshotAfterPreviewDoesNotMatchThe": {
    "zh": "Preview 写入后的 Local snapshot 与准备结果不一致，需要恢复确认",
    "en": "The Local snapshot after Preview does not match the prepared result. Recovery confirmation is required."
  },
  "localChangedBeforePreviewRollbackRetry": {
    "zh": "Local 在撤回 Preview 前发生变化，请重试",
    "en": "Local changed before Preview rollback. Retry."
  },
  "cannotVerifyAfterWritingPreviewRollbackTheEnvironmentMust": {
    "zh": "Preview 撤回写后无法完成验证，需要保留现场确认：{p0}",
    "en": "Cannot verify after writing Preview rollback. The environment must be preserved for inspection: {p0}"
  },
  "theLocalSnapshotAfterPreviewRollbackDoesNotMatch": {
    "zh": "Preview 撤回后的 Local snapshot 与安全恢复结果不一致，需要保留现场确认",
    "en": "The Local snapshot after Preview rollback does not match the safe recovery result. The environment must be preserved for inspection."
  },
  "localChangedBeforeFinalizingPreviewRetry": {
    "zh": "Local 在完成 Preview 前发生变化，请重试",
    "en": "Local changed before finalizing Preview. Retry."
  },
  "thePreviewTaskCommitTreeDoesNotMatchThe": {
    "zh": "Preview 任务提交 tree 与恢复评估不一致",
    "en": "The Preview task commit tree does not match the recovery assessment."
  },
  "thePreviewFinalIndexTreeDoesNotMatchThe": {
    "zh": "Preview 最终 index tree 与恢复评估不一致",
    "en": "The Preview final index tree does not match the recovery assessment."
  },
  "anotherGitOperationIsUpdatingTheLocalIndexRetry": {
    "zh": "Local index 正在被其他 Git 操作更新，请重试",
    "en": "Another Git operation is updating the Local index. Retry later."
  },
  "localChangedBeforeThePreviewCommitWasWrittenRetry": {
    "zh": "Local 在 Preview 提交写入前发生变化，请重试",
    "en": "Local changed before the Preview commit was written. Retry."
  },
  "previewCommitVerificationFailedAfterWriting": {
    "zh": "Preview 提交写后验证失败",
    "en": "Preview commit verification failed after writing."
  },
  "indexLocalIndexChangedAfterPreviewWroteItsChanges": {
    "zh": "index: Local index 在 Preview 写入后发生变化，拒绝覆盖并发 staged 状态",
    "en": "index: Local index changed after Preview wrote its changes. Concurrent staged state will not be overwritten."
  },
  "refVerifiableIndexCompensationEvidenceIsMissingPartialRollback": {
    "zh": "ref: 缺少可验证的 index 补偿证据，拒绝部分回滚",
    "en": "ref: Verifiable index compensation evidence is missing. Partial rollback was rejected."
  },
  "thePreviewCommitWriteCouldNotBeVerifiedAnd": {
    "zh": "Preview 提交写入未能验证，已完整回滚：{p0}",
    "en": "The Preview commit write could not be verified and was fully rolled back: {p0}"
  },
  "cannotProveSuccessOrCompleteRollbackAfterWritingThe": {
    "zh": "Preview 提交写入后无法证明成功或完整回滚，需要保留现场确认：{p0}{p1}",
    "en": "Cannot prove success or complete rollback after writing the Preview commit. The environment must be preserved for inspection: {p0}{p1}"
  },
  "gitOperationFailed": {
    "zh": "Git 操作失败（{p0}）：{p1}",
    "en": "Git operation failed ({p0}): {p1}"
  },
  "unknownGitError": {
    "zh": "未知 Git 错误",
    "en": "Unknown Git error"
  },
  "theCommitMessageMustBeNonemptyAndContainNoNul": {
    "zh": "Commit Message 不能为空或包含 NUL 字符",
    "en": "The commit message must not be empty or contain NUL characters."
  },
  "tempDirectoryCleanupFailed": {
    "zh": "[session-checkout-apply] 临时目录清理失败：",
    "en": "[session-checkout-apply] Failed to clean up the temporary directory:"
  }
} as const satisfies MessageCatalog

export type HostTranslator = Translator<typeof hostMessages>
