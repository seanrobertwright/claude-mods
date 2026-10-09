// A run's run log: transcript lines as rows, each row's node, and the window
// of the newest 60,000 drawn characters the pane keeps.

import type { LogRow, LogWindow, RunEvent } from '../types'
import { dollars, duration, fit, size } from './text'

/** The most drawn characters the window keeps, and a file's read view shows. */
export const WINDOW_CHARS = 60_000
/** The most an opened fold draws. */
export const FOLD_CHARS = 4_000
/** The lines of a bash node's printout shown. */
const EXEC_LINES = 20

export const EMPTY_WINDOW: LogWindow = { runId: '', rows: [], dropped: 0, taken: 0, open: [], tools: 0, end: '', isMissing: false, node: '' }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Whole lines out of a spawn's chunks: what came before plus this chunk, with a partial last line held for the next. */
export function splitChunk(held: string, chunk: string): { lines: string[]; held: string } {
  const text = held + chunk
  const at = text.lastIndexOf('\n')
  if (at < 0) return { lines: [], held: text }
  return { lines: text.slice(0, at).split('\n').map(line => line.replace(/\r$/, '')), held: text.slice(at + 1) }
}

/** The argument a tool row names: a command, a path, a pattern, or the input's first text. */
function mainArgument(input: Record<string, unknown>): { key: string; text: string } {
  for (const key of ['command', 'pattern', 'file_path', 'path', 'url', 'query', 'description', 'prompt']) {
    if (str(input[key]) !== '') return { key, text: str(input[key]) }
  }
  const first = Object.entries(input).find(([, value]) => typeof value === 'string')
  return first === undefined ? { key: '', text: '' } : { key: first[0], text: first[1] as string }
}

/** A tool row: the tool and its main argument on one line, the full input behind `▸` when there is more of it. */
function toolRow(name: string, input: Record<string, unknown>): { text: string; full: string } {
  const main = mainArgument(input)
  const content = str(input.content)
  const sized = name === 'Write' && content !== '' ? ` (${size(content.length)})` : ''
  const line = `${name} ${fit(main.text.split('\n')[0] ?? '', 200)}${sized}`.trim()
  const whole = Object.entries(input).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join('\n')
  // The full input is folded behind ▸ only when it says much more than the line does.
  const isMore = whole.length > line.length + 40 || (name === 'Write' && content !== '') || Object.values(input).some(value => typeof value === 'string' && value.includes('\n'))
  return { text: isMore ? `${line} ▸` : line, full: isMore ? whole : '' }
}

/** The tail of a printout: its last `count` lines. */
function tail(text: string, count: number): string[] {
  const lines = text.replace(/\n+$/, '').split('\n').filter(line => line !== '')
  return lines.slice(-count)
}

/**
 * The rows one transcript line makes. Transcript rows do not name their node:
 * a tool row is counted so the events can name it, and any other row belongs
 * to the nodes open when it was written.
 */
export function rowsOf(text: string, lineNo: number, window: LogWindow): { rows: LogRow[]; window: LogWindow } {
  let entry: unknown
  try {
    entry = JSON.parse(text)
  } catch {
    return { rows: [], window }
  }
  if (!isObject(entry)) return { rows: [], window }
  const execution = isObject(entry.execution) && isObject(entry.execution.node) ? entry.execution.node : {}
  const node = str(entry.step) || str(execution.id)
  const key = `l${lineNo}`
  const at = (row: Omit<LogRow, 'key' | 'nodes' | 'tool' | 'full'> & Partial<LogRow>): LogRow => ({ key, nodes: window.open, tool: -1, full: '', ...row })
  switch (entry.type) {
    case 'node_start':
      return { rows: [at({ kind: 'start', text: `▶ ${node}`, nodes: [node] })], window: { ...window, open: window.open.includes(node) ? window.open : [...window.open, node] } }
    case 'node_complete': {
      const spent = [typeof entry.duration_ms === 'number' ? duration(entry.duration_ms) : '', typeof entry.cost_usd === 'number' ? dollars(entry.cost_usd) : ''].filter(part => part !== '')
      return { rows: [at({ kind: 'end', text: `✓ ${node}${spent.length === 0 ? '' : ` ${spent.join(' ')}`}`, nodes: [node] })], window: { ...window, open: window.open.filter(open => open !== node) } }
    }
    case 'node_error':
    case 'node_failed':
      return { rows: [at({ kind: 'error', text: `✗ ${node}: ${str(entry.error) || str(entry.message)}`, nodes: [node] })], window: { ...window, open: window.open.filter(open => open !== node) } }
    case 'node_skipped':
      return { rows: [at({ kind: 'skip', text: `– ${node} skipped${str(entry.reason) === '' ? '' : `: ${str(entry.reason)}`}`, nodes: [node] })], window }
    case 'assistant':
      return { rows: [at({ kind: 'text', text: str(entry.content) })], window }
    case 'tool': {
      const drawn = toolRow(str(entry.tool_name) || 'tool', isObject(entry.tool_input) ? entry.tool_input : {})
      return { rows: [at({ kind: 'tool', text: drawn.text, full: drawn.full, tool: window.tools })], window: { ...window, tools: window.tools + 1 } }
    }
    case 'exec_output': {
      const out = [...tail(str(entry.stdout_tail), EXEC_LINES), ...tail(str(entry.stderr_tail), EXEC_LINES)]
      return { rows: out.length === 0 ? [] : [at({ kind: 'exec', text: out.join('\n') })], window }
    }
    default:
      // Heartbeats (watchdog_reset), workflow_start and workflow_complete draw nothing.
      return { rows: [], window }
  }
}

/** The characters a row draws in the window. */
export function rowChars(row: LogRow): number {
  return row.text.length
}

/** Keeps the newest rows that fit in 60,000 drawn characters; older rows drop first. */
export function capWindow(window: LogWindow): LogWindow {
  let total = window.rows.reduce((sum, row) => sum + rowChars(row), 0)
  let cut = 0
  while (total > WINDOW_CHARS && cut < window.rows.length) {
    total -= rowChars(window.rows[cut]!)
    cut++
  }
  return cut === 0 ? window : { ...window, rows: window.rows.slice(cut), dropped: window.dropped + cut }
}

/** Takes whole transcript lines into the window, numbering them from `from + 1`; lines up to `skip` were taken already, and only rows `keep` passes stay. */
export function take(window: LogWindow, lines: readonly string[], from: number, skip: number, keep: (row: LogRow) => boolean = () => true): LogWindow {
  let next = window
  let lineNo = from
  const rows: LogRow[] = []
  for (const text of lines) {
    lineNo++
    if (lineNo <= skip) continue
    const made = rowsOf(text, lineNo, next)
    next = made.window
    rows.push(...made.rows.filter(keep))
  }
  return capWindow({ ...next, rows: [...next.rows, ...rows], taken: Math.max(next.taken, lineNo) })
}

/** The steps of the run's tool calls in order: the nth names the node of the transcript's nth tool row. */
export function toolSteps(events: readonly RunEvent[]): string[] {
  return events.filter(e => e.type === 'tool_called').map(e => e.step)
}

/** The nodes a row belongs to: a tool row's from the events, any other row's from the nodes open when it was written. */
export function nodesOf(row: LogRow, steps: readonly string[]): string[] {
  if (row.kind === 'tool') {
    const step = steps[row.tool]
    if (step !== undefined && step !== '') return [step]
  }
  return row.nodes
}

/** Whether a row shows under `node`: all rows with no node picked. */
export function isUnder(row: LogRow, node: string, steps: readonly string[]): boolean {
  return node === '' || nodesOf(row, steps).includes(node)
}
