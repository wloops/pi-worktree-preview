import type { AdoptionRequest, Action } from './store.ts'

const actions = ['preview', 'rollback', 'commit', 'discard'] as const
export type ActionVerb = typeof actions[number]
export const commandActions: Record<ActionVerb, Action> = { preview: 'preview', rollback: 'rollback', commit: 'finalize', discard: 'discard' }
export type WorktreeCommand =
  | { kind: 'help' | 'new' | 'status' | 'resume' | 'back' | 'cancel' }
  | { kind: 'action'; verb: ActionVerb; text?: true }
  | { kind: 'confirm'; token: string }
  | { kind: 'adopt'; request: AdoptionRequest; text?: true }
  | { kind: 'discoverAdoption' }
  | { kind: 'selectAdoption'; numbers: number[] }

/** Explicit subcommands only; neither shell interpolation nor loose path parsing. */
export function parseWorktreeCommand(args: string): WorktreeCommand {
  const [, verb, argument] = /^([^\s]*)(?:\s+([\s\S]*))?$/u.exec(args.trim()) ?? []
  const useText = /^--text(?:\s|$)/u.test(argument ?? '')
  const payload = useText ? argument!.slice(6).trimStart() : argument
  if (!verb || verb === 'help' && !argument) return { kind: 'help' }
  if (!payload && actions.some(action => action === verb)) return { kind: 'action', verb: verb as ActionVerb, ...(useText ? { text: true } : {}) }
  if (!argument && (verb === 'new' || verb === 'status' || verb === 'resume' || verb === 'back' || verb === 'cancel')) return { kind: verb }
  if (verb === 'confirm' && !useText && payload && /^[a-f0-9-]{36}$/u.test(payload)) return { kind: 'confirm', token: payload }
  if (verb === 'adopt') {
    if (!argument) return { kind: 'discoverAdoption' }
    if (!useText && payload && /^[1-9]\d*(?:\s*,\s*[1-9]\d*)*$/u.test(payload)) {
      const numbers = payload.split(',').map(Number)
      if (numbers.every(Number.isSafeInteger) && new Set(numbers).size === numbers.length) return { kind: 'selectAdoption', numbers }
    }
    const usage = '运行 adopt 自动接入，adopt 1,3 只保留当前清单中对应文件，或显式传入 {"source":"/源目录","target":"/目标目录","base":"完整提交 OID","title":"提交标题","files":["相对路径"]}'
    let values: unknown
    try { values = JSON.parse(payload ?? '') } catch { throw new Error(usage) }
    const req = values as Partial<AdoptionRequest> | null
    if (!req || Object.keys(req).length !== 5 || typeof req.source !== 'string' || typeof req.target !== 'string' ||
        typeof req.base !== 'string' || typeof req.title !== 'string' || !Array.isArray(req.files) ||
        !req.files.length || req.files.some(path => typeof path !== 'string')) throw new Error(usage)
    return { kind: 'adopt', request: { source: req.source, target: req.target, base: req.base, title: req.title, files: req.files }, ...(useText ? { text: true } : {}) }
  }
  throw new Error('不支持的参数。使用 /worktree-preview help 查看命令。')
}
