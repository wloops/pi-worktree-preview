import { CURRENT_SESSION_VERSION, getAgentDir, SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type InputEvent, type SessionEntry } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { MAX_COMMIT_BODY } from './commit-message.ts'
import { checkout, PreviewConflict, shortSessionName, TaskStore, type Action, type AdoptionInspection, type AdoptionRequest, type SessionLink, type Task } from './store.ts'
import { commandActions, parseWorktreeCommand, type ActionVerb } from './commands.ts'
import { clean, pick, toolbar, withLoading, type Choice, type ToolbarChoice } from './ui.ts'

const NAME = 'worktree-preview'
const TOOL = 'worktree_ready_for_review'
const REVISE = 'worktree_begin_revision'
const FOLLOW_UP = 'worktree_start_follow_up'
const HISTORY_VIEW = `${NAME}-history-view`
const HISTORY_DIR = 'history-views'
const HISTORY_HINT = '历史对话 · 只读'
const historyReadTools = new Set(['read', 'grep', 'find', 'ls'])
// Native session replacement reloads the extension. Share only the transient
// delivery lock across the two instances, not UI or session contexts.
const deliveryKey = Symbol.for('pi-worktree-preview.pending-delivery-views')
const deliveryState = globalThis as typeof globalThis & { [deliveryKey]?: Set<string> }
const pendingDelivery = deliveryState[deliveryKey] ??= new Set<string>()
const delivering = (ctx: ExtensionContext) => pendingDelivery.has(ctx.sessionManager.getSessionFile() ?? '')
const guardedTools = new Set(['edit', 'write', 'bash', 'powershell', TOOL])
const labels: Record<Action, string> = {
  preview: '预览改动', rollback: '撤回预览', finalize: '确认提交',
  commit_ready: '跳过预览，直接提交', discard: '放弃任务',
}
const confirmationCopy: Record<Action, { title: string; lead: string; button: string }> = {
  preview: { title: '预览改动？', lead: '改动写入项目目录，不暂存、不提交。', button: '预览' },
  rollback: { title: '撤回预览？', lead: '只还原本次预览。', button: '撤回' },
  finalize: { title: '提交本次预览？', lead: '只提交任务改动。', button: '提交并安全清理' },
  commit_ready: { title: '跳过预览，直接提交？', lead: '写入项目目录并提交。', button: '提交并安全清理' },
  discard: { title: '放弃任务？', lead: '安全检查通过后删除隔离目录，项目目录不变。', button: '放弃' },
}
const completed: Record<Action, string> = {
  preview: '改动已写入项目目录，未暂存、未提交。', rollback: '已撤回本次预览。',
  finalize: '已提交本次预览', commit_ready: '已直接提交本次任务', discard: '任务已放弃，项目目录未改动。',
}
const progress: Record<Action, string> = {
  preview: '正在写入预览改动…', rollback: '正在撤回预览…', finalize: '正在提交预览…',
  commit_ready: '正在直接提交…', discard: '正在放弃任务并检查清理…',
}
type MenuAction = Action | 'arm' | 'resume' | 'history' | 'retained' | 'return' | 'mark' | 'scope' | 'recover' | 'close'
const phases = { creating: '创建中断', working: '进行中', ready: '待验收', previewed: '已预览', delivered: '已交付', discarded: '已放弃' }
const message = (e: unknown) => clean(e instanceof Error ? e.message : String(e))
function taskSummary(text: string) {
  // A pasted screenshot can precede the actual request, on the same line or above it.
  const attachment = /^(?:@?(?:\/|~\/|\.\.?\/).+?\.(?:png|jpe?g|webp|gif|bmp|heic)|\[Image[^\]]*\])(?:\s+|$)/iu
  const line = text.split(/\r?\n/u).map(line => line.trim().replace(attachment, '').trim()).find(Boolean)
  if (!line) return undefined
  const chars = Array.from(clean(line.replace(/\s+/gu, ' ')))
  return chars.length > 48 ? `${chars.slice(0, 48).join('')}…` : chars.join('')
}
function sessionLink(ctx: ExtensionContext): SessionLink | undefined {
  const file = ctx.sessionManager.getSessionFile()
  if (file) return { file, id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd }
}
function isBoundSession(ctx: ExtensionContext, target?: SessionLink) {
  const link = sessionLink(ctx)
  return !!link && !!target && link.id === target.id && link.file === target.file && link.cwd === target.cwd
}
const isOpenTask = (task: Task) => !!task.journal || !['delivered', 'discarded'].includes(task.phase)
const sessionBusy = '原对话已有未完成的任务或恢复记录；可新开对话并行开发。'
function currentTask(ctx: ExtensionContext, isolated: Task | undefined, tasks: Task[]) {
  if (isolated) return isBoundSession(ctx, isolated.isolatedSession) ? isolated : undefined
  const own = tasks.filter(task => isBoundSession(ctx, task.localSession))
  return own.find(isOpenTask) ?? own[0]
}
function deliveryChoices(task: Task | undefined): Choice<Action>[] {
  if (!task || task.journal) return []
  if (task.phase === 'ready') return [{ label: labels.preview, value: 'preview', tone: 'primary' }]
  if (task.phase === 'previewed') return [{ label: labels.finalize, value: 'finalize', tone: 'primary' }, { label: labels.rollback, value: 'rollback' }]
  return []
}
const localCheck = { label: '打开项目目录检查', value: 'return' } as const
const retainedChoice = { label: '已保留的 Worktree', value: 'retained' } as const
const historyChoice = { label: '任务历史', value: 'history' } as const
const recoverChoice = { label: '让 Agent 继续解决冲突', value: 'recover', tone: 'primary' } as const
const resumeChoice = { label: '进入 / 恢复 Worktree', value: 'resume' } as const
const scopeChoice = { label: '调整交付清单', value: 'scope' } as const

async function chooseReviewFiles(ctx: ExtensionContext, files: readonly string[], narrow: boolean, initial = narrow ? files : []) {
  if (!files.length) throw new Error('没有可验收的 Git 改动。')
  const selected = new Set(initial.filter(path => files.includes(path)))
  const choices: Choice<boolean>[] = files.map(path => ({
    get label() { return `[${selected.has(path) ? 'x' : ' '}] ${JSON.stringify(path)}` },
    value: false,
    toggle() { if (!selected.delete(path)) selected.add(path) },
  }))
  const apply = await pick(ctx, narrow ? '调整交付清单' : '选择交付文件', [
    narrow ? '取消勾选即可移除文件；保留文件的验收内容不变。' : '只勾选本次任务要交付的文件。',
    '保存只更新验收清单，不会写入项目目录。',
  ], [...choices, { label: '保存交付清单', value: true, tone: 'primary' }, { label: '取消', value: false, tone: 'quiet' }])
  if (!apply) return
  if (!selected.size) throw new Error('请选择至少一个要交付的改动文件。')
  return files.filter(path => selected.has(path))
}

function phaseLabel(isolated: boolean, task?: Task) {
  const scope = isolated ? 'Worktree' : '原对话'
  if (!task) return scope
  const phase = task.journal ? '恢复记录：已停止' : phases[task.phase]
  return `${scope} · ${isolated ? '' : 'Worktree '}${phase}`
}
function phaseTone(task?: Task) {
  if (task?.journal || task?.phase === 'creating') return 'danger'
  if (task?.recovery && task.phase === 'working' || task?.phase === 'previewed') return 'warning'
  if (task?.phase === 'delivered') return 'success'
  return 'normal'
}

function conflictPrompt(recovery: NonNullable<Task['recovery']>) {
  return `只在当前 detached Worktree 解决冲突，不写 Local。若未开始，先将已验收改动提交为 checkpoint，再运行 git -c core.hooksPath=/dev/null -c rerere.enabled=false -c merge.renames=false -c merge.directoryRenames=false merge --no-edit --no-autostash --no-overwrite-ignore ${recovery.localHeadOid}。已在合并中就继续，已合并就不要重做。只解决 Git 报出的冲突，保留其余自动合并结果；提交时禁用 Git hooks。只跑相关测试，再用 ${TOOL} 提交相对合并目标的完整任务文件清单；有歧义就停下问我，不要预览。`
}
const historyTasks = (tasks: Task[]) => tasks.filter(task =>
  ['delivered', 'discarded'].includes(task.phase) && !task.journal && task.isolatedSession?.cwd === task.isolatedPath)
const retainedTasks = (tasks: Task[]) => tasks.filter(task =>
  !task.external && ['delivered', 'discarded'].includes(task.phase) && !task.journal && task.cleanup?.status === 'retained')
const taskVersion = (task?: Task) => task && JSON.stringify([task.id, task.phase, task.review?.id, task.receipt?.previewId])
async function existing(file: string) {
  try { return (await lstat(file)).isFile() } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e }
}
async function isWorktreePath(root: string, path: string, cwd: string) {
  const within = (target: string) => {
    const name = relative(root, target)
    return !!name && name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name) && !name.toLowerCase().split(sep).includes('.git')
  }
  // Match Pi's leading @ and Unicode-space handling. Require a path rather
  // than Pi's optional home-relative or file-URL forms for mutators.
  const normalized = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ').replace(/^@/, '')
  if (normalized === '~' || normalized.startsWith('~/') || normalized.startsWith('file://')) return false
  let target = resolve(cwd, normalized)
  if (!within(target)) return false
  let checkingParent = false
  for (;;) {
    try {
      const actual = await realpath(target)
      return (checkingParent && actual === root) || within(actual)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // A dangling symlink is not a new file. Never authorize writes through it.
      try { await lstat(target); return false } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      if (target === root) return false
      target = dirname(target)
      checkingParent = true
    }
  }
}
// Pi 1.5 keeps the origin of a first-message Worktree in memory. Publish its
// own native header and entries, then reopen it so Pi knows the file is saved.
// Do not substitute a new session, or add a fake chat message to force a flush.
async function withSavedLocal(ctx: ExtensionCommandContext, run: (next: ExtensionCommandContext, send: (text: string) => unknown) => Promise<void>, initialName = '原对话 · Worktree 任务') {
  const source = sessionLink(ctx)
  if (!source) throw new Error('无有效的持久化 Pi 会话。')
  if (await existing(source.file)) { await run(ctx, () => {}); return }
  const header = ctx.sessionManager.getHeader()
  if (!header || header.id !== source.id || header.cwd !== source.cwd || header.version !== CURRENT_SESSION_VERSION) {
    throw new Error('无法保存原对话。')
  }
  const body = [header, ...ctx.sessionManager.getEntries()].map(entry => JSON.stringify(entry)).join('\n') + '\n'
  const dir = dirname(source.file)
  const stage = await mkdtemp(join(dir, '.worktree-origin-'))
  try {
    const staged = join(stage, 'session.jsonl')
    const fd = await open(staged, 'wx', 0o600)
    try {
      await fd.writeFile(body)
      if (!ctx.sessionManager.getSessionName()) SessionManager.open(staged).appendSessionInfo(initialName)
      await fd.sync()
    } finally { await fd.close() }
    const identity = await lstat(staged, { bigint: true })
    const undoPublication = async () => {
      const current = await lstat(source.file, { bigint: true })
      if (current.dev === identity.dev && current.ino === identity.ino && current.mtimeNs === identity.mtimeNs && current.size === identity.size) {
        await rm(source.file)
      }
    }
    await link(staged, source.file)
    try {
      const parent = await open(dir, 'r')
      try { await parent.sync() } finally { await parent.close() }
    } catch (error) {
      await undoPublication()
      throw error
    }
    const moved = await withLoading(ctx, '正在恢复原对话…', () => ctx.switchSession(source.file, { withSession: async next => {
      if (!isBoundSession(next, source) || !next.isIdle()) {
        next.ui.notify('未能恢复原对话；没有新建 Worktree。', 'error')
        return
      }
      await run(next, text => next.sendUserMessage(text, { expandPromptTemplates: true }))
    } }))
    if (moved.cancelled) {
      await undoPublication()
      throw new Error('Pi 取消了保存原对话。')
    }
  } finally { await rm(stage, { recursive: true }) }
}

