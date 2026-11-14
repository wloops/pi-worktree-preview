import { getAgentDir, SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type InputEvent } from '@earendil-works/pi-coding-agent'
import { matchesKey, truncateToWidth, visibleWidth, type TuiMouseEvent } from '@earendil-works/pi-tui'
import { Type } from 'typebox'
import { randomUUID } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { checkout, shortSessionName, TaskStore, type Action, type SessionLink, type Task } from './store.ts'

const NAME = 'worktree-preview'
const TOOL = 'worktree_ready_for_review'
const labels: Record<Action, string> = { preview: '预览到 Local', rollback: '撤回预览', finalize: '确认提交', discard: '放弃任务' }
const phases = { creating: '创建中断', working: '进行中', ready: '待验收', previewed: '已预览', delivered: '已交付', discarded: '已放弃' }
const clean = (s: string) => s.replace(/[\p{Cc}\p{Cf}]/gu, '?')
const message = (e: unknown) => clean(e instanceof Error ? e.message : String(e))
function sessionLink(ctx: ExtensionContext): SessionLink | undefined {
  const file = ctx.sessionManager.getSessionFile()
  if (file) return { file, id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd }
}
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

async function switchTo(ctx: ExtensionCommandContext, link: SessionLink, withSession?: SwitchOptions['withSession']) {
  if (!isAbsolute(link.file) || !await existing(link.file)) throw new Error(`Pi 会话文件不存在：${link.file}`)
  if (!(await lstat(link.cwd)).isDirectory()) throw new Error(`会话工作目录不存在：${link.cwd}`)
  const sm = SessionManager.open(link.file)
  if (sm.getSessionId() !== link.id || sm.getHeader()?.cwd !== link.cwd) throw new Error('会话身份或工作目录已变化。')
  return ctx.switchSession(link.file, { withSession })
}

function restoreDraft(ctx: ExtensionContext, text: string) {
  const current = ctx.ui.getEditorText()
  ctx.ui.setEditorText(!current || current === text ? text : `${text}\n\n${current}`)
}

type Draft = Pick<InputEvent, 'text' | 'images'> & { token: string; sessionId: string }

interface Choice<T> { label: string; value: T }
async function pick<T>(ctx: ExtensionCommandContext, title: string, detail: string[], choices: Choice<T>[]): Promise<T | undefined> {
  return ctx.ui.custom<T | undefined>((tui, theme, _keys, done) => {
    let selected = choices.length - 1 // cancellation is the default for keyboard confirmation
    let first = 0
    let rows = 0
    let start = 0
    const move = (delta: number) => { selected = (selected + delta + choices.length) % choices.length; tui.requestRender() }
    return {
      invalidate() {},
      render(width: number) {
        const cap = Math.max(1, tui.terminal.rows - 4)
        const lines = [theme.fg('accent', clean(title)), ...detail.slice(0, Math.min(7, Math.max(0, cap - Math.min(choices.length, 5) - 2))).map(clean)]
        start = lines.length
        rows = Math.max(1, Math.min(choices.length, cap - start - 1))
        first = Math.max(0, Math.min(first, choices.length - rows))
        if (selected < first) first = selected
        if (selected >= first + rows) first = selected - rows + 1
        for (let i = first; i < first + rows; i++) {
          const label = `${i === selected ? '›' : ' '} [ ${clean(choices[i].label)} ]`
          lines.push(i === selected ? theme.fg('accent', label) : label)
        }
        lines.push(theme.fg('dim', '点击选择 · ↑ ↓ Enter · Esc 关闭'))
        return lines.map(line => truncateToWidth(line, width, '…', true))
      },
      handleInput(data: string) {
        if (matchesKey(data, 'escape')) done(undefined)
        else if (matchesKey(data, 'up')) move(-1)
        else if (matchesKey(data, 'down')) move(1)
        else if (matchesKey(data, 'enter')) done(choices[selected].value)
      },
      handleMouse(event: TuiMouseEvent) {
        if (event.type === 'wheel' && event.wheelDelta) { move(Math.sign(event.wheelDelta)); return { handled: true } }
        const index = event.y - start
        if (event.button !== 'left' || index < 0 || index >= rows) return
        if (event.type === 'press') return { handled: true, render: false }
        if (event.type === 'click') { done(choices[first + index].value); return { handled: true } }
      },
    }
  }, { overlay: true, overlayOptions: { anchor: 'center', width: '86%' } })
}

