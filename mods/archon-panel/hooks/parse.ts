import type { Run, RunNode, State } from '../types'

export type Config = {
  archon: string
  limit: number
  refreshMs: number
}

export function parseConfig(options: Readonly<Record<string, unknown>>): Config {
  const { archonPath, limit, refreshSeconds } = options
  const isSeconds = typeof refreshSeconds === 'number' && Number.isInteger(refreshSeconds)
  return {
    archon: typeof archonPath === 'string' && archonPath.trim() !== '' ? archonPath.trim() : 'archon',
    limit: typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 && limit <= 50 ? limit : 10,
    refreshMs: isSeconds && (refreshSeconds === 0 || (refreshSeconds >= 2 && refreshSeconds <= 300)) ? refreshSeconds * 1000 : 5000,
  }
}

/** What the pane says when the Archon CLI cannot be started. */
export const NEEDS_ARCHON = 'The Archon pane needs the Archon CLI. Install it, or set its path in the mod settings, then press r.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\p{Cc}/gu, ' ').trim() : ''
}

const STATES: Readonly<Record<string, State>> = {
  running: 'running',
  started: 'running',
  paused: 'paused',
  waiting: 'paused',
  completed: 'completed',
  complete: 'completed',
  succeeded: 'completed',
  failed: 'failed',
  error: 'failed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  abandoned: 'cancelled',
  pending: 'pending',
}

export function stateOf(status: unknown): State {
  return STATES[text(status).toLowerCase()] ?? 'other'
}

function time(value: unknown): number {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isNaN(ms) ? 0 : ms
}

/** Reads `archon workflow runs --json`; rows without an id are dropped. */
export function parseRuns(json: string): Run[] {
  const body: unknown = JSON.parse(json)
  const rows = isRecord(body) ? body.runs : undefined
  if (!Array.isArray(rows)) throw new Error('archon workflow runs did not answer a list')
  return rows.filter(isRecord).flatMap(row => {
    const id = text(row.id)
    if (id === '') return []
    return [{
      id,
      workflow: text(row.workflow_name) || 'workflow',
      state: stateOf(row.status),
      message: text(row.user_message),
      startedAt: time(row.started_at),
      endedAt: time(row.completed_at),
    }]
  })
}

/** The node a transcript row is about, from its execution record or its `step`. */
function nodeId(row: Record<string, unknown>): string {
  const execution = isRecord(row.execution) ? row.execution : undefined
  const node = execution !== undefined && isRecord(execution.node) ? execution.node : undefined
  return text(node?.id) || text(row.step) || text(row.node_id)
}

const NODE_EVENTS: Readonly<Record<string, State>> = {
  node_start: 'running',
  node_complete: 'completed',
  node_failed: 'failed',
  node_error: 'failed',
  node_skipped: 'cancelled',
}

/**
 * Folds the JSONL transcript of `archon workflow logs` to the nodes it ran, in
 * the order they started: a node_start row opens a node as running, and a
 * later node_complete or node_failed row closes it. Other rows, and lines that
 * are not JSON, are skipped.
 */
export function parseNodes(transcript: string): RunNode[] {
  const nodes = new Map<string, State>()
  for (const line of transcript.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(row)) continue
    const state = NODE_EVENTS[text(row.type)]
    const id = nodeId(row)
    if (state !== undefined && id !== '') nodes.set(id, state)
  }
  return [...nodes].map(([id, state]) => ({ id, state }))
}

export function glyph(state: State): string {
  switch (state) {
    case 'running': return '●'
    case 'paused': return '⏸'
    case 'completed': return '✓'
    case 'failed': return '✗'
    case 'cancelled': return '⊘'
    case 'pending': return '○'
    case 'other': return '?'
  }
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** How long a run took, or has been going when it has not ended. */
export function runTime(run: Run, now: number): string {
  return run.startedAt === 0 ? '' : duration((run.endedAt === 0 ? now : run.endedAt) - run.startedAt)
}

export function fit(value: string, room: number): string {
  return value.length <= room ? value : `${value.slice(0, Math.max(0, room - 1))}…`
}

export function ago(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds} s ago`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`
}

/** The runs that are still going, which the pane keeps fresh. */
export function isLive(run: Run): boolean {
  return run.state === 'running' || run.state === 'paused'
}
