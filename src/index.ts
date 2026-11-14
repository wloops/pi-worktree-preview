import { getAgentDir, SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type InputEvent } from '@earendil-works/pi-coding-agent'
import { rgbColor, truncateToWidth, visibleWidth, type TuiMouseEvent } from '@earendil-works/pi-tui'
import { Type } from 'typebox'
import { randomUUID } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { checkout, shortSessionName, TaskStore, type Action, type SessionLink, type Task } from './store.ts'

const NAME = 'worktree-preview'
const TOOL = 'worktree_ready_for_review'
const labels: Record<Action, string> = { preview: '预览到 Local', rollback: '撤回预览', finalize: '确认提交', discard: '放弃任务' }
type MenuAction = Action | 'arm' | 'resume' | 'retained' | 'return' | 'mark' | 'close'
const phases = { creating: '创建中断', working: '进行中', ready: '待验收', previewed: '已预览', delivered: '已交付', discarded: '已放弃' }
const clean = (s: string) => s.replace(/[\p{Cc}\p{Cf}]/gu, '?')
const message = (e: unknown) => clean(e instanceof Error ? e.message : String(e))
function sessionLink(ctx: ExtensionContext): SessionLink | undefined {
  const file = ctx.sessionManager.getSessionFile()
  if (file) return { file, id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd }
}
function isBoundSession(ctx: ExtensionContext, target?: SessionLink) {
  const link = sessionLink(ctx)
  return !!link && !!target && link.id === target.id && link.file === target.file && link.cwd === target.cwd
}
function currentTask(isolated: Task | undefined, tasks: Task[]) {
  return isolated ?? tasks.find(t => t.journal || !['delivered', 'discarded'].includes(t.phase)) ?? tasks[0]
}
function deliveryChoices(task: Task | undefined, allowed: boolean): Choice<Action>[] {
  if (!allowed || !task || task.journal) return []
  if (task.phase === 'ready') return [{ label: labels.preview, value: 'preview' }]
  if (task.phase === 'previewed') return [{ label: labels.rollback, value: 'rollback' }, { label: labels.finalize, value: 'finalize' }]
  return []
}
const localCheck = { label: '打开 Local 检查', value: 'return' } as const
const retainedChoice = { label: '已保留的 Worktree', value: 'retained' } as const
const retainedTasks = (tasks: Task[]) => tasks.filter(task =>
  task.phase === 'delivered' && !task.journal && task.cleanup?.requested && task.isolatedSession)
const taskVersion = (task?: Task) => task && JSON.stringify([task.id, task.phase, task.review?.id, task.receipt?.previewId])
async function existing(file: string) {
  try { return (await lstat(file)).isFile() } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e }
}
async function newSession(cwd: string, name: string, sessionDir?: string): Promise<SessionLink> {
  // Native Pi creates files lazily. Reserve its allocated path and let SessionManager.open
  // initialize an empty persisted header, without submitting any prompt to a model.
  const file = SessionManager.create(cwd, sessionDir).getSessionFile()!
  const fd = await open(file, 'wx', 0o600)
  await fd.close()
  const sm = SessionManager.open(file, sessionDir, cwd)
  sm.appendSessionInfo(name)
  return { file, id: sm.getSessionId(), cwd: sm.getCwd() }
}
type SwitchOptions = NonNullable<Parameters<ExtensionCommandContext['switchSession']>[1]>

async function validateSession(link: SessionLink) {
  if (!isAbsolute(link.file) || !await existing(link.file)) throw new Error(`Pi 会话文件不存在：${link.file}`)
  if (!(await lstat(link.cwd)).isDirectory()) throw new Error(`会话工作目录不存在：${link.cwd}`)
  const sm = SessionManager.open(link.file)
  if (sm.getSessionId() !== link.id || sm.getHeader()?.cwd !== link.cwd) throw new Error('会话身份或工作目录已变化。')
}

async function switchTo(ctx: ExtensionCommandContext, link: SessionLink, withSession?: SwitchOptions['withSession']) {
  await validateSession(link)
  return ctx.switchSession(link.file, { withSession })
}

