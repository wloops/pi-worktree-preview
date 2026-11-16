import { isValidCommitMessage } from './commit-message.ts'
import { createTranslator } from './i18n/core.ts'
import { hostMessages } from './i18n/host-messages.ts'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants, realpathSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
const hostMessage = createTranslator(hostMessages, 'zh')
type ApplyBaseStrategy = 'recorded_base' | 'isolated_contains_local_head' | 'local_contains_isolated_head'

export interface ApplyPlanInput {
  baseOid: string
  isolatedPath: string
  localPath: string
}

interface ReviewedEntry {
  path: string
  working: string | null
  index: string | null
}

export interface FrozenReview {
  version: 1
  entries: ReviewedEntry[]
}

interface ExpectedReview {
  files: string[]
  fingerprint: string
  snapshot?: FrozenReview
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
  isolatedHeadRef: string | null
  isolatedTreeOid: string
  isolatedIndexTreeOid: string
  changedFiles: string[]
  snapshot: FrozenReview
  /** At least one changed working, index or HEAD path is outside the delivery. */
  partial: boolean
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
  localHeadOid: string
  localHeadRef: string | null
  isolatedHeadOid: string
  conflictingFiles: string[]
  committedConflictingFiles: string[]
  dirtyConflict: boolean
  reviewedTreeOid: string
  /** Stage-zero deltas relative to Local HEAD on other reviewed paths; absent for ambiguous Git paths. */
  cleanEntries?: { path: string; entry: string | null }[]
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

export interface PreviewRecoverySafeFinalize {
  status: 'safe'
  taskTreeOid: string
  finalIndexTreeOid: string
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

interface PreviewIdentity { previewId: string; reviewId: string; iteration: number }
type CommitJournal = (commitOid: string, indexBefore: Buffer | null, indexAfter: Buffer) => Promise<void>
interface FinalizeInput { localPath: string; receipt: PreviewReceipt; commitMessage: string; beforeCommit?: CommitJournal }
type DirectCommitOptions = PreviewIdentity & {
  commitMessage: string
  beforeWrite(receipt: PreviewReceipt, commitOid: string, indexBefore: Buffer | null, indexAfter: Buffer, finalIndexTreeOid: string): Promise<void>
}

export interface SessionCheckoutApplyEngine {
  inspectReview(input: ApplyPlanInput, files?: readonly string[]): Promise<InspectReviewResult>
  /** Narrow an existing review without accepting new bytes or paths. */
  restrictReview(input: ApplyPlanInput, expected: ExpectedReview, files: readonly string[]): Promise<FrozenReview>
  /** Merge only the frozen review scope; do not modify either checkout. */
  plan(input: ApplyPlanInput, review: ExpectedReview): Promise<ApplyPlanResult>
  preview(plan: ApplyPlan, options: {
    previewId: string
    reviewId: string
    iteration: number
    /** Local 写入前持久化 receipt artifacts/journal；失败时不得触碰 Local。 */
    beforeWrite?(receipt: PreviewReceipt): Promise<void>
  }): Promise<PreviewResult>
  rollback(input: {
    localPath: string
    receipt: PreviewReceipt
    /** Persists the mutation journal before the final Local CAS; no Local write may happen before it resolves. */
    beforeWrite?(): Promise<void>
  }): Promise<RollbackResult>
  finalize(input: FinalizeInput): Promise<FinishResult>
  /** Prepare and deliver in one journaled operation, without opening a preview. */
  commitReady(plan: ApplyPlan, options: DirectCommitOptions): Promise<FinishResult>
}

export interface SessionCheckoutApplyEngineOptions {
  /** 测试/宿主 seam：在最后一次 Local fingerprint 校验前执行。 */
  beforeFinalLocalValidation?(): Promise<void> | void
  /** 测试/宿主 seam：在 Local 写入完成、独立写后验证开始前执行。 */
  afterLocalWriteBeforeVerification?(): Promise<void> | void
  /** Test seam between the durable working-tree patch and the ref/index write. */
  afterDirectPatchBeforeCommit?(): Promise<void> | void
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
  review: FrozenReview
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
  rawConflicts?: string[]
  cleanEntries?: { path: string; entry: string | null }[]
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

// Git mode + blob ID (or absence) for exact paths. ls-tree uses a type token;
// ls-files --stage instead has a stage number, which must be zero for reviewed paths.
function entryMap(raw: Buffer, kind: 'tree' | 'index', paths: ReadonlySet<string>): Map<string, string> {
  const entries = new Map<string, string>()
  for (const record of parseNullSeparated(raw)) {
    const tab = record.indexOf('\t')
    const path = record.slice(tab + 1)
    if (!paths.has(path)) continue
    const [mode, second, third] = record.slice(0, tab).split(' ')
    const object = kind === 'tree' ? third : second
    if (tab < 0 || !/^(100644|100755|120000)$/.test(mode) || !OID_PATTERN.test(object) ||
        (kind === 'tree' ? second !== 'blob' : third !== '0') || entries.has(path)) {
      throw new Error(`无法核验待验收文件的 Git 条目：${JSON.stringify(path)}`)
    }
    entries.set(path, `${mode} ${object}`)
  }
  return entries
}

function reviewEntryPath(path: string, prefix: string): boolean {
  return isProjectPath(path, prefix) && path.split('/').every(part =>
    !!part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git' && !part.includes('\0'))
}

function selectReviewPaths(available: readonly string[], files: readonly string[]): string[] {
  if (!files.length) throw new Error('请选择至少一个要交付的改动文件。')
  const known = new Set(available)
  const selected = new Set(files)
  if (selected.size !== files.length || files.some(path => !known.has(path))) {
    throw new Error('交付清单必须包含实际有改动的文件路径，且不能有重复路径。')
  }
  return available.filter(path => selected.has(path))
}

function validateReview(review: FrozenReview, expected: ExpectedReview, prefix: string) {
  const files = new Set(expected.files)
  if (review.version !== 1 || !files.size || files.size !== expected.files.length ||
      new Set(review.entries.map(entry => entry.path)).size !== files.size || review.entries.length !== files.size ||
      review.entries.some(entry => !reviewEntryPath(entry.path, prefix) || !files.has(toProjectPath(entry.path, prefix)))) {
    throw new StaleReviewError()
  }
}

class StaleReviewError extends Error {
  constructor(path?: string) {
    super(path === undefined ? '无法核验此前的待验收记录，请重新标记待验收。' :
      `待验收文件已变化：${JSON.stringify(path)}。请重新标记待验收。`)
  }
}

async function readReviewFile(path: string) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await fd.stat()
    if (!info.isFile()) throw new Error(`待验收路径不是普通文件：${JSON.stringify(path)}`)
    return { bytes: await fd.readFile(), mode: (info.mode & 0o100) ? '100755' : '100644' }
  } finally { await fd.close() }
}

async function reviewWorkingEntry(root: string, path: string): Promise<{ bytes: Buffer; mode: string } | null> {
  const parts = path.split('/')
  let current = root
  for (let i = 0; i < parts.length; i++) {
    const parent = current
    current = join(parent, parts[i])
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    if (!info) return null
    // Git paths are exact; do not accept a differently spelled file through a
    // case-insensitive or Unicode-normalizing filesystem lookup.
    if (!(await readdir(parent)).includes(parts[i])) throw new StaleReviewError(path)
    if (i < parts.length - 1) {
      if (!info.isDirectory()) return null
      continue
    }
    if (info.isDirectory()) return null
    if (!info.isFile() && !info.isSymbolicLink()) throw new StaleReviewError(path)
    return info.isSymbolicLink() ? { bytes: await readlink(current, { encoding: 'buffer' }), mode: '120000' } : readReviewFile(current)
  }
  throw new StaleReviewError(path)
}

function gitBlobOid(bytes: Buffer, oidLength: number): string {
  return createHash(oidLength === 64 ? 'sha256' : 'sha1')
    .update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

async function verifyReview(root: string, review: FrozenReview, objectEnv?: NodeJS.ProcessEnv, write = false) {
  const paths = new Set(review.entries.map(entry => entry.path))
  const index = entryMap((await runGit(root, ['ls-files', '--stage', '-z'])).stdout, 'index', paths)
  for (const entry of review.entries) {
    if ((index.get(entry.path) ?? null) !== entry.index) throw new StaleReviewError(entry.path)
    const file = await reviewWorkingEntry(root, entry.path)
    if (!file && entry.working === null) continue
    if (!file || !entry.working) throw new StaleReviewError(entry.path)
    const [, oid] = entry.working.split(' ')
    const object = gitBlobOid(file.bytes, oid.length)
    if (`${file.mode} ${object}` !== entry.working) throw new StaleReviewError(entry.path)
    if (write) {
      const written = stdoutText(await runGit(root, ['hash-object', '-w', '--stdin'], { input: file.bytes, env: objectEnv }))
      if (written !== object) throw new StaleReviewError(entry.path)
    }
  }
}

async function reviewedTree(root: string, indexPath: string, baseOid: string, review: FrozenReview,
  objectDirectory?: string, sourceObjects?: string): Promise<string> {
  const env = {
    ...(objectDirectory && sourceObjects ? gitObjectEnvironment(objectDirectory, sourceObjects) : {}),
    GIT_INDEX_FILE: indexPath,
  }
  const zero = '0'.repeat(baseOid.length)
  // Remove first so reviewed file <-> directory replacements are explicit and
  // cannot implicitly replace entries from the recorded base outside the review.
  const removals = review.entries.map(entry => `0 ${zero}\t${entry.path}\0`)
  const updates = review.entries.flatMap(entry => entry.working === null ? [] : [`${entry.working}\t${entry.path}\0`])
  await runGit(root, ['read-tree', baseOid], { env })
  await runGit(root, ['update-index', '-z', '--index-info'], { env, input: [...removals, ...updates].join('') })
  const tree = stdoutText(await runGit(root, ['write-tree'], { env }))
  const actual = new Set(await changedTreePaths(root, baseOid, tree, objectDirectory ?? null, sourceObjects ?? null))
  if (actual.size !== review.entries.length || review.entries.some(entry => !actual.has(entry.path))) {
    throw new Error('无法将预览限制在待验收文件内；Local 未写入。')
  }
  return tree
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
  isolatedTreeOid: string,
  checkoutPath: string,
  projectPathPrefix: string,
  reviewedPaths: ReadonlySet<string>,
  committedOnly = false,
): Promise<MergeResult> {
  const localCommit = await createSnapshotCommit(
    checkoutPath,
    committedOnly ? local.headTreeOid : local.treeOid,
    baseOid,
    objectDirectory,
    sourceObjects,
    'Local snapshot',
  )
  const isolatedCommit = await createSnapshotCommit(
    checkoutPath,
    isolatedTreeOid,
    baseOid,
    objectDirectory,
    sourceObjects,
    'Reviewed Isolated snapshot',
  )
  const mergePath = join(tempRoot, committedOnly ? 'committed merge checkout' : 'merge checkout')
  const hooksPath = join(tempRoot, 'disabled hooks')
  await mkdir(mergePath, { recursive: true })
  await mkdir(hooksPath, { recursive: true })
  await initMergeCheckout(mergePath, checkoutPath, hooksPath)

  const mergeEnv: NodeJS.ProcessEnv = {
    GIT_ALTERNATE_OBJECT_DIRECTORIES: [objectDirectory, sourceObjects].map(gitAlternate).join(delimiter),
  }
  await runGit(mergePath, ['checkout', '--detach', localCommit], { env: mergeEnv })
  const merge = await runGit(mergePath, ['-c', 'merge.renames=false', '-c', 'merge.directoryRenames=false', 'merge', '--no-commit', '--no-ff', isolatedCommit], {
    env: mergeEnv,
    allowedExitCodes: [0, 1],
  })

  if (merge.exitCode === 1) {
    const conflicts = await runGit(mergePath, ['diff', '--name-only', '--diff-filter=U', '-z'], { env: mergeEnv })
    const rawConflicts = parseNullSeparated(conflicts.stdout)
    const conflictingFiles = rawConflicts.filter(path => isProjectPath(path, projectPathPrefix))
      .map(path => toProjectPath(path, projectPathPrefix)).sort()
    if (conflictingFiles.length === 0) throw new GitCommandFailure(['merge'], merge)
    const result: MergeConflictResult = { status: 'conflict', conflictingFiles, rawConflicts }
    if ((committedOnly || local.headTreeOid === local.treeOid) && rawConflicts.every(path => reviewedPaths.has(path))) {
      const conflicted = new Set(rawConflicts)
      const cleanPaths = new Set([...reviewedPaths].filter(path => !conflicted.has(path)))
      const entries = entryMap((await runGit(mergePath, ['ls-files', '--stage', '-z'], { env: mergeEnv })).stdout, 'index', cleanPaths)
      const upstream = entryMap((await runGit(mergePath, ['ls-tree', '-rz', local.headTreeOid], { env: mergeEnv })).stdout, 'tree', cleanPaths)
      result.cleanEntries = [...cleanPaths].filter(path => entries.get(path) !== upstream.get(path))
        .map(path => ({ path, entry: entries.get(path) ?? null }))
    }
    return result
  }
  // This second merge is diagnostic only; don't create a patch using the dirty tree.
  if (committedOnly) return { status: 'ready', changedFiles: [], patch: Buffer.alloc(0), mergedTreeOid: local.headTreeOid }

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
  const changedPaths = parseNullSeparated(changed.stdout)
  if (changedPaths.some(path => !reviewedPaths.has(path))) {
    throw new Error('合并结果包含待验收清单之外的文件；Local 未写入。')
  }
  const changedFiles = changedPaths.map(path => toProjectPath(path, projectPathPrefix)).sort()
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
    ['-c', 'i18n.commitEncoding=UTF-8', 'commit-tree', treeOid, '-p', parentOid],
    { input: `${commitMessage}\n` },
  ))
}

async function receiptPaths(root: string, project: string, receipt: PreviewReceipt): Promise<string[]> {
  const prefix = projectPrefix(root, project)
  const paths = await changedTreePaths(root, receipt.localWorkingTreeOid, receipt.previewWorkingTreeOid, null, null)
  const recorded = new Set(receipt.changedFiles)
  if (prefix === null || paths.length !== recorded.size || paths.some(path =>
    !reviewEntryPath(path, prefix) || !recorded.has(toProjectPath(path, prefix)))) {
    throw new Error('预览记录中的文件清单与快照不一致；保留现场。')
  }
  return paths
}

function pathsOverlap(a: string, b: string): boolean {
  const key = (path: string) => path.normalize('NFC').toLowerCase()
  const x = key(a), y = key(b)
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)
}

