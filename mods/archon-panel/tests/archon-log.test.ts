import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { capLines, serveLine } from '../hooks/serve-log'
import { MINUTE, row, T0 } from './fixtures/runs'
import { SERVE_LOG } from './fixtures/serve-log'
import { COLD, fake, IN_FRONT, paneProps, world } from './fixtures/world'
import type { World } from './fixtures/world'

const START = { cwd: 'D:/repos/widgets', surface: 'terminal', isInteractive: true } as const
const SERVE = 'C:/home/.archon/logs/serve.log'

const hhmm = (ms: number) => {
  const at = new Date(ms)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

test('each pino line reads time, level, module and message; a line that is not JSON is drawn as it is', () => {
  expect(serveLine(JSON.stringify({ level: 40, time: T0, module: 'adapter', msg: 'slow' }))).toEqual({ text: `${hhmm(T0)} warn  adapter  slow`, tone: 'warning' })
  expect(serveLine(JSON.stringify({ level: 50, time: T0, module: 'core', msg: 'boom' }))).toEqual({ text: `${hhmm(T0)} error core  boom`, tone: 'error' })
  expect(serveLine(JSON.stringify({ level: 60, time: T0, module: 'core', msg: 'dead' }))).toEqual({ text: `${hhmm(T0)} fatal core  dead`, tone: 'error' })
  expect(serveLine(JSON.stringify({ level: 30, time: T0, module: 'server', msg: 'up' }))).toEqual({ text: `${hhmm(T0)} info  server  up`, tone: undefined })
  expect(serveLine('[slack] socket closed')).toEqual({ text: '[slack] socket closed', tone: undefined })
})

async function archonLog($: Engine, on: On, over: Partial<World> = {}) {
  const clock = mock.clock(on, { now: T0 + 5 * MINUTE })
  mock.store(on)
  const w = world({ rows: [row('a')], panes: IN_FRONT(), ...over })
  fake(on, w)
  await $.session.start(START)
  await clock.settle()
  const pane = await $.ui.mount({ plugin: 'archon-panel', surface: 'terminal', component: 'Pane', requestId: 'archon', props: paneProps(100, 40) })
  return { clock, w, pane }
}

test('4: Archon\'s log shows the whole file, coloured by level, read only while it is in front', COLD, async ($, on) => {
  const { clock, w, pane } = await archonLog($, on, { disk: { [SERVE]: SERVE_LOG } })
  await clock.advance(10_000)
  expect(w.reads.filter(path => path === SERVE)).toEqual([])
  await pane.press({ key: 'tab-archon-log' })
  await clock.settle()
  expect((await pane.find({ type: 'Text', text: `${hhmm(T0 + MINUTE)} warn  adapter  rate limited, backing off` }))?.props.color).toBe('warning')
  expect((await pane.find({ type: 'Text', text: `${hhmm(T0 + 2 * MINUTE)} error orchestrator  workflow failed to start` }))?.props.color).toBe('error')
  expect(await pane.find({ type: 'Text', text: '[slack] socket closed, reconnecting' })).toBeDefined()

  // Followed while in front: a new line shows on the next read.
  w.disk[SERVE] = `${SERVE_LOG}${JSON.stringify({ level: 30, time: T0 + 3 * MINUTE, module: 'server', msg: 'run started' })}\n`
  await clock.advance(2_000)
  expect(await pane.find({ type: 'Text', text: `${hhmm(T0 + 3 * MINUTE)} info  server  run started` })).toBeDefined()
  await pane.unmount()
})

test('the archonLog setting names another file, with ~ expanded from the home folder', { ...COLD, options: { archonLog: '~/logs/archon.log' } }, async ($, on) => {
  const { clock, pane } = await archonLog($, on, { disk: { 'C:/home/logs/archon.log': SERVE_LOG } })
  await pane.press({ key: 'tab-archon-log' })
  await clock.settle()
  expect(await pane.find({ type: 'Text', text: '[slack] socket closed, reconnecting' })).toBeDefined()
  await pane.unmount()
})

test('a missing file is a dim hint, not a Requirement', COLD, async ($, on) => {
  const { clock, pane } = await archonLog($, on)
  await pane.press({ key: 'tab-archon-log' })
  await clock.settle()
  const hint = await pane.find({ type: 'Text', text: /No Archon's log at .*serve\.log/ })
  expect(hint?.props.dimColor).toBe(true)
  expect(await pane.find({ type: 'Text', text: /needs the Archon CLI/ })).toBeUndefined()
  await pane.unmount()
})

test('the newest lines are kept under 60,000 characters', COLD, async ($, on) => {
  const many = Array.from({ length: 1_000 }, (_, i) => `plain line ${String(i).padStart(4, '0')} ${'z'.repeat(80)}`).join('\n')
  const { clock, pane } = await archonLog($, on, { disk: { [SERVE]: `${many}\n` } })
  await pane.press({ key: 'tab-archon-log' })
  await clock.settle()
  const texts = (await pane.findAll({ type: 'Text' })).map(t => t.text).filter(t => t.startsWith('plain line'))
  expect(texts[texts.length - 1]?.startsWith('plain line 0999')).toBe(true)
  await pane.unmount()
  const kept = capLines(many.split('\n'))
  expect(kept.reduce((sum, text) => sum + text.length, 0)).toBeLessThanOrEqual(60_000)
  expect(kept[kept.length - 1]?.startsWith('plain line 0999')).toBe(true)
  expect(kept.length).toBe(Math.floor(60_000 / 96))
})
