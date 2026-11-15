import { CURRENT_SESSION_VERSION, getAgentDir, SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type InputEvent } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { checkout, PreviewConflict, shortSessionName, TaskStore, type Action, type SessionLink, type Task } from './store.ts'
import { clean, pick, toolbar, withLoading, type Choice } from './ui.ts'

const NAME = 'worktree-preview'
const TOOL = 'worktree_ready_for_review'
const REVISE = 'worktree_begin_revision'
const HISTORY_VIEW = `${NAME}-history-view`
const HISTORY_DIR = 'history-views'
const HISTORY_HINT = '历史对话 · 发送后在新 Worktree 继续'
const guardedTools = new Set(['edit', 'write', 'bash', 'powershell', TOOL])
const labels: Record<Action, string> = {
  preview: '预览到 Local', rollback: '撤回预览', finalize: '确认提交',
  commit_ready: '跳过预览，直接提交', discard: '放弃任务',
}
const progress: Record<Action, string> = {
  preview: '正在预览到 Local…', rollback: '正在撤回预览…', finalize: '正在提交预览…',
  commit_ready: '正在直接提交…', discard: '正在放弃任务并检查清理…',
}
type MenuAction = Action | 'arm' | 'resume' | 'history' | 'retained' | 'return' | 'mark' | 'scope' | 'recover' | 'close'
const phases = { creating: '创建中断', working: '进行中', ready: '待验收', previewed: '已预览', delivered: '已交付', discarded: '已放弃' }
const message = (e: unknown) => clean(e instanceof Error ? e.message : String(e))
function sessionLink(ctx: ExtensionContext): SessionLink | undefined {
  const file = ctx.sessionManager.getSessionFile()
  if (file) return { file, id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd }
}
function isBoundSession(ctx: ExtensionContext, target?: SessionLink) {
  const link = sessionLink(ctx)
  return !!link && !!target && link.id === target.id && link.file === target.file && link.cwd === target.cwd
}
const isOpenTask = (task: Task) => !!task.journal || !['delivered', 'discarded'].includes(task.phase)
const sessionBusy = '此 Local 会话已有未完成的任务或恢复记录；可新开 Local 会话并行开发。'
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
const localCheck = { label: '打开 Local 检查', value: 'return' } as const
const retainedChoice = { label: '已保留的 Worktree', value: 'retained' } as const
const historyChoice = { label: '任务历史', value: 'history' } as const
const recoverChoice = { label: '让 Agent 继续解决冲突', value: 'recover', tone: 'primary' } as const
const resumeChoice = { label: '进入 / 恢复 Worktree', value: 'resume' } as const
const scopeChoice = { label: '调整交付清单', value: 'scope' } as const

async function chooseReviewFiles(ctx: ExtensionContext, files: readonly string[], narrow: boolean) {
  if (!files.length) throw new Error('没有可验收的 Git 改动。')
  const selected = new Set(narrow ? files : [])
  const choices: Choice<boolean>[] = files.map(path => ({
    get label() { return `[${selected.has(path) ? 'x' : ' '}] ${JSON.stringify(path)}` },
    value: false,
    toggle() { if (!selected.delete(path)) selected.add(path) },
  }))
  const apply = await pick(ctx, narrow ? '调整交付清单' : '选择交付文件', [
    narrow ? '取消勾选即可从已有验收中移除文件，不会重读未交付内容。' : '只勾选本次任务要交付的文件。',
    '清单外的文件不会写入 Local。',
  ], [...choices, { label: '保存交付清单', value: true, tone: 'primary' }, { label: '取消', value: false, tone: 'quiet' }])
  if (!apply) return
  if (!selected.size) throw new Error('请选择至少一个要交付的改动文件。')
  return files.filter(path => selected.has(path))
}

function phaseLabel(isolated: boolean, task?: Task) {
  const scope = isolated ? 'Worktree' : 'Local'
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
  ['delivered', 'discarded'].includes(task.phase) && !task.journal && task.cleanup?.status === 'retained')
