import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted, TestOptions } from 'claude-code/testing'
import type { On } from 'claude-code'

import { keyProblem, parseSystemOne } from '../hooks/system-one'

const FENCE = '```'

const REPLY = [
  '### Push the auth branch and open its PR',
  'Two commits sit unpushed on feat/auth; nothing else can merge before it.',
  'Prompt =',
  FENCE,
  '/implement GitHub issue #52',
  FENCE,
  '',
  '### Triage incoming bugs',
  'Three new issues arrived overnight.',
  'Prompt =',
  FENCE,
  '/triage',
  FENCE,
].join('\n')

const ASK_SEAN = { name: 'ask-sean', description: "What's next?", source: 'user' } as const

const PANE_PROPS = {
  title: "What's next",
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const
const MOUNT = { plugin: 'whats-next', surface: 'terminal', component: 'Pane', requestId: 'whats-next', props: PANE_PROPS } as const

const LAYA = 'http://127.0.0.1:8000'
const JEV = 'https://api.typesafe.ai/v1/systemone'

/** laya-serve's /openapi.json as FastAPI writes it for `create_app` (docs/research/laya-on-windows.md). */
const LAYA_OPENAPI = {
  openapi: '3.1.0',
  info: { title: 'laya-serve', version: '0.1.0' },
  paths: { '/health': {}, '/v1/systemone': {}, '/v1/systemone/batch': {} },
}

/** A Laya answer to one Noul, with the extra fields Laya's docs list (docs/http-api.md "Response"). */
function layaAnswer(noul: number, truncated = false): unknown {
  return {
    model: 'laya-rl-agent',
    answers: {
      finished: { type: 'noul', noul, confidence: Math.max(noul, 1 - noul), answer_confidence: 0.9, action: { act_probability: 1 } },
    },
    usage: {
      input_tokens: 120,
      output_tokens: 0,
      state_tokens: truncated ? 700 : 120,
      state_tokens_dropped: truncated ? 188 : 0,
      truncated,
      truncated_questions: truncated ? ['finished'] : [],
    },
    routing: { model: 'english', repo: 'convaiinnovations/laya', reason: 'English text.', detection: null, workflow: null },
  }
}

/** A Jev answer to one Noul, as TypeSafe's Noul page shows one. */
function jevAnswer(noul: number): unknown {
  return { model: 'jev-1.13.0', answers: { finished: { type: 'noul', noul } }, usage: { input_tokens: 360, output_tokens: 1 } }
}

type Reply = { status: number; body: unknown } | 'refused' | Promise<{ status: number; body: unknown }>

/**
 * The engine beneath the mod: the skill's reply, one surface showing, a store,
 * Haiku answering NOT_DONE, and the two models answering `http.fetch` by URL.
 * `world.laya` and `world.jev` say what each answers next; `world.fetches` holds
 * every request, `world.judged` counts the Haiku asks.
 */
type World = {
  /** What the headless run of the skill answers. */
  reply: string
  surfaces: string[]
  /** Answers for the next surfaces checks, taken in turn before `surfaces`. */
  surfacesNext: string[][]
  laya: () => Reply
  openapi: () => Reply
  jev: () => Reply
  fetches: { url: string; method: string; headers: Record<string, string>; body: string }[]
  judged: number
  haiku: string
  marked: string[]
  exists: string[]
  toasts: string[]
}

function newWorld(): World {
  return {
    reply: REPLY,
    surfaces: ['terminal'],
    surfacesNext: [],
    laya: () => 'refused',
    openapi: () => ({ status: 200, body: LAYA_OPENAPI }),
    jev: () => 'refused',
    fetches: [],
    judged: 0,
    haiku: 'NOT_DONE',
    marked: [],
    exists: [],
    toasts: [],
  }
}

/**
 * A plugin above whats-next that refuses the glow's beats, for a test that
 * moves the clock by minutes: each 120 ms beat would otherwise run, thousands of them.
 */
const STILL_GLOW = {
  plugins: [
    {
      name: 'still-glow',
      tier: 'prepend',
      register(on) {
        on('clock.every', () => ({ deny: 'the glow is not under test' }))
      },
    },
  ],
} as const satisfies TestOptions

function fakeEngine(on: On, world: World): void {
  mock.store(on)
  mock.env(on, {})
  on('session.cwd', () => ({ value: '/work/repo' }))
  on('session.surfaces', () => ({ value: [...(world.surfacesNext.shift() ?? world.surfaces)] as never }))
  on('command.list', () => ({ value: [ASK_SEAN] }))
  on('ui.toast', (_$, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('model.complete', () => {
    world.judged += 1
    return { value: { isAnswered: true, text: world.haiku, usage: {} as never } }
  })
  on('process.run', (_$, e) => ({
    value: { exitCode: 0, stdout: e.argv[0] === 'git' ? 'true\n' : world.reply, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('fs.exists', (_$, e) => {
    // The engine resolves the path first, so on Windows it arrives under a drive: compared without it.
    const path = e.path.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/')
    world.exists.push(path)
    if (world.marked.includes('*throw*')) throw new Error('EACCES')
    return { value: world.marked.includes(path) }
  })
  on('http.fetch', async (_$, e) => {
    world.fetches.push({ url: e.url, method: e.init?.method ?? 'GET', headers: { ...e.init?.headers }, body: e.init?.body ?? '' })
    const reply = await (e.url === `${LAYA}/openapi.json` ? world.openapi() : e.url === `${LAYA}/v1/systemone` ? world.laya() : e.url === JEV ? world.jev() : 'refused')
    if (reply === 'refused') throw new Error('connect ECONNREFUSED')
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)
    return { value: { status: reply.status, ok: reply.status >= 200 && reply.status < 300, headers: {}, text } }
  })
}

const submit = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as const
const turn = (answer: string) => ({ answer, durationMs: 10, isAborted: false, turnId: 't', reason: 'answer' }) as const

/** Lists the steps and makes "Triage incoming bugs" the active one. */
async function startTriage($: Engine): Promise<Mounted<'terminal', 'Pane'>> {
  const pane = await $.ui.mount(MOUNT)
  await pane.press({ key: 'refresh' })
  await $.prompt.submit(submit('/triage'))
  return pane
}

async function titles(pane: Mounted<'terminal', 'Pane'>): Promise<string[]> {
  return (await pane.findAll({ type: 'Button' })).filter(button => button.key?.startsWith('open-')).map(button => button.text ?? '')
}

const fetched = (world: World, url: string) => world.fetches.filter(request => request.url === url)

test('Laya sure the step is done drops it with no Haiku call; sure it is not keeps it, with none either', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  let noul = 0.05
  world.laya = () => ({ status: 200, body: layaAnswer(noul) })

  const pane = await startTriage($)
  await $.turn.complete(turn('Labelled two of the three.'))
  await clock.settle()
  expect(await titles(pane)).toEqual(['Push the auth branch and open its PR', 'Triage incoming bugs'])
  expect(world.judged).toBe(0)

  noul = 0.95
  await $.turn.complete(turn('All three are triaged.'))
  await clock.settle()
  expect(await titles(pane)).toEqual(['Push the auth branch and open its PR'])
  expect(world.judged).toBe(0)
  expect(world.toasts).toContain(`What's next: done with "Triage incoming bugs".`)
  expect(fetched(world, JEV)).toEqual([])
  await pane.unmount()
})

/** A reply the test settles later, to hold a request open. */
function held(): { reply: Promise<{ status: number; body: unknown }>; answer: (status: number, body: unknown) => void } {
  let answer: (status: number, body: unknown) => void = () => {}
  const reply = new Promise<{ status: number; body: unknown }>(resolve => (answer = (status, body) => resolve({ status, body })))
  return { reply, answer }
}

test('between the thresholds, a cut answer, a failed request and a timeout each run the Haiku judge, and the bound is 5 s', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  const pane = await startTriage($)

  world.laya = () => ({ status: 200, body: layaAnswer(0.5) })
  await $.turn.complete(turn('Labelled two of the three.'))
  await clock.settle()
  expect(world.judged).toBe(1)

  world.laya = () => ({ status: 200, body: layaAnswer(0.97, true) })
  await $.turn.complete(turn('Labelled two of the three.'))
  await clock.settle()
  expect(world.judged).toBe(2)
  expect(await titles(pane)).toContain('Triage incoming bugs')

  world.laya = () => ({ status: 503, body: { detail: 'server busy, try again later' } })
  await $.turn.complete(turn('Labelled two of the three.'))
  await clock.settle()
  expect(world.judged).toBe(3)

  // Past the window that failure opened, Laya is asked again and never answers.
  await clock.advance(30_000)
  const hung = held()
  world.laya = () => hung.reply
  await $.turn.complete(turn('Labelled two of the three.'))
  await clock.advance(4_999)
  expect(world.judged).toBe(3)
  await clock.advance(1)
  expect(world.judged).toBe(4)
  expect(await titles(pane)).toContain('Triage incoming bugs')
  await pane.unmount()
})

const LOCAL_FIRST = { options: { modelChoice: 'local first', jevApiKey: 'ts-test-key' } } as const
const HOSTED_FIRST = { options: { modelChoice: 'hosted first', jevApiKey: 'ts-test-key' } } as const

test('an ask that finds Laya still busy takes the Haiku judge at once, asks no other model and leaves Laya available', LOCAL_FIRST, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  world.jev = () => ({ status: 200, body: jevAnswer(0.95) })
  const pane = await startTriage($)

  const first = held()
  world.laya = () => first.reply
  await $.turn.complete(turn('Labelled one of the three.'))
  await clock.settle()
  expect(fetched(world, `${LAYA}/v1/systemone`).length).toBe(1)

  // The first ask's request is still open: the second takes the fallback without a request of its own.
  await clock.advance(1_000)
  await $.turn.complete(turn('Labelled two of the three.'))
  await clock.settle()
  expect(world.judged).toBe(1)
  expect(fetched(world, `${LAYA}/v1/systemone`).length).toBe(1)
  expect(fetched(world, JEV)).toEqual([])

  // The first request answers within its bound: sure the step is not done.
  first.answer(200, layaAnswer(0.05))
  await clock.settle()
  expect(world.judged).toBe(1)

  // Busy was not a failure: the next ask goes straight to Laya, with no identity check before it.
  world.laya = () => ({ status: 200, body: layaAnswer(0.05) })
  await $.turn.complete(turn('Labelled all but one.'))
  await clock.settle()
  expect(fetched(world, `${LAYA}/v1/systemone`).length).toBe(2)
  expect(fetched(world, `${LAYA}/openapi.json`).length).toBe(1)
  expect(world.judged).toBe(1)
  await pane.unmount()
})

test('a request that lost its race holds Laya until the server answers', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  const pane = await startTriage($)

  const late = held()
  world.laya = () => late.reply
  await $.turn.complete(turn('Labelled one of the three.'))
  await clock.advance(5_000)
  expect(world.judged).toBe(1)

  // Past the 30 s window the timeout opened, the old request is still open: no new one is sent.
  await clock.advance(30_000)
  await $.turn.complete(turn('Labelled two of the three.'))
  await clock.settle()
  expect(world.judged).toBe(2)
  expect(fetched(world, `${LAYA}/v1/systemone`).length).toBe(1)

  // Once it answers, the slot is free again; the late answer itself changes nothing.
  late.answer(200, layaAnswer(0.99))
  await clock.settle()
  expect(await titles(pane)).toContain('Triage incoming bugs')
  world.laya = () => ({ status: 200, body: layaAnswer(0.05) })
  await $.turn.complete(turn('Labelled all but one.'))
  await clock.settle()
  expect(fetched(world, `${LAYA}/v1/systemone`).length).toBe(2)
  expect(world.judged).toBe(2)
  await pane.unmount()
})

test('each failure in a row keeps Laya unavailable twice as long, up to 5 min; a readable answer starts over at 30 s', STILL_GLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  const pane = await startTriage($)
  const asks = () => fetched(world, `${LAYA}/openapi.json`).length
  const judgeAt = async (wait: number) => {
    await clock.advance(wait)
    await $.turn.complete(turn('Labelled two of the three.'))
    await clock.settle()
  }

  // Refused: 30 s, 60 s, 120 s, 240 s, then 300 s twice.
  await judgeAt(0)
  expect(asks()).toBe(1)
  let expected = 1
  for (const window of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
    await judgeAt(window - 1)
    expect(asks()).toBe(expected)
    await judgeAt(1)
    expected += 1
    expect(asks()).toBe(expected)
  }

  // Laya comes up: its answer is readable, so the next failure opens a 30 s window again.
  const before = fetched(world, `${LAYA}/v1/systemone`).length
  const sent = () => fetched(world, `${LAYA}/v1/systemone`).length - before
  world.laya = () => ({ status: 200, body: layaAnswer(0.5) })
  await judgeAt(300_000)
  expect(sent()).toBe(1)
  world.laya = () => ({ status: 500, body: { detail: 'inference failed' } })
  await judgeAt(1)
  expect(sent()).toBe(2)
  await judgeAt(29_999)
  expect(sent()).toBe(2)
  world.laya = () => ({ status: 200, body: layaAnswer(0.5) })
  await judgeAt(1)
  expect(sent()).toBe(3)
  // Every Haiku ask was the fallback: a model's failure never stops the judge.
  expect(world.judged).toBe(17)
  await pane.unmount()
})

test('the identity check runs before the first ask and again after each window Laya was unavailable, and another app on the port fails it', STILL_GLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  const pane = await startTriage($)
  world.laya = () => ({ status: 200, body: layaAnswer(0.5) })

  await $.turn.complete(turn('Labelled one of the three.'))
  await clock.settle()
  await $.turn.complete(turn('Labelled two of the three.'))
  await clock.settle()
  expect(world.fetches.map(request => request.url)).toEqual([
    `${LAYA}/openapi.json`,
    `${LAYA}/v1/systemone`,
    `${LAYA}/v1/systemone`,
  ])

  // Laya stops and another FastAPI app takes the port: Laya fails, and after its window the check runs again and fails.
  world.laya = () => 'refused'
  await $.turn.complete(turn('Labelled two of the three.'))
  await clock.settle()
  world.openapi = () => ({ status: 200, body: { openapi: '3.1.0', info: { title: 'FastAPI', version: '0.1.0' }, paths: { '/health': {} } } })
  world.laya = () => ({ status: 200, body: layaAnswer(0.99) })
  await clock.advance(30_000)
  await $.turn.complete(turn('All three are triaged.'))
  await clock.settle()
  expect(world.fetches.map(request => request.url).slice(3)).toEqual([`${LAYA}/v1/systemone`, `${LAYA}/openapi.json`])
  expect(await titles(pane)).toContain('Triage incoming bugs')

  // A check answered with something other than 200, or that is not JSON, fails as well.
  for (const reply of [{ status: 404, body: LAYA_OPENAPI }, { status: 200, body: '<html>laya-serve</html>' }]) {
    world.openapi = () => reply
    await clock.advance(300_000)
    await $.turn.complete(turn('All three are triaged.'))
    await clock.settle()
    expect(fetched(world, `${LAYA}/v1/systemone`).length).toBe(3)
  }

  // Laya is back on its port: the check passes, then the ask goes out.
  world.openapi = () => ({ status: 200, body: LAYA_OPENAPI })
  await clock.advance(300_000)
  await $.turn.complete(turn('All three are triaged.'))
  await clock.settle()
  expect(world.fetches.map(request => request.url).slice(-2)).toEqual([`${LAYA}/openapi.json`, `${LAYA}/v1/systemone`])
  expect(await titles(pane)).toEqual(['Push the auth branch and open its PR'])
  await pane.unmount()
})

