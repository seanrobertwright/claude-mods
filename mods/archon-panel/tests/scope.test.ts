import { expect, mock, test } from 'claude-code/testing'

import { parseRun } from '../hooks/runs'
import { normalize, projectFromCodebases, projectFromRows } from '../hooks/scope'
import type { Run } from '../types'
import { otherRow, row } from './fixtures/runs'
import { COLD, fake, IN_FRONT, paneProps, world } from './fixtures/world'

const START = { cwd: 'D:/repos/widgets', surface: 'terminal', isInteractive: true } as const

test('paths normalize the same way on both sides', () => {
  const table: [string, 'windows' | 'mac' | 'linux', string][] = [
    ['D:\\repos\\widgets\\', 'windows', 'd:/repos/widgets'],
    ['D:/repos//widgets', 'windows', 'd:/repos/widgets'],
    ['d:\\Repos\\Widgets', 'windows', 'd:/repos/widgets'],
    ['D:\\', 'windows', 'd:/'],
    ['D:/', 'windows', 'd:/'],
    ['D:/repos/widgets/./docs/../', 'windows', 'd:/repos/widgets'],
    ['/Users/Ann/Widgets/', 'mac', '/users/ann/widgets'],
    ['/home/Ann/Widgets/', 'linux', '/home/Ann/Widgets'],
    ['/home/ann/a/../b', 'linux', '/home/ann/b'],
    ['/', 'linux', '/'],
  ]
  for (const [path, platform, normal] of table) expect(normalize(path, platform)).toBe(normal)
})

const CB = (id: string, cwd: string) => ({ id, name: id, default_cwd: cwd })

test('the server path: the ids registered at the primary checkout, else the deepest that holds it, else none', () => {
  const codebases = [CB('a', 'D:\\repos'), CB('b', 'D:\\repos\\widgets'), CB('c', 'D:/repos/widgets/'), CB('d', 'D:\\repos\\gadgets')]
  expect(projectFromCodebases(codebases, 'D:/repos/widgets', 'windows')).toEqual(['b', 'c'])
  expect(projectFromCodebases(codebases, 'D:/repos/widgets/packages/ui', 'windows')).toEqual(['b', 'c'])
  expect(projectFromCodebases([CB('a', 'D:\\repos'), CB('d', 'D:\\repos\\gadgets')], 'D:/repos/widgets', 'windows')).toEqual(['a'])
  expect(projectFromCodebases([CB('d', 'D:\\repos\\gadgets')], 'D:/repos/widgets', 'windows')).toEqual([])
  expect(projectFromCodebases([CB('w', '/home/ann/Widgets')], '/home/ann/widgets', 'linux')).toEqual([])
})

const run = (over: Parameters<typeof row>[1], id = 'r') => parseRun(row(id, over)) as Run

test('the CLI path: a row names the project by its origin or its working path, never by its output root', () => {
  const byOrigin = run({ codebase_id: 'cb-1', working_path: 'X:/elsewhere', metadata: { workflow_source: { origin: 'D:\\repos\\widgets\\' } } })
  const byWorkingPath = run({ codebase_id: 'cb-2', working_path: 'C:/wt/fix', metadata: { workflow_source: { origin: 'X:/elsewhere' } } })
  const byPrimaryPath = run({ codebase_id: 'cb-3', working_path: 'd:/repos/widgets', metadata: { workflow_source: { origin: 'X:/elsewhere' } } })
  const byOutputRootOnly = run({ codebase_id: 'cb-4', working_path: 'X:/a', output_root: 'D:/repos/widgets', metadata: { workflow_source: { origin: 'X:/b' } } })
  expect(projectFromRows([byOrigin, byWorkingPath, byPrimaryPath, byOutputRootOnly], 'D:/repos/widgets', 'C:/wt/fix', 'windows')).toEqual(['cb-1', 'cb-2', 'cb-3'])
  expect(projectFromRows([byOutputRootOnly], 'D:/repos/widgets', 'D:/repos/widgets', 'windows')).toEqual([])
})

test('Runs lists only this project, and counts other projects\' live runs once per parent', COLD, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  mock.store(on)
  const w = world({
    rows: [
      row('mine-1', { workflow_name: 'archon-plan' }),
      otherRow('theirs-1', { workflow_name: 'archon-review' }),
      otherRow('theirs-child', { workflow_name: 'archon-fix', parent_run_id: 'theirs-1' }),
      otherRow('theirs-2', { workflow_name: 'archon-assist', status: 'pending' }),
      otherRow('theirs-done', { workflow_name: 'archon-assist', status: 'completed', completed_at: '2026-10-09T14:05:00.000Z' }),
    ],
  })
  fake(on, w)
  for (const server of ['up', 'down'] as const) {
    w.server = server
    await $.session.start(START)
    await clock.settle()
    const pane = await $.ui.mount({ plugin: 'archon-panel', surface: 'terminal', component: 'Pane', requestId: 'archon', props: paneProps() })
    expect(await pane.find({ type: 'Text', text: '+2 live in other projects' })).toBeDefined()
    expect((await pane.findAll({ type: 'Button', text: /archon-plan/ })).length).toBe(1)
    expect(await pane.find({ type: 'Button', text: /archon-review|archon-fix|archon-assist/ })).toBeUndefined()
    await pane.unmount()
  }
})

test('a folder in no project shows the no-project line above the count, and no rows', COLD, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  mock.store(on)
  const w = world({ codebases: [CB('cb-gadgets', 'D:\\repos\\gadgets')], rows: [otherRow('theirs-1')] })
  fake(on, w)
  await $.session.start(START)
  await clock.settle()
  const pane = await $.ui.mount({ plugin: 'archon-panel', surface: 'terminal', component: 'Pane', requestId: 'archon', props: paneProps() })
  const lines = (await pane.findAll({ type: 'Text' })).map(found => found.text)
  const at = lines.indexOf("This folder isn't in an Archon project")
  expect(at).toBeGreaterThan(-1)
  expect(lines.indexOf('+1 live in other projects')).toBeGreaterThan(at)
  expect(await pane.find({ type: 'Button', text: /archon-plan/ })).toBeUndefined()
  await pane.unmount()
})

test('with the server down, an empty project set is tried again every tick, and a found one is kept until r', COLD, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  mock.store(on)
  const stray = row('stray', { codebase_id: 'cb-x', working_path: 'X:/a', metadata: { workflow_source: { origin: 'X:/a' } } })
  const w = world({ server: 'down', rows: [stray], panes: IN_FRONT() })
  fake(on, w)
  await $.session.start(START)
  await clock.settle()
  const pane = await $.ui.mount({ plugin: 'archon-panel', surface: 'terminal', component: 'Pane', requestId: 'archon', props: paneProps() })
  expect(await pane.find({ type: 'Text', text: "This folder isn't in an Archon project" })).toBeDefined()

  // A run started here names the project; the next tick finds it.
  w.rows = [stray, row('mine-1')]
  await clock.advance(30_000)
  expect(await pane.find({ type: 'Button', text: /archon-plan/ })).toBeDefined()

  // The set is kept: a later row of the same codebase that names no folder of ours still belongs.
  w.rows = [row('mine-2', { workflow_name: 'archon-review', working_path: 'X:/elsewhere', metadata: { workflow_source: { origin: 'X:/elsewhere' } } })]
  await clock.advance(30_000)
  expect(await pane.find({ type: 'Button', text: /archon-review/ })).toBeDefined()
  await pane.unmount()
})