const taskVersion = (task?: Task) => task && JSON.stringify([task.id, task.phase, task.review?.id, task.receipt?.previewId])
async function existing(file: string) {
  try { return (await lstat(file)).isFile() } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e }
}
async function isWorktreePath(root: string, path: string) {
  const within = (target: string) => {
    const name = relative(root, target)
    return !!name && name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name) && !name.toLowerCase().split(sep).includes('.git')
  }
  // Match Pi's leading @ and Unicode-space handling. Require a path rather
  // than Pi's optional home-relative or file-URL forms for mutators.
  const normalized = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ').replace(/^@/, '')
  if (normalized === '~' || normalized.startsWith('~/') || normalized.startsWith('file://')) return false
  let target = resolve(root, normalized)
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
async function withSavedLocal(ctx: ExtensionCommandContext, run: (next: ExtensionCommandContext, send: (text: string) => unknown) => Promise<void>) {
  const source = sessionLink(ctx)
  if (!source) throw new Error('无有效的持久化 Pi 会话。')
  if (await existing(source.file)) { await run(ctx, () => {}); return }
  const header = ctx.sessionManager.getHeader()
  if (!header || header.id !== source.id || header.cwd !== source.cwd || header.version !== CURRENT_SESSION_VERSION) {
    throw new Error('无法保存原 Local 会话。')
  }
  const body = [header, ...ctx.sessionManager.getEntries()].map(entry => JSON.stringify(entry)).join('\n') + '\n'
  const dir = dirname(source.file)
  const stage = await mkdtemp(join(dir, '.worktree-origin-'))
  try {
    const staged = join(stage, 'session.jsonl')
    const fd = await open(staged, 'wx', 0o600)
    try {
      await fd.writeFile(body)
      if (!ctx.sessionManager.getSessionName()) SessionManager.open(staged).appendSessionInfo('Local · Worktree 任务')
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
    const moved = await withLoading(ctx, '正在恢复原 Local 会话…', () => ctx.switchSession(source.file, { withSession: async next => {
      if (!isBoundSession(next, source) || !next.isIdle()) {
        next.ui.notify('未恢复空闲的原 Local 会话；没有新建 Worktree。', 'error')
        return
      }
      await run(next, text => next.sendUserMessage(text, { expandPromptTemplates: true }))
    } }))
    if (moved.cancelled) {
      await undoPublication()
      throw new Error('Pi 取消了保存原 Local 会话。')
    }
  } finally { await rm(stage, { recursive: true }) }
}

async function newSession(cwd: string, name: string): Promise<SessionLink> {
  // Native Pi creates files lazily. Reserve its allocated path and let SessionManager.open
  // initialize an empty persisted header, without submitting any prompt to a model.
  const file = SessionManager.create(cwd).getSessionFile()!
  const fd = await open(file, 'wx', 0o600)
  await fd.close()
  const sm = SessionManager.open(file, undefined, cwd)
  sm.appendSessionInfo(name)
  return { file, id: sm.getSessionId(), cwd: sm.getCwd() }
}
type HistoryView = { priorId: string; historyHash: string; returnTo: SessionLink }

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
    for (const line of body) {
      if (!line.trim()) continue
      const entry = parse(line)
      if (typeof entry?.type !== 'string' || entry.type === 'session' || typeof entry.id !== 'string' ||
          ids.has(entry.id) || (entry.parentId !== null && !ids.has(entry.parentId))) {
        throw new Error('原 Pi 会话的历史链接不完整，无法续接。')
      }
      ids.add(entry.id)
    }

    return { body, hash: createHash('sha256').update(body.join('\n')).digest('hex') }
  } finally { await fd.close() }
}

// Publish a native child only after the full history and marker are written.
async function copyHistory(cwd: string, source: SessionLink, body: string[], decorate: (sm: SessionManager) => void, sessionDir?: string): Promise<SessionLink> {
  const dir = SessionManager.create(cwd, sessionDir).getSessionDir()
  const staging = await mkdtemp(join(dir, '.worktree-follow-up-'))
  try {
    const child = SessionManager.create(cwd, staging, { parentSession: source.file })
    const path = child.getSessionFile()!
    const out = await open(path, 'wx', 0o600)
    try { await out.writeFile([JSON.stringify(child.getHeader()), ...body, ''].join('\n')) } finally { await out.close() }
    const fork = SessionManager.open(path)
    decorate(fork)
    const copy = await open(path, 'r+')
    try { await copy.sync() } finally { await copy.close() }
    const file = join(dir, basename(path))
    await link(path, file)
    const parent = await open(dir, 'r')
    try { await parent.sync() } finally { await parent.close() }
    return { file, id: fork.getSessionId(), cwd: fork.getCwd() }
  } finally { await rm(staging, { recursive: true }) }
}

