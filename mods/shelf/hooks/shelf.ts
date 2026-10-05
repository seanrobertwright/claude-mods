import type { Entry } from '../types'

/** What `/shelf` was asked to do, read from everything typed after the name. */
export type Request =
  | { kind: 'list' }
  | { kind: 'add'; name: string; path: string | null }
  | { kind: 'remove'; name: string }
  | { kind: 'usage' }

export const USAGE = 'Usage: /shelf, /shelf add <name> [path], /shelf remove <name>'

const NAME_LIMIT = 24
// A button's frame and the gap after it, beside its label.
const BUTTON_EXTRA = 5

function unquoted(text: string): string {
  const match = /^"(.*)"$/.exec(text) ?? /^'(.*)'$/.exec(text)
  return match?.[1] ?? text
}

export function parseRequest(args: string): Request {
  const trimmed = args.trim()
  if (trimmed === '') return { kind: 'list' }
  const [, verb = '', name = '', rest = ''] = /^(\S+)(?:\s+(\S+))?(?:\s+(.*))?$/.exec(trimmed) ?? []
  if (name === '' || name.length > NAME_LIMIT) return { kind: 'usage' }
  if (verb === 'add') {
    const path = unquoted(rest.trim())
    return { kind: 'add', name, path: path === '' ? null : path }
  }
  if (verb === 'remove' && rest === '') return { kind: 'remove', name }
  return { kind: 'usage' }
}

/** What the store gave back, kept only where it is still a list of entries. */
export function parseStored(value: unknown): Entry[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown): Entry[] => {
    if (typeof item !== 'object' || item === null) return []
    const { name, path } = item as Record<string, unknown>
    return typeof name === 'string' && typeof path === 'string' ? [{ name, path }] : []
  })
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** The shelf with `entry` on it: in the place of one with its name, or at the end. */
export function withEntry(entries: readonly Entry[], entry: Entry): Entry[] {
  const at = entries.findIndex(held => sameName(held.name, entry.name))
  if (at === -1) return [...entries, entry]
  return entries.map((held, index) => (index === at ? entry : held))
}

export function withoutEntry(entries: readonly Entry[], name: string): Entry[] {
  return entries.filter(held => !sameName(held.name, name))
}

/** The path as the prompt takes it: in double quotes when it holds a space. */
export function promptText(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path
}

/** How many of the entries' buttons fit one row of `columns` after the band's label. */
export function fitCount(entries: readonly Entry[], columns: number, labelColumns: number): number {
  let used = labelColumns
  let count = 0
  for (const entry of entries) {
    used += entry.name.length + BUTTON_EXTRA
    if (used > columns) break
    count += 1
  }
  return count
}

export function listing(entries: readonly Entry[]): string {
  if (entries.length === 0) return `The shelf is empty. ${USAGE}`
  return entries.map(entry => `${entry.name}: ${entry.path}`).join('\n')
}