/** The step whose prompt is submitted in these tests, as the skill's reply gives it. */
const TRIAGE = { title: 'Triage incoming bugs', why: 'Three new issues arrived overnight.', prompt: '/triage' }

test('under local first Jev is asked only while Laya is unavailable, with the key in its header alone and the verdict\'s text alone', LOCAL_FIRST, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  world.jev = () => ({ status: 200, body: jevAnswer(0.05) })
  const pane = await startTriage($)

  // Laya is refused: this judgment falls back, and does not ask Jev too.
  await $.turn.complete(turn('Labelled two of the three.'))
  await clock.settle()
  expect(fetched(world, JEV)).toEqual([])
  expect(world.judged).toBe(1)

  // While Laya is unavailable, Jev answers alone.
  await $.turn.complete(turn('Labelled two of the three.'))
  await clock.settle()
  expect(world.judged).toBe(1)
  const [ask] = fetched(world, JEV)
  expect(ask?.method).toBe('POST')
  expect(ask?.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer ts-test-key' })
  const body = JSON.parse(ask?.body ?? '{}') as Record<string, unknown>
  expect(Object.keys(body).sort()).toEqual(['model', 'questions', 'state'])
  expect(body.model).toBe('jev-latest')
  expect(body.state).toBe(
    ['Step: Triage incoming bugs', 'Why: Three new issues arrived overnight.', '<prompt>', '/triage', '</prompt>', '<message>', 'Labelled two of the three.', '</message>'].join('\n'),
  )
  expect(Object.keys(body.questions as object)).toEqual(['finished'])

  // Neither the key nor any address built from a setting reaches a URL; Laya never gets an Authorization header.
  for (const request of world.fetches) {
    expect(request.url).not.toContain('ts-test-key')
    expect([`${LAYA}/openapi.json`, `${LAYA}/v1/systemone`, JEV]).toContain(request.url)
    if (request.url !== JEV) expect(Object.keys(request.headers).map(name => name.toLowerCase())).not.toContain('authorization')
  }
  await pane.unmount()
})