function restoreDraft(ctx: ExtensionContext, text: string) {
  const current = ctx.ui.getEditorText()
  ctx.ui.setEditorText(!current || current === text ? text : `${text}\n\n${current}`)
}

type Draft = Pick<InputEvent, 'text' | 'images'> & { token: string; sessionId: string }
type ClickIntent = { token: string; sessionId: string; taskVersion: ReturnType<typeof taskVersion>; choice: MenuAction }

const lightPanel = {
  surface: rgbColor(245, 248, 253), header: rgbColor(222, 232, 250), edge: rgbColor(65, 92, 142),
  text: rgbColor(24, 39, 66), secondary: rgbColor(64, 81, 113), selectedBg: rgbColor(39, 76, 151),
}
const darkPanel = {
  surface: rgbColor(24, 32, 48), header: rgbColor(37, 54, 81), edge: rgbColor(130, 162, 216),
  text: rgbColor(235, 241, 252), secondary: rgbColor(177, 194, 219), selectedBg: rgbColor(48, 91, 166),
}
const selectedFg = rgbColor(255, 255, 255)

interface Choice<T> { label: string; value: T }
async function pick<T>(ctx: ExtensionCommandContext, title: string, detail: string[], choices: Choice<T>[]): Promise<T | undefined> {
  return ctx.ui.custom<T | undefined>((tui, theme, keys, done) => {
    // Paint the whole card, including padding, so transcript tool backgrounds never
    // show through. Use paired colors that remain readable in both Pi appearances.
    const palette = () => theme.appearance === 'light' ? lightPanel : darkPanel
    let selected = choices.length - 1 // cancellation is the default for keyboard confirmation
    let first = 0
    let rows = 0
    let start = 0
    let hitWidth = 0
    let hitInset = 0
    const move = (delta: number) => { selected = (selected + delta + choices.length) % choices.length; tui.requestRender() }
    return {
      invalidate() {},
      render(width: number) {
        const { surface, header, edge, text, secondary, selectedBg } = palette()
        const cap = Math.max(1, tui.terminal.rows - 2)
        hitWidth = width
        const framed = width >= 12 && cap >= 6
        hitInset = framed ? 1 : 0
        const inner = width - hitInset * 2
        const fit = (value: string) => truncateToWidth(value, inner, '…', true)
        const border = (value: string) => theme.style(value, { fg: edge, bg: surface })
        const row = (value: string, style = { fg: text, bg: surface, bold: false }) => {
          const line = theme.style(fit(value), style)
          return framed ? border('│') + line + border('│') : line
        }
        const roomy = framed && cap >= choices.length + 8
        const chrome = (framed ? 2 : 0) + (cap >= 2 ? 1 : 0) + (cap >= 4 ? 1 : 0) + (roomy ? 2 : 0)
        rows = Math.max(1, Math.min(choices.length, cap - chrome))
        first = Math.max(0, Math.min(first, choices.length - rows))
        if (selected < first) first = selected
        if (selected >= first + rows) first = selected - rows + 1
        const lines: string[] = []
        if (framed) lines.push(border(`╭${'─'.repeat(inner)}╮`))
        if (cap >= 2) lines.push(row(`  ${clean(title)}`, { fg: text, bg: header, bold: true }))
        for (const line of detail.slice(0, Math.max(0, cap - chrome - rows))) {
          lines.push(row(`  ${clean(line)}`))
        }
        if (roomy) lines.push(border(`├${'─'.repeat(inner)}┤`))
        start = lines.length
        for (let i = first; i < first + rows; i++) {
          const current = i === selected
          lines.push(row(`${current ? ' ▸' : '  '} [ ${clean(choices[i].label)} ]`, {
            fg: current ? selectedFg : text, bg: current ? selectedBg : surface, bold: true,
          }))
        }
        if (roomy) lines.push(row(''))
        if (cap >= 4) {
          const position = rows < choices.length ? `  ${selected + 1}/${choices.length} ·` : ' '
          lines.push(row(`${position} 点击选择 · ↑ ↓ Enter · Esc 关闭`, { fg: secondary, bg: surface, bold: false }))
        }
        if (framed) lines.push(border(`╰${'─'.repeat(inner)}╯`))
        return lines
      },
      handleInput(data: string) {
        if (keys.matches(data, 'tui.select.cancel')) done(undefined)
        else if (keys.matches(data, 'tui.select.up')) move(-1)
        else if (keys.matches(data, 'tui.select.down')) move(1)
        else if (keys.matches(data, 'tui.select.confirm')) done(choices[selected].value)
      },
      handleMouse(event: TuiMouseEvent) {
        if (event.type === 'wheel' && event.wheelDelta) { move(Math.sign(event.wheelDelta)); return { handled: true } }
        const index = event.y - start
        if (event.button !== 'left' || index < 0 || index >= rows || event.x < hitInset || event.x >= hitWidth - hitInset) return
        if (event.type === 'press') return { handled: true, render: false }
        if (event.type === 'click') { done(choices[first + index].value); return { handled: true } }
      },
    }
  }, { overlay: true, overlayOptions: { anchor: 'center', width: 76, margin: 1 }, blocked: { kind: 'question', message: clean(title) } })
}

