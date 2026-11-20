import type { ExtensionContext, Theme, ThemeStyle } from '@earendil-works/pi-coding-agent'
import { Key, Loader, matchesKey, rgbColor, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TuiMouseEvent } from '@earendil-works/pi-tui'
import { tr } from './i18n/display.ts'

export const clean = (text: string) => text.replace(/[\p{Cc}\p{Cf}]/gu, '?')

type Tone = 'primary' | 'danger' | 'quiet'
export interface Choice<T> { label: string; value: T; tone?: Tone; toggle?: () => void }
type PanelOptions = { tone?: 'warning' | 'danger'; signal?: AbortSignal; requiredDetails?: number; requireDetailViewport?: boolean; lead?: string; compactActions?: boolean }
export type ToolbarChoice<T> = Choice<T> & { trailing?: boolean; checked?: boolean }

const light = {
  surface: rgbColor(245, 248, 253), header: rgbColor(222, 232, 250), edge: rgbColor(65, 92, 142),
  text: rgbColor(24, 39, 66), secondary: rgbColor(64, 81, 113), primary: rgbColor(39, 76, 151), checkbox: rgbColor(81, 113, 168), checked: rgbColor(34, 67, 137),
  warningBg: rgbColor(255, 235, 196), warningFg: rgbColor(110, 60, 0),
  dangerBg: rgbColor(255, 226, 224), dangerFg: rgbColor(134, 35, 47), dangerSelected: rgbColor(152, 38, 54),
  successBg: rgbColor(222, 242, 230), successFg: rgbColor(25, 87, 56),
}
const dark = {
  surface: rgbColor(24, 32, 48), header: rgbColor(37, 54, 81), edge: rgbColor(130, 162, 216),
  text: rgbColor(235, 241, 252), secondary: rgbColor(177, 194, 219), primary: rgbColor(48, 91, 166), checkbox: rgbColor(70, 105, 163), checked: rgbColor(41, 79, 148),
  warningBg: rgbColor(69, 52, 28), warningFg: rgbColor(255, 213, 141),
  dangerBg: rgbColor(77, 37, 46), dangerFg: rgbColor(255, 185, 188), dangerSelected: rgbColor(157, 48, 68),
  successBg: rgbColor(28, 60, 50), successFg: rgbColor(161, 231, 189),
}
const white = rgbColor(255, 255, 255)
const palette = (theme: Theme) => theme.appearance === 'light' ? light : dark

/** A non-modal indicator for an actual operation, never for a user confirmation. */
export async function withLoading<T>(ctx: ExtensionContext, label: string, run: () => Promise<T>): Promise<T> {
  if (!ctx.hasUI || ctx.mode !== 'tui') return run()
  const key = 'worktree-preview-progress'
  let installed = false
  ctx.ui.setWidget(key, (tui, theme) => {
    const loader = new Loader(tui, frame => theme.fg('accent', frame), text => theme.bold(text), label)
    installed = true
    return {
      render: width => width > 0 ? loader.render(width).slice(1) : [],
      invalidate: () => loader.invalidate(),
      dispose() { installed = false; loader.stop() },
    }
  })
  try { return await run() }
  finally {
    // Pi disposes outgoing widgets on replacement. Never clear a replacement
    // session's indicator from its predecessor or mask the operation result.
    if (installed) {
      try { ctx.ui.setWidget(key, undefined) } catch { /* stale context */ }
    }
  }
}

type StatusTone = 'normal' | 'success' | 'warning' | 'danger'
function statusStyle(theme: Theme, tone: StatusTone): ThemeStyle {
  const p = palette(theme)
  if (tone === 'warning') return { fg: p.warningFg, bg: p.warningBg, bold: true }
  if (tone === 'danger') return { fg: p.dangerFg, bg: p.dangerBg, bold: true }
  if (tone === 'success') return { fg: p.successFg, bg: p.successBg, bold: true }
  return { fg: p.text, bg: p.header, bold: true }
}

