import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { approval, iso, MINUTE, onChild, row, T0 } from './fixtures/runs'
import type { Row } from './fixtures/runs'
import { fake, IN_FRONT, paneProps, world } from './fixtures/world'
import type { World } from './fixtures/world'

const START = { cwd: 'D:/repos/widgets', surface: 'terminal', isInteractive: true } as const

async function open($: Engine, on: On, rows: Row[], width = 80, bodyRows = 40, over: Partial<World> = {}) {
  const clock = mock.clock(on, { now: T0 + 20 * MINUTE })
  mock.store(on)
  const w = world({ rows, panes: IN_FRONT(), ...over })
  fake(on, w)
  await $.session.start(START)
  await clock.settle()
  const pane = await $.ui.mount({ plugin: 'archon-panel', surface: 'terminal', component: 'Pane', requestId: 'archon', props: paneProps(width, bodyRows) })
  return { clock, w, pane }
}

const tabs = async (pane: { findAll: (q: { type: 'Button' }) => Promise<{ text: string; key: string | undefined; props: Record<string, unknown> }[]> }) =>
  (await pane.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('tab-')).map(b => `${String(b.props.hotkey)}: ${b.text}`)

test('the pinned row names the four sub-tabs, Runs carrying the live count and the needs-you count', async ($, on) => {
  const { pane } = await open($, on, [
    row('a'),
    row('b', { status: 'paused', metadata: { approval: approval() } }),
    // A parent and its sub-run count as one live run; the sub-run on an approval makes the parent need you once.
    row('p', { status: 'paused', metadata: { approval: onChild('c') } }),
    row('c', { parent_run_id: 'p', status: 'paused', metadata: { approval: approval() } }),
    row('d', { status: 'completed', completed_at: iso(T0 + MINUTE) }),
  ])
  expect(await tabs(pane)).toEqual(['1: Runs 3 ⏸2', '2: Graph', '3: Log', "4: Archon's log"])
  await pane.unmount()
})

test('with nothing needing you the ⏸ count is left out', async ($, on) => {
  const { pane } = await open($, on, [row('a')])
  expect(await tabs(pane)).toEqual(['1: Runs 1', '2: Graph', '3: Log', "4: Archon's log"])
  await pane.unmount()
})

test('below about 40 columns the labels shorten', async ($, on) => {
  const { pane } = await open($, on, [row('a')], 36)
  expect(await tabs(pane)).toEqual(['1: Runs 1', '2: Graph', '3: Log', '4: Arch'])
  await pane.unmount()
})

test('the settings gear is drawn only while /mod-settings is listed, and runs it', async ($, on) => {
  const { pane, w } = await open($, on, [row('a')])
  expect(await pane.find({ key: 'mod-settings' })).toBeUndefined()
  w.commands = ['mod-settings']
  await pane.redraw()
  const gear = await pane.find({ key: 'mod-settings' })
  expect(gear?.text).toBe('⚙️')
  await pane.press({ key: 'mod-settings' })
  expect(w.ran).toEqual(['/mod-settings'])
  await pane.unmount()
})

test('the digits switch sub-tabs, and r reloads at once', async ($, on) => {
  const { pane, w } = await open($, on, [row('a')])
  await pane.press({ key: 'tab-archon-log' })
  expect(await pane.find({ type: 'Text', text: /serve\.log/ })).toBeDefined()
  await pane.press({ key: 'tab-runs' })
  expect(await pane.find({ type: 'Button', text: /archon-plan/ })).toBeDefined()
  const before = w.fetches.length
  await pane.press({ key: 'reload' })
  expect(w.fetches.length).toBeGreaterThan(before)
  await pane.unmount()
})

const many = Array.from({ length: 30 }, (_, i) => row(`r${String(i).padStart(2, '0')}`, {
  workflow_name: `wf-${String(i).padStart(2, '0')}`,
  status: 'completed',
  user_message: '',
  completed_at: iso(T0 + i * 1000),
  last_activity_at: iso(T0 + i * 1000),
}))

const scrollBy = ($: Engine, by: number) =>
  $.ui.scroll({ component: 'Pane', requestId: 'archon', offset: Math.max(0, by), by, bodyRows: 10, contentRows: 10, origin: { kind: 'person' } } as never)

test('the pane scrolls for itself: the engine\'s window stays at 0, the body moves under the pinned row, with a more line in its height', async ($, on) => {
  const { pane, w } = await open($, on, many, 80, 10)
  const names = async () => (await pane.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('pick-')).map(b => /wf-\d+/.exec(b.text)?.[0])
  // Newest first: wf-29 at the top; 10 rows are the pinned row, 8 runs and the more line.
  expect(await names()).toEqual(['wf-29', 'wf-28', 'wf-27', 'wf-26', 'wf-25', 'wf-24', 'wf-23', 'wf-22'])
  expect(await pane.find({ type: 'Text', text: '… 22 more' })).toBeDefined()
  expect(await tabs(pane)).toHaveLength(4)

  await scrollBy($, 3)
  expect(w.scrolls).toEqual([0])
  expect((await names())[0]).toBe('wf-26')
  expect(await tabs(pane)).toHaveLength(4)
  await scrollBy($, -10)
  expect((await names())[0]).toBe('wf-29')
  await pane.unmount()
})

test('each sub-tab keeps its own position', async ($, on) => {
  const { pane } = await open($, on, many, 80, 10)
  const first = async () => (await pane.findAll({ type: 'Button' })).find(b => b.key?.startsWith('pick-'))?.text ?? ''
  await scrollBy($, 5)
  expect(await first()).toMatch(/wf-24/)
  await pane.press({ key: 'tab-graph' })
  await scrollBy($, 2)
  await pane.press({ key: 'tab-runs' })
  expect(await first()).toMatch(/wf-24/)
  await pane.unmount()
})