test('Jev is sent the last 8,000 characters of the answer, and the whole step', LOCAL_FIRST, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  world.jev = () => ({ status: 200, body: jevAnswer(0.05) })
  const pane = await startTriage($)
  await $.turn.complete(turn('Labelled two of the three.'))
  await clock.settle()

  const answer = `${'x'.repeat(500)}${'y'.repeat(8_000)}`
  await $.turn.complete(turn(answer))
  await clock.settle()
  const state = String((JSON.parse(fetched(world, JEV)[0]?.body ?? '{}') as { state?: unknown }).state)
  expect(state).toContain(`<message>\n${'y'.repeat(8_000)}\n</message>`)
  expect(state).not.toContain('x')
  expect(state).toContain(`<prompt>\n${TRIAGE.prompt}\n</prompt>`)
  await pane.unmount()
})

test('under hosted first Jev is asked first, and Laya only while Jev is unavailable; a judgment never asks both', HOSTED_FIRST, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  world.laya = () => ({ status: 200, body: layaAnswer(0.05) })
  world.jev = () => ({ status: 529, body: { detail: 'overloaded' } })
  const pane = await startTriage($)

  await $.turn.complete(turn('Labelled two of the three.'))
  await clock.settle()
  expect(world.fetches.map(request => request.url)).toEqual([JEV])
  expect(world.judged).toBe(1)

  await $.turn.complete(turn('Labelled two of the three.'))
  await clock.settle()
  expect(world.fetches.map(request => request.url)).toEqual([JEV, `${LAYA}/openapi.json`, `${LAYA}/v1/systemone`])
  expect(world.judged).toBe(1)

  // Jev's window over, it is first again, and its sure answer drops the step.
  world.jev = () => ({ status: 200, body: jevAnswer(0.93) })
  await clock.advance(30_000)
  await $.turn.complete(turn('All three are triaged.'))
  await clock.settle()
  expect(world.fetches.map(request => request.url).slice(3)).toEqual([JEV])
  expect(await titles(pane)).toEqual(['Push the auth branch and open its PR'])
  await pane.unmount()
})

