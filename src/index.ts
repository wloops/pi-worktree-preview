import { getDisplayLanguage, loadDisplayLanguage, saveDisplayLanguage, tf, tr } from './i18n/display.ts'
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
const HISTORY_HINT = () => tr('历史对话 · 只读', 'History · Read-only')
const historyReadTools = new Set(['read', 'grep', 'find', 'ls'])
// Native session replacement reloads the extension. Share only the transient
// delivery lock across the two instances, not UI or session contexts.
const deliveryKey = Symbol.for('pi-worktree-preview.pending-delivery-views')
const deliveryState = globalThis as typeof globalThis & { [deliveryKey]?: Set<string> }
const pendingDelivery = deliveryState[deliveryKey] ??= new Set<string>()
const delivering = (ctx: ExtensionContext) => pendingDelivery.has(ctx.sessionManager.getSessionFile() ?? '')
const guardedTools = new Set(['edit', 'write', 'bash', 'powershell'])
const workflowTools = new Set([TOOL, REVISE, FOLLOW_UP])
const noWorkflow = () => tr('当前对话未绑定 Worktree 任务；无需使用此工具，可按用户要求正常继续。', 'This conversation has no linked Worktree task. Skip this tool and proceed with the user\'s request.')
const labels = (): Record<Action, string> => ({
  preview: tr('预览改动', 'Preview changes'), rollback: tr('撤回预览', 'Undo preview'), finalize: tr('确认提交', 'Confirm commit'),
  commit_ready: tr('跳过预览，直接提交', 'Skip preview and commit'), discard: tr('放弃任务', 'Discard task'),
})
const confirmationCopy = (): Record<Action, { title: string; lead: string; button: string }> => ({
  preview: { title: tr('预览改动？', 'Preview changes?'), lead: tr('改动写入项目目录，不暂存、不提交。', 'Writes changes to the project folder without staging or committing.'), button: tr('预览', 'Preview') },
  rollback: { title: tr('撤回预览？', 'Undo preview?'), lead: tr('只还原本次预览。', 'Only this preview will be undone.'), button: tr('撤回', 'Undo') },
  finalize: { title: tr('提交本次预览？', 'Commit this preview?'), lead: tr('只提交任务改动。', 'Only task changes will be committed.'), button: tr('提交并安全清理', 'Commit and safely clean up') },
  commit_ready: { title: tr('跳过预览，直接提交？', 'Skip preview and commit?'), lead: tr('写入项目目录并提交。', 'Writes changes to the project folder and commits them.'), button: tr('提交并安全清理', 'Commit and safely clean up') },
  discard: { title: tr('放弃任务？', 'Discard task?'), lead: tr('安全检查通过后删除隔离目录，项目目录不变。', 'Removes the isolated directory if safety checks pass. The project folder is unchanged.'), button: tr('放弃', 'Discard') },
})
const completed = (): Record<Action, string> => ({
  preview: tr('改动已写入项目目录，未暂存、未提交。', 'Changes written to the project folder, without staging or committing.'), rollback: tr('已撤回本次预览。', 'Preview undone.'),
  finalize: tr('已提交本次预览', 'Preview committed'), commit_ready: tr('已直接提交本次任务', 'Task committed directly'), discard: tr('任务已放弃，项目目录未改动。', 'Task discarded. The project folder was not changed.'),
})
const progress = (): Record<Action, string> => ({
  preview: tr('正在写入预览改动…', 'Writing preview changes…'), rollback: tr('正在撤回预览…', 'Undoing preview…'), finalize: tr('正在提交预览…', 'Committing preview…'),
  commit_ready: tr('正在直接提交…', 'Committing directly…'), discard: tr('正在放弃任务并检查清理…', 'Discarding task and checking cleanup…'),
})
type MenuAction = Action | 'arm' | 'resume' | 'history' | 'retained' | 'return' | 'mark' | 'scope' | 'recover' | 'language' | 'close'
const phases = () => ({ creating: tr('创建中断', 'Creation interrupted'), working: tr('进行中', 'In progress'), ready: tr('待验收', 'Ready for review'), previewed: tr('已预览', 'Preview active'), delivered: tr('已交付', 'Delivered'), discarded: tr('已放弃', 'Discarded') })
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
const sessionBusy = () => tr('原对话已有未完成的任务或恢复记录；可新开对话并行开发。', 'This conversation already has an open task or recovery record. Start a new conversation to work in parallel.')
function currentTask(ctx: ExtensionContext, isolated: Task | undefined, tasks: Task[]) {
  if (isolated) return isBoundSession(ctx, isolated.isolatedSession) ? isolated : undefined
  const own = tasks.filter(task => isBoundSession(ctx, task.localSession))
  return own.find(isOpenTask) ?? own[0]
}
function deliveryChoices(task: Task | undefined): Choice<Action>[] {
  if (!task || task.journal) return []
  if (task.phase === 'ready') return [{ label: labels().preview, value: 'preview', tone: 'primary' }]
  if (task.phase === 'previewed') return [{ label: labels().finalize, value: 'finalize', tone: 'primary' }, { label: labels().rollback, value: 'rollback' }]
  return []
}
const localCheck = () => ({ label: tr('打开项目目录检查', 'Inspect project folder'), value: 'return' } as const)
const retainedChoice = () => ({ label: tr('已保留的 Worktree', 'Retained Worktrees'), value: 'retained' } as const)
const historyChoice = () => ({ label: tr('任务历史', 'Task history'), value: 'history' } as const)
const recoverChoice = () => ({ label: tr('让 Agent 继续解决冲突', 'Let Agent continue resolving'), value: 'recover', tone: 'primary' } as const)
const resumeChoice = () => ({ label: tr('进入 / 恢复 Worktree', 'Open / resume Worktree'), value: 'resume' } as const)
const scopeChoice = () => ({ label: tr('调整交付清单', 'Change delivery scope'), value: 'scope' } as const)

async function chooseReviewFiles(ctx: ExtensionContext, files: readonly string[], narrow: boolean, initial = narrow ? files : []) {
  if (!files.length) throw new Error(tr('没有可验收的 Git 改动。', 'No Git changes to review.'))
  const selected = new Set(initial.filter(path => files.includes(path)))
  const choices: Choice<boolean>[] = files.map(path => ({
    get label() { return `[${selected.has(path) ? 'x' : ' '}] ${JSON.stringify(path)}` },
    value: false,
    toggle() { if (!selected.delete(path)) selected.add(path) },
  }))
  const apply = await pick(ctx, narrow ? tr('调整交付清单', 'Change delivery scope') : tr('选择交付文件', 'Choose files to deliver'), [
    narrow ? tr('取消勾选即可移除文件；保留文件的验收内容不变。', 'Uncheck files to remove them. The remaining files keep their reviewed contents.') : tr('只勾选本次任务要交付的文件。', 'Select only files that belong to this task.'),
    tr('保存只更新验收清单，不会写入项目目录。', 'Saving updates the review only. It does not write to the project folder.'),
  ], [...choices, { label: tr('保存交付清单', 'Save file list'), value: true, tone: 'primary' }, { label: tr('取消', 'Cancel'), value: false, tone: 'quiet' }])
  if (!apply) return
  if (!selected.size) throw new Error(tr('请选择至少一个要交付的改动文件。', 'Select at least one changed file to deliver.'))
  return files.filter(path => selected.has(path))
}

function phaseLabel(isolated: boolean, task?: Task) {
  const scope = isolated ? 'Worktree' : tr('原对话', 'Original conversation')
  if (!task) return scope
  const phase = task.journal ? tr('恢复记录：已停止', 'Recovery record: stopped') : task.recovery ? tr('解决冲突中', 'Resolving conflicts') : phases()[task.phase]
  return `${scope} · ${isolated ? '' : 'Worktree '}${phase}`
}
function phaseTone(task?: Task) {
  if (task?.journal || task?.phase === 'creating') return 'danger'
  if (task?.recovery && task.phase === 'working' || task?.phase === 'previewed') return 'warning'
  if (task?.phase === 'delivered') return 'success'
  return 'normal'
}

