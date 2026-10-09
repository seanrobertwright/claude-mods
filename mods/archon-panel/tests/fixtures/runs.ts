// Hand-built Archon v0.11.1 run rows, shaped by docs/research/archon-api.md
// and archon-run-data.md: the rows `GET /api/dashboard/runs` and
// `archon workflow runs --json --all --limit 50` both list.

/** The primary checkout of the project the tests' session sits in, and a linked worktree of it. */
export const PRIMARY = 'D:/repos/widgets'
export const WORKTREE = 'C:/home/.archon/workspaces/octo/widgets/worktrees/fix/thing'
export const OUTPUT_ROOT = 'C:/home/.archon/workspaces/octo/widgets'
export const OTHER = 'D:/repos/gadgets'

/** The project's codebase as the server lists it, registered with backslashes. */
export const CODEBASES = [
  { id: 'cb-widgets', name: 'octo/widgets', repository_url: 'https://github.com/octo/widgets', default_cwd: 'D:\\repos\\widgets' },
  { id: 'cb-gadgets', name: 'octo/gadgets', repository_url: 'https://github.com/octo/gadgets', default_cwd: 'D:\\repos\\gadgets' },
]

export const T0 = Date.parse('2026-10-09T14:00:00.000Z')
export const iso = (ms: number) => new Date(ms).toISOString()
export const MINUTE = 60_000

export type Row = Record<string, unknown> & { id: string; status: string; metadata: Record<string, unknown> }

/** A run row of this project, running, started at T0, overridden by `over` (metadata merged). */
export function row(id: string, over: Partial<Record<string, unknown>> & { metadata?: Record<string, unknown> } = {}): Row {
  const { metadata, ...rest } = over
  return {
    id,
    workflow_name: 'archon-plan',
    status: 'running',
    outcome: null,
    user_message: 'Plan the widget\nwith care',
    started_at: iso(T0),
    completed_at: null,
    last_activity_at: iso(T0 + MINUTE),
    codebase_id: 'cb-widgets',
    codebase_name: 'octo/widgets',
    working_path: 'D:\\repos\\widgets',
    output_root: OUTPUT_ROOT,
    parent_run_id: null,
    parent_conversation_id: null,
    adopted_from_run_id: null,
    active_nodes: [],
    ...rest,
    metadata: {
      workflow_source: { origin: 'D:/repos/widgets', root: `${OUTPUT_ROOT}/workflow-source/runs/${id}` },
      total_cost_usd: 0,
      ...metadata,
    },
  }
}

/** A run of another project. */
export function otherRow(id: string, over: Partial<Record<string, unknown>> & { metadata?: Record<string, unknown> } = {}): Row {
  return row(id, {
    codebase_id: 'cb-gadgets',
    codebase_name: 'octo/gadgets',
    working_path: 'D:\\repos\\gadgets',
    output_root: 'C:/home/.archon/workspaces/octo/gadgets',
    ...over,
    metadata: { workflow_source: { origin: 'D:/repos/gadgets', root: 'C:/home/.archon/workspaces/octo/gadgets/workflow-source/runs/x' }, ...over.metadata },
  })
}

/** An approval gate's `metadata.approval`, as an approval node writes it. */
export function approval(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { nodeId: 'review-gate', message: 'Review the plan\nbefore it ships', type: 'approval', waitingSince: iso(T0 + 2 * MINUTE), ...over }
}

/** An action-needed wait's `metadata.wait`. */
export function attention(message = 'Push the release tag, then resume.'): Record<string, unknown> {
  return { owner: 'dag', nodeId: 'tag', kind: 'attention', waitingSince: iso(T0 + 2 * MINUTE), message }
}

/** A paused parent's gate on its sub-run. */
export function onChild(childRunId: string, nodeId = 'fix'): Record<string, unknown> {
  return { nodeId, type: 'child_workflow', childRunId, waitingSince: iso(T0 + 2 * MINUTE) }
}

/** The list body both sources give, `counts` included. */
export function listBody(rows: readonly Row[]): string {
  const count = (status: string) => rows.filter(r => r.status === status).length
  return JSON.stringify({
    runs: rows,
    total: rows.length,
    counts: { all: rows.length, running: count('running'), completed: count('completed'), failed: count('failed'), cancelled: count('cancelled'), pending: count('pending'), paused: count('paused') },
    scopeFallback: true,
  })
}

/** One event row of `GET /api/workflows/runs/{id}`. */
export function event(type: string, step: string, data: Record<string, unknown> = {}, at = T0): Record<string, unknown> {
  return { id: `${type}-${step}-${at}`, workflow_run_id: 'x', event_type: type, step_name: step, step_index: 0, data, created_at: iso(at), event_order: 0 }
}
