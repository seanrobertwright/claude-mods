// Reading Archon's run rows at the boundary, and what state each run is in.

import type { Decision, Gate, Run, Status, Wait } from '../types'
import { oneLine } from './text'

const STATUSES: readonly Status[] = ['pending', 'running', 'paused', 'completed', 'failed', 'cancelled']
const CHAT_PLATFORMS = ['slack', 'telegram', 'github', 'discord']

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function time(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isNaN(parsed) ? 0 : parsed
}

function label(id: string): string {
  return id === '' ? id : `${id[0]!.toUpperCase()}${id.slice(1).replace(/[-_]/g, ' ')}`
}

function decisions(value: unknown): Decision[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): Decision[] => {
    if (typeof entry === 'string' && entry !== '') return [{ id: entry, label: label(entry) }]
    if (!isObject(entry)) return []
    const id = text(entry.id) || text(entry.decision) || text(entry.value)
    return id === '' ? [] : [{ id, label: text(entry.label) || label(id) }]
  })
}

function gate(value: unknown): Gate | null {
  if (!isObject(value)) return null
  const nodeId = text(value.nodeId) || text(value.node_id)
  const type = text(value.type)
  const declared = decisions(value.decisions)
  return {
    nodeId,
    message: text(value.message),
    type,
    decisions: declared.length > 0 ? declared : [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }],
    childRunId: text(value.childRunId) || text(value.child_run_id),
    hasRework: value.onReject !== undefined || value.on_reject !== undefined || declared.some(d => d.id === 'reject'),
    isRoundDone: value.roundDone === true || value.isComplete === true || value.complete === true,
    isReadable: nodeId !== '' && type !== '',
    since: time(value.waitingSince ?? value.requestedAt ?? value.since),
  }
}

function wait(value: unknown): Wait | null {
  if (!isObject(value)) return null
  return {
    kind: text(value.kind),
    nodeId: text(value.nodeId) || text(value.node_id),
    message: text(value.message),
    until: text(value.until),
    event: text(value.event),
    since: time(value.waitingSince ?? value.since),
  }
}

/** One run row from either source; undefined when it has no id. Unknown statuses read as `pending`. */
export function parseRun(value: unknown): Run | undefined {
  if (!isObject(value) || text(value.id) === '') return undefined
  const metadata = isObject(value.metadata) ? value.metadata : {}
  const source = isObject(metadata.workflow_source) ? metadata.workflow_source : {}
  const status = STATUSES.find(s => s === value.status) ?? 'pending'
  const platform = [value.platform_type, value.parent_platform_type, metadata.platform_type, metadata.platform]
    .map(text)
    .map(name => name.toLowerCase())
    .find(name => CHAT_PLATFORMS.includes(name)) ?? ''
  return {
    id: text(value.id),
    workflow: text(value.workflow_name) || 'workflow',
    status,
    message: oneLine(text(value.user_message)),
    startedAt: time(value.started_at),
    completedAt: time(value.completed_at),
    lastActivityAt: time(value.last_activity_at) || time(value.started_at),
    codebaseId: text(value.codebase_id),
    workingPath: text(value.working_path),
    outputRoot: text(value.output_root),
    parentId: text(value.parent_run_id),
    parentNodeId: text(metadata.parent_node_id),
    adoptedFromId: text(value.adopted_from_run_id),
    origin: text(source.origin),
    sourceRoot: text(source.root),
    hasConversation: text(value.parent_conversation_id) !== '',
    platform,
    isContainer: metadata.isolation === 'container' || (isObject(metadata.isolation) && metadata.isolation.kind === 'container'),
    approval: status === 'paused' ? gate(metadata.approval) : null,
    wait: status === 'paused' ? wait(metadata.wait) : null,
    costUsd: typeof metadata.total_cost_usd === 'number' ? metadata.total_cost_usd : 0,
  }
}

/** The rows of a runs list, either source's body; throws when it is not one. */
export function parseRuns(body: string): Run[] {
  const parsed: unknown = JSON.parse(body)
  if (!isObject(parsed) || !Array.isArray(parsed.runs)) throw new Error('Archon answered without a runs list')
  return parsed.runs.flatMap(entry => parseRun(entry) ?? [])
}

/** Whether a run has ended: completed, failed or cancelled. */
export function hasEnded(run: Run): boolean {
  return run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled'
}

/** The run at the top of a run's chain of parents, as far as the rows go; a missing parent stands for itself. */
export function rootId(run: Run, byId: ReadonlyMap<string, Run>): string {
  let at = run
  const seen = new Set<string>()
  while (at.parentId !== '' && !seen.has(at.id)) {
    seen.add(at.id)
    const parent = byId.get(at.parentId)
    if (parent === undefined) return at.parentId
    at = parent
  }
  return at.id
}

/** How many live runs: a parent and its sub-runs count as one while any of them has not ended. */
export function liveCount(runs: readonly Run[]): number {
  const byId = new Map(runs.map(run => [run.id, run]))
  return new Set(runs.filter(run => !hasEnded(run)).map(run => rootId(run, byId))).size
}
