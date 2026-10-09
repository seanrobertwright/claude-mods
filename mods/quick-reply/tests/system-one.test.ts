import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'
import type { On } from 'claude-code'

const LAYA = 'http://127.0.0.1:8000'
const JEV = 'https://api.typesafe.ai/v1/systemone'

/** laya-serve's /openapi.json as FastAPI writes it for `create_app` (docs/research/laya-on-windows.md). */
const LAYA_OPENAPI = {
  openapi: '3.1.0',
  info: { title: 'laya-serve', version: '0.1.0' },
  paths: { '/health': {}, '/v1/systemone': {}, '/v1/systemone/batch': {} },
}

/** What a test has a model answer: a pick with its confidence for a Choice, a probability of yes for a Noul. */
type Reading = Record<string, { choice: string; confidence: number } | { noul: number }>

/** A Laya answer, with the extra fields Laya's docs list (docs/http-api.md "Response"). */
function layaAnswer(reading: Reading, truncated = false): unknown {
  const answers = Object.fromEntries(
    Object.entries(reading).map(([id, answer]) => [
      id,
      'noul' in answer
        ? { type: 'noul', noul: answer.noul, confidence: Math.max(answer.noul, 1 - answer.noul), answer_confidence: 0.9, action: { act_probability: 1 } }
        : { type: 'choice', choice: answer.choice, confidence: answer.confidence, answer_confidence: 0.9, action: { act_probability: 1 } },
    ]),
  )
  return {
    model: 'laya-rl-agent',
    answers,
    usage: { input_tokens: 200, output_tokens: 0, state_tokens: 200, state_tokens_dropped: truncated ? 90 : 0, truncated, truncated_questions: [] },
    routing: { model: 'english', repo: 'convaiinnovations/laya', reason: 'English text.', detection: null, workflow: null },
  }
}

/** A Jev answer, as TypeSafe's API reference shows one. */
function jevAnswer(reading: Reading): unknown {
  const answers = Object.fromEntries(
    Object.entries(reading).map(([id, answer]) => [
      id,
      'noul' in answer ? { type: 'noul', noul: answer.noul } : { type: 'choice', choice: answer.choice, confidence: answer.confidence },
    ]),
  )
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: 400, output_tokens: 3 } }
}

type Reply = { status: number; body: unknown } | 'refused' | Promise<{ status: number; body: unknown }>

/**
 * The engine beneath the band: its own band, a surface showing the session,
 * and the two models answering `http.fetch` by URL. `world.laya` and `world.jev`
 * say what each answers next; `world.fetches` holds every request.
 */
type World = {
  surfaces: string[]
  laya: () => Reply
  openapi: () => Reply
  jev: () => Reply
  fetches: { url: string; method: string; headers: Record<string, string>; body: string }[]
  sent: string[]
  toasts: string[]
  /** The paths `fs.exists` says are there. */
  marked: string[]
}

function newWorld(): World {
  return {
    surfaces: ['terminal'],
    laya: () => 'refused',
    openapi: () => ({ status: 200, body: LAYA_OPENAPI }),
    jev: () => 'refused',
    fetches: [],
    sent: [],
    toasts: [],
    marked: [],
  }
}

function fakeEngine(on: On, world: World): void {
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 0 }))
  on('ui.toast', (_$, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('session.cwd', () => ({ value: '/work/repo' }))
  on('session.surfaces', () => ({ value: [...world.surfaces] as never }))
  on('fs.exists', (_$, e) => {
    // The engine resolves the path first, so on Windows it arrives under a drive: compared without it.
    const path = e.path.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/')
    return { value: world.marked.includes(path) }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.submit', (_$, e) => {
    world.sent.push(e.text)
    return { text: e.text }
  })
  on('http.fetch', async (_$, e) => {
    world.fetches.push({ url: e.url, method: e.init?.method ?? 'GET', headers: { ...e.init?.headers }, body: e.init?.body ?? '' })
    const reply = await (e.url === `${LAYA}/openapi.json` ? world.openapi() : e.url === `${LAYA}/v1/systemone` ? world.laya() : e.url === JEV ? world.jev() : 'refused')
    if (reply === 'refused') throw new Error('connect ECONNREFUSED')
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)
    return { value: { status: reply.status, ok: reply.status >= 200 && reply.status < 300, headers: {}, text } }
  })
}