test('under local only nothing goes to api.typesafe.ai, whatever key is set, and with Laya down the judge is Haiku as before', { options: { jevApiKey: 'ts-test-key' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  world.jev = () => ({ status: 200, body: jevAnswer(0.99) })
  world.haiku = 'DONE'
  const pane = await startTriage($)

  await $.turn.complete(turn('All three are triaged.'))
  await clock.settle()
  expect(fetched(world, JEV)).toEqual([])
  expect(world.exists).toEqual([])
  expect(world.judged).toBe(1)
  expect(await titles(pane)).toEqual(['Push the auth branch and open its PR'])
  // Local only names no key, set or not.
  expect(await pane.find({ type: 'Text', text: /Jev API key/ })).toBeUndefined()
  await pane.unmount()
})

test('a key Jev rejects keeps Jev off for the rest of the module\'s life, Laya still answers, and the pane names it', { ...HOSTED_FIRST, ...STILL_GLOW }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  world.laya = () => ({ status: 200, body: layaAnswer(0.05) })
  world.jev = () => ({ status: 401, body: { detail: 'invalid api key' } })
  const pane = await startTriage($)
  expect(await pane.find({ type: 'Text', text: /Jev API key/ })).toBeUndefined()

  await $.turn.complete(turn('Labelled two of the three.'))
  await clock.settle()
  expect(world.judged).toBe(1)
  expect(await pane.find({ type: 'Text', text: /TypeSafe rejected What's next's "Jev API key".*reloads/ })).toBeDefined()
  // The list is still there under the line.
  expect(await titles(pane)).toEqual(['Push the auth branch and open its PR', 'Triage incoming bugs'])

  // An hour on, Jev is still never asked: Laya is, and answers.
  world.jev = () => ({ status: 200, body: jevAnswer(0.99) })
  for (const wait of [0, 3_600_000]) {
    await clock.advance(wait)
    await $.turn.complete(turn('Labelled two of the three.'))
    await clock.settle()
  }
  expect(fetched(world, JEV).length).toBe(1)
  expect(fetched(world, `${LAYA}/v1/systemone`).length).toBe(2)
  expect(world.judged).toBe(1)
  await pane.unmount()
})