function conflictPrompt(recovery: NonNullable<Task['recovery']>) {
  if (recovery.workspace) {
    return `只在独立冲突目录 ${JSON.stringify(recovery.workspace.checkout.root)} 解决冲突，不修改项目目录或外部 Worktree。只修 Git 报出的冲突并暂存，不必提交。跑相关测试后调用 ${TOOL}，列出该目录相对 ${recovery.localHeadOid} 的完整改动。不要预览。`
  }
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
async function sessionCwd(file: string): Promise<string | undefined> {
  // Only the native switch should load/migrate or repair the selected session.
  if (!await existing(file).catch(() => false)) return
  const fd = await open(file, 'r').catch(() => undefined)
  if (!fd) return
  try {
    const buffer = Buffer.alloc(64 * 1024)
    const { bytesRead } = await fd.read(buffer)
    const value = JSON.parse(buffer.toString('utf8', 0, bytesRead).split('\n', 1)[0])
    if (value?.type === 'session' && typeof value.cwd === 'string') return value.cwd
  } catch { /* Let Pi handle unreadable session files. */ }
  finally { await fd.close() }
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
async function withSavedLocal(ctx: ExtensionCommandContext, run: (next: ExtensionCommandContext, send: (text: string) => unknown) => Promise<void>, initialName = tr('原对话 · Worktree 任务', 'Original conversation · Worktree task')) {
  const source = sessionLink(ctx)
  if (!source) throw new Error(tr('无有效的持久化 Pi 会话。', 'No valid saved Pi session.'))
  if (await existing(source.file)) { await run(ctx, () => {}); return }
  const header = ctx.sessionManager.getHeader()
  if (!header || header.id !== source.id || header.cwd !== source.cwd || header.version !== CURRENT_SESSION_VERSION) {
    throw new Error(tr('无法保存原对话。', 'Could not save the original conversation.'))
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
    const moved = await withLoading(ctx, tr('正在恢复原对话…', 'Restoring original conversation…'), () => ctx.switchSession(source.file, { withSession: async next => {
      if (!isBoundSession(next, source) || !next.isIdle()) {
        next.ui.notify(tr('未能恢复原对话；没有新建 Worktree。', 'Could not restore the original conversation. No Worktree was created.'), 'error')
        return
      }
      await run(next, text => next.sendUserMessage(text, { expandPromptTemplates: true }))
    } }))
    if (moved.cancelled) {
      await undoPublication()
      throw new Error(tr('Pi 取消了保存原对话。', 'Pi cancelled saving the original conversation.'))
    }
  } finally { await rm(stage, { recursive: true }) }
}

type HistoryProof = { historyHash: string; historyLines?: number }
type HistoryView = HistoryProof & { priorId: string; returnTo: SessionLink; afterCommit?: true; leaf?: string }
const hashHistory = (lines: string[]) => createHash('sha256').update(lines.join('\n')).digest('hex')

async function readHistory(source: SessionLink) {
  if (!isAbsolute(source.file) || !await existing(source.file)) throw new Error(tr('原 Pi 会话文件已不存在，无法续接。', 'The original Pi session file is missing. Cannot continue it.'))
  const fd = await open(source.file, 'r')
  try {
    // Pi's open/forkFrom loader can repair a missing final newline in place.
    // Never hand it the original. Read a stable copy of the persisted tree;
    // preserve its entry links and let Pi select the last saved branch as usual.
    const before = await fd.stat({ bigint: true })
    const [first, ...body] = (await fd.readFile('utf8')).trimEnd().split('\n')
    const after = await lstat(source.file, { bigint: true })
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error(tr('原 Pi 会话在续接时已变化，请重试。', 'The original Pi session changed while continuing. Try again.'))
    const parse = (line: string) => {
      try { return JSON.parse(line) } catch { throw new Error(tr('原 Pi 会话内容已损坏，无法续接。', 'The original Pi session is damaged. Cannot continue it.')) }
    }
    const header = parse(first)
    if (header?.type !== 'session' || header.id !== source.id || header.cwd !== source.cwd) {
      throw new Error(tr('原 Pi 会话的身份或工作目录已变化。', 'The identity or working directory of the original Pi session changed.'))
    }
    if (header.version !== CURRENT_SESSION_VERSION) throw new Error(tr('原 Pi 会话格式版本不兼容，无法续接。', 'The original Pi session uses an incompatible format version.'))
    const ids = new Set<string>()
    let stateSuffixStart = 0
    for (const [i, line] of body.entries()) {
      if (!line.trim()) { stateSuffixStart = i + 1; continue }
      const entry = parse(line)
      if (typeof entry?.type !== 'string' || entry.type === 'session' || typeof entry.id !== 'string' ||
          ids.has(entry.id) || (entry.parentId !== null && !ids.has(entry.parentId))) {
        throw new Error(tr('原 Pi 会话的历史链接不完整，无法续接。', 'The original Pi session has incomplete history links. Cannot continue it.'))
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
  if (!source || source.cwd !== task.isolatedPath) throw new Error(tr('找不到原 Worktree 对话。', 'Could not find the original Worktree conversation.'))
  await data.validateLocalIdentity(task)
  const { body, ids, hash } = await readHistory(source)
  const leaf = delivery?.leaf ?? undefined
  if (leaf !== undefined && !ids.has(leaf)) throw new Error(tr('当前对话分支尚未保存，无法保留对话。', 'The current conversation branch is not saved yet and cannot be preserved.'))
  const dir = join(data.directory, HISTORY_DIR)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const proof: HistoryProof = { historyHash: hash, ...(delivery ? { historyLines: body.length } : {}) }
  const target = await createChildSession(returnTo.cwd, source, body, sm => {
    if (leaf !== undefined) sm.branch(leaf)
    sm.appendSessionInfo(`${delivery ? tr('Worktree · 任务对话', 'Worktree · Task conversation') : tr('历史对话', 'Conversation history')} · ${task.review?.message ?? shortSessionName(task.id)}`)
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
  if (!leaf) throw new Error(tr('缺少原对话记录，未开启下一轮。', 'The original conversation is missing. The next round was not started.'))
  const entries = ctx.sessionManager.getEntries()
  const marker = entries.map(entry => entry.type === 'custom' ? entry.customType : undefined).lastIndexOf(HISTORY_VIEW)
  const end = entries.findIndex(entry => entry.id === leaf)
  if (marker < 0 || end < marker) throw new Error(tr('无法保存当前对话分支，未开启下一轮。', 'Could not save the current conversation branch. The next round was not started.'))
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
    throw new Error(tr('原 Pi 会话在打开后已变化；请返回原对话后重新打开任务历史。', 'The original Pi session changed after opening. Return to the original conversation and reopen task history.'))
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
  if (!isAbsolute(link.file) || !await existing(link.file)) throw new Error(tf('Pi 会话文件不存在：{0}', 'Pi session file not found: {0}', link.file))
  if (!(await lstat(link.cwd)).isDirectory()) throw new Error(tf('会话工作目录不存在：{0}', 'Session working directory not found: {0}', link.cwd))
  const sm = SessionManager.open(link.file)
  if (sm.getSessionId() !== link.id || sm.getHeader()?.cwd !== link.cwd) throw new Error(tr('会话身份或工作目录已变化。', 'The session identity or working directory changed.'))
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
  | { kind: 'action'; task: Task; verb: ActionVerb; discardFingerprint?: string; text?: true }
  | { kind: 'recover'; task: Task; conflict: PreviewConflict })
const standaloneCommands = () => [
  ['new', '', tr('下次发送时新建 Worktree', 'Create a Worktree on the next send')],
  ['status', '', tr('查看 Worktree 与验收状态', 'Show Worktree and review status')],
  ['resume', '', tr('进入关联的 Worktree 对话', 'Open the linked Worktree conversation')],
  ['back', '', tr('返回原对话', 'Return to original conversation')],
  ['preview', '', tr('发起预览改动', 'Start previewing changes')],
  ['recover', '', tr('让 Agent 继续解决冲突', 'Let Agent continue resolving')],
  ['rollback', '', tr('发起撤回预览', 'Start undoing the preview')],
  ['commit', '', tr('发起提交已预览的改动', 'Start committing previewed changes')],
  ['discard', '', tr('发起放弃任务或解除外部登记', 'Discard a task or unlink an external Worktree')],
  ['adopt', '', tr('接入当前 Worktree', 'Adopt the current Worktree')],
  ['confirm', tr(' <确认码>', ' <confirmation code>'), tr('确认待执行的操作', 'Confirm a pending operation')],
  ['cancel', '', tr('取消待确认操作或下次新建', 'Cancel pending confirmation or creation')],
  ['language', ' [zh|en]', tr('查看或设置扩展显示语言', 'Show or set the extension display language')],
] as const
const confirmationTTL = 5 * 60 * 1000
function adoptionDetails(shown: AdoptionInspection) {
  return [tf('来源：{0}', 'Source: {0}', JSON.stringify(shown.isolated.root)), tf('目标：{0} · {1}', 'Target: {0} · {1}', JSON.stringify(shown.local.root), JSON.stringify(shown.localHeadRef)),
    tf('候选起点：{0}', 'Candidate base: {0}', shown.baseOid), tf('提交标题：{0}', 'Commit title: {0}', JSON.stringify(shown.review.message))]
}
function numberedAdoptionFiles(files: readonly string[]) {
  return files.map((file, index) => `${index + 1}. ${JSON.stringify(file)}`)
}
function commandNotice(ctx: ExtensionContext, kind: 'ok' | 'confirm' | 'error', text: string, summary?: string) {
  if (ctx.mode === 'rpc' && (summary || kind === 'error')) {
    const status = clean(summary ?? tf('Worktree：{0}', 'Worktree: {0}', text.split('\n')[0]))
    ctx.ui.setStatus(NAME, Array.from(status).slice(0, 110).join(''))
  }
  ctx.ui.notify(`${NAME} ${kind}: ${text}`, kind === 'error' ? 'error' : 'info')
}

function commandFiles(files: readonly string[], compact: boolean): string[] {
  return compact ? [tf('涉及 {0} 个文件。', 'Files affected: {0}.', files.length)] : ['', tf('文件（{0}）：', 'Files ({0}):', files.length), ...numberedAdoptionFiles(files)]
}

function commandActionDetails(task: Task, act: Action, compact: boolean): string {
  const { title, lead } = confirmationCopy()[act]
  const externalDiscard = task.external && act === 'discard'
  const files = task.receipt?.changedFiles ?? task.review?.files ?? []
  return [externalDiscard ? tr('解除外部 Worktree 登记？', 'Unlink external Worktree?') : title,
    externalDiscard ? tr('只解除登记，两个目录都不改动。', 'Only the registration is removed. Neither directory is changed.') : lead,
    ...(task.external && !externalDiscard ? [tr('不修改或删除源目录。', 'The source directory will not be modified or deleted.')] : act === 'finalize' ? [tr('提交后尝试安全清理；不会强制删除。', 'Safe cleanup will be attempted after committing. Nothing will be force-deleted.')] : []),
    tf('目标：{0} · {1}', 'Target: {0} · {1}', JSON.stringify(task.local.root), JSON.stringify(task.localHeadRef)),
    tf('来源：{0}', 'Source: {0}', JSON.stringify(task.isolatedPath)),
    ...(task.external && act === 'preview' ? [tf('起点：{0}', 'Base: {0}', task.baseOid)] : []),
    ...(act === 'finalize' && task.review ? [tf('提交标题：{0}', 'Commit title: {0}', JSON.stringify(task.review.message)),
      ...(task.review.body ? [tr('提交正文：', 'Commit body:'), ...task.review.body.split('\n').map(clean)] : [])] : []),
    ...commandFiles(files, compact),
  ].join('\n')
}

async function confirmRemoval(ctx: ExtensionContext, data: TaskStore, task: Task, title: string) {
  const proof = await withLoading(ctx, tr('正在检查保留的 Worktree…', 'Checking retained Worktree…'), () => data.inspectRetainedRemoval(task, ctx.cwd))
  const remove = await pick(ctx, title, [
    tr('强删将永久移除此目录，包括未交付改动和忽略文件。', 'Force removal permanently deletes this directory, including undelivered changes and ignored files.'),
    tr('目标目录：', 'Target directory:'), task.isolatedPath,
    tr('先备份需要的文件，并关闭其他使用该目录的会话。', 'Back up anything you need and close other sessions using this directory.'),
    tf('原因：{0}', 'Reason: {0}', task.cleanup?.reason ?? tr('保留环境', 'Retained environment')),
  ], [{ label: tr('确认强删 Worktree', 'Force-remove Worktree'), value: true, tone: 'danger' }, { label: tr('保留 Worktree', 'Keep Worktree'), value: false, tone: 'quiet' }],
  { tone: 'danger', requiredDetails: 3 })
  if (!remove || !ctx.isIdle()) return
  await withLoading(ctx, tr('正在删除 Worktree…', 'Removing Worktree…'), () => data.removeRetained(task.id, ctx.cwd, proof))
  ctx.ui.notify(tr('Worktree 已删除；项目目录与对话历史未改动。', 'Worktree removed. The project folder and conversation history are unchanged.'), 'info')
}

export default function extension(pi: ExtensionAPI) {
  const preferencesDir = join(getAgentDir(), NAME)
  loadDisplayLanguage(preferencesDir)
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
  let conflictKickoff = false
  let activeHold: { data: TaskStore; id: string; editor: boolean } | undefined
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
  async function isWorkflowEditor(ctx: ExtensionContext, data: TaskStore, task: Task): Promise<boolean> {
    const link = sessionLink(ctx)
    return !!link && editingSession(ctx, task) && (!task.external || await data.isEditingSession(task, link).catch(() => false))
  }
  const isBuiltin = (name: string) => pi.getAllTools().some(tool => tool.name === name && tool.sourceInfo.path === `builtin:${name}`)
  async function verifyExternalEditor(data: TaskStore, task: Task, link?: SessionLink) {
    if (!link || !await data.isEditingSession(task, link)) throw new Error(tr('只能在绑定的 Worktree 源对话中返修。', 'Revisions must run in the linked source Worktree conversation.'))
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
            if (busy || draft || clickIntent || !ctx.isIdle()) ctx.ui.notify(tr('请等待当前操作结束。', 'Wait for the current operation to finish.'), 'warning')
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
          label: !view ? tr('历史会话记录无效 · 请退出此会话', 'Invalid history view · Close this session') : pending ? tr('任务对话', 'Task conversation') : !view.afterCommit ? HISTORY_HINT() :
            historyCanFollowUp ? tf('{0} · 只读对话', '{0} · Read-only conversation', prior?.phase === 'discarded' ? tr('已放弃', 'Discarded') : tr('已交付', 'Delivered')) :
            prior?.journal ? tr('操作已停止 · 请检查恢复记录', 'Operation stopped · Check the recovery record') : tr('任务对话 · 尚未交付', 'Task conversation · Not delivered'),
          tone: view?.afterCommit && historyCanFollowUp ? 'success' : 'warning',
        },
        buttons: view && !pending ? [
          ...(canResume ? [{ label: tr('[ 回到 Worktree ]', '[ Back to Worktree ]'), value: 'resume' as const }] : []),
          { label: tr('[ 返回原对话 ]', '[ Return to original ]'), value: 'back' },
        ] : [],
      }), choice => pi.sendUserMessage(`/${NAME} ${choice}`, { expandPromptTemplates: true }))
      return
    }
    const state = await context(ctx)
    if (!state.local && !state.isolated) { ctx.ui.setWidget(NAME, undefined); return }
    const active = currentTask(ctx, state.isolated, state.tasks)
    const direct: Choice<MenuAction>[] = deliveryChoices(active)
    if (state.isolated && active?.phase === 'previewed' && !active.journal) direct.push(localCheck())
    if (active?.phase === 'working' && active.recovery && !active.journal) direct.push(recoverChoice())
    else if (!state.isolated && active?.phase === 'working' && !active.journal && active.isolatedSession) {
      direct.push({ ...resumeChoice(), tone: 'primary' })
    }
    const showCreate = !!state.local && (!active || !isOpenTask(active))
    const id = ctx.sessionManager.getSessionId()
    const selected = () => armed?.sessionId === id
    installToolbar<MenuAction | 'menu'>(ctx, () => ({
      status: state.isolated || active ? { label: phaseLabel(!!state.isolated, active), tone: phaseTone(active) } : undefined,
      buttons: [
        ...(showCreate ? [{ label: tf('[{0}] 新建 Worktree', '[{0}] New Worktree', selected() ? 'x' : ' '), value: 'arm' as const, tone: 'primary' as const, checked: selected() }] : []),
        ...direct.map(({ label, ...choice }) => ({ ...choice, label: `[ ${label} ]` })),
        ...(historyTasks(state.tasks).length ? [{ label: tr('[ 任务历史 ]', '[ Task history ]'), value: 'history' as const }] : []),
        { label: tr(' ⋯ 更多 ', ' ⋯ More '), value: 'menu' as const, trailing: true },
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
    if (revising || commandAsk || conflictKickoff || delivering(ctx)) {
      if (ctx.hasUI) ctx.ui.notify(tr('请等待当前操作结束。', 'Wait for the current operation to finish.'), 'warning')
      return { cancel: true }
    }
    try {
      if (pendingHold && pendingHold.id !== activeHold?.id) await pendingHold.data.releaseWorktree(pendingHold.id)
      pendingHold = undefined
      const file = event.targetSessionFile
      if (!file) return
      const targetCwd = await sessionCwd(file)
      if (!targetCwd) return
      const path = await realpath(targetCwd).catch(() => targetCwd)
      const data = store ??= new TaskStore(join(await realpath(getAgentDir()), NAME))
      // Only sessions entering the plugin-owned directory can need a lease.
      const prefix = join(data.directory, 'worktrees') + sep
      if (!path.startsWith(prefix) && !targetCwd.startsWith(prefix)) return
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
        const targetCwd = await sessionCwd(event.targetSessionFile)
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
        activeHold = { data, id: isolated.id, editor: editingSession(ctx, isolated) }
        incomingHoldFailed = false
      }
      await refresh(ctx)
    } catch (error) { if (ctx.hasUI) ctx.ui.notify(message(error), 'error') }
  })
  pi.on('input', (event, ctx) => {
    if (incomingHoldFailed) {
      if (ctx.hasUI && (event.source === 'interactive' || event.source === 'rpc')) restoreDraft(ctx, event.text)
      if (ctx.hasUI) ctx.ui.notify(tr('无法确认 Worktree 会话占用，请退出后重试。', 'Could not confirm the Worktree session hold. Exit and try again.'), 'error')
      return { action: 'handled' }
    }
    const history = historyView !== undefined
    if (revising || runningCommand || conflictKickoff || delivering(ctx) && !history) {
      if (ctx.hasUI) { restoreDraft(ctx, event.text); commandNotice(ctx, 'error', tr('操作尚未结束；消息未发送。', 'An operation is in progress. Message not sent.')) }
      return { action: 'handled' }
    }
    if (history && (!historyView || event.source !== 'interactive' || !ctx.hasUI)) return { action: 'handled' }
    if ((event.source !== 'interactive' && event.source !== 'rpc') || !ctx.hasUI || (!event.text.trim() && !event.images?.length)) return
    if (history && !historyCanFollowUp) {
      restoreDraft(ctx, event.text)
      ctx.ui.notify(delivering(ctx) ? tr('请等待提交操作结束；消息未发送。', 'Wait for the commit to finish. Message not sent.') : tr('目前不能从此处继续。请回到 Worktree，或检查恢复记录。', 'Cannot continue from here. Return to the Worktree or check the recovery record.'), 'warning')
      return { action: 'handled' }
    }
    confirmation = undefined // Task input invalidates earlier approval.
    const sessionId = ctx.sessionManager.getSessionId()
    // Pi handles UI/extension commands outside this hook. Keep task prompts,
    // including skills, templates, and pasted paths, as raw input until switch.
    if (!history && armed?.sessionId !== sessionId) return
    if (busy || draft || historyTurn || !ctx.isIdle() || event.streamingBehavior) {
      restoreDraft(ctx, event.text)
      if (ctx.mode === 'rpc') commandNotice(ctx, 'error', tr('请等待当前操作结束再发送；消息未发送。', 'Wait for the current operation to finish before sending. Message not sent.'))
      else ctx.ui.notify(tr('请等待当前操作结束再发送；消息未发送。', 'Wait for the current operation to finish before sending. Message not sent.'), 'warning')
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
    const output = tr('历史对话不执行 shell；请返回原对话。', 'Shell commands are disabled in history views. Return to the original conversation.')
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
    const tools = event.systemPromptOptions.selectedTools.filter(name => !workflowTools.has(name))
    event.systemPromptOptions.selectedTools = tools
    delete event.systemPromptOptions.sections.worktree_preview
    const state = await workspace(ctx).catch(() => undefined)
    const candidate = state && editingTask(ctx, state)
    const task = candidate && await isWorkflowEditor(ctx, state.data, candidate) ? candidate : undefined
    const canWork = !!task && !task.journal && !incomingHoldFailed && ['working', 'ready', 'previewed'].includes(task.phase)
    const recovery = task?.recovery
    if (canWork) tools.push(TOOL)
    if (canWork && !recovery) tools.push(REVISE)
    else {
      // Pi can restore the live loadout between turns. Keep tools that do
      // not apply to this phase out of that loadout as well as this prompt.
      const active = pi.getActiveTools()
      const applicable = active.filter(name => !workflowTools.has(name) || (canWork && name === TOOL))
      if (applicable.length !== active.length) pi.setActiveTools(applicable)
    }
    if (!task) return
    const guidance = canWork && recovery
      ? `Conflict recovery is already authorized; no revision or further approval is needed. For conflict work, ${recovery.workspace ? 'resolve only unmerged paths in the independent directory and stage the results, without committing' : 'use the existing checkpoint or merge if present; otherwise follow the conflict request to checkpoint the reviewed changes and merge the pinned commit in this Worktree. Resolve only unmerged paths and complete the merge'}. Keep auto-merged files unchanged. Verify the result and call ${TOOL} with the full task file list relative to ${recovery.localHeadOid}. Do not preview. For discussion, do not edit.`
      : canWork && task.external
      ? `Status: ${task.phase}. For requested edits in ready or previewed state, call ${REVISE} alone and wait for success; on cancellation stop. If already working, continue directly. After editing and testing, call ${TOOL} alone with the exact paths for the current task, including earlier changes still intended for delivery and any newly relevant paths. Exclude unrelated files. For discussion, leave the review unchanged.`
      : canWork
      ? `Status at the start of this request: ${task.phase}. For questions, explanations, and discussion, use read-only tools; do not invalidate a review or ask to roll back. If the user actually requests changes after a review was marked ready (including when a Local preview is active), call ${REVISE} alone before editing or running shell commands. The tool handles any required user confirmation. Wait for its success, then implement the existing request yourself in this Worktree, in the same turn, without asking the user to repeat it. If cancelled or unsuccessful, do not edit or retry unless asked again. After verifying, call ${TOOL} with a short commit title and only the exact repo-relative paths for the entire task, including earlier rounds and both sides of renames. Never blindly submit git status or include unrelated runtime/generated files. Then stop editing.`
      : task.external ? 'Worktree delivery tools are unavailable in the current task state. Use the host client’s normal tools as appropriate.' :
        'This managed task is not editable. Use it for inspection only; do not modify files or mark it ready.'
    const ownership = task.recovery?.workspace ? `For conflict recovery, work only in ${JSON.stringify(task.recovery.workspace.checkout.root)}, not in the source or delivery checkout.` :
      task.external ? 'This is an adopted external Git worktree. Work in the source checkout, not the delivery target.' :
      'This is a managed isolated Git worktree. Work only in the active Worktree cwd.'
    const delivery = task.external ? 'The user controls the plugin’s preview, rollback, delivery and discard actions.' :
      'Do not write to Local yourself; the user alone controls preview, rollback, delivery and discard.'
    event.systemPromptOptions.sections.worktree_preview = `${ownership} ${guidance} ${delivery}`
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
      return { block: true, reason: tr('历史对话只读，不执行修改或 shell。', 'History is read-only. Editing and shell commands are disabled.') }
    }
    if (event.toolName === FOLLOW_UP || canReadInHistory(event.toolName)) return
    const workflowTool = event.toolName === TOOL || event.toolName === REVISE
    // A lease protects the directory from cleanup; only the bound managed
    // conversation gets editing gates. Adopted sessions use the host tools.
    const managedEditor = activeHold?.editor || incomingHoldFailed
    if (!workflowTool && (!managedEditor || !guardedTools.has(event.toolName))) return
    let state: Awaited<ReturnType<typeof workspace>>
    try { state = await workspace(ctx) }
    catch (error) { return managedEditor ? { block: true, reason: tf('无法核对 Worktree 状态：{0}', 'Could not verify Worktree state: {0}', message(error)) } : undefined }
    const task = editingTask(ctx, state)
    if (!managedEditor && (!task || !await isWorkflowEditor(ctx, state.data, task))) return
    const assistant = ctx.sessionManager.getBranch().reverse().find(entry => entry.type === 'message' && entry.message.role === 'assistant')
    const calls = assistant?.type === 'message' && assistant.message.role === 'assistant'
      ? assistant.message.content.filter(part => part.type === 'toolCall') : []
    if ((calls.length > 1 && calls.some(call => call.name === TOOL || call.name === REVISE)) ||
        (event.parentToolCallId && (event.toolName === TOOL || event.toolName === REVISE))) {
      return { block: true, reason: tf('{0} 和 {1} 都必须单独调用，不可与其他工具批量执行。', '{0} and {1} must each be called on their own, not in a batch with other tools.', REVISE, TOOL) }
    }
    if (event.toolName === REVISE) return
    const canRefreshReview = task?.external && task.phase === 'ready' && event.toolName === TOOL
    if (task && (task.phase === 'working' || canRefreshReview) && !task.journal &&
        !revising && !revisionStopped && !incomingHoldFailed && editingSession(ctx, task)) {
      if ((event.toolName === 'edit' || event.toolName === 'write') &&
          (typeof event.input.path !== 'string' || !await isWorktreePath(task.isolatedPath, event.input.path, ctx.cwd))) {
        return { block: true, reason: tr('只允许编辑当前 Worktree 内的文件。', 'Only files inside the current Worktree may be edited.') }
      }
      return
    }
    const reason = !revisionStopped && task && !task.journal && editingSession(ctx, task) &&
        ['ready', 'previewed'].includes(task.phase)
      ? tf('当前处于验收阶段。如果用户要求改动，先单独调用 {0}；如果只是讨论，请用只读工具。', 'The task is under review. For requested edits, first call {0} alone. For discussion, use read-only tools.', REVISE)
      : tr('当前会话不允许编辑或执行 shell；请勿绕过。', 'Editing and shell commands are not allowed in this session. Do not bypass this restriction.')
    return { block: true, reason }
  })
  pi.registerTool({
    name: FOLLOW_UP, label: tr('开启下一轮 Worktree', 'Start next Worktree round'), defaultActive: false, exposure: 'model-only', executionMode: 'sequential',
    description: 'Answer or clarify here read-only; call this tool alone only if the user explicitly asks for project changes.',
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      if (historyView === undefined) return { content: [{ type: 'text', text: noWorkflow() }], details: {}, isError: true }
      const turn = historyTurn
      if (!turn || !historyCanFollowUp || delivering(ctx) || turn.requested || !isBoundSession(ctx, turn.source) || signal?.aborted) {
        return { content: [{ type: 'text', text: tr('未开启下一轮。', 'The next round was not started.') }], details: {}, isError: true }
      }
      turn.requested = true
      return { content: [{ type: 'text', text: tr('将在新 Worktree 继续。', 'Continuing in a new Worktree.') }], details: {}, terminate: true }
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
    name: REVISE, label: tr('开始返修', 'Start revision'), defaultActive: false, exposure: 'model-only', executionMode: 'sequential',
    description: 'Call alone only for requested edits, not discussion. Wait for any required approval and rollback; on success continue the same request, on failure stop.',
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      const result = (ok: boolean, text: string) => ({ content: [{ type: 'text' as const, text }], details: { ok }, isError: !ok })
      const state = await workspace(ctx).catch(() => undefined)
      const task = state && editingTask(ctx, state)
      const link = sessionLink(ctx)
      if (!state || !task || !link || !await isWorkflowEditor(ctx, state.data, task)) return result(false, noWorkflow())
      if (task.recovery && !task.journal && !incomingHoldFailed) {
        return result(true, tr('已在解决冲突，不需要开始返修。请按当前请求继续处理冲突，不要再次调用此工具。', 'Conflict recovery is already underway. Continue the current conflict request without calling this tool again.'))
      }
      if (busy || revisionStopped) return result(false, tr('不能开始返修。请勿编辑，也不要在本轮重试。', 'Cannot start revision. Do not edit or retry in this turn.'))
      busy = true
      revising = true
      try {
        signal?.throwIfAborted()
        const { data } = state
        const resuming = task.external && task.phase === 'working'
        const rollingBack = task.phase === 'previewed' && !!task.receipt
        if (incomingHoldFailed || task.journal ||
            (!resuming && (!task.review || (task.phase !== 'ready' && !rollingBack)))) {
          throw new Error(tr('当前不在可返修的 Worktree 验收状态。', 'The Worktree is not in a review state that allows revision.'))
        }
        if (task.external) await verifyExternalEditor(data, task, link)
        signal?.throwIfAborted()
        if (rollingBack) {
          const title = tr('返修前需撤回项目目录的预览', 'Undo the project preview before revising?')
          const accept = tr('撤回预览，继续返修', 'Undo preview and revise')
          const detail = [tr('撤回后，Agent 会接着处理刚才的要求。', 'The Agent will continue the request you just made once the preview is undone.'),
            tr('预览文件若已被修改，将停止并保留现场。', 'If previewed files were edited, the operation will stop and leave them as they are.'), tf('项目目录：{0}', 'Project folder: {0}', JSON.stringify(task.local.root))]
          let confirmed: boolean | undefined
          if (ctx.hasUI && ctx.mode === 'tui') {
            confirmed = await pick(ctx, title, detail, [
              { label: accept, value: true, tone: 'primary' }, { label: tr('取消', 'Cancel'), value: false, tone: 'quiet' },
            ], { signal, tone: 'warning' })
          } else if (ctx.hasUI && ctx.mode === 'rpc') {
            const ask = new AbortController()
            const approvalSignal = signal ? AbortSignal.any([signal, ask.signal]) : ask.signal
            commandAsk = ask
            const expires = Date.now() + confirmationTTL
            try {
              const choice = await ctx.ui.select([title, ...detail,
                tf('涉及 {0} 个文件。', 'Files affected: {0}.', task.receipt!.changedFiles.length)].join('\n'),
                [tr('取消', 'Cancel'), accept], { signal: approvalSignal, timeout: confirmationTTL })
              confirmed = choice === accept && !approvalSignal.aborted && Date.now() < expires
            } finally { if (commandAsk === ask) commandAsk = undefined }
          } else throw new Error(tf('请先运行 /{0}-rollback 并确认，再重试修改。', 'Run /{0}-rollback and confirm, then retry your edit request.', NAME))
          signal?.throwIfAborted()
          if (!confirmed) throw new Error(tr('未确认撤回，预览保留。', 'Rollback was not confirmed. The preview remains active.'))
        }
        if (rollingBack) {
          await withLoading(ctx, progress().rollback, () => data.act(task.id, 'rollback', {
            phase: task.phase, reviewId: task.review!.id, previewId: task.receipt!.previewId, revision: { session: link, signal }, session: link,
          }))
        } else if (resuming) {
          await withLoading(ctx, tr('正在检查返修状态…', 'Checking revision state…'), () => data.resumeExternalEditing(task.id, link, signal))
        } else {
          await withLoading(ctx, tr('正在准备返修…', 'Preparing revision…'), () => data.continueEditing(task.id, link, task.review!.id, signal))
        }
        if (task.external && ctx.mode === 'rpc') ctx.ui.setStatus(NAME, tr('Worktree 返修中', 'Worktree revision in progress'))
        return result(true, tr('已进入返修。请现在继续处理用户刚才的修改要求，只改本 Worktree，验证后重新标记待验收。', 'Revision started. Continue the user\'s request now, edit only this Worktree, verify, and mark it ready for review again.'))
      } catch (error) {
        revisionStopped = true
        return result(false, tf('{0} 不要编辑，也不要在本轮重试。', '{0} Do not edit or retry in this turn.', message(error)))
      } finally {
        await refresh(ctx).catch(() => {})
        revising = false
        busy = false
      }
    },
  })
  pi.registerTool({
    name: TOOL, label: tr('标记待验收', 'Mark ready for review'), defaultActive: false, exposure: 'model-only', executionMode: 'sequential', description: 'Mark the current Worktree ready for user review. Does not write to Local or commit. Call after edits and tests.',
    parameters: Type.Object({
      commitMessage: Type.String({ description: 'A one-line commit title (1–200 characters). Follow the language of the current task conversation, not UI labels, tool output, or automatic recovery instructions. Honor any explicit title or language requested by the user.' }),
      commitBody: Type.Optional(Type.String({ maxLength: MAX_COMMIT_BODY, description: 'Optional commit body, without the title. Add only necessary details, such as why the change was made, important behavior, or compatibility impact. Use the title language unless the user requests otherwise. Omit when the title is enough.' })),
      files: Type.Array(Type.String(), { minItems: 1, description: 'Exact repo-relative paths intentionally changed for this task, including deletions and both sides of a rename. Exclude unrelated runtime state and test artifacts.' }),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (signal?.aborted) throw new Error(tr('已取消。', 'Cancelled.'))
      const state = await workspace(ctx).catch(() => undefined)
      const link = sessionLink(ctx)
      const task = state && editingTask(ctx, state)
      if (!state || !task || !link || !await isWorkflowEditor(ctx, state.data, task)) throw new Error(noWorkflow())
      const review = await withLoading(ctx, tr('正在标记待验收…', 'Marking ready for review…'), () =>
        state.data.markReady(task.id, link, params.commitMessage, params.files, { body: params.commitBody,
          ...(task.external ? { expectedReview: { id: task.review?.id } } : {}) }))
      await refresh(ctx)
      const next = ctx.mode === 'rpc' ? tf('可运行 /{0}-preview。', 'Run /{0}-preview.', NAME) : tr('可点击「预览改动」。', 'Click “Preview changes”.')
      if (ctx.mode === 'rpc' && task.external) ctx.ui.setStatus(NAME, tf('Worktree 待验收 · {0} 个文件 · /{1}-preview', 'Worktree ready for review · Files: {0} · /{1}-preview', review.files.length, NAME))
      return { content: [{ type: 'text', text: tf('已标记待验收（{0} 个文件）；未修改项目目录。{1}', 'Marked ready for review (files: {0}). The project folder was not changed. {1}', review.files.length, next) }], details: { reviewId: review.id } }
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
        if (!local || isolated) throw new Error(tr('只能从原 Git 项目目录新建 Worktree。', 'Create a Worktree from the original Git project folder.'))
        if (process.platform === 'win32') throw new Error(tr('当前版本仅支持 macOS/Linux。', 'Only macOS and Linux are currently supported.'))
        const active = sessionLink(current)
        if (!active || view === null) throw new Error(tr('无有效的持久化 Pi 会话，不能新建 Worktree。', 'A saved Pi session is required to create a Worktree.'))
        const source = view?.returnTo ?? active
        if (tasks.some(task => task.localSession.id === source.id && task.localSession.file === source.file &&
            task.localSession.cwd === source.cwd && isOpenTask(task))) throw new Error(sessionBusy())
        const created = await withLoading(current, tr('正在创建 Worktree…', 'Creating Worktree…'), async () => {
          await validateSession(source)
          if (view && !inherited) throw new Error(tr('缺少续接对话记录。', 'The conversation history needed to continue is missing.'))
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
          try { pi.setSessionName(tf('原对话 · {0}', 'Original conversation · {0}', summary)) } catch { /* optional metadata */ }
        }
        const result = await switchTo(current, target, tr('正在进入 Worktree…', 'Opening Worktree…'), async next => {
          entered = replaced = true
          try {
            if (!isBoundSession(next, target)) throw new Error(tr('Pi 未进入预期的隔离 Worktree。', 'Pi did not enter the expected isolated Worktree.'))
            if (view) await rm(active.file, { force: true }).catch(() => {})
            if (next.mode === 'rpc') commandNotice(next, 'ok', tf('已进入 Worktree {0} · {1}', 'Opened Worktree {0} · {1}', JSON.stringify(target.cwd), target.id))
            await next.sendUserMessage(images?.length ? [{ type: 'text', text }, ...images] : text, { expandPromptTemplates: true })
          } catch (error) {
            restoreDraft(next, text)
            const detail = tf('无法在 Worktree 发送消息：{0}{1}', 'Could not send the message in the Worktree: {0}{1}', message(error), images?.length ? tr('；请重新附加图片。', ' Reattach the images and try again.') : '')
            if (next.mode === 'rpc') commandNotice(next, 'error', detail)
            else next.ui.notify(detail, 'error')
          }
        })
        if (result.cancelled) throw new Error(tf('Pi 取消了切换；{0}可从工作台恢复已创建的 Worktree。', 'Pi cancelled the switch. {0}You can resume the Worktree from the menu.', view ? tr('返回原对话后，', 'Return to the original conversation first. ') : ''))
      } catch (error) {
        if (!entered && current !== ctx) {
          restoreDraft(current, text)
          const detail = tf('消息未发送：{0}{1}', 'Message not sent: {0}{1}', message(error), images?.length ? tr('；请重新附加图片。', ' Reattach the images and try again.') : '')
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
      if (!ctx.isIdle() || sessionId !== ctx.sessionManager.getSessionId()) throw new Error(tr('当前对话已变化或忙碌。', 'The current conversation changed or is busy.'))
      if (view) await create(ctx, () => {})
      else {
        const localBranch = captureLocalBranch(ctx)
        await withSavedLocal(ctx, async (current, send) => {
          if (current !== ctx) replaced = true
          await create(current, send, localBranch)
        }, summary ? tf('原对话 · {0}', 'Original conversation · {0}', summary) : undefined)
      }
    } catch (error) {
      if (!replaced) {
        restoreDraft(ctx, text)
        const detail = tf('消息未发送：{0}{1}', 'Message not sent: {0}{1}', message(error), images?.length ? tr('；请重新附加图片。', ' Reattach the images and try again.') : '')
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

  function scheduleConflictTurn(ctx: ExtensionContext, data: TaskStore, task: Task, session: SessionLink, recovery: NonNullable<Task['recovery']>) {
    conflictKickoff = true
    setImmediate(() => { void (async () => {
      try {
        await data.resumeConflictRecovery(task.id, session, recovery)
        if (!isBoundSession(ctx, session) || !ctx.isIdle() || busy || runningCommand) {
          throw new Error(tr('未启动 Agent；可在原对话继续解决冲突。', 'The Agent did not start. You can resume conflict recovery from the original conversation.'))
        }
        conflictKickoff = false // Allow just this extension-initiated input to pass.
        pi.sendUserMessage(conflictPrompt(recovery))
      } finally { conflictKickoff = false }
    })().catch(error => { try { commandNotice(ctx, 'error', message(error)) } catch { /* Session closed. */ } }) })
  }

  async function setLanguage(ctx: ExtensionContext, language: 'zh' | 'en') {
    if (language !== getDisplayLanguage()) {
      await saveDisplayLanguage(preferencesDir, language)
      registerCommands()
    }
    const text = tr('显示语言：简体中文', 'Display language: English')
    commandNotice(ctx, 'ok', text, text)
  }

  async function runCommand(ctx: ExtensionCommandContext, args: string) {
    let replaced = false
    let kickoff: (() => void) | undefined
    if (busy || draft || conflictKickoff || !ctx.isIdle() || delivering(ctx)) {
      commandNotice(ctx, 'error', commandAsk ? tr('请先回答或关闭当前确认。', 'Answer or close the current confirmation first.') : tr('当前对话忙碌，请等待操作结束。', 'This conversation is busy. Wait for the current operation to finish.'))
      return
    }
    busy = runningCommand = true
    try {
      const command = parseWorktreeCommand(args)
      let approval = confirmation
      if (command.kind !== 'status' && command.kind !== 'help' && command.kind !== 'language') confirmation = undefined
      if (command.kind === 'help') {
        commandNotice(ctx, 'ok', tf('Worktree 命令：\n{0}', 'Worktree commands:\n{0}', standaloneCommands().map(([verb, usage, description]) =>
          `/${NAME}-${verb}${usage} — ${description}`).join('\n')))
        return
      }
      if (command.kind === 'language') {
        if (command.language) await setLanguage(ctx, command.language)
        else {
          const text = tr('显示语言：简体中文', 'Display language: English')
          commandNotice(ctx, 'ok', text, text)
        }
        return
      }
      if (command.kind === 'cancel') {
        armed = undefined
        commandNotice(ctx, 'ok', tr('已取消待确认操作／下次新建。', 'Pending operation or next Worktree creation cancelled.'), tr('Worktree · 已取消', 'Worktree · Cancelled'))
        return
      }
      const link = sessionLink(ctx)
      if (!link || historyView !== undefined || incomingHoldFailed) throw new Error(tr('当前不是可操作的持久化 Pi 会话。', 'This is not a saved Pi session that can perform the operation.'))
      const { local, isolated, tasks, data } = await context(ctx)
      const task = currentTask(ctx, isolated, tasks)
      if (command.kind === 'status') {
        commandNotice(ctx, 'ok', JSON.stringify(task ? { id: task.id, phase: task.phase, external: !!task.external,
          source: task.isolatedPath, target: task.local.root, ready: task.review?.files,
          preview: task.receipt?.changedFiles, commit: task.commitOid, cleanup: task.cleanup,
          conflict: task.recovery?.workspace && { directory: task.recovery.workspace.checkout.root, files: task.recovery.conflictingFiles },
          ...(task.journal ? { recovery: data.statePath, operation: task.journal.operation } : {}) } :
          { phase: 'none', cwd: ctx.cwd, armed: armed?.sessionId === link.id }))
        return
      }
      if (command.kind === 'new') {
        if (!local || isolated || process.platform === 'win32') throw new Error(tr('只能从受支持的原 Git 项目目录新建 Worktree。', 'Create a Worktree from a supported original Git project folder.'))
        if (task && isOpenTask(task)) throw new Error(sessionBusy())
        armed = { sessionId: link.id }
        commandNotice(ctx, 'ok', tr('下次发送的任务消息将在新 Worktree 中执行。', 'Your next task message will run in a new Worktree.'), tr('下次发送时新建 Worktree', 'Create a Worktree on the next send'))
        return
      }
      const move = async (target: SessionLink, execute: (next: ExtensionContext) => Promise<void>) => {
        const result = await switchTo(ctx, target, tr('正在切换对话…', 'Switching conversation…'), async next => {
          replaced = true
          try {
            if (!isBoundSession(next, target) || !next.isIdle()) throw new Error(tr('未进入预期的空闲会话。', 'Could not enter the expected idle conversation.'))
            await execute(next)
          } catch (error) { commandNotice(next, 'error', message(error)) }
          finally { await refresh(next).catch(() => {}) }
        })
        if (result.cancelled) throw new Error(tr('Pi 取消了切换，未执行操作。', 'Pi cancelled the switch. No operation was performed.'))
      }
      if (command.kind === 'back' || command.kind === 'resume') {
        if (!task || task.external) throw new Error(tr('没有可切换的插件 Worktree 对话；外部 Worktree 由原客户端管理。', 'No managed Worktree conversation to switch to. External Worktrees are managed by their host client.'))
        const target = command.kind === 'back' && isolated ? task.localSession :
          command.kind === 'resume' && !isolated && !task.journal && task.phase !== 'creating' &&
          (isOpenTask(task) || task.cleanup?.status === 'retained') ? task.isolatedSession : undefined
        if (!target) throw new Error(tr('当前没有可切换的对话。', 'There is no conversation to switch to.'))
        if (command.kind === 'back') await data.validateLocalIdentity(task)
        else await data.validateIsolatedIdentity(task)
        await move(target, async next => commandNotice(next, 'ok', JSON.stringify({ cwd: target.cwd, session: target.id })))
        return
      }
      const offer = async (candidate: NonNullable<Confirmation>, details: string, accept: string, text?: true) => {
        if (ctx.mode !== 'rpc' || text) {
          confirmation = candidate
          commandNotice(ctx, 'confirm', tf('{0}\n5 分钟内运行 /{1}-confirm {2}，或 /{3}-cancel。', '{0}\nWithin 5 minutes, run /{1}-confirm {2} or /{3}-cancel.', details, NAME, candidate.token, NAME), tr('Worktree · 等待确认', 'Worktree · Awaiting confirmation'))
          return
        }
        // A native select requires an explicit choice every time. Some hosts
        // cache yes/no approvals for the entire session; do not use confirm.
        const ask = new AbortController()
        commandAsk = ask
        let choice: string | undefined
        try { choice = await ctx.ui.select(details, [tr('取消', 'Cancel'), accept], { signal: ask.signal, timeout: confirmationTTL }) }
        finally { if (commandAsk === ask) commandAsk = undefined }
        if (choice !== accept || ask.signal.aborted || Date.now() >= candidate.expires) {
          commandNotice(ctx, 'ok', tr('未执行操作。', 'The operation was not performed.'), tr('Worktree · 未执行操作', 'Worktree · Not performed'))
          return
        }
        if (!isBoundSession(ctx, candidate.session) || !ctx.isIdle() || delivering(ctx)) throw new Error(tr('验收对话已变化，未执行操作。', 'The review conversation changed. The operation was not performed.'))
        return candidate
      }
      const registerAdoption = async (owner: SessionLink, request: AdoptionRequest, shown: AdoptionInspection) => {
        await withSavedLocal(ctx, async (next, send) => {
          if (next !== ctx) replaced = true
          try {
            if (!isBoundSession(next, owner) || !next.isIdle()) throw new Error(tr('接入对话已变化，未登记。', 'The adoption conversation changed. Nothing was registered.'))
            const registered = await withLoading(next, tr('正在接入外部 Worktree…', 'Adopting external Worktree…'), () => data.adopt(owner, request, shown))
            armed = undefined
            const files = registered.review?.files ?? []
            commandNotice(next, 'ok', [tf('已接入 · {0} 个文件。可直接运行 /{1}-preview。', 'Worktree adopted · Files: {0}. Run /{1}-preview to continue.', files.length, NAME),
              tf('未改动源或目标目录。任务：{0}', 'The source and target directories were not changed. Task: {0}', registered.id), ...adoptionDetails(shown), ...numberedAdoptionFiles(files),
            ].join('\n'), tf('Worktree 已接入 · {0} 个文件 · 下一步：/{1}-preview', 'Worktree adopted · Files: {0} · Next: /{1}-preview', files.length, NAME))
          } catch (error) { commandNotice(next, 'error', message(error)) }
          finally {
            // A native reopen loads a new extension runtime. Let that runtime
            // install the widget so its click handler can dispatch commands.
            if (next !== ctx && next.mode === 'tui') {
              try { await send(`/${NAME} refresh`) } catch { /* Registration is already durable. */ }
            }
          }
        }, tr('外部 Worktree · 验收', 'External Worktree · Review'))
      }
      if (command.kind === 'selectAdoption') {
        if (!task?.external || task.phase !== 'ready' || !task.review || task.journal) {
          throw new Error(tr('只能调整本对话中尚未预览的外部 Worktree 清单。', 'Only an unpreviewed external Worktree in this conversation can have its file list narrowed.'))
        }
        const review = task.review
        if (command.numbers.some(number => number > review.files.length)) throw new Error(tr('文件编号不在当前清单中。', 'A file number is outside the current list.'))
        const selected = new Set(command.numbers)
        const files = review.files.filter((_file, index) => selected.has(index + 1))
        const updated = await withLoading(ctx, tr('正在更新交付清单…', 'Updating delivery scope…'), () => data.restrictReview(task.id, link, review.id, files))
        commandNotice(ctx, 'ok', [tr('已缩小交付清单；可继续预览。', 'Delivery scope narrowed. You can preview now.'), ...numberedAdoptionFiles(updated.files)].join('\n'),
          tf('交付清单已更新 · {0} 个文件 · 下一步：/{1}-preview', 'Delivery scope updated · Files: {0} · Next: /{1}-preview', updated.files.length, NAME))
        return
      }
      if (command.kind === 'adopt' || command.kind === 'discoverAdoption') {
        if (isolated || task && isOpenTask(task)) throw new Error(tr('已有进行中任务；请从未绑定的源或目标对话接入。', 'A task is already active. Adopt from an unbound source or target conversation.'))
        const inspect = <T>(run: () => Promise<T>) => withLoading(ctx, tr('正在检查外部 Worktree…', 'Checking external Worktree…'), run)
        if (command.kind === 'discoverAdoption') {
          const shown = await inspect(() => data.discoverAdoption(link))
          await registerAdoption(link, {
            source: shown.isolated.root, target: shown.local.root, base: shown.baseOid,
            title: shown.review.message, files: shown.review.files,
          }, shown)
        } else {
          const shown = await inspect(() => data.inspectAdoption(link, command.request))
          const accepted = await offer({ kind: 'adopt', request: command.request, shown, token: randomUUID(), expires: Date.now() + confirmationTTL, session: link },
            [tr('接入外部 Worktree？只登记，不改动两个目录。', 'Adopt this external Worktree? Registers it without changing either directory.'), ...adoptionDetails(shown),
              ...commandFiles(shown.review.files, ctx.mode === 'rpc' && !command.text)].join('\n'), tr('接入 Worktree', 'Adopt Worktree'), command.text)
          if (accepted?.kind === 'adopt') await registerAdoption(accepted.session, accepted.request, accepted.shown)
        }
        return
      }
      const startRecovery = async (approved: Task, conflict: PreviewConflict) => {
        if (!approved.external || !approved.review || !await data.isEditingSession(approved, link)) throw new Error(tr('请在绑定的源 Worktree 对话中解决冲突。', 'Resolve conflicts from the linked source Worktree conversation.'))
        const recovery = await withLoading(ctx, tr('正在准备冲突处理…', 'Preparing conflict recovery…'), () => data.beginConflictRecovery(approved.id, link, approved.review!.id, conflict.plan))
        commandNotice(ctx, 'ok', tr('已准备独立冲突目录，未修改两个 checkout。', 'Prepared a separate conflict directory. Neither checkout was changed.'), tr('Worktree · 解决冲突中', 'Worktree · Resolving conflicts'))
        kickoff = () => scheduleConflictTurn(ctx, data, approved, link, recovery)
      }
      if (command.kind === 'recover') {
        if (!task?.external || !task.recovery?.workspace) throw new Error(tr('当前没有可继续的外部冲突处理。', 'There is no external conflict resolution to resume.'))
        const recovery = task.recovery
        await data.resumeConflictRecovery(task.id, link, recovery)
        commandNotice(ctx, 'ok', tr('正在继续解决冲突。', 'Resuming conflict resolution.'), tr('Worktree · 解决冲突中', 'Worktree · Resolving conflicts'))
        kickoff = () => scheduleConflictTurn(ctx, data, task, link, recovery)
        return
      }
      if (command.kind === 'action') {
        if (!task || task.journal || (command.verb === 'preview' ? task.phase !== 'ready' :
            command.verb === 'discard' ? !((task.external || isolated) && ['ready', 'working'].includes(task.phase)) :
              task.phase !== 'previewed')) throw new Error(tr('当前任务阶段或对话不允许此操作；先查看 status。', 'This task state or conversation does not allow that operation. Check status first.'))
        const act = commandActions[command.verb]
        const discardFingerprint = act === 'discard' && !task.external ? await data.discardFingerprint(task) : undefined
        const accept = task.external && act === 'discard' ? tr('解除登记', 'Unlink') : act === 'finalize' && task.external ? tr('提交', 'Commit') : confirmationCopy()[act].button
        approval = await offer({ kind: 'action', task, verb: command.verb, discardFingerprint, text: command.text, token: randomUUID(), expires: Date.now() + confirmationTTL, session: link },
          commandActionDetails(task, act, ctx.mode === 'rpc' && !command.text), accept, command.text)
        if (!approval) return
      } else if (command.kind !== 'confirm' || !approval || approval.token !== command.token || approval.expires <= Date.now() ||
          !isBoundSession(ctx, approval.session)) throw new Error(tr('确认码无效、已使用或已过期；请重新发起操作。', 'The confirmation code is invalid, used, or expired. Start the operation again.'))
      if (approval.kind === 'adopt') {
        await registerAdoption(approval.session, approval.request, approval.shown)
        return
      }
      const approved = approval.task
      if (!task || task.id !== approved.id || taskVersion(task) !== taskVersion(approved)) throw new Error(tr('任务已变化；请重新发起操作。', 'The task changed. Start the operation again.'))
      if (approval.kind === 'recover') { await startRecovery(approved, approval.conflict); return }
      const useText = approval.text
      const act = commandActions[approval.verb]
      const execute = async (next: ExtensionContext) => {
        const owner = sessionLink(next)
        if (!owner) throw new Error(tr('确认会话已变化。', 'The confirmation conversation changed.'))
        const result = await data.act(approved.id, act, { session: owner, phase: approved.phase,
          reviewId: approved.review?.id, previewId: approved.receipt?.previewId, discardFingerprint: approval.discardFingerprint })
        const outcome = result.external && act === 'discard' ? tr('已解除登记。', 'Worktree unlinked.') : completed()[act]
        commandNotice(next, 'ok', `${outcome}${result.commitOid ? ` · ${result.commitOid}` : ''}` +
          (result.external ? tr(' 外部 Worktree 未修改或删除。', ' The external Worktree was not modified or deleted.') : result.cleanup?.status === 'retained' ?
            tf(' Worktree 保留：{0}', ' Worktree retained: {0}', result.cleanup.reason ?? result.isolatedPath) : result.cleanup?.status === 'done' ? tr(' Worktree 已清理。', ' Worktree cleaned up.') : ''),
          `Worktree · ${outcome}${result.commitOid ? ` · ${result.commitOid.slice(0, 12)}` : ''}`)
      }
      if (!approved.external && isolated && (act === 'finalize' || act === 'discard')) {
        await data.validateLocalIdentity(approved)
        const target = approved.localSession
        if (pendingDelivery.has(target.file)) throw new Error(tr('目标对话正有其他 Worktree 操作。', 'The target conversation is busy with another Worktree operation.'))
        pendingDelivery.add(target.file)
        try { await move(target, execute) }
        finally { pendingDelivery.delete(target.file) }
      } else {
        try { await execute(ctx) }
        catch (error) {
          if (!(error instanceof PreviewConflict) || act !== 'preview' || !approved.external || !error.plan.cleanEntries ||
              !error.plan.committedConflictingFiles.length || !await data.isEditingSession(approved, link)) throw error
          const accepted = await offer({ kind: 'recover', task: approved, conflict: error, token: randomUUID(), expires: Date.now() + confirmationTTL, session: link },
            [tr('预览冲突 · 项目目录未修改。', 'Preview conflict · Project folder unchanged.'), tf('提交冲突：{0} 个文件。', 'Files with committed conflicts: {0}.', error.plan.committedConflictingFiles.length),
              tr('仅在独立目录解决；完成后重新验收。', 'Resolve in a separate directory and mark ready again.')].join('\n'), tr('让 Agent 解决冲突', 'Let Agent resolve conflicts'), useText)
          if (accepted?.kind === 'recover') await startRecovery(approved, error)
        }
      }
    } catch (error) { if (!replaced) commandNotice(ctx, 'error', message(error)) }
    finally {
      if (!replaced) await refresh(ctx).catch(() => {})
      busy = runningCommand = false
      kickoff?.()
    }
  }

  function registerCommands() {
    for (const [verb, usage, description] of standaloneCommands()) {
      pi.registerCommand(`${NAME}-${verb}`, {
        description: `${description}${usage ? ` ${usage.trim()}` : ''}`,
        async handler(args, ctx) {
          if (ctx.hasUI) await runCommand(ctx, `${verb}${args.trim() ? ` ${args.trim()}` : ''}`)
        },
      })
    }
    pi.registerCommand(NAME, workbenchCommand())
  }

  const workbenchCommand = () => ({
    description: tr('打开 Worktree 工作台；加 help 查看命令', 'Open the Worktree menu; use help to list commands'),
    getArgumentCompletions: (prefix: string) => {
      const matches = standaloneCommands().filter(([verb]) => verb.startsWith(prefix))
      return matches.length ? matches.map(([verb, , description]) => ({ value: verb, label: verb, description })) : null
    },
    async handler(args: string, ctx: ExtensionCommandContext) {
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
      if (busy || conflictKickoff) return
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
            if (!prior || !prior.isolatedSession || prior.phase === 'delivered' || prior.phase === 'discarded') throw new Error(tr('原 Worktree 已结束，不能恢复编辑。', 'The original Worktree is finished and cannot be reopened for editing.'))
            await data.validateIsolatedIdentity(prior)
            target = prior.isolatedSession
          }
          const moved = await switchTo(ctx, target, args === 'resume' ? tr('正在回到 Worktree…', 'Returning to Worktree…') : tr('正在返回原对话…', 'Returning to original conversation…'), async next => {
            replaced = true
            if (isBoundSession(next, target)) {
              if (text) restoreDraft(next, text)
              if (viewFile) await rm(viewFile, { force: true }).catch(() => {})
            }
          })
          if (moved.cancelled) throw new Error(tr('Pi 取消了切换。', 'Pi cancelled the switch.'))
        } catch (error) { if (!replaced) ctx.ui.notify(message(error), 'error') }
        finally { busy = false }
        return
      }
      if (intent) clickIntent = undefined
      if (draft || !ctx.isIdle()) return
      busy = true
      let switching = false
      let kickoff: (() => void) | undefined
      try {
        const { local, isolated, tasks, data, cwd } = await context(ctx)
        const task = currentTask(ctx, isolated, tasks)
        if (!local && !isolated) throw new Error(tr('请从有初始提交的 Git checkout 打开 Pi。', 'Open Pi from a Git checkout with an initial commit.'))
        const choices: Choice<MenuAction>[] = [...deliveryChoices(task)]
        if (task?.phase === 'ready' && !task.external && task.review && !task.journal && !task.recovery) {
          choices.push({ label: labels().commit_ready, value: 'commit_ready' })
        }
        if (task?.phase === 'ready' && !task.journal && !task.recovery && (task.review?.files.length ?? 0) > 1 && (task.isolatedSession || task.external)) choices.push(scopeChoice())
        if (task?.phase === 'working' && task.recovery && !task.journal) choices.push(recoverChoice())
        const details: string[] = []
        if (task?.journal || task?.phase === 'creating') {
          details.push(tr('操作已停止', 'Operation stopped'), tf('恢复记录：{0}', 'Recovery record: {0}', data.statePath), tf('隔离目录：{0}', 'Isolated directory: {0}', task.isolatedPath))
        } else if (task?.cleanup?.status === 'retained') {
          details.push(tf('已保留 · {0}', 'Retained · {0}', task.cleanup.reason ?? 'Worktree'))
        } else if (task?.review) {
          details.push(tf('{0} · {1} 个文件', '{0} · Files: {1}', task.review.message, task.review.files.length))
        }
        if (isolated && task) {
          choices.push(task.phase === 'previewed' && !task.journal ? localCheck() : { label: tr('返回原对话', 'Return to original conversation'), value: 'return' })
          if (!task.journal && ['working', 'ready'].includes(task.phase)) {
            choices.push({ label: tr('标记待验收（手动）', 'Mark ready for review (manual)'), value: 'mark' }, { label: labels().discard, value: 'discard', tone: 'danger' })
          }
        } else if (local) {
          if (!task || !isOpenTask(task)) {
            choices.push({ label: armed?.sessionId === ctx.sessionManager.getSessionId() ? tr('取消下次发送时创建', 'Cancel creation on next send') : tr('下次发送时新建 Worktree', 'Create a Worktree on the next send'), value: 'arm' })
          }
          if (historyTasks(tasks).length) choices.push(historyChoice())
          if (task && isOpenTask(task) && !task.journal && task.phase !== 'creating') {
            if (task.isolatedSession) choices.push({ ...resumeChoice(), tone: choices.length ? undefined : 'primary' })
            if (task.external && ['working', 'ready'].includes(task.phase)) choices.push({ label: tr('解除外部任务登记', 'Unlink external task'), value: 'discard' })
            if (task.external && ['working', 'ready'].includes(task.phase) && await data.isEditingSession(task, task.localSession).catch(() => false)) {
              choices.push({ label: tr('标记待验收（手动）', 'Mark ready for review (manual)'), value: 'mark' })
            }
          }
        }
        const retained = retainedTasks(tasks)
        if (retained.length) choices.push(retainedChoice())
        choices.push({ label: tr('显示语言', 'Display language'), value: 'language' }, { label: tr('关闭', 'Close'), value: 'close', tone: 'quiet' })
        if (intent && (intent.sessionId !== ctx.sessionManager.getSessionId() || intent.taskVersion !== taskVersion(task) ||
            !choices.some(option => option.value === intent.choice))) throw new Error(tr('任务状态已变化，请重新选择。', 'The task state changed. Make your selection again.'))
        const tone = phaseTone(task)
        const choice = intent?.choice ?? await pick(ctx, tr('Worktree · 更多', 'Worktree · More'), details, choices, {
          tone: tone === 'danger' || tone === 'warning' ? tone : undefined,
        })
        if (!choice || choice === 'close' || !ctx.isIdle()) return
        if (choice === 'language') {
          const language = await pick<'zh' | 'en' | undefined>(ctx, tr('显示语言', 'Display language'), [], [
            { label: `${getDisplayLanguage() === 'zh' ? '✓ ' : ''}简体中文`, value: 'zh' },
            { label: `${getDisplayLanguage() === 'en' ? '✓ ' : ''}English`, value: 'en' },
            { label: tr('取消', 'Cancel'), value: undefined, tone: 'quiet' },
          ])
          if (language && ctx.isIdle()) await setLanguage(ctx, language)
        } else if (choice === 'arm' && local) {
          if (!sessionLink(ctx)) throw new Error(tr('无持久化 Pi 会话，不能新建 Worktree。', 'A saved Pi session is required to create a Worktree.'))
          const id = ctx.sessionManager.getSessionId()
          armed = armed?.sessionId === id ? undefined : { sessionId: id }
        } else if (choice === 'history' && local) {
          const prior = await pick<Task | undefined>(ctx, tr('打开历史对话', 'Open conversation history'), [
            tr('可以继续提问；明确要求改动时才从项目目录当前 HEAD 新建 Worktree。', 'You can ask follow-up questions here. An explicit edit request starts a new Worktree from the current project HEAD.'),
          ], [
            ...historyTasks(tasks).map(item => ({ label: `${item.id.slice(0, 8)} · ${phases()[item.phase]} · ${item.review?.message ?? 'Worktree'}`, value: item })),
            { label: tr('取消', 'Cancel'), value: undefined },
          ])
          if (!prior || !ctx.isIdle()) return
          await withSavedLocal(ctx, async current => {
            if (current !== ctx) switching = true
            try {
              const { target } = await withLoading(current, tr('正在准备历史对话…', 'Preparing conversation history…'), () => makeHistoryView(data, prior, sessionLink(current)!))
              const moved = await switchTo(current, target, tr('正在打开历史对话…', 'Opening conversation history…'), async () => { switching = true })
              if (moved.cancelled) {
                await rm(target.file, { force: true })
                throw new Error(tr('Pi 取消了打开历史对话。', 'Pi cancelled opening the history view.'))
              }
            } catch (error) {
              if (current === ctx) throw error
              current.ui.notify(message(error), 'error')
            }
          })
        } else if (choice === 'return' && isolated) {
          await withLoading(ctx, tr('正在检查原对话…', 'Checking original conversation…'), () => data.validateLocalIdentity(isolated))
          const moved = await switchTo(ctx, isolated.localSession, tr('正在返回原对话…', 'Returning to original conversation…'), async () => { switching = true })
          if (moved.cancelled) throw new Error(tr('Pi 取消了切换。', 'Pi cancelled the switch.'))
        } else if (choice === 'retained' || (choice === 'resume' && task?.isolatedSession)) {
          const target = choice === 'retained' ? await pick<Task | undefined>(ctx, tr('已保留的 Worktree', 'Retained Worktrees'), [tr('选择一个已结束任务的保留目录。', 'Choose a retained directory from a finished task.')], [
            ...retained.map(item => ({ label: `${item.id.slice(0, 8)} · ${item.review?.message ?? 'Worktree'}`, value: item })),
            { label: tr('取消', 'Cancel'), value: undefined },
          ]) : task
          if (!target || !ctx.isIdle()) return
          if (choice === 'retained') {
            const next = await pick(ctx, tr('管理保留的 Worktree', 'Manage retained Worktree'), [
              tf('原因：{0}', 'Reason: {0}', target.cleanup?.reason ?? tr('保留环境', 'Retained environment')), tf('目录：{0}', 'Directory: {0}', target.isolatedPath),
            ], [
              ...(target.isolatedSession ? [{ label: tr('检查保留目录', 'Inspect retained directory'), value: 'resume' }] : []),
              { label: tr('检查并清理…', 'Check and clean up…'), value: 'remove' }, { label: tr('关闭', 'Close'), value: 'close' },
            ])
            if (!ctx.isIdle()) return
            if (next === 'remove') { await confirmRemoval(ctx, data, target, tr('确认：清理保留的 Worktree', 'Confirm retained Worktree cleanup')); return }
            if (next !== 'resume') return
          }
          if (!target.isolatedSession) return
          await withLoading(ctx, tr('正在检查 Worktree…', 'Checking Worktree…'), () => data.validateIsolatedIdentity(target))
          const moved = await switchTo(ctx, target.isolatedSession, tr('正在恢复 Worktree 会话…', 'Resuming Worktree conversation…'), async () => { switching = true })
          if (moved.cancelled) throw new Error(tr('Pi 取消了切换。', 'Pi cancelled the switch.'))
        } else if (choice === 'recover' && task?.recovery) {
          if (task.external && task.recovery.workspace) {
            const link = sessionLink(ctx)
            if (!link) throw new Error(tr('找不到绑定的 Pi 会话。', 'Could not find the linked Pi session.'))
            const recovery = task.recovery
            await data.resumeConflictRecovery(task.id, link, recovery)
            kickoff = () => scheduleConflictTurn(ctx, data, task, link, recovery)
            return
          }
          const target = task.isolatedSession
          if (!target) throw new Error(tr('找不到任务的 Worktree 会话。', 'Could not find the task\'s Worktree session.'))
          const resume = async (next: ExtensionContext, send: (text: string) => unknown) => {
            await withLoading(next, tr('正在检查冲突恢复状态…', 'Checking conflict recovery state…'), async () => {
              const latest = (await data.read()).tasks.find(item => item.id === task.id)
              if (!isBoundSession(next, target) || !next.isIdle() || latest?.phase !== 'working' || latest.journal ||
                  JSON.stringify(latest.recovery) !== JSON.stringify(task.recovery)) throw new Error(tr('冲突恢复状态已变化。', 'The conflict recovery state changed.'))
              await data.validateIsolatedIdentity(latest)
            })
            await send(conflictPrompt(task.recovery!))
          }
          if (isolated) await resume(ctx, text => pi.sendUserMessage(text))
          else {
            await withLoading(ctx, tr('正在检查 Worktree…', 'Checking Worktree…'), () => data.validateIsolatedIdentity(task))
            const moved = await switchTo(ctx, target, tr('正在恢复 Worktree 会话…', 'Resuming Worktree conversation…'), async next => {
              switching = true
              try { await resume(next, text => next.sendUserMessage(text)) }
              catch (error) { next.ui.notify(message(error), 'error') }
            })
            if (moved.cancelled) throw new Error(tr('Pi 取消了切换。', 'Pi cancelled the switch.'))
          }
        } else if (choice === 'mark' && task) {
          const link = sessionLink(ctx)
          if (!link || !editingSession(ctx, task)) throw new Error(tr('只能在绑定的 Worktree 源对话中标记待验收。', 'Mark ready for review in the linked source Worktree conversation.'))
          if (task.external) await verifyExternalEditor(data, task, link)
          const candidates = await withLoading(ctx, tr('正在扫描 Worktree 改动…', 'Scanning Worktree changes…'), () => data.reviewCandidates(task))
          const files = await chooseReviewFiles(ctx, candidates, false, task.review?.files)
          if (!files || !ctx.isIdle()) return
          await withLoading(ctx, tr('正在标记待验收…', 'Marking ready for review…'), () =>
            data.markReady(task.id, link, task.review?.message ?? 'Worktree task changes', files, {
              body: task.review?.body, expectedReview: { id: task.review?.id },
            }))
          ctx.ui.notify(tr('已标记待验收；未修改项目目录。', 'Marked ready for review. The project folder was not changed.'), 'info')
        } else if (choice === 'scope' && task?.review && (task.isolatedSession || task.external)) {
          const files = await chooseReviewFiles(ctx, task.review.files, true)
          if (!files || files.length === task.review.files.length || !ctx.isIdle()) return
          const link = sessionLink(ctx)
          if (!link) throw new Error(tr('找不到绑定的 Pi 会话。', 'Could not find the linked Pi session.'))
          const reviewId = task.review.id
          await withLoading(ctx, tr('正在更新交付清单…', 'Updating delivery scope…'), () => data.restrictReview(task.id, link, reviewId, files))
          await refresh(ctx)
          ctx.ui.notify(tr('已更新交付清单；未修改项目目录。', 'Delivery scope updated. The project folder was not changed.'), 'info')
        } else if (task && choice in labels()) {
          const act = choice as Action
          if (act === 'discard' && !task.external && (!isolated || !isBoundSession(ctx, task.isolatedSession))) throw new Error(tr('只能在任务的 Worktree 对话中放弃。', 'Discard from the task\'s Worktree conversation.'))
          const discardFingerprint = act === 'discard' && !task.external
            ? await withLoading(ctx, tr('正在检查可放弃的 Worktree…', 'Checking whether the Worktree can be discarded…'), () => data.discardFingerprint(task)) : undefined
          const copy = task.external && act === 'discard' ? { title: tr('解除登记？', 'Unlink Worktree?'), lead: tr('只解除登记，不修改源或项目目录。', 'Only removes the registration. The source and project folders stay unchanged.'), button: tr('解除登记', 'Unlink') } :
            task.external && act === 'finalize' ? { ...confirmationCopy()[act], button: tr('提交预览', 'Commit preview') } : confirmationCopy()[act]
          const commits = act === 'finalize' || act === 'commit_ready'
          const leavesWorktree = commits && !!isolated
          const partial = commits && !task.external && !!task.review?.partial
          const relevantFiles = (act === 'commit_ready' ? task.review?.files : task.receipt?.changedFiles ?? task.review?.files) ?? []
          const detail = [
            ...(commits && task.review ? [tf('提交标题：{0}', 'Commit title: {0}', task.review.message.trim())] : []),
            act === 'discard' ? tr('隔离 Worktree', 'Isolated Worktree') : tf('项目目录{0}', 'Project folder{0}', relevantFiles.length ? tf(' · {0} 个文件', ' · Files: {0}', relevantFiles.length) : ''),
            act === 'discard' ? task.isolatedPath : task.local.root,
          ]
          if (act === 'discard') detail.unshift(copy.lead)
          if (leavesWorktree) detail.push(tr('提交后保留当前对话。', 'The current conversation stays open after committing.'))
          const externalPreview = !!task.external && act === 'preview'
          if (externalPreview) detail.push(tf('目标分支：{0}', 'Target branch: {0}', task.localHeadRef), tf('起点：{0}', 'Base: {0}', task.baseOid), tr('来源：', 'Source:'), task.isolatedPath)
          if (task.external && commits) detail.push(tr('外部 Worktree 由原工具管理，不会删除。', 'The external host manages this Worktree. It will not be deleted.'))
          if (partial) detail.push(tr('清单外有改动，将保留 Worktree。', 'There are changes outside the delivery scope, so the Worktree will be retained.'))
          if (commits && task.review?.body) detail.push(tr('提交正文：', 'Commit body:'), ...task.review.body.split('\n').map(line => line.replaceAll('\t', '    ')), '')
          if (commits || externalPreview) detail.push(...relevantFiles.map(path => `• ${JSON.stringify(path)}`))
          const decision = await pick<'execute' | 'keep' | undefined>(ctx, copy.title, detail, [
            { label: partial ? tr('提交并保留', 'Commit and keep') : copy.button, value: 'execute', tone: act === 'discard' ? 'danger' : 'primary' },
            ...(commits && !partial && !task.external ? [{ label: tr('提交并保留', 'Commit and keep'), value: 'keep' as const }] : []),
            { label: tr('取消', 'Cancel'), value: undefined, tone: 'quiet' },
          ], { compactActions: true, lead: act === 'discard' ? undefined : copy.lead, requiredDetails: act === 'discard' ? detail.length : undefined,
            requireDetailViewport: commits || externalPreview, tone: act === 'discard' ? 'danger' : commits || act === 'rollback' ? 'warning' : undefined })
          if (!decision || !ctx.isIdle()) return
          const recoverConflict = async (conflict: PreviewConflict) => {
            const plan = conflict.plan
            const target = task.isolatedSession
            const source = sessionLink(ctx)
            const externalRecovery = !!task.external && !!source && await data.isEditingSession(task, source)
            const canRecover = (!!target && !task.review?.partial || externalRecovery) && !!task.review && !!plan.cleanEntries && plan.committedConflictingFiles.length > 0
            const committed = plan.committedConflictingFiles.length > 0
            const paths = plan.conflictingFiles.slice(0, 6).map(path => `• ${JSON.stringify(path)}`)
            if (plan.conflictingFiles.length > paths.length) paths.push(tf('… 共 {0} 个冲突文件', '… Conflict files: {0} total', plan.conflictingFiles.length))
            const recover = await pick(ctx, committed ? tr('预览冲突 · 项目目录未修改', 'Preview conflict · Project folder unchanged') : tr('与项目原目录的未提交改动冲突', 'Conflict with uncommitted changes in the project folder'), [
              !committed ? tr('预览未写入任何文件。请先对比项目原目录与 Worktree 的改动。', 'The preview did not write any files. Compare changes in the project folder and the Worktree first.') :
                canRecover ? tf('只在{0}合并项目目录的提交 {1}，生成新验收。', 'Merge project commit {1} only in {0}, then create a new review.', externalRecovery ? tr('独立冲突目录', 'the separate conflict directory') : ' Worktree', plan.localHeadOid.slice(0, 12)) : tr('与项目目录的已提交改动冲突；这组冲突不能安全地自动交给 Agent。', 'The conflict comes from committed project changes and cannot safely be handed to the Agent automatically.'),
              ...(committed && plan.dirtyConflict ? [tr('项目原目录的未提交改动不会带入 Worktree，仍需单独处理。', 'Uncommitted project changes are not brought into the Worktree and still need separate handling.')] : []),
              ...paths,
            ], [...(canRecover ? [{ label: tr('让 Agent 解决冲突', 'Let Agent resolve conflicts'), value: 'recover' as const, tone: 'primary' as const }] : []),
              { label: tr('关闭', 'Close'), value: 'close', tone: 'quiet' }], { tone: 'warning' })
            if (recover !== 'recover' || !task.review || !ctx.isIdle()) return
            const reviewId = task.review.id
            if (externalRecovery && source) {
              const recovery = await withLoading(ctx, tr('正在准备冲突处理…', 'Preparing conflict recovery…'), () => data.beginConflictRecovery(task.id, source, reviewId, plan))
              kickoff = () => scheduleConflictTurn(ctx, data, task, source, recovery)
              return
            }
            if (!target) return
            const begin = async (next: ExtensionContext, send: (text: string) => unknown) => {
              if (!isBoundSession(next, target) || !next.isIdle()) throw new Error(tr('未进入预期的空闲 Worktree 会话。', 'Could not enter the expected idle Worktree conversation.'))
              const recovery = await withLoading(next, tr('正在准备冲突处理…', 'Preparing conflict recovery…'), () => data.beginConflictRecovery(task.id, target, reviewId, plan))
              await send(conflictPrompt(recovery))
            }
            if (isolated) await begin(ctx, text => pi.sendUserMessage(text))
            else {
              const moved = await switchTo(ctx, target, tr('正在进入 Worktree…', 'Opening Worktree…'), async next => {
                switching = true
                try { await begin(next, text => next.sendUserMessage(text)) }
                catch (error) { next.ui.notify(message(error), 'error') }
                finally {
                  if (next.isIdle()) await next.sendUserMessage(`/${NAME} refresh`, { expandPromptTemplates: true }).catch(() => {})
                }
              })
              if (moved.cancelled) throw new Error(tr('Pi 取消了切换；未开始处理冲突。', 'Pi cancelled the switch. Conflict resolution was not started.'))
            }
          }
          const execute = async (activeCtx: ExtensionContext) => {
            const result = await withLoading(activeCtx, progress()[act], async () => {
              if (decision === 'keep') {
                if (!task.isolatedSession || task.isolatedSession.cwd !== task.isolatedPath) throw new Error(tr('找不到可保留的 Worktree 会话，未提交。', 'No Worktree conversation to retain was found. Nothing was committed.'))
                await validateSession(task.isolatedSession)
              }
              return data.act(task.id, act, {
                phase: task.phase, reviewId: task.review?.id, previewId: task.receipt?.previewId,
                discardFingerprint, keepWorktree: decision === 'keep', session: task.external ? sessionLink(activeCtx) : undefined,
              })
            }).catch(error => {
              if (act === 'commit_ready' && error instanceof PreviewConflict) {
                throw new Error(tf('{0}。可通过「预览改动」查看冲突处理选项。', '{0} Use “Preview changes” to see conflict resolution options.', error.message), { cause: error })
              }
              throw error
            })
            const oid = commits && result.commitOid ? ` · ${result.commitOid.slice(0, 12)}` : ''
            const followUp = act === 'preview' && isolated ? tr('可点「打开项目目录检查」。', ' Click “Inspect project folder” to check the changes.') : ''
            const cleanup = result.cleanup?.status === 'retained'
              ? tf(' Worktree 已保留：{0}{1}', ' Worktree retained: {0}{1}', result.isolatedPath, result.cleanup.reason ? `（${result.cleanup.reason}）` : '')
              : result.cleanup?.status === 'done' ? tr(' Worktree 已清理。', ' Worktree cleaned up.') : ''
            activeCtx.ui.notify(`${completed()[act]}${oid}${followUp}${cleanup}`,
              result.cleanup?.status === 'retained' && !result.cleanup.requested ? 'warning' : 'info')
            if (result.cleanup?.canForce && !partial && activeCtx.isIdle()) {
              try { await confirmRemoval(activeCtx, data, result, tr('未能安全清理 Worktree', 'Could not safely clean up the Worktree')) }
              catch (error) { activeCtx.ui.notify(tf('Worktree 清理已停止：{0}', 'Worktree cleanup stopped: {0}', message(error)), 'warning') }
            }
          }
          if (act === 'discard' && !task.external) {
            const text = ctx.ui.getEditorText()
            await withLoading(ctx, tr('正在检查原对话…', 'Checking original conversation…'), () => data.validateLocalIdentity(task))
            const moved = await switchTo(ctx, task.localSession, tr('正在返回原对话…', 'Returning to original conversation…'), async next => {
              switching = true
              if (!isBoundSession(next, task.localSession) || !next.isIdle()) {
                next.ui.notify(tr('未进入预期的原对话，任务未放弃。', 'Could not enter the expected original conversation. The task was not discarded.'), 'error')
                return
              }
              if (text) restoreDraft(next, text)
              try { await execute(next) }
              catch (error) { next.ui.notify(message(error), 'error') }
              finally { await next.sendUserMessage(`/${NAME} refresh`, { expandPromptTemplates: true }).catch(() => {}) }
            })
            if (moved.cancelled) throw new Error(tr('Pi 取消了切换，任务未放弃。', 'Pi cancelled the switch. The task was not discarded.'))
          } else if (leavesWorktree) {
            // Move off the old cwd before cleanup, but keep the task transcript on
            // screen. This view blocks tools and prompt delivery until handoff.
            const leaf = ctx.sessionManager.getLeafId()
            const { target, source, proof } = await withLoading(ctx, tr('正在保留任务对话…', 'Preserving task conversation…'), async () => {
              await data.validateLocal(task)
              await validateSession(task.localSession)
              return makeHistoryView(data, task, task.localSession, { leaf })
            })
            pendingDelivery.add(target.file)
            try {
              const moved = await switchTo(ctx, target, tr('正在切换提交环境…', 'Switching to commit context…'), async next => {
                switching = true
                try {
                  const nextCwd = await realpath(next.cwd)
                  const inProject = nextCwd === task.local.root || nextCwd.startsWith(task.local.root + '/')
                  if (!inProject || !isBoundSession(next, target) || !next.isIdle()) {
                    throw new Error(tr('未进入预期的任务对话，未提交。', 'Could not enter the expected task conversation. Nothing was committed.'))
                  }
                  if (!matchesHistory(await readHistory(source), proof)) throw new Error(tr('任务对话已变化，未提交。', 'The task conversation changed. Nothing was committed.'))
                  await execute(next)
                } catch (error) {
                  next.ui.notify(message(error), 'error')
                } finally {
                  pendingDelivery.delete(target.file)
                  try { await next.sendUserMessage(`/${NAME} refresh`, { expandPromptTemplates: true }) }
                  catch (error) { next.ui.notify(tf('无法刷新工作台：{0}', 'Could not refresh the Worktree menu: {0}', message(error)), 'warning') }
                }
              })
              if (moved.cancelled) {
                await rm(target.file, { force: true })
                throw new Error(tr('Pi 取消了切换，未提交。', 'Pi cancelled the switch. Nothing was committed.'))
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
        if (!switching) await refresh(ctx).catch(() => {})
        busy = false
        kickoff?.()
      }
    },
  })
  registerCommands()
}
