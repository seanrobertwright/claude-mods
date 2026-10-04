import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { formatWait, instantMs, parseConfig, parseMinutes, planResume } from '../hooks/plan'

/** Stand-ins for what the engine does beneath the plugins: an empty band, a status line, toasts. */
function engineBeneath(on: On): void {
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
}

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
  const sent: string[] = []
  on('classic.StopFailure', () => ({}))
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: { window: 200_000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(NOW + 10 * MINUTE).toISOString() }],
    },
  }))
  on('prompt.submit', (_$, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  await $.classic.StopFailure({ error: 'rate_limit' })
  const band = await $.ui.mount({ plugin: 'auto-resume', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ key: 'now' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /11 min/ })).toBeDefined()

  await clock.advance(11 * MINUTE)
  expect(sent).toEqual(['continue'])
  expect(await band.find({ key: 'now' })).toBeUndefined()
  await band.unmount()
})

test('Cancel disarms the countdown', async ($, on) => {
  engineBeneath(on)
  const clock = mock.clock(on, { now: NOW })
  const sent: string[] = []
  on('classic.StopFailure', () => ({}))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
  on('prompt.submit', (_$, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  await $.classic.StopFailure({ error: 'overloaded' })
  const band = await $.ui.mount({ plugin: 'auto-resume', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  await band.press({ key: 'cancel' })
  await clock.advance(30 * MINUTE)
  expect(sent).toEqual([])
  await band.unmount()
})