/** Rows and hit regions are built together from visual columns, not string offsets. */
export function toolbar<T>(
  theme: Theme, width: number, status: { label: string; tone?: StatusTone } | undefined, buttons: ToolbarChoice<T>[],
) {
  const p = palette(theme)
  const lines: string[] = []
  const hits: { row: number; from: number; to: number; value: T }[] = []
  if (width < 1) return { lines, hits }
  const statusText = status ? truncateToWidth(` ${clean(status.label)} `, width, '…') : ''
  let row = status ? theme.style(statusText, statusStyle(theme, status.tone ?? 'normal')) : ''
  let used = visibleWidth(statusText)
  for (const { label, value, tone, trailing, checked } of buttons) {
    const text = truncateToWidth(clean(label), width, '…')
    const size = visibleWidth(text)
    if (used && used + 2 + size > width) { lines.push(row); row = ''; used = 0 }
    const gap = trailing ? width - used - size : used ? 2 : 0
    row += ' '.repeat(gap)
    used += gap
    hits.push({ row: lines.length, from: used, to: used + size, value })
    const primaryBg = checked === undefined ? p.primary : checked ? p.checked : p.checkbox
    row += theme.style(text, tone === 'primary' || checked !== undefined ? { fg: white, bg: primaryBg, bold: true } :
      trailing ? { fg: p.text, bg: p.header, bold: true } : { fg: p.text, bg: p.surface })
    used += size
  }
  if (row) lines.push(row)
  return { lines, hits }
}

