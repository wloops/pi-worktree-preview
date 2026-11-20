import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Language } from './core.ts'

const key = Symbol.for('pi-worktree-preview.display-language')
const globals = globalThis as typeof globalThis & { [key]?: Language }

export function getDisplayLanguage(): Language {
  return globals[key] ?? 'zh'
}

export function tr(zh: string, en: string): string {
  return getDisplayLanguage() === 'en' ? en : zh
}

export function tf(zh: string, en: string, ...values: unknown[]): string {
  return tr(zh, en).replace(/\{(\d+)\}/gu, (_match, index: string) => String(values[Number(index)]))
}

export function loadDisplayLanguage(dir: string): void {
  try {
    const value: unknown = JSON.parse(readFileSync(join(dir, 'preferences.json'), 'utf8')).language
    globals[key] = value === 'en' ? 'en' : 'zh'
  } catch { globals[key] = 'zh' }
}

export async function saveDisplayLanguage(dir: string, language: Language): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, 'preferences.json')
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, JSON.stringify({ language }) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temp, file)
    globals[key] = language
  } finally { await rm(temp, { force: true }).catch(() => {}) }
}
