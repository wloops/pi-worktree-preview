import { tr } from './i18n/display.ts'

export const MAX_COMMIT_BODY = 4_000

export function normalizeCommitBody(value: unknown): string | undefined {
  if (value === undefined) return
  if (typeof value !== 'string' || value.length > MAX_COMMIT_BODY || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value)) {
    throw new Error(tr(`提交正文最多 ${MAX_COMMIT_BODY} 字符，不能包含控制字符。`,
      `The commit body must be at most ${MAX_COMMIT_BODY} characters and cannot contain control characters.`))
  }
  const paragraphs = value.replace(/\r\n?/g, '\n').split('\n')
  while (paragraphs.length && !paragraphs[0]?.trim()) paragraphs.shift()
  while (paragraphs.length && !paragraphs.at(-1)?.trim()) paragraphs.pop()
  return paragraphs.join('\n') || undefined
}

export function formatCommitMessage(title: string, body?: string): string {
  return body ? `${title}\n\n${body}` : title
}

/** Commit messages are sent to Git on stdin. */
export function isValidCommitMessage(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0')
}
