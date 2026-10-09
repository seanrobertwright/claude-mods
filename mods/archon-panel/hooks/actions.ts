// Acting on a run that needs you: answering an approval, and resuming or
// abandoning a run on action needed or left paused by a sub-run that ended.
// Nothing else is ever done to a run. Each action goes where the run lives
// (ADR-0006).

import type { Detail, Gate, Pending, Run } from '../types'
import { clockTime, firstLine } from './text'

/** Letters an answer never takes: reload, all nodes, back, open, abandon, and approve's and reject's own. */
const RESERVED = new Set(['r', 'a', 'b', 'o', 'x', 'y', 'n'])

export type AnswerButton = {
  decision: string
  letter: string
  label: string
  isPrimary: boolean
}

/**
 * One button per decision the gate declares, in the workflow's order and
 * words: approve is `y`, reject is `n`, any other the first free letter of
 * its label. The labels carry their consequences: what a reject cancels, and
 * what a bare approve does at a loop gate whose round said it is done.
 */
export function answerButtons(gate: Gate, run: Run, parent: Run | undefined, text: string): AnswerButton[] {
  const used = new Set<string>()
  const letterOf = (id: string, label: string) => {
    if (id === 'approve') return 'y'
    if (id === 'reject') return 'n'
    const free = Array.from(label.toLowerCase()).find(ch => /[a-z]/.test(ch) && !RESERVED.has(ch) && !used.has(ch))
    return free ?? ''
  }
  return gate.decisions.map(decision => {
    const letter = letterOf(decision.id, decision.label)
    used.add(letter)
    let label = decision.label
    if (decision.id === 'reject') {
      if (parent !== undefined) label = `${label} (cancels this sub-run; ${parent.workflow} stays paused)`
      else if (!gate.hasRework) label = `${label} (cancels the run)`
    }
    if (decision.id === 'approve' && gate.type === 'interactive_loop' && gate.isRoundDone) label = text.trim() === '' ? 'Approve and finish' : 'Another round'
    return { decision: decision.id, letter, label: letter === '' ? label : `${letter}: ${label}`, isPrimary: decision.id === 'approve' }
  })
}

/** Where an action goes: the CLI, the server, or nowhere (a chat run's resume). */
export type Route =
  | { via: 'cli'; argv: string[] }
  | { via: 'server'; path: string; body: string }
  | { via: 'none' }

/** A chat platform's name as the pane says it: `Slack`, `Telegram`, `GitHub`. */
export function platformName(platform: string): string {
  return platform === 'github' ? 'GitHub' : platform === '' ? '' : `${platform[0]!.toUpperCase()}${platform.slice(1)}`
}

/**
 * Routes an action where the run lives (ADR-0006). A CLI-started run (no
 * parent conversation) always goes through the CLI, answers and resumes
 * `--detach`. A run from the web UI or a chat goes through the server while it
 * answers, else the same CLI call. A chat run is never resumed from the pane,
 * and abandon, with nothing to route back, goes through the CLI for it.
 */
export function route(pending: Pending, run: Run, text: string, isServer: boolean, archon: string): Route {
  const viaServer = run.hasConversation && isServer
  const id = run.id
  if (pending.kind === 'answer') {
    if (viaServer) {
      if (pending.decision === 'approve') return { via: 'server', path: `/api/workflows/runs/${id}/approve`, body: JSON.stringify(text === '' ? {} : { comment: text }) }
      if (pending.decision === 'reject') return { via: 'server', path: `/api/workflows/runs/${id}/reject`, body: JSON.stringify(text === '' ? {} : { reason: text }) }
      return { via: 'server', path: `/api/workflows/runs/${id}/respond`, body: JSON.stringify(text === '' ? { decision: pending.decision } : { decision: pending.decision, text }) }
    }
    const verb = pending.decision === 'approve' || pending.decision === 'reject' ? [pending.decision, id] : ['respond', id, pending.decision]
    return { via: 'cli', argv: [archon, 'workflow', ...verb, ...(text === '' ? [] : [text]), '--detach', '--json'] }
  }
  if (pending.kind === 'resume') {
    if (run.platform !== '') return { via: 'none' }
    if (viaServer) return { via: 'server', path: `/api/workflows/runs/${id}/resume`, body: '' }
    return { via: 'cli', argv: [archon, 'workflow', 'resume', id, '--detach', '--json'] }
  }
  if (viaServer && run.platform === '') return { via: 'server', path: `/api/workflows/runs/${id}/abandon`, body: '' }
  return { via: 'cli', argv: [archon, 'workflow', 'abandon', id, '--json'] }
}

