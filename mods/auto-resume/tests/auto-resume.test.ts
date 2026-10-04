import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { formatWait, instantMs, parseConfig, parseMinutes, planResume } from '../hooks/plan'

/**
 * Stand-ins for what the engine does beneath the plugins: an empty band, a
 * status line, toasts (recorded in `toasts`), and the surfaces showing the
 * session, a list the test edits.
 */
function engineBeneath(on: On, surfaces: string[] = ['terminal'], toasts: string[] = []): void {
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  on('session.detach', (_$, e) => ({ clientId: e.clientId }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.surfaces', () => ({ value: [...surfaces] as never }))
}

/** A rate limit whose five-hour window resets ten minutes after NOW. */
function rateLimited(on: On): void {
  on('classic.StopFailure', () => ({}))
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: { window: 200_000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(NOW + 10 * MINUTE).toISOString() }],
    },
  }))
}

/** Records every prompt submitted. */
function submitted(on: On): string[] {
  const sent: string[] = []
  on('prompt.submit', (_$, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  return sent
}

const PHONE = { surface: 'mobile', clientId: 'mobile:default' } as const

const MINUTE = 60_000
const NOW = 1_800_000_000_000
const config = parseConfig({})

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
} as const

test('instantMs reads zoned ISO instants and refuses zone-less ones', () => {
  expect(instantMs('2027-01-15T08:00:00Z')).toBe(Date.UTC(2027, 0, 15, 8))
  expect(instantMs('2027-01-15T10:00:00+02:00')).toBe(Date.UTC(2027, 0, 15, 8))
  expect(instantMs('2027-01-15T08:00:00')).toBeUndefined()
  expect(instantMs('soon')).toBeUndefined()
})

test('a rate limit waits for the exhausted window to reset, plus the grace', () => {
  const resetsAt = '2027-01-15T08:00:00Z'
  const plan = planResume({
    error: 'rate_limit',
    rateLimits: [
      { kind: 'five_hour', percentUsed: 100, resetsAt },
      { kind: 'seven_day', percentUsed: 40, resetsAt: '2027-01-20T00:00:00Z' },
    ],
    now: Date.UTC(2027, 0, 15, 6),
    attempts: 0,
    config,
  })
  expect(plan).toEqual({ resumeAt: Date.UTC(2027, 0, 15, 8) + MINUTE, reason: '5-hour limit reached' })
})

test('without a reset time it backs off, and gives up after the retries', () => {
  expect(planResume({ error: 'rate_limit', rateLimits: [], now: NOW, attempts: 0, config })?.resumeAt).toBe(NOW + MINUTE)
  expect(planResume({ error: 'overloaded', rateLimits: [], now: NOW, attempts: 2, config })?.resumeAt).toBe(NOW + 4 * MINUTE)
  expect(planResume({ error: 'overloaded', rateLimits: [], now: NOW, attempts: 4, config })?.resumeAt).toBe(NOW + 15 * MINUTE)
  expect(planResume({ error: 'rate_limit', rateLimits: [], now: NOW, attempts: 5, config })).toBeUndefined()
  expect(planResume({ error: 'billing_error', rateLimits: [], now: NOW, attempts: 0, config })).toBeUndefined()
  const quiet = parseConfig({ retryOverloaded: false })
  expect(planResume({ error: 'overloaded', rateLimits: [], now: NOW, attempts: 0, config: quiet })).toBeUndefined()
})

test('options and arguments are parsed at the boundary', () => {
  expect(parseConfig({ graceSeconds: -1, maxRetries: 2.5, text: '  ' })).toEqual({
    text: 'continue',
    graceMs: MINUTE,
    retryOverloaded: true,
    maxRetries: 5,
  })
  expect(parseMinutes('15')).toBe(15)
  expect(parseMinutes('0')).toBeUndefined()
  expect(parseMinutes('1e3')).toBeUndefined()
  expect(formatWait(45_000)).toBe('45 s')
  expect(formatWait(72 * MINUTE)).toBe('1 h 12 min')
})

test('a rate-limited turn arms a countdown that sends "continue" at the reset', async ($, on) => {
  engineBeneath(on)
  const clock = mock.clock(on, { now: NOW })
  rateLimited(on)
  const sent = submitted(on)

  await $.classic.StopFailure({ error: 'rate_limit' })
  const band = await $.ui.mount({ plugin: 'auto-resume', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ key: 'now' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /11 min/ })).toBeDefined()

  await clock.advance(11 * MINUTE)
  expect(sent).toEqual(['continue'])
  expect(await band.find({ key: 'now' })).toBeUndefined()
  await band.unmount()
})

