import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createSessionCheckoutApplyEngine, runGit, type ApplyConflictPlanResult, type FrozenReview, type PreviewReceipt } from './engine.ts'

export interface Checkout { root: string; gitDir: string; commonDir: string; rootIdentity: string; gitIdentity: string; commonIdentity: string }
export interface SessionLink { id: string; file: string; cwd: string }
type Phase = 'creating' | 'working' | 'ready' | 'previewed' | 'delivered' | 'discarded'
interface Review { id: string; fingerprint: string; files: string[]; message: string; snapshot?: FrozenReview; partial?: true }
interface ConflictRecovery {
  localHeadOid: string
  isolatedHeadOid: string
  reviewedTreeOid: string
  conflictingFiles: string[]
  cleanEntries: { path: string; entry: string | null }[]
}
export interface Task {
  id: string
  phase: Phase
  baseOid: string
  localHeadRef: string
  local: Checkout
  isolatedPath: string
  isolated?: Checkout
  localSession: SessionLink
  isolatedSession?: SessionLink
  followUpOf?: string
  review?: Review
  recovery?: ConflictRecovery
  receipt?: PreviewReceipt
  // A null indexBefore explicitly records that no index file existed.
  journal?: { operation: 'preview' | 'rollback' | 'finalize' | 'commit_ready' | 'cleanup'; at: number; commitOid?: string; indexBefore?: string | null; indexAfter?: string }
  cleanup?: { status: 'done' | 'retained'; reason?: string; requested?: true; canForce?: true }
  commitOid?: string | null
}
interface State { version: 1; tasks: Task[] }
export type Action = 'preview' | 'rollback' | 'finalize' | 'commit_ready' | 'discard'
const oid = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const errText = (error: unknown) => error instanceof Error ? error.message : String(error)
const out = async (cwd: string, args: string[]) => (await runGit(cwd, args)).stdout.toString('utf8').replace(/\r?\n$/, '')
const fileIdentity = async (path: string) => { const s = await stat(path, { bigint: true }); return `${s.dev}:${s.ino}` }

