import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { attention, parseRun } from '../hooks/runs'
import type { Detail, Run } from '../types'
import { approval, attention as attentionWait, iso, MINUTE, onChild, row, T0, WORKTREE } from './fixtures/runs'
import type { Row } from './fixtures/runs'
import { fake, IN_FRONT, paneProps, world } from './fixtures/world'

const START = { cwd: 'D:/repos/widgets', surface: 'terminal', isInteractive: true } as const
const parse = (r: Row) => parseRun(r) as Run
const index = (rows: Row[]) => new Map(rows.map(r => [r.id, parse(r)]))
const NO_DETAIL: Detail = { events: [], files: [], transcriptPath: '', isWorkingPathThere: true }

test('a paused run is sorted the way Archon\'s runAttention sorts it, plus the stranded check', () => {
  const cases: [string, Row[], string][] = [
    ['approval', [row('r', { status: 'paused', metadata: { approval: approval() } })], 'approval'],
    ['interactive loop gate', [row('r', { status: 'paused', metadata: { approval: approval({ type: 'interactive_loop' }) } })], 'approval'],
    ['action needed', [row('r', { status: 'paused', metadata: { wait: attentionWait() } })], 'action'],
    ['time wait', [row('r', { status: 'paused', metadata: { wait: { kind: 'time', nodeId: 'w', until: iso(T0 + 30 * MINUTE) } } })], 'waiting'],
    ['event wait', [row('r', { status: 'paused', metadata: { wait: { kind: 'event', nodeId: 'w', event: 'ci.done' } } })], 'waiting'],
    ['unreadable gate', [row('r', { status: 'paused', metadata: {} })], 'unreadable'],
    ['blocked on a live sub-run', [row('r', { status: 'paused', metadata: { approval: onChild('c') } }), row('c', { parent_run_id: 'r' })], 'blocked'],
    ['stranded by a cancelled sub-run', [row('r', { status: 'paused', metadata: { approval: onChild('c') } }), row('c', { parent_run_id: 'r', status: 'cancelled' })], 'stranded'],
    ['stranded by a failed sub-run', [row('r', { status: 'paused', metadata: { approval: onChild('c') } }), row('c', { parent_run_id: 'r', status: 'failed' })], 'stranded'],
    ['stranded by a completed sub-run', [row('r', { status: 'paused', metadata: { approval: onChild('c') } }), row('c', { parent_run_id: 'r', status: 'completed' })], 'stranded'],
    ['running', [row('r')], 'none'],
  ]
  for (const [, rows, kind] of cases) expect(attention(parse(rows[0]!), index(rows), undefined).kind).toBe(kind)
})

test('an answered gate waiting to resume does not need you', () => {
  const run = parse(row('r', { status: 'paused', metadata: { approval: approval() } }))
  const answered: Detail = { ...NO_DETAIL, events: [
    { type: 'approval_requested', step: 'review-gate', at: T0, output: '', error: '', iteration: 0, decision: '', text: '', reason: '', durationMs: 0, costUsd: 0 },
    { type: 'approval_received', step: 'review-gate', at: T0 + MINUTE, output: '', error: '', iteration: 0, decision: 'approve', text: '', reason: '', durationMs: 0, costUsd: 0 },
  ] }
  expect(attention(run, index([]), answered).kind).toBe('resuming')
})

async function runsPane($: Engine, on: On, rows: Row[], over: Parameters<typeof world>[0] = {}) {
  const clock = mock.clock(on, { now: T0 + 20 * MINUTE })
  mock.store(on)
  const w = world({ rows, panes: IN_FRONT(), ...over })
  fake(on, w)
  await $.session.start(START)
  await clock.settle()
  const pane = await $.ui.mount({ plugin: 'archon-panel', surface: 'terminal', component: 'Pane', requestId: 'archon', props: paneProps(80) })
  return { clock, w, pane }
}

/** Each run row as it reads: glyph, then the row's button. */
const labels = async (pane: { findAll: (q: { type: 'Box' }) => Promise<{ text: string; key: string | undefined }[]> }) =>
  (await pane.findAll({ type: 'Box' })).filter(b => b.key?.startsWith('run-')).map(b => b.text.trim())

