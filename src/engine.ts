import { isValidCommitMessage } from './commit-message.ts'
import { createTranslator } from './i18n/core.ts'
import { hostMessages } from './i18n/host-messages.ts'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
const hostMessage = createTranslator(hostMessages, 'zh')
type ApplyBaseStrategy = 'recorded_base' | 'isolated_contains_local_head' | 'local_contains_isolated_head'

export interface ApplyPlanInput {
  baseOid: string
  isolatedPath: string
  localPath: string
}

export interface ApplyPlan {
  revision: string
  localFingerprint: string
  isolatedFingerprint: string
  effectiveBaseOid: string
  baseStrategy: ApplyBaseStrategy
  localHeadOid: string
  /** null 表示 Local 当前为 detached HEAD；Apply 允许，Finish 会拒绝自动提交。 */
  localHeadRef: string | null
  isolatedHeadOid: string
  changedFiles: string[]
}

export interface ReviewSnapshotResult {
  status: 'ready'
  isolatedFingerprint: string
  isolatedHeadOid: string
  changedFiles: string[]
}

export type InspectReviewResult = ReviewSnapshotResult | ApplyPlanErrorResult

export interface ApplyReadyPlanResult {
  status: 'ready'
  plan: ApplyPlan
}

export interface ApplyConflictPlanResult {
  status: 'conflict'
  revision: string
  localFingerprint: string
  isolatedFingerprint: string
  effectiveBaseOid: string
  baseStrategy: ApplyBaseStrategy
  /** 冲突计算时的真实 Local HEAD，供 Isolated Agent 在当前 Worktree 内同步并解决冲突。 */
  localHeadOid: string
  isolatedHeadOid: string
  conflictingFiles: string[]
}

export interface ApplyPlanErrorResult {
  status: 'error'
  error: ApplyError
}

export type ApplyPlanResult = ApplyReadyPlanResult | ApplyConflictPlanResult | ApplyPlanErrorResult

export interface ApplyErrorResult {
  status: 'error'
  error: ApplyError
}

export interface FinishSuccessResult {
  status: 'finished'
  changedFiles: string[]
  /** null 表示 Worktree 与 Local 已一致，没有创建空提交。 */
  commitOid: string | null
  /** 本次已整合的 Isolated 快照，供清理未完成时后续 Apply 去重。 */
  nextBaseOid: string
}

export type FinishResult = FinishSuccessResult | ApplyErrorResult

export interface PreviewReceipt {
  previewId: string
  reviewId: string
  iteration: number
  previewedAt: number
  configuredBaseOid: string
  effectiveBaseOid: string
  baseStrategy: ApplyBaseStrategy
  localHeadOid: string
  localHeadRef: string | null
  localFingerprintBefore: string
  localFingerprintPreview: string
  localWorkingTreeOid: string
  localIndexTreeOid: string
  previewWorkingTreeOid: string
  isolatedHeadOid: string
  isolatedFingerprint: string
  isolatedSnapshotOid: string
  changedFiles: string[]
}

export interface PreviewSuccessResult {
  status: 'previewed'
  receipt: PreviewReceipt
  changedFiles: string[]
}

export type PreviewResult = PreviewSuccessResult | ApplyErrorResult

export interface RollbackSuccessResult {
  status: 'preview_rolled_back'
  changedFiles: string[]
}

export type RollbackResult = RollbackSuccessResult | ApplyErrorResult

export type PreviewRecoveryActionBlockCode =
  | 'stale_local'
  | 'preview_modified'
  | 'commit_isolation_conflict'
  | 'operation_not_allowed'

export interface PreviewRecoveryBlockedAction {
  status: 'blocked'
  code: PreviewRecoveryActionBlockCode
  message: string
  conflictingFiles?: string[]
}

export interface PreviewRecoverySafeRollback {
  status: 'safe'
  targetTreeOid: string
}

export interface PreviewRecoverySafeFinalize {
  status: 'safe'
  taskTreeOid: string
  finalIndexTreeOid: string
  expectedWorkingTreeOid: string
  commitRequired: boolean
}

export interface InvalidInputApplyError {
  code: 'invalid_input'
  message: string
}

export interface InvalidPlanApplyError {
  code: 'invalid_plan'
  message: string
}

export interface StaleLocalApplyError {
  code: 'stale_local'
  message: string
}

export interface StaleIsolatedApplyError {
  code: 'stale_isolated'
  message: string
}

export interface GitApplyError {
  code: 'git_error'
  message: string
  /** Host may clear only a planning journal when the engine proved Local was restored exactly. */
  recoveryState?: 'unchanged' | 'uncertain'
}

export interface CommitIsolationApplyError {
  code: 'commit_isolation_conflict'
  message: string
}

export interface OperationNotAllowedApplyError {
  code: 'operation_not_allowed'
  message: string
}

export interface PreviewModifiedApplyError {
  code: 'preview_modified'
  message: string
}

export type ApplyError =
  | InvalidInputApplyError
  | InvalidPlanApplyError
  | StaleLocalApplyError
  | StaleIsolatedApplyError
  | GitApplyError
  | CommitIsolationApplyError
  | OperationNotAllowedApplyError
  | PreviewModifiedApplyError

export interface SessionCheckoutApplyEngine {
  inspectReview(input: ApplyPlanInput): Promise<InspectReviewResult>
  /** 复用真实 Apply merge 计算，但不持久化可执行 plan，也不修改任一 checkout。 */
  plan(input: ApplyPlanInput): Promise<ApplyPlanResult>
  preview(plan: ApplyPlan, options: {
    previewId: string
    reviewId: string
    iteration: number
    /** Local 写入前持久化 receipt artifacts/journal；失败时不得触碰 Local。 */
    beforeWrite?(receipt: PreviewReceipt): Promise<void>
  }): Promise<PreviewResult>
  /** Strictly read-only detached Preview recovery assessment; it persists no executable plan. */
  rollback(input: {
    localPath: string
    receipt: PreviewReceipt
    /** Persists the mutation journal before the final Local CAS; no Local write may happen before it resolves. */
    beforeWrite?(): Promise<void>
  }): Promise<RollbackResult>
  finalize(input: {
    localPath: string
    receipt: PreviewReceipt
    commitMessage: string
    /** Commit object 已创建但 branch ref 尚未更新时持久化恢复信息。 */
    beforeCommit?(commitOid: string, indexBefore: Buffer, indexAfter: Buffer): Promise<void>
  }): Promise<FinishResult>
}

export interface SessionCheckoutApplyEngineOptions {
  /** 测试/宿主 seam：在最后一次 Local fingerprint 校验前执行。 */
  beforeFinalLocalValidation?(): Promise<void> | void
  /** 测试/宿主 seam：在 Local 写入完成、独立写后验证开始前执行。 */
  afterLocalWriteBeforeVerification?(): Promise<void> | void
}

interface GitResult {
  exitCode: number
  stdout: Buffer
  stderr: string
}

interface CheckoutSnapshot {
  fingerprint: string
  headOid: string
  headRef: string | null
  headTreeOid: string
  indexTreeOid: string
  treeOid: string
  indexEntries: Buffer
}

interface ApplyScope {
  isolatedGitRoot: string
  localGitRoot: string
  projectPrefix: string
  sourceObjects: string
}

interface StoredPlan {
  input: ApplyPlanInput
  patch: Buffer
  plan: ApplyPlan
  scope: ApplyScope
}

interface MergeReadyResult {
  status: 'ready'
  changedFiles: string[]
  patch: Buffer
  mergedTreeOid: string
}

interface MergeConflictResult {
  status: 'conflict'
  conflictingFiles: string[]
}

type MergeResult = MergeReadyResult | MergeConflictResult

interface TreeMergeReadyResult {
  status: 'ready'
  treeOid: string
}

type TreeMergeResult = TreeMergeReadyResult | MergeConflictResult

class GitCommandFailure extends Error {
  constructor(
    readonly args: string[],
    readonly result: GitResult,
  ) {
    super(result.stderr || hostMessage('gitExitedWithCode', { p0: result.exitCode }))
  }
}

const GIT_TIMEOUT_MS = 30_000
const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
const PLAIN_ATTRIBUTES = '* !merge !filter !text !eol !ident !working-tree-encoding\n'