type HistoryProof = { historyHash: string; historyLines?: number }
type HistoryView = HistoryProof & { priorId: string; returnTo: SessionLink; afterCommit?: true; leaf?: string }
const hashHistory = (lines: string[]) => createHash('sha256').update(lines.join('\n')).digest('hex')

async function readHistory(source: SessionLink) {
  if (!isAbsolute(source.file) || !await existing(source.file)) throw new Error('原 Pi 会话文件已不存在，无法续接。')
  const fd = await open(source.file, 'r')
  try {
    // Pi's open/forkFrom loader can repair a missing final newline in place.
    // Never hand it the original. Read a stable copy of the persisted tree;
    // preserve its entry links and let Pi select the last saved branch as usual.
    const before = await fd.stat({ bigint: true })
    const [first, ...body] = (await fd.readFile('utf8')).trimEnd().split('\n')
    const after = await lstat(source.file, { bigint: true })
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('原 Pi 会话在续接时已变化，请重试。')
    const parse = (line: string) => {
      try { return JSON.parse(line) } catch { throw new Error('原 Pi 会话内容已损坏，无法续接。') }
    }
    const header = parse(first)
    if (header?.type !== 'session' || header.id !== source.id || header.cwd !== source.cwd) {
      throw new Error('原 Pi 会话的身份或工作目录已变化。')
    }
    if (header.version !== CURRENT_SESSION_VERSION) throw new Error('原 Pi 会话格式版本不兼容，无法续接。')
    const ids = new Set<string>()
    let stateSuffixStart = 0
    for (const [i, line] of body.entries()) {
      if (!line.trim()) { stateSuffixStart = i + 1; continue }
      const entry = parse(line)
      if (typeof entry?.type !== 'string' || entry.type === 'session' || typeof entry.id !== 'string' ||
          ids.has(entry.id) || (entry.parentId !== null && !ids.has(entry.parentId))) {
        throw new Error('原 Pi 会话的历史链接不完整，无法续接。')
      }
      ids.add(entry.id)
      if (entry.type !== 'custom' || typeof entry.customType !== 'string' || !entry.customType) stateSuffixStart = i + 1
    }

    return { body, ids, stateSuffixStart, hash: hashHistory(body) }
  } finally { await fd.close() }
}

function matchesHistory(history: Awaited<ReturnType<typeof readHistory>>, proof: HistoryProof) {
  const n = proof.historyLines
  if (n === undefined) return history.hash === proof.historyHash
  // During native switch, shutdown hooks may append custom extension state.
  // Require the exact original prefix and permit only Pi's non-context `custom`
  // entries after it, never messages (including custom_message) or context edits.
  return n >= history.stateSuffixStart && n <= history.body.length && hashHistory(history.body.slice(0, n)) === proof.historyHash
}

// Publish a native child only after its header, history and metadata are written.
async function createChildSession(cwd: string, parent: SessionLink, body: string[], decorate: (sm: SessionManager) => void, sessionDir?: string): Promise<SessionLink> {
  const dir = SessionManager.create(cwd, sessionDir).getSessionDir()
  const staging = await mkdtemp(join(dir, '.worktree-follow-up-'))
  try {
    const child = SessionManager.create(cwd, staging, { parentSession: parent.file })
    const path = child.getSessionFile()!
    const out = await open(path, 'wx', 0o600)
    try { await out.writeFile([JSON.stringify(child.getHeader()), ...body, ''].join('\n')) } finally { await out.close() }
    const fork = SessionManager.open(path)
    decorate(fork)
    const copy = await open(path, 'r+')
    try { await copy.sync() } finally { await copy.close() }
    const file = join(dir, basename(path))
    await link(path, file)
    const directory = await open(dir, 'r')
    try { await directory.sync() } finally { await directory.close() }
    return { file, id: fork.getSessionId(), cwd: fork.getCwd() }
  } finally { await rm(staging, { recursive: true }) }
}

async function makeHistoryView(data: TaskStore, task: Task, returnTo: SessionLink, delivery?: { leaf: string | null }) {
  const source = task.isolatedSession
  if (!source || source.cwd !== task.isolatedPath) throw new Error('找不到原 Worktree 对话。')
  await data.validateLocalIdentity(task)
  const { body, ids, hash } = await readHistory(source)
  const leaf = delivery?.leaf ?? undefined
  if (leaf !== undefined && !ids.has(leaf)) throw new Error('当前对话分支尚未保存，无法保留对话。')
  const dir = join(data.directory, HISTORY_DIR)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const proof: HistoryProof = { historyHash: hash, ...(delivery ? { historyLines: body.length } : {}) }
  const target = await createChildSession(returnTo.cwd, source, body, sm => {
    if (leaf !== undefined) sm.branch(leaf)
    sm.appendSessionInfo(`${delivery ? 'Worktree · 任务对话' : '历史对话'} · ${task.review?.message ?? shortSessionName(task.id)}`)
    sm.appendCustomEntry(HISTORY_VIEW, { priorId: task.id, returnTo, ...proof, ...(delivery ? { afterCommit: true, leaf } : {}) } satisfies HistoryView)
  }, dir)
  return { target, source, proof }
}

type FollowUpHistory = { body: string[]; leaf: string | null }

function captureLocalBranch(ctx: ExtensionContext): string[] {
  // Use the live Pi leaf, not the last line on disk (which can be on an
  // abandoned branch after /tree). Copy conversation, not the old loadout
  // or extension state. Keep Pi's native compaction and context-edit links.
  const branch = ctx.sessionManager.getBranch()
  const entries = branch.flatMap<SessionEntry>(entry => {
    switch (entry.type) {
      case 'message': {
        const msg = entry.message
        if (msg.role === 'system' || msg.role === 'bashExecution' && msg.excludeFromContext) return []
        if (msg.role === 'toolResult' || msg.role === 'custom') return [{ ...entry, message: { ...msg, details: undefined } }]
        if (msg.role === 'bashExecution') return [{ ...entry, message: { ...msg, fullOutputPath: undefined } }]
        return [entry]
      }
      case 'custom_message': return [{ ...entry, details: undefined }]
      case 'compaction': return [{ ...entry, systemMessage: undefined, details: undefined }]
      case 'branch_summary': return [{ ...entry, details: undefined }]
      case 'context_edit': return [entry]
      default: return []
    }
  })
  const ids = new Set(entries.map(entry => entry.id))
  const retained = entries.filter(entry => entry.type !== 'context_edit' || ids.has(entry.targetId))
  const keptIds = new Set(retained.map(entry => entry.id))
  const nextKept = new Map<string, string>()
  let next: string | undefined
  for (let i = branch.length - 1; i >= 0; i--) {
    const { id } = branch[i]
    if (keptIds.has(id)) next = id
    if (next) nextKept.set(id, next)
  }
  let parentId: string | null = null
  const previous = new Set<string>()
  return retained.map(entry => {
    if (entry.type === 'compaction') {
      // If Pi anchored its kept range at removed metadata, start at the
      // next retained entry instead. Its own ID represents an empty range.
      const anchor = nextKept.get(entry.firstKeptEntryId)
      entry = { ...entry, firstKeptEntryId: anchor && previous.has(anchor) ? anchor : entry.id }
    }
    const line = JSON.stringify({ ...entry, parentId })
    parentId = entry.id
    previous.add(entry.id)
    return line
  })
}

function captureFollowUp(ctx: ExtensionContext, leaf: string | null): FollowUpHistory {
  if (!leaf) throw new Error('缺少原对话记录，未开启下一轮。')
  const entries = ctx.sessionManager.getEntries()
  const marker = entries.map(entry => entry.type === 'custom' ? entry.customType : undefined).lastIndexOf(HISTORY_VIEW)
  const end = entries.findIndex(entry => entry.id === leaf)
  if (marker < 0 || end < marker) throw new Error('无法保存当前对话分支，未开启下一轮。')
  const prefix = entries.slice(0, end + 1)
  const failedRouting = new Set<string>()
  let turnStart = marker + 1
  for (let i = turnStart; i < prefix.length; i++) {
    const entry = prefix[i]
    if (entry.type !== 'message') continue
    if (entry.message.role === 'user') turnStart = i
    if (entry.message.role === 'toolResult' && entry.message.toolName === FOLLOW_UP && !entry.message.isError) {
      // A previous attempt to switch may have failed. Do not carry that
      // routing turn into the new task alongside the retried user request.
      for (const routed of prefix.slice(turnStart, i + 1)) failedRouting.add(routed.id)
    }
  }
  const parentOf = new Map<string, string | null>()
  const body: string[] = []
  for (const [i, entry] of prefix.entries()) {
    const parentId = entry.parentId === null ? null : parentOf.get(entry.parentId) ?? null
    // Keep earlier Q&A, but let Pi restore the original Worktree loadout.
    const skip = i === marker || failedRouting.has(entry.id) || (i > marker && entry.type === 'message' && entry.message.role === 'system')
    parentOf.set(entry.id, skip ? parentId : entry.id)
    if (!skip) body.push(JSON.stringify({ ...entry, parentId }))
  }
  return { body, leaf: parentOf.get(leaf) ?? null }
}

async function forkWorktreeSession(cwd: string, task: Task, prior: Task, view: HistoryView, inherited: FollowUpHistory, name: string): Promise<SessionLink> {
  const source = prior.isolatedSession!
  const history = await readHistory(source)
  if (!matchesHistory(history, view) || (view.leaf !== undefined && !history.ids.has(view.leaf))) {
    throw new Error('原 Pi 会话在打开后已变化；请返回原对话后重新打开任务历史。')
  }
  // Carry the read-only Q&A without the routing turn. Keep later rounds under
  // their origin in Pi's picker, independently of where their history came from.
  return createChildSession(cwd, task.localSession, inherited.body, fork => {
    if (inherited.leaf !== null) fork.branch(inherited.leaf)
    fork.appendSessionInfo(name)
    fork.appendCustomMessageEntry(`${NAME}-follow-up`, [
      `New isolated task from Local's HEAD at creation (${task.baseOid}).`,
      `The prior task was ${prior.phase === 'delivered' ? 'delivered' : 'discarded'}.`,
      'Only conversation history was inherited, not the prior workspace or uncommitted changes. Treat old files, tool output, and paths as historical. Verify against the new cwd and follow the new request; do not resume the old task by default.',
    ].join(' '), false)
  })
}

type SwitchOptions = NonNullable<Parameters<ExtensionCommandContext['switchSession']>[1]>

async function validateSession(link: SessionLink) {
  if (!isAbsolute(link.file) || !await existing(link.file)) throw new Error(`Pi 会话文件不存在：${link.file}`)
  if (!(await lstat(link.cwd)).isDirectory()) throw new Error(`会话工作目录不存在：${link.cwd}`)
  const sm = SessionManager.open(link.file)
  if (sm.getSessionId() !== link.id || sm.getHeader()?.cwd !== link.cwd) throw new Error('会话身份或工作目录已变化。')
}

async function switchTo(ctx: ExtensionCommandContext, link: SessionLink, loading: string, withSession?: SwitchOptions['withSession']) {
  return withLoading(ctx, loading, async () => {
    await validateSession(link)
    return ctx.switchSession(link.file, { withSession })
  })
}

function restoreDraft(ctx: ExtensionContext, text: string) {
  const current = ctx.ui.getEditorText()
  ctx.ui.setEditorText(!current || current === text ? text : `${text}\n\n${current}`)
}