/** How a sub-run ended, as a stranded parent's view says it. */
export function strandHead(subRun: Run | undefined): string {
  const name = subRun?.workflow ?? 'sub-run'
  if (subRun?.status === 'cancelled') return `! Sub-run ${name} was cancelled${subRun.completedAt > 0 ? ` (rejected ${clockTime(subRun.completedAt)})` : ''}`
  if (subRun?.status === 'failed') return `! Sub-run ${name} failed`
  return `! Sub-run ${name} finished`
}

/** The resume button of a stranded parent, by how its sub-run ended. */
export function strandResume(subRun: Run | undefined): string {
  const name = subRun?.workflow ?? 'the sub-run'
  if (subRun?.status === 'cancelled') return 'r  Resume without it'
  if (subRun?.status === 'failed') return `r  Resume: run ${name} again, once`
  return `r  Resume: go on with ${name}'s output`
}

/** The confirming line of a stranded parent's resume. */
export function strandConfirm(node: string, subRun: Run | undefined): string {
  const name = subRun?.workflow ?? 'the sub-run'
  if (subRun?.status === 'cancelled') return `Resume: node ${node} fails ("Sub-run '${name}' was cancelled") and the run goes on by its rules, which usually fail it.`
  if (subRun?.status === 'failed') return `Resume: node ${node} runs ${name} again, once.`
  return `Resume: node ${node} goes on with ${name}'s output.`
}

export const ABANDON_LINE = "Abandon: ends this run and anything it started. It can't be resumed."
export const SERVER_DOWN_NOTE = "The server isn't answering, so the rest of this run won't show in its chat."

/** What an answer that landed looks like: `✓ Approved 14:32 · "…"`, `✗ Rejected …`, other decisions by label. */
export function recordLine(decision: string, label: string, text: string, at: number): string {
  const said = text === '' ? '' : ` · "${text}"`
  if (decision === 'reject') return `✗ Rejected ${clockTime(at)}${said}`
  if (decision === 'approve') return `✓ Approved ${clockTime(at)}${said}`
  return `✓ ${label.replace(/^[a-z]: /, '')} ${clockTime(at)}${said}`
}

/** The last answer the run's events record: the decision, when and the text. */
export function lastAnswer(detail: Detail | undefined): { decision: string; at: number; text: string } | undefined {
  const received = [...(detail?.events ?? [])].reverse().find(e => e.type === 'approval_received')
  return received === undefined ? undefined : { decision: received.decision || 'approve', at: received.at, text: received.text }
}

/** Archon's own words from a CLI reply or a REST body: `{ok:false, error}`, `{error}`, `{message}`, else the last line; a refusal's `childRunId` names the sub-run to answer instead. */
export function archonMessage(text: string): { ok: boolean | undefined; message: string; subRunId: string; logPath: string } {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const message = typeof parsed.error === 'string' ? parsed.error : typeof parsed.message === 'string' ? parsed.message : ''
    return {
      ok: typeof parsed.ok === 'boolean' ? parsed.ok : typeof parsed.success === 'boolean' ? parsed.success : undefined,
      message,
      subRunId: typeof parsed.childRunId === 'string' ? parsed.childRunId : '',
      logPath: typeof parsed.logPath === 'string' ? parsed.logPath : '',
    }
  } catch {
    return { ok: undefined, message: firstLine(text.split(/\r?\n/).reverse().join('\n')), subRunId: '', logPath: '' }
  }
}