async function checkWorkingScope(root: string, actual: string, expected: string, paths: string[],
  objectDirectory: string | null, sourceObjects: string | null): Promise<ApplyError | undefined> {
  const changed = (await changedTreePaths(root, expected, actual, objectDirectory, sourceObjects))
    .find(path => paths.some(task => pathsOverlap(path, task)))
  if (changed !== undefined) {
    return { code: 'preview_modified', message: `Local 的预览路径自预览后已变化：${JSON.stringify(changed)}；保留现场。` }
  }
  // Git's view can omit ignored replacements or normalize an aliased name.
  const entries = entryMap((await runGit(root, ['ls-tree', '-rz', expected])).stdout, 'tree', new Set(paths))
  for (const path of paths) {
    const wanted = entries.get(path)
    let matches = false
    try {
      if (wanted) {
        const file = await reviewWorkingEntry(root, path)
        matches = file !== null && `${file.mode} ${gitBlobOid(file.bytes, expected.length)}` === wanted
      } else {
        matches = await matchesAbsentPath(root, path, entries)
      }
    } catch (error) {
      if (!(error instanceof StaleReviewError)) throw error
    }
    if (!matches) {
      return { code: 'preview_modified', message: `Local 的预览路径自预览后已变化：${JSON.stringify(path)}；保留现场。` }
    }
  }
}