export async function runGit(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: Buffer | string; allowedExitCodes?: number[] } = {},
): Promise<GitResult> {
  return await new Promise<GitResult>((resolveResult, reject) => {
    // Review/delivery must support the same Windows paths as initial creation.
    const child = spawn('git', [
      ...(process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : []),
      '-c', 'core.quotePath=false', '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
      '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', '-c', 'core.fsync=all',
      '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'diff.srcPrefix=a/', '-c', 'diff.dstPrefix=b/',
      '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args,
    ], {
      cwd,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
        GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1',
        ...options.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let settled = false

    const finish = (error: Error | null, result?: GitResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else if (result) resolveResult(result)
    }

    child.stdin.on('error', () => { /* Report Git's exit status instead of EPIPE. */ })
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
    child.on('error', (error) => finish(error))
    child.on('close', (exitCode) => {
      const result: GitResult = {
        exitCode: exitCode ?? -1,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks).toString('utf8').trim(),
      }
      const allowed = options.allowedExitCodes ?? [0]
      finish(allowed.includes(result.exitCode) ? null : new GitCommandFailure(args, result), result)
    })

    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
    }, GIT_TIMEOUT_MS)

    if (options.input !== undefined) child.stdin.end(options.input)
    else child.stdin.end()
  })
}

function stdoutText(result: GitResult): string {
  return result.stdout.toString('utf8').trim()
}

function parseNullSeparated(output: Buffer): string[] {
  return output
    .toString('utf8')
    .split('\0')
    .filter((value) => value.length > 0)
}