/** A reply the test settles later, to hold a request open. */
function held(): { reply: Promise<{ status: number; body: unknown }>; answer: (status: number, body: unknown) => void } {
  let answer: (status: number, body: unknown) => void = () => {}
  const reply = new Promise<{ status: number; body: unknown }>(resolve => (answer = (status, body) => resolve({ status, body })))
  return { reply, answer }
}

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
} as const

const turn = (answer: string) => ({ answer, durationMs: 10, isAborted: false, turnId: 't', reason: 'answer' }) as const

async function mountBand($: Engine): Promise<Mounted<'terminal', 'AbovePrompt'>> {
  return $.ui.mount({ plugin: 'quick-reply', surface: 'terminal', component: 'AbovePrompt', props: BAND })
}

/** The band's button keys, in the order drawn. */
async function keys(band: Mounted<'terminal', 'AbovePrompt'>): Promise<string[]> {
  return (await band.findAll({ type: 'Button' })).map(button => button.key ?? '')
}

/** A report whose closing question sets two alternatives with "or": the regexes offer its files as choices (#103). */
const REPORT_OR = ['Done. I changed three files:', '1. parse.ts', '2. register.tsx', '3. the tests', 'All tests pass. Should I push now or wait for CI?'].join('\n')

test('the band draws the regex reading at once, then the parts Laya settled within 2 s', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  const laya = held()
  world.laya = () => laya.reply

  await $.turn.complete(turn(REPORT_OR))
  await clock.settle()
  const band = await mountBand($)
  expect(await keys(band)).toEqual(['option-1', 'option-2', 'option-3', 'reply-Yes', 'reply-Go with your recommendation', 'reply-No'])

  laya.answer(200, layaAnswer({
    ending: { choice: 'asks yes or no', confidence: 0.97 },
    options_are_choices: { noul: 0.02 },
    recommended: { choice: 'none', confidence: 0.96 },
  }))
  await clock.advance(1_500)
  expect(await keys(band)).toEqual(['reply-Yes', 'reply-Go with your recommendation', 'reply-No'])
  await band.unmount()
})

/** Laya sure the answer asks a yes/no question and its items are no choices. */
const YES_NO = {
  ending: { choice: 'asks yes or no', confidence: 0.97 },
  options_are_choices: { noul: 0.02 },
  recommended: { choice: 'none', confidence: 0.96 },
}

const REGEX_KEYS = ['option-1', 'option-2', 'option-3', 'reply-Yes', 'reply-Go with your recommendation', 'reply-No']

test('a reading that arrives after 2 s changes nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  const laya = held()
  world.laya = () => laya.reply

  await $.turn.complete(turn(REPORT_OR))
  await clock.advance(2_000)
  laya.answer(200, layaAnswer(YES_NO))
  await clock.settle()
  const band = await mountBand($)
  expect(await keys(band)).toEqual(REGEX_KEYS)
  await band.unmount()
})

const submit = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as const

test("a reading that arrives after the next prompt changes nothing, not even the next answer's band", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  const laya = held()
  world.laya = () => laya.reply

  await $.turn.complete(turn(REPORT_OR))
  await clock.settle()
  await $.prompt.submit(submit('Run the tests again.'))
  const band = await mountBand($)
  expect(await keys(band)).toEqual([])

  // The next answer's ask finds Laya still busy with the first, so its band is the regexes' alone,
  // and the first answer's reading, arriving now, does not land on it.
  await $.turn.complete(turn(REPORT_OR))
  await clock.settle()
  laya.answer(200, layaAnswer(YES_NO))
  await clock.advance(500)
  expect(await keys(band)).toEqual(REGEX_KEYS)
  expect(world.fetches.filter(request => request.url === `${LAYA}/v1/systemone`).length).toBe(1)
  await band.unmount()
})