async function matchesAbsentPath(root: string, path: string, entries: ReadonlyMap<string, string>): Promise<boolean> {
  const statAt = (name: string) => lstat(join(root, name)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  const matchesDirectory = async (name: string): Promise<boolean> => {
    const items = await readdir(join(root, name), { withFileTypes: true })
    if (!items.length) return false
    for (const item of items) {
      const child = `${name}/${item.name}`
      if (item.isDirectory() ? !await matchesDirectory(child) : !entries.has(child)) return false
    }
    return true
  }
  let parent = ''
  for (const part of path.split('/')) {
    const name = parent ? `${parent}/${part}` : part
    const stat = await statAt(name)
    if (!stat) return true
    if (!(await readdir(join(root, parent))).includes(part)) return false
    if (!stat.isDirectory()) return name !== path && entries.has(name)
    parent = name
  }
  // A file-to-directory replacement may contain reviewed descendants, but no
  // ignored or empty obstructions that Git's snapshot would omit.
  return matchesDirectory(path)
}

function matchesReceiptIndex(current: CheckoutSnapshot, receipt: PreviewReceipt): boolean {
  // Legacy receipts already bind the exact index entries and both tree IDs.
  // Reconstruct those hashes without using today's unrelated worktree content.
  const fingerprint = (tree: string) => snapshotFingerprint(current.headOid, current.headRef, current.indexEntries, tree)
  return current.headOid === receipt.localHeadOid && current.headRef === receipt.localHeadRef &&
    current.indexTreeOid === receipt.localIndexTreeOid &&
    fingerprint(receipt.localWorkingTreeOid) === receipt.localFingerprintBefore &&
    fingerprint(receipt.previewWorkingTreeOid) === receipt.localFingerprintPreview
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
    commitRequired: receipt.changedFiles.length > 0 && taskTree.treeOid !== current.headTreeOid,
  }
}

async function resolveIndexPath(checkoutPath: string): Promise<string> {
  return resolve(checkoutPath, stdoutText(await runGit(
    checkoutPath,
    ['rev-parse', '--path-format=absolute', '--git-path', 'index'],
  )))
}

// Git can represent the empty index by not having an index file at all.
// Do not confuse absence with zero bytes or a dangling symlink.
async function readIndexBytes(path: string): Promise<Buffer | null> {
  let handle: Awaited<ReturnType<typeof open>>
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Local 的 Git 索引不是普通文件。')
    return await handle.readFile()
  } finally { await handle.close() }
}

