// What reaches the person outside the pane: the status line, and toasts when
// this project's runs need you, fail or finish, one per event across sessions.

import type { Detail, Run } from '../types'
import { hasEnded, needsYou, subRunsOf, topRuns, waitNode } from './runs'
import type { NeedsYou } from './runs'
import { duration, firstLine } from './text'

/** The status line's length, about; parts are dropped to fit it. */
const STATUS_ROOM = 60

/** How a run is named outside the pane: its workflow, and the start of its id when another run here has the same workflow. */
export function nameOf(run: Run, runs: readonly Run[]): string {
  const isShared = topRuns(runs).some(other => other.id !== run.id && other.workflow === run.workflow)
  return isShared ? `${run.workflow} ${run.id.slice(0, 6)}` : run.workflow
}

function needing(runs: readonly Run[], details: Readonly<Record<string, Detail>>): { run: Run; need: NeedsYou }[] {
  return topRuns(runs).flatMap(run => {
    const need = needsYou(run, runs, details)
    return need === undefined ? [] : [{ run, need }]
  })
}

/**
 * The status line: `Archon`, then what needs you, what runs here, and what
 * needs you elsewhere, each left out at zero; undefined with none of them.
 * Cut to about 60 characters by dropping elsewhere, then running, then
 * naming no run. A parent and its sub-runs count as one.
 */
export function statusText(runs: readonly Run[], details: Readonly<Record<string, Detail>>, elsewhere: number): string | undefined {
  const needs = needing(runs, details)
  const needIds = new Set(needs.map(entry => entry.run.id))
  const running = topRuns(runs).filter(run => !needIds.has(run.id) && isFamilyLive(run, runs)).length
  if (needs.length === 0 && running === 0 && elsewhere === 0) return undefined
  if (needs.length === 0 && running === 0) return `Archon · ⏸ ${elsewhere} elsewhere`

  const first = needs[0]
  const counted = needs.length === 1 ? '⏸ 1 needs you' : `⏸ ${needs.length} need you`
  const named = first === undefined || needs.length > 1
    ? counted
    : `⏸ ${nameOf(first.run, runs)} ${first.need.standing.kind === 'approval' ? 'needs approval' : 'needs you'}`
  const parts = (need: string, isRunning: boolean, isElsewhere: boolean) =>
    ['Archon', ...(needs.length > 0 ? [need] : []), ...(isRunning && running > 0 ? [`${running} running`] : []), ...(isElsewhere && elsewhere > 0 ? [`⏸ ${elsewhere} elsewhere`] : [])].join(' · ')
  for (const text of [parts(named, true, true), parts(named, true, false), parts(named, false, false)]) {
    if (Array.from(text).length <= STATUS_ROOM) return text
  }
  return parts(counted, false, false)
}

function isFamilyLive(run: Run, runs: readonly Run[], depth = 0): boolean {
  if (!hasEnded(run)) return true
  return depth < 10 && subRunsOf(run, runs).some(subRun => isFamilyLive(subRun, runs, depth + 1))
}

export type ToastEvent = {
  runId: string
  event: 'needs-you' | 'failed' | 'completed'
  /** Which gate a needs-you toast was for, so a later gate on the same run toasts again. */
  gate: string
  text: string
  timeoutMs: number
}

const STAYS = { 'needs-you': 15_000, 'failed': 8_000, 'completed': 4_000 } as const

/** What a run that needs you is waiting on, as its toast says it. */
function needText(run: Run, need: NeedsYou, runs: readonly Run[]): string {
  const name = nameOf(run, runs)
  const found = need.standing
  if (found.kind === 'approval') {
    const inSub = need.holder.id === run.id ? '' : ` (in sub-run ${need.holder.workflow})`
    return `⏸ ${name} needs approval: ${firstLine(found.gate.message)}${inSub}`
  }
  if (found.kind === 'action') return `⏸ ${name} needs you: ${firstLine(found.wait.message)}`
  if (found.kind === 'stranded') {
    const subRun = found.subRun
    const ending = subRun === undefined ? 'ended' : subRun.status === 'completed' ? 'done' : subRun.status
    return `⏸ ${name} needs you: sub-run ${subRun?.workflow ?? 'sub-run'} was ${ending}`
  }
  return `⏸ ${name} needs you`
}