test('a 403 from Jev is a rejected key too', LOCAL_FIRST, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  world.jev = () => ({ status: 403, body: { detail: 'forbidden' } })
  const pane = await startTriage($)
  for (let turns = 0; turns < 3; turns += 1) {
    await $.turn.complete(turn('Labelled two of the three.'))
    await clock.settle()
  }
  expect(fetched(world, JEV).length).toBe(1)
  expect(await pane.find({ type: 'Text', text: /TypeSafe rejected/ })).toBeDefined()
  await pane.unmount()
})

test('under a choice that allows Jev, an absent key is named in the pane and nothing goes to Jev', { options: { modelChoice: 'local first' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  const pane = await startTriage($)
  expect(await pane.find({ type: 'Text', text: /no "Jev API key" is set/ })).toBeDefined()
  expect(await titles(pane)).toEqual(['Push the auth branch and open its PR', 'Triage incoming bugs'])
  for (let turns = 0; turns < 2; turns += 1) {
    await $.turn.complete(turn('Labelled two of the three.'))
    await clock.settle()
  }
  expect(fetched(world, JEV)).toEqual([])
  expect(world.judged).toBe(2)
  await pane.unmount()
})

for (const key of ['ts test key', 'ts-k\u00e9y', 'ts-key\u0007']) {
  test(`a key that is not printable ASCII without spaces (${JSON.stringify(key)}) is named in the pane and never sent`, { options: { modelChoice: 'local first', jevApiKey: key } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const world = newWorld()
    fakeEngine(on, world)
    world.jev = () => ({ status: 200, body: jevAnswer(0.05) })
    const pane = await startTriage($)
    expect(await pane.find({ type: 'Text', text: /"Jev API key" is not a key/ })).toBeDefined()
    for (let turns = 0; turns < 2; turns += 1) {
      await $.turn.complete(turn('Labelled two of the three.'))
      await clock.settle()
    }
    expect(fetched(world, JEV)).toEqual([])
    expect(world.judged).toBe(2)
    await pane.unmount()
  })
}

test('a key is trimmed before it is sent', { options: { modelChoice: 'hosted first', jevApiKey: '  ts-test-key\n' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  world.jev = () => ({ status: 200, body: jevAnswer(0.05) })
  const pane = await startTriage($)
  await $.turn.complete(turn('Labelled two of the three.'))
  await clock.settle()
  expect(fetched(world, JEV)[0]?.headers.Authorization).toBe('Bearer ts-test-key')
  expect(await pane.find({ type: 'Text', text: /Jev API key/ })).toBeUndefined()
  await pane.unmount()
})

test('Laya is asked at 127.0.0.1 on the Laya port setting', { options: { layaPort: 8123 } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  const pane = await startTriage($)
  await $.turn.complete(turn('Labelled two of the three.'))
  await clock.settle()
  expect(world.fetches.map(request => request.url)).toEqual(['http://127.0.0.1:8123/openapi.json'])
  await pane.unmount()
})

for (const layaPort of [0, 65_536, 8000.5, -1]) {
  test(`a Laya port of ${layaPort} reads as 8000`, { options: { layaPort } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const world = newWorld()
    fakeEngine(on, world)
    const pane = await startTriage($)
    await $.turn.complete(turn('Labelled two of the three.'))
    await clock.settle()
    expect(world.fetches.map(request => request.url)).toEqual([`${LAYA}/openapi.json`, `${LAYA}/v1/systemone`])
    await pane.unmount()
  })
}

test('an answer of the wrong shape is unreadable: the Haiku judge runs and the model is unavailable for a while', { ...HOSTED_FIRST, ...STILL_GLOW }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  world.laya = () => ({ status: 200, body: layaAnswer(0.99) })
  const pane = await startTriage($)
  const unreadable: unknown[] = [
    'not json',
    { answers: { finished: { type: 'noul', noul: 0.99 } } },
    { model: 'jev-1.13.0', answers: { finished: { type: 'noul', noul: 0.99 }, extra: { type: 'noul', noul: 0.5 } } },
    { model: 'jev-1.13.0', answers: { done: { type: 'noul', noul: 0.99 } } },
    { model: 'jev-1.13.0', answers: { finished: { type: 'choice', choice: 'yes' } } },
    { model: 'jev-1.13.0', answers: { finished: { type: 'noul', noul: 1.5 } } },
    { model: 'jev-1.13.0', answers: { finished: { type: 'noul', noul: '0.99' } } },
  ]
  let window = 30_000
  for (const body of unreadable) {
    world.jev = () => ({ status: 200, body })
    const before = fetched(world, JEV).length
    await $.turn.complete(turn('All three are triaged.'))
    await clock.settle()
    expect(fetched(world, JEV).length).toBe(before + 1)
    expect(await titles(pane)).toContain('Triage incoming bugs')
    // Jev is unavailable now: Laya is asked in its place, sure the step is not done.
    world.laya = () => ({ status: 200, body: layaAnswer(0.01) })
    await $.turn.complete(turn('All three are triaged.'))
    await clock.settle()
    expect(fetched(world, JEV).length).toBe(before + 1)
    await clock.advance(window)
    window = Math.min(window * 2, 300_000)
  }
  expect(world.judged).toBe(unreadable.length)
  await pane.unmount()
})

test('a Laya answer without its usage facts is unreadable', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  world.laya = () => ({ status: 200, body: jevAnswer(0.99) })
  const pane = await startTriage($)
  await $.turn.complete(turn('All three are triaged.'))
  await clock.settle()
  expect(world.judged).toBe(1)
  world.laya = () => ({ status: 200, body: layaAnswer(0.99) })
  await $.turn.complete(turn('All three are triaged.'))
  await clock.settle()
  expect(fetched(world, `${LAYA}/v1/systemone`).length).toBe(1)
  await pane.unmount()
})

