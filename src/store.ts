import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createSessionCheckoutApplyEngine, runGit, type FrozenReview, type PreviewReceipt } from './engine.ts'

export interface Checkout { root: string; gitDir: string; commonDir: string; rootIdentity: string; gitIdentity: string; commonIdentity: string }
export interface SessionLink { id: string; file: string; cwd: string }
type Phase = 'creating' | 'working' | 'ready' | 'previewed' | 'delivered' | 'discarded'
interface Review { id: string; fingerprint: string; files: string[]; message: string; snapshot?: FrozenReview }
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
  review?: Review
  receipt?: PreviewReceipt
  journal?: { operation: 'preview' | 'rollback' | 'finalize' | 'cleanup'; at: number; commitOid?: string; indexBefore?: string; indexAfter?: string }
  cleanup?: { status: 'done' | 'retained'; reason?: string }
  commitOid?: string | null
}
interface State { version: 1; tasks: Task[] }
export type Action = 'preview' | 'rollback' | 'finalize' | 'discard'
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

  async create(local: Checkout, localSession: SessionLink, createSession: (cwd: string, id: string) => Promise<SessionLink>): Promise<Task> {
    return this.locked(async (state, save) => {
      if (!same(await checkout(local.root), local)) throw new Error('Local 身份已经变化。')
      if (state.tasks.some(t => t.local.root === local.root && (!terminal(t) || t.journal))) throw new Error('这个 Local 已有未完成的任务或恢复记录。')
      await assertOrdinary(local)
      const localHeadRef = await normalRef(local.root)
      const baseOid = await out(local.root, ['rev-parse', '--verify', 'HEAD^{commit}'])
      if (!oid.test(baseOid)) throw new Error('缺少初始 Git 提交。')
      const id = randomUUID()
      const isolatedPath = join(this.worktrees, id)
      if (isolatedPath.startsWith(local.root + '/') || isolatedPath === local.root) throw new Error('Pi 数据目录不能位于当前仓库内。')
      await mkdir(this.worktrees, { recursive: true, mode: 0o700 })
      const task: Task = { id, phase: 'creating', baseOid, localHeadRef, local, isolatedPath, localSession }
      state.tasks.push(task)
      await save()
      await runGit(local.root, ['worktree', 'add', '--detach', '--', isolatedPath, baseOid])
      task.isolated = await checkout(isolatedPath)
      task.isolatedSession = await createSession(isolatedPath, id)
      task.phase = 'working'
      await save()
      return task
    })
  }

  async validateIsolated(task: Task) {
    const expected = task.isolated
    if (!expected || task.isolatedPath !== join(this.worktrees, task.id) || expected.root !== task.isolatedPath ||
        expected.root === task.local.root || expected.gitDir === task.local.gitDir || expected.commonDir !== task.local.commonDir ||
        !same(await checkout(task.isolatedPath), expected)) throw new Error('隔离 Worktree 的身份已变化；保留现场。')
    await assertOrdinary(expected)
  }

  async validateLocal(task: Task) {
    if (!same(await checkout(task.local.root), task.local)) throw new Error('Local checkout 的身份已变化。')
    await assertOrdinary(task.local)
    if (await normalRef(task.local.root) !== task.localHeadRef) throw new Error('Local 分支已变化；保留现场。')
  }

  private input(task: Task) { return { localPath: task.local.root, isolatedPath: task.isolatedPath, baseOid: task.baseOid } }

  async markReady(id: string, session: SessionLink, message: string): Promise<Review> {
    const title = message.trim()
    if (!title || title.length > 200 || /[\x00-\x1f\x7f]/.test(title)) throw new Error('请提供 1–200 字符的单行提交说明。')
    return this.locked(async (state, save) => {
      const task = state.tasks.find(t => t.id === id)
      if (!task || task.journal || !['working', 'ready'].includes(task.phase) || !task.isolatedSession ||
          task.isolatedSession.id !== session.id || task.isolatedSession.file !== session.file || task.isolatedSession.cwd !== session.cwd) {
        throw new Error('当前不是可标记待验收的隔离会话。')
      }
      await this.validateIsolated(task)
      const inspected = await this.engineFactory().inspectReview(this.input(task))
      if (inspected.status === 'error') engineError(inspected)
      if (!inspected.changedFiles.length) throw new Error('没有可验收的 Git 改动。')
      const review = { id: randomUUID(), fingerprint: inspected.isolatedFingerprint, files: inspected.changedFiles, message: title, snapshot: inspected.snapshot }
      task.review = review
      task.phase = 'ready'
      await save()
      return review
    })
  }

  async discardFingerprint(task: Task): Promise<string> {
    await this.validateIsolated(task)
    const inspected = await this.engineFactory().inspectReview(this.input(task))
    if (inspected.status === 'error') engineError(inspected)
    return inspected.isolatedFingerprint
  }

  /** Expected tokens tie the confirmation to the state that the user actually saw. */
  async act(id: string, action: Action, expected: { phase: Phase; reviewId?: string; previewId?: string; discardFingerprint?: string }): Promise<Task> {
    return this.locked(async (state, save) => {
      const task = state.tasks.find(t => t.id === id)
      if (!task || task.journal || task.phase !== expected.phase || task.review?.id !== expected.reviewId || task.receipt?.previewId !== expected.previewId) {
        throw new Error(`任务状态已变化或存在恢复记录；操作已停止。${this.statePath}`)
      }
      await this.validateLocal(task)
      const engine = this.engineFactory()
      try {
        if (action === 'discard' && ['working', 'ready'].includes(task.phase)) {
          if (await this.discardFingerprint(task) !== expected.discardFingerprint) throw new Error('Worktree 在确认放弃期间已变化。')
          task.phase = 'discarded'
          await this.cleanup(task, expected.discardFingerprint!, save)
        } else if (action === 'preview' && task.phase === 'ready' && task.review) {
          await this.validateIsolated(task)
          const res = await engine.plan(this.input(task), task.review)
          if (res.status === 'error') engineError(res)
          if (res.status === 'conflict') throw new Error(`预览冲突，Local 未写入：${res.conflictingFiles.map(s => JSON.stringify(s)).join('、')}`)
          if (res.plan.localHeadRef !== task.localHeadRef) throw new Error('计算预览时 Local 分支已变化。')
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
          const rolled = await engine.rollback({ localPath: task.local.root, receipt: task.receipt, beforeWrite: async () => {
            await this.validateLocal(task)
            task.journal = { operation: 'rollback', at: Date.now() }
            await save()
          } })
          if (rolled.status === 'error') engineError(rolled)
          delete task.receipt
          delete task.journal
          task.phase = 'ready'
          await save()
          await this.unpin(task).catch(() => {})
        } else if (action === 'finalize' && task.phase === 'previewed' && task.receipt && task.review) {
          const done = await engine.finalize({ localPath: task.local.root, receipt: task.receipt, commitMessage: task.review.message, beforeCommit: async (commitOid, before, after) => {
            await this.validateLocal(task)
            const prefix = join(this.directory, `${task.id}-${task.receipt!.previewId}`)
            const indexBefore = `${prefix}.index-before`
            const indexAfter = `${prefix}.index-after`
            await saveArtifact(indexBefore, before)
            await saveArtifact(indexAfter, after)
            task.journal = { operation: 'finalize', at: Date.now(), commitOid, indexBefore, indexAfter }
            await save()
            await this.pin(task, [commitOid], 'commit')
          } })
          if (done.status === 'error') engineError(done)
          task.phase = 'delivered'
          task.commitOid = done.commitOid
          const journal = task.journal as Task['journal']
          delete task.journal
          // Persist delivery independently before cleanup can do anything destructive.
          await save()
          for (const file of [journal?.indexBefore, journal?.indexAfter]) {
            if (file) await rm(file, { force: true }).catch(() => {})
          }
          try {
            await this.cleanup(task, task.receipt.isolatedFingerprint, save)
          } catch (error) {
            throw new Error(`已提交 ${done.commitOid}，但未能确认 Worktree 清理完成：${errText(error)}`, { cause: error })
          }
          await this.unpin(task).catch(() => {})
        } else throw new Error('当前阶段不允许此操作。')
      } catch (error) {
        throw new Error(task.journal ? `${errText(error)}；已停用自动操作，恢复记录：${this.statePath}` : errText(error), { cause: error })
      }
      return task
    })
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

  private async cleanup(task: Task, expected: string, save: () => Promise<void>) {
    const retained = async (reason: string) => { task.cleanup = { status: 'retained', reason }; await save() }
    await save() // The confirmed terminal phase is durable even if cleanup is skipped.
    try {
      const processCwd = await realpath(process.cwd())
      if (processCwd === task.isolatedPath || processCwd.startsWith(task.isolatedPath + '/')) {
        throw new Error('Pi 进程仍从此 Worktree 启动，保留目录。')
      }
      await this.validateLocal(task)
      await this.validateIsolated(task)
      const listed = (await runGit(task.local.root, ['worktree', 'list', '--porcelain', '-z'])).stdout.toString('utf8')
      const entry = listed.split('\0\0').find(record => record.split('\0')[0] === `worktree ${task.isolatedPath}`)
      if (!entry || entry.split('\0').some(field => /^(locked|prunable)( |$)/.test(field))) throw new Error('Worktree 未注册、已锁定或可被修剪。')
      task.journal = { operation: 'cleanup', at: Date.now() }
      await save()
      if (await this.discardFingerprint(task) !== expected) throw new Error('隔离 Worktree 在确认后已变化。')
      const ignored = await runGit(task.isolatedPath, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])
      if (ignored.stdout.length) throw new Error('隔离 Worktree 有被 Git 忽略的文件；为避免丢失，保留整个 Worktree。')
      const marker = await lstat(join(task.isolatedPath, '.git'))
      if (!marker.isFile()) throw new Error('不是受管的 linked Worktree。')
      const visit = async (dir: string) => {
        const children = await readdir(dir, { withFileTypes: true })
        if (!children.length) throw new Error('隔离 Worktree 有 Git 无法快照的空目录；保留整个 Worktree。')
        for (const child of children) {
          if (child.name.toLowerCase() === '.git') {
            if (dir === task.isolatedPath && child.name === '.git') continue
            throw new Error('Worktree 中有嵌套的 Git 元数据。')
          }
          if (child.isDirectory()) await visit(join(dir, child.name))
          else if (!child.isFile() && !child.isSymbolicLink()) throw new Error('Worktree 中有 Git 无法快照的特殊文件。')
        }
      }
      await visit(task.isolatedPath)
    } catch (error) {
      delete task.journal
      await retained(errText(error))
      return
    }
    // If removal fails or is interrupted, deliberately leave the cleanup journal.
    await runGit(task.local.root, ['worktree', 'remove', '--force', '--', task.isolatedPath])
    task.cleanup = { status: 'done' }
    delete task.journal
    await save()
  }
}

export function shortSessionName(id: string) { return `Worktree ${id.slice(0, 8)}` }
