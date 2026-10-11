import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { approval, event, iso, MINUTE, OUTPUT_ROOT, row, T0 } from './fixtures/runs'
import type { Row } from './fixtures/runs'
import { DELIVER, SHIP } from './fixtures/workflows'
import { COLD, end, fake, feed, IN_FRONT, paneProps, send, world } from './fixtures/world'
import { line } from './fixtures/transcripts'
import type { World } from './fixtures/world'

const START = { cwd: 'D:/repos/widgets', surface: 'terminal', isInteractive: true } as const
const ROOT = `${OUTPUT_ROOT}/workflow-source/runs/ship-1`

/** The run's frozen source on disk: the manifest, its workflow and the one it includes, and a stale project copy of another. */
const SOURCE = {
  [`${ROOT}/manifest.json`]: JSON.stringify({ workflow_name: 'archon-ship', scopes: ['bundled'], digest: 'x', file_count: 3, byte_count: 1 }),
  [`${ROOT}/bundled/workflows/archon-ship.yaml`]: SHIP,
  [`${ROOT}/bundled/workflows/archon-deliver.yaml`]: DELIVER,
  [`${ROOT}/bundled/commands/plan.md`]: '# plan',
}

const at = (minutes: number) => T0 + minutes * MINUTE
const SHIP_EVENTS = [
  event('node_started', 'plan', {}, at(1)),
  event('node_completed', 'plan', { node_output: 'planned' }, at(2)),
  event('node_started', 'deliver__implement', {}, at(2)),
  event('node_completed', 'deliver__implement', {}, at(3)),
  event('node_started', 'deliver__fix-1', {}, at(3)),
  event('node_completed', 'deliver__fix-1', {}, at(4)),
  event('node_started', 'fix-cycle.fix', { iteration: 1 }, at(4)),
  event('node_completed', 'fix-cycle.fix', { iteration: 1 }, at(5)),
  event('node_started', 'fix-cycle.recheck', { iteration: 1 }, at(5)),
  event('node_failed', 'fix-cycle.recheck', { iteration: 1, error: 'not ready' }, at(6)),
  event('node_started', 'fix-cycle.fix', { iteration: 2 }, at(6)),
]

async function graph($: Engine, on: On, rows: Row[], over: Partial<World> = {}, surface: 'terminal' | 'mobile' = 'terminal', pick = 'ship-1') {
  const clock = mock.clock(on, { now: at(20) })
  mock.store(on)
  const w = world({ rows, panes: IN_FRONT(), disk: { ...SOURCE }, events: { 'ship-1': SHIP_EVENTS }, ...over })
  fake(on, w)
  await $.session.start(START)
  await clock.settle()
  const pane = await $.ui.mount({ plugin: 'archon-panel', surface, component: 'Pane', requestId: 'archon', props: paneProps(120, 60) })
  await pane.press({ key: `pick-${pick}` })
  await clock.settle()
  return { clock, w, pane }
}

const SHIP_ROW = row('ship-1', { workflow_name: 'archon-ship', started_at: iso(at(0)), last_activity_at: iso(at(6)) })
const CHILD_ROW = row('child-1', { workflow_name: 'archon-fix', parent_run_id: 'ship-1', started_at: iso(at(10)), metadata: { parent_node_id: 'child' } })

const shown = async (pane: { findAll: (q: { type: 'Box' }) => Promise<{ text: string }[]> }) => (await pane.findAll({ type: 'Box' })).map(box => box.text).join('\n')

test('picking a run that does not need you opens its Graph, read from its frozen source', COLD, async ($, on) => {
  const { pane } = await graph($, on, [SHIP_ROW, CHILD_ROW])
  expect((await pane.find({ key: 'tab-graph' }))?.props.dimColor).toBe(false)
  const all = await shown(pane)
  expect(all).toContain('archon-ship  running  20m')
  expect(all).toContain('✓ plan')
  expect(all).toContain('✓ deliver 2/2')
  expect(all).toContain('● fix-cycle ⟳2')
  expect(all).toContain('○ review-gate')
  expect(all).toContain('● ↳ archon-fix')
  await pane.unmount()
})

test('an include block folds to one box, expands in place when picked, and folds from its header', COLD, async ($, on) => {
  const { pane } = await graph($, on, [SHIP_ROW])
  await pane.press({ key: 'node-block:deliver' })
  let all = await shown(pane)
  expect(all).toContain('✓ deliver__implement')
  expect(all).toContain('✓ deliver__fix-1')
  expect(all).not.toContain('deliver 2/2')
  await pane.press({ key: 'fold-deliver' })
  all = await shown(pane)
  expect(all).toContain('deliver 2/2')
  await pane.unmount()
})