/**
 * The toast-worthy events among this project's runs as they stand: each run
 * on an approval, action needed or stranded (an unreadable gate is counted but
 * never toasts), and each failure and finish after `since`. Sub-runs never
 * toast for themselves: a sub-run's approval is raised for its parent.
 */
export function toastEvents(runs: readonly Run[], details: Readonly<Record<string, Detail>>, since: number): ToastEvent[] {
  const events: ToastEvent[] = []
  for (const { run, need } of needing(runs, details)) {
    if (need.standing.kind === 'unreadable') continue
    const gate = `${need.holder.id}:${need.standing.kind}:${waitNode(need.standing)}:${need.standing.since}`
    events.push({ runId: run.id, event: 'needs-you', gate, text: needText(run, need, runs), timeoutMs: STAYS['needs-you'] })
  }
  for (const run of topRuns(runs)) {
    if (run.completedAt <= since) continue
    if (run.status === 'failed') {
      const failed = [...(details[run.id]?.events ?? [])].reverse().find(e => e.type === 'node_failed' || (e.type === 'workflow_failed' && e.error !== ''))
      const node = failed?.type === 'node_failed' ? failed.step : ''
      const error = firstLine(failed?.error ?? '')
      const text = `✗ ${nameOf(run, runs)} failed${node === '' ? '' : ` at ${node}`}${error === '' ? '' : `: ${error}`}`
      events.push({ runId: run.id, event: 'failed', gate: '', text, timeoutMs: STAYS.failed })
    } else if (run.status === 'completed') {
      const subFailed = subRunsOf(run, runs).filter(subRun => subRun.status === 'failed').length
      const tail = subFailed === 0 ? '' : `, ${subFailed} sub-run${subFailed === 1 ? '' : 's'} failed`
      events.push({ runId: run.id, event: 'completed', gate: '', text: `✓ ${nameOf(run, runs)} finished in ${duration(run.completedAt - run.startedAt)}${tail}`, timeoutMs: STAYS.completed })
    }
  }
  return events
}

/** One toast for the events of one poll: the one event's own, or the counts in order, staying the longest part's time. */
export function collapse(events: readonly ToastEvent[]): { text: string; timeoutMs: number } | undefined {
  if (events.length === 0) return undefined
  if (events.length === 1) return { text: events[0]!.text, timeoutMs: events[0]!.timeoutMs }
  const count = (event: ToastEvent['event']) => events.filter(e => e.event === event).length
  const needs = count('needs-you')
  const parts = [
    needs > 0 ? `⏸ ${needs} ${needs === 1 ? 'needs' : 'need'} you` : '',
    count('failed') > 0 ? `✗ ${count('failed')} failed` : '',
    count('completed') > 0 ? `✓ ${count('completed')} finished` : '',
  ].filter(part => part !== '')
  return { text: parts.join(' · '), timeoutMs: Math.max(...events.map(e => e.timeoutMs)) }
}

/** The store key of a toast claim. */
export function claimKey(event: ToastEvent): string {
  return `toasted/${event.runId}/${event.event}`
}

/** Whether a claim already in the store covers this event: the same gate for a needs-you, any claim for a failure or finish. */
export function isClaimed(event: ToastEvent, value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (event.event !== 'needs-you') return true
  return typeof value === 'object' && (value as { gate?: unknown }).gate === event.gate
}

/** Whether a claim read back is this session's. */
export function isMine(value: unknown, session: string): boolean {
  if (typeof value === 'string') return value === session
  return typeof value === 'object' && value !== null && (value as { session?: unknown }).session === session
}
