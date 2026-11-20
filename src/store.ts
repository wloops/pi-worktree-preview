import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { formatCommitMessage, normalizeCommitBody } from './commit-message.ts'
import { tr } from './i18n/display.ts'
import { createSessionCheckoutApplyEngine, prepareExternalConflictWorkspace, runGit, verifyFrozenReview, type ApplyConflictPlanResult, type FrozenReview, type PreviewReceipt } from './engine.ts'

export interface Checkout { root: string; gitDir: string; commonDir: string; rootIdentity: string; gitIdentity: string; commonIdentity: string }
export interface SessionLink { id: string; file: string; cwd: string }
type Phase = 'creating' | 'working' | 'ready' | 'previewed' | 'delivered' | 'discarded'
interface Review { id: string; fingerprint: string; files: string[]; message: string; body?: string; snapshot?: FrozenReview; partial?: true }
interface PrivateResolution { checkout: Checkout; sourceReview: FrozenReview; baseOid: string }
interface ConflictRecovery {
  localHeadOid: string
  isolatedHeadOid: string
  reviewedTreeOid: string
  conflictingFiles: string[]
  cleanEntries: { path: string; entry: string | null }[]
  workspace?: PrivateResolution
  files?: string[]
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
  // Never own, switch, or remove the source checkout. Older records carry adoption-time Git state.
  external?: true | { headOid: string; headRef: string | null }
  review?: Review
  recovery?: ConflictRecovery
  resolution?: PrivateResolution
  receipt?: PreviewReceipt
  // A null indexBefore explicitly records that no index file existed.
  journal?: { operation: 'preview' | 'rollback' | 'finalize' | 'commit_ready' | 'cleanup'; at: number; commitOid?: string; indexBefore?: string | null; indexAfter?: string }
  cleanup?: { status: 'done' | 'retained'; reason?: string; requested?: true; canForce?: true }
  commitOid?: string | null
}
interface State { version: 1; tasks: Task[] }
export interface AdoptionRequest {
  source: string; target: string; base: string; title: string; files: readonly string[]
}
export interface AdoptionInspection {
  local: Checkout; isolated: Checkout; baseOid: string; localHeadRef: string
  localHeadOid: string; isolatedHeadOid: string; isolatedHeadRef: string | null
  review: Omit<Review, 'id'>
}
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
  if (process.platform === 'win32') throw new Error(tr('此版本不在 Windows 上执行写操作。', 'This version does not perform write operations on Windows.'))
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
    throw new Error(tr(`Git 正在进行其他操作（${name}）。`, `Another Git operation is in progress (${name}).`))
  }
}

async function normalRef(root: string) {
  const result = await runGit(root, ['symbolic-ref', '--quiet', 'HEAD'], { allowedExitCodes: [0, 1] })
  const ref = result.stdout.toString('utf8').trim()
  if (!ref.startsWith('refs/heads/')) throw new Error(tr('Local 必须位于普通 Git 分支。', 'Local must be on a normal Git branch.'))
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
    throw new Error(tr(`此 Local 有未解决的写入恢复记录；已停止验收。检查 ${statePath}`, `This Local checkout has an unresolved write recovery record. Review stopped. Check ${statePath}`))
  }
  if (peers.some(peer => peer.phase === 'previewed')) {
    throw new Error(tr('此 Local 正在预览另一个任务；请先在原任务会话撤回或确认提交，再重试。', 'This Local checkout is previewing another task. Roll back or confirm the commit in that task’s original session before retrying.'))
  }
}
class CleanupDataLoss extends Error {}
export class PreviewConflict extends Error {
  constructor(readonly plan: ApplyConflictPlanResult) {
    const paths = plan.conflictingFiles.map(path => JSON.stringify(path)).join(tr('、', ', '))
    super(plan.committedConflictingFiles.length ? tr(`预览冲突，Local 未写入：${paths}`, `Preview conflicts; Local was not changed: ${paths}`) :
      tr(`Local 未提交的改动挡住预览，Local 未写入：${paths}`, `Uncommitted changes in Local block the preview; Local was not changed: ${paths}`))
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
    if (parsed.version !== 1 || !Array.isArray(parsed.tasks)) throw new Error(tr(`不支持的工作流记录：${this.statePath}`, `Unsupported workflow record: ${this.statePath}`))
    return parsed
  }

