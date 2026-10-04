import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { findOptions, optionReply, parseReplies, readAnswer } from '../hooks/detect'

/** Stand-ins for what the engine does beneath the plugins: an empty band, a status line, toasts. */
function engineBeneath(on: On): void {
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
}

const CHOICE = [
  'Two ways to store sessions:',
  '',
  '**A.** Postgres — durable, but one more service',
  '   - needs a migration',
  '**B.** Redis: fast, but volatile',
  '',
  'I recommend A. Which do you want?',
].join('\n')

const DONE = ['Done. I changed three files:', '1. parse.ts', '2. register.tsx', '3. the tests', '', 'All tests pass.'].join('\n')

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
} as const

test('readAnswer finds the offered choices and the recommendation', () => {
  expect(readAnswer(CHOICE)).toEqual({
    isQuestion: true,
    hasRecommendation: true,
    options: [
      { marker: 'a', label: 'Postgres' },
      { marker: 'b', label: 'Redis' },
    ],
  })
})

test('a numbered summary that asks nothing offers no choices', () => {
  expect(readAnswer(DONE)).toEqual({ isQuestion: false, hasRecommendation: false, options: [] })
})

test('findOptions keeps the last run in sequence and skips code', () => {
  const text = ['1. old', '2. older', '', '```', '1. code', '2. code', '```', '1) Ship it', '2) Wait', '3) Drop it'].join('\n')
  expect(findOptions(text).map(option => option.label)).toEqual(['Ship it', 'Wait', 'Drop it'])
  expect(findOptions('1. only one')).toEqual([])
})

test('parseReplies trims, drops empties and duplicates, and caps at six', () => {
  expect(parseReplies(' Yes || No|Yes ')).toEqual(['Yes', 'No'])
  expect(parseReplies('1|2|3|4|5|6|7').length).toBe(6)
  expect(parseReplies(42)).toEqual([])
  expect(optionReply({ marker: 'b', label: 'Redis' })).toBe('b) Redis')
})

test('after a question the band offers its choices and sends the pick', async ($, on) => {
  engineBeneath(on)
  const sent: string[] = []
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.submit', (_$, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    await $.turn.complete({ answer: CHOICE, durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
    const band = await $.ui.mount({ plugin: 'quick-reply', surface, component: 'AbovePrompt', props: BAND })
    expect((await band.find({ key: 'option-a' }))?.text).toContain('Postgres')
    expect(await band.find({ key: 'reply-Go with your recommendation' })).toBeDefined()
    expect(await band.find({ key: 'reply-Continue' })).toBeUndefined()

    await band.press({ key: 'option-b' })
    expect(sent[sent.length - 1]).toBe('b) Redis')
    // Sending clears the band until the next answer.
    expect(await band.find({ key: 'option-a' })).toBeUndefined()
    await band.unmount()
  }
})

test('after a plain answer the band offers the idle replies, and none while working', async ($, on) => {
  engineBeneath(on)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  await $.turn.complete({ answer: DONE, durationMs: 10, isAborted: false, turnId: 't2', reason: 'answer' })

  const band = await $.ui.mount({ plugin: 'quick-reply', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ key: 'reply-Continue' })).toBeDefined()
  expect(await band.find({ key: 'reply-Yes' })).toBeUndefined()
  await band.unmount()

  const busy = await $.ui.mount({
    plugin: 'quick-reply',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { ...BAND, isWorking: true },
  })
  expect(await busy.find({ key: 'reply-Continue' })).toBeUndefined()
  await busy.unmount()
})

test('in a headless session a question submits no prompt and starts no process', async ($, on) => {
  engineBeneath(on)
  const clock = mock.clock(on, { now: 1_000 })
  const sent: string[] = []
  const runs: (readonly string[])[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: [] }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.submit', (_$, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('process.run', (_$, e) => {
    runs.push(e.argv)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.session.start({ cwd: '/work/repo', surface: null, isInteractive: false })
  await $.turn.complete({ answer: CHOICE, durationMs: 10, isAborted: false, turnId: 't3', reason: 'answer' })
  await clock.advance(600_000)
  expect(sent).toEqual([])
  expect(runs).toEqual([])
})