export default function extension(pi: ExtensionAPI) {
  let store: TaskStore | undefined
  let busy = false
  let armedSession: string | undefined
  let draft: Draft | undefined
  let clickIntent: ClickIntent | undefined

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
  async function refresh(ctx: ExtensionContext) {
    if (!ctx.hasUI) return
    const state = await context(ctx)
    if (!state.local && !state.isolated) { ctx.ui.setWidget(NAME, undefined); return }
    const active = currentTask(state.isolated, state.tasks)
    const direct: Choice<MenuAction>[] = deliveryChoices(active, !state.isolated || isBoundSession(ctx, active?.isolatedSession))
    if (state.isolated && active?.phase === 'previewed' && !active.journal) direct.unshift(localCheck)
    if (retainedTasks(state.tasks).length) direct.push(retainedChoice)
    const scope = state.isolated ? 'Worktree' : 'Local'
    const status = active ? ` · ${active.journal ? '恢复记录：已停止' : phases[active.phase]}` : ''
    const canArm = !active || (!state.isolated && !active.journal && ['delivered', 'discarded'].includes(active.phase))
    const id = ctx.sessionManager.getSessionId()
    const checked = () => armedSession === id
    const button = () => canArm ? `[${checked() ? 'x' : ' '}] 新建 Worktree` : '[ 工作树操作 ]'
    ctx.ui.setWidget(NAME, (tui, theme) => {
      let hits: { row: number; from: number; to: number; choice?: MenuAction }[] = []
      return {
        invalidate() {},
        render(width) {
          const hint = canArm && checked() ? ' · 发送下一条消息时创建' : ''
          const lines = [truncateToWidth(theme.fg('accent', button()) + `  ${scope}${status}${hint}`, width)]
          hits = [{ row: 0, from: 0, to: Math.min(width, visibleWidth(button())) }]
          let row = ''
          for (const { label, value } of direct) {
            const item = truncateToWidth(`[ ${label} ]`, width)
            if (row && visibleWidth(row) + 2 + visibleWidth(item) > width) { lines.push(row); row = '' }
            if (row) row += '  '
            const from = visibleWidth(row)
            row += theme.fg('accent', item)
            hits.push({ row: lines.length, from, to: visibleWidth(row), choice: value })
          }
          if (row) lines.push(row)
          return lines
        },
        handleMouse(event) {
          if (event.button !== 'left') return
          const hit = hits.find(({ row, from, to }) => event.y === row && event.x >= from && event.x < to)
          if (!hit) return
          if (event.type === 'press') return { handled: true, render: false }
          if (event.type === 'click') {
            if (busy || draft || clickIntent || !ctx.isIdle()) ctx.ui.notify('请等待当前操作结束。', 'warning')
            else if (hit.choice) {
              const token = randomUUID()
              clickIntent = { token, choice: hit.choice, sessionId: id, taskVersion: taskVersion(active) }
              pi.sendUserMessage(`/${NAME} ${token}`, { expandPromptTemplates: true })
            } else if (canArm) {
              if (!sessionLink(ctx)) ctx.ui.notify('无持久化 Pi 会话，不能新建 Worktree。', 'warning')
              else { armedSession = checked() ? undefined : id; tui.requestRender() }
            } else openMenu()
            return { handled: true }
          }
        },
      }
    })
  }

  pi.on('session_start', async (_event, ctx) => {
    try { await refresh(ctx) } catch (error) { if (ctx.hasUI) ctx.ui.notify(message(error), 'error') }
  })
  pi.on('input', (event, ctx) => {
    if (event.source !== 'interactive' || !ctx.hasUI || !event.text.trim() || /^[!/]/.test(event.text.trimStart())) return
    const sessionId = ctx.sessionManager.getSessionId()
    if (armedSession !== sessionId) return
    if (busy || draft || !ctx.isIdle() || event.streamingBehavior) {
      restoreDraft(ctx, event.text)
      ctx.ui.notify('请等待当前操作结束再发送；消息未发送到 Local。', 'warning')
      return { action: 'handled' }
    }
    const token = randomUUID()
    draft = { text: event.text, images: event.images, sessionId, token }
    // Only commands can replace a session. Wait for input preflight to unwind and
    // pass just a nonce to the command, never the message text or attachments.
    setImmediate(() => { if (draft?.token === token) pi.sendUserMessage(`/${NAME} ${token}`, { expandPromptTemplates: true }) })
    return { action: 'handled' }
  })
  pi.on('before_agent_start', async (event, ctx) => {
    const state = await context(ctx).catch(() => undefined)
    const task = state?.isolated
    if (!task || task.isolatedSession?.id !== ctx.sessionManager.getSessionId()) return
    const guidance = task.phase === 'previewed'
      ? 'Local has an active preview. Discuss the changes without modifying files. If more edits are needed, ask the user to click 撤回预览 first; do not roll back yourself.'
      : task.phase === 'delivered' || task.phase === 'discarded'
        ? 'This task is closed. Use this environment for inspection only; do not mark it ready again. Ask the user to start a new task from Local for further edits.'
        : `After completing and verifying the requested task, call ${TOOL} with a short commit title. After marking ready, do not modify the worktree unless the user asks for more work.`
    return { systemPrompt: `${event.systemPrompt}\n\nThis is a managed isolated Git worktree. Work only in the active cwd; do not write to Local or deliver changes yourself. ${guidance} The user alone controls preview, rollback, delivery and discard.` }
  })
  pi.registerTool({
    name: TOOL, label: '标记待验收', description: 'Mark the current managed Worktree ready for user review. Does not write to Local or commit. Call after edits and tests.',
    parameters: Type.Object({ commitMessage: Type.String({ description: 'A one-line commit title (1–200 characters).' }) }),
    async execute(_id, params, signal, _update, ctx) {
      if (signal?.aborted) throw new Error('已取消。')
      const state = await context(ctx)
      const link = sessionLink(ctx)
      if (!state.isolated || !link) throw new Error('只能在受管 Worktree 的原始 Pi 会话中标记待验收。')
      const review = await state.data.markReady(state.isolated.id, link, params.commitMessage)
      await refresh(ctx)
      return { content: [{ type: 'text', text: `已标记待验收（${review.files.length} 个文件）；未修改 Local。用户可直接点击「预览到 Local」。` }], details: { reviewId: review.id } }
    },
  })

  async function sendInNewWorktree(ctx: ExtensionCommandContext, { text, images, sessionId }: Draft) {
    let replaced = false
    busy = true
    try {
      if (!ctx.isIdle() || sessionId !== ctx.sessionManager.getSessionId()) throw new Error('Local 会话已变化或忙碌。')
      const { local, isolated, data } = await context(ctx)
      if (!local || isolated) throw new Error('只能从 Local Git checkout 新建 Worktree。')
      if (process.platform === 'win32') throw new Error('当前版本仅支持 macOS/Linux。')
      const active = sessionLink(ctx)
      if (!active) throw new Error('无持久化 Pi 会话（例如 --no-session），不能新建 Worktree。')
      const source = await existing(active.file) ? active : await newSession(ctx.cwd, 'Local · Worktree 任务', ctx.sessionManager.getSessionDir())
      const created = await data.create(local, source, (path, id) => newSession(path, shortSessionName(id)))
      const target = created.isolatedSession!
      const result = await switchTo(ctx, target, async next => {
        replaced = true
        try {
          if (next.cwd !== target.cwd || next.sessionManager.getSessionId() !== target.id) throw new Error('Pi 未进入预期的隔离 Worktree。')
          await next.sendUserMessage(images?.length ? [{ type: 'text', text }, ...images] : text)
        } catch (error) {
          restoreDraft(next, text)
          next.ui.notify(`无法在 Worktree 发送消息：${message(error)}${images?.length ? '；请重新附加图片。' : ''}`, 'error')
        }
      })
      if (result.cancelled) throw new Error('Pi 取消了切换，可从工作台恢复已创建的 Worktree。')
    } catch (error) {
      if (!replaced) {
        restoreDraft(ctx, text)
        ctx.ui.notify(`消息未发送到 Local：${message(error)}${images?.length ? '；请重新附加图片。' : ''}`, 'error')
      }
    } finally {
      draft = undefined
      armedSession = undefined
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
      const intent = args && clickIntent?.token === args ? clickIntent : undefined
      if (args && !intent) return
      if (intent) clickIntent = undefined
      if (draft || !ctx.isIdle()) return
      busy = true
      let switching = false
      try {
        const { local, isolated, tasks, data, cwd } = await context(ctx)
        const task = currentTask(isolated, tasks)
        if (!local && !isolated) throw new Error('请从有初始提交的 Git checkout 打开 Pi。')
        const mayDeliver = !isolated || isBoundSession(ctx, isolated.isolatedSession)
        const choices: Choice<MenuAction>[] = [...deliveryChoices(task, mayDeliver)]
        const details = [`${isolated ? 'Worktree' : 'Local'}${task ? ` · ${phases[task.phase]}${task.review ? ` · ${task.review.message}（${task.review.files.length} 个文件）` : ''}` : ''}`]
        if (task) {
          if (task.journal || task.phase === 'creating') details.push(`已停止自动操作 · ${data.statePath}`, task.isolatedPath)
          if (task.cleanup?.status === 'retained') details.push(`保留 Worktree：${task.cleanup.reason}`, task.isolatedPath)
        }
        details.push(`目录：${cwd}`)
        if (isolated) {
          choices.unshift(isolated.phase === 'previewed' && !isolated.journal ? localCheck : { label: '返回 Local', value: 'return' })
          if (mayDeliver && !isolated.journal && ['working', 'ready'].includes(isolated.phase)) choices.push({ label: '标记待验收（手动）', value: 'mark' })
        } else if (!task || (!task.journal && ['delivered', 'discarded'].includes(task.phase))) {
          choices.push({ label: armedSession === ctx.sessionManager.getSessionId() ? '取消下次发送时新建' : '下次发送时新建 Worktree', value: 'arm' })
        } else if (!task.journal && task.phase !== 'creating') {
          if (task.isolatedSession) choices.unshift({ label: '进入 / 恢复 Worktree', value: 'resume' })
          if (task.phase === 'working' || task.phase === 'ready') choices.push({ label: labels.discard, value: 'discard' })
        }
        const retained = retainedTasks(tasks)
        if (retained.length) choices.push(retainedChoice)
        choices.push({ label: '关闭', value: 'close' })
        if (intent && (intent.sessionId !== ctx.sessionManager.getSessionId() || intent.taskVersion !== taskVersion(task) ||
            !choices.some(option => option.value === intent.choice))) throw new Error('任务状态已变化，请重新选择。')
        const choice = intent?.choice ?? await pick(ctx, 'Worktree 预览工作台', details, choices)
        if (!choice || choice === 'close' || !ctx.isIdle()) return
        if (choice === 'arm' && local) {
          if (!sessionLink(ctx)) throw new Error('无持久化 Pi 会话，不能新建 Worktree。')
          const id = ctx.sessionManager.getSessionId()
          armedSession = armedSession === id ? undefined : id
        } else if (choice === 'return' && isolated) {
          await data.validateLocalIdentity(isolated)
          const moved = await switchTo(ctx, isolated.localSession, async () => { switching = true })
          if (moved.cancelled) throw new Error('Pi 取消了切换。')
        } else if (choice === 'retained' || (choice === 'resume' && task?.isolatedSession)) {
          const target = choice === 'retained' ? await pick<Task | undefined>(ctx, '已保留的 Worktree', ['任务已交付，可恢复会话检查原环境。'], [
            ...retained.map(item => ({ label: `${item.id.slice(0, 8)} · ${item.review?.message ?? 'Worktree'}`, value: item })),
            { label: '取消', value: undefined },
          ]) : task
          if (!target?.isolatedSession || !ctx.isIdle()) return
          await data.validateIsolatedIdentity(target)
          const moved = await switchTo(ctx, target.isolatedSession, async () => { switching = true })
          if (moved.cancelled) throw new Error('Pi 取消了切换。')
        } else if (choice === 'mark' && isolated) {
          const link = sessionLink(ctx)
          if (!link) throw new Error('没有可保存的 Pi 会话。')
          await data.markReady(isolated.id, link, 'Worktree task changes')
          ctx.ui.notify('已标记待验收；未修改 Local。', 'info')
        } else if (task && choice in labels) {
          const act = choice as Action
          const discardFingerprint = act === 'discard' ? await data.discardFingerprint(task) : undefined
          const impact: Record<Action, string> = {
            preview: '只将任务改动写入原 checkout，不暂存、不提交。',
            rollback: '恢复预览前的文件状态；Local 发生漂移时停止。',
            finalize: '只提交本次预览的任务改动，保留原有 Git 改动。',
            discard: '放弃隔离工作；若能安全核验，将删除隔离 Worktree。',
          }
          const relevantFiles = task.receipt?.changedFiles ?? task.review?.files ?? []
          const summary = relevantFiles.slice(0, 3).map(s => `• ${s}`)
          if (relevantFiles.length > 3) summary.push(`… 共 ${relevantFiles.length} 个文件`)
          const leavesWorktree = act === 'finalize' && !!isolated
          const detail = [impact[act], task.local.root, ...summary]
          if (act === 'finalize') detail.push('默认安全清理；也可保留 Worktree 环境供日后检查。')
          if (leavesWorktree) detail.unshift('将先切换到原 Local 会话，再提交。')
          const decision = await pick<'execute' | 'keep' | undefined>(ctx, `确认：${labels[act]}`, detail, [
            { label: act === 'finalize' ? '提交并清理 Worktree（默认）' : `执行${labels[act]}`, value: 'execute' },
            ...(act === 'finalize' ? [{ label: '提交并保留 Worktree', value: 'keep' as const }] : []),
            { label: '取消', value: undefined },
          ])
          if (!decision || !ctx.isIdle()) return
          const execute = async (activeCtx: ExtensionContext) => {
            if (decision === 'keep') {
              if (!task.isolatedSession || task.isolatedSession.cwd !== task.isolatedPath) throw new Error('找不到可保留的 Worktree 会话，未提交。')
              await validateSession(task.isolatedSession)
            }
            const result = await data.act(task.id, act, {
              phase: task.phase, reviewId: task.review?.id, previewId: task.receipt?.previewId,
              discardFingerprint, keepWorktree: decision === 'keep',
            })
            const note = result.cleanup?.status === 'retained' ? `；保留 Worktree：${result.isolatedPath}（${result.cleanup.reason}）` : ''
            const preview = act === 'preview' && isolated ? '；仍在 Worktree，可点击「打开 Local 检查」' : ''
            activeCtx.ui.notify(`${labels[act]}完成${result.commitOid ? ` · ${result.commitOid.slice(0, 12)}` : ''}${preview}${note}`,
              note && !result.cleanup?.requested ? 'warning' : 'info')
          }
          if (leavesWorktree) {
            // Leave the active cwd before finalize can delete it. A veto or failed
            // switch never authorizes a commit from the old session.
            await data.validateLocal(task)
            const moved = await switchTo(ctx, task.localSession, async next => {
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
          } else await execute(ctx)
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