  private async locked<T>(fn: (state: State, save: () => Promise<void>) => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await syncDir(dirname(this.directory))
    try { await mkdir(this.lockPath, { mode: 0o700 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(tr(`另一个操作仍在运行，或之前中断。已停止；检查 ${this.lockPath}`,
        `Another operation is still running or was interrupted. Operation stopped; check ${this.lockPath}`))
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

  async discoverAdoption(session: SessionLink): Promise<AdoptionInspection> {
    const source = await checkout(session.cwd)
    const listed = (await runGit(source.root, ['worktree', 'list', '--porcelain', '-z'])).stdout.toString('utf8')
    // Git lists the main worktree first. Do not guess an alternate checkout or
    // infer the target from the source branch's upstream (which may be remote).
    const first = listed.split('\0\0')[0].split('\0')
    if (!first[0]?.startsWith('worktree ') || first.includes('bare') || first.includes('detached') || source.gitDir === source.commonDir) {
      throw new Error(tr('请在外部 linked Worktree 的 Pi 对话中运行；没有可自动选择的主 checkout 时，请显式指定接入参数。',
        'Run this from a Pi session in an external linked Worktree. If no main checkout can be selected automatically, specify the adoption parameters explicitly.'))
    }
    const target = await checkout(first[0].slice('worktree '.length))
    if (target.gitDir !== target.commonDir || target.commonDir !== source.commonDir || target.root === source.root) {
      throw new Error(tr('无法确定唯一的主 checkout；请显式指定接入参数。', 'Could not identify a unique main checkout. Specify the adoption parameters explicitly.'))
    }
    const [targetHead, sourceHead] = await Promise.all([target, source].map(dir => out(dir.root, ['rev-parse', 'HEAD^{commit}'])))
    const base = await out(target.root, ['merge-base', '--all', targetHead, sourceHead])
    if (!oid.test(base)) throw new Error(tr('未找到唯一共同分叉基点，不能自动接入。', 'No unique common merge base was found. Automatic adoption is not possible.'))
    const subject = sourceHead === base ? '' : (await out(source.root, ['show', '-s', '--format=%s', sourceHead])).trim()
    // Keep the fallback commit title stable; it can become Git commit content.
    const title = subject && subject.length <= 200 && !/[\x00-\x1f\x7f]/.test(subject) ? subject : '交付外部 Worktree 改动'
    const found = await this.inspectAdoptionSnapshot(session, { source: source.root, target: target.root, base, title })
    if (!same(source, found.isolated) || !same(target, found.local) || found.localHeadOid !== targetHead || found.isolatedHeadOid !== sourceHead) {
      throw new Error(tr('识别期间 checkout 已变化，请重新识别。', 'The checkout changed during discovery. Run discovery again.'))
    }
    return found
  }

  private sameAdoptionHeads(a: AdoptionInspection, b: AdoptionInspection) {
    return same(a.isolated, b.isolated) && same(a.local, b.local) && a.baseOid === b.baseOid && a.localHeadRef === b.localHeadRef &&
      a.localHeadOid === b.localHeadOid && a.isolatedHeadOid === b.isolatedHeadOid && a.isolatedHeadRef === b.isolatedHeadRef
  }

  async inspectAdoption(session: SessionLink, request: AdoptionRequest): Promise<AdoptionInspection> {
    if (!request.files.length) throw new Error(tr('请明确列出交付文件。', 'List the files to deliver explicitly.'))
    return this.inspectAdoptionSnapshot(session, request)
  }

  private async inspectAdoptionSnapshot(session: SessionLink, request: Omit<AdoptionRequest, 'files'> & { files?: readonly string[] }): Promise<AdoptionInspection> {
    if (![request.source, request.target].every(path => path.startsWith('/') && !path.includes('\0')) || !oid.test(request.base)) {
      throw new Error(tr('请提供绝对目录和完整起点提交 OID。', 'Provide absolute directory paths and the full base commit OID.'))
    }
    const title = request.title.trim()
    if (!title || title.length > 200 || /[\x00-\x1f\x7f]/.test(title)) throw new Error(tr('请提供 1–200 字符的单行提交标题。', 'Provide a single-line commit title of 1–200 characters.'))
    const [local, isolated, source, target, current] = await Promise.all([
      checkout(request.target), checkout(request.source), realpath(request.source), realpath(request.target), checkout(session.cwd),
    ])
    const contains = (root: string, path: string) => path === root || path.startsWith(root + '/')
    const managed = await realpath(this.worktrees).catch(error => { if (missing(error)) return this.worktrees; throw error })
    if (isolated.root !== source || local.root !== target || local.gitDir === isolated.gitDir || local.commonDir !== isolated.commonDir ||
        local.commonIdentity !== isolated.commonIdentity || contains(local.root, isolated.root) || contains(isolated.root, local.root) ||
        contains(managed, isolated.root) || contains(managed, local.root) || !(same(current, local) || same(current, isolated))) {
      throw new Error(tr('请选择同一 Git 仓库中两个独立的 checkout 根目录，并从其中之一运行接入；不能接入插件自建目录。',
        'Choose two separate checkout roots in the same Git repository and run adoption from one of them. An extension-managed directory cannot be adopted.'))
    }
    await this.validateLinkedRegistration(local, isolated, true)
    await Promise.all([assertOrdinary(local), assertOrdinary(isolated)])
    const [localHeadRef, localHeadOid, sourceHead, baseOid] = await Promise.all([
      normalRef(local.root), out(local.root, ['rev-parse', 'HEAD^{commit}']),
      out(isolated.root, ['rev-parse', 'HEAD^{commit}']), out(local.root, ['rev-parse', '--verify', `${request.base}^{commit}`]),
    ])
    if (baseOid !== request.base || await out(local.root, ['merge-base', '--all', localHeadOid, sourceHead]) !== baseOid) {
      throw new Error(tr('起点必须是源 Worktree 与目标当前 HEAD 的唯一共同分叉基点（git merge-base --all）。',
        'The base must be the unique common merge base of the source Worktree and the target’s current HEAD (git merge-base --all).'))
    }
    const inspected = await this.engineFactory().inspectReview({ localPath: local.root, isolatedPath: isolated.root, baseOid }, request.files)
    if (inspected.status === 'error') engineError(inspected)
    if (!inspected.changedFiles.length) throw new Error(tr('没有相对候选起点可交付的改动。', 'There are no changes to deliver relative to the proposed base.'))
    const sourceRef = await runGit(isolated.root, ['symbolic-ref', '--quiet', 'HEAD'], { allowedExitCodes: [0, 1] })
    if (inspected.isolatedHeadRef === localHeadRef) throw new Error(tr('源 Worktree 和目标不能检出同一个分支。', 'The source Worktree and target cannot have the same branch checked out.'))
    if (await out(local.root, ['rev-parse', 'HEAD']) !== localHeadOid || await normalRef(local.root) !== localHeadRef ||
        inspected.isolatedHeadOid !== sourceHead || await out(isolated.root, ['rev-parse', 'HEAD']) !== sourceHead ||
        inspected.isolatedHeadRef !== (sourceRef.stdout.toString('utf8').trim() || null) ||
        !same(await checkout(local.root), local) || !same(await checkout(isolated.root), isolated)) {
      throw new Error(tr('检查期间 checkout 已变化，请重试。', 'The checkout changed during inspection. Try again.'))
    }
    return { local, isolated, baseOid, localHeadRef, localHeadOid, isolatedHeadOid: sourceHead,
      isolatedHeadRef: inspected.isolatedHeadRef, review: { message: title, files: inspected.changedFiles,
        snapshot: inspected.snapshot, fingerprint: inspected.isolatedFingerprint, ...(inspected.partial ? { partial: true } : {}) } }
  }

  async adopt(session: SessionLink, request: AdoptionRequest, shown: AdoptionInspection): Promise<Task> {
    return this.locked(async (state, save) => {
      const current = await this.inspectAdoption(session, request)
      const { isolated, local, baseOid, localHeadRef, review } = current
      // Bind the exact selected contents and checkout identities to confirmation.
      // Unrelated working copy drift doesn't affect the selected delivery.
      if (!this.sameAdoptionHeads(current, shown) || review.message !== shown.review.message ||
          JSON.stringify(review.snapshot) !== JSON.stringify(shown.review.snapshot)) {
        throw new Error(tr('接入来源、目标或交付内容已变化；请重新检查。', 'The source, target, or delivery contents changed. Inspect them again.'))
      }
      const overlaps = (a: Checkout, b: Checkout | undefined) => !!b && (a.gitDir === b.gitDir ||
        a.root === b.root || a.root.startsWith(b.root + '/') || b.root.startsWith(a.root + '/'))
      if (state.tasks.some(t => (!terminal(t) || t.journal) && (sameSession(t.localSession, session) ||
          overlaps(isolated, t.isolated) || overlaps(isolated, t.local) || overlaps(local, t.isolated)))) {
        throw new Error(tr('当前会话或相关 checkout 已有冲突的任务；请先结束该任务。', 'The current session or a related checkout already has a conflicting task. End that task first.'))
      }
      const task: Task = { id: randomUUID(), external: true,
        phase: 'ready', baseOid, localHeadRef, local,
        isolatedPath: isolated.root, isolated, localSession: session, review: { id: randomUUID(), ...review } }
      state.tasks.push(task)
      await save()
      return task
    })
  }

  async create(local: Checkout, localSession: SessionLink, createSession: (cwd: string, task: Task, prior?: Task) => Promise<SessionLink>, followUpOf?: string): Promise<Task> {
    return this.locked(async (state, save) => {
      if (!same(await checkout(local.root), local)) throw new Error(tr('Local 身份已经变化。', 'The Local checkout identity has changed.'))
      if (state.tasks.some(t => t.external && t.isolated && (!terminal(t) || t.journal) && (t.isolated.root === local.root || t.isolated.gitDir === local.gitDir))) {
        throw new Error(tr('此 checkout 是进行中外部任务的来源，不能另作预览目标。', 'This checkout is the source of an active external task and cannot also be used as a preview target.'))
      }
      if (state.tasks.some(t => sameSession(t.localSession, localSession) && (!terminal(t) || t.journal))) {
        throw new Error(tr('此 Local 会话已有未完成的任务或恢复记录；可新开 Local 会话并行开发。', 'This Local session already has an unfinished task or a recovery record. Open another Local session to work in parallel.'))
      }
      const prior = followUpOf ? state.tasks.find(t => t.id === followUpOf) : undefined
      if (followUpOf && (!prior || !terminal(prior) || prior.journal || !same(prior.local, local) ||
          prior.isolatedSession?.cwd !== prior.isolatedPath || !prior.isolatedSession)) {
        throw new Error(tr('原任务不可续接，或不属于同一个 Local checkout。', 'The original task cannot be continued or does not belong to the same Local checkout.'))
      }
      await assertOrdinary(local)
      const localHeadRef = await normalRef(local.root)
      const baseOid = await out(local.root, ['rev-parse', '--verify', 'HEAD^{commit}'])
      if (!oid.test(baseOid)) throw new Error(tr('缺少初始 Git 提交。', 'An initial Git commit is required.'))
      const id = randomUUID()
      const isolatedPath = join(this.worktrees, id)
      if (isolatedPath.startsWith(local.root + '/') || isolatedPath === local.root) throw new Error(tr('Pi 数据目录不能位于当前仓库内。', 'The Pi data directory must not be inside the current repository.'))
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
    if (!expected || (!task.external && task.isolatedPath !== join(this.worktrees, task.id)) || expected.root !== task.isolatedPath ||
        expected.root === task.local.root || expected.gitDir === task.local.gitDir || expected.commonDir !== task.local.commonDir ||
        !same(await checkout(task.isolatedPath), expected)) throw new Error(tr('隔离 Worktree 的身份已变化；保留现场。', 'The isolated Worktree identity has changed. The environment was preserved for inspection.'))
    if (task.external) await this.validateLinkedRegistration(task.local, expected, true)
    return expected
  }

  async validateIsolated(task: Task) {
    await assertOrdinary(await this.validateIsolatedIdentity(task))
  }

  private async validateExternalDeliverySource(task: Task) {
    const source = await this.validateIsolatedIdentity(task)
    const ref = await runGit(source.root, ['symbolic-ref', '--quiet', 'HEAD'], { allowedExitCodes: [0, 1] })
    if (ref.stdout.toString('utf8').trim() === task.localHeadRef) {
      throw new Error(tr('外部 Worktree 和目标检出了同一个分支；交付会影响源目录。请先在源 Worktree 切回不同分支。',
        'The external Worktree and target have the same branch checked out. Delivery would affect the source checkout. Switch the source Worktree to a different branch first.'))
    }
  }

  async validateLocalIdentity(task: Task) {
    if (!same(await checkout(task.local.root), task.local)) throw new Error(tr('Local checkout 的身份已变化。', 'The Local checkout identity has changed.'))
  }

  async validateLocal(task: Task) {
    await this.validateLocalIdentity(task)
    await assertOrdinary(task.local)
    if (await normalRef(task.local.root) !== task.localHeadRef) throw new Error(tr('Local 分支已变化；保留现场。', 'The Local branch has changed. The environment was preserved for inspection.'))
  }

  private input(task: Task, resolution = task.resolution) {
    return resolution ? { localPath: task.local.root, isolatedPath: resolution.checkout.root, baseOid: resolution.baseOid, privateResolution: true as const } :
      { localPath: task.local.root, isolatedPath: task.isolatedPath, baseOid: task.baseOid }
  }

  private async validateResolution(task: Task, resolution = task.resolution, verifySource = true) {
    if (!resolution) return
    const root = resolution.checkout.root
    const parent = dirname(root)
    if (!task.external || dirname(parent) !== join(this.directory, 'conflict-workspaces') ||
        join(parent, 'committed merge checkout') !== root || !same(await checkout(root), resolution.checkout) ||
        resolution.checkout.gitDir !== join(root, '.git') || resolution.checkout.commonDir !== resolution.checkout.gitDir) {
      throw new Error(tr('冲突处理目录已变化。', 'The conflict-resolution directory has changed.'))
    }
    if (verifySource) await verifyFrozenReview(task.isolatedPath, resolution.sourceReview)
  }

  async resumeConflictRecovery(id: string, session: SessionLink, expected: ConflictRecovery): Promise<void> {
    const task = (await this.read()).tasks.find(t => t.id === id)
    if (!task || task.phase !== 'working' || task.journal || JSON.stringify(task.recovery) !== JSON.stringify(expected) ||
        !await this.isEditingSession(task, session)) throw new Error(tr('冲突恢复状态已变化。', 'The conflict recovery state has changed.'))
    await this.validateIsolatedIdentity(task)
    await this.validateResolution(task, expected.workspace)
  }

  async beginConflictRecovery(id: string, session: SessionLink, reviewId: string, shown: ApplyConflictPlanResult): Promise<ConflictRecovery> {
    return this.locked(async (state, save) => {
      const task = state.tasks.find(t => t.id === id)
      if (!task || task.phase !== 'ready' || task.review?.id !== reviewId || task.receipt || task.journal || task.recovery ||
          !await this.isEditingSession(task, session)) throw new Error(tr('待验收状态或隔离会话已变化，请重新预览。', 'The pending review or isolated session has changed. Preview again.'))
      if (!task.external && task.review.partial) throw new Error(tr('受管 Worktree 的部分交付不能自动合并冲突。', 'Conflicts cannot be merged automatically for a partial delivery from a managed Worktree.'))
      assertLocalAcceptanceAvailable(state, task, this.statePath)
      await this.validateLocal(task)
      await this.validateIsolated(task)
      const engine = this.engineFactory()
      const input = this.input(task)
      await this.validateResolution(task)
      const latest = await engine.plan(input, task.review)
      if (latest.status === 'error') engineError(latest)
      if (latest.status !== 'conflict' || latest.localFingerprint !== shown.localFingerprint || latest.dirtyConflict !== shown.dirtyConflict ||
          latest.localHeadOid !== shown.localHeadOid || latest.localHeadRef !== task.localHeadRef ||
          latest.isolatedHeadOid !== shown.isolatedHeadOid || latest.reviewedTreeOid !== shown.reviewedTreeOid ||
          JSON.stringify(latest.conflictingFiles) !== JSON.stringify(shown.conflictingFiles) ||
          JSON.stringify(latest.committedConflictingFiles) !== JSON.stringify(shown.committedConflictingFiles)) {
        throw new Error(tr('Local 或冲突情况已变化，请重新预览。', 'Local or the conflict state has changed. Preview again.'))
      }
      if (!latest.committedConflictingFiles.length || !latest.cleanEntries) throw new Error(tr('无法安全合并这组冲突；Local 未修改。', 'These conflicts cannot be merged safely. Local was not changed.'))
      const { isolatedHeadOid, localHeadOid, reviewedTreeOid, committedConflictingFiles, cleanEntries } = latest
      if (task.external) {
        const sourceReview = task.resolution?.sourceReview ?? task.review.snapshot
        if (!sourceReview || !await isAncestor(task.local.root, input.baseOid, localHeadOid)) throw new Error(tr('无法验证冲突基点。', 'Could not verify the conflict base.'))
        const directory = join(this.directory, 'conflict-workspaces')
        await mkdir(directory, { mode: 0o700, recursive: true })
        if (await realpath(directory) !== directory) throw new Error(tr('冲突处理目录不可用。', 'The conflict-resolution directory is unavailable.'))
        const root = await mkdtemp(join(directory, `${task.id}-`))
        const path = await prepareExternalConflictWorkspace(root, input, task.review, latest)
        const workspace = { checkout: await checkout(path), sourceReview, baseOid: localHeadOid }
        await this.validateLocal(task)
        await this.validateIsolated(task)
        await this.validateResolution(task, workspace)
        if (await out(task.local.root, ['rev-parse', 'HEAD']) !== localHeadOid) throw new Error(tr('合并目标已变化，请重新预览。', 'The merge target has changed. Preview again.'))
        const recovery: ConflictRecovery = { localHeadOid, isolatedHeadOid, reviewedTreeOid, conflictingFiles: committedConflictingFiles,
          cleanEntries, workspace, files: task.review.files }
        task.recovery = recovery
        delete task.resolution
        delete task.review
        task.phase = 'working'
        await save()
        return recovery
      }
      const current = await engine.inspectReview(input)
      if (current.status === 'error') engineError(current)
      // Agent can checkpoint the exact reviewed tree without picking up later files or
      // flattening a staged version different from both HEAD and the reviewed content.
      const [headTree, mergeBase] = await Promise.all([
        out(task.isolatedPath, ['rev-parse', `${isolatedHeadOid}^{tree}`]),
        out(task.isolatedPath, ['merge-base', '--all', isolatedHeadOid, localHeadOid]),
      ])
      if (current.isolatedHeadRef || current.isolatedHeadOid !== isolatedHeadOid || current.isolatedTreeOid !== reviewedTreeOid ||
          (current.isolatedIndexTreeOid !== reviewedTreeOid && current.isolatedIndexTreeOid !== headTree) ||
          mergeBase !== task.baseOid || !await isAncestor(task.local.root, task.baseOid, localHeadOid)) {
        throw new Error(tr('Worktree 有未验收的改动、独立暂存内容或不同的 Git 历史，无法安全交给 Agent 合并。',
          'The Worktree has unreviewed changes, separately staged changes, or a different Git history. It cannot safely be handed to the agent for merging.'))
      }
      await this.validateLocal(task)
      await this.validateIsolated(task)
      // Only detached HEAD can move during recovery. Do not give the Agent an
      // attached branch whose ref (possibly shared with Local) could change.
      const symbolic = await runGit(task.isolatedPath, ['symbolic-ref', '--quiet', 'HEAD'], { allowedExitCodes: [0, 1] })
      if (symbolic.exitCode !== 1 || await out(task.local.root, ['rev-parse', 'HEAD']) !== localHeadOid ||
          await out(task.isolatedPath, ['rev-parse', 'HEAD']) !== isolatedHeadOid) throw new Error(tr('合并目标已变化，请重新预览。', 'The merge target has changed. Preview again.'))
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
    await this.validateResolution(task, task.recovery?.workspace)
    const input = this.input(task, task.recovery?.workspace)
    const result = await this.engineFactory().inspectReview({ ...input, baseOid: task.recovery?.localHeadOid ?? input.baseOid })
    if (result.status === 'error') engineError(result)
    return result.changedFiles
  }

  async restrictReview(id: string, session: SessionLink, reviewId: string, files: readonly string[]): Promise<Review> {
    return this.locked(async (state, save) => {
      const task = state.tasks.find(t => t.id === id)
      if (!task || task.phase !== 'ready' || task.review?.id !== reviewId || task.journal || task.receipt || task.recovery ||
          !(boundIsolatedSession(task, session) || sameSession(task.localSession, session))) {
        throw new Error(tr('待验收状态或绑定会话已变化，请重新选择文件。', 'The pending review or bound session has changed. Select the files again.'))
      }
      if (files.length >= task.review.files.length) throw new Error(tr('这里只能缩小交付清单。', 'You can only narrow the delivery list here.'))
      await this.validateIsolated(task)
      await this.validateResolution(task)
      const snapshot = await this.engineFactory().restrictReview(this.input(task), task.review, files)
      const review: Review = { ...task.review, id: randomUUID(), files: [...files].sort(), snapshot, partial: true }
      task.review = review
      await save()
      return review
    })
  }

  async isEditingSession(task: Task, session: SessionLink): Promise<boolean> {
    // Before external adoption recorded only one session link. Use that exact
    // link, and only if it belongs to the source, not an adopting target.
    if (!task.external) return boundIsolatedSession(task, session)
    return sameSession(task.localSession, session) && !!task.isolated && same(await checkout(session.cwd), task.isolated)
  }

  async markReady(id: string, session: SessionLink, message: string, files: readonly string[],
    options?: { body?: string; expectedReview?: { id: string | undefined } }): Promise<Review> {
    const title = message.trim()
    if (!title || title.length > 200 || /[\x00-\x1f\x7f]/.test(title)) throw new Error(tr('请提供 1–200 字符的单行提交标题。', 'Provide a single-line commit title of 1–200 characters.'))
    const body = normalizeCommitBody(options?.body)
    if (!Array.isArray(files) || !files.length) throw new Error(tr('请明确列出本次任务要交付的改动文件。', 'Explicitly list the changed files to deliver for this task.'))
    return this.locked(async (state, save) => {
      const task = state.tasks.find(t => t.id === id)
      if (!task || task.journal || (task.phase !== 'working' && task.phase !== 'ready') || !await this.isEditingSession(task, session)) {
        throw new Error(tr('当前不是可标记待验收的隔离会话。', 'This is not the isolated session that can mark the task ready for review.'))
      }
      if (options?.expectedReview && task.review?.id !== options.expectedReview.id) throw new Error(tr('待验收记录已变化，请重新选择。', 'The pending review record has changed. Select it again.'))
      await this.validateIsolated(task)
      const recovery = task.recovery
      // Normal re-review looks at the source. A recovery review only reads its private workspace.
      const workspace = recovery?.workspace
      if (task.resolution && !workspace) throw new Error(tr('要改动已解决的交付，请先开始返修。', 'Start a revision before making changes to the resolved delivery.'))
      const baseOid = recovery?.localHeadOid ?? task.baseOid
      if (workspace) {
        await this.validateResolution(task, workspace)
        if ((await runGit(workspace.checkout.root, ['ls-files', '-u', '-z'])).stdout.length) throw new Error(tr('还有未解决的冲突；请先暂存已解决的冲突文件。',
          'Unresolved conflicts remain. Stage the files after resolving their conflicts.'))
      }
      const inspected = await this.engineFactory().inspectReview({ ...this.input(task, workspace), baseOid }, workspace ? undefined : files)
      if (inspected.status === 'error') engineError(inspected)
      if (task.external && !workspace) {
        // A new review can select a new set of paths at any source HEAD.
        // Only a checkout change during this very scan requires a retry.
        await this.validateIsolated(task)
        const ref = await runGit(task.isolatedPath, ['symbolic-ref', '--quiet', 'HEAD'], { allowedExitCodes: [0, 1] })
        if (inspected.isolatedHeadRef !== (ref.stdout.toString('utf8').trim() || null) ||
            inspected.isolatedHeadOid !== await out(task.isolatedPath, ['rev-parse', 'HEAD'])) {
          throw new Error(tr('扫描期间源 Worktree 已变化；请重新标记待验收。', 'The source Worktree changed during the scan. Mark the task ready for review again.'))
        }
      }
      if (workspace && recovery) {
        const allowed = new Set(recovery.files)
        const actual = new Map(inspected.snapshot.entries.map(({ path, working, index }) => [path, { working, index }]))
        const clean = new Map(recovery.cleanEntries.map(({ path, entry }) => [path, entry]))
        const conflicts = new Set(recovery.conflictingFiles)
        if (files.length !== actual.size || new Set(files).size !== actual.size || files.some(path => !actual.has(path)) ||
            [...actual].some(([path, entry]) => !allowed.has(path) || entry.working !== entry.index ||
              (!conflicts.has(path) && (!clean.has(path) || clean.get(path) !== entry.working))) ||
            [...clean.keys()].some(path => !actual.has(path)) || inspected.isolatedTreeOid !== inspected.isolatedIndexTreeOid) {
          throw new Error(tr('冲突结果必须完整、已暂存，并保留非冲突文件的自动合并结果。', 'The conflict resolution must be complete and staged, and must preserve the automatic merge result for files without conflicts.'))
        }
        await this.validateResolution(task, workspace)
        await this.validateLocal(task)
        if (!await isAncestor(task.local.root, baseOid, 'HEAD')) throw new Error(tr('项目目录已不包含合并目标。', 'The project checkout no longer contains the merge target.'))
        task.resolution = workspace
        delete task.recovery
      } else if (recovery) {
        if (inspected.partial) throw new Error(tr('合并完成后的交付清单必须包含相对合并目标的全部改动。', 'After merging, the delivery list must include all changes relative to the merge target.'))
        const [firstParent, mergedParent, ...others] = (await out(task.isolatedPath,
          ['show', '-s', '--format=%P', inspected.isolatedHeadOid])).split(' ')
        if (inspected.isolatedHeadRef || !oid.test(firstParent) || mergedParent !== baseOid || others.length ||
            !await isAncestor(task.isolatedPath, recovery.isolatedHeadOid, firstParent) ||
            await out(task.isolatedPath, ['rev-parse', `${firstParent}^{tree}`]) !== recovery.reviewedTreeOid ||
            await out(task.isolatedPath, ['rev-parse', 'HEAD']) !== inspected.isolatedHeadOid ||
            await out(task.isolatedPath, ['rev-parse', `${inspected.isolatedHeadOid}^{tree}`]) !== inspected.isolatedTreeOid ||
            inspected.isolatedIndexTreeOid !== inspected.isolatedTreeOid) {
          throw new Error(tr(`请先在当前 Worktree 完成与 ${baseOid.slice(0, 12)} 的合并提交，再标记待验收。`, `Complete the merge commit with ${baseOid.slice(0, 12)} in this Worktree before marking the task ready for review.`))
        }
        const expected = new Map(recovery.cleanEntries.map(({ path, entry }) => [path, entry]))
        const conflicts = new Set(recovery.conflictingFiles)
        const actual = new Map(inspected.snapshot.entries.map(({ path, working }) => [path, working]))
        if ([...expected].some(([path, entry]) => !actual.has(path) || actual.get(path) !== entry) ||
            [...actual].some(([path]) => !conflicts.has(path) && !expected.has(path))) {
          throw new Error(tr('合并结果改动了冲突范围外的内容；请保留 Git 自动合并的结果后再标记待验收。',
            'The merge result includes changes outside the conflict scope. Preserve Git’s automatic merge result before marking the task ready for review.'))
        }
        await this.validateLocal(task)
        if (!await isAncestor(task.local.root, baseOid, 'HEAD')) throw new Error(tr('Local 已不包含合并目标，无法生成新验收。', 'Local no longer contains the merge target. A new review cannot be prepared.'))
        task.baseOid = baseOid
        delete task.recovery
      }
      if (!inspected.changedFiles.length) throw new Error(recovery ? tr('合并后无需交付：任务改动已在 Local HEAD 中。可返回 Local 放弃此任务。',
        'Nothing to deliver after merging: the task changes are already in Local HEAD. Return to Local to discard this task.') : tr('没有可验收的 Git 改动。', 'There are no Git changes to review.'))
      const review: Review = { id: randomUUID(), fingerprint: inspected.isolatedFingerprint, files: inspected.changedFiles,
        message: title, ...(body ? { body } : {}), snapshot: inspected.snapshot, ...(inspected.partial ? { partial: true } : {}) }
      task.review = review
      task.phase = 'ready'
      await save()
      return review
    })
  }

  async continueEditing(id: string, session: SessionLink, reviewId: string, signal?: AbortSignal): Promise<void> {
    await this.locked(async (state, save) => {
      const task = state.tasks.find(t => t.id === id)
      if (!task || task.phase !== 'ready' || task.review?.id !== reviewId || task.receipt || task.journal || !await this.isEditingSession(task, session)) {
        throw new Error(tr('待验收状态或隔离会话已变化，不能继续修改。', 'The pending review or isolated session has changed. Editing cannot continue.'))
      }
      if (task.external) await this.validateIsolatedIdentity(task)
      else await this.validateIsolated(task)
      signal?.throwIfAborted()
      delete task.resolution
      delete task.review
      task.phase = 'working'
      await save()
    })
  }

  async resumeExternalEditing(id: string, session: SessionLink, signal?: AbortSignal): Promise<void> {
    await this.locked(async state => {
      const task = state.tasks.find(t => t.id === id)
      if (!task?.external || task.phase !== 'working' || task.review || task.receipt || task.journal ||
          !await this.isEditingSession(task, session)) {
        throw new Error(tr('返修状态或绑定会话已变化。', 'The revision state or bound session has changed.'))
      }
      await this.validateIsolatedIdentity(task)
      signal?.throwIfAborted()
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
    session?: SessionLink
  }): Promise<Task> {
    return this.locked(async (state, save) => {
      const task = state.tasks.find(t => t.id === id)
      if (!task || task.journal || task.phase !== expected.phase || task.review?.id !== expected.reviewId || task.receipt?.previewId !== expected.previewId) {
        throw new Error(tr(`任务状态已变化或存在恢复记录；操作已停止。${this.statePath}`, `The task state has changed or a recovery record exists. Operation stopped. ${this.statePath}`))
      }
      if ((task.external || expected.session) && (!expected.session ||
          !(sameSession(task.localSession, expected.session) || boundIsolatedSession(task, expected.session)))) {
        throw new Error(tr('当前不是绑定的 Pi 对话；操作已停止。', 'This is not the bound Pi session. Operation stopped.'))
      }
      if (task.external && action === 'discard' && ['working', 'ready'].includes(task.phase)) {
        task.phase = 'discarded'
        await save()
        return task
      }
      if (task.external && action === 'commit_ready') throw new Error(tr('外部 Worktree 必须先预览再提交。', 'An external Worktree must be previewed before committing.'))
      if (task.external && expected.revision && (action !== 'rollback' || !expected.session ||
          !sameSession(expected.session, expected.revision.session))) throw new Error(tr('返修确认不属于当前外部 Worktree 对话。', 'The revision confirmation does not belong to the current external Worktree session.'))
      // The register lock covers this check through the Local write and receipt.
      // Working/ready siblings and isolated-only cleanup never own this slot.
      if (action !== 'discard') assertLocalAcceptanceAvailable(state, task, this.statePath)
      await this.validateLocal(task)
      const engine = this.engineFactory()
      try {
        if (action === 'discard' && ['working', 'ready'].includes(task.phase)) {
          if (await this.discardFingerprint(task) !== expected.discardFingerprint) throw new Error(tr('Worktree 在确认放弃期间已变化。', 'The Worktree changed while discard was being confirmed.'))
          task.phase = 'discarded'
          await this.cleanup(task, expected.discardFingerprint!, save)
        } else if ((action === 'preview' || action === 'commit_ready') && task.phase === 'ready' && task.review) {
          await this.validateIsolated(task)
          await this.validateResolution(task)
          const input = this.input(task)
          const res = await engine.plan(input, task.review)
          if (res.status === 'error') engineError(res)
          const localPlan = res.status === 'conflict' ? res : res.plan
          if (localPlan.localHeadRef !== task.localHeadRef || !await isAncestor(task.local.root, input.baseOid, localPlan.localHeadOid)) {
            throw new Error(tr('Local 分支或历史已变化；未写入 Local。', 'The Local branch or history has changed. Local was not changed.'))
          }
          if (res.status === 'conflict') throw new PreviewConflict(res)
          if (action === 'commit_ready') {
            const review = task.review
            const done = await engine.commitReady(res.plan, {
              previewId: randomUUID(), reviewId: review.id, iteration: 1, commitMessage: formatCommitMessage(review.message, review.body),
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
              await this.validateResolution(task)
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
            if (!task.review || !await this.isEditingSession(task, revision.session)) throw new Error(tr('待验收状态或隔离会话已变化，不能继续修改。', 'The pending review or isolated session has changed. Editing cannot continue.'))
            if (task.external) await this.validateIsolatedIdentity(task)
            else await this.validateIsolated(task)
            revision.signal?.throwIfAborted()
          }
          const rolled = await engine.rollback({ localPath: task.local.root, receipt: task.receipt, beforeWrite: async () => {
            await this.validateLocal(task)
            if (revision) {
              if (task.external) await this.validateIsolatedIdentity(task)
              else await this.validateIsolated(task)
              revision.signal?.throwIfAborted()
            }
            task.journal = { operation: 'rollback', at: Date.now() }
            await save()
          } })
          if (rolled.status === 'error') engineError(rolled)
          delete task.receipt
          delete task.journal
          if (revision) {
            delete task.resolution
            delete task.review
            task.phase = 'working'
          } else task.phase = 'ready'
          await save()
          await this.unpin(task).catch(() => {})
        } else if (action === 'finalize' && task.phase === 'previewed' && task.receipt && task.review) {
          if (task.receipt.reviewId !== task.review.id) throw new Error(tr('预览与待验收记录不匹配；未提交。', 'The preview does not match the pending review record. No commit was made.'))
          const commitMessage = formatCommitMessage(task.review.message, task.review.body)
          const done = await engine.finalize({ localPath: task.local.root, receipt: task.receipt, commitMessage, beforeCommit: async (commitOid, before, after) => {
            await this.validateLocal(task)
            // Both checkouts share refs. An external source that changed to
            // the target branch must not have its HEAD moved by delivery.
            if (task.external) await this.validateExternalDeliverySource(task)
            else if (expected.keepWorktree) await this.validateIsolatedIdentity(task)
            await this.recordCommit(task, 'finalize', task.receipt!, commitOid, before, after, save)
          } })
          if (done.status === 'error') engineError(done)
          await this.completeCommit(task, done.commitOid, task.receipt.isolatedFingerprint, !!expected.keepWorktree, save)
        } else throw new Error(tr('当前阶段不允许此操作。', 'This operation is not allowed in the current phase.'))
      } catch (error) {
        if (error instanceof PreviewConflict) throw error
        const detail = errText(error)
        throw new Error(task.journal ? tr(`${detail}；已停用自动操作，恢复记录：${this.statePath}`,
          `${detail}; automatic operations were disabled. Recovery record: ${this.statePath}`) : detail, { cause: error })
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
    // Reasons are diagnostic text saved as displayed; legacy reasons remain readable as-is.
    if (!task.external && keep) task.cleanup = { status: 'retained', reason: tr('按用户选择保留环境。', 'The Worktree was kept as requested.'), requested: true }
    else if (!task.external && task.review?.partial) task.cleanup = { status: 'retained', reason: tr('含未纳入交付清单的改动。', 'The Worktree contains changes not included in the delivery list.'), canForce: true }
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
    if (!task.external && !keep && !task.review?.partial) {
      try { await this.cleanup(task, fingerprint, save) }
      catch (error) {
        const detail = errText(error)
        throw new Error(tr(`已提交 ${commitOid}，但未能确认 Worktree 清理完成：${detail}`,
          `Committed ${commitOid}, but could not verify that Worktree cleanup completed: ${detail}`), { cause: error })
      }
    }
    await this.unpin(task).catch(() => {})
  }

  private prefix(task: Task) { return `refs/pi-worktree-preview/${task.id}` }
  private async pin(task: Task, objects: string[], key = 'snapshot') {
    const refs = objects.map((object, i) => {
      if (!oid.test(object)) throw new Error(tr('恢复快照 OID 无效。', 'Invalid recovery snapshot OID.'))
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
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error(tr('Worktree ID 无效。', 'Invalid Worktree ID.'))
    return join(this.directory, 'active-sessions', id)
  }

  async holdWorktree(id: string) {
    await this.locked(async state => {
      const task = state.tasks.find(item => item.id === id)
      if (!task || task.cleanup?.status === 'done' || task.journal?.operation === 'cleanup') throw new Error(tr('Worktree 已清理或正在清理。', 'The Worktree has already been cleaned up or cleanup is in progress.'))
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
      if (!/^[1-9]\d*$/.test(pid)) throw new Error(tr('无法确认 Worktree 的会话占用状态。', 'Could not verify whether a session is using this Worktree.'))
      try { process.kill(Number(pid), 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue }
      throw new Error(tr('另一个 Pi 会话正在使用此 Worktree，或仍有未释放的占用。', 'Another Pi session is using this Worktree or has not released it.'))
    }
  }

  private async checkCleanupIdentity(task: Task, cwd: string) {
    if (task.external) throw new Error(tr('外部 Worktree 由原工具管理，插件不会删除。', 'The external Worktree is managed by its original tool. The extension will not remove it.'))
    for (const active of [cwd, process.cwd()]) {
      const path = await realpath(active)
      if (path === task.isolatedPath || path.startsWith(task.isolatedPath + '/')) {
        throw new Error(tr('当前 Pi 会话或进程仍在此 Worktree 中，保留目录。', 'The current Pi session or process is still in this Worktree. The directory was kept.'))
      }
    }
    await this.assertNoActiveSessions(task.id)
    const local = await checkout(cwd)
    if (!same(local, task.local)) throw new Error(tr('只能从原 Local checkout 清理该 Worktree。', 'This Worktree can only be cleaned up from the original Local checkout.'))
    await assertOrdinary(task.local)
    const isolated = await this.validateIsolatedIdentity(task)
    await assertOrdinary(isolated)
    await this.validateLinkedRegistration(local, isolated)
    try {
      await lstat(join(isolated.gitDir, 'index.lock'))
      throw new Error(tr('Worktree 的 Git 索引仍被锁定。', 'The Worktree’s Git index is still locked.'))
    } catch (error) { if (!missing(error)) throw error }
    const [index, head, modules] = await Promise.all([
      runGit(isolated.root, ['ls-files', '--stage', '-z']), runGit(isolated.root, ['ls-tree', '-r', '-z', 'HEAD']),
      lstat(join(isolated.gitDir, 'modules')).then(() => true, error => { if (missing(error)) return false; throw error }),
    ])
    if (modules || [index, head].some(result => result.stdout.toString('utf8').split('\0').some(line => line.startsWith('160000 ')))) {
      throw new Error(tr('Worktree 中有 Git 子模块，不能清理。', 'This Worktree contains Git submodules and cannot be cleaned up.'))
    }
    if (process.platform === 'linux') {
      const mounts = await readFile('/proc/self/mountinfo', 'utf8')
      for (const record of mounts.trimEnd().split('\n')) {
        const mount = record.split(' ')[4]?.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)))
        if (!mount || mount === isolated.root || mount.startsWith(isolated.root + '/')) throw new Error(tr('无法排除 Worktree 中的挂载点。', 'Could not rule out mount points in the Worktree.'))
      }
    }
  }

  private async validateLinkedRegistration(local: Checkout, isolated: Checkout, allowLocked = false) {
    const marker = join(isolated.root, '.git')
    if (!(await lstat(marker)).isFile()) throw new Error(tr('不是受管的 linked Worktree。', 'This is not a managed linked Worktree.'))
    const pointer = (await readFile(marker, 'utf8')).replace(/\r?\n$/, '')
    const backlink = (await readFile(join(isolated.gitDir, 'gitdir'), 'utf8')).replace(/\r?\n$/, '')
    if (!pointer.startsWith('gitdir: ') || await realpath(resolve(isolated.root, pointer.slice(8))) !== isolated.gitDir ||
        await realpath(resolve(isolated.gitDir, backlink)) !== marker) throw new Error(tr('Git Worktree 登记与目录不匹配。', 'The Git Worktree registration does not match the directory.'))
    const listed = (await runGit(local.root, ['worktree', 'list', '--porcelain', '-z'])).stdout.toString('utf8')
    const entry = listed.split('\0\0').find(record => record.split('\0')[0] === `worktree ${isolated.root}`)
    if (!entry || entry.split('\0').some(field => /^(prunable)( |$)/.test(field) || (!allowLocked && /^locked( |$)/.test(field)))) {
      throw new Error(tr('Worktree 未注册、已锁定或可被修剪。', 'The Worktree is unregistered, locked, or eligible for pruning.'))
    }
  }

  private async scanCleanupTree(root: string, hash?: ReturnType<typeof createHash>) {
    const device = (await lstat(root, { bigint: true })).dev
    let empty = false
    const stamp = (s: BigIntStats) =>
      [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].map(value => value.toString()).join(':')
    const visit = async (path: string, rel: string) => {
      const s = await lstat(path, { bigint: true })
      if (s.dev !== device) throw new Error(tr('Worktree 内有其他文件系统，不能清理。', 'The Worktree contains another filesystem and cannot be cleaned up.'))
      const before = stamp(s)
      hash?.update(JSON.stringify([rel, before]) + '\n')
      if (rel === '.git' && !s.isFile()) throw new Error(tr('不是受管的 linked Worktree。', 'This is not a managed linked Worktree.'))
      if (s.isDirectory()) {
        const children = (await readdir(path, { encoding: 'buffer' })).map(name => {
          const text = name.toString('utf8')
          if (!Buffer.from(text).equals(name)) throw new Error(tr('Worktree 中有无法安全检查的非 UTF-8 文件名。', 'The Worktree contains a non-UTF-8 file name that cannot be checked safely.'))
          return text
        }).sort()
        if (!children.length) empty = true
        if (children.includes('HEAD') && children.includes('objects') && children.includes('refs')) {
          throw new Error(tr('Worktree 中可能有嵌套的裸 Git 仓库。', 'The Worktree may contain a nested bare Git repository.'))
        }
        for (const child of children) {
          if (child.toLowerCase() === '.git' && (rel || child !== '.git')) throw new Error(tr('Worktree 中有嵌套的 Git 元数据。', 'The Worktree contains nested Git metadata.'))
          await visit(join(path, child), rel ? `${rel}/${child}` : child)
        }
      } else if (s.isFile()) {
        if (hash) {
          const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
          try {
            if (stamp(await fd.stat({ bigint: true })) !== before) throw new Error(tr('检查期间文件已变化。', 'A file changed during inspection.'))
            const content = createHash('sha256')
            for await (const block of fd.createReadStream({ autoClose: false })) content.update(block)
            if (stamp(await fd.stat({ bigint: true })) !== before) throw new Error(tr('检查期间文件已变化。', 'A file changed during inspection.'))
            hash.update(content.digest())
          } finally { await fd.close() }
        }
      } else if (s.isSymbolicLink()) {
        if (hash) hash.update(createHash('sha256').update(await readlink(path, { encoding: 'buffer' })).digest())
      } else throw new Error(tr('Worktree 中有 Git 无法快照的特殊文件。', 'The Worktree contains a special file that Git cannot snapshot.'))
      if (hash && stamp(await lstat(path, { bigint: true })) !== before) throw new Error(tr('检查期间目录内容已变化。', 'The directory contents changed during inspection.'))
    }
    await visit(root, '')
    return empty
  }

  private async removeWorktree(task: Task, save: () => Promise<void>) {
    if (task.external) throw new Error(tr('外部 Worktree 由原工具管理，插件不会删除。', 'The external Worktree is managed by its original tool. The extension will not remove it.'))
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
      const reasons = [
        changed && tr('隔离 Worktree 在确认后已变化', 'The isolated Worktree changed after confirmation'),
        ignored.stdout.length > 0 && tr('包含 Git 忽略的文件', 'Contains Git-ignored files'),
        empty && tr('包含空目录', 'Contains empty directories'),
      ].filter(Boolean)
      if (reasons.length) throw new CleanupDataLoss(reasons.join(tr('；', '; ')) + tr('。', '.'))
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
    if (task.external || !terminal(task) || task.journal || task.cleanup?.status !== 'retained') throw new Error(tr('仅可清理已结束且没有恢复记录的保留 Worktree。',
      'Only retained Worktrees with completed tasks and no recovery records can be cleaned up.'))
    return this.removalProof(task, cwd)
  }

  async removeRetained(id: string, cwd: string, proof: string): Promise<void> {
    await this.locked(async (state, save) => {
      const task = state.tasks.find(item => item.id === id)
      if (!task || task.external || !terminal(task) || task.journal || task.cleanup?.status !== 'retained') throw new Error(tr('保留状态已变化或存在恢复记录，未删除。',
        'The retention state changed or a recovery record exists. The Worktree was not removed.'))
      task.journal = { operation: 'cleanup', at: Date.now() }
      await save()
      try {
        if (await this.removalProof(task, cwd) !== proof) throw new Error(tr('Worktree 在确认期间发生变化，未删除。请重新检查。', 'The Worktree changed during confirmation and was not removed. Inspect it again.'))
      } catch (error) {
        delete task.journal // No deletion was attempted.
        await save()
        throw error
      }
      try { await this.removeWorktree(task, save) }
      catch (error) {
        const detail = errText(error)
        throw new Error(tr(`未能确认 Worktree 清理完成，恢复记录：${this.statePath}；${detail}`,
          `Could not verify that Worktree cleanup completed. Recovery record: ${this.statePath}; ${detail}`), { cause: error })
      }
    })
  }
}

export function shortSessionName(id: string) { return `Worktree ${id.slice(0, 8)}` }