test('Runs puts runs that need you first, the longest waiting at the top, then the rest by latest activity', async ($, on) => {
  const { pane } = await runsPane($, on, [
    row('quiet', { workflow_name: 'archon-quiet', last_activity_at: iso(T0 + MINUTE) }),
    row('busy', { workflow_name: 'archon-busy', last_activity_at: iso(T0 + 3 * MINUTE) }),
    row('gate-new', { workflow_name: 'archon-gate-new', status: 'paused', metadata: { approval: approval({ waitingSince: iso(T0 + 10 * MINUTE) }) } }),
    row('gate-old', { workflow_name: 'archon-gate-old', status: 'paused', metadata: { wait: { ...attentionWait(), waitingSince: iso(T0 + 4 * MINUTE) } } }),
    // A sub-run's activity counts for its parent.
    row('quiet-child', { workflow_name: 'archon-child', parent_run_id: 'quiet', last_activity_at: iso(T0 + 5 * MINUTE) }),
  ])
  const order = (await labels(pane)).map(text => /archon-[a-z-]+/.exec(text)?.[0])
  expect(order).toEqual(['archon-gate-old', 'archon-gate-new', 'archon-quiet', 'archon-child', 'archon-busy'])
  await pane.unmount()
})

test('each row reads glyph, workflow, status word and time, with a dim detail line', async ($, on) => {
  const { pane } = await runsPane($, on, [
    row('a', { workflow_name: 'archon-approve', status: 'paused', metadata: { approval: approval() } }),
    row('b', { workflow_name: 'archon-act', status: 'paused', metadata: { wait: attentionWait('Push the tag\nthen resume') } }),
    row('c', { workflow_name: 'archon-odd', status: 'paused', metadata: {} }),
    row('d', { workflow_name: 'archon-later', status: 'paused', metadata: { wait: { kind: 'event', nodeId: 'w', event: 'ci.done' } } }),
    row('e', { workflow_name: 'archon-run', started_at: iso(T0 + 17 * MINUTE) }),
    row('f', { workflow_name: 'archon-done', status: 'completed', started_at: iso(T0), completed_at: iso(T0 + 12 * MINUTE) }),
    row('g', { workflow_name: 'archon-broke', status: 'failed', started_at: iso(T0), completed_at: iso(T0 + 42_000) }),
    row('h', { workflow_name: 'archon-stop', status: 'cancelled', started_at: iso(T0), completed_at: iso(T0 + MINUTE) }),
    row('i', { workflow_name: 'archon-wait', status: 'pending', started_at: iso(T0 + 19 * MINUTE) }),
  ])
  const shown = await labels(pane)
  expect(shown).toContain('⏸ archon-approve  needs your approval  20m')
  expect(shown).toContain('! archon-act  action needed  20m')
  expect(shown).toContain('? archon-odd  gate Archon can\'t read  20m')
  expect(shown).toContain('◷ archon-later  waits for ci.done  20m')
  expect(shown).toContain('● archon-run  running  3m')
  expect(shown).toContain('✓ archon-done  completed  12m')
  expect(shown).toContain('✗ archon-broke  failed  42s')
  expect(shown).toContain('✗ archon-stop  cancelled  1m')
  expect(shown).toContain('○ archon-wait  pending  1m')
  expect(await pane.find({ type: 'Text', text: '  Push the tag' })).toBeDefined()
  expect((await pane.findAll({ type: 'Text', text: '  Plan the widget with care' })).some(t => t.props.dimColor === true)).toBe(true)
  expect((await pane.find({ type: 'Text', text: '⏸' }))?.props.color).toBe('warning')
  await pane.unmount()
})

test('a stranded parent reads stuck, with its sub-run\'s ending beside it', async ($, on) => {
  const { pane } = await runsPane($, on, [
    row('p', { workflow_name: 'archon-ship', status: 'paused', metadata: { approval: onChild('c') } }),
    row('c', { workflow_name: 'archon-fix', parent_run_id: 'p', status: 'failed', completed_at: iso(T0 + 5 * MINUTE) }),
  ])
  expect(await labels(pane)).toContain('! archon-ship  stuck: sub-run ended  20m')
  expect(await pane.find({ type: 'Text', text: /failed/ })).toBeDefined()
  await pane.unmount()
})

test('a parent waiting on a sub-run is dim, or reads approval in sub-run and sorts first when the sub-run is on one', async ($, on) => {
  const { pane } = await runsPane($, on, [
    row('busy', { workflow_name: 'archon-busy', last_activity_at: iso(T0 + 19 * MINUTE) }),
    row('p', { workflow_name: 'archon-ship', status: 'paused', metadata: { approval: onChild('c') } }),
    row('c', { workflow_name: 'archon-fix', parent_run_id: 'p', status: 'paused', metadata: { approval: approval() } }),
    row('p2', { workflow_name: 'archon-deliver', status: 'paused', metadata: { approval: onChild('c2') } }),
    row('c2', { workflow_name: 'archon-review', parent_run_id: 'p2' }),
  ])
  const shown = await labels(pane)
  expect(shown[0]).toBe('⏸ archon-ship  approval in sub-run  20m')
  expect(shown).toContain('⏸ archon-deliver  waiting on a sub-run  20m')
  await pane.unmount()
})