test('the client reads an unrecognised model choice as local only, and then never looks at the key', () => {
  expect(parseSystemOne({ modelChoice: 'everywhere', jevApiKey: 'ts-test-key' })).toEqual({
    modelChoice: 'local only',
    keyState: undefined,
    key: undefined,
    layaPort: 8000,
  })
  expect(keyProblem(parseSystemOne({ modelChoice: 'local only', jevApiKey: 'not a key' }))).toBeUndefined()
  expect(keyProblem(parseSystemOne({ modelChoice: 'hosted first' }))).toBe('absent')
})

test('before each call to Jev the session\'s folder and every folder above it are checked for the local-only mark, one check a level', HOSTED_FIRST, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  world.laya = () => ({ status: 200, body: layaAnswer(0.05) })
  world.jev = () => ({ status: 200, body: jevAnswer(0.05) })
  const pane = await startTriage($)

  await $.turn.complete(turn('Labelled two of the three.'))
  await clock.settle()
  expect(world.exists).toEqual(['/work/repo/.claude/system-one-local-only', '/work/.claude/system-one-local-only', '/.claude/system-one-local-only'])
  expect(fetched(world, JEV).length).toBe(1)

  // Marked mid-session above the folder: the next judgment sends nothing to Jev and asks Laya.
  world.marked.push('/work/.claude/system-one-local-only')
  world.exists.length = 0
  await $.turn.complete(turn('Labelled two of the three.'))
  await clock.settle()
  expect(world.exists).toEqual(['/work/repo/.claude/system-one-local-only', '/work/.claude/system-one-local-only'])
  expect(fetched(world, JEV).length).toBe(1)
  expect(fetched(world, `${LAYA}/v1/systemone`).length).toBe(1)

  // A lookup that cannot complete counts as marked.
  world.marked = ['*throw*']
  await $.turn.complete(turn('Labelled two of the three.'))
  await clock.settle()
  expect(fetched(world, JEV).length).toBe(1)
  expect(fetched(world, `${LAYA}/v1/systemone`).length).toBe(2)
  expect(world.judged).toBe(0)
  await pane.unmount()
})