type Armed = { sessionId: string }
type Prompt = Pick<InputEvent, 'text' | 'images'> & Armed
type Draft = Prompt & { token: string; inherited?: FollowUpHistory }
type ClickIntent = { token: string; sessionId: string; taskVersion: ReturnType<typeof taskVersion>; choice: MenuAction }
type Confirmation = { token: string; expires: number; session: SessionLink } & (
  | { kind: 'adopt'; request: AdoptionRequest; shown: AdoptionInspection }
  | { kind: 'action'; task: Task; verb: ActionVerb; discardFingerprint?: string })
const standaloneCommands = [
  ['new', '', '下次发送时新建 Worktree'],
  ['status', '', '查看 Worktree 与验收状态'],
  ['resume', '', '进入关联的 Worktree 对话'],
  ['back', '', '返回原对话'],
  ['preview', '', '发起预览改动'],
  ['rollback', '', '发起撤回预览'],
  ['commit', '', '发起提交已预览的改动'],
  ['discard', '', '发起放弃任务或解除外部登记'],
  ['adopt', '', '接入当前 Worktree'],
  ['confirm', ' <确认码>', '确认待执行的操作'],
  ['cancel', '', '取消待确认操作或下次新建'],
] as const
const confirmationTTL = 5 * 60 * 1000
function adoptionDetails(shown: AdoptionInspection) {
  return [`来源：${JSON.stringify(shown.isolated.root)}`, `目标：${JSON.stringify(shown.local.root)} · ${JSON.stringify(shown.localHeadRef)}`,
    `候选起点：${shown.baseOid}`, `提交标题：${JSON.stringify(shown.review.message)}`]
}
function numberedAdoptionFiles(files: readonly string[]) {
  return files.map((file, index) => `${index + 1}. ${JSON.stringify(file)}`)
}
function commandNotice(ctx: ExtensionContext, kind: 'ok' | 'confirm' | 'error', text: string, summary?: string) {
  if (ctx.mode === 'rpc' && (summary || kind === 'error')) {
    const status = clean(summary ?? `Worktree：${text.split('\n')[0]}`)
    ctx.ui.setStatus(NAME, Array.from(status).slice(0, 110).join(''))
  }
  ctx.ui.notify(`${NAME} ${kind}: ${text}`, kind === 'error' ? 'error' : 'info')
}

function commandFiles(files: readonly string[], compact: boolean): string[] {
  return compact ? [`涉及 ${files.length} 个文件。`] : ['', `文件（${files.length}）：`, ...numberedAdoptionFiles(files)]
}

function commandActionDetails(task: Task, act: Action, compact: boolean): string {
  const { title, lead } = confirmationCopy[act]
  const externalDiscard = task.external && act === 'discard'
  const files = task.receipt?.changedFiles ?? task.review?.files ?? []
  return [externalDiscard ? '解除外部 Worktree 登记？' : title,
    externalDiscard ? '只解除登记，两个目录都不改动。' : lead,
    ...(task.external && !externalDiscard ? ['不修改或删除源目录。'] : act === 'finalize' ? ['提交后尝试安全清理；不会强制删除。'] : []),
    `目标：${JSON.stringify(task.local.root)} · ${JSON.stringify(task.localHeadRef)}`,
    `来源：${JSON.stringify(task.isolatedPath)}`,
    ...(task.external && act === 'preview' ? [`起点：${task.baseOid}`] : []),
    ...(act === 'finalize' && task.review ? [`提交标题：${JSON.stringify(task.review.message)}`,
      ...(task.review.body ? ['提交正文：', ...task.review.body.split('\n').map(clean)] : [])] : []),
    ...commandFiles(files, compact),
  ].join('\n')
}

async function confirmRemoval(ctx: ExtensionContext, data: TaskStore, task: Task, title: string) {
  const proof = await withLoading(ctx, '正在检查保留的 Worktree…', () => data.inspectRetainedRemoval(task, ctx.cwd))
  const remove = await pick(ctx, title, [
    '强删将永久移除此目录，包括未交付改动和忽略文件。',
    '目标目录：', task.isolatedPath,
    '先备份需要的文件，并关闭其他使用该目录的会话。',
    `原因：${task.cleanup?.reason ?? '保留环境'}`,
  ], [{ label: '确认强删 Worktree', value: true, tone: 'danger' }, { label: '保留 Worktree', value: false, tone: 'quiet' }],
  { tone: 'danger', requiredDetails: 3 })
  if (!remove || !ctx.isIdle()) return
  await withLoading(ctx, '正在删除 Worktree…', () => data.removeRetained(task.id, ctx.cwd, proof))
  ctx.ui.notify('Worktree 已删除；项目目录与对话历史未改动。', 'info')
}

