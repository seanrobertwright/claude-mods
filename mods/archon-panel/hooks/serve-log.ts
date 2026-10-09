// Archon's log: what `archon serve` writes about its own work, for every
// project on the machine, shown whole and uncut to the session's project.

import { WINDOW_CHARS } from './log'
import { clockTime } from './text'

const LEVELS: Record<number, string> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' }

/** One line as the sub-tab draws it: a pino line as `14:02 warn  adapter  msg`, level 40 in `warning`, 50 and up in `error`; any other line as it is. */
export function serveLine(line: string): { text: string; tone: 'warning' | 'error' | undefined } {
  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch {
    return { text: line, tone: undefined }
  }
  if (typeof entry !== 'object' || entry === null || typeof (entry as { level?: unknown }).level !== 'number') return { text: line, tone: undefined }
  const { level, time, module, msg } = entry as { level: number; time?: unknown; module?: unknown; msg?: unknown }
  const name = LEVELS[level] ?? String(level)
  const at = typeof time === 'number' ? `${clockTime(time)} ` : ''
  const text = `${at}${name.padEnd(5)} ${typeof module === 'string' ? `${module}  ` : ''}${typeof msg === 'string' ? msg : ''}`
  return { text: text.trimEnd(), tone: level >= 50 ? 'error' : level >= 40 ? 'warning' : undefined }
}

/** The newest lines that fit under the window's 60,000 characters. */
export function capLines(lines: readonly string[]): string[] {
  const kept: string[] = []
  let total = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (total + line.length > WINDOW_CHARS) break
    total += line.length
    kept.unshift(line)
  }
  return kept
}

/** The log file's path with a leading `~` expanded from the home folder. */
export function expandHome(path: string, home: string): string {
  return path === '~' || path.startsWith('~/') || path.startsWith('~\\') ? `${home.replace(/[\\/]+$/, '')}${path.slice(1).replace(/\\/g, '/')}` : path
}