export async function checkout(cwd: string): Promise<Checkout> {
  const root = await realpath(await out(cwd, ['rev-parse', '--show-toplevel']))
  const gitDir = await realpath(await out(root, ['rev-parse', '--absolute-git-dir']))
  const commonDir = await realpath(await out(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
  const [rootIdentity, gitIdentity, commonIdentity] = await Promise.all([fileIdentity(root), fileIdentity(gitDir), fileIdentity(commonDir)])
  return { root, gitDir, commonDir, rootIdentity, gitIdentity, commonIdentity }
}

function same(a: Checkout, b: Checkout) {
  return a.root === b.root && a.gitDir === b.gitDir && a.commonDir === b.commonDir &&
    a.rootIdentity === b.rootIdentity && a.gitIdentity === b.gitIdentity && a.commonIdentity === b.commonIdentity
}

async function syncDir(path: string) {
  if (process.platform === 'win32') throw new Error('此版本不在 Windows 上执行写操作。')
  const fd = await open(path, 'r')
  try { await fd.sync() } finally { await fd.close() }
}

async function atomicJson(path: string, data: State) {
  const tmp = `${path}.${randomUUID()}.tmp`
  const file = await open(tmp, 'wx', 0o600)
  try {
    try { await file.writeFile(JSON.stringify(data, null, 2) + '\n'); await file.sync() } finally { await file.close() }
    await rename(tmp, path)
    await syncDir(dirname(path))
  } finally { await rm(tmp, { force: true }) }
}

async function saveArtifact(path: string, bytes: Buffer) {
  const file = await open(path, 'wx', 0o600)
  try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
}

async function assertOrdinary(local: Checkout) {
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_START']) {
    try { await lstat(join(local.gitDir, name)) } catch (error) { if (missing(error)) continue; throw error }
    throw new Error(`Git 正在进行其他操作（${name}）。`)
  }
}

async function normalRef(root: string) {
  const result = await runGit(root, ['symbolic-ref', '--quiet', 'HEAD'], { allowedExitCodes: [0, 1] })
  const ref = result.stdout.toString('utf8').trim()
  if (!ref.startsWith('refs/heads/')) throw new Error('Local 必须位于普通 Git 分支。')
  return ref
}

function terminal(task: Task) { return task.phase === 'delivered' || task.phase === 'discarded' }
function sameSession(bound: SessionLink | undefined, session: SessionLink) {
  return !!bound && bound.id === session.id && bound.file === session.file && bound.cwd === session.cwd
}
function boundIsolatedSession(task: Task, session: SessionLink) {
  return sameSession(task.isolatedSession, session)
}
function assertLocalAcceptanceAvailable(state: State, task: Task, statePath: string) {
  const peers = state.tasks.filter(peer => peer.id !== task.id &&
    (peer.local.root === task.local.root || peer.local.gitDir === task.local.gitDir))
  if (peers.some(peer => peer.journal && peer.journal.operation !== 'cleanup')) {
    throw new Error(`此 Local 有未解决的写入恢复记录；已停止验收。检查 ${statePath}`)
  }
  if (peers.some(peer => peer.phase === 'previewed')) {
    throw new Error('此 Local 正在预览另一个任务；请先在原任务会话撤回或确认提交，再重试。')
  }
}
class CleanupDataLoss extends Error {}
export class PreviewConflict extends Error {
  constructor(readonly plan: ApplyConflictPlanResult) {
    const paths = plan.conflictingFiles.map(path => JSON.stringify(path)).join('、')
    super(plan.committedConflictingFiles.length ? `预览冲突，Local 未写入：${paths}` :
      `Local 未提交的改动挡住预览，Local 未写入：${paths}`)
  }
}
async function isAncestor(root: string, older: string, newer: string) {
  return (await runGit(root, ['merge-base', '--is-ancestor', older, newer], { allowedExitCodes: [0, 1] })).exitCode === 0
}
function engineError(result: { error: { message: string } }): never { throw new Error(result.error.message) }

/** A single durable registry/lock per Pi profile. No automatic lock stealing or journal replay. */
export class TaskStore {
  readonly statePath: string
  readonly lockPath: string
  private readonly worktrees: string
  constructor(readonly directory: string, private readonly engineFactory = createSessionCheckoutApplyEngine) {
    this.statePath = join(directory, 'tasks.json')
    this.lockPath = join(directory, 'mutation.lock')
    this.worktrees = join(directory, 'worktrees')
  }

  async read(): Promise<State> {
    let data: string
    try { data = await readFile(this.statePath, 'utf8') } catch (error) { if (missing(error)) return { version: 1, tasks: [] }; throw error }
    const parsed: State = JSON.parse(data)
    if (parsed.version !== 1 || !Array.isArray(parsed.tasks)) throw new Error(`不支持的工作流记录：${this.statePath}`)
    return parsed
  }

  private async locked<T>(fn: (state: State, save: () => Promise<void>) => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await syncDir(dirname(this.directory))
    try { await mkdir(this.lockPath, { mode: 0o700 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`另一个操作仍在运行，或之前中断。已停止；检查 ${this.lockPath}`)
      throw error
    }
    try {
      const note = await open(join(this.lockPath, 'owner.json'), 'wx', 0o600)
      try { await note.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); await note.sync() } finally { await note.close() }
      await syncDir(this.lockPath)
      await syncDir(this.directory)
      const state = await this.read()
      return await fn(state, () => atomicJson(this.statePath, state))
    } finally { await rm(this.lockPath, { recursive: true }); await syncDir(this.directory) }
  }

  async create(local: Checkout, localSession: SessionLink, createSession: (cwd: string, task: Task, prior?: Task) => Promise<SessionLink>, followUpOf?: string): Promise<Task> {
    return this.locked(async (state, save) => {
      if (!same(await checkout(local.root), local)) throw new Error('Local 身份已经变化。')
      if (state.tasks.some(t => sameSession(t.localSession, localSession) && (!terminal(t) || t.journal))) {
        throw new Error('此 Local 会话已有未完成的任务或恢复记录；可新开 Local 会话并行开发。')
      }
      const prior = followUpOf ? state.tasks.find(t => t.id === followUpOf) : undefined
      if (followUpOf && (!prior || !terminal(prior) || prior.journal || !same(prior.local, local) ||
          prior.isolatedSession?.cwd !== prior.isolatedPath || !prior.isolatedSession)) {
        throw new Error('原任务不可续接，或不属于同一个 Local checkout。')
      }
      await assertOrdinary(local)
      const localHeadRef = await normalRef(local.root)
      const baseOid = await out(local.root, ['rev-parse', '--verify', 'HEAD^{commit}'])
      if (!oid.test(baseOid)) throw new Error('缺少初始 Git 提交。')
      const id = randomUUID()
      const isolatedPath = join(this.worktrees, id)
      if (isolatedPath.startsWith(local.root + '/') || isolatedPath === local.root) throw new Error('Pi 数据目录不能位于当前仓库内。')
      await mkdir(this.worktrees, { recursive: true, mode: 0o700 })
      const task: Task = { id, phase: 'creating', baseOid, localHeadRef, local, isolatedPath, localSession }
      if (prior) {
        task.followUpOf = prior.id
        // Pi can fork into a logical cwd that does not exist yet. If the source
        // session is missing, fail before recording the task or creating a Worktree.
        task.isolatedSession = await createSession(isolatedPath, task, prior)
      }
      state.tasks.push(task)
      await save()
      await runGit(local.root, ['worktree', 'add', '--detach', '--', isolatedPath, baseOid])
      task.isolated = await checkout(isolatedPath)
      task.isolatedSession ??= await createSession(isolatedPath, task)
      task.phase = 'working'
      await save()
      return task
    })
  }

  async validateIsolatedIdentity(task: Task) {
    const expected = task.isolated
    if (!expected || task.isolatedPath !== join(this.worktrees, task.id) || expected.root !== task.isolatedPath ||
        expected.root === task.local.root || expected.gitDir === task.local.gitDir || expected.commonDir !== task.local.commonDir ||
        !same(await checkout(task.isolatedPath), expected)) throw new Error('隔离 Worktree 的身份已变化；保留现场。')
    return expected
  }

  async validateIsolated(task: Task) { await assertOrdinary(await this.validateIsolatedIdentity(task)) }

  async validateLocalIdentity(task: Task) {
    if (!same(await checkout(task.local.root), task.local)) throw new Error('Local checkout 的身份已变化。')
  }

  async validateLocal(task: Task) {
    await this.validateLocalIdentity(task)
    await assertOrdinary(task.local)
    if (await normalRef(task.local.root) !== task.localHeadRef) throw new Error('Local 分支已变化；保留现场。')
  }

  private input(task: Task) { return { localPath: task.local.root, isolatedPath: task.isolatedPath, baseOid: task.baseOid } }

  async beginConflictRecovery(id: string, session: SessionLink, reviewId: string, shown: ApplyConflictPlanResult): Promise<ConflictRecovery> {
    return this.locked(async (state, save) => {
      const task = state.tasks.find(t => t.id === id)
      if (!task || task.phase !== 'ready' || task.review?.id !== reviewId || task.receipt || task.journal || task.recovery ||
          !boundIsolatedSession(task, session)) throw new Error('待验收状态或隔离会话已变化，请重新预览。')
      if (task.review.partial) throw new Error('交付清单未覆盖整个 Worktree，不能自动合并冲突。')
      assertLocalAcceptanceAvailable(state, task, this.statePath)
      await this.validateLocal(task)
      await this.validateIsolated(task)
      const engine = this.engineFactory()
      const input = this.input(task)
      const current = await engine.inspectReview(input)
      if (current.status === 'error') engineError(current)
      const latest = await engine.plan(input, task.review)
      if (latest.status === 'error') engineError(latest)
      if (latest.status !== 'conflict' || latest.localFingerprint !== shown.localFingerprint || latest.dirtyConflict !== shown.dirtyConflict ||
          latest.localHeadOid !== shown.localHeadOid || latest.localHeadRef !== task.localHeadRef ||
          latest.isolatedHeadOid !== shown.isolatedHeadOid || latest.reviewedTreeOid !== shown.reviewedTreeOid ||
          JSON.stringify(latest.conflictingFiles) !== JSON.stringify(shown.conflictingFiles) ||
          JSON.stringify(latest.committedConflictingFiles) !== JSON.stringify(shown.committedConflictingFiles)) {
        throw new Error('Local 或冲突情况已变化，请重新预览。')
      }
      if (!latest.committedConflictingFiles.length || !latest.cleanEntries) throw new Error('无法安全合并这组冲突；Local 未修改。')
      const { isolatedHeadOid, localHeadOid, reviewedTreeOid, committedConflictingFiles, cleanEntries } = latest
      // Agent can checkpoint the exact reviewed tree without picking up later files or
      // flattening a staged version different from both HEAD and the reviewed content.
      const [headTree, mergeBase] = await Promise.all([
        out(task.isolatedPath, ['rev-parse', `${isolatedHeadOid}^{tree}`]),
        out(task.isolatedPath, ['merge-base', '--all', isolatedHeadOid, localHeadOid]),
      ])
      if (current.isolatedHeadRef || current.isolatedHeadOid !== isolatedHeadOid || current.isolatedTreeOid !== reviewedTreeOid ||
          (current.isolatedIndexTreeOid !== reviewedTreeOid && current.isolatedIndexTreeOid !== headTree) ||
          mergeBase !== task.baseOid || !await isAncestor(task.local.root, task.baseOid, localHeadOid)) {
        throw new Error('Worktree 有未验收的改动、独立暂存内容或不同的 Git 历史，无法安全交给 Agent 合并。')
      }
      await this.validateLocal(task)
      await this.validateIsolated(task)
      // Only detached HEAD can move during recovery. Do not give the Agent an
      // attached branch whose ref (possibly shared with Local) could change.
      const symbolic = await runGit(task.isolatedPath, ['symbolic-ref', '--quiet', 'HEAD'], { allowedExitCodes: [0, 1] })
      if (symbolic.exitCode !== 1 || await out(task.local.root, ['rev-parse', 'HEAD']) !== localHeadOid ||
          await out(task.isolatedPath, ['rev-parse', 'HEAD']) !== isolatedHeadOid) throw new Error('合并目标已变化，请重新预览。')
      const recovery: ConflictRecovery = { localHeadOid, isolatedHeadOid, reviewedTreeOid, conflictingFiles: committedConflictingFiles, cleanEntries }
      task.recovery = recovery
      delete task.review
      task.phase = 'working'
      await save()
      return recovery
    })
  }

  async reviewCandidates(task: Task): Promise<string[]> {
    await this.validateIsolated(task)
    const result = await this.engineFactory().inspectReview({ ...this.input(task), baseOid: task.recovery?.localHeadOid ?? task.baseOid })
    if (result.status === 'error') engineError(result)
    return result.changedFiles
  }

  async restrictReview(id: string, session: SessionLink, reviewId: string, files: readonly string[]): Promise<Review> {
    return this.locked(async (state, save) => {
      const task = state.tasks.find(t => t.id === id)
      if (!task || task.phase !== 'ready' || task.review?.id !== reviewId || task.journal || task.receipt || task.recovery ||
          !(boundIsolatedSession(task, session) || sameSession(task.localSession, session))) {
        throw new Error('待验收状态或绑定会话已变化，请重新选择文件。')
      }
      if (files.length >= task.review.files.length) throw new Error('这里只能缩小交付清单。')
      await this.validateIsolated(task)
      const snapshot = await this.engineFactory().restrictReview(this.input(task), task.review, files)
      const review: Review = { ...task.review, id: randomUUID(), files: [...files].sort(), snapshot, partial: true }
      task.review = review
      await save()
      return review
    })
  }

  async markReady(id: string, session: SessionLink, message: string, files: readonly string[]): Promise<Review> {
    const title = message.trim()
    if (!title || title.length > 200 || /[\x00-\x1f\x7f]/.test(title)) throw new Error('请提供 1–200 字符的单行提交说明。')
    if (!Array.isArray(files) || !files.length) throw new Error('请明确列出本次任务要交付的改动文件。')
    return this.locked(async (state, save) => {
      const task = state.tasks.find(t => t.id === id)
      if (!task || task.journal || !['working', 'ready'].includes(task.phase) || !boundIsolatedSession(task, session)) {
        throw new Error('当前不是可标记待验收的隔离会话。')
      }
      await this.validateIsolated(task)
      const recovery = task.recovery
      const baseOid = recovery?.localHeadOid ?? task.baseOid
      const inspected = await this.engineFactory().inspectReview({ ...this.input(task), baseOid }, files)
      if (inspected.status === 'error') engineError(inspected)
      if (recovery) {
        if (inspected.partial) throw new Error('合并完成后的交付清单必须包含相对合并目标的全部改动。')
        const [firstParent, mergedParent, ...others] = (await out(task.isolatedPath,
          ['show', '-s', '--format=%P', inspected.isolatedHeadOid])).split(' ')
        if (inspected.isolatedHeadRef || !oid.test(firstParent) || mergedParent !== baseOid || others.length ||
            !await isAncestor(task.isolatedPath, recovery.isolatedHeadOid, firstParent) ||
            await out(task.isolatedPath, ['rev-parse', `${firstParent}^{tree}`]) !== recovery.reviewedTreeOid ||
            await out(task.isolatedPath, ['rev-parse', 'HEAD']) !== inspected.isolatedHeadOid ||
            await out(task.isolatedPath, ['rev-parse', `${inspected.isolatedHeadOid}^{tree}`]) !== inspected.isolatedTreeOid ||
            inspected.isolatedIndexTreeOid !== inspected.isolatedTreeOid) {
          throw new Error(`请先在当前 Worktree 完成与 ${baseOid.slice(0, 12)} 的合并提交，再标记待验收。`)
        }
        const expected = new Map(recovery.cleanEntries.map(({ path, entry }) => [path, entry]))
        const conflicts = new Set(recovery.conflictingFiles)
        const actual = new Map(inspected.snapshot.entries.map(({ path, working }) => [path, working]))
        if ([...expected].some(([path, entry]) => !actual.has(path) || actual.get(path) !== entry) ||
            [...actual].some(([path]) => !conflicts.has(path) && !expected.has(path))) {
          throw new Error('合并结果改动了冲突范围外的内容；请保留 Git 自动合并的结果后再标记待验收。')
        }
        await this.validateLocal(task)
        if (!await isAncestor(task.local.root, baseOid, 'HEAD')) throw new Error('Local 已不包含合并目标，无法生成新验收。')
        task.baseOid = baseOid
        delete task.recovery
      }
      if (!inspected.changedFiles.length) throw new Error(recovery ? '合并后无需交付：任务改动已在 Local HEAD 中。可返回 Local 放弃此任务。' : '没有可验收的 Git 改动。')
      const review: Review = { id: randomUUID(), fingerprint: inspected.isolatedFingerprint, files: inspected.changedFiles,
        message: title, snapshot: inspected.snapshot, ...(inspected.partial ? { partial: true } : {}) }
      task.review = review
      task.phase = 'ready'
      await save()
      return review
    })
  }

  async continueEditing(id: string, session: SessionLink, reviewId: string, signal?: AbortSignal): Promise<void> {
    await this.locked(async (state, save) => {
      const task = state.tasks.find(t => t.id === id)
      if (!task || task.phase !== 'ready' || task.review?.id !== reviewId || task.receipt || task.journal || !boundIsolatedSession(task, session)) {
        throw new Error('待验收状态或隔离会话已变化，不能继续修改。')
      }
      await this.validateIsolated(task)
      signal?.throwIfAborted()
      delete task.review
      task.phase = 'working'
      await save()
    })
  }

  async discardFingerprint(task: Task): Promise<string> {
    await this.validateIsolated(task)
    const inspected = await this.engineFactory().inspectReview(this.input(task))
    if (inspected.status === 'error') engineError(inspected)
    return inspected.isolatedFingerprint
  }

  /** Expected tokens tie the confirmation to the state that the user actually saw. */
  async act(id: string, action: Action, expected: {
    phase: Phase; reviewId?: string; previewId?: string; discardFingerprint?: string; keepWorktree?: boolean
    revision?: { session: SessionLink; signal?: AbortSignal }
  }): Promise<Task> {
    return this.locked(async (state, save) => {
      const task = state.tasks.find(t => t.id === id)
      if (!task || task.journal || task.phase !== expected.phase || task.review?.id !== expected.reviewId || task.receipt?.previewId !== expected.previewId) {
        throw new Error(`任务状态已变化或存在恢复记录；操作已停止。${this.statePath}`)
      }
      // The register lock covers this check through the Local write and receipt.
      // Working/ready siblings and isolated-only cleanup never own this slot.
      if (action !== 'discard') assertLocalAcceptanceAvailable(state, task, this.statePath)
      await this.validateLocal(task)
      const engine = this.engineFactory()
      try {
        if (action === 'discard' && ['working', 'ready'].includes(task.phase)) {
          if (await this.discardFingerprint(task) !== expected.discardFingerprint) throw new Error('Worktree 在确认放弃期间已变化。')
          task.phase = 'discarded'
          await this.cleanup(task, expected.discardFingerprint!, save)
        } else if ((action === 'preview' || action === 'commit_ready') && task.phase === 'ready' && task.review) {
          await this.validateIsolated(task)
          const res = await engine.plan(this.input(task), task.review)
          if (res.status === 'error') engineError(res)
          const localPlan = res.status === 'conflict' ? res : res.plan
          if (localPlan.localHeadRef !== task.localHeadRef || !await isAncestor(task.local.root, task.baseOid, localPlan.localHeadOid)) {
            throw new Error('Local 分支或历史已变化；未写入 Local。')
          }
          if (res.status === 'conflict') throw new PreviewConflict(res)
          if (action === 'commit_ready') {
            const review = task.review
            const done = await engine.commitReady(res.plan, {
              previewId: randomUUID(), reviewId: review.id, iteration: 1, commitMessage: review.message,
              beforeWrite: async (receipt, commitOid, before, after, finalIndexTreeOid) => {
                await this.validateLocal(task)
                await this.validateIsolated(task)
                await this.recordCommit(task, 'commit_ready', receipt, commitOid, before, after, save, finalIndexTreeOid)
              },
            })
            if (done.status === 'error') {
              // Clear only when the engine knows it never started Local writes.
              // A failed journal/artifact write or uncertain patch keeps evidence.
              const error = done.error
              if (task.journal && (error.code === 'stale_local' || error.code === 'stale_isolated' ||
                  (error.code === 'git_error' && error.recoveryState === 'unchanged'))) {
                await this.clearDirectJournal(task, save)
              }
              engineError(done)
            }
            await this.completeCommit(task, done.commitOid, review.fingerprint, !!expected.keepWorktree, save)
            return task
          }
          const applied = await engine.preview(res.plan, {
            previewId: randomUUID(), reviewId: task.review.id, iteration: 1,
            beforeWrite: async receipt => {
              await this.validateLocal(task)
              await this.validateIsolated(task)
              task.receipt = receipt
              task.journal = { operation: 'preview', at: Date.now() }
              await save()
              await this.pin(task, [receipt.localHeadOid, receipt.localWorkingTreeOid, receipt.localIndexTreeOid, receipt.previewWorkingTreeOid, receipt.isolatedSnapshotOid, receipt.isolatedHeadOid])
            },
          })
          if (applied.status === 'error') {
            // This engine result is only emitted before any Local file/index/ref write.
            if (applied.error.code === 'stale_isolated' && task.journal) {
              delete task.journal
              delete task.receipt
              await save()
              await this.unpin(task).catch(() => {})
            }
            engineError(applied)
          }
          task.receipt = applied.receipt
          task.phase = 'previewed'
          delete task.journal
          await save()
        } else if (action === 'rollback' && task.phase === 'previewed' && task.receipt) {
          const revision = expected.revision
          if (revision) {
            if (!task.review || !boundIsolatedSession(task, revision.session)) throw new Error('待验收状态或隔离会话已变化，不能继续修改。')
            await this.validateIsolated(task)
            revision.signal?.throwIfAborted()
          }
          const rolled = await engine.rollback({ localPath: task.local.root, receipt: task.receipt, beforeWrite: async () => {
            await this.validateLocal(task)
            if (revision) {
              await this.validateIsolated(task)
              revision.signal?.throwIfAborted()
            }
            task.journal = { operation: 'rollback', at: Date.now() }
            await save()
          } })
          if (rolled.status === 'error') engineError(rolled)
          delete task.receipt
          delete task.journal
          if (revision) {
            delete task.review
            task.phase = 'working'
          } else task.phase = 'ready'
          await save()
          await this.unpin(task).catch(() => {})
        } else if (action === 'finalize' && task.phase === 'previewed' && task.receipt && task.review) {
          const done = await engine.finalize({ localPath: task.local.root, receipt: task.receipt, commitMessage: task.review.message, beforeCommit: async (commitOid, before, after) => {
            await this.validateLocal(task)
            if (expected.keepWorktree) await this.validateIsolatedIdentity(task)
            await this.recordCommit(task, 'finalize', task.receipt!, commitOid, before, after, save)
          } })
          if (done.status === 'error') engineError(done)
          await this.completeCommit(task, done.commitOid, task.receipt.isolatedFingerprint, !!expected.keepWorktree, save)
        } else throw new Error('当前阶段不允许此操作。')
      } catch (error) {
        if (error instanceof PreviewConflict) throw error
        throw new Error(task.journal ? `${errText(error)}；已停用自动操作，恢复记录：${this.statePath}` : errText(error), { cause: error })
      }
      return task
    })
  }

  private async recordCommit(task: Task, operation: 'finalize' | 'commit_ready', receipt: PreviewReceipt,
    commitOid: string, before: Buffer | null, after: Buffer, save: () => Promise<void>, finalIndexTreeOid?: string) {
    const prefix = join(this.directory, `${task.id}-${receipt.previewId}`)
    const indexBefore = before === null ? null : `${prefix}.index-before`
    const indexAfter = `${prefix}.index-after`
    if (before !== null && indexBefore !== null) await saveArtifact(indexBefore, before)
    await saveArtifact(indexAfter, after)
    if (operation === 'commit_ready') {
      task.receipt = receipt // Recovery evidence only; the task never enters previewed.
    }
    task.journal = { operation, at: Date.now(), commitOid, indexBefore, indexAfter }
    await save()
    await this.pin(task, [commitOid, ...(finalIndexTreeOid ? [finalIndexTreeOid, receipt.localHeadOid, receipt.localWorkingTreeOid,
      receipt.localIndexTreeOid, receipt.previewWorkingTreeOid, receipt.isolatedSnapshotOid, receipt.isolatedHeadOid] : [])], 'commit')
  }

  private async clearDirectJournal(task: Task, save: () => Promise<void>) {
    const { journal, receipt } = task
    delete task.receipt
    delete task.journal
    try { await save() }
    catch (error) {
      task.journal = journal
      task.receipt = receipt
      throw error
    }
    await this.deleteIndexArtifacts(journal)
    await this.unpin(task).catch(() => {})
  }

  private async deleteIndexArtifacts(journal: Task['journal']) {
    for (const file of [journal?.indexBefore, journal?.indexAfter]) {
      if (file) await rm(file, { force: true }).catch(() => {})
    }
  }

  private async completeCommit(task: Task, commitOid: string | null, fingerprint: string, keep: boolean, save: () => Promise<void>) {
    task.phase = 'delivered'
    task.commitOid = commitOid
    if (keep) task.cleanup = { status: 'retained', reason: '按用户选择保留环境。', requested: true }
    else if (task.review?.partial) task.cleanup = { status: 'retained', reason: '含未纳入交付清单的改动。', canForce: true }
    const { journal, receipt } = task
    if (journal?.operation === 'commit_ready') delete task.receipt
    delete task.journal
    // Persist delivery independently before cleanup can do anything destructive.
    try { await save() }
    catch (error) {
      task.journal = journal
      task.receipt = receipt
      throw error
    }
    await this.deleteIndexArtifacts(journal)
    if (!keep && !task.review?.partial) {
      try { await this.cleanup(task, fingerprint, save) }
      catch (error) { throw new Error(`已提交 ${commitOid}，但未能确认 Worktree 清理完成：${errText(error)}`, { cause: error }) }
    }
    await this.unpin(task).catch(() => {})
  }

  private prefix(task: Task) { return `refs/pi-worktree-preview/${task.id}` }
  private async pin(task: Task, objects: string[], key = 'snapshot') {
    const refs = objects.map((object, i) => {
      if (!oid.test(object)) throw new Error('恢复快照 OID 无效。')
      return `update ${this.prefix(task)}/${key}-${i} ${object}\n`
    }).join('')
    await runGit(task.local.root, ['-c', 'core.fsync=all', 'update-ref', '--stdin'], { input: refs })
  }
  private async unpin(task: Task) {
    await this.validateLocal(task)
    const refs = await out(task.local.root, ['for-each-ref', '--format=%(refname) %(objectname)', `${this.prefix(task)}/`])
    if (refs) await runGit(task.local.root, ['update-ref', '--stdin'], { input: refs.split('\n').map(ref => `delete ${ref}\n`).join('') })
  }

  private leaseDir(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Worktree ID 无效。')
    return join(this.directory, 'active-sessions', id)
  }

  async holdWorktree(id: string) {
    await this.locked(async state => {
      const task = state.tasks.find(item => item.id === id)
      if (!task || task.cleanup?.status === 'done' || task.journal?.operation === 'cleanup') throw new Error('Worktree 已清理或正在清理。')
      await this.validateIsolatedIdentity(task)
      const dir = this.leaseDir(id)
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const handle = await open(join(dir, String(process.pid)), 'a', 0o600)
      await handle.close()
    })
  }

  async releaseWorktree(id: string) {
    await rm(join(this.leaseDir(id), String(process.pid)), { force: true })
  }

  private async assertNoActiveSessions(id: string) {
    const entries = await readdir(this.leaseDir(id)).catch(error => { if (missing(error)) return []; throw error })
    for (const pid of entries) {
      if (!/^[1-9]\d*$/.test(pid)) throw new Error('无法确认 Worktree 的会话占用状态。')
      try { process.kill(Number(pid), 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue }
      throw new Error('另一个 Pi 会话正在使用此 Worktree，或仍有未释放的占用。')
    }
  }

  private async checkCleanupIdentity(task: Task, cwd: string) {
    for (const active of [cwd, process.cwd()]) {
      const path = await realpath(active)
      if (path === task.isolatedPath || path.startsWith(task.isolatedPath + '/')) {
        throw new Error('当前 Pi 会话或进程仍在此 Worktree 中，保留目录。')
      }
    }
    await this.assertNoActiveSessions(task.id)
    const local = await checkout(cwd)
    if (!same(local, task.local)) throw new Error('只能从原 Local checkout 清理该 Worktree。')
    await assertOrdinary(task.local)
    const isolated = await this.validateIsolatedIdentity(task)
    await assertOrdinary(isolated)
    const marker = join(isolated.root, '.git')
    if (!(await lstat(marker)).isFile()) throw new Error('不是受管的 linked Worktree。')
    const pointer = (await readFile(marker, 'utf8')).replace(/\r?\n$/, '')
    const backlink = (await readFile(join(isolated.gitDir, 'gitdir'), 'utf8')).replace(/\r?\n$/, '')
    if (!pointer.startsWith('gitdir: ') || await realpath(resolve(isolated.root, pointer.slice(8))) !== isolated.gitDir ||
        await realpath(resolve(isolated.gitDir, backlink)) !== marker) throw new Error('Git Worktree 登记与目录不匹配。')
    try {
      await lstat(join(isolated.gitDir, 'index.lock'))
      throw new Error('Worktree 的 Git 索引仍被锁定。')
    } catch (error) { if (!missing(error)) throw error }
    const [index, head, modules] = await Promise.all([
      runGit(isolated.root, ['ls-files', '--stage', '-z']), runGit(isolated.root, ['ls-tree', '-r', '-z', 'HEAD']),
      lstat(join(isolated.gitDir, 'modules')).then(() => true, error => { if (missing(error)) return false; throw error }),
    ])
    if (modules || [index, head].some(result => result.stdout.toString('utf8').split('\0').some(line => line.startsWith('160000 ')))) {
      throw new Error('Worktree 中有 Git 子模块，不能清理。')
    }
    if (process.platform === 'linux') {
      const mounts = await readFile('/proc/self/mountinfo', 'utf8')
      for (const record of mounts.trimEnd().split('\n')) {
        const mount = record.split(' ')[4]?.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)))
        if (!mount || mount === isolated.root || mount.startsWith(isolated.root + '/')) throw new Error('无法排除 Worktree 中的挂载点。')
      }
    }
    const listed = (await runGit(task.local.root, ['worktree', 'list', '--porcelain', '-z'])).stdout.toString('utf8')
    const entry = listed.split('\0\0').find(record => record.split('\0')[0] === `worktree ${task.isolatedPath}`)
    if (!entry || entry.split('\0').some(field => /^(locked|prunable)( |$)/.test(field))) throw new Error('Worktree 未注册、已锁定或可被修剪。')
  }

  private async scanCleanupTree(root: string, hash?: ReturnType<typeof createHash>) {
    const device = (await lstat(root, { bigint: true })).dev
    let empty = false
    const stamp = (s: BigIntStats) =>
      [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].map(value => value.toString()).join(':')
    const visit = async (path: string, rel: string) => {
      const s = await lstat(path, { bigint: true })
      if (s.dev !== device) throw new Error('Worktree 内有其他文件系统，不能清理。')
      const before = stamp(s)
      hash?.update(JSON.stringify([rel, before]) + '\n')
      if (rel === '.git' && !s.isFile()) throw new Error('不是受管的 linked Worktree。')
      if (s.isDirectory()) {
        const children = (await readdir(path, { encoding: 'buffer' })).map(name => {
          const text = name.toString('utf8')
          if (!Buffer.from(text).equals(name)) throw new Error('Worktree 中有无法安全检查的非 UTF-8 文件名。')
          return text
        }).sort()
        if (!children.length) empty = true
        if (children.includes('HEAD') && children.includes('objects') && children.includes('refs')) {
          throw new Error('Worktree 中可能有嵌套的裸 Git 仓库。')
        }
        for (const child of children) {
          if (child.toLowerCase() === '.git' && (rel || child !== '.git')) throw new Error('Worktree 中有嵌套的 Git 元数据。')
          await visit(join(path, child), rel ? `${rel}/${child}` : child)
        }
      } else if (s.isFile()) {
        if (hash) {
          const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
          try {
            if (stamp(await fd.stat({ bigint: true })) !== before) throw new Error('检查期间文件已变化。')
            const content = createHash('sha256')
            for await (const block of fd.createReadStream({ autoClose: false })) content.update(block)
            if (stamp(await fd.stat({ bigint: true })) !== before) throw new Error('检查期间文件已变化。')
            hash.update(content.digest())
          } finally { await fd.close() }
        }
      } else if (s.isSymbolicLink()) {
        if (hash) hash.update(createHash('sha256').update(await readlink(path, { encoding: 'buffer' })).digest())
      } else throw new Error('Worktree 中有 Git 无法快照的特殊文件。')
      if (hash && stamp(await lstat(path, { bigint: true })) !== before) throw new Error('检查期间目录内容已变化。')
    }
    await visit(root, '')
    return empty
  }

  private async removeWorktree(task: Task, save: () => Promise<void>) {
    // A failed or interrupted removal deliberately leaves the cleanup journal.
    await runGit(task.local.root, ['worktree', 'remove', '--force', '--', task.isolatedPath])
    task.cleanup = { status: 'done' }
    delete task.journal
    await save()
  }

  private async cleanup(task: Task, expected: string, save: () => Promise<void>) {
    await save() // The terminal phase is durable even if cleanup is skipped.
    try {
      await this.checkCleanupIdentity(task, task.local.root)
      task.journal = { operation: 'cleanup', at: Date.now() }
      await save()
      const empty = await this.scanCleanupTree(task.isolatedPath)
      const ignored = await runGit(task.isolatedPath, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])
      const changed = await this.discardFingerprint(task) !== expected
      const reasons = [changed && '隔离 Worktree 在确认后已变化', ignored.stdout.length > 0 && '包含 Git 忽略的文件', empty && '包含空目录'].filter(Boolean)
      if (reasons.length) throw new CleanupDataLoss(`${reasons.join('；')}。`)
    } catch (error) {
      delete task.journal
      task.cleanup = { status: 'retained', reason: errText(error), ...(error instanceof CleanupDataLoss ? { canForce: true } : {}) }
      await save()
      return
    }
    await this.removeWorktree(task, save)
  }

  private async removalProof(task: Task, cwd: string) {
    await this.checkCleanupIdentity(task, cwd)
    const isolated = task.isolated!
    const hash = createHash('sha256')
    // Include raw ignored bytes and empty directories which the Git fingerprint omits.
    // Hash symlinks themselves, never their targets.
    await this.scanCleanupTree(task.isolatedPath, hash)
    hash.update(await this.discardFingerprint(task))
    for (const file of ['HEAD', 'index']) {
      const data = await readFile(join(isolated.gitDir, file)).catch(error => { if (missing(error)) return undefined; throw error })
      hash.update(data ? createHash('sha256').update(data).digest('hex') : '-').update('\n')
    }
    await this.checkCleanupIdentity(task, cwd)
    return hash.digest('hex')
  }

  async inspectRetainedRemoval(task: Task, cwd: string): Promise<string> {
    if (!terminal(task) || task.journal || task.cleanup?.status !== 'retained') throw new Error('仅可清理已结束且没有恢复记录的保留 Worktree。')
    return this.removalProof(task, cwd)
  }

  async removeRetained(id: string, cwd: string, proof: string): Promise<void> {
    await this.locked(async (state, save) => {
      const task = state.tasks.find(item => item.id === id)
      if (!task || !terminal(task) || task.journal || task.cleanup?.status !== 'retained') throw new Error('保留状态已变化或存在恢复记录，未删除。')
      task.journal = { operation: 'cleanup', at: Date.now() }
      await save()
      try {
        if (await this.removalProof(task, cwd) !== proof) throw new Error('Worktree 在确认期间发生变化，未删除。请重新检查。')
      } catch (error) {
        delete task.journal // No deletion was attempted.
        await save()
        throw error
      }
      try { await this.removeWorktree(task, save) }
      catch (error) { throw new Error(`未能确认 Worktree 清理完成，恢复记录：${this.statePath}；${errText(error)}`, { cause: error }) }
    })
  }
}

export function shortSessionName(id: string) { return `Worktree ${id.slice(0, 8)}` }