function sameIndexBytes(a: Buffer | null, b: Buffer | null): boolean {
  return a === null || b === null ? a === b : a.equals(b)
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

// Check the real filesystem, not just Git's visible snapshot. In particular
// git apply --check accepts replacing some nonempty directories with a file.
async function checkPreviewPatch(root: string, patch: Buffer, changedPaths: string[],
  beforeTreeOid: string, afterTreeOid: string, env?: NodeJS.ProcessEnv) {
  const paths = new Set(changedPaths)
  const [before, after] = await Promise.all([beforeTreeOid, afterTreeOid].map(async tree =>
    entryMap((await runGit(root, ['ls-tree', '-rz', tree], { env })).stdout, 'tree', paths)))
  const stop = (path: string): never => { throw new Error(`Local 路径与预览改动冲突，Local 未写入：${JSON.stringify(path)}`) }
  const statAt = (path: string) => lstat(join(root, path)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err
    return undefined
  })
  const checkDirectory = async (path: string) => {
    const contents = await readdir(join(root, path), { withFileTypes: true })
    if (!contents.length) stop(path)
    for (const child of contents) {
      const name = `${path}/${child.name}`
      if (child.isDirectory()) await checkDirectory(name)
      else if (!before.has(name) || after.has(name)) stop(name)
    }
  }
  for (const path of changedPaths) {
    const parts = path.split('/')
    let parent = ''
    for (let i = 0; i < parts.length; i++) {
      const name = parent ? `${parent}/${parts[i]}` : parts[i]
      const st = await statAt(name)
      if (!st) break
      if (!(await readdir(join(root, parent))).includes(parts[i])) stop(name)
      if (i < parts.length - 1) {
        if (!st.isDirectory()) {
          if (!before.has(name) || after.has(name)) stop(name)
          break
        }
      } else if (!before.has(path) && after.has(path)) {
        if (!st.isDirectory()) stop(path)
        await checkDirectory(path)
      }
      parent = name
    }
  }
  // An ignored task addition would be invisible to the post-write fingerprint.
  const additions = [...after.keys()].filter(path => !before.has(path))
  if (additions.length) {
    const ignored = await runGit(root, ['check-ignore', '-z', '--stdin'], {
      input: additions.join('\0') + '\0', allowedExitCodes: [0, 1],
    })
    if (ignored.stdout.length) stop(parseNullSeparated(ignored.stdout)[0])
  }
  await runGit(root, ['apply', '--check', '-p1', '--binary', '--whitespace=nowarn'], { input: patch })
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

  inspectReview(input: ApplyPlanInput, files?: readonly string[]): Promise<InspectReviewResult> {
    return this.captureReview(input, files)
  }

  async restrictReview(input: ApplyPlanInput, expected: ExpectedReview, files: readonly string[]): Promise<FrozenReview> {
    const selected = new Set(selectReviewPaths(expected.files, files))
    const root = await resolveGitRoot(input.isolatedPath)
    const prefix = projectPrefix(root, input.isolatedPath)
    if (prefix === null) throw new StaleReviewError()
    let review = expected.snapshot
    if (!review) {
      const inspected = await this.captureReview(input, undefined, expected)
      if (inspected.status === 'error') throw new Error(inspected.error.message)
      review = inspected.snapshot
    }
    validateReview(review, expected, prefix)
    const narrowed: FrozenReview = {
      version: 1, entries: review.entries.filter(entry => selected.has(toProjectPath(entry.path, prefix))),
    }
    const temp = await mkdtemp(join(tmpdir(), 'pi-wtp-review-scope-'))
    try {
      const objects = join(temp, 'objects')
      await mkdir(objects)
      const source = await sourceObjectDirectory(root)
      await verifyReview(root, narrowed, gitObjectEnvironment(objects, source), true)
      // A file/directory replacement may require more than one listed path.
      await reviewedTree(root, join(temp, 'review.index'), input.baseOid, narrowed, objects, source)
      return narrowed
    } finally { await this.cleanup(temp) }
  }

  private async captureReview(input: ApplyPlanInput, files?: readonly string[], legacy?: ExpectedReview): Promise<InspectReviewResult> {
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
      const allChanged = legacy
        ? legacy.files.map(path => localPrefix ? `${localPrefix}/${path}` : path)
        : await changedTreePaths(isolatedGitRoot, input.baseOid, isolated.treeOid, objectDirectory, localObjects)
      if (allChanged.some((path) => !isProjectPath(path, localPrefix))) {
        return { status: 'error', error: { code: 'invalid_input', message: hostMessage('isolatedContainsChangesOutsideTheProjectRootAReview') } }
      }
      if (allChanged.some(path => !reviewEntryPath(path, localPrefix))) throw new Error('待验收文件包含无效 Git 路径。')
      const changedFiles = files ? selectReviewPaths(allChanged, files.map(path => localPrefix ? `${localPrefix}/${path}` : path)) : allChanged
      const paths = new Set(changedFiles)
      const partial = changedFiles.length !== allChanged.length || (!!files && (await Promise.all(
        [...new Set([isolated.indexTreeOid, isolated.headTreeOid])].filter(tree => tree !== isolated.treeOid)
          .map(tree => changedTreePaths(isolatedGitRoot, input.baseOid, tree, objectDirectory, localObjects)),
      )).some(delta => delta.some(path => !paths.has(path))))
      const working = entryMap((await runGit(isolatedGitRoot, ['ls-tree', '-rz', isolated.treeOid], {
        env: gitObjectEnvironment(objectDirectory, localObjects),
      })).stdout, 'tree', paths)
      const index = entryMap(isolated.indexEntries, 'index', paths)
      const snapshot: FrozenReview = {
        version: 1,
        entries: changedFiles.map(path => ({ path, working: working.get(path) ?? null, index: index.get(path) ?? null })),
      }
      if (partial) {
        await reviewedTree(isolatedGitRoot, join(tempRoot, 'selected-review.index'), input.baseOid, snapshot, objectDirectory, localObjects)
      }
      if (legacy) {
        // Prove that the reconstructed tree plus the exact old HEAD and index
        // hash to the existing receipt. Later *unstaged* unrelated paths can
        // be ignored even for an old review; anything unprovable needs re-review.
        const projected = await reviewedTree(localGitRoot, join(tempRoot, 'legacy-review.index'), input.baseOid, snapshot,
          objectDirectory, localObjects).catch(() => { throw new StaleReviewError() })
        if (snapshotFingerprint(isolated.headOid, isolated.headRef, isolated.indexEntries, projected) !== legacy.fingerprint) {
          throw new StaleReviewError()
        }
      }
      return {
        status: 'ready',
        isolatedFingerprint: legacy?.fingerprint ?? isolated.fingerprint,
        isolatedHeadOid: isolated.headOid, isolatedHeadRef: isolated.headRef,
        isolatedTreeOid: isolated.treeOid, isolatedIndexTreeOid: isolated.indexTreeOid,
        changedFiles: changedFiles.map((path) => toProjectPath(path, localPrefix)).sort(),
        snapshot, partial,
      }
    } catch (error) {
      return { status: 'error', error: { code: error instanceof StaleReviewError ? 'stale_isolated' : 'git_error', message: this.errorMessage(error) } }
    } finally {
      if (tempRoot) await this.cleanup(tempRoot)
    }
  }

  async plan(input: ApplyPlanInput, expected: ExpectedReview): Promise<ApplyPlanResult> {
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

      // Legacy ready records only have the full fingerprint. Migrate in memory
      // only when that exact checkout can still be proven, never from file names alone.
      let review = expected.snapshot
      if (!review) {
        const inspected = await this.captureReview(input, undefined, expected)
        if (inspected.status === 'error') return inspected
        review = inspected.snapshot
      }
      validateReview(review, expected, localPrefix)
      const isolatedEnv = gitObjectEnvironment(objectDirectory, localObjects)
      await verifyReview(isolatedGitRoot, review, isolatedEnv, true)
      const isolatedHeadOid = stdoutText(await runGit(isolatedGitRoot, ['rev-parse', 'HEAD']))
      const isolatedTreeOid = await reviewedTree(localGitRoot, join(tempRoot, 'reviewed.index'), input.baseOid, review, objectDirectory, localObjects)
      const local = await this.captureSnapshot(
        localGitRoot,
        join(tempRoot, 'local.index'),
        objectDirectory,
        localObjects,
      )
      const reviewedPaths = new Set(review.entries.map(entry => entry.path))
      const merge = await computeMerge(
        tempRoot, localObjects, objectDirectory, input.baseOid, local, isolatedTreeOid, localGitRoot, localPrefix, reviewedPaths,
      )
      const revision = randomUUID()
      if (merge.status === 'conflict') {
        const committed = local.headOid !== input.baseOid && local.headTreeOid !== local.treeOid
          ? await computeMerge(tempRoot, localObjects, objectDirectory, input.baseOid, local, isolatedTreeOid, localGitRoot, localPrefix, reviewedPaths, true)
          : undefined
        const committedConflictingFiles = local.headOid === input.baseOid ? []
          : !committed ? merge.conflictingFiles : committed.status === 'conflict' ? committed.conflictingFiles : []
        // On a clean Local tree the first merge is already the committed-only result.
        // Reuse its staged entries rather than attributing that conflict to dirty files.
        const recovery = committed ?? (local.headOid === input.baseOid ? undefined : merge)
        const dirtyPaths = local.headTreeOid === local.indexTreeOid && local.indexTreeOid === local.treeOid ? [] : [
          ...await changedTreePaths(localGitRoot, local.headTreeOid, local.indexTreeOid, objectDirectory, localObjects),
          ...await changedTreePaths(localGitRoot, local.indexTreeOid, local.treeOid, objectDirectory, localObjects),
        ]
        const dirtyConflict = merge.conflictingFiles.some(path => !committedConflictingFiles.includes(path)) ||
          dirtyPaths.some(path => merge.rawConflicts?.some(conflict =>
            path === conflict || path.startsWith(`${conflict}/`) || conflict.startsWith(`${path}/`)))
        return {
          status: 'conflict',
          revision,
          localFingerprint: local.fingerprint,
          isolatedFingerprint: expected.fingerprint,
          effectiveBaseOid: input.baseOid,
          baseStrategy: 'recorded_base',
          localHeadOid: local.headOid,
          localHeadRef: local.headRef,
          isolatedHeadOid,
          conflictingFiles: merge.conflictingFiles,
          committedConflictingFiles,
          dirtyConflict,
          reviewedTreeOid: isolatedTreeOid,
          cleanEntries: recovery?.status === 'conflict' ? recovery.cleanEntries : undefined,
        }
      }

      const plan: ApplyPlan = {
        revision,
        localFingerprint: local.fingerprint,
        isolatedFingerprint: expected.fingerprint,
        effectiveBaseOid: input.baseOid,
        baseStrategy: 'recorded_base',
        localHeadOid: local.headOid,
        localHeadRef: local.headRef,
        isolatedHeadOid,
        changedFiles: merge.changedFiles,
      }
      this.plans.set(revision, {
        input: { ...input },
        patch: merge.patch,
        plan: { ...plan, changedFiles: [...plan.changedFiles] },
        scope: { isolatedGitRoot, localGitRoot, projectPrefix: localPrefix, sourceObjects: localObjects },
        review,
      })
      return { status: 'ready', plan: { ...plan, changedFiles: [...plan.changedFiles] } }
    } catch (error) {
      return { status: 'error', error: { code: error instanceof StaleReviewError ? 'stale_isolated' : 'git_error', message: this.errorMessage(error) } }
    } finally {
      if (tempRoot) await this.cleanup(tempRoot)
    }
  }

  private async prepareWrite(stored: StoredPlan, identity: PreviewIdentity, tempRoot: string): Promise<PreviewReceipt | ApplyErrorResult> {
    if (!identity.previewId.trim() || !identity.reviewId.trim() || !Number.isSafeInteger(identity.iteration) || identity.iteration < 1) {
      return { status: 'error', error: { code: 'invalid_input', message: hostMessage('invalidPreviewIdentity') } }
    }
    const { localGitRoot, isolatedGitRoot, sourceObjects } = stored.scope
    if (!pathsMatch(await sourceObjectDirectory(localGitRoot), sourceObjects)) {
      return { status: 'error', error: { code: 'invalid_plan', message: hostMessage('thePreviewPlanSGitRepositoryIdentityHasChanged') } }
    }
    const local = await this.captureSnapshot(localGitRoot, join(tempRoot, 'persistent-local.index'), null, null)
    if (local.fingerprint !== stored.plan.localFingerprint) {
      return { status: 'error', error: { code: 'stale_local', message: hostMessage('localChangedAfterPlanningRecalculateThePlan') } }
    }
    if (!stored.patch.length) {
      return { status: 'error', error: { code: 'operation_not_allowed', message: '本次任务没有可写入 Local 的新改动。' } }
    }
    await verifyReview(isolatedGitRoot, stored.review, undefined, true)
    const paths = this.writePaths(stored)
    // These files can change the visibility or representation of unrelated paths.
    const metadata = paths.find(path => ['.gitignore', '.gitattributes'].includes(path.split('/').at(-1)?.toLowerCase() ?? ''))
    if (metadata) {
      return { status: 'error', error: { code: 'operation_not_allowed', message: `暂不支持交付影响 Git 快照规则的改动：${JSON.stringify(metadata)}；Local 未写入。` } }
    }
    const previewWorkingTreeOid = await prepareIndexFromPatch(localGitRoot, join(tempRoot, 'planned-working.index'), local.treeOid, stored.patch)
    await checkPreviewPatch(localGitRoot, stored.patch, paths, local.treeOid, previewWorkingTreeOid)
    const isolatedTreeOid = await reviewedTree(localGitRoot, join(tempRoot, 'persistent-reviewed.index'), stored.input.baseOid, stored.review)
    const isolatedSnapshotOid = await createSnapshotCommit(localGitRoot, isolatedTreeOid, stored.plan.effectiveBaseOid, null, null, 'Reviewed Isolated snapshot')
    return {
      previewId: identity.previewId, reviewId: identity.reviewId, iteration: identity.iteration,
      previewedAt: Date.now(), configuredBaseOid: stored.input.baseOid,
      effectiveBaseOid: stored.plan.effectiveBaseOid, baseStrategy: stored.plan.baseStrategy,
      localHeadOid: local.headOid, localHeadRef: local.headRef,
      localFingerprintBefore: local.fingerprint,
      localFingerprintPreview: snapshotFingerprint(local.headOid, local.headRef, local.indexEntries, previewWorkingTreeOid),
      localWorkingTreeOid: local.treeOid, localIndexTreeOid: local.indexTreeOid, previewWorkingTreeOid,
      isolatedHeadOid: stored.plan.isolatedHeadOid, isolatedFingerprint: stored.plan.isolatedFingerprint,
      isolatedSnapshotOid, changedFiles: [...stored.plan.changedFiles],
    }
  }

  private writePaths(stored: StoredPlan): string[] {
    const prefix = stored.scope.projectPrefix
    return stored.plan.changedFiles.map(path => prefix ? `${prefix}/${path}` : path)
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
    let tempRoot: string | null = null
    let localWriteStarted = false
    try {
      tempRoot = await mkdtemp(join(tmpdir(), 'pi-wtp-preview-'))
      const preparedReceipt = await this.prepareWrite(stored, options, tempRoot)
      if ('status' in preparedReceipt) return preparedReceipt
      const { previewWorkingTreeOid, localWorkingTreeOid, localFingerprintPreview } = preparedReceipt
      const repoPaths = this.writePaths(stored)
      const objectDirectory = join(tempRoot, 'objects')
      await mkdir(objectDirectory, { recursive: true })
      const sourceObjects = stored.scope.sourceObjects
      await options.beforeWrite?.(preparedReceipt)
      await this.options.beforeFinalLocalValidation?.()
      await verifyReview(stored.scope.isolatedGitRoot, stored.review)
      const finalLocal = await this.captureSnapshot(
        stored.scope.localGitRoot,
        join(tempRoot, 'final-local.index'),
        objectDirectory,
        sourceObjects,
      )
      if (finalLocal.headOid !== stored.plan.localHeadOid || finalLocal.fingerprint !== stored.plan.localFingerprint) {
        return { status: 'error', error: { code: 'stale_local', message: hostMessage('localChangedBeforePreviewWroteItsChangesRecalculateThe') } }
      }
      await checkPreviewPatch(stored.scope.localGitRoot, stored.patch, repoPaths, localWorkingTreeOid, previewWorkingTreeOid)
      localWriteStarted = true
      await runGit(stored.scope.localGitRoot, ['apply', '-p1', '--binary', '--whitespace=nowarn'], { input: stored.patch })
      await syncPatchedPaths(stored.scope.localGitRoot, repoPaths)
      await this.options.afterLocalWriteBeforeVerification?.()
      const previewedLocal = await this.captureSnapshot(
        stored.scope.localGitRoot,
        join(tempRoot, 'previewed-local.index'),
        null,
        null,
      )
      if (previewedLocal.fingerprint !== localFingerprintPreview) {
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
      if (error instanceof StaleReviewError && !localWriteStarted) {
        return { status: 'error', error: { code: 'stale_isolated', message: error.message } }
      }
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
      const receipt = input.receipt
      if (!matchesReceiptIndex(current, receipt)) {
        return { status: 'error', error: { code: 'stale_local', message: 'Local 自预览后已变化（分支、HEAD 或索引）；停止撤回，保留现场。' } }
      }
      const paths = await receiptPaths(localGitRoot, input.localPath, receipt)
      const checkScope = (actual: string, expected: string, objects: string | null, alternates: string | null) =>
        checkWorkingScope(localGitRoot, actual, expected, paths, objects, alternates)
      const initialError = await checkScope(current.treeOid, receipt.previewWorkingTreeOid, objectDirectory, sourceObjects)
      if (initialError) return { status: 'error', error: initialError }
      const rollbackPatch = await treePatch(localGitRoot, receipt.previewWorkingTreeOid, receipt.localWorkingTreeOid, objectDirectory, sourceObjects)
      const checkPatch = () => checkPreviewPatch(localGitRoot, rollbackPatch, paths, receipt.previewWorkingTreeOid, receipt.localWorkingTreeOid)
      if (rollbackPatch.length) await checkPatch()
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
      if (!matchesReceiptIndex(finalLocal, receipt)) {
        return { status: 'error', error: { code: 'stale_local', message: hostMessage('localChangedBeforePreviewRollbackRetry') } }
      }
      const finalError = await checkScope(finalLocal.treeOid, receipt.previewWorkingTreeOid, objectDirectory, sourceObjects)
      if (finalError) return { status: 'error', error: finalError }
      if (rollbackPatch.length > 0) {
        await checkPatch()
        await runGit(localGitRoot, ['apply', '-p1', '--binary', '--whitespace=nowarn'], { input: rollbackPatch })
        await syncPatchedPaths(localGitRoot, paths)
      }
      try {
        await this.options.afterLocalWriteBeforeVerification?.()
        const rolledBack = await this.captureSnapshot(
          localGitRoot,
          join(tempRoot, 'rolled-back.index'),
          objectDirectory,
          sourceObjects,
        )
        const scopeError = await checkScope(rolledBack.treeOid, receipt.localWorkingTreeOid, objectDirectory, sourceObjects)
        if (!matchesReceiptIndex(rolledBack, receipt) || scopeError) {
          throw new Error(scopeError?.message ?? hostMessage('theLocalSnapshotAfterPreviewRollbackDoesNotMatch'))
        }
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
      return { status: 'preview_rolled_back', changedFiles: [...input.receipt.changedFiles] }
    } catch (error) {
      return { status: 'error', error: { code: 'git_error', message: this.errorMessage(error) } }
    } finally {
      if (tempRoot) await this.cleanup(tempRoot)
    }
  }

  async commitReady(plan: ApplyPlan, options: DirectCommitOptions): Promise<FinishResult> {
    const stored = this.plans.get(plan.revision)
    if (!stored || !planMatches(stored.plan, plan)) {
      return { status: 'error', error: { code: 'invalid_plan', message: '直接提交的计划已变化，Local 未写入。' } }
    }
    this.plans.delete(plan.revision)
    let tempRoot: string | null = null
    try {
      tempRoot = await mkdtemp(join(tmpdir(), 'pi-wtp-direct-plan-'))
      const receipt = await this.prepareWrite(stored, options, tempRoot)
      if ('status' in receipt) return receipt
      return await this.writeCommit({
        localPath: stored.input.localPath, receipt, commitMessage: options.commitMessage,
      }, { stored, beforeWrite: options.beforeWrite })
    } catch (error) {
      return { status: 'error', error: { code: error instanceof StaleReviewError ? 'stale_isolated' : 'git_error', message: this.errorMessage(error) } }
    } finally {
      if (tempRoot) await this.cleanup(tempRoot)
    }
  }

  async finalize(input: FinalizeInput): Promise<FinishResult> {
    return this.writeCommit(input)
  }

  private async writeCommit(input: FinalizeInput, delivery?: {
    stored: StoredPlan; beforeWrite: DirectCommitOptions['beforeWrite']
  }): Promise<FinishResult> {
    const direct = delivery?.stored
    const commitMessage = input.commitMessage.trim()
    if (!isValidCommitMessage(commitMessage)) {
      return { status: 'error', error: { code: 'invalid_input', message: hostMessage('theCommitMessageMustBeNonemptyAndContainNoNul') } }
    }

    let tempRoot: string | null = null
    let ownedIndexLock: string | null = null
    let backupIndex: string | null = null
    let preserveBackup = false
    let directJournalRecorded = false
    let directWriteStarted = false
    try {
      tempRoot = await mkdtemp(join(tmpdir(), 'pi-wtp-commit-'))
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
      const receipt = input.receipt
      if (!matchesReceiptIndex(current, receipt) || (direct && current.fingerprint !== receipt.localFingerprintBefore)) {
        return { status: 'error', error: { code: 'stale_local', message: direct ? 'Local 在准备直接提交时已变化，未写入。' : 'Local 自预览后已变化（分支、HEAD 或索引）；停止提交，保留现场。' } }
      }
      const paths = await receiptPaths(localGitRoot, input.localPath, receipt)
      const checkScope = (actual: string) =>
        checkWorkingScope(localGitRoot, actual, receipt.previewWorkingTreeOid, paths, objectDirectory, sourceObjects)
      if (direct) {
        if (!pathsMatch(sourceObjects, direct.scope.sourceObjects) || localGitRoot !== direct.scope.localGitRoot) {
          return { status: 'error', error: { code: 'invalid_plan', message: 'Local 仓库身份已变化，未写入。' } }
        }
        // Never silently absorb a staged or working edit on a reviewed path,
        // including a dirty hunk Git dropped because it already matches the task.
        const dirty = (await Promise.all([current.indexTreeOid, current.treeOid].map(tree =>
          changedTreePaths(localGitRoot, current.headTreeOid, tree, objectDirectory, sourceObjects)))).flat()
        const overlapping = dirty.find(path => direct.review.entries.some(entry => pathsOverlap(path, entry.path)))
        if (overlapping !== undefined) return { status: 'error', error: { code: 'commit_isolation_conflict',
          message: `Local 原有改动与交付清单重叠：${JSON.stringify(overlapping)}。不能直接提交；请先处理 Local 改动，或使用预览检查。` } }
      } else {
        const initialError = await checkScope(current.treeOid)
        if (initialError) return { status: 'error', error: initialError }
      }
      const realIndexPath = await resolveIndexPath(localGitRoot)
      const originalIndexBytes = await readIndexBytes(realIndexPath)
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
        if (direct) return { status: 'error', error: { code: 'operation_not_allowed', message: '没有可直接提交的任务改动。' } }
        await this.options.beforeFinalLocalValidation?.()
        const finalLocal = await this.captureSnapshot(
          localGitRoot,
          join(tempRoot, 'final-empty.index'),
          objectDirectory,
          sourceObjects,
        )
        if (!matchesReceiptIndex(finalLocal, receipt)) {
          return { status: 'error', error: { code: 'stale_local', message: hostMessage('localChangedBeforeFinalizingPreviewRetry') } }
        }
        const finalError = await checkScope(finalLocal.treeOid)
        if (finalError) return { status: 'error', error: finalError }
        return {
          status: 'finished',
          changedFiles: [],
          commitOid: null,
          nextBaseOid: input.receipt.isolatedSnapshotOid,
        }
      }

      const [committedPaths, reindexedPaths] = await Promise.all([
        changedTreePaths(localGitRoot, current.headTreeOid, assessment.taskTreeOid, objectDirectory, sourceObjects),
        changedTreePaths(localGitRoot, receipt.localIndexTreeOid, assessment.finalIndexTreeOid, objectDirectory, sourceObjects),
      ])
      const taskPaths = new Set(paths)
      if ([...committedPaths, ...reindexedPaths].some(path => !taskPaths.has(path))) {
        return { status: 'error', error: { code: 'commit_isolation_conflict', message: '提交或索引结果包含预览之外的文件；Local 未提交。' } }
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
      const branchRef = current.headRef
      if (!branchRef?.startsWith('refs/heads/')) {
        return { status: 'error', error: { code: 'operation_not_allowed', message: hostMessage('localIsNotOnANormalBranchATask') } }
      }
      if (delivery) {
        await delivery.beforeWrite(receipt, commitOid, originalIndexBytes, intendedIndexBytes, assessment.finalIndexTreeOid)
        directJournalRecorded = true
      } else await input.beforeCommit?.(commitOid, originalIndexBytes, intendedIndexBytes)
      if (!direct && originalIndexBytes !== null) {
        backupIndex = `${realIndexPath}.pi-wtp-backup-${randomUUID()}`
        const backup = await open(backupIndex, 'wx', 0o600)
        try { await backup.writeFile(originalIndexBytes); await backup.sync() } finally { await backup.close() }
        await syncPath(dirname(realIndexPath))
      }
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
      if (direct) await verifyReview(direct.scope.isolatedGitRoot, direct.review)
      const finalLocal = await this.captureSnapshot(localGitRoot, join(tempRoot, 'final-local.index'), objectDirectory, sourceObjects)
      const finalIndexBytes = await readIndexBytes(realIndexPath)
      if (!matchesReceiptIndex(finalLocal, receipt) || !sameIndexBytes(finalIndexBytes, originalIndexBytes) ||
          (direct && finalLocal.fingerprint !== receipt.localFingerprintBefore)) {
        return { status: 'error', error: { code: 'stale_local', message: direct ? 'Local 在直接提交前已变化，未写入。' : hostMessage('localChangedBeforeThePreviewCommitWasWrittenRetry') } }
      }
      if (direct) {
        await checkPreviewPatch(localGitRoot, direct.patch, paths, receipt.localWorkingTreeOid, receipt.previewWorkingTreeOid)
      } else {
        const finalError = await checkScope(finalLocal.treeOid)
        if (finalError) return { status: 'error', error: finalError }
      }

      // Updating a named branch gives an OID CAS without following a different
      // checkout's HEAD. Recheck the symbolic ref after filesystem verification.
      const headRef = await runGit(localGitRoot, ['symbolic-ref', '--quiet', 'HEAD'], { allowedExitCodes: [0, 1] })
      if (headRef.exitCode !== 0 || stdoutText(headRef) !== branchRef) {
        return { status: 'error', error: { code: 'stale_local', message: hostMessage('localChangedBeforeThePreviewCommitWasWrittenRetry') } }
      }
      let refUpdated = false
      let indexReplaced = false
      let writeError: unknown = null
      try {
        if (direct) {
          directWriteStarted = true
          await runGit(localGitRoot, ['apply', '-p1', '--binary', '--whitespace=nowarn'], { input: direct.patch })
          await syncPatchedPaths(localGitRoot, paths)
          await this.options.afterDirectPatchBeforeCommit?.()
          const patched = await this.captureSnapshot(localGitRoot, join(tempRoot, 'direct-patched.index'), objectDirectory, sourceObjects)
          const scopeError = await checkScope(patched.treeOid)
          if (scopeError || !matchesReceiptIndex(patched, receipt) || !sameIndexBytes(await readIndexBytes(realIndexPath), originalIndexBytes)) {
            throw new Error(scopeError?.message ?? 'Local 在写入文件后发生变化。')
          }
          const stillOnBranch = await runGit(localGitRoot, ['symbolic-ref', '--quiet', 'HEAD'], { allowedExitCodes: [0, 1] })
          if (stillOnBranch.exitCode !== 0 || stdoutText(stillOnBranch) !== branchRef) throw new Error('Local 分支在写入文件后发生变化。')
        }
        await runGit(localGitRoot, ['update-ref', '--no-deref', branchRef, commitOid, current.headOid])
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
            objectDirectory,
            sourceObjects,
          )
          const scopeError = await checkScope(committed.treeOid)
          const committedIndexBytes = await readIndexBytes(realIndexPath)
          if (
            committed.headOid === commitOid
            && committed.headRef === branchRef
            && committed.indexTreeOid === assessment.finalIndexTreeOid
            && committed.indexEntries.equals(expectedIndexEntries)
            && !scopeError
            && sameIndexBytes(committedIndexBytes, intendedIndexBytes)
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
          writeError = new Error(scopeError?.message ?? hostMessage('previewCommitVerificationFailedAfterWriting'))
        } catch (error) {
          writeError = error
        }
      }

      // No inverse patch or ref/index compensation for direct delivery: after
      // the first file write an external editor or Git process may own a change.
      if (direct) return { status: 'error', error: { code: 'git_error', recoveryState: 'uncertain',
        message: `未能确认直接提交完成：${this.errorMessage(writeError)}；未自动撤销，保留现场。` } }

      const rollbackErrors: string[] = []
      if (refUpdated && !indexReplaced && ownedIndexLock) {
        // The ref moved but the index replacement did not. We still own index.lock, so no Git
        // index writer can race the ref CAS rollback; the real index is already the original one.
        try {
          await runGit(localGitRoot, ['update-ref', '--no-deref', branchRef, current.headOid, commitOid])
          refUpdated = false
          await unlink(ownedIndexLock)
          ownedIndexLock = null
        } catch (error) {
          rollbackErrors.push(`ref: ${this.errorMessage(error)}`)
        }
      } else if (refUpdated && indexReplaced && (backupIndex || originalIndexBytes === null)) {
        // Never restore over an index that changed after our write. If the
        // old index was absent, hold its lock while removing our new index.
        try {
          const restoreBytes = backupIndex ? await readFile(backupIndex) : null
          ownedIndexLock = await writeIndexLock(realIndexPath, restoreBytes ?? Buffer.alloc(0))
          const currentIndexBytes = await readIndexBytes(realIndexPath)
          if (!sameIndexBytes(currentIndexBytes, intendedIndexBytes)) {
            rollbackErrors.push(hostMessage('indexLocalIndexChangedAfterPreviewWroteItsChanges'))
          } else {
            await runGit(localGitRoot, ['update-ref', '--no-deref', branchRef, current.headOid, commitOid])
            refUpdated = false
            if (restoreBytes === null) {
              await unlink(realIndexPath)
            } else {
              await rename(ownedIndexLock, realIndexPath)
              ownedIndexLock = null
            }
            indexReplaced = false
            await syncPath(dirname(realIndexPath))
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
            objectDirectory,
            sourceObjects,
          )
          const scopeError = await checkScope(restoredLocal.treeOid)
          const restoredIndexBytes = await readIndexBytes(realIndexPath)
          restored = matchesReceiptIndex(restoredLocal, receipt)
            && !scopeError
            && sameIndexBytes(restoredIndexBytes, originalIndexBytes)
          if (ownedIndexLock) {
            await unlink(ownedIndexLock)
            ownedIndexLock = null
          }
        } catch (error) {
          restored = false
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
      if (direct && !directWriteStarted && error instanceof StaleReviewError) {
        return { status: 'error', error: { code: 'stale_isolated', message: error.message } }
      }
      const recoveryState = directWriteStarted ? 'uncertain' : directJournalRecorded ? 'unchanged' : undefined
      return { status: 'error', error: { code: 'git_error', recoveryState, message: this.errorMessage(error) } }
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
