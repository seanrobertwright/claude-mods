// Reading Archon's run rows at the boundary, and what state each run is in.

import type { Decision, Detail, Gate, Run, Status, Wait } from '../types'
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
    subRunId: text(value.childRunId) || text(value.child_run_id),
    hasRework: value.onReject !== undefined || value.on_reject !== undefined,
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

/**
 * Why a run stands where it does, mirroring Archon's `runAttention`
 * (`packages/workflows/src/schemas/workflow-run.ts` at v0.11.1) from
 * `metadata.approval` and `metadata.wait`, plus the mod's own check of a
 * `child_workflow` gate's sub-run, which Archon never reads.
 */
export type Standing =
  | { kind: 'none' }
  | { kind: 'approval'; gate: Gate; since: number }
  | { kind: 'action'; wait: Wait; since: number }
  | { kind: 'stranded'; gate: Gate; subRun: Run | undefined; since: number }
  | { kind: 'unreadable'; since: number }
  | { kind: 'blocked'; gate: Gate; subRun: Run | undefined }
  | { kind: 'waiting'; wait: Wait }
  | { kind: 'resuming'; gate: Gate }

/** Whether a gate was answered: an `approval_received` after the last `approval_requested`. */
function isAnswered(detail: Detail | undefined): boolean {
  const events = detail?.events ?? []
  const asked = events.map(e => e.type).lastIndexOf('approval_requested')
  const answered = events.map(e => e.type).lastIndexOf('approval_received')
  return answered > asked && answered >= 0
}

/** Where a run stands, its sub-run looked up among `runs`. */
export function standing(run: Run, runs: readonly Run[], detail: Detail | undefined): Standing {
  if (run.status !== 'paused') return { kind: 'none' }
  const since = run.approval?.since || run.wait?.since || run.lastActivityAt
  if (run.wait !== null) {
    return run.wait.kind === 'attention' ? { kind: 'action', wait: run.wait, since } : { kind: 'waiting', wait: run.wait }
  }
  const gate = run.approval
  if (gate === null) return { kind: 'unreadable', since }
  if (gate.type === 'child_workflow') {
    const subRun = runs.find(other => other.id === gate.subRunId)
    return subRun !== undefined && hasEnded(subRun) ? { kind: 'stranded', gate, subRun, since } : { kind: 'blocked', gate, subRun }
  }
  if (!gate.isReadable) return { kind: 'unreadable', since }
  return isAnswered(detail) ? { kind: 'resuming', gate } : { kind: 'approval', gate, since }
}

/** The node a run waits at: an approval's or a stranded parent's gate, or an action-needed wait; '' for any other standing. */
export function waitNode(found: Standing): string {
  if (found.kind === 'approval' || found.kind === 'stranded') return found.gate.nodeId
  if (found.kind === 'action') return found.wait.nodeId
  return ''
}

/** What a run that needs you is waiting on: the run that holds it (the parent, or the deepest sub-run on a gate) and why. */
export type NeedsYou = {
  holder: Run
  standing: Extract<Standing, { since: number }>
}

/**
 * Whether a run needs you, following a parent blocked on a live sub-run down
 * the chain to the deepest run on a gate. Waits, answered gates and a sub-run
 * still working do not.
 */
export function needsYou(run: Run, runs: readonly Run[], details: Readonly<Record<string, Detail>>): NeedsYou | undefined {
  let at = run
  for (let depth = 0; depth < 10; depth++) {
    const found = standing(at, runs, details[at.id])
    if (found.kind === 'approval' || found.kind === 'action' || found.kind === 'stranded' || found.kind === 'unreadable') return { holder: at, standing: found }
    if (found.kind !== 'blocked' || found.subRun === undefined) return undefined
    at = found.subRun
  }
  return undefined
}

/** The sub-runs of a run among the rows, oldest first. */
export function subRunsOf(run: Run, runs: readonly Run[]): Run[] {
  return runs.filter(other => other.parentId === run.id).sort((a, b) => a.startedAt - b.startedAt)
}

/** The latest activity of a run or any run below it. */
export function latestActivity(run: Run, runs: readonly Run[], depth = 0): number {
  if (depth > 10) return run.lastActivityAt
  return Math.max(run.lastActivityAt, ...subRunsOf(run, runs).map(subRun => latestActivity(subRun, runs, depth + 1)))
}

/** The rows the Runs sub-tab lists: runs that are not sub-runs of a listed run. */
export function topRuns(runs: readonly Run[]): Run[] {
  const ids = new Set(runs.map(run => run.id))
  return runs.filter(run => run.parentId === '' || !ids.has(run.parentId))
}

/** Needs-you runs first, the one that has needed you longest at the top; then the rest by latest activity. */
export function sortRuns(runs: readonly Run[], all: readonly Run[], details: Readonly<Record<string, Detail>>): Run[] {
  const keyed = runs.map(run => ({ run, need: needsYou(run, all, details), latest: latestActivity(run, all) }))
  keyed.sort((a, b) => {
    if (a.need !== undefined && b.need !== undefined) return a.need.standing.since - b.need.standing.since
    if (a.need !== undefined) return -1
    if (b.need !== undefined) return 1
    return b.latest - a.latest
  })
  return keyed.map(entry => entry.run)
}

/** How many of a run family need you: a parent and its sub-runs count once. */
export function needsYouCount(runs: readonly Run[], details: Readonly<Record<string, Detail>>): number {
  return topRuns(runs).filter(run => needsYou(run, runs, details) !== undefined).length
}