test('under local first a marked folder leaves the judgment to Haiku while Laya is unavailable', LOCAL_FIRST, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  world.jev = () => ({ status: 200, body: jevAnswer(0.05) })
  world.marked = ['/.claude/system-one-local-only']
  const pane = await startTriage($)
  for (let turns = 0; turns < 2; turns += 1) {
    await $.turn.complete(turn('Labelled two of the three.'))
    await clock.settle()
  }
  expect(fetched(world, JEV)).toEqual([])
  expect(world.exists.length).toBe(3)
  expect(world.judged).toBe(2)
  await pane.unmount()
})

test('a session no surface shows asks neither model', HOSTED_FIRST, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  world.laya = () => ({ status: 200, body: layaAnswer(0.99) })
  world.jev = () => ({ status: 200, body: jevAnswer(0.99) })
  const pane = await startTriage($)

  world.surfaces = []
  await $.turn.complete(turn('All three are triaged.'))
  await clock.settle()
  expect(world.fetches).toEqual([])
  expect(world.exists).toEqual([])

  // The last surface leaves after the turn hook looked but before the client asks: the client asks no model either.
  world.surfaces = ['terminal']
  world.surfacesNext = [['terminal'], []]
  await $.turn.complete(turn('All three are triaged.'))
  await clock.settle()
  expect(world.fetches).toEqual([])
  expect(world.exists).toEqual([])
  expect(await titles(pane)).toContain('Triage incoming bugs')
  await pane.unmount()
})