export async function pick<T>(ctx: ExtensionContext, title: string, detail: string[], choices: Choice<T>[], options: PanelOptions = {}): Promise<T | undefined> {
  const { signal, tone, requiredDetails = 0, requireDetailViewport = false, lead, compactActions = false } = options
  if (!choices.length || signal?.aborted) return
  return ctx.ui.custom<T | undefined>((tui, theme, keys, done) => {
    let finished = false
    const finish = (value: T | undefined) => {
      if (finished) return
      finished = true
      signal?.removeEventListener('abort', cancel)
      done(value)
    }
    const cancel = () => finish(undefined)
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()

    let selected = choices.length - 1 // Enter defaults to close/cancel, including destructive dialogs.
    let first = 0
    let rows = 0
    let start = 0
    let detailStart = 0
    let detailRows = 0
    let detailOffset = 0
    let detailMax = 0
    let detailControl: { y: number; from: number; to: number } | undefined
    let inset = 0
    let tooSmall = false
    const terminalSize = () => `${tui.terminal.columns}:${tui.terminal.rows}`
    let renderedSize = ''
    let press: string | undefined
    let actionHits: { index: number; y: number; from: number; to: number }[] = []
    const activate = (index: number) => {
      if (tooSmall || terminalSize() !== renderedSize) return finish(undefined)
      const choice = choices[index]
      if (!choice.toggle) return finish(choice.value)
      choice.toggle()
      selected = index
      tui.requestRender()
    }
    const move = (delta: number) => {
      if (tooSmall) return
      selected = (selected + delta + choices.length) % choices.length
      tui.requestRender()
    }
    const scroll = (delta: number, wrap = false) => {
      detailOffset = wrap && detailOffset === detailMax ? 0 : Math.max(0, Math.min(detailMax, detailOffset + delta))
      tui.requestRender()
    }
    return {
      dispose: cancel,
      invalidate() {},
      render(width: number) {
        const p = palette(theme)
        const cap = Math.max(1, tui.terminal.rows - 2)
        renderedSize = terminalSize()
        const framed = width >= 12 && cap >= 7
        inset = framed ? 1 : 0
        const inner = width - inset * 2
        const padding = inner >= 8 ? 2 : 0
        const pad = ' '.repeat(padding)
        const cols = Math.max(1, inner - padding * 2)
        const fit = (value: string) => truncateToWidth(value, inner, '…', true)
        const border = (value: string) => theme.style(value, { fg: p.edge, bg: p.surface })
        const row = (value: string, style: ThemeStyle = { fg: p.text, bg: p.surface }) => {
          const line = theme.style(fit(value), style)
          return framed ? border('│') + line + border('│') : line
        }
        const lines: string[] = []
        if (framed) lines.push(border(`╭${'─'.repeat(inner)}╮`))
        if (cap >= 2) lines.push(row(`${pad}${clean(title)}`, statusStyle(theme, tone ?? 'normal')))
        const footer = cap >= 4
        const separator = framed && cap >= 9
        const budget = cap - lines.length - Number(framed) - Number(footer) - Number(separator)
        const wrap = (items: string[]) => items.flatMap(line => wrapTextWithAnsi(clean(line), cols))
        const headline = lead ? wrap([lead]) : []
        // Never trade away the cancel button or the pinned destructive warning for copy.
        const showLead = !requiredDetails && headline.length > 0 && headline.length < budget
        const required = showLead ? headline : wrap(detail.slice(0, requiredDetails))
        const paragraphs = wrap(detail.slice(requiredDetails))
        const labelCols = Math.max(1, inner - (inner > 10 ? 7 : 0))
        tooSmall = (requiredDetails > 0 && required.length + choices.length > budget) ||
          (requireDetailViewport && (!footer || budget - required.length < 2)) ||
          ((requiredDetails > 0 || requireDetailViewport) && choices.some(({ label }) => visibleWidth(clean(label)) > labelCols))
        const fixed = tooSmall ? [tr('请放大终端后再确认。', 'Resize to confirm.')].slice(0, budget - 1) : required
        const room = budget - fixed.length
        // Keep the deletion warning and target pinned; extra context scrolls independently.
        const reserve = tooSmall ? 0 : Math.max(0, Math.min(paragraphs.length, Math.floor(room / 2), 8))
        const actionWidth = choices.reduce((sum, { label }) => sum + visibleWidth(clean(label)) + 6, 0) + choices.length - 1
        const inline = compactActions && !tooSmall && actionWidth <= cols
        rows = tooSmall || inline ? 1 : Math.max(1, Math.min(choices.length, room - reserve))
        detailRows = tooSmall ? 0 : Math.max(0, Math.min(paragraphs.length, room - rows))
        detailMax = paragraphs.length - detailRows
        detailOffset = Math.min(detailOffset, detailMax)
        for (const line of fixed) lines.push(row(pad + line, { fg: p.text, bg: p.surface, bold: true }))
        detailStart = lines.length
        for (const line of paragraphs.slice(detailOffset, detailOffset + detailRows)) {
          lines.push(row(pad + line, { fg: p.secondary, bg: p.surface }))
        }
        if (separator) lines.push(border(`├${'─'.repeat(inner)}┤`))
        first = Math.max(0, Math.min(first, choices.length - rows))
        if (selected < first) first = selected
        if (selected >= first + rows) first = selected - rows + 1
        const shownFirst = tooSmall ? choices.length - 1 : first
        start = lines.length
        actionHits = []
        if (inline) {
          let x = inner - padding - actionWidth
          let line = theme.style(' '.repeat(x), { bg: p.surface })
          for (const [index, { label, tone }] of choices.entries()) {
            const current = index === selected
            const face = `${current ? '▸' : ' '} [ ${clean(label)} ]`
            const size = visibleWidth(face)
            actionHits.push({ index, y: start, from: inset + x + 2, to: inset + x + size })
            line += theme.style(face, tone === 'primary' || tone === 'danger' ? {
              fg: white, bg: tone === 'danger' ? p.dangerSelected : p.primary, bold: true,
            } : { fg: p.text, bg: current ? p.header : p.surface, bold: current })
            if (index < choices.length - 1) line += theme.style(' ', { bg: p.surface })
            x += size + 1
          }
          line += theme.style(pad, { bg: p.surface })
          lines.push(framed ? border('│') + line + border('│') : line)
        }
        for (let i = shownFirst; !inline && i < shownFirst + rows; i++) {
          const { label, tone } = choices[i]
          const current = tooSmall || i === selected
          const prefix = inner > 10 ? (current ? ' ▸ ' : '   ') : ''
          const labelText = truncateToWidth(clean(label), labelCols, '…')
          const marker = prefix ? `[ ${labelText} ]` : labelText
          actionHits.push({ index: i, y: lines.length, from: inset + visibleWidth(prefix), to: inset + visibleWidth(prefix + marker) })
          lines.push(row(prefix + marker, current ? {
            fg: white, bg: tone === 'danger' ? p.dangerSelected : p.primary, bold: true,
          } : {
            fg: tone === 'danger' ? p.dangerFg : tone === 'quiet' ? p.secondary : p.text,
            bg: tone === 'danger' ? p.dangerBg : tone === 'primary' ? p.header : p.surface,
            bold: tone === 'primary' || tone === 'danger',
          }))
        }
        detailControl = undefined
        if (footer) {
          const position = !inline && !tooSmall && rows < choices.length ? `${selected + 1}/${choices.length} · ` : ''
          const chip = detailRows && detailMax ? `${tr('详情', 'Info')} ${detailOffset + 1}–${detailOffset + detailRows}/${paragraphs.length} ↕` : ''
          const help = tooSmall ? tr('终端太小 · Esc 关闭', 'Too small · Esc') : `${position}${inline ? '←→' : '↑↓'} · Enter · Esc`
          const prefix = chip ? `${pad}${chip}` : pad
          if (chip && visibleWidth(prefix) <= inner) detailControl = { y: lines.length, from: inset + padding, to: inset + visibleWidth(prefix) }
          lines.push(row(prefix + (chip ? '   ' : '') + help, { fg: p.secondary, bg: p.surface }))
        }
        if (framed) lines.push(border(`╰${'─'.repeat(inner)}╯`))
        return lines
      },
      handleInput(data: string) {
        if (keys.matches(data, 'tui.select.cancel')) cancel()
        else if (keys.matches(data, 'tui.select.up') || compactActions && matchesKey(data, Key.left)) move(-1)
        else if (keys.matches(data, 'tui.select.down') || compactActions && matchesKey(data, Key.right)) move(1)
        else if (keys.matches(data, 'tui.select.confirm')) activate(selected)
        else if (matchesKey(data, Key.pageUp)) scroll(-Math.max(1, detailRows))
        else if (matchesKey(data, Key.pageDown)) scroll(Math.max(1, detailRows))
      },
      handleMouse(event: TuiMouseEvent) {
        if (event.type === 'wheel' && event.wheelDelta && event.x >= inset && event.x < event.width - inset) {
          if (event.y >= detailStart && event.y < detailStart + detailRows) scroll(Math.sign(event.wheelDelta))
          else if (event.y >= start && event.y < start + rows) move(Math.sign(event.wheelDelta))
          else return
          return { handled: true }
        }
        if (event.button !== 'left') return
        const action = actionHits.find(hit => hit.y === event.y && event.x >= hit.from && event.x < hit.to)
        const detailHit = detailControl && event.y === detailControl.y && event.x >= detailControl.from && event.x < detailControl.to
        const key = (detailHit || action) && terminalSize() === renderedSize
          ? `${renderedSize}:${event.x}:${event.y}:${event.screenX}:${event.screenY}:${detailHit ? `detail-${detailOffset}` : action?.index}` : undefined
        if (event.type === 'press') {
          press = key
          if (key) return { handled: true, render: false }
        }
        if (event.type === 'click') {
          const confirmed = key && key === press
          press = undefined
          if (confirmed) {
            if (detailHit) scroll(Math.max(1, detailRows), true)
            else if (action) activate(action.index)
            return { handled: true }
          }
        }
      },
    }
  }, { overlay: true, overlayOptions: { anchor: 'center', width: compactActions ? 64 : 76, margin: 1 }, blocked: { kind: 'question', message: clean(title) } })
}
