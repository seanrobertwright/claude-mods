import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { approval, event, iso, MINUTE, OUTPUT_ROOT, row, T0 } from './fixtures/runs'
import type { Row } from './fixtures/runs'
import { DELIVER, SHIP } from './fixtures/workflows'
import { COLD, fake, IN_FRONT, paneProps, world } from './fixtures/world'
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

async function graph($: Engine, on: On, rows: Row[], over: Partial<World> = {}, surface: 'terminal' | 'mobile' = 'terminal') {
  const clock = mock.clock(on, { now: at(20) })
  mock.store(on)
  const w = world({ rows, panes: IN_FRONT(), disk: { ...SOURCE }, events: { 'ship-1': SHIP_EVENTS }, ...over })
  fake(on, w)
  await $.session.start(START)
  await clock.settle()
  const pane = await $.ui.mount({ plugin: 'archon-panel', surface, component: 'Pane', requestId: 'archon', props: paneProps(120, 60) })
  await pane.press({ key: 'pick-ship-1' })
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
  const border = (await pane.findAll({ type: 'Text' })).find(t => t.text.includes('┏'))
  expect(border?.props.color).toBe('warning')
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