test('a loop group shows its current round when picked, and steps back through earlier ones', COLD, async ($, on) => {
  const { pane } = await graph($, on, [SHIP_ROW])
  await pane.press({ key: 'node-fix-cycle' })
  let all = await shown(pane)
  expect(all).toContain('round 2 · ‹ ›')
  expect(all).toContain('● fix')
  expect(all).toContain('○ recheck')
  await pane.press({ key: 'round-back' })
  all = await shown(pane)
  expect(all).toContain('round 1 · ‹ ›')
  expect(all).toContain('✓ fix')
  expect(all).toContain('✗ recheck')
  await pane.press({ key: 'round-on' })
  expect(await shown(pane)).toContain('round 2 · ‹ ›')
  await pane.unmount()
})

test('a workflow node opens its sub-run\'s Graph, which leads back to its parent', COLD, async ($, on) => {
  const { pane } = await graph($, on, [SHIP_ROW, CHILD_ROW], {
    disk: {
      ...SOURCE,
      [`${OUTPUT_ROOT}/workflow-source/runs/child-1/manifest.json`]: JSON.stringify({ workflow_name: 'archon-fix' }),
      [`${OUTPUT_ROOT}/workflow-source/runs/child-1/bundled/workflows/archon-fix.yaml`]: 'name: archon-fix\nnodes:\n  - id: patch\n    command: patch\n',
    },
  })
  await pane.press({ key: 'node-child' })
  const all = await shown(pane)
  expect(all).toContain('archon-ship › archon-fix')
  expect(all).toContain('patch')
  await pane.press({ key: 'graph-parent' })
  expect(await shown(pane)).toContain('fix-cycle ⟳2')
  await pane.unmount()
})

test('a sub-run on an approval gives its workflow box the warning border, and picking it opens the gate in Log', COLD, async ($, on) => {
  const child = row('child-1', { workflow_name: 'archon-fix', parent_run_id: 'ship-1', status: 'paused', metadata: { parent_node_id: 'child', approval: approval({ nodeId: 'ok' }) } })
  const parent = row('ship-1', { workflow_name: 'archon-ship', status: 'paused', metadata: { approval: { nodeId: 'child', type: 'child_workflow', childRunId: 'child-1' } } })
  const clock = mock.clock(on, { now: at(20) })
  mock.store(on)
  const w = world({ rows: [parent, child], panes: IN_FRONT(), disk: { ...SOURCE }, events: { 'ship-1': SHIP_EVENTS } })
  fake(on, w)
  await $.session.start(START)
  await clock.settle()
  const pane = await $.ui.mount({ plugin: 'archon-panel', surface: 'terminal', component: 'Pane', requestId: 'archon', props: paneProps(120, 60) })
  // A needs-you run opens Log on its sub-run's gate; the Graph shows that sub-run, which leads back to its parent.
  await pane.press({ key: 'pick-ship-1' })
  await pane.press({ key: 'tab-graph' })
  await clock.settle()
  await pane.press({ key: 'graph-parent' })
  await clock.settle()
  // Heavy borders are the gate's, in warning, and the running nodes', in success.
  const heavy = (await pane.findAll({ type: 'Text' })).filter(t => t.text.includes('┏')).map(t => t.props.color)
  expect(heavy).toContain('warning')
  expect(heavy.filter(color => color !== 'warning' && color !== 'success')).toEqual([])
  await pane.press({ key: 'node-child' })
  expect((await pane.find({ key: 'tab-log' }))?.props.dimColor).toBe(false)
  await pane.unmount()
})

test('picking a node opens Log cut to that node', COLD, async ($, on) => {
  const { pane } = await graph($, on, [SHIP_ROW])
  await pane.press({ key: 'node-plan' })
  expect((await pane.find({ key: 'tab-log' }))?.props.dimColor).toBe(false)
  await pane.unmount()
})

test('↗ Archon links the run\'s page while the server answers, never from the CLI or on the phone', COLD, async ($, on) => {
  const { pane } = await graph($, on, [SHIP_ROW])
  expect((await pane.find({ type: 'Link' }))?.props.href).toBe('http://localhost:3090/console/r/ship-1')
  await pane.unmount()
})

test('no ↗ Archon link while the CLI answers', COLD, async ($, on) => {
  const { pane } = await graph($, on, [SHIP_ROW], { server: 'down' })
  expect(await pane.find({ type: 'Link' })).toBeUndefined()
  await pane.unmount()
})

test('no ↗ Archon link on the phone, where localhost is the phone', COLD, async ($, on) => {
  const { pane } = await graph($, on, [SHIP_ROW], {}, 'mobile')
  expect(await pane.find({ type: 'Link' })).toBeUndefined()
  await pane.unmount()
})