/** The questions of each request sent to `url`, by id. */
function questionsSent(world: World, url: string): Record<string, { type: string; criteria?: Record<string, string> }>[] {
  return world.fetches.filter(request => request.url === url).map(request => JSON.parse(request.body).questions)
}

test('whether the items are choices, and which one is recommended, are asked only when the regexes find a run of items', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)

  world.laya = () => ({ status: 200, body: layaAnswer({ ending: { choice: 'asks yes or no', confidence: 0.97 } }) })
  await $.turn.complete(turn('I changed parse.ts. Shall I commit?'))
  await clock.settle()
  world.laya = () => ({ status: 200, body: layaAnswer(YES_NO) })
  await $.turn.complete(turn(REPORT_OR))
  await clock.settle()

  const [plain, report] = questionsSent(world, `${LAYA}/v1/systemone`)
  expect(Object.keys(plain ?? {})).toEqual(['ending'])
  expect(Object.keys(report ?? {})).toEqual(['ending', 'options_are_choices', 'recommended'])
  expect(report?.recommended?.type).toBe('choice')
  expect(Object.keys(report?.recommended?.criteria ?? {})).toEqual(['1', '2', '3', 'none'])
  expect(Object.values(report?.recommended?.criteria ?? {}).slice(0, 3)).toEqual(['parse.ts', 'register.tsx', 'the tests'])
  expect(Object.keys(report?.ending?.criteria ?? {}).length).toBe(6)
})

/** Two lettered ways and a question, recommending one: the regexes read a question with choices and a recommendation. */
const CHOICE = ['Two ways to store sessions:', '', 'a. Postgres', 'b. Redis', '', 'I recommend a. Which do you want?'].join('\n')
const CHOICE_KEYS = ['option-a', 'option-b', 'reply-Yes', 'reply-Go with your recommendation', 'reply-No']

async function recommendVariant(band: Mounted<'terminal', 'AbovePrompt'>): Promise<unknown> {
  return (await band.find({ key: 'reply-Go with your recommendation' }))?.props.variant
}

test('an answer below its threshold leaves that part of the regex reading in place; one at or above it settles that part', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  const band = await mountBand($)
  const answerWith = async (reading: Reading) => {
    world.laya = () => ({ status: 200, body: layaAnswer(reading) })
    await $.turn.complete(turn(CHOICE))
    await clock.settle()
  }

  await answerWith({
    ending: { choice: 'reports finished work', confidence: 0.85 },
    options_are_choices: { noul: 0.5 },
    recommended: { choice: 'none', confidence: 0.85 },
  })
  expect(await keys(band)).toEqual(CHOICE_KEYS)
  expect(await recommendVariant(band)).toBe('primary')

  // Each part on its own: the others below their thresholds.
  await answerWith({
    ending: { choice: 'offers alternatives', confidence: 0.5 },
    options_are_choices: { noul: 0.5 },
    recommended: { choice: 'none', confidence: 0.92 },
  })
  expect(await keys(band)).toEqual(CHOICE_KEYS)
  expect(await recommendVariant(band)).toBe('secondary')

  await answerWith({
    ending: { choice: 'offers alternatives', confidence: 0.5 },
    options_are_choices: { noul: 0.08 },
    recommended: { choice: 'a', confidence: 0.5 },
  })
  expect(await keys(band)).toEqual(['reply-Yes', 'reply-Go with your recommendation', 'reply-No'])

  await answerWith({
    ending: { choice: 'reports finished work', confidence: 0.93 },
    options_are_choices: { noul: 0.5 },
    recommended: { choice: 'a', confidence: 0.5 },
  })
  expect(await keys(band)).toEqual(['reply-Continue', 'reply-Commit and push'])

  // An ending that neither asks nor reports finished work leaves whether the answer asks to the regexes.
  await answerWith({
    ending: { choice: 'reports a failure', confidence: 0.99 },
    options_are_choices: { noul: 0.5 },
    recommended: { choice: 'a', confidence: 0.5 },
  })
  expect(await keys(band)).toEqual(CHOICE_KEYS)
  await band.unmount()
})