async function forkWorktreeSession(cwd: string, task: Task, prior: Task, historyHash: string): Promise<SessionLink> {
  const source = prior.isolatedSession!
  const { body, hash } = await readHistory(source)
  if (hash !== historyHash) throw new Error('原 Pi 会话在打开后已变化；请返回 Local 重新打开历史。')
  return copyHistory(cwd, source, body, fork => {
    fork.appendSessionInfo(shortSessionName(task.id))
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
type Draft = Pick<InputEvent, 'text' | 'images'> & Armed & { token: string }
type ClickIntent = { token: string; sessionId: string; taskVersion: ReturnType<typeof taskVersion>; choice: MenuAction }

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
  ctx.ui.notify('Worktree 已删除；Local 与 Pi 会话历史未改动。', 'info')
}

export default function extension(pi: ExtensionAPI) {
  let store: TaskStore | undefined
  let busy = false
  let armed: Armed | undefined
  let historyView: HistoryView | null | undefined
  let draft: Draft | undefined
  let clickIntent: ClickIntent | undefined
  let activeHold: { data: TaskStore; id: string } | undefined
  let pendingHold: { data: TaskStore; id: string } | undefined
  let incomingHoldFailed = false
  let revisionStopped = false

  async function context(ctx: ExtensionContext) {
    const data = store ??= new TaskStore(join(await realpath(getAgentDir()), NAME))
    const cwd = await realpath(ctx.cwd)
    const tasks = (await data.read()).tasks
    const isolated = tasks.find(task => task.isolatedPath === cwd || cwd.startsWith(task.isolatedPath + '/'))
    if (isolated) return { data, cwd, isolated, tasks: [] }
    let local: Awaited<ReturnType<typeof checkout>> | undefined
    try { local = await checkout(cwd) } catch { /* No Git checkout: no workflow entry. */ }
    const own = local ? tasks.filter(task => task.local.root === local.root).reverse() : []
    return { data, cwd, local, isolated, tasks: own }
  }

  const openMenu = () => pi.sendUserMessage(`/${NAME}`, { expandPromptTemplates: true })
  function installToolbar<T>(ctx: ExtensionContext, view: () => {
    status: Parameters<typeof toolbar<T>>[2]; buttons: Choice<T>[]
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
    if (!ctx.hasUI) return
    if (historyView !== undefined) {
      installToolbar(ctx, () => ({
        status: { label: historyView ? HISTORY_HINT : '历史会话记录无效 · 请退出此会话', tone: 'warning' },
        buttons: historyView ? [{ label: '[ 返回 Local ]', value: 'back' }] : [],
      }), () => pi.sendUserMessage(`/${NAME} back`, { expandPromptTemplates: true }))
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
      status: { label: phaseLabel(!!state.isolated, active), tone: phaseTone(active) },
      buttons: [
        ...(showCreate ? [{ label: `[${selected() ? 'x' : ' '}] 新建 Worktree`, value: 'arm' as const, tone: 'primary' as const }] : []),
        ...direct.map(({ label, ...choice }) => ({ ...choice, label: `[ ${label} ]` })),
        ...(historyTasks(state.tasks).length ? [{ label: '[ 任务历史 ]', value: 'history' as const }] : []),
        ...(showMenu ? [{ label: '[ 工作树操作 ]', value: 'menu' as const }] : []),
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
    try {
      if (pendingHold && pendingHold.id !== activeHold?.id) await pendingHold.data.releaseWorktree(pendingHold.id)
      pendingHold = undefined
      const file = event.targetSessionFile
      if (!file || !await existing(file)) return
      const data = store ??= new TaskStore(join(await realpath(getAgentDir()), NAME))
      const targetCwd = SessionManager.open(file).getHeader()?.cwd
      if (!targetCwd) return
      const path = await realpath(targetCwd)
      const target = (await data.read()).tasks.find(task => path === task.isolatedPath || path.startsWith(task.isolatedPath + '/'))
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
            typeof view.priorId === 'string' && typeof view.historyHash === 'string' && /^[a-f0-9]{64}$/.test(view.historyHash)) {
          historyView = view as HistoryView
        }
        await refresh(ctx)
        return
      }
      const path = await realpath(ctx.cwd).catch(() => ctx.cwd)
      const isolated = (await data.read()).tasks.find(task => path === task.isolatedPath || path.startsWith(task.isolatedPath + '/'))
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
      if (ctx.hasUI && event.source === 'interactive') restoreDraft(ctx, event.text)
      if (ctx.hasUI) ctx.ui.notify('无法确认 Worktree 会话占用，请退出后重试。', 'error')
      return { action: 'handled' }
    }
    const history = historyView !== undefined
    if (history && (!historyView || event.source !== 'interactive' || !ctx.hasUI)) return { action: 'handled' }
    if (event.source !== 'interactive' || !ctx.hasUI || !event.text.trim()) return
    const sessionId = ctx.sessionManager.getSessionId()
    // Pi handles UI/extension commands outside this hook. Keep task prompts,
    // including skills, templates, and pasted paths, as raw input until switch.
    if (!history && armed?.sessionId !== sessionId) return
    if (busy || draft || !ctx.isIdle() || event.streamingBehavior) {
      restoreDraft(ctx, event.text)
      ctx.ui.notify('请等待当前操作结束再发送；消息未发送到 Local。', 'warning')
      return { action: 'handled' }
    }
    const token = randomUUID()
    draft = { sessionId, text: event.text, images: event.images, token }
    // Only commands can replace a session. Wait for input preflight to unwind and
    // pass just a nonce to the command, never the message text or attachments.
    setImmediate(() => { if (draft?.token === token) pi.sendUserMessage(`/${NAME} ${token}`, { expandPromptTemplates: true }) })
    return { action: 'handled' }
  })
  pi.on('session_before_fork', () => historyView !== undefined ? { cancel: true } : undefined)
  pi.on('session_before_compact', () => historyView !== undefined ? { cancel: true } : undefined)
  pi.on('user_bash', (_event, ctx) => {
    if (historyView === undefined) return
    if (ctx.hasUI) ctx.ui.notify('此处只查看历史；请先返回 Local 再执行 shell。', 'warning')
    return { result: { output: '历史对话未执行 shell。', exitCode: 1, cancelled: false, truncated: false } }
  })
  pi.on('before_agent_start', async (event, ctx) => {
    if (historyView !== undefined) { ctx.abort(); return }
    revisionStopped = false
    const state = await context(ctx).catch(() => undefined)
    const task = state?.isolated
    if (!task) return
    const canWork = isBoundSession(ctx, task.isolatedSession) && !task.journal && ['working', 'ready', 'previewed'].includes(task.phase)
    const guidance = canWork
      ? `Status at the start of this request: ${task.phase}. For questions, explanations, and discussion, use read-only tools; do not invalidate a review or ask to roll back. If the user actually requests changes after a review was marked ready (including when a Local preview is active), call ${REVISE} alone before editing or running shell commands. The tool handles any required user confirmation. Wait for its success, then implement the existing request yourself in this Worktree, in the same turn, without asking the user to repeat it. If cancelled or unsuccessful, do not edit or retry unless asked again. After verifying, call ${TOOL} with a short commit title and only the exact repo-relative paths for the entire task, including earlier rounds and both sides of renames. Never blindly submit git status or include unrelated runtime/generated files. Then stop editing.`
      : 'This session or task is not editable. Use it for inspection only; do not modify files or mark it ready.'
    return { systemPrompt: `${event.systemPrompt}\n\nThis is a managed isolated Git worktree. Work only in the active Worktree cwd. ${guidance} Do not write to Local yourself; the user alone controls preview, rollback, delivery and discard.` }
  })
  // Shell cannot be reliably classified as read-only. Keep built-in mutators
  // behind the revision step, including sibling calls while confirmation is open.
  pi.on('tool_call', async (event, ctx) => {
    if (historyView !== undefined) return { block: true, reason: '历史对话只用于查看；请在新 Worktree 继续。' }
    if ((!guardedTools.has(event.toolName) && event.toolName !== REVISE) || (!activeHold && !incomingHoldFailed)) return
    const assistant = ctx.sessionManager.getBranch().reverse().find(entry => entry.type === 'message' && entry.message.role === 'assistant')
    const calls = assistant?.type === 'message' && assistant.message.role === 'assistant'
      ? assistant.message.content.filter(part => part.type === 'toolCall') : []
    if ((calls.length > 1 && calls.some(call => call.name === TOOL || call.name === REVISE)) ||
        (event.parentToolCallId && (event.toolName === TOOL || event.toolName === REVISE))) {
      return { block: true, reason: `${REVISE} 和 ${TOOL} 都必须单独调用，不可与其他工具批量执行。` }
    }
    if (event.toolName === REVISE) return
    const state = await context(ctx)
    const task = state.isolated
    if (task?.phase === 'working' && !task.journal && !revisionStopped && !incomingHoldFailed && isBoundSession(ctx, task.isolatedSession)) {
      if ((event.toolName === 'edit' || event.toolName === 'write') &&
          (typeof event.input.path !== 'string' || !await isWorktreePath(task.isolatedPath, event.input.path))) {
        return { block: true, reason: '只允许编辑当前 Worktree 内的文件。' }
      }
      return
    }
    const reason = !revisionStopped && task && !task.journal && isBoundSession(ctx, task.isolatedSession) && ['ready', 'previewed'].includes(task.phase)
      ? `当前处于验收阶段。如果用户要求改动，先单独调用 ${REVISE}；如果只是讨论，请用只读工具。`
      : '当前会话不允许编辑或执行 shell；请勿绕过。'
    return { block: true, reason }
  })
  pi.registerTool({
    name: REVISE, label: '开始返修', executionMode: 'sequential',
    description: 'Only when the user requests edits to a reviewed Worktree, call this alone before changing files or using shell. If there is a Local preview, wait for a user click to roll it back. On success continue the existing request in the same turn; on failure do not edit or ask again. Not for discussion.',
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      const result = (ok: boolean, text: string) => ({ content: [{ type: 'text' as const, text }], details: { ok }, isError: !ok })
      if (busy || revisionStopped) return result(false, '不能开始返修。请勿编辑，也不要在本轮重试。')
      busy = true
      try {
        signal?.throwIfAborted()
        const { isolated: task, data } = await context(ctx)
        const link = sessionLink(ctx)
        if (incomingHoldFailed || !task || !link || !isBoundSession(ctx, task.isolatedSession) || task.journal ||
            !task.review || (task.phase !== 'ready' && (task.phase !== 'previewed' || !task.receipt))) {
          throw new Error('当前不在可返修的 Worktree 验收状态。')
        }
        if (task.phase === 'ready') {
          const reviewId = task.review.id
          await withLoading(ctx, '正在准备返修…', () => data.continueEditing(task.id, link, reviewId, signal))
        } else {
          if (ctx.mode !== 'tui' || !ctx.hasUI) throw new Error('需要在 Pi TUI 由用户确认撤回。')
          const confirmed = await pick(ctx, '返修前需撤回 Local 预览', [
            '恢复 Local 的预览改动后，Agent 会接着处理刚才的要求。',
            '如 Local 的预览文件已被修改，将停止并保留现场。',
            `Local：${task.local.root}`,
          ], [{ label: '撤回预览，继续返修', value: true, tone: 'primary' }, { label: '取消', value: false, tone: 'quiet' }], { signal, tone: 'warning' })
          signal?.throwIfAborted()
          if (!confirmed) throw new Error('用户取消了撤回，预览保留。')
          const reviewId = task.review.id
          await withLoading(ctx, progress.rollback, () => data.act(task.id, 'rollback', {
            phase: task.phase, reviewId, previewId: task.receipt?.previewId, revision: { session: link, signal },
          }))
        }
        return result(true, '已进入返修。请现在继续处理用户刚才的修改要求，只改本 Worktree，验证后重新标记待验收。')
      } catch (error) {
        revisionStopped = true
        return result(false, `${message(error)} 不要编辑，也不要在本轮重试。`)
      } finally {
        busy = false
        await refresh(ctx).catch(() => {})
      }
    },
  })
  pi.registerTool({
    name: TOOL, label: '标记待验收', executionMode: 'sequential', description: 'Mark the current managed Worktree ready for user review. Does not write to Local or commit. Call after edits and tests.',
    parameters: Type.Object({
      commitMessage: Type.String({ description: 'A one-line commit title (1–200 characters).' }),
      files: Type.Array(Type.String(), { minItems: 1, description: 'Exact repo-relative paths intentionally changed for this task, including deletions and both sides of a rename. Exclude unrelated runtime state and test artifacts.' }),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (signal?.aborted) throw new Error('已取消。')
      const state = await context(ctx)
      const link = sessionLink(ctx)
      if (!state.isolated || !link) throw new Error('只能在受管 Worktree 的原始 Pi 会话中标记待验收。')
      const id = state.isolated.id
      const review = await withLoading(ctx, '正在标记待验收…', () => state.data.markReady(id, link, params.commitMessage, params.files))
      await refresh(ctx)
      return { content: [{ type: 'text', text: `已标记待验收（${review.files.length} 个文件）；未修改 Local。用户可直接点击「预览到 Local」。` }], details: { reviewId: review.id } }
    },
  })

  async function sendInNewWorktree(ctx: ExtensionCommandContext, { text, images, sessionId }: Draft) {
    let replaced = false
    const view = historyView
    const create = async (current: ExtensionCommandContext, send: (text: string) => unknown) => {
      let entered = false
      try {
        const { local, isolated, tasks, data } = await context(current)
        if (!local || isolated) throw new Error('只能从 Local Git checkout 新建 Worktree。')
        if (process.platform === 'win32') throw new Error('当前版本仅支持 macOS/Linux。')
        const active = sessionLink(current)
        if (!active || view === null) throw new Error('无有效的持久化 Pi 会话，不能新建 Worktree。')
        const source = view?.returnTo ?? active
        if (tasks.some(task => task.localSession.id === source.id && task.localSession.file === source.file &&
            task.localSession.cwd === source.cwd && isOpenTask(task))) throw new Error(sessionBusy)
        const created = await withLoading(current, '正在创建 Worktree…', async () => {
          await validateSession(source)
          return data.create(local, source, (path, task, prior) => prior && view
            ? forkWorktreeSession(path, task, prior, view.historyHash)
            : newSession(path, shortSessionName(task.id)), view?.priorId)
        })
        const target = created.isolatedSession!
        const result = await switchTo(current, target, '正在进入 Worktree…', async next => {
          entered = replaced = true
          try {
            if (!isBoundSession(next, target)) throw new Error('Pi 未进入预期的隔离 Worktree。')
            if (view) await rm(active.file, { force: true }).catch(() => {})
            await next.sendUserMessage(images?.length ? [{ type: 'text', text }, ...images] : text, { expandPromptTemplates: true })
          } catch (error) {
            restoreDraft(next, text)
            next.ui.notify(`无法在 Worktree 发送消息：${message(error)}${images?.length ? '；请重新附加图片。' : ''}`, 'error')
          }
        })
        if (result.cancelled) throw new Error(`Pi 取消了切换；${view ? '返回 Local 后，' : ''}可从工作台恢复已创建的 Worktree。`)
      } catch (error) {
        if (!entered && current !== ctx) {
          restoreDraft(current, text)
          current.ui.notify(`消息未发送到 Local：${message(error)}${images?.length ? '；请重新附加图片。' : ''}`, 'error')
          await send(`/${NAME} refresh`)
        } else throw error
      }
    }
    busy = true
    try {
      if (!ctx.isIdle() || sessionId !== ctx.sessionManager.getSessionId()) throw new Error('Local 会话已变化或忙碌。')
      if (view) await create(ctx, () => {})
      else await withSavedLocal(ctx, async (current, send) => {
        if (current !== ctx) replaced = true
        await create(current, send)
      })
    } catch (error) {
      if (!replaced) {
        restoreDraft(ctx, text)
        ctx.ui.notify(`消息未发送到 Local：${message(error)}${images?.length ? '；请重新附加图片。' : ''}`, 'error')
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

  pi.registerCommand(NAME, {
    description: '打开 Worktree 预览工作台（fullscreen 中也可点击）',
    async handler(args, ctx) {
      if (!ctx.hasUI || busy) return
      if (args === 'refresh') {
        try { await refresh(ctx) } catch (error) { ctx.ui.notify(message(error), 'error') }
        return
      }
      if (args && draft?.token === args) { await sendInNewWorktree(ctx, draft); return }
      if (historyView !== undefined) {
        if (!historyView || draft || !ctx.isIdle() || (args && args !== 'back')) return
        const { returnTo } = historyView
        const viewFile = ctx.sessionManager.getSessionFile()
        busy = true
        let replaced = false
        try {
          const moved = await switchTo(ctx, returnTo, '正在返回 Local…', async next => {
            replaced = true
            if (viewFile && isBoundSession(next, returnTo)) await rm(viewFile, { force: true }).catch(() => {})
          })
          if (moved.cancelled) throw new Error('Pi 取消了返回 Local。')
        } catch (error) { if (!replaced) ctx.ui.notify(message(error), 'error') }
        finally { busy = false }
        return
      }
      const intent = args && clickIntent?.token === args ? clickIntent : undefined
      if (args && !intent) return
      if (intent) clickIntent = undefined
      if (draft || !ctx.isIdle()) return
      busy = true
      let switching = false
      try {
        const { local, isolated, tasks, data, cwd } = await context(ctx)
        const task = currentTask(ctx, isolated, tasks)
        if (!local && !isolated) throw new Error('请从有初始提交的 Git checkout 打开 Pi。')
        const choices: Choice<MenuAction>[] = [...deliveryChoices(task)]
        if (task?.phase === 'ready' && task.review && !task.journal && !task.recovery) {
          choices.push({ label: labels.commit_ready, value: 'commit_ready' })
        }
        if (task?.phase === 'ready' && !task.journal && !task.recovery && (task.review?.files.length ?? 0) > 1 && task.isolatedSession) choices.push(scopeChoice)
        if (task?.phase === 'working' && task.recovery && !task.journal) choices.push(recoverChoice)
        const details = [phaseLabel(!!isolated, task)]
        if (task?.review) details.push(`验收：${task.review.message} · ${task.review.files.length} 个文件`)
        if (task) {
          if (task.journal || task.phase === 'creating') details.push(`已停止自动操作 · ${data.statePath}`, task.isolatedPath)
          if (task.cleanup?.status === 'retained') details.push(`保留 Worktree：${task.cleanup.reason}`, task.isolatedPath)
        }
        details.push(`目录：${cwd}`)
        if (isolated && task) {
          choices.push(task.phase === 'previewed' && !task.journal ? localCheck : { label: '返回 Local', value: 'return' })
          if (!task.journal && ['working', 'ready'].includes(task.phase)) choices.push({ label: '标记待验收（手动）', value: 'mark' })
        } else if (local) {
          if (!task || !isOpenTask(task)) {
            choices.push({ label: armed?.sessionId === ctx.sessionManager.getSessionId() ? '取消下次发送时创建' : '下次发送时新建 Worktree', value: 'arm' })
          }
          if (historyTasks(tasks).length) choices.push(historyChoice)
          if (task && isOpenTask(task) && !task.journal && task.phase !== 'creating') {
            if (task.isolatedSession) choices.push({ ...resumeChoice, tone: choices.length ? undefined : 'primary' })
            if (task.phase === 'working' || task.phase === 'ready') choices.push({ label: labels.discard, value: 'discard', tone: 'danger' })
          }
        }
        const retained = retainedTasks(tasks)
        if (retained.length) choices.push(retainedChoice)
        choices.push({ label: '关闭', value: 'close', tone: 'quiet' })
        if (intent && (intent.sessionId !== ctx.sessionManager.getSessionId() || intent.taskVersion !== taskVersion(task) ||
            !choices.some(option => option.value === intent.choice))) throw new Error('任务状态已变化，请重新选择。')
        const tone = phaseTone(task)
        const choice = intent?.choice ?? await pick(ctx, 'Worktree 预览工作台', details, choices, {
          tone: tone === 'danger' || tone === 'warning' ? tone : undefined,
        })
        if (!choice || choice === 'close' || !ctx.isIdle()) return
        if (choice === 'arm' && local) {
          if (!sessionLink(ctx)) throw new Error('无持久化 Pi 会话，不能新建 Worktree。')
          const id = ctx.sessionManager.getSessionId()
          armed = armed?.sessionId === id ? undefined : { sessionId: id }
        } else if (choice === 'history' && local) {
          const prior = await pick<Task | undefined>(ctx, '打开历史对话', [
            '选择后立即打开原对话；首次发送时从 Local 最新 HEAD 创建新 Worktree。',
            '只继承对话，不复制原 Worktree 的未提交文件。',
          ], [
            ...historyTasks(tasks).map(item => ({ label: `${item.id.slice(0, 8)} · ${phases[item.phase]} · ${item.review?.message ?? 'Worktree'}`, value: item })),
            { label: '取消', value: undefined },
          ])
          if (!prior || !ctx.isIdle()) return
          const source = prior.isolatedSession!
          const { body, hash } = await withLoading(ctx, '正在读取历史对话…', async () => {
            await data.validateLocalIdentity(prior)
            return readHistory(source)
          })
          await withSavedLocal(ctx, async current => {
            if (current !== ctx) switching = true
            try {
              const returnTo = sessionLink(current)!
              const view = await withLoading(current, '正在准备历史对话…', async () => {
                const dir = join(data.directory, HISTORY_DIR)
                await mkdir(dir, { recursive: true, mode: 0o700 })
                return copyHistory(current.cwd, source, body, sm => {
                  sm.appendSessionInfo(`历史对话 · ${prior.review?.message ?? shortSessionName(prior.id)}`)
                  sm.appendCustomEntry(HISTORY_VIEW, { priorId: prior.id, historyHash: hash, returnTo } satisfies HistoryView)
                }, dir)
              })
              const moved = await switchTo(current, view, '正在打开历史对话…', async () => { switching = true })
              if (moved.cancelled) {
                await rm(view.file, { force: true })
                throw new Error('Pi 取消了打开历史对话。')
              }
            } catch (error) {
              if (current === ctx) throw error
              current.ui.notify(message(error), 'error')
            }
          })
        } else if (choice === 'return' && isolated) {
          await withLoading(ctx, '正在检查 Local 会话…', () => data.validateLocalIdentity(isolated))
          const moved = await switchTo(ctx, isolated.localSession, '正在返回 Local…', async () => { switching = true })
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
              ...(target.isolatedSession ? [{ label: '恢复会话检查', value: 'resume' }] : []),
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
        } else if (choice === 'mark' && isolated) {
          const link = sessionLink(ctx)
          if (!link) throw new Error('没有可保存的 Pi 会话。')
          const candidates = await withLoading(ctx, '正在扫描 Worktree 改动…', () => data.reviewCandidates(isolated))
          const files = await chooseReviewFiles(ctx, candidates, false)
          if (!files || !ctx.isIdle()) return
          await withLoading(ctx, '正在标记待验收…', () =>
            data.markReady(isolated.id, link, isolated.review?.message ?? 'Worktree task changes', files))
          ctx.ui.notify('已标记待验收；未修改 Local。', 'info')
        } else if (choice === 'scope' && task?.review && task.isolatedSession) {
          const files = await chooseReviewFiles(ctx, task.review.files, true)
          if (!files || files.length === task.review.files.length || !ctx.isIdle()) return
          const link = sessionLink(ctx)
          if (!link) throw new Error('找不到绑定的 Pi 会话。')
          const reviewId = task.review.id
          await withLoading(ctx, '正在更新交付清单…', () => data.restrictReview(task.id, link, reviewId, files))
          ctx.ui.notify('已更新交付清单；未修改 Local。', 'info')
        } else if (task && choice in labels) {
          const act = choice as Action
          const discardFingerprint = act === 'discard'
            ? await withLoading(ctx, '正在检查可放弃的 Worktree…', () => data.discardFingerprint(task)) : undefined
          const impact: Record<Action, string> = {
            preview: '只将任务改动写入原 checkout，不暂存、不提交。',
            rollback: '恢复预览前的文件状态；Local 发生漂移时停止。',
            finalize: '只提交本次预览的任务改动，保留原有 Git 改动。',
            commit_ready: '不打开预览。直接把验收清单中的任务改动写入 Local 并提交；检查不通过则停止。',
            discard: '放弃隔离工作；若能安全核验，将删除隔离 Worktree。',
          }
          const relevantFiles = task.receipt?.changedFiles ?? task.review?.files ?? []
          const summary = relevantFiles.slice(0, 3).map(s => `• ${s}`)
          if (relevantFiles.length > 3) summary.push(`… 共 ${relevantFiles.length} 个文件`)
          const commits = act === 'finalize' || act === 'commit_ready'
          const leavesWorktree = commits && !!isolated
          const detail = [impact[act], task.local.root, ...summary]
          const partial = commits && !!task.review?.partial
          if (commits) detail.push(partial ? '清单外还有改动，提交后将保留 Worktree。' : '默认安全清理；也可保留 Worktree 环境供日后检查。')
          if (leavesWorktree) detail.unshift('将先切换到原 Local 会话，再提交。')
          const decision = await pick<'execute' | 'keep' | undefined>(ctx, `确认：${labels[act]}`, detail, [
            { label: partial ? '提交并保留 Worktree' : commits ? '提交并清理 Worktree（默认）' : `执行${labels[act]}`, value: 'execute', tone: act === 'discard' ? 'danger' : 'primary' },
            ...(commits && !partial ? [{ label: '提交并保留 Worktree', value: 'keep' as const }] : []),
            { label: '取消', value: undefined, tone: 'quiet' },
          ], { tone: act === 'discard' ? 'danger' : commits || act === 'rollback' ? 'warning' : undefined })
          if (!decision || !ctx.isIdle()) return
          const recoverConflict = async (conflict: PreviewConflict) => {
            const plan = conflict.plan
            const target = task.isolatedSession
            const canRecover = !!target && !!task.review && !task.review.partial && !!plan.cleanEntries && plan.committedConflictingFiles.length > 0
            const canNarrow = !!target && !!task.review && task.review.files.length > 1 && !task.recovery
            const paths = plan.conflictingFiles.slice(0, 6).map(path => `• ${JSON.stringify(path)}`)
            if (plan.conflictingFiles.length > paths.length) paths.push(`… 共 ${plan.conflictingFiles.length} 个冲突文件`)
            const recover = await pick(ctx, '预览冲突 · Local 未修改', [
              !plan.committedConflictingFiles.length ? '如果冲突文件不是任务改动，可调整交付清单；否则请先处理 Local 未提交改动。' :
                canRecover ? `只在 Worktree 合并 Local ${plan.localHeadOid.slice(0, 12)}，生成新验收。` : '这组冲突不能安全地自动交给 Agent。',
              ...(canRecover && plan.dirtyConflict ? ['冲突路径也有 Local 未提交的改动，不会带入 Worktree。'] : []),
              ...paths,
            ], [...(canRecover ? [{ label: '让 Agent 解决冲突', value: 'recover' as const, tone: 'primary' as const }] : []),
              ...(canNarrow ? [scopeChoice] : []), { label: '关闭', value: 'close', tone: 'quiet' }], { tone: 'warning' })
            if (!recover || recover === 'close' || !target || !task.review || !ctx.isIdle()) return
            const reviewId = task.review.id
            if (recover === 'scope') {
              const files = await chooseReviewFiles(ctx, task.review.files, true)
              if (!files || files.length === task.review.files.length || !ctx.isIdle()) return
              const link = sessionLink(ctx)
              if (!link) throw new Error('找不到绑定的 Pi 会话。')
              await withLoading(ctx, '正在更新交付清单…', () => data.restrictReview(task.id, link, reviewId, files))
              ctx.ui.notify('已更新交付清单；请重新点击预览。', 'info')
              return
            }
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
                discardFingerprint, keepWorktree: decision === 'keep',
              })
            }).catch(error => {
              if (act === 'commit_ready' && error instanceof PreviewConflict) {
                throw new Error(`${error.message}。可使用「预览到 Local」查看冲突处理选项。`, { cause: error })
              }
              throw error
            })
            const note = result.cleanup?.status === 'retained' ? `；保留 Worktree：${result.isolatedPath}（${result.cleanup.reason}）` : ''
            const preview = act === 'preview' && isolated ? '；仍在 Worktree，可点击「打开 Local 检查」' : ''
            activeCtx.ui.notify(`${labels[act]}完成${result.commitOid ? ` · ${result.commitOid.slice(0, 12)}` : ''}${preview}${note}`,
              note && !result.cleanup?.requested ? 'warning' : 'info')
            if (result.cleanup?.canForce && !partial && activeCtx.isIdle()) {
              try { await confirmRemoval(activeCtx, data, result, '未能安全清理 Worktree') }
              catch (error) { activeCtx.ui.notify(`Worktree 清理已停止：${message(error)}`, 'warning') }
            }
          }
          if (leavesWorktree) {
            // Leave the active cwd before delivery can delete it. A veto or failed
            // switch never authorizes a commit from the old session.
            await withLoading(ctx, '正在检查 Local checkout…', () => data.validateLocal(task))
            const moved = await switchTo(ctx, task.localSession, '正在切换到 Local 提交…', async next => {
              switching = true
              try {
                const nextCwd = await realpath(next.cwd)
                const localCwd = nextCwd === task.local.root || nextCwd.startsWith(task.local.root + '/')
                if (!localCwd || !isBoundSession(next, task.localSession) || !next.isIdle()) {
                  throw new Error('未进入预期的空闲 Local 会话，未提交。')
                }
                await execute(next)
              } catch (error) {
                next.ui.notify(message(error), 'error')
              } finally {
                // Refresh via the replacement extension, never install old widget callbacks.
                try { await next.sendUserMessage(`/${NAME} refresh`, { expandPromptTemplates: true }) }
                catch (error) { next.ui.notify(`无法刷新工作台：${message(error)}`, 'warning') }
              }
            })
            if (moved.cancelled) throw new Error('Pi 取消了切换，未提交。')
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
