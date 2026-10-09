import { expect, mock, test } from 'claude-code/testing'

import { row } from './fixtures/runs'
import { archonCalls, COLD, fake, HOME_ARCHON, IN_FRONT, OLD_VERSION, paneProps, world } from './fixtures/world'

const NEEDS_CLI = 'The Archon pane needs the Archon CLI, v0.11.0 or later. Install it from https://archon.diy, or set its path in the mod settings, then press r.'
const NEEDS_NEWER = 'The Archon pane needs Archon v0.11.0 or later; this is v0.10.1. Update it, then press r.'
const START = { cwd: 'D:/repos/widgets', surface: 'terminal', isInteractive: true } as const

const WHERE = [
  { at: 'setting', options: { archonPath: ' D:\\tools\\archon.exe ' }, settingPath: 'D:\\tools\\archon.exe', runs: 'D:\\tools\\archon.exe' },
  { at: 'path', options: {}, settingPath: '', runs: 'archon' },
  { at: 'home', options: {}, settingPath: '', runs: HOME_ARCHON },
] as const

for (const where of WHERE) {
  test(`the CLI found by ${where.at} is the one every call runs`, { ...COLD, options: where.options }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    mock.store(on)
    const w = world({ archonAt: where.at, settingPath: where.settingPath, server: 'down', rows: [row('run-1')] })
    fake(on, w)

    await $.session.start(START)
    await clock.settle()
    const calls = w.argv.filter(argv => argv[0] !== 'git')
    expect(calls.some(argv => argv[1] === '--version')).toBe(true)
    const listed = calls.find(argv => argv[1] === 'workflow' && argv[2] === 'runs')
    expect(listed?.[0]?.replace(/\\/g, '/')).toBe(where.runs.replace(/\\/g, '/'))
  })
}

for (const { why, version, archonAt, says } of [
  { why: 'missing', version: '', archonAt: 'none', says: NEEDS_CLI },
  { why: 'older than v0.11.0', version: OLD_VERSION, archonAt: 'home', says: NEEDS_NEWER },
] as const) {
  test(`with the CLI ${why} the pane shows only the Requirement line, and nothing polls, toasts or goes on the status line`, COLD, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    mock.store(on)
    const w = world({ archonAt, ...(version === '' ? {} : { version }), rows: [row('run-1', { status: 'paused', metadata: { approval: { nodeId: 'g', type: 'approval', message: 'ok?' } } })] })
    fake(on, w)

    await $.session.start(START)
    await clock.settle()
    const pane = await $.ui.mount({ plugin: 'archon-panel', surface: 'terminal', component: 'Pane', requestId: 'archon', props: paneProps() })
    expect((await pane.find({ type: 'Text', text: says }))?.text).toBe(says)
    expect(await pane.find({ type: 'Text', text: /archon-plan|No workflow runs/ })).toBeUndefined()

    const before = w.argv.length + w.fetches.length
    await clock.advance(10 * 60_000)
    expect(w.argv.length + w.fetches.length).toBe(before)
    expect(w.fetches).toEqual([])
    expect(w.toasts).toEqual([])
    expect(w.status.filter(text => text !== undefined)).toEqual([])
    expect(w.opened).toEqual([])
    await pane.unmount()
  })
}

test('once the CLI is installed, r checks it again and polling starts', COLD, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  mock.store(on)
  const w = world({ archonAt: 'none', server: 'down', rows: [row('run-1')], panes: IN_FRONT() })
  fake(on, w)

  await $.session.start(START)
  await clock.settle()
  const pane = await $.ui.mount({ plugin: 'archon-panel', surface: 'terminal', component: 'Pane', requestId: 'archon', props: paneProps() })
  expect(await pane.find({ type: 'Text', text: NEEDS_CLI })).toBeDefined()

  w.archonAt = 'home'
  await pane.press({ key: 'reload' })
  await clock.settle()
  expect(await pane.find({ type: 'Text', text: NEEDS_CLI })).toBeUndefined()
  expect(await pane.find({ type: 'Button', text: /archon-plan/ })).toBeDefined()
  const lists = () => archonCalls(w).filter(call => call.startsWith('workflow runs')).length
  const first = lists()
  await clock.advance(10_000)
  expect(lists()).toBeGreaterThan(first)
  await pane.unmount()
})