export default function extension(pi: ExtensionAPI) {
  let store: TaskStore | undefined
  let busy = false
  let armed: Armed | undefined
  let historyView: HistoryView | null | undefined
  let historyCanFollowUp = false
  let pendingHistoryPrompt: Prompt | undefined
  let historyTurn: { prompt: Prompt; source: SessionLink; leaf: string | null; requested: boolean } | undefined
  let draft: Draft | undefined
  let clickIntent: ClickIntent | undefined
  let confirmation: Confirmation | undefined
  let commandAsk: AbortController | undefined
  let runningCommand = false
  let activeHold: { data: TaskStore; id: string } | undefined
  let pendingHold: { data: TaskStore; id: string } | undefined
  let incomingHoldFailed = false
  let revisionStopped = false
  let revising = false

  async function workspace(ctx: ExtensionContext) {
    const data = store ??= new TaskStore(join(await realpath(getAgentDir()), NAME))
    const cwd = await realpath(ctx.cwd).catch(() => ctx.cwd)
    const tasks = (await data.read()).tasks
    const isolated = tasks.find(task => !task.external && (task.isolatedPath === cwd || cwd.startsWith(task.isolatedPath + '/')))
    return { data, cwd, isolated, tasks }
  }

  async function context(ctx: ExtensionContext) {
    const { data, cwd, isolated, tasks } = await workspace(ctx)
    if (isolated) return { data, cwd, isolated, tasks: [] }
    let local: Awaited<ReturnType<typeof checkout>> | undefined
    try { local = await checkout(cwd) } catch { /* No Git checkout: no workflow entry. */ }
    const own = tasks.filter(task => task.local.root === local?.root || task.external && isBoundSession(ctx, task.localSession)).reverse()
    return { data, cwd, local, isolated, tasks: own }
  }

  // Find the adoption binding independently of cwd; the store checks source
  // identity before changing its review or preview state.
  const externalTask = (ctx: ExtensionContext, tasks: readonly Task[]) => tasks.find(task => task.external && isOpenTask(task) &&
    task.localSession.id === ctx.sessionManager.getSessionId() && task.localSession.file === ctx.sessionManager.getSessionFile())
  const editingTask = (ctx: ExtensionContext, state: Pick<Awaited<ReturnType<typeof workspace>>, 'isolated' | 'tasks'>) =>
    state.isolated ?? externalTask(ctx, state.tasks)
  const editingSession = (ctx: ExtensionContext, task: Task) => isBoundSession(ctx, task.external ? task.localSession : task.isolatedSession)
  const isBuiltin = (name: string) => pi.getAllTools().some(tool => tool.name === name && tool.sourceInfo.path === `builtin:${name}`)
  async function verifyExternalEditor(data: TaskStore, task: Task, link?: SessionLink) {
    if (!link || !await data.isEditingSession(task, link)) throw new Error('只能在绑定的 Worktree 源对话中返修。')
    await data.validateIsolatedIdentity(task)
  }

  const openMenu = () => pi.sendUserMessage(`/${NAME}`, { expandPromptTemplates: true })
  function installToolbar<T>(ctx: ExtensionContext, view: () => {
    status: Parameters<typeof toolbar<T>>[2]; buttons: ToolbarChoice<T>[]
  }, activate: (value: T) => void) {
    ctx.ui.setWidget(NAME, (_tui, theme) => {
      let hits: ReturnType<typeof toolbar<T>>['hits'] = []
      let pressed: (typeof hits)[number] | undefined
      return {
        invalidate() {},
        render(width) {
          const { status, buttons } = view()
          const layout = toolbar(theme, width, status, buttons)
          hits = layout.hits
          return layout.lines
        },
        handleMouse(event) {
          if (event.button !== 'left') return
          const hit = hits.find(({ row, from, to }) => event.y === row && event.x >= from && event.x < to)
          if (event.type === 'press') {
            pressed = hit
            if (hit) return { handled: true, render: false }
          }
          if (event.type === 'click') {
            const matches = hit && pressed && Object.is(hit.value, pressed.value) && hit.row === pressed.row && hit.from === pressed.from && hit.to === pressed.to
            pressed = undefined
            if (!matches) return
            if (busy || draft || clickIntent || !ctx.isIdle()) ctx.ui.notify('请等待当前操作结束。', 'warning')
            else activate(hit.value)
            return { handled: true }
          }
        },
      }
    })
  }

  async function refresh(ctx: ExtensionContext) {
    if (!ctx.hasUI || ctx.mode !== 'tui') return
    if (historyView !== undefined) {
      const view = historyView
      const pending = !!view?.afterCommit && delivering(ctx)
      historyCanFollowUp = false
      const prior = view?.afterCommit && !pending ? (await store!.read()).tasks.find(task => task.id === view.priorId) : undefined
      if (view && !pending) historyCanFollowUp = !view.afterCommit || !!prior && historyTasks([prior]).length === 1
      const canResume = !!prior?.isolatedSession && prior.phase !== 'delivered' && prior.phase !== 'discarded'
      installToolbar<'back' | 'resume'>(ctx, () => ({
        status: {
          label: !view ? '历史会话记录无效 · 请退出此会话' : pending ? '任务对话' : !view.afterCommit ? HISTORY_HINT :
            historyCanFollowUp ? `${prior?.phase === 'discarded' ? '已放弃' : '已交付'} · 只读对话` :
            prior?.journal ? '操作已停止 · 请检查恢复记录' : '任务对话 · 尚未交付',
          tone: view?.afterCommit && historyCanFollowUp ? 'success' : 'warning',
        },
        buttons: view && !pending ? [
          ...(canResume ? [{ label: '[ 回到 Worktree ]', value: 'resume' as const }] : []),
          { label: '[ 返回原对话 ]', value: 'back' },
        ] : [],
      }), choice => pi.sendUserMessage(`/${NAME} ${choice}`, { expandPromptTemplates: true }))
      return
    }
    const state = await context(ctx)
    if (!state.local && !state.isolated) { ctx.ui.setWidget(NAME, undefined); return }
    const active = currentTask(ctx, state.isolated, state.tasks)
    const direct: Choice<MenuAction>[] = deliveryChoices(active)
    if (state.isolated && active?.phase === 'previewed' && !active.journal) direct.push(localCheck)
    if (active?.phase === 'working' && active.recovery && !active.journal) direct.push(recoverChoice)
    else if (!state.isolated && active?.phase === 'working' && !active.journal && active.isolatedSession) {
      direct.push({ ...resumeChoice, tone: 'primary' })
    }
    const showCreate = !!state.local && (!active || !isOpenTask(active))
    const showMenu = (active && (state.isolated || isOpenTask(active))) || retainedTasks(state.tasks).length > 0
    const id = ctx.sessionManager.getSessionId()
    const selected = () => armed?.sessionId === id
    installToolbar<MenuAction | 'menu'>(ctx, () => ({
      status: state.isolated || active ? { label: phaseLabel(!!state.isolated, active), tone: phaseTone(active) } : undefined,
      buttons: [
        ...(showCreate ? [{ label: `[${selected() ? 'x' : ' '}] 新建 Worktree`, value: 'arm' as const, tone: 'primary' as const, checked: selected() }] : []),
        ...direct.map(({ label, ...choice }) => ({ ...choice, label: `[ ${label} ]` })),
        ...(historyTasks(state.tasks).length ? [{ label: '[ 任务历史 ]', value: 'history' as const }] : []),
        ...(showMenu ? [{ label: ' ⋯ 更多 ', value: 'menu' as const, trailing: true }] : []),
      ],
    }), choice => {
      if (choice === 'menu') openMenu()
      else {
        const token = randomUUID()
        clickIntent = { token, choice, sessionId: id, taskVersion: taskVersion(active) }
        pi.sendUserMessage(`/${NAME} ${token}`, { expandPromptTemplates: true })
      }
    })
  }

  // Pi changes its logical cwd without chdir. Coordinate managed sessions with
  // removal, including the interval between native switch and session_start.
  pi.on('session_before_switch', async (event, ctx) => {
    if (revising || commandAsk || delivering(ctx)) {
      if (ctx.hasUI) ctx.ui.notify('请等待当前操作结束。', 'warning')
      return { cancel: true }
    }
    try {
      if (pendingHold && pendingHold.id !== activeHold?.id) await pendingHold.data.releaseWorktree(pendingHold.id)
      pendingHold = undefined
      const file = event.targetSessionFile
      if (!file || !await existing(file)) return
      const data = store ??= new TaskStore(join(await realpath(getAgentDir()), NAME))
      const targetCwd = SessionManager.open(file).getHeader()?.cwd
      if (!targetCwd) return
      const path = await realpath(targetCwd)
      const target = (await data.read()).tasks.find(task => !task.external && (path === task.isolatedPath || path.startsWith(task.isolatedPath + '/')))
      if (target) {
        await data.holdWorktree(target.id)
        pendingHold = { data, id: target.id }
      }
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(message(error), 'error')
      return { cancel: true }
    }
  })
  pi.on('session_shutdown', async (event, ctx) => {
    confirmation = undefined
    commandAsk?.abort()
    try {
      if (event.reason === 'quit' && pendingHold && pendingHold.id !== activeHold?.id) await pendingHold.data.releaseWorktree(pendingHold.id)
      if (!activeHold || (event.reason !== 'quit' && event.reason !== 'resume')) return
      if (event.reason === 'resume' && event.targetSessionFile) {
        const targetCwd = SessionManager.open(event.targetSessionFile).getCwd()
        if (targetCwd === ctx.cwd) return
      }
      await activeHold.data.releaseWorktree(activeHold.id)
    } catch (error) { if (ctx.hasUI) ctx.ui.notify(message(error), 'warning') }
  })
  pi.on('session_start', async (_event, ctx) => {
    try {
      const data = store ??= new TaskStore(join(await realpath(getAgentDir()), NAME))
      const viewFile = ctx.sessionManager.getSessionFile()
      const ownView = !!viewFile && dirname(viewFile) === join(data.directory, HISTORY_DIR)
      if (ownView) {
        const marker = ctx.sessionManager.getEntries().reverse().find(entry => entry.type === 'custom' && entry.customType === HISTORY_VIEW)
        historyView = null // Fail closed even if a stale view is resumed out of band.
        const view = marker?.type === 'custom' ? marker.data as Partial<HistoryView> | undefined : undefined
        if (view?.returnTo?.cwd === ctx.cwd && typeof view.returnTo.id === 'string' && typeof view.returnTo.file === 'string' &&
            typeof view.priorId === 'string' && typeof view.historyHash === 'string' && /^[a-f0-9]{64}$/.test(view.historyHash) &&
            (view.afterCommit === undefined || view.afterCommit === true) && (view.leaf === undefined || typeof view.leaf === 'string') &&
            (view.historyLines === undefined || (view.afterCommit && Number.isSafeInteger(view.historyLines) && view.historyLines >= 0))) {
          historyView = view as HistoryView
        }
        await refresh(ctx)
        return
      }
      const path = await realpath(ctx.cwd).catch(() => ctx.cwd)
      const isolated = (await data.read()).tasks.find(task => !task.external && (path === task.isolatedPath || path.startsWith(task.isolatedPath + '/')))
      if (isolated) {
        // Native startup can reach a managed cwd while another Pi deletes it.
        incomingHoldFailed = true
        await data.holdWorktree(isolated.id)
        activeHold = { data, id: isolated.id }
        incomingHoldFailed = false
      }
      await refresh(ctx)
    } catch (error) { if (ctx.hasUI) ctx.ui.notify(message(error), 'error') }
  })
  pi.on('input', (event, ctx) => {
    if (incomingHoldFailed) {
      if (ctx.hasUI && (event.source === 'interactive' || event.source === 'rpc')) restoreDraft(ctx, event.text)
      if (ctx.hasUI) ctx.ui.notify('无法确认 Worktree 会话占用，请退出后重试。', 'error')
      return { action: 'handled' }
    }
    const history = historyView !== undefined
    if (revising || runningCommand || delivering(ctx) && !history) {
      if (ctx.hasUI) { restoreDraft(ctx, event.text); commandNotice(ctx, 'error', '操作尚未结束；消息未发送。') }
      return { action: 'handled' }
    }
    if (history && (!historyView || event.source !== 'interactive' || !ctx.hasUI)) return { action: 'handled' }
    if ((event.source !== 'interactive' && event.source !== 'rpc') || !ctx.hasUI || (!event.text.trim() && !event.images?.length)) return
    if (history && !historyCanFollowUp) {
      restoreDraft(ctx, event.text)
      ctx.ui.notify(delivering(ctx) ? '请等待提交操作结束；消息未发送。' : '目前不能从此处继续。请回到 Worktree，或检查恢复记录。', 'warning')
      return { action: 'handled' }
    }
    confirmation = undefined // Task input invalidates earlier approval.
    const sessionId = ctx.sessionManager.getSessionId()
    // Pi handles UI/extension commands outside this hook. Keep task prompts,
    // including skills, templates, and pasted paths, as raw input until switch.
    if (!history && armed?.sessionId !== sessionId) return
    if (busy || draft || historyTurn || !ctx.isIdle() || event.streamingBehavior) {
      restoreDraft(ctx, event.text)
      if (ctx.mode === 'rpc') commandNotice(ctx, 'error', '请等待当前操作结束再发送；消息未发送。')
      else ctx.ui.notify('请等待当前操作结束再发送；消息未发送。', 'warning')
      return { action: 'handled' }
    }
    const prompt = { sessionId, text: event.text, images: event.images }
    if (history) {
      pendingHistoryPrompt = prompt
      return { action: 'continue' }
    }
    const token = randomUUID()
    draft = { ...prompt, token }
    // Only commands can replace a session. Wait for input preflight to unwind and
    // pass just a nonce to the command, never the message text or attachments.
    setImmediate(() => { if (draft?.token === token) pi.sendUserMessage(`/${NAME} ${token}`, { expandPromptTemplates: true }) })
    return { action: 'handled' }
  })
  pi.on('session_before_fork', () => historyView !== undefined ? { cancel: true } : undefined)
  pi.on('session_before_compact', () => historyView !== undefined ? { cancel: true } : undefined)
  // Tree navigation can run a summary and change the context silently.
  pi.on('session_before_tree', () => historyView !== undefined ? { cancel: true } : undefined)
  pi.on('user_bash', (_event, ctx) => {
    if (historyView === undefined) return
    const output = '历史对话不执行 shell；请返回原对话。'
    if (ctx.hasUI) ctx.ui.notify(output, 'warning')
    return { result: { output, exitCode: 1, cancelled: false, truncated: false } }
  })
  const canReadInHistory = (name: string) => historyReadTools.has(name) && isBuiltin(name)

  pi.on('before_agent_start', async (event, ctx) => {
    if (historyView !== undefined) {
      const prompt = pendingHistoryPrompt
      pendingHistoryPrompt = undefined
      const source = sessionLink(ctx)
      if (!prompt || prompt.sessionId !== source?.id || event.messageType !== 'user' || !historyCanFollowUp || delivering(ctx)) {
        ctx.abort()
        return
      }
      historyTurn = { prompt, source, leaf: ctx.sessionManager.getLeafId(), requested: false }
      event.systemPromptOptions.selectedTools = [...pi.getActiveTools().filter(canReadInHistory), FOLLOW_UP]
      return
    }
    revisionStopped = false
    const state = await workspace(ctx).catch(() => undefined)
    const task = state && editingTask(ctx, state)
    if (!task) return
    const canWork = editingSession(ctx, task) && !task.journal && ['working', 'ready', 'previewed'].includes(task.phase) &&
      (!task.external || await state!.data.isEditingSession(task, sessionLink(ctx)!).catch(() => false))
    const guidance = canWork && task.external
      ? `Status: ${task.phase}. For requested edits in ready or previewed state, call ${REVISE} alone and wait for success; on cancellation stop. If already working, continue directly. After editing and testing, call ${TOOL} alone with the exact paths for the current task, including earlier changes still intended for delivery and any newly relevant paths. Exclude unrelated files. For discussion, leave the review unchanged.`
      : canWork
      ? `Status at the start of this request: ${task.phase}. For questions, explanations, and discussion, use read-only tools; do not invalidate a review or ask to roll back. If the user actually requests changes after a review was marked ready (including when a Local preview is active), call ${REVISE} alone before editing or running shell commands. The tool handles any required user confirmation. Wait for its success, then implement the existing request yourself in this Worktree, in the same turn, without asking the user to repeat it. If cancelled or unsuccessful, do not edit or retry unless asked again. After verifying, call ${TOOL} with a short commit title and only the exact repo-relative paths for the entire task, including earlier rounds and both sides of renames. Never blindly submit git status or include unrelated runtime/generated files. Then stop editing.`
      : task.external ? 'This session can run acceptance commands but is not bound to the source Worktree for revision or review.' :
        'This session or task is not editable. Use it for inspection only; do not modify files or mark it ready.'
    const ownership = task.external ? 'This is an adopted external Git worktree. Work in the source checkout, not the delivery target.' :
      'This is a managed isolated Git worktree. Work only in the active Worktree cwd.'
    const delivery = task.external ? 'The user controls the plugin’s preview, rollback, delivery and discard actions.' :
      'Do not write to Local yourself; the user alone controls preview, rollback, delivery and discard.'
    return { systemPrompt: `${event.systemPrompt}\n\n${ownership} ${guidance} ${delivery}` }
  })
  // In managed Worktrees, keep built-in mutators behind the revision step,
  // including sibling calls while confirmation is open.
  pi.on('tool_call', async (event, ctx) => {
    if (historyView !== undefined) {
      if (historyTurn && !historyTurn.requested && !event.parentToolCallId && canReadInHistory(event.toolName)) return
      if (event.toolName === FOLLOW_UP && historyTurn && !historyTurn.requested && !event.parentToolCallId) {
        const last = ctx.sessionManager.getBranch().reverse().find(entry => entry.type === 'message' && entry.message.role === 'assistant')
        if (last?.type === 'message' && last.message.role === 'assistant') {
          const calls = last.message.content.filter(part => part.type === 'toolCall')
          if (calls.length === 1 && calls[0].id === event.toolCallId && calls[0].name === FOLLOW_UP) return
        }
        return { block: true, reason: 'Call the follow-up tool by itself.' }
      }
      return { block: true, reason: '历史对话只读，不执行修改或 shell。' }
    }
    if (event.toolName === FOLLOW_UP) return { block: true, reason: 'Only available in ended task conversations.' }
    if (canReadInHistory(event.toolName)) return
    const workflowTool = event.toolName === TOOL || event.toolName === REVISE
    // An adopted Worktree remains under the host client's tool policy. Only
    // intercept its own workflow tools, not the client's workspace tools.
    if (!workflowTool && ((!activeHold && !incomingHoldFailed) || !guardedTools.has(event.toolName))) return
    let state: Awaited<ReturnType<typeof workspace>>
    try { state = await workspace(ctx) }
    catch (error) { return { block: true, reason: `无法核对 Worktree 状态：${message(error)}` } }
    const task = editingTask(ctx, state)
    if (!activeHold && !incomingHoldFailed && !task?.external) return
    const assistant = ctx.sessionManager.getBranch().reverse().find(entry => entry.type === 'message' && entry.message.role === 'assistant')
    const calls = assistant?.type === 'message' && assistant.message.role === 'assistant'
      ? assistant.message.content.filter(part => part.type === 'toolCall') : []
    if ((calls.length > 1 && calls.some(call => call.name === TOOL || call.name === REVISE)) ||
        (event.parentToolCallId && (event.toolName === TOOL || event.toolName === REVISE))) {
      return { block: true, reason: `${REVISE} 和 ${TOOL} 都必须单独调用，不可与其他工具批量执行。` }
    }
    if (event.toolName === REVISE) return
    const canRefreshReview = task?.external && task.phase === 'ready' && event.toolName === TOOL
    if (task && (task.phase === 'working' || canRefreshReview) && !task.journal &&
        !revising && !revisionStopped && !incomingHoldFailed && editingSession(ctx, task)) {
      if ((event.toolName === 'edit' || event.toolName === 'write') &&
          (typeof event.input.path !== 'string' || !await isWorktreePath(task.isolatedPath, event.input.path, ctx.cwd))) {
        return { block: true, reason: '只允许编辑当前 Worktree 内的文件。' }
      }
      return
    }
    const reason = !revisionStopped && task && !task.journal && editingSession(ctx, task) &&
        ['ready', 'previewed'].includes(task.phase)
      ? `当前处于验收阶段。如果用户要求改动，先单独调用 ${REVISE}；如果只是讨论，请用只读工具。`
      : '当前会话不允许编辑或执行 shell；请勿绕过。'
    return { block: true, reason }
  })
  pi.registerTool({
    name: FOLLOW_UP, label: '开启下一轮 Worktree', defaultActive: false, exposure: 'model-only', executionMode: 'sequential',
    description: 'Answer or clarify here read-only; call this tool alone only if the user explicitly asks for project changes.',
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      const turn = historyTurn
      if (!turn || !historyCanFollowUp || delivering(ctx) || turn.requested || !isBoundSession(ctx, turn.source) || signal?.aborted) {
        return { content: [{ type: 'text', text: '未开启下一轮。' }], details: {}, isError: true }
      }
      turn.requested = true
      return { content: [{ type: 'text', text: '将在新 Worktree 继续。' }], details: {}, terminate: true }
    },
  })
  pi.on('agent_settled', async (event, ctx) => {
    const turn = historyTurn
    historyTurn = undefined
    if (!turn?.requested || !isBoundSession(ctx, turn.source)) return
    if (event.aborted) {
      restoreDraft(ctx, turn.prompt.text)
      return
    }
    const token = randomUUID()
    // Capture only what preceded this turn. Most recent on disk includes the
    // decision tool call/result; they must never become the next task prompt.
    try {
      draft = { ...turn.prompt, token, inherited: captureFollowUp(ctx, turn.leaf) }
      pi.sendUserMessage(`/${NAME} ${token}`, { expandPromptTemplates: true })
    } catch (error) {
      draft = undefined
      restoreDraft(ctx, turn.prompt.text)
      ctx.ui.notify(message(error), 'error')
    }
  })
  pi.registerTool({
    name: REVISE, label: '开始返修', executionMode: 'sequential',
    description: 'Call alone only for requested edits, not discussion. Wait for any required approval and rollback; on success continue the same request, on failure stop.',
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      const result = (ok: boolean, text: string) => ({ content: [{ type: 'text' as const, text }], details: { ok }, isError: !ok })
      if (busy || revisionStopped) return result(false, '不能开始返修。请勿编辑，也不要在本轮重试。')
      busy = true
      revising = true
      try {
        signal?.throwIfAborted()
        const state = await workspace(ctx)
        const task = editingTask(ctx, state)
        const { data } = state
        const link = sessionLink(ctx)
        const resuming = task?.external && task.phase === 'working'
        const rollingBack = task?.phase === 'previewed' && !!task.receipt
        if (incomingHoldFailed || !task || !link || !editingSession(ctx, task) || task.journal ||
            (!resuming && (!task.review || (task.phase !== 'ready' && !rollingBack)))) {
          throw new Error('当前不在可返修的 Worktree 验收状态。')
        }
        if (task.external) await verifyExternalEditor(data, task, link)
        signal?.throwIfAborted()
        if (rollingBack) {
          const title = '返修前需撤回项目目录的预览'
          const accept = '撤回预览，继续返修'
          const detail = ['撤回后，Agent 会接着处理刚才的要求。',
            '预览文件若已被修改，将停止并保留现场。', `项目目录：${JSON.stringify(task.local.root)}`]
          let confirmed: boolean | undefined
          if (ctx.hasUI && ctx.mode === 'tui') {
            confirmed = await pick(ctx, title, detail, [
              { label: accept, value: true, tone: 'primary' }, { label: '取消', value: false, tone: 'quiet' },
            ], { signal, tone: 'warning' })
          } else if (ctx.hasUI && ctx.mode === 'rpc') {
            const ask = new AbortController()
            const approvalSignal = signal ? AbortSignal.any([signal, ask.signal]) : ask.signal
            commandAsk = ask
            const expires = Date.now() + confirmationTTL
            try {
              const choice = await ctx.ui.select([title, ...detail,
                `涉及 ${task.receipt!.changedFiles.length} 个文件。`].join('\n'),
                ['取消', accept], { signal: approvalSignal, timeout: confirmationTTL })
              confirmed = choice === accept && !approvalSignal.aborted && Date.now() < expires
            } finally { if (commandAsk === ask) commandAsk = undefined }
          } else throw new Error(`请先运行 /${NAME}-rollback 并确认，再重试修改。`)
          signal?.throwIfAborted()
          if (!confirmed) throw new Error('未确认撤回，预览保留。')
        }
        if (rollingBack) {
          await withLoading(ctx, progress.rollback, () => data.act(task.id, 'rollback', {
            phase: task.phase, reviewId: task.review!.id, previewId: task.receipt!.previewId, revision: { session: link, signal }, session: link,
          }))
        } else if (resuming) {
          await withLoading(ctx, '正在检查返修状态…', () => data.resumeExternalEditing(task.id, link, signal))
        } else {
          await withLoading(ctx, '正在准备返修…', () => data.continueEditing(task.id, link, task.review!.id, signal))
        }
        if (task.external && ctx.mode === 'rpc') ctx.ui.setStatus(NAME, 'Worktree 返修中')
        return result(true, '已进入返修。请现在继续处理用户刚才的修改要求，只改本 Worktree，验证后重新标记待验收。')
      } catch (error) {
        revisionStopped = true
        return result(false, `${message(error)} 不要编辑，也不要在本轮重试。`)
      } finally {
        await refresh(ctx).catch(() => {})
        revising = false
        busy = false
      }
    },
  })
  pi.registerTool({
    name: TOOL, label: '标记待验收', executionMode: 'sequential', description: 'Mark the current Worktree ready for user review. Does not write to Local or commit. Call after edits and tests.',
    parameters: Type.Object({
      commitMessage: Type.String({ description: 'A one-line commit title (1–200 characters). Follow the language of the current task conversation, not UI labels, tool output, or automatic recovery instructions. Honor any explicit title or language requested by the user.' }),
      commitBody: Type.Optional(Type.String({ maxLength: MAX_COMMIT_BODY, description: 'Optional commit body, without the title. Add only necessary details, such as why the change was made, important behavior, or compatibility impact. Use the title language unless the user requests otherwise. Omit when the title is enough.' })),
      files: Type.Array(Type.String(), { minItems: 1, description: 'Exact repo-relative paths intentionally changed for this task, including deletions and both sides of a rename. Exclude unrelated runtime state and test artifacts.' }),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (signal?.aborted) throw new Error('已取消。')
      const state = await workspace(ctx)
      const link = sessionLink(ctx)
      const task = editingTask(ctx, state)
      if (!task || !link || !editingSession(ctx, task) || task.external && !await state.data.isEditingSession(task, link)) {
        throw new Error('只能在绑定的 Worktree 源对话中标记待验收。')
      }
      const review = await withLoading(ctx, '正在标记待验收…', () =>
        state.data.markReady(task.id, link, params.commitMessage, params.files, { body: params.commitBody,
          ...(task.external ? { expectedReview: { id: task.review?.id } } : {}) }))
      await refresh(ctx)
      const next = ctx.mode === 'rpc' ? `可运行 /${NAME}-preview。` : '可点击「预览改动」。'
      if (ctx.mode === 'rpc' && task.external) ctx.ui.setStatus(NAME, `Worktree 待验收 · ${review.files.length} 个文件 · /${NAME}-preview`)
      return { content: [{ type: 'text', text: `已标记待验收（${review.files.length} 个文件）；未修改项目目录。${next}` }], details: { reviewId: review.id } }
    },
  })

  async function sendInNewWorktree(ctx: ExtensionCommandContext, { text, images, sessionId, inherited }: Draft) {
    let replaced = false
    const view = historyView
    const summary = taskSummary(text)
    const create = async (current: ExtensionCommandContext, send: (text: string) => unknown, localBranch: string[] = []) => {
      let entered = false
      try {
        const { local, isolated, tasks, data } = await context(current)
        if (!local || isolated) throw new Error('只能从原 Git 项目目录新建 Worktree。')
        if (process.platform === 'win32') throw new Error('当前版本仅支持 macOS/Linux。')
        const active = sessionLink(current)
        if (!active || view === null) throw new Error('无有效的持久化 Pi 会话，不能新建 Worktree。')
        const source = view?.returnTo ?? active
        if (tasks.some(task => task.localSession.id === source.id && task.localSession.file === source.file &&
            task.localSession.cwd === source.cwd && isOpenTask(task))) throw new Error(sessionBusy)
        const created = await withLoading(current, '正在创建 Worktree…', async () => {
          await validateSession(source)
          if (view && !inherited) throw new Error('缺少续接对话记录。')
          return data.create(local, source, (path, task, prior) => {
            const name = summary ? `Worktree · ${summary}` : shortSessionName(task.id)
            return prior && view && inherited
              ? forkWorktreeSession(path, task, prior, view, inherited, name)
              : createChildSession(path, task.localSession, localBranch, sm => {
                sm.appendSessionInfo(name)
                if (localBranch.length) sm.appendCustomMessageEntry(`${NAME}-local-context`, [
                  `New isolated task from the source checkout's HEAD at creation (${task.baseOid}).`,
                  'Only conversation history was inherited, not uncommitted changes or workspace state.',
                  'Use prior discussion to understand the new request. Treat earlier tool output and paths as historical; check the new cwd and work only there.',
                ].join(' '), false)
              })
          }, view?.priorId)
        })
        const target = created.isolatedSession!
        if (!view && current === ctx && summary && !ctx.sessionManager.getSessionName()) {
          // An already-persisted unnamed origin does not pass through the bootstrap above.
          // A display-name write must not block entering an already-created task.
          try { pi.setSessionName(`原对话 · ${summary}`) } catch { /* optional metadata */ }
        }
        const result = await switchTo(current, target, '正在进入 Worktree…', async next => {
          entered = replaced = true
          try {
            if (!isBoundSession(next, target)) throw new Error('Pi 未进入预期的隔离 Worktree。')
            if (view) await rm(active.file, { force: true }).catch(() => {})
            if (next.mode === 'rpc') commandNotice(next, 'ok', `已进入 Worktree ${JSON.stringify(target.cwd)} · ${target.id}`)
            await next.sendUserMessage(images?.length ? [{ type: 'text', text }, ...images] : text, { expandPromptTemplates: true })
          } catch (error) {
            restoreDraft(next, text)
            const detail = `无法在 Worktree 发送消息：${message(error)}${images?.length ? '；请重新附加图片。' : ''}`
            if (next.mode === 'rpc') commandNotice(next, 'error', detail)
            else next.ui.notify(detail, 'error')
          }
        })
        if (result.cancelled) throw new Error(`Pi 取消了切换；${view ? '返回原对话后，' : ''}可从工作台恢复已创建的 Worktree。`)
      } catch (error) {
        if (!entered && current !== ctx) {
          restoreDraft(current, text)
          const detail = `消息未发送：${message(error)}${images?.length ? '；请重新附加图片。' : ''}`
          if (current.mode === 'rpc') commandNotice(current, 'error', detail)
          else {
            current.ui.notify(detail, 'error')
            await send(`/${NAME} refresh`)
          }
        } else throw error
      }
    }
    busy = true
    try {
      if (!ctx.isIdle() || sessionId !== ctx.sessionManager.getSessionId()) throw new Error('当前对话已变化或忙碌。')
      if (view) await create(ctx, () => {})
      else {
        const localBranch = captureLocalBranch(ctx)
        await withSavedLocal(ctx, async (current, send) => {
          if (current !== ctx) replaced = true
          await create(current, send, localBranch)
        }, summary ? `原对话 · ${summary}` : undefined)
      }
    } catch (error) {
      if (!replaced) {
        restoreDraft(ctx, text)
        const detail = `消息未发送：${message(error)}${images?.length ? '；请重新附加图片。' : ''}`
        if (ctx.mode === 'rpc') commandNotice(ctx, 'error', detail)
        else ctx.ui.notify(detail, 'error')
      }
    } finally {
      draft = undefined
      // A failed follow-up remains in the history view. Retrying a restored
      // draft there can never fall through to a normal Local prompt.
      armed = undefined
      busy = false
      if (!replaced) await refresh(ctx).catch(() => {})
    }
  }

  async function runCommand(ctx: ExtensionCommandContext, args: string) {
    let replaced = false
    if (busy || draft || !ctx.isIdle() || delivering(ctx)) {
      commandNotice(ctx, 'error', commandAsk ? '请先回答或关闭当前确认。' : '当前对话忙碌，请等待操作结束。')
      return
    }
    busy = runningCommand = true
    try {
      const command = parseWorktreeCommand(args)
      let approval = confirmation
      if (command.kind !== 'status' && command.kind !== 'help') confirmation = undefined
      if (command.kind === 'help') {
        commandNotice(ctx, 'ok', `Worktree 命令：\n${standaloneCommands.map(([verb, usage, description]) =>
          `/${NAME}-${verb}${usage} — ${description}`).join('\n')}`)
        return
      }
      if (command.kind === 'cancel') {
        armed = undefined
        commandNotice(ctx, 'ok', '已取消待确认操作／下次新建。', 'Worktree · 已取消')
        return
      }
      const link = sessionLink(ctx)
      if (!link || historyView !== undefined || incomingHoldFailed) throw new Error('当前不是可操作的持久化 Pi 会话。')
      const { local, isolated, tasks, data } = await context(ctx)
      const task = currentTask(ctx, isolated, tasks)
      if (command.kind === 'status') {
        commandNotice(ctx, 'ok', JSON.stringify(task ? { id: task.id, phase: task.phase, external: !!task.external,
          source: task.isolatedPath, target: task.local.root, ready: task.review?.files,
          preview: task.receipt?.changedFiles, commit: task.commitOid, cleanup: task.cleanup,
          ...(task.journal ? { recovery: data.statePath, operation: task.journal.operation } : {}) } :
          { phase: 'none', cwd: ctx.cwd, armed: armed?.sessionId === link.id }))
        return
      }
      if (command.kind === 'new') {
        if (!local || isolated || process.platform === 'win32') throw new Error('只能从受支持的原 Git 项目目录新建 Worktree。')
        if (task && isOpenTask(task)) throw new Error(sessionBusy)
        armed = { sessionId: link.id }
        commandNotice(ctx, 'ok', '下次发送的任务消息将在新 Worktree 中执行。', '下次发送时新建 Worktree')
        return
      }
      const move = async (target: SessionLink, execute: (next: ExtensionContext) => Promise<void>) => {
        const result = await switchTo(ctx, target, '正在切换对话…', async next => {
          replaced = true
          try {
            if (!isBoundSession(next, target) || !next.isIdle()) throw new Error('未进入预期的空闲会话。')
            await execute(next)
          } catch (error) { commandNotice(next, 'error', message(error)) }
          finally { await refresh(next).catch(() => {}) }
        })
        if (result.cancelled) throw new Error('Pi 取消了切换，未执行操作。')
      }
      if (command.kind === 'back' || command.kind === 'resume') {
        if (!task || task.external) throw new Error('没有可切换的插件 Worktree 对话；外部 Worktree 由原客户端管理。')
        const target = command.kind === 'back' && isolated ? task.localSession :
          command.kind === 'resume' && !isolated && !task.journal && task.phase !== 'creating' &&
          (isOpenTask(task) || task.cleanup?.status === 'retained') ? task.isolatedSession : undefined
        if (!target) throw new Error('当前没有可切换的对话。')
        if (command.kind === 'back') await data.validateLocalIdentity(task)
        else await data.validateIsolatedIdentity(task)
        await move(target, async next => commandNotice(next, 'ok', JSON.stringify({ cwd: target.cwd, session: target.id })))
        return
      }
      const offer = async (candidate: NonNullable<Confirmation>, details: string, accept: string, text?: true) => {
        if (ctx.mode !== 'rpc' || text) {
          confirmation = candidate
          commandNotice(ctx, 'confirm', `${details}\n5 分钟内运行 /${NAME}-confirm ${candidate.token}，或 /${NAME}-cancel。`, 'Worktree · 等待确认')
          return
        }
        // A native select requires an explicit choice every time. Some hosts
        // cache yes/no approvals for the entire session; do not use confirm.
        const ask = new AbortController()
        commandAsk = ask
        let choice: string | undefined
        try { choice = await ctx.ui.select(details, ['取消', accept], { signal: ask.signal, timeout: confirmationTTL }) }
        finally { if (commandAsk === ask) commandAsk = undefined }
        if (choice !== accept || ask.signal.aborted || Date.now() >= candidate.expires) {
          commandNotice(ctx, 'ok', '未执行操作。', 'Worktree · 未执行操作')
          return
        }
        if (!isBoundSession(ctx, candidate.session) || !ctx.isIdle() || delivering(ctx)) throw new Error('验收对话已变化，未执行操作。')
        return candidate
      }
      const registerAdoption = async (owner: SessionLink, request: AdoptionRequest, shown: AdoptionInspection) => {
        await withSavedLocal(ctx, async (next, send) => {
          if (next !== ctx) replaced = true
          try {
            if (!isBoundSession(next, owner) || !next.isIdle()) throw new Error('接入对话已变化，未登记。')
            const registered = await withLoading(next, '正在接入外部 Worktree…', () => data.adopt(owner, request, shown))
            armed = undefined
            const files = registered.review?.files ?? []
            commandNotice(next, 'ok', [`已接入 · ${files.length} 个文件。可直接运行 /${NAME}-preview。`,
              `未改动源或目标目录。任务：${registered.id}`, ...adoptionDetails(shown), ...numberedAdoptionFiles(files),
            ].join('\n'), `Worktree 已接入 · ${files.length} 个文件 · 下一步：/${NAME}-preview`)
          } catch (error) { commandNotice(next, 'error', message(error)) }
          finally {
            // A native reopen loads a new extension runtime. Let that runtime
            // install the widget so its click handler can dispatch commands.
            if (next !== ctx && next.mode === 'tui') {
              try { await send(`/${NAME} refresh`) } catch { /* Registration is already durable. */ }
            }
          }
        }, '外部 Worktree · 验收')
      }
      if (command.kind === 'selectAdoption') {
        if (!task?.external || task.phase !== 'ready' || !task.review || task.journal) {
          throw new Error('只能调整本对话中尚未预览的外部 Worktree 清单。')
        }
        const review = task.review
        if (command.numbers.some(number => number > review.files.length)) throw new Error('文件编号不在当前清单中。')
        const selected = new Set(command.numbers)
        const files = review.files.filter((_file, index) => selected.has(index + 1))
        const updated = await withLoading(ctx, '正在更新交付清单…', () => data.restrictReview(task.id, link, review.id, files))
        commandNotice(ctx, 'ok', ['已缩小交付清单；可继续预览。', ...numberedAdoptionFiles(updated.files)].join('\n'),
          `交付清单已更新 · ${updated.files.length} 个文件 · 下一步：/${NAME}-preview`)
        return
      }
      if (command.kind === 'adopt' || command.kind === 'discoverAdoption') {
        if (isolated || task && isOpenTask(task)) throw new Error('已有进行中任务；请从未绑定的源或目标对话接入。')
        const inspect = <T>(run: () => Promise<T>) => withLoading(ctx, '正在检查外部 Worktree…', run)
        if (command.kind === 'discoverAdoption') {
          const shown = await inspect(() => data.discoverAdoption(link))
          await registerAdoption(link, {
            source: shown.isolated.root, target: shown.local.root, base: shown.baseOid,
            title: shown.review.message, files: shown.review.files,
          }, shown)
        } else {
          const shown = await inspect(() => data.inspectAdoption(link, command.request))
          const accepted = await offer({ kind: 'adopt', request: command.request, shown, token: randomUUID(), expires: Date.now() + confirmationTTL, session: link },
            ['接入外部 Worktree？只登记，不改动两个目录。', ...adoptionDetails(shown),
              ...commandFiles(shown.review.files, ctx.mode === 'rpc' && !command.text)].join('\n'), '接入 Worktree', command.text)
          if (accepted?.kind === 'adopt') await registerAdoption(accepted.session, accepted.request, accepted.shown)
        }
        return
      }
      if (command.kind === 'action') {
        if (!task || task.journal || (command.verb === 'preview' ? task.phase !== 'ready' :
            command.verb === 'discard' ? !((task.external || isolated) && ['ready', 'working'].includes(task.phase)) :
              task.phase !== 'previewed')) throw new Error('当前任务阶段或对话不允许此操作；先查看 status。')
        const act = commandActions[command.verb]
        const discardFingerprint = act === 'discard' && !task.external ? await data.discardFingerprint(task) : undefined
        const accept = task.external && act === 'discard' ? '解除登记' : act === 'finalize' && task.external ? '提交' : confirmationCopy[act].button
        approval = await offer({ kind: 'action', task, verb: command.verb, discardFingerprint, token: randomUUID(), expires: Date.now() + confirmationTTL, session: link },
          commandActionDetails(task, act, ctx.mode === 'rpc' && !command.text), accept, command.text)
        if (!approval) return
      } else if (command.kind !== 'confirm' || !approval || approval.token !== command.token || approval.expires <= Date.now() ||
          !isBoundSession(ctx, approval.session)) throw new Error('确认码无效、已使用或已过期；请重新发起操作。')
      if (approval.kind === 'adopt') {
        await registerAdoption(approval.session, approval.request, approval.shown)
        return
      }
      const approved = approval.task
      if (!task || task.id !== approved.id || taskVersion(task) !== taskVersion(approved)) throw new Error('任务已变化；请重新发起操作。')
      const act = commandActions[approval.verb]
      const execute = async (next: ExtensionContext) => {
        const owner = sessionLink(next)
        if (!owner) throw new Error('确认会话已变化。')
        const result = await data.act(approved.id, act, { session: owner, phase: approved.phase,
          reviewId: approved.review?.id, previewId: approved.receipt?.previewId, discardFingerprint: approval.discardFingerprint })
        const outcome = result.external && act === 'discard' ? '已解除登记。' : completed[act]
        commandNotice(next, 'ok', `${outcome}${result.commitOid ? ` · ${result.commitOid}` : ''}` +
          (result.external ? ' 外部 Worktree 未修改或删除。' : result.cleanup?.status === 'retained' ?
            ` Worktree 保留：${result.cleanup.reason ?? result.isolatedPath}` : result.cleanup?.status === 'done' ? ' Worktree 已清理。' : ''),
          `Worktree · ${outcome}${result.commitOid ? ` · ${result.commitOid.slice(0, 12)}` : ''}`)
      }
      if (!approved.external && isolated && (act === 'finalize' || act === 'discard')) {
        await data.validateLocalIdentity(approved)
        const target = approved.localSession
        if (pendingDelivery.has(target.file)) throw new Error('目标对话正有其他 Worktree 操作。')
        pendingDelivery.add(target.file)
        try { await move(target, execute) }
        finally { pendingDelivery.delete(target.file) }
      } else await execute(ctx)
    } catch (error) { if (!replaced) commandNotice(ctx, 'error', message(error)) }
    finally {
      busy = runningCommand = false
      if (!replaced) await refresh(ctx).catch(() => {})
    }
  }

  for (const [verb, usage, description] of standaloneCommands) {
    pi.registerCommand(`${NAME}-${verb}`, {
      description: `${description}${usage ? `（${usage.trim()}）` : ''}`,
      async handler(args, ctx) {
        if (ctx.hasUI) await runCommand(ctx, `${verb}${args.trim() ? ` ${args.trim()}` : ''}`)
      },
    })
  }

  pi.registerCommand(NAME, {
    description: '打开 Worktree 工作台；加 help 查看命令',
    getArgumentCompletions: prefix => {
      const matches = standaloneCommands.filter(([verb]) => verb.startsWith(prefix))
      return matches.length ? matches.map(([verb, , description]) => ({ value: verb, label: verb, description })) : null
    },
    async handler(args, ctx) {
      if (!ctx.hasUI) return
      if (args === 'refresh') {
        try { await refresh(ctx) } catch (error) { ctx.ui.notify(message(error), 'error') }
        return
      }
      if (args && draft?.token === args && !busy) { await sendInNewWorktree(ctx, draft); return }
      const intent = args && clickIntent?.token === args ? clickIntent : undefined
      // Native history controls use the existing private-view navigation.
      const historyNav = !busy && !!historyView && (args === 'back' || args === 'resume')
      if (!intent && !historyNav && (args.trim() || ctx.mode === 'rpc')) { await runCommand(ctx, args); return }
      if (busy) return
      if (historyView !== undefined) {
        if (!historyView || delivering(ctx) || draft || !ctx.isIdle() || (args !== 'back' && args !== 'resume')) return
        const view = historyView
        const viewFile = ctx.sessionManager.getSessionFile()
        const text = ctx.ui.getEditorText()
        busy = true
        let replaced = false
        try {
          let target = view.returnTo
          if (args === 'resume') {
            const data = store!
            const prior = view.afterCommit && (await data.read()).tasks.find(task => task.id === view.priorId)
            if (!prior || !prior.isolatedSession || prior.phase === 'delivered' || prior.phase === 'discarded') throw new Error('原 Worktree 已结束，不能恢复编辑。')
            await data.validateIsolatedIdentity(prior)
            target = prior.isolatedSession
          }
          const moved = await switchTo(ctx, target, args === 'resume' ? '正在回到 Worktree…' : '正在返回原对话…', async next => {
            replaced = true
            if (isBoundSession(next, target)) {
              if (text) restoreDraft(next, text)
              if (viewFile) await rm(viewFile, { force: true }).catch(() => {})
            }
          })
          if (moved.cancelled) throw new Error('Pi 取消了切换。')
        } catch (error) { if (!replaced) ctx.ui.notify(message(error), 'error') }
        finally { busy = false }
        return
      }
      if (intent) clickIntent = undefined
      if (draft || !ctx.isIdle()) return
      busy = true
      let switching = false
      try {
        const { local, isolated, tasks, data, cwd } = await context(ctx)
        const task = currentTask(ctx, isolated, tasks)
        if (!local && !isolated) throw new Error('请从有初始提交的 Git checkout 打开 Pi。')
        const choices: Choice<MenuAction>[] = [...deliveryChoices(task)]
        if (task?.phase === 'ready' && !task.external && task.review && !task.journal && !task.recovery) {
          choices.push({ label: labels.commit_ready, value: 'commit_ready' })
        }
        if (task?.phase === 'ready' && !task.journal && !task.recovery && (task.review?.files.length ?? 0) > 1 && (task.isolatedSession || task.external)) choices.push(scopeChoice)
        if (task?.phase === 'working' && task.recovery && !task.journal) choices.push(recoverChoice)
        const details: string[] = []
        if (task?.journal || task?.phase === 'creating') {
          details.push('操作已停止', `恢复记录：${data.statePath}`, `隔离目录：${task.isolatedPath}`)
        } else if (task?.cleanup?.status === 'retained') {
          details.push(`已保留 · ${task.cleanup.reason ?? 'Worktree'}`)
        } else if (task?.review) {
          details.push(`${task.review.message} · ${task.review.files.length} 个文件`)
        }
        if (isolated && task) {
          choices.push(task.phase === 'previewed' && !task.journal ? localCheck : { label: '返回原对话', value: 'return' })
          if (!task.journal && ['working', 'ready'].includes(task.phase)) {
            choices.push({ label: '标记待验收（手动）', value: 'mark' }, { label: labels.discard, value: 'discard', tone: 'danger' })
          }
        } else if (local) {
          if (!task || !isOpenTask(task)) {
            choices.push({ label: armed?.sessionId === ctx.sessionManager.getSessionId() ? '取消下次发送时创建' : '下次发送时新建 Worktree', value: 'arm' })
          }
          if (historyTasks(tasks).length) choices.push(historyChoice)
          if (task && isOpenTask(task) && !task.journal && task.phase !== 'creating') {
            if (task.isolatedSession) choices.push({ ...resumeChoice, tone: choices.length ? undefined : 'primary' })
            if (task.external && ['working', 'ready'].includes(task.phase)) choices.push({ label: '解除外部任务登记', value: 'discard' })
            if (task.external && ['working', 'ready'].includes(task.phase) && await data.isEditingSession(task, task.localSession).catch(() => false)) {
              choices.push({ label: '标记待验收（手动）', value: 'mark' })
            }
          }
        }
        const retained = retainedTasks(tasks)
        if (retained.length) choices.push(retainedChoice)
        choices.push({ label: '关闭', value: 'close', tone: 'quiet' })
        if (intent && (intent.sessionId !== ctx.sessionManager.getSessionId() || intent.taskVersion !== taskVersion(task) ||
            !choices.some(option => option.value === intent.choice))) throw new Error('任务状态已变化，请重新选择。')
        const tone = phaseTone(task)
        const choice = intent?.choice ?? await pick(ctx, 'Worktree · 更多', details, choices, {
          tone: tone === 'danger' || tone === 'warning' ? tone : undefined,
        })
        if (!choice || choice === 'close' || !ctx.isIdle()) return
        if (choice === 'arm' && local) {
          if (!sessionLink(ctx)) throw new Error('无持久化 Pi 会话，不能新建 Worktree。')
          const id = ctx.sessionManager.getSessionId()
          armed = armed?.sessionId === id ? undefined : { sessionId: id }
        } else if (choice === 'history' && local) {
          const prior = await pick<Task | undefined>(ctx, '打开历史对话', [
            '可以继续提问；明确要求改动时才从项目目录当前 HEAD 新建 Worktree。',
          ], [
            ...historyTasks(tasks).map(item => ({ label: `${item.id.slice(0, 8)} · ${phases[item.phase]} · ${item.review?.message ?? 'Worktree'}`, value: item })),
            { label: '取消', value: undefined },
          ])
          if (!prior || !ctx.isIdle()) return
          await withSavedLocal(ctx, async current => {
            if (current !== ctx) switching = true
            try {
              const { target } = await withLoading(current, '正在准备历史对话…', () => makeHistoryView(data, prior, sessionLink(current)!))
              const moved = await switchTo(current, target, '正在打开历史对话…', async () => { switching = true })
              if (moved.cancelled) {
                await rm(target.file, { force: true })
                throw new Error('Pi 取消了打开历史对话。')
              }
            } catch (error) {
              if (current === ctx) throw error
              current.ui.notify(message(error), 'error')
            }
          })
        } else if (choice === 'return' && isolated) {
          await withLoading(ctx, '正在检查原对话…', () => data.validateLocalIdentity(isolated))
          const moved = await switchTo(ctx, isolated.localSession, '正在返回原对话…', async () => { switching = true })
          if (moved.cancelled) throw new Error('Pi 取消了切换。')
        } else if (choice === 'retained' || (choice === 'resume' && task?.isolatedSession)) {
          const target = choice === 'retained' ? await pick<Task | undefined>(ctx, '已保留的 Worktree', ['选择一个已结束任务的保留目录。'], [
            ...retained.map(item => ({ label: `${item.id.slice(0, 8)} · ${item.review?.message ?? 'Worktree'}`, value: item })),
            { label: '取消', value: undefined },
          ]) : task
          if (!target || !ctx.isIdle()) return
          if (choice === 'retained') {
            const next = await pick(ctx, '管理保留的 Worktree', [
              `原因：${target.cleanup?.reason ?? '保留环境'}`, `目录：${target.isolatedPath}`,
            ], [
              ...(target.isolatedSession ? [{ label: '检查保留目录', value: 'resume' }] : []),
              { label: '检查并清理…', value: 'remove' }, { label: '关闭', value: 'close' },
            ])
            if (!ctx.isIdle()) return
            if (next === 'remove') { await confirmRemoval(ctx, data, target, '确认：清理保留的 Worktree'); return }
            if (next !== 'resume') return
          }
          if (!target.isolatedSession) return
          await withLoading(ctx, '正在检查 Worktree…', () => data.validateIsolatedIdentity(target))
          const moved = await switchTo(ctx, target.isolatedSession, '正在恢复 Worktree 会话…', async () => { switching = true })
          if (moved.cancelled) throw new Error('Pi 取消了切换。')
        } else if (choice === 'recover' && task?.recovery) {
          const target = task.isolatedSession
          if (!target) throw new Error('找不到任务的 Worktree 会话。')
          const resume = async (next: ExtensionContext, send: (text: string) => unknown) => {
            await withLoading(next, '正在检查冲突恢复状态…', async () => {
              const latest = (await data.read()).tasks.find(item => item.id === task.id)
              if (!isBoundSession(next, target) || !next.isIdle() || latest?.phase !== 'working' || latest.journal ||
                  JSON.stringify(latest.recovery) !== JSON.stringify(task.recovery)) throw new Error('冲突恢复状态已变化。')
              await data.validateIsolatedIdentity(latest)
            })
            await send(conflictPrompt(task.recovery!))
          }
          if (isolated) await resume(ctx, text => pi.sendUserMessage(text))
          else {
            await withLoading(ctx, '正在检查 Worktree…', () => data.validateIsolatedIdentity(task))
            const moved = await switchTo(ctx, target, '正在恢复 Worktree 会话…', async next => {
              switching = true
              try { await resume(next, text => next.sendUserMessage(text)) }
              catch (error) { next.ui.notify(message(error), 'error') }
            })
            if (moved.cancelled) throw new Error('Pi 取消了切换。')
          }
        } else if (choice === 'mark' && task) {
          const link = sessionLink(ctx)
          if (!link || !editingSession(ctx, task)) throw new Error('只能在绑定的 Worktree 源对话中标记待验收。')
          if (task.external) await verifyExternalEditor(data, task, link)
          const candidates = await withLoading(ctx, '正在扫描 Worktree 改动…', () => data.reviewCandidates(task))
          const files = await chooseReviewFiles(ctx, candidates, false, task.review?.files)
          if (!files || !ctx.isIdle()) return
          await withLoading(ctx, '正在标记待验收…', () =>
            data.markReady(task.id, link, task.review?.message ?? 'Worktree task changes', files, {
              body: task.review?.body, expectedReview: { id: task.review?.id },
            }))
          ctx.ui.notify('已标记待验收；未修改项目目录。', 'info')
        } else if (choice === 'scope' && task?.review && (task.isolatedSession || task.external)) {
          const files = await chooseReviewFiles(ctx, task.review.files, true)
          if (!files || files.length === task.review.files.length || !ctx.isIdle()) return
          const link = sessionLink(ctx)
          if (!link) throw new Error('找不到绑定的 Pi 会话。')
          const reviewId = task.review.id
          await withLoading(ctx, '正在更新交付清单…', () => data.restrictReview(task.id, link, reviewId, files))
          await refresh(ctx)
          ctx.ui.notify('已更新交付清单；未修改项目目录。', 'info')
        } else if (task && choice in labels) {
          const act = choice as Action
          if (act === 'discard' && !task.external && (!isolated || !isBoundSession(ctx, task.isolatedSession))) throw new Error('只能在任务的 Worktree 对话中放弃。')
          const discardFingerprint = act === 'discard' && !task.external
            ? await withLoading(ctx, '正在检查可放弃的 Worktree…', () => data.discardFingerprint(task)) : undefined
          const copy = task.external && act === 'discard' ? { title: '解除登记？', lead: '只解除登记，不修改源或项目目录。', button: '解除登记' } :
            task.external && act === 'finalize' ? { ...confirmationCopy[act], button: '提交预览' } : confirmationCopy[act]
          const commits = act === 'finalize' || act === 'commit_ready'
          const leavesWorktree = commits && !!isolated
          const partial = commits && !task.external && !!task.review?.partial
          const relevantFiles = (act === 'commit_ready' ? task.review?.files : task.receipt?.changedFiles ?? task.review?.files) ?? []
          const detail = [
            ...(commits && task.review ? [`提交标题：${task.review.message.trim()}`] : []),
            act === 'discard' ? '隔离 Worktree' : `项目目录${relevantFiles.length ? ` · ${relevantFiles.length} 个文件` : ''}`,
            act === 'discard' ? task.isolatedPath : task.local.root,
          ]
          if (act === 'discard') detail.unshift(copy.lead)
          if (leavesWorktree) detail.push('提交后保留当前对话。')
          const externalPreview = !!task.external && act === 'preview'
          if (externalPreview) detail.push(`目标分支：${task.localHeadRef}`, `起点：${task.baseOid}`, '来源：', task.isolatedPath)
          if (task.external && commits) detail.push('外部 Worktree 由原工具管理，不会删除。')
          if (partial) detail.push('清单外有改动，将保留 Worktree。')
          if (commits && task.review?.body) detail.push('提交正文：', ...task.review.body.split('\n').map(line => line.replaceAll('\t', '    ')), '')
          if (commits || externalPreview) detail.push(...relevantFiles.map(path => `• ${JSON.stringify(path)}`))
          const decision = await pick<'execute' | 'keep' | undefined>(ctx, copy.title, detail, [
            { label: partial ? '提交并保留' : copy.button, value: 'execute', tone: act === 'discard' ? 'danger' : 'primary' },
            ...(commits && !partial && !task.external ? [{ label: '提交并保留', value: 'keep' as const }] : []),
            { label: '取消', value: undefined, tone: 'quiet' },
          ], { compactActions: true, lead: act === 'discard' ? undefined : copy.lead, requiredDetails: act === 'discard' ? detail.length : undefined,
            requireDetailViewport: commits || externalPreview, tone: act === 'discard' ? 'danger' : commits || act === 'rollback' ? 'warning' : undefined })
          if (!decision || !ctx.isIdle()) return
          const recoverConflict = async (conflict: PreviewConflict) => {
            const plan = conflict.plan
            const target = task.isolatedSession
            const canRecover = !!target && !!task.review && !task.review.partial && !!plan.cleanEntries && plan.committedConflictingFiles.length > 0
            const canNarrow = (!!target || !!task.external) && !!task.review && task.review.files.length > 1 && !task.recovery
            const paths = plan.conflictingFiles.slice(0, 6).map(path => `• ${JSON.stringify(path)}`)
            if (plan.conflictingFiles.length > paths.length) paths.push(`… 共 ${plan.conflictingFiles.length} 个冲突文件`)
            const recover = await pick(ctx, '预览冲突 · 项目目录未修改', [
              !plan.committedConflictingFiles.length ? '冲突文件若不属于任务，可调整交付清单；否则请先处理项目目录的未提交改动。' :
                canRecover ? `只在 Worktree 合并项目目录的提交 ${plan.localHeadOid.slice(0, 12)}，生成新验收。` : '这组冲突不能安全地自动交给 Agent。',
              ...(canRecover && plan.dirtyConflict ? ['项目目录的未提交改动不会带入 Worktree。'] : []),
              ...paths,
            ], [...(canRecover ? [{ label: '让 Agent 解决冲突', value: 'recover' as const, tone: 'primary' as const }] : []),
              ...(canNarrow ? [scopeChoice] : []), { label: '关闭', value: 'close', tone: 'quiet' }], { tone: 'warning' })
            if (!recover || recover === 'close' || !task.review || !ctx.isIdle()) return
            const reviewId = task.review.id
            if (recover === 'scope') {
              const files = await chooseReviewFiles(ctx, task.review.files, true)
              if (!files || files.length === task.review.files.length || !ctx.isIdle()) return
              const link = sessionLink(ctx)
              if (!link) throw new Error('找不到绑定的 Pi 会话。')
              await withLoading(ctx, '正在更新交付清单…', () => data.restrictReview(task.id, link, reviewId, files))
              await refresh(ctx)
              ctx.ui.notify('已更新交付清单；请重新点击预览。', 'info')
              return
            }
            if (!target) return
            const begin = async (next: ExtensionContext, send: (text: string) => unknown) => {
              if (!isBoundSession(next, target) || !next.isIdle()) throw new Error('未进入预期的空闲 Worktree 会话。')
              const recovery = await withLoading(next, '正在准备冲突处理…', () => data.beginConflictRecovery(task.id, target, reviewId, plan))
              await send(conflictPrompt(recovery))
            }
            if (isolated) await begin(ctx, text => pi.sendUserMessage(text))
            else {
              const moved = await switchTo(ctx, target, '正在进入 Worktree…', async next => {
                switching = true
                try { await begin(next, text => next.sendUserMessage(text)) }
                catch (error) { next.ui.notify(message(error), 'error') }
                finally {
                  if (next.isIdle()) await next.sendUserMessage(`/${NAME} refresh`, { expandPromptTemplates: true }).catch(() => {})
                }
              })
              if (moved.cancelled) throw new Error('Pi 取消了切换；未开始处理冲突。')
            }
          }
          const execute = async (activeCtx: ExtensionContext) => {
            const result = await withLoading(activeCtx, progress[act], async () => {
              if (decision === 'keep') {
                if (!task.isolatedSession || task.isolatedSession.cwd !== task.isolatedPath) throw new Error('找不到可保留的 Worktree 会话，未提交。')
                await validateSession(task.isolatedSession)
              }
              return data.act(task.id, act, {
                phase: task.phase, reviewId: task.review?.id, previewId: task.receipt?.previewId,
                discardFingerprint, keepWorktree: decision === 'keep', session: task.external ? sessionLink(activeCtx) : undefined,
              })
            }).catch(error => {
              if (act === 'commit_ready' && error instanceof PreviewConflict) {
                throw new Error(`${error.message}。可通过「预览改动」查看冲突处理选项。`, { cause: error })
              }
              throw error
            })
            const oid = commits && result.commitOid ? ` · ${result.commitOid.slice(0, 12)}` : ''
            const followUp = act === 'preview' && isolated ? '可点「打开项目目录检查」。' : ''
            const cleanup = result.cleanup?.status === 'retained'
              ? ` Worktree 已保留：${result.isolatedPath}${result.cleanup.reason ? `（${result.cleanup.reason}）` : ''}`
              : result.cleanup?.status === 'done' ? ' Worktree 已清理。' : ''
            activeCtx.ui.notify(`${completed[act]}${oid}${followUp}${cleanup}`,
              result.cleanup?.status === 'retained' && !result.cleanup.requested ? 'warning' : 'info')
            if (result.cleanup?.canForce && !partial && activeCtx.isIdle()) {
              try { await confirmRemoval(activeCtx, data, result, '未能安全清理 Worktree') }
              catch (error) { activeCtx.ui.notify(`Worktree 清理已停止：${message(error)}`, 'warning') }
            }
          }
          if (act === 'discard' && !task.external) {
            const text = ctx.ui.getEditorText()
            await withLoading(ctx, '正在检查原对话…', () => data.validateLocalIdentity(task))
            const moved = await switchTo(ctx, task.localSession, '正在返回原对话…', async next => {
              switching = true
              if (!isBoundSession(next, task.localSession) || !next.isIdle()) {
                next.ui.notify('未进入预期的原对话，任务未放弃。', 'error')
                return
              }
              if (text) restoreDraft(next, text)
              try { await execute(next) }
              catch (error) { next.ui.notify(message(error), 'error') }
              finally { await next.sendUserMessage(`/${NAME} refresh`, { expandPromptTemplates: true }).catch(() => {}) }
            })
            if (moved.cancelled) throw new Error('Pi 取消了切换，任务未放弃。')
          } else if (leavesWorktree) {
            // Move off the old cwd before cleanup, but keep the task transcript on
            // screen. This view blocks tools and prompt delivery until handoff.
            const leaf = ctx.sessionManager.getLeafId()
            const { target, source, proof } = await withLoading(ctx, '正在保留任务对话…', async () => {
              await data.validateLocal(task)
              await validateSession(task.localSession)
              return makeHistoryView(data, task, task.localSession, { leaf })
            })
            pendingDelivery.add(target.file)
            try {
              const moved = await switchTo(ctx, target, '正在切换提交环境…', async next => {
                switching = true
                try {
                  const nextCwd = await realpath(next.cwd)
                  const inProject = nextCwd === task.local.root || nextCwd.startsWith(task.local.root + '/')
                  if (!inProject || !isBoundSession(next, target) || !next.isIdle()) {
                    throw new Error('未进入预期的任务对话，未提交。')
                  }
                  if (!matchesHistory(await readHistory(source), proof)) throw new Error('任务对话已变化，未提交。')
                  await execute(next)
                } catch (error) {
                  next.ui.notify(message(error), 'error')
                } finally {
                  pendingDelivery.delete(target.file)
                  try { await next.sendUserMessage(`/${NAME} refresh`, { expandPromptTemplates: true }) }
                  catch (error) { next.ui.notify(`无法刷新工作台：${message(error)}`, 'warning') }
                }
              })
              if (moved.cancelled) {
                await rm(target.file, { force: true })
                throw new Error('Pi 取消了切换，未提交。')
              }
            } finally { pendingDelivery.delete(target.file) }
          } else {
            try { await execute(ctx) }
            catch (error) {
              if (act !== 'preview' || !(error instanceof PreviewConflict)) throw error
              await recoverConflict(error)
            }
          }
        }
      } catch (error) {
        if (!switching) {
          try { ctx.ui.notify(message(error), 'error') } catch { /* A failed replacement may have invalidated the original context. */ }
        }
      } finally {
        busy = false
        if (!switching) await refresh(ctx).catch(() => {})
      }
    },
  })
}