export default function extension(pi: ExtensionAPI) {
  let store: TaskStore | undefined
  let busy = false
  let currentCwd: string | undefined
  let armedSession: string | undefined
  let draft: Draft | undefined

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
    currentCwd = ctx.cwd
    if (!state.local && !state.isolated) { ctx.ui.setWidget(NAME, undefined); return }
    const active = state.isolated ?? state.tasks.find(t => t.journal || !['delivered', 'discarded'].includes(t.phase)) ?? state.tasks[0]
    const scope = state.isolated ? 'Worktree' : 'Local'
    const status = active ? ` · ${active.journal ? '恢复记录：已停止' : phases[active.phase]}` : ''
    const canArm = !active || (!state.isolated && !active.journal && ['delivered', 'discarded'].includes(active.phase))
    const id = ctx.sessionManager.getSessionId()
    const checked = () => armedSession === id
    const button = () => canArm ? `[${checked() ? 'x' : ' '}] 新建 Worktree` : '[ 工作树操作 ]'
    ctx.ui.setWidget(NAME, (tui, theme) => ({
      invalidate() {},
      render(width) {
        const hint = canArm && checked() ? ' · 发送下一条消息时创建' : ''
        return [truncateToWidth(theme.fg('accent', button()) + `  ${scope}${status}${hint}`, width)]
      },
      handleMouse(event) {
        if (event.button !== 'left' || event.y !== 0 || event.x < 0 || event.x >= visibleWidth(button())) return
        if (event.type === 'press') return { handled: true, render: false }
        if (event.type === 'click') {
          if (busy || draft || !ctx.isIdle()) ctx.ui.notify('请等待当前操作结束。', 'warning')
          else if (canArm) {
            if (!sessionLink(ctx)) ctx.ui.notify('无持久化 Pi 会话，不能新建 Worktree。', 'warning')
            else { armedSession = checked() ? undefined : id; tui.requestRender() }
          } else openMenu()
          return { handled: true }
        }
      },
    }))
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
    return { systemPrompt: `${event.systemPrompt}\n\nThis is a managed isolated Git worktree. Work only in the active cwd; do not write to Local or deliver changes yourself. After completing and verifying the requested task, call ${TOOL} with a short commit title. After marking ready, do not modify the worktree unless the user asks for more work. The user alone controls preview, rollback, delivery and discard.` }
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
      return { content: [{ type: 'text', text: `已标记待验收（${review.files.length} 个文件）；未修改 Local。用户可点击「返回 Local」后预览。` }], details: { reviewId: review.id } }
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

  type MenuAction = Action | 'arm' | 'resume' | 'return' | 'mark' | 'close'
  pi.registerCommand(NAME, {
    description: '打开 Worktree 预览工作台（fullscreen 中也可点击）',
    async handler(args, ctx) {
      if (!ctx.hasUI || busy) return
      if (args) {
        if (draft?.token === args) await sendInNewWorktree(ctx, draft)
        return
      }
      if (draft || !ctx.isIdle()) return
      busy = true
      let switching = false
      try {
        const { local, isolated, tasks, data, cwd } = await context(ctx)
        const task = isolated ?? tasks.find(t => t.journal || !['delivered', 'discarded'].includes(t.phase)) ?? tasks[0]
        if (!local && !isolated) throw new Error('请从有初始提交的 Git checkout 打开 Pi。')
        const choices: Choice<MenuAction>[] = []
        const details = [cwd]
        if (task) {
          details.push(`${phases[task.phase]}${task.review ? ` · ${task.review.message} (${task.review.files.length} 个文件)` : ''}`)
          if (task.journal || task.phase === 'creating') details.push(`已停止自动操作 · ${data.statePath}`, task.isolatedPath)
          if (task.cleanup?.status === 'retained') details.push(`保留 Worktree：${task.cleanup.reason}`, task.isolatedPath)
        }
        if (isolated) {
          choices.push({ label: '返回 Local', value: 'return' })
          if (!task?.journal && ['working', 'ready'].includes(isolated.phase)) choices.push({ label: '标记待验收（手动）', value: 'mark' })
        } else if (!task || (!task.journal && ['delivered', 'discarded'].includes(task.phase))) {
          choices.push({ label: armedSession === ctx.sessionManager.getSessionId() ? '取消下次发送时新建' : '下次发送时新建 Worktree', value: 'arm' })
        } else if (!task.journal && task.phase !== 'creating') {
          if (task.isolatedSession && task.phase !== 'previewed') choices.push({ label: '进入 / 恢复 Worktree', value: 'resume' })
          if (task.phase === 'ready') choices.push({ label: labels.preview, value: 'preview' })
          if (task.phase === 'working' || task.phase === 'ready') choices.push({ label: labels.discard, value: 'discard' })
          if (task.phase === 'previewed') choices.push({ label: labels.rollback, value: 'rollback' }, { label: labels.finalize, value: 'finalize' })
        }
        choices.push({ label: '关闭', value: 'close' })
        const choice = await pick(ctx, 'Worktree 预览工作台', details, choices)
        if (!choice || choice === 'close' || !ctx.isIdle()) return
        if (choice === 'arm' && local) {
          if (!sessionLink(ctx)) throw new Error('无持久化 Pi 会话，不能新建 Worktree。')
          const id = ctx.sessionManager.getSessionId()
          armedSession = armedSession === id ? undefined : id
        } else if (choice === 'return' && isolated) {
          await data.validateLocal(isolated)
          switching = true
          await switchTo(ctx, isolated.localSession)
        } else if (choice === 'resume' && task?.isolatedSession) {
          await data.validateIsolated(task)
          switching = true
          await switchTo(ctx, task.isolatedSession)
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
          const yes = await pick(ctx, `确认：${labels[act]}`, [impact[act], task.local.root, ...summary], [
            { label: `执行${labels[act]}`, value: true }, { label: '取消', value: false },
          ])
          if (!yes || !ctx.isIdle()) return
          const result = await data.act(task.id, act, { phase: task.phase, reviewId: task.review?.id, previewId: task.receipt?.previewId, discardFingerprint })
          const note = result.cleanup?.status === 'retained' ? `；保留 Worktree：${result.isolatedPath}（${result.cleanup.reason}）` : ''
          ctx.ui.notify(`${labels[act]}完成${result.commitOid ? ` · ${result.commitOid.slice(0, 12)}` : ''}${note}`, note ? 'warning' : 'info')
        }
      } catch (error) {
        if (!switching || currentCwd === ctx.cwd) {
          try { ctx.ui.notify(message(error), 'error') } catch { /* A replacement may have invalidated the original context. */ }
        }
      } finally {
        busy = false
        if (!switching) await refresh(ctx).catch(() => {})
      }
    },
  })
}