test('a model can settle what the regexes miss: a recommendation they do not see, and a question they do not see', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  const band = await mountBand($)

  world.laya = () => ({ status: 200, body: layaAnswer({
    ending: { choice: 'offers alternatives', confidence: 0.95 },
    options_are_choices: { noul: 0.97 },
    recommended: { choice: 'b', confidence: 0.94 },
  }) })
  await $.turn.complete(turn(['Two ways forward:', 'a. Fix it now', 'b. Open an issue', 'Which do you want?'].join('\n')))
  await clock.settle()
  expect(await recommendVariant(band)).toBe('primary')

  // "Your call between the two." asks without a ? or an asking word.
  world.laya = () => ({ status: 200, body: layaAnswer({
    ending: { choice: 'offers alternatives', confidence: 0.95 },
    options_are_choices: { noul: 0.97 },
    recommended: { choice: 'none', confidence: 0.94 },
  }) })
  await $.turn.complete(turn(['Two ways forward:', 'a. Fix it now', 'b. Open an issue', 'Your call between the two.'].join('\n')))
  await clock.settle()
  expect(await keys(band)).toEqual(['option-a', 'option-b', 'reply-Yes', 'reply-Go with your recommendation', 'reply-No'])
  await band.unmount()
})

test('a session no surface shows asks no model, and nor does a subagent\'s turn or a turn that ends other than by an answer', { options: { modelChoice: 'hosted first', jevApiKey: 'ts-test-key' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  world.laya = () => ({ status: 200, body: layaAnswer(YES_NO) })
  world.jev = () => ({ status: 200, body: jevAnswer(YES_NO) })

  world.surfaces = []
  await $.turn.complete(turn(REPORT_OR))
  await clock.advance(2_000)
  world.surfaces = ['terminal']
  await $.turn.complete({ ...turn(REPORT_OR), agentId: 'agent-1' })
  for (const reason of ['aborted', 'error'] as const) await $.turn.complete({ ...turn(REPORT_OR), reason })
  await $.turn.complete({ ...turn(REPORT_OR), reason: 'refusal', refusal: { category: null, explanation: null } })
  await clock.advance(2_000)
  expect(world.fetches).toEqual([])
})

test('with neither model reachable the band reads as it does today, and nothing is said', { options: { modelChoice: 'local first', jevApiKey: 'ts-test-key' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  world.openapi = () => 'refused'
  const band = await mountBand($)

  await $.turn.complete(turn(REPORT_OR))
  await clock.advance(2_000)
  expect(await keys(band)).toEqual(REGEX_KEYS)
  await $.turn.complete(turn(REPORT_OR))
  await clock.advance(2_000)
  expect(await keys(band)).toEqual(REGEX_KEYS)
  expect(world.toasts).toEqual([])
  expect(await band.find({ type: 'Text', text: /Jev/ })).toBeUndefined()
  await band.unmount()
})

const LOCAL_FIRST = { options: { modelChoice: 'local first', jevApiKey: 'ts-test-key' } } as const
const fetched = (world: World, url: string) => world.fetches.filter(request => request.url === url)

test('under local only nothing is ever sent to api.typesafe.ai, whatever key is set', { options: { jevApiKey: 'ts-test-key' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  world.jev = () => ({ status: 200, body: jevAnswer(YES_NO) })

  for (let index = 0; index < 4; index += 1) {
    await $.turn.complete(turn(REPORT_OR))
    await clock.advance(400_000)
  }
  expect(fetched(world, `${LAYA}/openapi.json`).length).toBe(4)
  expect(world.fetches.filter(request => request.url.includes('typesafe'))).toEqual([])
})

test('a folder marked local only keeps the answer off Jev, and Laya is asked in its place', { options: { modelChoice: 'hosted first', jevApiKey: 'ts-test-key' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  world.marked = ['/work/.claude/system-one-local-only']
  world.jev = () => ({ status: 200, body: jevAnswer(YES_NO) })
  world.laya = () => ({ status: 200, body: layaAnswer(YES_NO) })

  await $.turn.complete(turn(REPORT_OR))
  await clock.settle()
  expect(fetched(world, JEV)).toEqual([])
  expect(fetched(world, `${LAYA}/v1/systemone`).length).toBe(1)
})

/** Exactly 8,000 characters that end an answer: a long report, then the run and its question. */
const LAST_8000 = [`${'The parser now reads every heading. '.repeat(220)}`.slice(0, 8_000 - REPORT_OR.length - 1), REPORT_OR].join('\n')

test('under local first with Laya unavailable, Jev gets only the last 8,000 characters of the answer and the labels found; a turn never asks both', LOCAL_FIRST, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  world.openapi = () => 'refused'
  world.jev = () => ({ status: 200, body: jevAnswer(YES_NO) })
  const band = await mountBand($)

  // Laya is asked and fails: this turn's reading is the regexes', and Jev is not asked for it.
  await $.turn.complete(turn(REPORT_OR))
  await clock.advance(2_000)
  expect(fetched(world, `${LAYA}/openapi.json`).length).toBe(1)
  expect(fetched(world, JEV)).toEqual([])
  expect(await keys(band)).toEqual(REGEX_KEYS)

  // Laya is unavailable now, so the next turn asks Jev, and only Jev.
  await $.turn.complete(turn(`An opening paragraph that Jev is not sent.\n${LAST_8000}`))
  await clock.settle()
  expect(fetched(world, `${LAYA}/openapi.json`).length).toBe(1)
  const [request] = fetched(world, JEV)
  const body = JSON.parse(request?.body ?? '{}')
  expect(Object.keys(body)).toEqual(['model', 'state', 'questions'])
  expect(body.state).toBe(LAST_8000)
  expect(Object.values(body.questions.recommended.criteria)).toEqual(['parse.ts', 'register.tsx', 'the tests', 'It recommends none of them.'])
  expect(await keys(band)).toEqual(['reply-Yes', 'reply-Go with your recommendation', 'reply-No'])
  await band.unmount()
})

test('Jev\'s answers are held to Jev\'s own thresholds', { options: { modelChoice: 'hosted first', jevApiKey: 'ts-test-key' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  const band = await mountBand($)

  world.jev = () => ({ status: 200, body: jevAnswer({
    ending: { choice: 'reports finished work', confidence: 0.85 },
    options_are_choices: { noul: 0.5 },
    recommended: { choice: 'none', confidence: 0.85 },
  }) })
  await $.turn.complete(turn(REPORT_OR))
  await clock.settle()
  expect(await keys(band)).toEqual(REGEX_KEYS)

  world.jev = () => ({ status: 200, body: jevAnswer({
    ending: { choice: 'reports finished work', confidence: 0.95 },
    options_are_choices: { noul: 0.05 },
    recommended: { choice: 'none', confidence: 0.95 },
  }) })
  await $.turn.complete(turn(REPORT_OR))
  await clock.settle()
  expect(await keys(band)).toEqual(['reply-Continue', 'reply-Commit and push'])
  expect(fetched(world, `${LAYA}/v1/systemone`)).toEqual([])
  await band.unmount()
})

/** Nine choices whose labels run past 40 characters, and the question that closes them. */
const NINE = [
  ...Array.from({ length: 9 }, (_, index) => `${index + 1}. Option ${index + 1} with a label that runs well past forty characters`),
  'Which one should I take?',
].join('\n')

test('Laya is sent the answer\'s closing lines, where the question is, and at most 9 labels of at most 40 characters', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  world.laya = () => ({ status: 200, body: layaAnswer({
    ending: { choice: 'offers alternatives', confidence: 0.5 },
    options_are_choices: { noul: 0.5 },
    recommended: { choice: 'none', confidence: 0.5 },
  }) })

  const opening = Array.from({ length: 6 }, () => 'A long line of the report that comes before the choices. '.repeat(15)).join('\n')
  await $.turn.complete(turn(`${opening}\n${NINE}\n\n`))
  await clock.settle()

  const [request] = fetched(world, `${LAYA}/v1/systemone`)
  const body = JSON.parse(request?.body ?? '{}')
  expect(body.state).toBe(NINE)
  const labels = Object.entries(body.questions.recommended.criteria).filter(([option]) => option !== 'none').map(([, label]) => label as string)
  expect(labels.length).toBe(9)
  expect(labels[0]).toBe('Option 1 with a label that runs well pa…')
  for (const label of labels) expect(Array.from(label).length).toBeLessThanOrEqual(40)
})

/** The band's lines of text, in the order drawn. */
async function texts(band: Mounted<'terminal', 'AbovePrompt'>): Promise<{ text: string; isDim: boolean }[]> {
  return (await band.findAll({ type: 'Text' })).map(text => ({ text: text.text ?? '', isDim: text.props.dimColor === true }))
}

test('under a choice that allows Jev, an absent key is named on a dim line under the replies, gone at the next prompt', { options: { modelChoice: 'local first' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  const band = await mountBand($)

  await $.turn.complete(turn(REPORT_OR))
  await clock.advance(2_000)
  const [reply, note] = await texts(band)
  expect(reply?.text).toBe('Reply:')
  expect(note?.isDim).toBe(true)
  expect(note?.text).toMatch(/quick-reply may ask TypeSafe's hosted Jev, but no "Jev API key" is set/)
  expect(fetched(world, JEV)).toEqual([])

  await $.prompt.submit(submit('Push it.'))
  await $.turn.complete({ ...turn(REPORT_OR), reason: 'aborted' })
  expect(await band.find({ type: 'Text', text: /Jev API key/ })).toBeUndefined()
  await band.unmount()
})

test('a key that is not a key is named, and never sent', { options: { modelChoice: 'hosted first', jevApiKey: 'ts test key' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  const band = await mountBand($)

  await $.turn.complete(turn(REPORT_OR))
  await clock.advance(2_000)
  expect(await band.find({ type: 'Text', text: /quick-reply's "Jev API key" is not a key/ })).toBeDefined()
  expect(fetched(world, JEV)).toEqual([])
  await band.unmount()
})

test('a key Jev rejects is named after the answer the rejection came on, and gone at the next prompt', { options: { modelChoice: 'hosted first', jevApiKey: 'ts-test-key' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  world.jev = () => ({ status: 401, body: { detail: 'invalid api key' } })
  const band = await mountBand($)

  await $.turn.complete(turn(REPORT_OR))
  await clock.settle()
  expect(await keys(band)).toEqual(REGEX_KEYS)
  expect(await band.find({ type: 'Text', text: /TypeSafe rejected quick-reply's "Jev API key"/ })).toBeDefined()

  await $.prompt.submit(submit('Push it.'))
  expect(await band.find({ type: 'Text', text: /Jev API key/ })).toBeUndefined()
  await band.unmount()
})

test('under local only no key is named, whatever the key setting holds', { options: { jevApiKey: 'ts test key' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  const band = await mountBand($)

  await $.turn.complete(turn(REPORT_OR))
  await clock.advance(2_000)
  expect(await texts(band)).toEqual([{ text: 'Reply:', isDim: true }])
  await band.unmount()
})