function gitAlternate(path: string) {
  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`
}

function gitObjectEnvironment(objectDirectory: string, sourceObjectDirectory: string): NodeJS.ProcessEnv {
  return {
    GIT_OBJECT_DIRECTORY: objectDirectory,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: gitAlternate(sourceObjectDirectory),
  }
}

async function sourceObjectDirectory(checkoutPath: string): Promise<string> {
  const output = stdoutText(await runGit(checkoutPath, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']))
  return resolve(checkoutPath, output)
}

async function resolveGitRoot(checkoutPath: string): Promise<string> {
  const output = stdoutText(await runGit(checkoutPath, ['rev-parse', '--show-toplevel']))
  return resolve(checkoutPath, output)
}

function canonicalExistingPath(path: string): string {
  try {
    return realpathSync.native(resolve(path))
  } catch {
    return resolve(path)
  }
}

function projectPrefix(gitRoot: string, projectRoot: string): string | null {
  const prefix = relative(canonicalExistingPath(gitRoot), canonicalExistingPath(projectRoot))
    .replace(/\\/g, '/')
    .replace(/\/$/, '')
  if (prefix === '..' || prefix.startsWith('../') || isAbsolute(prefix)) return null
  return prefix
}

function isProjectPath(repoPath: string, prefix: string): boolean {
  return !prefix || repoPath.startsWith(`${prefix}/`)
}

function toProjectPath(repoPath: string, prefix: string): string {
  return prefix ? repoPath.slice(prefix.length + 1) : repoPath
}

interface EffectiveApplyBase {
  oid: string
  strategy: ApplyBaseStrategy
}

async function isAncestor(checkoutPath: string, olderOid: string, newerOid: string): Promise<boolean> {
  const result = await runGit(
    checkoutPath,
    ['merge-base', '--is-ancestor', olderOid, newerOid],
    { allowedExitCodes: [0, 1] },
  )
  return result.exitCode === 0
}

async function selectEffectiveApplyBase(
  checkoutPath: string,
  recordedBaseOid: string,
  localHeadOid: string,
  isolatedHeadOid: string,
): Promise<EffectiveApplyBase> {
  // recorded base 必须能证明位于两侧真实提交历史中，才允许利用 ancestry 前移。
  // 上次 Apply 的内部 snapshot 通常不在任一分支历史中，因此第二次 Apply 会保守使用 recorded base。
  const recordedInLocal = await isAncestor(checkoutPath, recordedBaseOid, localHeadOid)
  const recordedInIsolated = await isAncestor(checkoutPath, recordedBaseOid, isolatedHeadOid)
  if (!recordedInLocal || !recordedInIsolated) {
    return { oid: recordedBaseOid, strategy: 'recorded_base' }
  }

  if (await isAncestor(checkoutPath, localHeadOid, isolatedHeadOid)) {
    return { oid: localHeadOid, strategy: 'isolated_contains_local_head' }
  }
  if (await isAncestor(checkoutPath, isolatedHeadOid, localHeadOid)) {
    return { oid: isolatedHeadOid, strategy: 'local_contains_isolated_head' }
  }
  return { oid: recordedBaseOid, strategy: 'recorded_base' }
}

async function changedTreePaths(
  checkoutPath: string,
  baseOid: string,
  treeOid: string,
  objectDirectory: string | null,
  sourceObjects: string | null,
): Promise<string[]> {
  const result = await runGit(
    checkoutPath,
    ['diff', '--name-only', '-z', '--no-ext-diff', '--no-renames', baseOid, treeOid, '--'],
    { env: objectDirectory && sourceObjects ? gitObjectEnvironment(objectDirectory, sourceObjects) : undefined },
  )
  return parseNullSeparated(result.stdout)
}

function snapshotFingerprint(
  headOid: string,
  headRef: string | null,
  indexEntries: Buffer,
  treeOid: string,
): string {
  return createHash('sha256')
    .update(headOid)
    .update('\0')
    .update(headRef ?? 'DETACHED')
    .update('\0')
    .update(indexEntries)
    .update('\0')
    .update(treeOid)
    .digest('hex')
}

async function assertSupportedCheckout(cwd: string) {
  const sparse = await runGit(cwd, ['config', '--bool', '--get', 'core.sparseCheckout'], { allowedExitCodes: [0, 1] })
  if (stdoutText(sparse) === 'true') throw new Error('不支持 sparse checkout。')
  const attrsConfig = await runGit(cwd, ['config', '--get-regexp', '^(core\\.(symlinks|filemode)|filter\\.)'], { allowedExitCodes: [0, 1] })
  if (stdoutText(attrsConfig).split('\n').some(entry => /^filter\.|^core\.(symlinks|filemode) (false|no|off|0)$/i.test(entry))) {
    throw new Error('不支持启用了内容转换或禁用文件模式/符号链接的 Git checkout。')
  }
  const index = (await runGit(cwd, ['ls-files', '--debug', '-z'])).stdout.toString('utf8')
  // Each debug record is NUL-delimited path + five stat lines. Parse exact boundaries so
  // paths containing newlines cannot be mistaken for flags. Ignore ordinary stat data.
  let next = 0
  while (next < index.length) {
    const nul = index.indexOf('\0', next)
    const end = index.indexOf('\n', index.indexOf('\tflags: ', nul + 1))
    if (nul < 0 || end < 0) throw new Error('无法核验 Git 索引标志。')
    const flags = /\tflags: ([\da-f]+)\n$/i.exec(index.slice(nul + 1, end + 1))
    if (!flags || (Number.parseInt(flags[1], 16) & 0x6000b000) !== 0) {
      throw new Error('不支持冲突、intent-to-add、assume-unchanged 或 skip-worktree 的索引。')
    }
    next = end + 1
  }
  const paths = (await runGit(cwd, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).stdout
  if (!paths.length) return
  if (!Buffer.from(paths.toString('utf8')).equals(paths)) throw new Error('不支持非 UTF-8 的 Git 文件名。')
  const attributes = (await runGit(cwd, ['check-attr', '-z', '--stdin', 'filter', 'text', 'eol', 'ident', 'working-tree-encoding', 'merge'], { input: paths })).stdout.toString('utf8').split('\0')
  for (let i = 0; i + 2 < attributes.length; i += 3) {
    const value = attributes[i + 2]
    if (value !== 'unspecified' && (value !== 'unset' || attributes[i + 1] === 'merge')) {
      throw new Error(`不支持影响文件内容或合并语义的 Git 属性：${attributes[i + 1]}。`)
    }
  }
}

async function captureSnapshot(
  checkoutPath: string,
  indexPath: string,
  objectDirectory: string | null,
  sourceObjects: string | null,
): Promise<CheckoutSnapshot> {
  const headOid = stdoutText(await runGit(checkoutPath, ['rev-parse', 'HEAD']))
  const headTreeOid = stdoutText(await runGit(checkoutPath, ['rev-parse', `${headOid}^{tree}`]))
  const symbolic = await runGit(checkoutPath, ['symbolic-ref', '--quiet', 'HEAD'], { allowedExitCodes: [0, 1] })
  const headRef = symbolic.exitCode === 0 ? stdoutText(symbolic) : null
  await assertSupportedCheckout(checkoutPath)
  const indexEntries = (await runGit(checkoutPath, ['ls-files', '--stage', '-z'])).stdout
  const stagedPatch = (
    await runGit(checkoutPath, [
      'diff',
      '--cached',
      '--binary',
      '--full-index',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames', '--src-prefix=a/', '--dst-prefix=b/',
      headOid,
      '--',
    ])
  ).stdout
  const env: NodeJS.ProcessEnv = {
    ...(objectDirectory && sourceObjects ? gitObjectEnvironment(objectDirectory, sourceObjects) : {}),
    GIT_INDEX_FILE: indexPath,
  }

  await runGit(checkoutPath, ['read-tree', headOid], { env })
  if (stagedPatch.length > 0) {
    await runGit(checkoutPath, ['apply', '-p1', '--cached', '--binary', '--whitespace=nowarn'], {
      env,
      input: stagedPatch,
    })
  }
  const indexTreeOid = stdoutText(await runGit(checkoutPath, ['write-tree'], { env }))
  // 先还原真实 index 的 staged 语义，再叠加 working tree，得到完整最终状态。
  await runGit(checkoutPath, ['add', '-A', '--', '.'], { env })
  const treeOid = stdoutText(await runGit(checkoutPath, ['write-tree'], { env }))
  const paths = (await runGit(checkoutPath, ['ls-files', '--stage', '-z'], { env })).stdout
  if (paths.toString('utf8').split('\0').some(record => record.startsWith('160000 '))) {
    throw new Error('不支持 Submodule 或嵌套的 Git 仓库。')
  }
  const fingerprint = snapshotFingerprint(headOid, headRef, indexEntries, treeOid)

  return { fingerprint, headOid, headRef, headTreeOid, indexTreeOid, treeOid, indexEntries }
}

async function createSnapshotCommit(
  checkoutPath: string,
  treeOid: string,
  parentOid: string | null,
  objectDirectory: string | null,
  sourceObjects: string | null,
  label: string,
): Promise<string> {
  const args = ['commit-tree', treeOid, ...(parentOid ? ['-p', parentOid] : [])]
  const result = await runGit(checkoutPath, args, {
    env: {
      ...(objectDirectory && sourceObjects ? gitObjectEnvironment(objectDirectory, sourceObjects) : {}),
      GIT_AUTHOR_NAME: 'Pi Worktree Preview',
      GIT_AUTHOR_EMAIL: 'pi-wtp-apply@localhost',
      GIT_COMMITTER_NAME: 'Pi Worktree Preview',
      GIT_COMMITTER_EMAIL: 'pi-wtp-apply@localhost',
    },
    input: `${label}\n`,
  })
  return stdoutText(result)
}

async function initMergeCheckout(mergePath: string, checkoutPath: string, hooksPath: string) {
  const format = stdoutText(await runGit(checkoutPath, ['rev-parse', '--show-object-format']))
  if (format !== 'sha1' && format !== 'sha256') throw new Error('不支持的 Git 对象格式。')
  await runGit(mergePath, ['init', '--template=', `--object-format=${format}`])
  await mkdir(join(mergePath, '.git', 'info'), { recursive: true })
  // Historical trees can contain custom merge/conversion attributes even when neither
  // current checkout does. Do not execute or inherit those drivers in the merge sandbox.
  await writeFile(join(mergePath, '.git', 'info', 'attributes'), PLAIN_ATTRIBUTES)
  await runGit(mergePath, ['config', 'core.hooksPath', hooksPath])
  await runGit(mergePath, ['config', 'user.name', 'Pi Worktree Preview'])
  await runGit(mergePath, ['config', 'user.email', 'pi-wtp-apply@localhost'])
}

async function computeMerge(
  tempRoot: string,
  sourceObjects: string,
  objectDirectory: string,
  baseOid: string,
  local: CheckoutSnapshot,
  isolated: CheckoutSnapshot,
  checkoutPath: string,
  projectPathPrefix: string,
): Promise<MergeResult> {
  const localCommit = await createSnapshotCommit(
    checkoutPath,
    local.treeOid,
    baseOid,
    objectDirectory,
    sourceObjects,
    'Local snapshot',
  )
  const isolatedCommit = await createSnapshotCommit(
    checkoutPath,
    isolated.treeOid,
    baseOid,
    objectDirectory,
    sourceObjects,
    'Isolated snapshot',
  )
  const mergePath = join(tempRoot, 'merge checkout')
  const hooksPath = join(tempRoot, 'disabled hooks')
  await mkdir(mergePath, { recursive: true })
  await mkdir(hooksPath, { recursive: true })
  await initMergeCheckout(mergePath, checkoutPath, hooksPath)

  const mergeEnv: NodeJS.ProcessEnv = {
    GIT_ALTERNATE_OBJECT_DIRECTORIES: [objectDirectory, sourceObjects].map(gitAlternate).join(delimiter),
  }
  await runGit(mergePath, ['checkout', '--detach', localCommit], { env: mergeEnv })
  const merge = await runGit(mergePath, ['merge', '--no-commit', '--no-ff', isolatedCommit], {
    env: mergeEnv,
    allowedExitCodes: [0, 1],
  })

  if (merge.exitCode === 1) {
    const conflicts = await runGit(mergePath, ['diff', '--name-only', '--diff-filter=U', '-z'], { env: mergeEnv })
    const conflictingFiles = parseNullSeparated(conflicts.stdout)
      .filter((path) => isProjectPath(path, projectPathPrefix))
      .map((path) => toProjectPath(path, projectPathPrefix))
      .sort()
    if (conflictingFiles.length === 0) throw new GitCommandFailure(['merge'], merge)
    return { status: 'conflict', conflictingFiles }
  }

  const mergedTree = stdoutText(await runGit(mergePath, ['write-tree'], { env: mergeEnv }))
  const changed = await runGit(
    mergePath,
    ['diff', '--name-only', '-z', '--no-ext-diff', '--no-renames', local.treeOid, mergedTree, '--'],
    { env: mergeEnv },
  )
  const patch = (
    await runGit(
      mergePath,
      [
        'diff',
        '--binary',
        '--full-index',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames', '--src-prefix=a/', '--dst-prefix=b/',
        local.treeOid,
        mergedTree,
        '--',
      ],
      { env: mergeEnv },
    )
  ).stdout
  const changedFiles = parseNullSeparated(changed.stdout)
    .filter((path) => isProjectPath(path, projectPathPrefix))
    .map((path) => toProjectPath(path, projectPathPrefix))
    .sort()
  const centralIndex = join(tempRoot, 'merged-central.index')
  const centralEnv: NodeJS.ProcessEnv = {
    ...gitObjectEnvironment(objectDirectory, sourceObjects),
    GIT_INDEX_FILE: centralIndex,
  }
  await runGit(checkoutPath, ['read-tree', local.treeOid], { env: centralEnv })
  if (patch.length > 0) {
    await runGit(checkoutPath, ['apply', '-p1', '--cached', '--binary', '--whitespace=nowarn'], {
      env: centralEnv,
      input: patch,
    })
  }
  const centralMergedTree = stdoutText(await runGit(checkoutPath, ['write-tree'], { env: centralEnv }))
  return { status: 'ready', changedFiles, patch, mergedTreeOid: centralMergedTree }
}

async function computeTreeMerge(
  tempRoot: string,
  sourceObjects: string,
  objectDirectory: string,
  checkoutPath: string,
  label: string,
  baseTreeOid: string,
  oursTreeOid: string,
  theirsTreeOid: string,
): Promise<TreeMergeResult> {
  const baseCommit = await createSnapshotCommit(
    checkoutPath,
    baseTreeOid,
    null,
    objectDirectory,
    sourceObjects,
    `${label} base`,
  )
  const oursCommit = await createSnapshotCommit(
    checkoutPath,
    oursTreeOid,
    baseCommit,
    objectDirectory,
    sourceObjects,
    `${label} ours`,
  )
  const theirsCommit = await createSnapshotCommit(
    checkoutPath,
    theirsTreeOid,
    baseCommit,
    objectDirectory,
    sourceObjects,
    `${label} theirs`,
  )
  const mergePath = join(tempRoot, label.replace(/[^a-z0-9_-]+/gi, '-'))
  const hooksPath = join(tempRoot, `${label}-disabled-hooks`.replace(/[^a-z0-9_-]+/gi, '-'))
  await mkdir(mergePath, { recursive: true })
  await mkdir(hooksPath, { recursive: true })
  await initMergeCheckout(mergePath, checkoutPath, hooksPath)

  const env: NodeJS.ProcessEnv = {
    GIT_ALTERNATE_OBJECT_DIRECTORIES: [objectDirectory, sourceObjects].map(gitAlternate).join(delimiter),
  }
  await runGit(mergePath, ['checkout', '--detach', oursCommit], { env })
  const merge = await runGit(mergePath, ['merge', '--no-commit', '--no-ff', theirsCommit], {
    env,
    allowedExitCodes: [0, 1],
  })
  if (merge.exitCode === 1) {
    const conflicts = await runGit(mergePath, ['diff', '--name-only', '--diff-filter=U', '-z'], { env })
    const conflictingFiles = parseNullSeparated(conflicts.stdout).sort()
    if (conflictingFiles.length === 0) throw new GitCommandFailure(['merge'], merge)
    return { status: 'conflict', conflictingFiles }
  }
  const mergedTreeOid = stdoutText(await runGit(mergePath, ['write-tree'], { env }))
  const mergedPatch = (
    await runGit(
      mergePath,
      [
        'diff',
        '--binary',
        '--full-index',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames', '--src-prefix=a/', '--dst-prefix=b/',
        oursTreeOid,
        mergedTreeOid,
        '--',
      ],
      { env },
    )
  ).stdout
  const centralIndex = join(tempRoot, `${label}-central.index`.replace(/[^a-z0-9_.-]+/gi, '-'))
  const centralEnv: NodeJS.ProcessEnv = {
    ...gitObjectEnvironment(objectDirectory, sourceObjects),
    GIT_INDEX_FILE: centralIndex,
  }
  await runGit(checkoutPath, ['read-tree', oursTreeOid], { env: centralEnv })
  if (mergedPatch.length > 0) {
    await runGit(checkoutPath, ['apply', '-p1', '--cached', '--binary', '--whitespace=nowarn'], {
      env: centralEnv,
      input: mergedPatch,
    })
  }
  return { status: 'ready', treeOid: stdoutText(await runGit(checkoutPath, ['write-tree'], { env: centralEnv })) }
}

async function treePatch(
  checkoutPath: string,
  fromTreeOid: string,
  toTreeOid: string,
  objectDirectory: string,
  sourceObjects: string,
): Promise<Buffer> {
  return (
    await runGit(
      checkoutPath,
      [
        'diff',
        '--binary',
        '--full-index',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames', '--src-prefix=a/', '--dst-prefix=b/',
        fromTreeOid,
        toTreeOid,
        '--',
      ],
      { env: gitObjectEnvironment(objectDirectory, sourceObjects) },
    )
  ).stdout
}

function pathsMatch(left: string, right: string): boolean {
  const normalizedLeft = canonicalExistingPath(left)
  const normalizedRight = canonicalExistingPath(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

function planMatches(stored: ApplyPlan, supplied: ApplyPlan): boolean {
  return stored.revision === supplied.revision
    && stored.localFingerprint === supplied.localFingerprint
    && stored.isolatedFingerprint === supplied.isolatedFingerprint
    && stored.effectiveBaseOid === supplied.effectiveBaseOid
    && stored.baseStrategy === supplied.baseStrategy
    && stored.localHeadOid === supplied.localHeadOid
    && stored.localHeadRef === supplied.localHeadRef
    && stored.isolatedHeadOid === supplied.isolatedHeadOid
    && stored.changedFiles.length === supplied.changedFiles.length
    && stored.changedFiles.every((path, index) => path === supplied.changedFiles[index])
}

async function prepareIndexFromPatch(
  checkoutPath: string,
  indexPath: string,
  baseOid: string,
  patch: Buffer,
): Promise<string> {
  const env = { GIT_INDEX_FILE: indexPath }
  await runGit(checkoutPath, ['read-tree', baseOid], { env })
  if (patch.length > 0) {
    await runGit(checkoutPath, ['apply', '-p1', '--cached', '--binary', '--whitespace=nowarn'], { env, input: patch })
  }
  return stdoutText(await runGit(checkoutPath, ['write-tree'], { env }))
}

async function createUserCommit(
  checkoutPath: string,
  treeOid: string,
  parentOid: string,
  commitMessage: string,
): Promise<string> {
  return stdoutText(await runGit(
    checkoutPath,
    ['commit-tree', treeOid, '-p', parentOid],
    { input: `${commitMessage.trim()}\n` },
  ))
}

async function prepareRollbackAssessment(
  tempRoot: string,
  sourceObjects: string,
  objectDirectory: string,
  localGitRoot: string,
  current: CheckoutSnapshot,
  receipt: PreviewReceipt,
): Promise<PreviewRecoverySafeRollback | PreviewRecoveryBlockedAction> {
  if (current.headRef !== receipt.localHeadRef) {
    return { status: 'blocked', code: 'stale_local', message: hostMessage('theLocalBranchHasChangedPreviewCannotBeRolled') }
  }
  if (current.headOid !== receipt.localHeadOid && !await isAncestor(localGitRoot, receipt.localHeadOid, current.headOid)) {
    return { status: 'blocked', code: 'stale_local', message: hostMessage('localHEADIsNotASafeFastForwardFrom') }
  }

  let rollbackBaselineTreeOid = receipt.localWorkingTreeOid
  let expectedPreviewTreeOid = receipt.previewWorkingTreeOid
  if (current.headOid !== receipt.localHeadOid) {
    const receiptHeadTreeOid = stdoutText(await runGit(localGitRoot, ['rev-parse', `${receipt.localHeadOid}^{tree}`]))
    const advancedBaseline = await computeTreeMerge(
      tempRoot, sourceObjects, objectDirectory, localGitRoot,
      'preview-rollback-advanced-baseline', receiptHeadTreeOid, current.headTreeOid, receipt.localWorkingTreeOid,
    )
    if (advancedBaseline.status === 'conflict') {
      return {
        status: 'blocked', code: 'preview_modified',
        message: hostMessage('newLocalCommitsConflictWithPrePreviewLocalChanges', { p0: advancedBaseline.conflictingFiles.join('、') }),
        conflictingFiles: [...advancedBaseline.conflictingFiles],
      }
    }
    const previewAbsence = await computeTreeMerge(
      tempRoot, sourceObjects, objectDirectory, localGitRoot,
      'preview-rollback-preview-absence', receipt.previewWorkingTreeOid, advancedBaseline.treeOid, receipt.localWorkingTreeOid,
    )
    if (previewAbsence.status === 'conflict') {
      return {
        status: 'blocked', code: 'preview_modified',
        message: hostMessage('newLocalCommitsConflictWithThePreviewTaskChanges', { p0: previewAbsence.conflictingFiles.join('、') }),
        conflictingFiles: [...previewAbsence.conflictingFiles],
      }
    }
    if (previewAbsence.treeOid !== advancedBaseline.treeOid) {
      return {
        status: 'blocked', code: 'preview_modified',
        message: hostMessage('newLocalCommitsAlreadyContainSomeOrAllPreview'),
      }
    }
    const advancedPreview = await computeTreeMerge(
      tempRoot, sourceObjects, objectDirectory, localGitRoot,
      'preview-rollback-advanced-preview', receipt.localWorkingTreeOid, advancedBaseline.treeOid, receipt.previewWorkingTreeOid,
    )
    if (advancedPreview.status === 'conflict') {
      return {
        status: 'blocked', code: 'preview_modified',
        message: hostMessage('newLocalCommitsConflictWithThePreviewTaskChanges', { p0: advancedPreview.conflictingFiles.join('、') }),
        conflictingFiles: [...advancedPreview.conflictingFiles],
      }
    }
    rollbackBaselineTreeOid = advancedBaseline.treeOid
    expectedPreviewTreeOid = advancedPreview.treeOid
  }
  const rollbackTree = await computeTreeMerge(
    tempRoot, sourceObjects, objectDirectory, localGitRoot,
    'preview-rollback', expectedPreviewTreeOid, current.treeOid, rollbackBaselineTreeOid,
  )
  if (rollbackTree.status === 'conflict') {
    return {
      status: 'blocked', code: 'preview_modified',
      message: hostMessage('localHasAdditionalChangesInThePreviewAreaSafe', { p0: rollbackTree.conflictingFiles.join('、') }),
      conflictingFiles: [...rollbackTree.conflictingFiles],
    }
  }
  return { status: 'safe', targetTreeOid: rollbackTree.treeOid }
}

async function prepareFinalizeAssessment(
  tempRoot: string,
  sourceObjects: string,
  objectDirectory: string,
  localGitRoot: string,
  current: CheckoutSnapshot,
  receipt: PreviewReceipt,
): Promise<PreviewRecoverySafeFinalize | PreviewRecoveryBlockedAction> {
  if (!receipt.localHeadRef?.startsWith('refs/heads/')) {
    return { status: 'blocked', code: 'operation_not_allowed', message: hostMessage('localIsNotOnANormalBranchATask') }
  }
  if (current.headRef !== receipt.localHeadRef) {
    return { status: 'blocked', code: 'stale_local', message: hostMessage('theLocalBranchHasChangedThePreviewCommitCannot') }
  }
  if (current.headOid !== receipt.localHeadOid && !await isAncestor(localGitRoot, receipt.localHeadOid, current.headOid)) {
    return { status: 'blocked', code: 'stale_local', message: hostMessage('localHEADIsNotASafeFastForwardFrom281') }
  }
  const previewRemoval = await computeTreeMerge(
    tempRoot, sourceObjects, objectDirectory, localGitRoot,
    'preview-finalize-separation', receipt.previewWorkingTreeOid, current.treeOid, receipt.localWorkingTreeOid,
  )
  if (previewRemoval.status === 'conflict') {
    return {
      status: 'blocked', code: 'preview_modified',
      message: hostMessage('localHasAdditionalChangesInThePreviewAreaA', { p0: previewRemoval.conflictingFiles.join('、') }),
      conflictingFiles: [...previewRemoval.conflictingFiles],
    }
  }
  const taskTree = await computeTreeMerge(
    tempRoot, sourceObjects, objectDirectory, localGitRoot,
    'preview-task-isolation', receipt.localWorkingTreeOid, current.headTreeOid, receipt.previewWorkingTreeOid,
  )
  if (taskTree.status === 'conflict') {
    return {
      status: 'blocked', code: 'commit_isolation_conflict',
      message: hostMessage('previewTaskChangesCannotBeReliablySeparatedFromThe', { p0: taskTree.conflictingFiles.join('、') }),
      conflictingFiles: [...taskTree.conflictingFiles],
    }
  }
  if (taskTree.treeOid === current.headTreeOid && receipt.changedFiles.length > 0) {
    return {
      status: 'blocked', code: 'preview_modified',
      message: hostMessage('previewTaskChangesAreAlreadyInLocalHEADNo'),
    }
  }
  const finalIndexTree = await computeTreeMerge(
    tempRoot, sourceObjects, objectDirectory, localGitRoot,
    'preview-index-preservation', current.headTreeOid, taskTree.treeOid, current.indexTreeOid,
  )
  if (finalIndexTree.status === 'conflict') {
    return {
      status: 'blocked', code: 'commit_isolation_conflict',
      message: hostMessage('thePreviewCommitCannotBeReliablySeparatedFromLocal', { p0: finalIndexTree.conflictingFiles.join('、') }),
      conflictingFiles: [...finalIndexTree.conflictingFiles],
    }
  }
  return {
    status: 'safe', taskTreeOid: taskTree.treeOid, finalIndexTreeOid: finalIndexTree.treeOid,
    expectedWorkingTreeOid: current.treeOid,
    commitRequired: receipt.changedFiles.length > 0 && taskTree.treeOid !== current.headTreeOid,
  }
}

async function resolveIndexPath(checkoutPath: string): Promise<string> {
  return resolve(checkoutPath, stdoutText(await runGit(
    checkoutPath,
    ['rev-parse', '--path-format=absolute', '--git-path', 'index'],
  )))
}

async function syncPath(path: string) {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

/** Persist regular contents and directory entries before declaring a journaled write complete. */
async function syncPatchedPaths(root: string, paths: string[]) {
  const dirs = new Set([root])
  for (const path of paths) {
    const parts = path.split('/')
    if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('无效的 Git 路径。')
    let full = root
    for (const part of parts) {
      full = join(full, part)
      const st = await lstat(full).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      })
      if (st?.isDirectory()) { dirs.add(full); continue }
      if (st?.isFile()) await syncPath(full)
      break
    }
  }
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) await syncPath(dir)
}

async function removeBestEffort(path: string | null): Promise<void> {
  if (!path) return
  try {
    await unlink(path)
  } catch {
    // 临时 index 不存在或已完成 rename 时无需处理。
  }
}

async function writeIndexLock(indexPath: string, contents: Buffer): Promise<string> {
  const lockPath = `${indexPath}.lock`
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(lockPath, 'wx')
    await handle.writeFile(contents)
    await handle.sync()
    await handle.close()
    handle = null
    return lockPath
  } catch (error) {
    try {
      await handle?.close()
    } catch {
      // 原始错误优先；finally 会清理由本次调用创建的 lock。
    }
    if (handle) await removeBestEffort(lockPath)
    throw error
  }
}

function isIndexLockContention(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'EEXIST'
}

class DefaultSessionCheckoutApplyEngine implements SessionCheckoutApplyEngine {
  private readonly plans = new Map<string, StoredPlan>()

  constructor(private readonly options: SessionCheckoutApplyEngineOptions) {}

  private captureSnapshot(checkoutPath: string, indexPath: string, objectDirectory: string | null, sourceObjects: string | null): Promise<CheckoutSnapshot> {
    return captureSnapshot(checkoutPath, indexPath, objectDirectory, sourceObjects)
  }

  async inspectReview(input: ApplyPlanInput): Promise<InspectReviewResult> {
    if (!OID_PATTERN.test(input.baseOid)) {
      return { status: 'error', error: { code: 'invalid_input', message: hostMessage('invalidSessionBaseOIDFormat') } }
    }
    let tempRoot: string | null = null
    try {
      tempRoot = await mkdtemp(join(tmpdir(), 'pi-wtp-review-snapshot-'))
      const objectDirectory = join(tempRoot, 'objects')
      await mkdir(objectDirectory, { recursive: true })
      const localGitRoot = await resolveGitRoot(input.localPath)
      const isolatedGitRoot = await resolveGitRoot(input.isolatedPath)
      const localObjects = await sourceObjectDirectory(localGitRoot)
      const isolatedObjects = await sourceObjectDirectory(isolatedGitRoot)
      if (!pathsMatch(localObjects, isolatedObjects)) {
        return { status: 'error', error: { code: 'invalid_input', message: hostMessage('localAndIsolatedDoNotBelongToTheSame') } }
      }
      const localPrefix = projectPrefix(localGitRoot, input.localPath)
      const isolatedPrefix = projectPrefix(isolatedGitRoot, input.isolatedPath)
      if (localPrefix === null || isolatedPrefix === null || localPrefix !== isolatedPrefix) {
        return { status: 'error', error: { code: 'invalid_input', message: hostMessage('theLocalAndIsolatedProjectSubdirectoriesDoNotMatch') } }
      }
      await runGit(localGitRoot, ['cat-file', '-e', `${input.baseOid}^{commit}`])
      const isolated = await this.captureSnapshot(
        isolatedGitRoot,
        join(tempRoot, 'isolated.index'),
        objectDirectory,
        localObjects,
      )
      const changedFiles = await changedTreePaths(
        isolatedGitRoot,
        input.baseOid,
        isolated.treeOid,
        objectDirectory,
        localObjects,
      )
      if (changedFiles.some((path) => !isProjectPath(path, localPrefix))) {
        return { status: 'error', error: { code: 'invalid_input', message: hostMessage('isolatedContainsChangesOutsideTheProjectRootAReview') } }
      }
      return {
        status: 'ready',
        isolatedFingerprint: isolated.fingerprint,
        isolatedHeadOid: isolated.headOid,
        changedFiles: changedFiles.map((path) => toProjectPath(path, localPrefix)).sort(),
      }
    } catch (error) {
      return { status: 'error', error: { code: 'git_error', message: this.errorMessage(error) } }
    } finally {
      if (tempRoot) await this.cleanup(tempRoot)
    }
  }

  async plan(input: ApplyPlanInput): Promise<ApplyPlanResult> {
    return this.calculatePlan(input, true)
  }

  private async calculatePlan(input: ApplyPlanInput, persistPlan: boolean): Promise<ApplyPlanResult> {
    if (!OID_PATTERN.test(input.baseOid)) {
      return { status: 'error', error: { code: 'invalid_input', message: hostMessage('invalidSessionBaseOIDFormat') } }
    }

    let tempRoot: string | null = null
    try {
      tempRoot = await mkdtemp(join(tmpdir(), 'pi-wtp-apply-plan-'))
      const objectDirectory = join(tempRoot, 'objects')
      await mkdir(objectDirectory, { recursive: true })
      const localGitRoot = await resolveGitRoot(input.localPath)
      const isolatedGitRoot = await resolveGitRoot(input.isolatedPath)
      const localObjects = await sourceObjectDirectory(localGitRoot)
      const isolatedObjects = await sourceObjectDirectory(isolatedGitRoot)
      if (!pathsMatch(localObjects, isolatedObjects)) {
        return { status: 'error', error: { code: 'invalid_input', message: hostMessage('localAndIsolatedDoNotBelongToTheSame') } }
      }
      const localPrefix = projectPrefix(localGitRoot, input.localPath)
      const isolatedPrefix = projectPrefix(isolatedGitRoot, input.isolatedPath)
      if (localPrefix === null || isolatedPrefix === null || localPrefix !== isolatedPrefix) {
        return { status: 'error', error: { code: 'invalid_input', message: hostMessage('theLocalAndIsolatedProjectSubdirectoriesDoNotMatch') } }
      }
      await runGit(localGitRoot, ['cat-file', '-e', `${input.baseOid}^{commit}`])

      const local = await this.captureSnapshot(
        localGitRoot,
        join(tempRoot, 'local.index'),
        objectDirectory,
        localObjects,
      )
      const isolated = await this.captureSnapshot(
        isolatedGitRoot,
        join(tempRoot, 'isolated.index'),
        objectDirectory,
        localObjects,
      )
      const effectiveBase = await selectEffectiveApplyBase(
        localGitRoot,
        input.baseOid,
        local.headOid,
        isolated.headOid,
      )
      const isolatedChangedPaths = await changedTreePaths(
        isolatedGitRoot,
        effectiveBase.oid,
        isolated.treeOid,
        objectDirectory,
        localObjects,
      )
      if (isolatedChangedPaths.some((path) => !isProjectPath(path, localPrefix))) {
        return {
          status: 'error',
          error: { code: 'invalid_input', message: hostMessage('isolatedContainsChangesOutsideTheProjectRootApplyWas') },
        }
      }
      const merge = await computeMerge(
        tempRoot,
        localObjects,
        objectDirectory,
        effectiveBase.oid,
        local,
        isolated,
        localGitRoot,
        localPrefix,
      )
      const revision = randomUUID()
      if (merge.status === 'conflict') {
        return {
          status: 'conflict',
          revision,
          localFingerprint: local.fingerprint,
          isolatedFingerprint: isolated.fingerprint,
          effectiveBaseOid: effectiveBase.oid,
          baseStrategy: effectiveBase.strategy,
          localHeadOid: local.headOid,
          isolatedHeadOid: isolated.headOid,
          conflictingFiles: merge.conflictingFiles,
        }
      }

      const plan: ApplyPlan = {
        revision,
        localFingerprint: local.fingerprint,
        isolatedFingerprint: isolated.fingerprint,
        effectiveBaseOid: effectiveBase.oid,
        baseStrategy: effectiveBase.strategy,
        localHeadOid: local.headOid,
        localHeadRef: local.headRef,
        isolatedHeadOid: isolated.headOid,
        changedFiles: merge.changedFiles,
      }
      if (persistPlan) {
        this.plans.set(revision, {
          input: { ...input },
          patch: merge.patch,
          plan: { ...plan, changedFiles: [...plan.changedFiles] },
          scope: {
            isolatedGitRoot,
            localGitRoot,
            projectPrefix: localPrefix,
            sourceObjects: localObjects,
          },
        })
      }
      return { status: 'ready', plan: { ...plan, changedFiles: [...plan.changedFiles] } }
    } catch (error) {
      return { status: 'error', error: { code: 'git_error', message: this.errorMessage(error) } }
    } finally {
      if (tempRoot) await this.cleanup(tempRoot)
    }
  }

  async preview(
    plan: ApplyPlan,
    options: {
      previewId: string
      reviewId: string
      iteration: number
      beforeWrite?(receipt: PreviewReceipt): Promise<void>
    },
  ): Promise<PreviewResult> {
    const stored = this.plans.get(plan.revision)
    if (!stored || !planMatches(stored.plan, plan)) {
      return { status: 'error', error: { code: 'invalid_plan', message: hostMessage('thePreviewPlanIsMissingAlreadyUsedOrModified') } }
    }
    if (!options.previewId.trim() || !options.reviewId.trim() || !Number.isSafeInteger(options.iteration) || options.iteration < 1) {
      return { status: 'error', error: { code: 'invalid_input', message: hostMessage('invalidPreviewIdentity') } }
    }

    let tempRoot: string | null = null
    try {
      tempRoot = await mkdtemp(join(tmpdir(), 'pi-wtp-preview-'))
      const objectDirectory = join(tempRoot, 'objects')
      await mkdir(objectDirectory, { recursive: true })
      const sourceObjects = await sourceObjectDirectory(stored.scope.localGitRoot)
      if (!pathsMatch(sourceObjects, stored.scope.sourceObjects)) {
        return { status: 'error', error: { code: 'invalid_plan', message: hostMessage('thePreviewPlanSGitRepositoryIdentityHasChanged') } }
      }
      const local = await this.captureSnapshot(
        stored.scope.localGitRoot,
        join(tempRoot, 'local.index'),
        objectDirectory,
        sourceObjects,
      )
      if (
        local.headOid !== stored.plan.localHeadOid
        || local.headRef !== stored.plan.localHeadRef
        || local.fingerprint !== stored.plan.localFingerprint
      ) {
        return { status: 'error', error: { code: 'stale_local', message: hostMessage('localChangedAfterPlanningRecalculateThePlan') } }
      }
      const isolated = await this.captureSnapshot(
        stored.scope.isolatedGitRoot,
        join(tempRoot, 'isolated.index'),
        objectDirectory,
        sourceObjects,
      )
      if (isolated.headOid !== stored.plan.isolatedHeadOid || isolated.fingerprint !== stored.plan.isolatedFingerprint) {
        return { status: 'error', error: { code: 'stale_isolated', message: hostMessage('isolatedChangedAfterPlanningRecalculateThePlan') } }
      }

      const persistentLocal = await this.captureSnapshot(
        stored.scope.localGitRoot,
        join(tempRoot, 'persistent-local.index'),
        null,
        null,
      )
      const persistentIsolated = await this.captureSnapshot(
        stored.scope.isolatedGitRoot,
        join(tempRoot, 'persistent-isolated.index'),
        null,
        null,
      )
      if (
        persistentLocal.fingerprint !== stored.plan.localFingerprint
        || persistentIsolated.fingerprint !== stored.plan.isolatedFingerprint
      ) {
        return { status: 'error', error: { code: 'invalid_plan', message: hostMessage('thePersistentPreviewSnapshotDoesNotMatchTheReviewed') } }
      }
      const previewWorkingTreeOid = await prepareIndexFromPatch(
        stored.scope.localGitRoot,
        join(tempRoot, 'preview-working.index'),
        persistentLocal.treeOid,
        stored.patch,
      )
      const isolatedSnapshotOid = await createSnapshotCommit(
        stored.scope.isolatedGitRoot,
        persistentIsolated.treeOid,
        stored.plan.effectiveBaseOid,
        null,
        null,
        'Previewed Isolated snapshot',
      )
      if (stored.plan.changedFiles.length === 0) {
        return { status: 'error', error: { code: 'operation_not_allowed', message: '本次任务没有可写入 Local 的新改动。' } }
      }
      const preparedReceipt: PreviewReceipt = {
        previewId: options.previewId,
        reviewId: options.reviewId,
        iteration: options.iteration,
        previewedAt: Date.now(),
        configuredBaseOid: stored.input.baseOid,
        effectiveBaseOid: stored.plan.effectiveBaseOid,
        baseStrategy: stored.plan.baseStrategy,
        localHeadOid: persistentLocal.headOid,
        localHeadRef: persistentLocal.headRef,
        localFingerprintBefore: persistentLocal.fingerprint,
        localFingerprintPreview: snapshotFingerprint(persistentLocal.headOid, persistentLocal.headRef, persistentLocal.indexEntries, previewWorkingTreeOid),
        localWorkingTreeOid: persistentLocal.treeOid,
        localIndexTreeOid: persistentLocal.indexTreeOid,
        previewWorkingTreeOid,
        isolatedHeadOid: persistentIsolated.headOid,
        isolatedFingerprint: persistentIsolated.fingerprint,
        isolatedSnapshotOid,
        changedFiles: [...stored.plan.changedFiles],
      }

      await options.beforeWrite?.(preparedReceipt)
      await this.options.beforeFinalLocalValidation?.()
      const finalIsolated = await this.captureSnapshot(stored.scope.isolatedGitRoot, join(tempRoot, 'final-isolated.index'), objectDirectory, sourceObjects)
      if (finalIsolated.fingerprint !== stored.plan.isolatedFingerprint) {
        return { status: 'error', error: { code: 'stale_isolated', message: '待验收的 Worktree 在预览前发生变化。' } }
      }
      const finalLocal = await this.captureSnapshot(
        stored.scope.localGitRoot,
        join(tempRoot, 'final-local.index'),
        objectDirectory,
        sourceObjects,
      )
      if (finalLocal.headOid !== stored.plan.localHeadOid || finalLocal.fingerprint !== stored.plan.localFingerprint) {
        return { status: 'error', error: { code: 'stale_local', message: hostMessage('localChangedBeforePreviewWroteItsChangesRecalculateThe') } }
      }
      if (stored.patch.length > 0) {
        await runGit(stored.scope.localGitRoot, ['apply', '-p1', '--binary', '--whitespace=nowarn'], { input: stored.patch })
        await syncPatchedPaths(stored.scope.localGitRoot, stored.plan.changedFiles)
      }
      await this.options.afterLocalWriteBeforeVerification?.()
      const previewedLocal = await this.captureSnapshot(
        stored.scope.localGitRoot,
        join(tempRoot, 'previewed-local.index'),
        null,
        null,
      )
      if (previewedLocal.treeOid !== previewWorkingTreeOid || previewedLocal.headOid !== persistentLocal.headOid ||
          previewedLocal.headRef !== persistentLocal.headRef || !previewedLocal.indexEntries.equals(persistentLocal.indexEntries)) {
        return {
          status: 'error',
          error: { code: 'git_error', message: hostMessage('theLocalSnapshotAfterPreviewDoesNotMatchThe') },
        }
      }

      this.plans.delete(plan.revision)
      const receipt: PreviewReceipt = {
        ...preparedReceipt,
        localFingerprintPreview: previewedLocal.fingerprint,
      }
      return { status: 'previewed', receipt, changedFiles: [...receipt.changedFiles] }
    } catch (error) {
      return { status: 'error', error: { code: 'git_error', message: this.errorMessage(error) } }
    } finally {
      if (tempRoot) await this.cleanup(tempRoot)
    }
  }

  async rollback(input: {
    localPath: string
    receipt: PreviewReceipt
    beforeWrite?(): Promise<void>
  }): Promise<RollbackResult> {
    let tempRoot: string | null = null
    try {
      tempRoot = await mkdtemp(join(tmpdir(), 'pi-wtp-preview-rollback-'))
      const localGitRoot = await resolveGitRoot(input.localPath)
      const objectDirectory = join(tempRoot, 'objects')
      await mkdir(objectDirectory, { recursive: true })
      const sourceObjects = await sourceObjectDirectory(localGitRoot)
      const current = await this.captureSnapshot(
        localGitRoot,
        join(tempRoot, 'current.index'),
        objectDirectory,
        sourceObjects,
      )
      if (current.fingerprint !== input.receipt.localFingerprintPreview) {
        return { status: 'error', error: { code: 'stale_local', message: 'Local 自预览后已变化；停止撤回，保留现场。' } }
      }
      const assessment = await prepareRollbackAssessment(
        tempRoot,
        sourceObjects,
        objectDirectory,
        localGitRoot,
        current,
        input.receipt,
      )
      if (assessment.status === 'blocked') {
        return { status: 'error', error: { code: assessment.code, message: assessment.message } }
      }
      const rollbackPatch = await treePatch(
        localGitRoot,
        current.treeOid,
        assessment.targetTreeOid,
        objectDirectory,
        sourceObjects,
      )
      // Journal persistence may await registry I/O, so it must happen before the authoritative
      // final Local CAS. From the snapshot below to git apply there is no callback/yield seam.
      await input.beforeWrite?.()
      await this.options.beforeFinalLocalValidation?.()
      const finalLocal = await this.captureSnapshot(
        localGitRoot,
        join(tempRoot, 'final-local.index'),
        objectDirectory,
        sourceObjects,
      )
      if (
        finalLocal.fingerprint !== current.fingerprint
        || finalLocal.headOid !== current.headOid
        || finalLocal.headRef !== current.headRef
      ) {
        return { status: 'error', error: { code: 'stale_local', message: hostMessage('localChangedBeforePreviewRollbackRetry') } }
      }
      if (rollbackPatch.length > 0) {
        await runGit(localGitRoot, ['apply', '-p1', '--binary', '--whitespace=nowarn'], { input: rollbackPatch })
        await syncPatchedPaths(localGitRoot, input.receipt.changedFiles)
      }
      let rolledBack: CheckoutSnapshot
      try {
        await this.options.afterLocalWriteBeforeVerification?.()
        rolledBack = await this.captureSnapshot(
          localGitRoot,
          join(tempRoot, 'rolled-back.index'),
          null,
          null,
        )
      } catch (error) {
        return {
          status: 'error',
          error: {
            code: 'git_error',
            message: hostMessage('cannotVerifyAfterWritingPreviewRollbackTheEnvironmentMust', { p0: this.errorMessage(error) }),
            recoveryState: 'uncertain',
          },
        }
      }
      const expectedFingerprint = snapshotFingerprint(
        current.headOid,
        current.headRef,
        current.indexEntries,
        assessment.targetTreeOid,
      )
      if (
        rolledBack.headOid !== current.headOid
        || rolledBack.headRef !== current.headRef
        || rolledBack.indexTreeOid !== current.indexTreeOid
        || rolledBack.treeOid !== assessment.targetTreeOid
        || rolledBack.fingerprint !== expectedFingerprint
      ) {
        return {
          status: 'error',
          error: {
            code: 'git_error',
            message: hostMessage('theLocalSnapshotAfterPreviewRollbackDoesNotMatch'),
            recoveryState: 'uncertain',
          },
        }
      }
      return { status: 'preview_rolled_back', changedFiles: [...input.receipt.changedFiles] }
    } catch (error) {
      return { status: 'error', error: { code: 'git_error', message: this.errorMessage(error) } }
    } finally {
      if (tempRoot) await this.cleanup(tempRoot)
    }
  }

  async finalize(input: {
    localPath: string
    receipt: PreviewReceipt
    commitMessage: string
    beforeCommit?(commitOid: string, indexBefore: Buffer, indexAfter: Buffer): Promise<void>
  }): Promise<FinishResult> {
    const commitMessage = input.commitMessage.trim()
    if (!isValidCommitMessage(commitMessage)) {
      return { status: 'error', error: { code: 'invalid_input', message: hostMessage('theCommitMessageMustBeNonemptyAndContainNoNul') } }
    }

    let tempRoot: string | null = null
    let ownedIndexLock: string | null = null
    let backupIndex: string | null = null
    let preserveBackup = false
    try {
      tempRoot = await mkdtemp(join(tmpdir(), 'pi-wtp-preview-finalize-'))
      const localGitRoot = await resolveGitRoot(input.localPath)
      const objectDirectory = join(tempRoot, 'objects')
      await mkdir(objectDirectory, { recursive: true })
      const sourceObjects = await sourceObjectDirectory(localGitRoot)
      const current = await this.captureSnapshot(
        localGitRoot,
        join(tempRoot, 'current.index'),
        objectDirectory,
        sourceObjects,
      )
      if (current.fingerprint !== input.receipt.localFingerprintPreview) {
        return { status: 'error', error: { code: 'stale_local', message: 'Local 自预览后已变化；停止提交，保留现场。' } }
      }
      const realIndexPath = await resolveIndexPath(localGitRoot)
      const originalIndexBytes = await readFile(realIndexPath)
      const assessment = await prepareFinalizeAssessment(
        tempRoot,
        sourceObjects,
        objectDirectory,
        localGitRoot,
        current,
        input.receipt,
      )
      if (assessment.status === 'blocked') {
        return { status: 'error', error: { code: assessment.code, message: assessment.message } }
      }

      if (!assessment.commitRequired) {
        await this.options.beforeFinalLocalValidation?.()
        const finalLocal = await this.captureSnapshot(
          localGitRoot,
          join(tempRoot, 'final-empty.index'),
          objectDirectory,
          sourceObjects,
        )
        if (
          finalLocal.headOid !== current.headOid
          || finalLocal.headRef !== current.headRef
          || finalLocal.fingerprint !== current.fingerprint
        ) {
          return { status: 'error', error: { code: 'stale_local', message: hostMessage('localChangedBeforeFinalizingPreviewRetry') } }
        }
        return {
          status: 'finished',
          changedFiles: [],
          commitOid: null,
          nextBaseOid: input.receipt.isolatedSnapshotOid,
        }
      }

      const taskPatch = await treePatch(
        localGitRoot,
        current.headTreeOid,
        assessment.taskTreeOid,
        objectDirectory,
        sourceObjects,
      )
      const finalIndexPatch = await treePatch(
        localGitRoot,
        assessment.taskTreeOid,
        assessment.finalIndexTreeOid,
        objectDirectory,
        sourceObjects,
      )
      const actualTaskTreeOid = await prepareIndexFromPatch(
        localGitRoot,
        join(tempRoot, 'task.index'),
        current.headOid,
        taskPatch,
      )
      if (actualTaskTreeOid !== assessment.taskTreeOid) {
        return { status: 'error', error: { code: 'git_error', message: hostMessage('thePreviewTaskCommitTreeDoesNotMatchThe') } }
      }
      const commitOid = await createUserCommit(localGitRoot, actualTaskTreeOid, current.headOid, commitMessage)
      const finalIndexPath = join(tempRoot, 'final.index')
      const actualFinalIndexTreeOid = await prepareIndexFromPatch(
        localGitRoot,
        finalIndexPath,
        commitOid,
        finalIndexPatch,
      )
      if (actualFinalIndexTreeOid !== assessment.finalIndexTreeOid) {
        return { status: 'error', error: { code: 'git_error', message: hostMessage('thePreviewFinalIndexTreeDoesNotMatchThe') } }
      }
      const expectedIndexEntries = (
        await runGit(localGitRoot, ['ls-files', '--stage', '-z'], { env: { GIT_INDEX_FILE: finalIndexPath } })
      ).stdout
      const intendedIndexBytes = await readFile(finalIndexPath)
      const expectedFingerprint = snapshotFingerprint(
        commitOid,
        current.headRef,
        expectedIndexEntries,
        assessment.expectedWorkingTreeOid,
      )
      await input.beforeCommit?.(commitOid, originalIndexBytes, intendedIndexBytes)

      const branchRef = current.headRef
      if (!branchRef?.startsWith('refs/heads/')) {
        return { status: 'error', error: { code: 'operation_not_allowed', message: hostMessage('localIsNotOnANormalBranchATask') } }
      }
      backupIndex = `${realIndexPath}.pi-wtp-backup-${randomUUID()}`
      const backup = await open(backupIndex, 'wx', 0o600)
      try { await backup.writeFile(originalIndexBytes); await backup.sync() } finally { await backup.close() }
      await syncPath(dirname(realIndexPath))
      await this.options.beforeFinalLocalValidation?.()
      try {
        // Use Git's canonical index.lock protocol. While this lock exists, concurrent git add/reset
        // cannot mutate the real index between the authoritative snapshot and our atomic replacement.
        ownedIndexLock = await writeIndexLock(realIndexPath, intendedIndexBytes)
      } catch (error) {
        if (isIndexLockContention(error)) {
          return { status: 'error', error: { code: 'stale_local', message: hostMessage('anotherGitOperationIsUpdatingTheLocalIndexRetry') } }
        }
        throw error
      }
      const finalLocal = await this.captureSnapshot(
        localGitRoot,
        join(tempRoot, 'final-local.index'),
        objectDirectory,
        sourceObjects,
      )
      const finalIndexBytes = await readFile(realIndexPath)
      if (
        finalLocal.headOid !== current.headOid
        || finalLocal.headRef !== current.headRef
        || finalLocal.fingerprint !== current.fingerprint
        || !finalIndexBytes.equals(originalIndexBytes)
      ) {
        return { status: 'error', error: { code: 'stale_local', message: hostMessage('localChangedBeforeThePreviewCommitWasWrittenRetry') } }
      }

      let refUpdated = false
      let indexReplaced = false
      let writeError: unknown = null
      try {
        await runGit(localGitRoot, ['update-ref', branchRef, commitOid, current.headOid])
        refUpdated = true
        await rename(ownedIndexLock, realIndexPath)
        ownedIndexLock = null
        indexReplaced = true
        await syncPath(dirname(realIndexPath))
      } catch (error) {
        writeError = error
      }

      if (!writeError) {
        try {
          await this.options.afterLocalWriteBeforeVerification?.()
          const committed = await this.captureSnapshot(
            localGitRoot,
            join(tempRoot, 'committed.index'),
            null,
            null,
          )
          const committedIndexBytes = await readFile(realIndexPath)
          if (
            committed.headOid === commitOid
            && committed.headRef === branchRef
            && committed.indexTreeOid === assessment.finalIndexTreeOid
            && committed.treeOid === assessment.expectedWorkingTreeOid
            && committed.fingerprint === expectedFingerprint
            && committedIndexBytes.equals(intendedIndexBytes)
          ) {
            await removeBestEffort(backupIndex)
            backupIndex = null
            return {
              status: 'finished',
              changedFiles: [...input.receipt.changedFiles],
              commitOid,
              nextBaseOid: input.receipt.isolatedSnapshotOid,
            }
          }
          writeError = new Error(hostMessage('previewCommitVerificationFailedAfterWriting'))
        } catch (error) {
          writeError = error
        }
      }

      const rollbackErrors: string[] = []
      if (refUpdated && !indexReplaced && ownedIndexLock) {
        // The ref moved but the index replacement did not. We still own index.lock, so no Git
        // index writer can race the ref CAS rollback; the real index is already the original one.
        try {
          await runGit(localGitRoot, ['update-ref', branchRef, current.headOid, commitOid])
          refUpdated = false
          await removeBestEffort(ownedIndexLock)
          ownedIndexLock = null
        } catch (error) {
          rollbackErrors.push(`ref: ${this.errorMessage(error)}`)
        }
      } else if (refUpdated && indexReplaced && backupIndex) {
        // Never restore the old backup over an index that changed after our write.
        try {
          const backupBytes = await readFile(backupIndex)
          ownedIndexLock = await writeIndexLock(realIndexPath, backupBytes)
          const currentIndexBytes = await readFile(realIndexPath)
          if (!currentIndexBytes.equals(intendedIndexBytes)) {
            rollbackErrors.push(hostMessage('indexLocalIndexChangedAfterPreviewWroteItsChanges'))
          } else {
            await runGit(localGitRoot, ['update-ref', branchRef, current.headOid, commitOid])
            refUpdated = false
            await rename(ownedIndexLock, realIndexPath)
            ownedIndexLock = null
            indexReplaced = false
          }
        } catch (error) {
          rollbackErrors.push(`compensation: ${this.errorMessage(error)}`)
        }
      } else if (refUpdated) {
        rollbackErrors.push(hostMessage('refVerifiableIndexCompensationEvidenceIsMissingPartialRollback'))
      }

      let restored = false
      if (rollbackErrors.length === 0) {
        try {
          const restoredLocal = await this.captureSnapshot(
            localGitRoot,
            join(tempRoot, 'restored.index'),
            null,
            null,
          )
          const restoredIndexBytes = await readFile(realIndexPath)
          restored = restoredLocal.headOid === current.headOid
            && restoredLocal.headRef === current.headRef
            && restoredLocal.indexTreeOid === current.indexTreeOid
            && restoredLocal.treeOid === current.treeOid
            && restoredLocal.fingerprint === current.fingerprint
            && restoredIndexBytes.equals(originalIndexBytes)
        } catch (error) {
          rollbackErrors.push(`verification: ${this.errorMessage(error)}`)
        }
      }
      if (restored) {
        await removeBestEffort(backupIndex)
        backupIndex = null
        return {
          status: 'error',
          error: {
            code: 'git_error',
            message: hostMessage('thePreviewCommitWriteCouldNotBeVerifiedAnd', { p0: this.errorMessage(writeError) }),
            recoveryState: 'unchanged',
          },
        }
      }

      preserveBackup = true
      const rollbackDetail = rollbackErrors.length > 0 ? `；${rollbackErrors.join('；')}` : ''
      return {
        status: 'error',
        error: {
          code: 'git_error',
          message: hostMessage('cannotProveSuccessOrCompleteRollbackAfterWritingThe', { p0: this.errorMessage(writeError), p1: rollbackDetail }),
          recoveryState: 'uncertain',
        },
      }
    } catch (error) {
      return { status: 'error', error: { code: 'git_error', message: this.errorMessage(error) } }
    } finally {
      await removeBestEffort(ownedIndexLock)
      if (!preserveBackup) await removeBestEffort(backupIndex)
      if (tempRoot) await this.cleanup(tempRoot)
    }
  }

  private errorMessage(error: unknown): string {
    if (error instanceof GitCommandFailure) {
      return hostMessage('gitOperationFailed', { p0: error.args[0] ?? 'unknown', p1: error.message })
    }
    return error instanceof Error ? error.message : hostMessage('unknownGitError')
  }

  private async cleanup(path: string): Promise<void> {
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 2 })
    } catch (error) {
      // 清理失败不能掩盖 plan/apply 的主结果。
      console.warn(hostMessage('tempDirectoryCleanupFailed'), error)
    }
  }
}

export function createSessionCheckoutApplyEngine(
  options: SessionCheckoutApplyEngineOptions = {},
): SessionCheckoutApplyEngine {
  return new DefaultSessionCheckoutApplyEngine(options)
}