test('a resume pressed twice at once sends "continue" once', async ($, on) => {
  engineBeneath(on)
  const clock = mock.clock(on, { now: NOW })
  rateLimited(on)
  const sent = submitted(on)

  await $.classic.StopFailure({ error: 'rate_limit' })
  const band = await $.ui.mount({ plugin: 'auto-resume', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await Promise.all([band.press({ key: 'now' }), band.press({ key: 'now' })])
  await clock.advance(11 * MINUTE)
  expect(sent).toEqual(['continue'])
  await band.unmount()
})

test('Cancel disarms the countdown', async ($, on) => {
  engineBeneath(on)
  const clock = mock.clock(on, { now: NOW })
  on('classic.StopFailure', () => ({}))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
  const sent = submitted(on)

  await $.classic.StopFailure({ error: 'overloaded' })
  const band = await $.ui.mount({ plugin: 'auto-resume', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  await band.press({ key: 'cancel' })
  await clock.advance(30 * MINUTE)
  expect(sent).toEqual([])
  await band.unmount()
})

test('a headless session arms nothing after a rate limit', async ($, on) => {
  const toasts: string[] = []
  engineBeneath(on, [], toasts)
  const clock = mock.clock(on, { now: NOW })
  rateLimited(on)
  const sent = submitted(on)

  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await $.classic.StopFailure({ error: 'rate_limit' })
  const band = await $.ui.mount({ plugin: 'auto-resume', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ key: 'now' })).toBeUndefined()
  await clock.advance(30 * MINUTE)
  expect(sent).toEqual([])
  expect(toasts).toEqual([])
  await band.unmount()
})

test('a resume armed while shown is still sent after the last surface detaches, and the countdown stops', async ($, on) => {
  const surfaces = ['mobile']
  engineBeneath(on, surfaces)
  const clock = mock.clock(on, { now: NOW })
  rateLimited(on)
  const sent = submitted(on)

  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await $.session.attach(PHONE)
  await $.classic.StopFailure({ error: 'rate_limit' })
  const band = await $.ui.mount({ plugin: 'auto-resume', surface: 'mobile', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: /11 min/ })).toBeDefined()

  surfaces.length = 0
  await $.session.detach({ ...PHONE, reason: 'detach' })
  await clock.advance(5 * MINUTE)
  // No tick while nothing shows the session: the countdown still reads its old time.
  expect(await band.find({ type: 'Text', text: /11 min/ })).toBeDefined()

  await clock.advance(6 * MINUTE)
  expect(sent).toEqual(['continue'])
  await band.unmount()
})

test('a surface attaching while a resume is armed brings the countdown up to date', async ($, on) => {
  const surfaces = ['mobile']
  engineBeneath(on, surfaces)
  const clock = mock.clock(on, { now: NOW })
  rateLimited(on)
  submitted(on)

  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await $.session.attach(PHONE)
  await $.classic.StopFailure({ error: 'rate_limit' })
  surfaces.length = 0
  await $.session.detach({ ...PHONE, reason: 'detach' })
  await clock.advance(5 * MINUTE)

  surfaces.push('mobile')
  await $.session.attach(PHONE)
  const band = await $.ui.mount({ plugin: 'auto-resume', surface: 'mobile', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: /6 min/ })).toBeDefined()
  await clock.advance(MINUTE)
  expect(await band.find({ type: 'Text', text: /5 min/ })).toBeDefined()
  await band.unmount()
})

test('a prompt from the SDK host takes over from an armed resume', async ($, on) => {
  engineBeneath(on, ['mobile'])
  const clock = mock.clock(on, { now: NOW })
  rateLimited(on)
  const sent = submitted(on)

  await $.classic.StopFailure({ error: 'rate_limit' })
  await $.prompt.submit({ text: 'next task', origin: { kind: 'sdk' }, wait: false })
  await clock.advance(30 * MINUTE)
  expect(sent).toEqual(['next task'])
})

test('a resume restored at start after a reload is still sent with no surface', async ($, on) => {
  const surfaces = ['terminal']
  engineBeneath(on, surfaces)
  const clock = mock.clock(on, { now: NOW })
  rateLimited(on)
  const sent = submitted(on)

  await $.classic.StopFailure({ error: 'rate_limit' })
  // A hot reload raises session.start again; this time nothing shows the session.
  surfaces.length = 0
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await clock.advance(11 * MINUTE)
  expect(sent).toEqual(['continue'])
})

test('a surface attaching while the countdown ticks shows the time now, not the last tick', async ($, on) => {
  const surfaces = ['terminal']
  engineBeneath(on, surfaces)
  const clock = mock.clock(on, { now: NOW })
  submitted(on)

  await $.command.run({ command: 'auto-resume', args: 'in 1', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  const band = await $.ui.mount({ plugin: 'auto-resume', surface: 'mobile', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: /1 min/ })).toBeDefined()
  // Ticks come every 30 s: at 25 s the band still shows the time of the last one.
  await clock.advance(25_000)
  expect(await band.find({ type: 'Text', text: /1 min/ })).toBeDefined()

  surfaces.push('mobile')
  await $.session.attach(PHONE)
  expect(await band.find({ type: 'Text', text: /35 s/ })).toBeDefined()
  await band.unmount()
})