const LONG_PROMPT_REPLY = [
  '### Triage incoming bugs',
  'Three new issues arrived overnight.',
  'Prompt =',
  FENCE,
  `/triage ${'with care '.repeat(60).trim()}`,
  FENCE,
].join('\n')

test('what is sent to Laya fits its window: the whole message when it fits, else the prompt is dropped before the end of the answer is cut', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = newWorld()
  fakeEngine(on, world)
  world.reply = LONG_PROMPT_REPLY
  world.laya = () => ({ status: 200, body: layaAnswer(0.05) })
  const pane = await $.ui.mount(MOUNT)
  await pane.press({ key: 'refresh' })
  const prompt = `/triage ${'with care '.repeat(60).trim()}`
  await $.prompt.submit(submit(prompt))
  const sent = () => String((JSON.parse(fetched(world, `${LAYA}/v1/systemone`).at(-1)?.body ?? '{}') as { state?: unknown }).state)

  // A short answer and the prompt fit together.
  await $.turn.complete(turn('Labelled two of the three.'))
  await clock.settle()
  expect(sent()).toBe(['Step: Triage incoming bugs', 'Why: Three new issues arrived overnight.', '<prompt>', prompt, '</prompt>', '<message>', 'Labelled two of the three.', '</message>'].join('\n'))

  // A long answer: the prompt goes first, then the answer is cut from its start, its end kept.
  const answer = `${'a'.repeat(3_000)} All three are triaged; nothing is left.`
  await $.turn.complete(turn(answer))
  await clock.settle()
  const state = sent()
  expect(state.startsWith('Step: Triage incoming bugs\nWhy: Three new issues arrived overnight.\n<message>\n')).toBe(true)
  expect(state.endsWith('All three are triaged; nothing is left.\n</message>')).toBe(true)
  expect(state).not.toContain('<prompt>')
  expect(state).not.toContain('with care')
  expect(state.length).toBe(1_200)
  await pane.unmount()
})
