import { expect, mock, test } from 'claude-code/testing'

import { MINUTE, row, T0 } from './fixtures/runs'
import { fake, HOME_ARCHON, IN_FRONT, PHONE, TERMINAL, world } from './fixtures/world'
import type { World } from './fixtures/world'

const START = { cwd: 'D:/repos/widgets', surface: 'terminal', isInteractive: true } as const
const HEADLESS = { cwd: 'D:/repos/widgets', surface: null, isInteractive: false } as const
const lists = (w: World) => w.fetches.filter(f => f.url.startsWith('http://localhost:3090/api/dashboard/runs?limit=')).length
const checks = (w: World) => w.argv.filter(argv => argv[0] === HOME_ARCHON && argv[1] === '--version').length

test('a headless session polls, follows and checks nothing, and opens nothing', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  const w = world({ surfaces: [], rows: [row('mine-1')] })
  fake(on, w)
  await $.session.start(HEADLESS)
  await clock.advance(10 * MINUTE)
  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't', reason: 'answer' } as never)
  await clock.advance(10 * MINUTE)
  expect(w.argv).toEqual([])
  expect(w.fetches).toEqual([])
  expect(w.spawned).toEqual([])
  expect(w.opened).toEqual([])
  expect(w.toasts).toEqual([])
})

test('the first attach to a headless session checks the CLI, loads, and opens the pane where it docks with a live run', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  const w = world({ surfaces: [], rows: [row('mine-1')] })
  fake(on, w)
  await $.session.start(HEADLESS)
  await clock.settle()
  w.surfaces.push('terminal')
  await $.session.attach(TERMINAL)
  await clock.settle()
  expect(checks(w)).toBe(1)
  expect(lists(w)).toBe(1)
  expect(w.opened).toEqual(['archon'])
})

test('a phone attaching first loads but waits for /archon to open the pane', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  const w = world({ surfaces: [], rows: [row('mine-1')] })
  fake(on, w)
  await $.session.start(HEADLESS)
  w.surfaces.push('mobile')
  await $.session.attach(PHONE)
  await clock.settle()
  expect(lists(w)).toBe(1)
  expect(w.opened).toEqual([])
  await $.command.run({ command: 'archon', args: '', origin: { kind: 'bridge' }, presentation: { isFullscreen: false, columns: 40 } })
  expect(w.opened).toEqual(['archon+focus'])
})

test('at start the pane opens unasked, without the keys, with a live run here', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  const w = world({ rows: [row('mine-1')] })
  fake(on, w)
  await $.session.start(START)
  await clock.settle()
  expect(w.opened).toEqual(['archon'])
})

test('with nothing live here the pane stays closed at start', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  const w = world({ rows: [row('mine-1', { status: 'completed', completed_at: new Date(T0).toISOString() })] })
  fake(on, w)
  await $.session.start(START)
  await clock.settle()
  expect(w.opened).toEqual([])
})

test('/archon opens the pane in front with the keys, never asking for columns, and loads at once', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  const w = world({ rows: [row('mine-1', { status: 'completed' })] })
  fake(on, w)
  await $.session.start(START)
  await clock.settle()
  const before = lists(w)
  await $.command.run({ command: 'archon', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  await clock.settle()
  expect(w.opened).toEqual(['archon+focus'])
  expect(lists(w)).toBe(before + 1)
})

test('the last detach stops polling, and the next attach loads at once and starts it again', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  const w = world({ rows: [row('mine-1')], panes: IN_FRONT() })
  fake(on, w)
  await $.session.start(START)
  await clock.settle()
  await clock.advance(2_000)
  expect(lists(w)).toBe(2)

  w.surfaces.length = 0
  await $.session.detach({ ...PHONE, reason: 'detach' })
  await clock.advance(10 * MINUTE)
  expect(lists(w)).toBe(2)

  w.surfaces.push('mobile')
  await $.session.attach(PHONE)
  await clock.settle()
  expect(lists(w)).toBe(3)
  await clock.advance(2_000)
  expect(lists(w)).toBe(4)
})

test('a main-thread turn reloads when the runs are more than 10 s old; a subagent\'s turn never does', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  const w = world({ rows: [row('mine-1')] })
  fake(on, w)
  await $.session.start(START)
  await clock.settle()
  w.panes = []
  const turn = { answer: 'done', durationMs: 10, isAborted: false, turnId: 't', reason: 'answer' } as const
  await clock.advance(5_000)
  await $.turn.complete(turn as never)
  await clock.settle()
  expect(lists(w)).toBe(1)
  await clock.advance(6_000)
  await $.turn.complete({ ...turn, agentId: 'agent-1' } as never)
  await clock.settle()
  expect(lists(w)).toBe(1)
  await $.turn.complete(turn as never)
  await clock.settle()
  expect(lists(w)).toBe(2)
})

test('a reload drops the load in flight and loads again from session.start', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  const w = world({ rows: [row('mine-1')], panes: IN_FRONT() })
  fake(on, w)
  await $.session.start(START)
  await clock.settle()
  // The next list hangs; a reload (session.start again) comes while it does.
  w.server = 'hang'
  await clock.advance(2_000)
  w.server = 'up'
  w.rows = [row('mine-1', { workflow_name: 'archon-review' })]
  await $.session.start(START)
  await clock.settle()
  w.release()
  await clock.advance(2_000)
  expect(lists(w)).toBeGreaterThan(2)
})

test('an attach compares against the statuses kept from before the gap, so what changed meanwhile surfaces', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  const w = world({ rows: [row('mine-1', { workflow_name: 'archon-plan', started_at: new Date(T0).toISOString() })] })
  fake(on, w)
  await $.session.start(START)
  await clock.settle()
  w.surfaces.length = 0
  await $.session.detach({ ...PHONE, reason: 'detach' })
  await clock.advance(5 * MINUTE)
  w.rows = [row('mine-1', { workflow_name: 'archon-plan', status: 'completed', started_at: new Date(T0).toISOString(), completed_at: new Date(T0 + 4 * MINUTE).toISOString() })]
  w.surfaces.push('mobile')
  await $.session.attach(PHONE)
  await clock.settle()
  await clock.advance(1_000)
  expect(w.toasts).toEqual([{ text: '✓ archon-plan finished in 4m', timeoutMs: 4_000 }])
})