/** A run of an installed pack's entry point: Archon names it `owner/pack:entry`, and the pack maps the entry to a file whose own name differs. */
const PACK_ROOT = `${OUTPUT_ROOT}/workflow-source/runs/pack-1`
const PACK_DIR = `${PACK_ROOT}/installed/acme.kit`
const PACK_SOURCE = (entry: string) => ({
  [`${PACK_ROOT}/manifest.json`]: JSON.stringify({ workflow_name: 'acme/kit:build', scopes: ['installed', 'bundled'] }),
  [`${PACK_DIR}/archon-plugin.json`]: JSON.stringify({ schemaVersion: 1, kind: 'workflow-pack', name: 'kit', entrypoints: { build: entry } }),
  [`${PACK_DIR}/build/kit-build.yaml`]: 'name: kit-build\nnodes:\n  - id: compile\n    script: compile\n  - id: review\n    include: kit-review\n    depends_on: [compile]\n',
  [`${PACK_DIR}/review/kit-review.yaml`]: 'name: kit-review\nnodes:\n  - id: read\n    command: read\n  - id: judge\n    command: judge\n    depends_on: [read]\n',
  [`${PACK_ROOT}/bundled/workflows/archon-ship.yaml`]: SHIP,
})
const PACK_ROW = row('pack-1', { workflow_name: 'acme/kit:build', started_at: iso(at(0)), last_activity_at: iso(at(1)) })

test("a pack entry point's Graph is read from the file its pack maps it to, with the pack workflow it includes", COLD, async ($, on) => {
  const { pane } = await graph($, on, [PACK_ROW], { disk: PACK_SOURCE('build/kit-build.yaml') }, 'terminal', 'pack-1')
  const all = await shown(pane)
  expect(all).not.toContain("can't be read")
  expect(all).toContain('compile')
  await pane.press({ key: 'node-block:review' })
  const open = await shown(pane)
  expect(open).toContain('read')
  expect(open).toContain('judge')
  await pane.unmount()
})

test('a pack entry point that leaves its pack folder is not followed', COLD, async ($, on) => {
  const { pane } = await graph($, on, [PACK_ROW], { disk: PACK_SOURCE('../../bundled/workflows/archon-ship.yaml') }, 'terminal', 'pack-1')
  expect(await shown(pane)).toContain("This run's workflow source can't be read.")
  await pane.unmount()
})

test('a live run\'s Graph follows its run log: a node runs the moment its start is written, its box flashing, until its end is', COLD, async ($, on) => {
  const f = feed()
  const { clock, w, pane } = await graph($, on, [SHIP_ROW], { feeds: { 'ship-1': f } })
  expect(w.spawned.map(argv => argv.slice(1).join(' '))).toEqual(['workflow logs ship-1 --follow'])
  expect(await shown(pane)).toContain('○ review-gate')

  // The transcript's times are seconds after T0; the clock reads 20 minutes after it.
  send(f, `${[
    line('node_start', { step: 'review-gate', execution: { path: 'review-gate' } }, 18 * 60),
    line('tool', { tool_name: 'Read', tool_input: { file_path: 'docs/review.md' } }, 19 * 60 + 50),
  ].join('\n')}\n`)
  await clock.settle()
  expect(await shown(pane)).toContain('● review-gate')
  expect(await shown(pane)).toContain('review-gate 2m · Read docs/review.md · 10s ago')

  const running = async () => (await pane.findAll({ type: 'Text' })).filter(t => t.props.color === 'success' && /[┌┏]/.test(t.text))
  const beat = async () => (await running()).map(t => `${t.text[0]}${t.props.bold === true ? 'b' : ''}${t.props.dimColor === true ? 'd' : ''}`)
  const on1 = await beat()
  expect(on1.length).toBeGreaterThan(0)
  expect(new Set(on1)).toEqual(new Set(['┏b']))
  await clock.advance(500)
  expect(new Set(await beat())).toEqual(new Set(['┌d']))
  await clock.advance(500)
  expect(new Set(await beat())).toEqual(new Set(['┏b']))

  send(f, `${line('node_complete', { step: 'review-gate', execution: { path: 'review-gate' } }, 19 * 60 + 55)}\n`)
  await clock.settle()
  expect(await shown(pane)).toContain('✓ review-gate')
  expect(await shown(pane)).not.toContain('Read docs/review.md')

  // Leaving the Graph kills the follower, and the flash stops with it.
  await pane.press({ key: 'tab-runs' })
  await clock.settle()
  expect(w.killed).toHaveLength(1)
  await pane.press({ key: 'tab-graph' })
  await clock.settle()
  expect(w.spawned).toHaveLength(2)
  end(f, 0)
  await pane.unmount()
})

test('a finished run\'s Graph neither follows nor flashes; it reads its events', COLD, async ($, on) => {
  const doneRow = row('ship-1', { workflow_name: 'archon-ship', status: 'completed', started_at: iso(at(0)), completed_at: iso(at(9)) })
  const { clock, w, pane } = await graph($, on, [doneRow])
  expect(w.spawned).toEqual([])
  const before = await shown(pane)
  await clock.advance(1500)
  expect(await shown(pane)).toBe(before)
  await pane.unmount()
})
