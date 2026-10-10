// Small text helpers every view shares. Carried over from the first cut and
// extended; each mod keeps its own copy (ADR-0001).

import type { Status } from '../types'

/** `line` cut to `max` characters, ending in `…` when cut. */
export function fit(line: string, max: number): string {
  const chars = Array.from(line)
  return chars.length <= max ? line : `${chars.slice(0, Math.max(1, max - 1)).join('')}…`
}

/** The last line of a command's output, at most 200 characters. */
export function lastLine(output: string): string {
  const lines = output.trim().split(/\r?\n/)
  return lines[lines.length - 1]?.slice(0, 200) ?? ''
}

/** The first non-empty line of `text`, trimmed. */
export function firstLine(text: string): string {
  return text.split(/\r?\n/).map(line => line.trim()).find(line => line !== '') ?? ''
}

/** `text` on one line: runs of whitespace, newlines included, become one space. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** How long ago `ms` was: `just now`, `4 min ago`, `2 h ago`. */
export function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  return minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`
}

/** A span of time, short: `42s`, `3m`, `1h 12m`. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const rest = minutes % 60
  return rest === 0 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 60)}h ${rest}m`
}

/** The time of day `ms` falls on, `14:05`, in the machine's own time. */
export function clockTime(ms: number): string {
  const at = new Date(ms)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/** A size in bytes, short: `512 B`, `35 KB`, `1.2 MB`. */
export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** A cost in dollars, `$4.12`. */
export function dollars(usd: number): string {
  return `$${usd.toFixed(2)}`
}

/** What a run's or a node's state looks like in one character. */
export type Look = 'running' | 'pending' | 'approval' | 'action' | 'unreadable' | 'waiting' | Exclude<Status, 'running' | 'pending' | 'paused'> | 'paused' | 'skipped'

const GLYPHS: Record<Look, string> = {
  running: '●',
  pending: '○',
  paused: '⏸',
  approval: '⏸',
  action: '!',
  unreadable: '?',
  waiting: '◷',
  completed: '✓',
  failed: '✗',
  cancelled: '✗',
  skipped: '–',
}

export function glyph(look: Look): string {
  return GLYPHS[look]
}

/** The theme colour a state is drawn in; undefined for the text colour. */
export function colour(look: Look): 'success' | 'error' | 'warning' | undefined {
  if (look === 'running' || look === 'completed') return 'success'
  if (look === 'failed') return 'error'
  if (look === 'approval' || look === 'action' || look === 'unreadable') return 'warning'
  return undefined
}
