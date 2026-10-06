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

const DONE_ASKS = ['Done. I changed three files:', '1. parse.ts', '2. register.tsx', '3. the tests', 'All tests pass. Shall I commit?'].join(
  '\n',
)

const URL_QUOTED = 'See `https://example.com/search?q=mods` for the page.'
const URL_BARE = 'See https://example.com/search?q=mods for the page.'

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

test('a numbered report before a yes-or-no question offers no choices', () => {
  expect(readAnswer(DONE_ASKS)).toEqual({ isQuestion: true, hasRecommendation: false, options: [] })
})

test('a run is still offered when the question is open, sets alternatives or names a marker', () => {
  const ways = ['I see two ways forward:', '1. Fix it now', '2. Open an issue']
  const closings = [
    'What would you like to do?',
    'How would you like to proceed?',
    'Should I do 1, 2, or both?',
    'Want me to go with 1?',
    'I recommend 1. Sound good?',
    'Do you want the quick fix or the issue?',
    'I lean towards the first. Thoughts?',
    'Let me know which you prefer.',
  ]
  for (const closing of closings) {
    expect(readAnswer([...ways, closing].join('\n')).options.map(option => option.label)).toEqual(['Fix it now', 'Open an issue'])
  }
  expect(readAnswer(['Should I:', '1. Fix it now', '2. Open an issue'].join('\n')).options.length).toBe(2)
})

test('a lowercase-lettered run is still offered when the question names a marker', () => {
  const ways = ['I see two ways forward:', 'a. Fix it now', 'b. Open an issue']
  for (const closing of ['I recommend b. Sound good?', 'Want me to go with a?', 'Shall I start with (b)?']) {
    expect(readAnswer([...ways, closing].join('\n')).options.map(option => option.marker)).toEqual(['a', 'b'])
  }
  // Neither the "e" of "e.g." nor the "f" of "for" is a marker.
  expect(readAnswer([...ways, 'Want me to add cases, e.g. URLs?'].join('\n')).options).toEqual([])
  expect(readAnswer([...ways, 'Shall I push it for review?'].join('\n')).options).toEqual([])
})

test('a yes-or-no question is not about the run, wherever it stands', () => {
  const files = ['1. parse.ts', '2. register.tsx']
  expect(readAnswer(['Shall I commit? Here is what changed:', ...files].join('\n')).options).toEqual([])
  expect(readAnswer(['Here is what changed:', ...files, 'Let me know if you want anything else.'].join('\n')).options).toEqual([])
  expect(readAnswer(['Here is what changed:', ...files, 'All 2 tests pass. Want me to push?'].join('\n')).options).toEqual([])
  expect(readAnswer(['Here is what changed:', ...files, 'For the record, all tests pass. Shall I commit?'].join('\n')).options).toEqual([])
  expect(readAnswer(['Here is what changed:', ...files, 'Shall I bump the version to 1.5?'].join('\n')).options).toEqual([])
})

test('a ? inside a URL or inline code is not a question', () => {
  const idle = { isQuestion: false, hasRecommendation: false, options: [] }
  expect(readAnswer(URL_QUOTED)).toEqual(idle)
  expect(readAnswer(URL_BARE)).toEqual(idle)
  expect(readAnswer('The check is `value?.length ? 1 : 0` now.')).toEqual(idle)
  expect(readAnswer('The route is /search?q=mods now, see https://example.com/pick for more.')).toEqual(idle)
  expect(readAnswer('Open (https://example.com/search?q=mods) — is that the page?').isQuestion).toBe(true)
  expect(readAnswer('Is this what you meant?**').isQuestion).toBe(true)
  expect(readAnswer('Ready to merge?—or wait for CI').isQuestion).toBe(true)
})

test('an answer that recommends against something has no recommendation', () => {
  expect(readAnswer('I would not recommend option B here.').hasRecommendation).toBe(false)
  expect(readAnswer("I wouldn't recommend B, and A is not recommended either.").hasRecommendation).toBe(false)
  expect(readAnswer('I recommend against option B.').hasRecommendation).toBe(false)
  expect(readAnswer('I have no strong recommendation here.').hasRecommendation).toBe(false)
  expect(readAnswer('Run `npm run recommend` to list them.').hasRecommendation).toBe(false)
  expect(readAnswer('I would not recommend option B here. I recommend A.').hasRecommendation).toBe(true)
  expect(readAnswer('I would not, however, recommend option B.').hasRecommendation).toBe(false)
  expect(readAnswer('This is not an approach I would recommend.').hasRecommendation).toBe(false)
  expect(readAnswer('Neither option is one I can recommend.').hasRecommendation).toBe(false)
  expect(readAnswer('If not, I recommend A.').hasRecommendation).toBe(true)
  // A "not" or a "no" that belongs to something else leaves the recommendation standing.
  expect(readAnswer('Since the tests do not pass I recommend reverting.').hasRecommendation).toBe(true)
  expect(readAnswer('I have no objections and recommend merging.').hasRecommendation).toBe(true)
  expect(readAnswer('If that is not possible I recommend option A.').hasRecommendation).toBe(true)
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

test('after a report that ends on a yes-or-no question the band offers the question replies only', async ($, on) => {
  engineBeneath(on)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  await $.turn.complete({ answer: DONE_ASKS, durationMs: 10, isAborted: false, turnId: 't5', reason: 'answer' })

  const band = await $.ui.mount({ plugin: 'quick-reply', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ key: 'reply-Yes' })).toBeDefined()
  expect(await band.find({ key: 'option-1' })).toBeUndefined()
  expect(await band.find({ key: 'option-2' })).toBeUndefined()
  expect(await band.find({ key: 'option-3' })).toBeUndefined()
  await band.unmount()
})

test('after an answer whose only ? is in a URL the band offers the idle replies', async ($, on) => {
  engineBeneath(on)
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  for (const answer of [URL_QUOTED, URL_BARE]) {
    await $.turn.complete({ answer, durationMs: 10, isAborted: false, turnId: 't6', reason: 'answer' })
    const band = await $.ui.mount({ plugin: 'quick-reply', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await band.find({ key: 'reply-Continue' })).toBeDefined()
    expect(await band.find({ key: 'reply-Yes' })).toBeUndefined()
    await band.unmount()
  }
})

test('the recommendation reply is primary only when the answer recommends something', async ($, on) => {
  engineBeneath(on)
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  const variants: [string, string][] = [
    ['I recommend option A here. Shall I go on?', 'primary'],
    ['I would not recommend option B here. Shall I go on?', 'secondary'],
  ]
  for (const [answer, variant] of variants) {
    await $.turn.complete({ answer, durationMs: 10, isAborted: false, turnId: 't7', reason: 'answer' })
    const band = await $.ui.mount({ plugin: 'quick-reply', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect((await band.find({ key: 'reply-Go with your recommendation' }))?.props.variant).toBe(variant)
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

test('the band keeps what is beneath it on a row under the replies', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', props: {}, children: ['band beneath'] }))
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  await $.turn.complete({ answer: DONE, durationMs: 10, isAborted: false, turnId: 't4', reason: 'answer' })

  const band = await $.ui.mount({ plugin: 'quick-reply', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ key: 'reply-Continue' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: 'band beneath' })).toBeDefined()
  await band.unmount()
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