test('one sub-run is one indented line; a fan-out folds to its counts and opens and folds on a pick', async ($, on) => {
  const kids = Array.from({ length: 5 }, (_, i) => row(`k${i}`, {
    workflow_name: 'archon-item',
    parent_run_id: 'fan',
    status: i < 2 ? 'running' : i === 2 ? 'failed' : 'completed',
    completed_at: i < 2 ? null : iso(T0 + MINUTE),
  }))
  const { pane } = await runsPane($, on, [
    row('one', { workflow_name: 'archon-solo' }),
    row('solo-child', { workflow_name: 'my-sub-workflow', parent_run_id: 'one', started_at: iso(T0 + 17 * MINUTE) }),
    row('fan', { workflow_name: 'archon-fan' }),
    ...kids,
  ])
  expect(await labels(pane)).toContain('↳ my-sub-workflow  running  3m')
  const folded = '↳ 5 sub-runs · 2 running · 1 failed · 2 done'
  expect(await labels(pane)).toContain(folded)
  expect((await labels(pane)).filter(text => text.includes('archon-item'))).toEqual([])
  await pane.press({ key: 'fanout-fan' })
  expect((await labels(pane)).filter(text => text.includes('archon-item')).length).toBe(5)
  await pane.press({ key: 'fanout-fan' })
  expect((await labels(pane)).filter(text => text.includes('archon-item'))).toEqual([])
  await pane.unmount()
})

test('an ended parent\'s sub-runs fold the same way', async ($, on) => {
  const { pane } = await runsPane($, on, [
    row('p', { workflow_name: 'archon-ship', status: 'completed', completed_at: iso(T0 + 9 * MINUTE) }),
    row('c', { workflow_name: 'archon-fix', parent_run_id: 'p', status: 'completed', completed_at: iso(T0 + 8 * MINUTE) }),
  ])
  expect(await labels(pane)).toContain('↳ 1 sub-run · 1 done')
  await pane.unmount()
})

test('in a linked worktree its runs are pinned first under the branch, the rest under the project line, each pinned one marked here', async ($, on) => {
  const { pane } = await runsPane($, on, [
    row('mine', { workflow_name: 'archon-newer', last_activity_at: iso(T0 + 9 * MINUTE) }),
    row('here-old', { workflow_name: 'archon-here-old', working_path: WORKTREE, status: 'completed', started_at: iso(T0), completed_at: iso(T0 + MINUTE) }),
    row('here-new', { workflow_name: 'archon-here-new', working_path: WORKTREE.replace(/\//g, '\\'), started_at: iso(T0 + 2 * MINUTE) }),
  ], { cwd: WORKTREE, git: { common: 'D:/repos/widgets/.git', top: WORKTREE, branch: 'fix/thing' } })
  const shown = await labels(pane)
  expect(shown.map(text => /archon-[a-z-]+/.exec(text)?.[0])).toEqual(['archon-here-new', 'archon-here-old', 'archon-newer'])
  const texts = (await pane.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts.indexOf('fix/thing')).toBeGreaterThan(-1)
  expect(texts.indexOf('─ project ─')).toBeGreaterThan(texts.indexOf('fix/thing'))
  expect(texts.filter(t => t.startsWith('  here · ')).length).toBe(2)
  await pane.unmount()
})

test('a session in the primary checkout pins nothing', async ($, on) => {
  const { pane } = await runsPane($, on, [row('a', { working_path: 'D:/repos/widgets' })])
  const texts = (await pane.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts.includes('─ project ─')).toBe(false)
  expect(texts.some(t => t.startsWith('  here · '))).toBe(false)
  await pane.unmount()
})

test('adoption lines name the other run, or its short id alone when it is not listed', async ($, on) => {
  const { pane } = await runsPane($, on, [
    row('1a2b3c4d5e', { workflow_name: 'archon-plan', status: 'completed', completed_at: iso(T0 + MINUTE) }),
    row('9f8e7d6c5b', { workflow_name: 'archon-deliver', adopted_from_run_id: '1a2b3c4d5e' }),
    row('0a0b0c0d0e', { workflow_name: 'archon-review', adopted_from_run_id: 'ffffeeee99' }),
  ])
  const texts = (await pane.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts.some(t => t.includes('continues archon-plan 1a2b3c4'))).toBe(true)
  expect(texts.some(t => t.includes('continued by archon-deliver 9f8e7d6'))).toBe(true)
  expect(texts.some(t => t.includes('continues ffffeee'))).toBe(true)
  await pane.unmount()
})

test('a project with no runs says so', async ($, on) => {
  const { pane } = await runsPane($, on, [])
  expect(await pane.find({ type: 'Text', text: 'No workflow runs here yet.' })).toBeDefined()
  await pane.unmount()
})

