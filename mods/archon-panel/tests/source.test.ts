import { expect, mock, test } from 'claude-code/testing'

import { approval, event, MINUTE, row, T0 } from './fixtures/runs'
import { archonCalls, fake, IN_FRONT, paneProps, world } from './fixtures/world'
import type { World } from './fixtures/world'

const START = { cwd: 'D:/repos/widgets', surface: 'terminal', isInteractive: true } as const
const SERVER_LINE = "Archon's server isn't answering on port 3090, so runs come from the CLI every 10 s. archon serve makes them faster."

const serverLists = (w: World) => w.fetches.filter(f => f.url.startsWith('http://localhost:3090/api/dashboard/runs?limit=')).length
const cliLists = (w: World) => archonCalls(w).filter(call => call.startsWith('workflow runs --json --all --limit 50')).length

test('with the server answering, runs come from it and the CLI lists nothing', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  const w = world({ rows: [row('mine-1')], panes: IN_FRONT() })
  fake(on, w)
  await $.session.start(START)
  await clock.settle()
  expect(w.fetches.some(f => f.url === 'http://localhost:3090/api/codebases')).toBe(true)
  expect(w.fetches.some(f => f.url === 'http://localhost:3090/api/dashboard/runs?codebaseId=cb-widgets&limit=50')).toBe(true)
  expect(cliLists(w)).toBe(0)
  const pane = await $.ui.mount({ plugin: 'archon-panel', surface: 'terminal', component: 'Pane', requestId: 'archon', props: paneProps() })
  expect(await pane.find({ type: 'Button', text: /archon-plan/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: SERVER_LINE })).toBeUndefined()
  await pane.unmount()
})

for (const server of ['down', 'html'] as const) {
  test(`a server that is ${server === 'down' ? 'refusing' : 'answering HTML'} falls back to the CLI in the same tick, with the dim server line`, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    const w = world({ server, rows: [row('mine-1')], panes: IN_FRONT() })
    fake(on, w)
    await $.session.start(START)
    await clock.settle()
    expect(cliLists(w)).toBe(1)
    const pane = await $.ui.mount({ plugin: 'archon-panel', surface: 'terminal', component: 'Pane', requestId: 'archon', props: paneProps() })
    expect(await pane.find({ type: 'Button', text: /archon-plan/ })).toBeDefined()
    expect((await pane.find({ type: 'Text', text: SERVER_LINE }))?.props.dimColor).toBe(true)
    await pane.unmount()
  })
}

test('a server hanging past 2 s falls back to the CLI in the same tick', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  const w = world({ server: 'hang', rows: [row('mine-1')], panes: IN_FRONT() })
  fake(on, w)
  await $.session.start(START)
  await clock.settle()
  expect(cliLists(w)).toBe(0)
  await clock.advance(1_999)
  expect(cliLists(w)).toBe(0)
  await clock.advance(1)
  expect(cliLists(w)).toBe(1)
  w.release()
})

const TIERS = [
  { what: 'the pane in front, with a live run here', panes: IN_FRONT, rows: [row('mine-1')], server: 2_000, cli: 10_000 },
  { what: 'the pane in front, nothing live', panes: IN_FRONT, rows: [row('mine-1', { status: 'completed', completed_at: '2026-10-09T14:10:00.000Z' })], server: 10_000, cli: 30_000 },
  { what: 'the pane behind another tab or closed', panes: () => [], rows: [row('mine-1')], server: 15_000, cli: 60_000 },
] as const

for (const tier of TIERS) {
  for (const source of ['server', 'cli'] as const) {
    test(`${tier.what}: the ${source} is polled every ${(source === 'server' ? tier.server : tier.cli) / 1000} s`, async ($, on) => {
      const clock = mock.clock(on, { now: T0 })
      mock.store(on)
      const w = world({ server: source === 'server' ? 'up' : 'down', rows: [...tier.rows], panes: tier.panes() })
      fake(on, w)
      const count = source === 'server' ? serverLists : cliLists
      const every = source === 'server' ? tier.server : tier.cli
      await $.session.start(START)
      await clock.settle()
      // An unasked open at start brings the pane up with a live run; this test sets what is in front itself.
      w.panes = tier.panes()
      for (let round = 0; round < 2; round++) {
        const before = count(w)
        await clock.advance(every - 1)
        expect(count(w)).toBe(before)
        await clock.advance(1)
        expect(count(w)).toBe(before + 1)
      }
    })
  }
}

test('a headless session polls nothing, from either source', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  const w = world({ surfaces: [], rows: [row('mine-1')] })
  fake(on, w)
  await $.session.start({ ...START, surface: null, isInteractive: false })
  await clock.advance(10 * MINUTE)
  expect(w.fetches).toEqual([])
  expect(w.argv).toEqual([])
  expect(w.spawned).toEqual([])
})

const details = (w: World, id: string) => w.fetches.filter(f => f.url === `http://localhost:3090/api/workflows/runs/${id}`).length

test('a run\'s detail is fetched only when its row changed since the last tick', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  const w = world({ rows: [row('a'), row('b', { workflow_name: 'archon-review' })], panes: IN_FRONT(), events: { a: [event('node_started', 'plan')] } })
  fake(on, w)
  await $.session.start(START)
  await clock.settle()
  expect(details(w, 'a')).toBe(1)
  expect(details(w, 'b')).toBe(1)
  expect(w.fetches.filter(f => f.url === 'http://localhost:3090/api/runs/a/artifacts').length).toBe(1)

  await clock.advance(2_000)
  expect(details(w, 'a')).toBe(1)
  expect(details(w, 'b')).toBe(1)

  w.rows = [row('a', { status: 'paused', metadata: { approval: approval() } }), row('b', { workflow_name: 'archon-review' })]
  await clock.advance(2_000)
  expect(details(w, 'a')).toBe(2)
  expect(details(w, 'b')).toBe(1)

  w.rows = [row('a', { status: 'paused', metadata: { approval: approval() } }), row('b', { workflow_name: 'archon-review', last_activity_at: new Date(T0 + 5 * MINUTE).toISOString() })]
  await clock.advance(2_000)
  expect(details(w, 'a')).toBe(2)
  expect(details(w, 'b')).toBe(2)
})

test('on the CLI, a changed row\'s detail is read with workflow get, events and all', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  const w = world({ server: 'down', rows: [row('a')], panes: IN_FRONT() })
  fake(on, w)
  await $.session.start(START)
  await clock.settle()
  const calls = archonCalls(w)
  expect(calls).toContain('workflow get a --json --verbose --events')
  expect(calls).toContain('workflow get a --json')
})

test('a sub-run whose parent is not among the rows brings the parent in by id, once while nothing changes', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  const parent = row('parent', { workflow_name: 'archon-ship' })
  const child = row('child', { workflow_name: 'archon-fix', parent_run_id: 'parent' })
  const w = world({ rows: [child], panes: IN_FRONT() })
  fake(on, w)
  // The parent is not listed, but answers by id.
  w.httpReply = (method, path) => (method === 'GET' && path === '/api/workflows/runs/parent' ? { status: 200, body: JSON.stringify({ run: parent, events: [] }) } : undefined)
  await $.session.start(START)
  await clock.settle()
  expect(details(w, 'parent')).toBe(1)
  await clock.advance(2_000)
  await clock.advance(2_000)
  expect(details(w, 'parent')).toBe(1)
  const pane = await $.ui.mount({ plugin: 'archon-panel', surface: 'terminal', component: 'Pane', requestId: 'archon', props: paneProps() })
  expect(await pane.find({ type: 'Button', text: /archon-ship/ })).toBeDefined()
  await pane.unmount()
})
