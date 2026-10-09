// The System One client's own tests (ADR-0004), against a fake SystemOneIo: the
// client's rules are proved here once, not through each mod that carries a copy.
// Run by `node --test` (npm run test:shared), which strips the types.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Ask, SystemOneSettings } from './system-one.ts'
import { fakeIo, held, jevAnswer, JEV, laya, LAYA_OPENAPI, layaAnswer } from './system-one.fake.ts'
import type { Fake, Reading } from './system-one.fake.ts'

type Client = typeof import('./system-one.ts')

/** The client keeps state per module (windows, the rejected key), so each test loads its own instance. */
let loads = 0
async function load(): Promise<Client> {
  return (await import(`./system-one.ts?fresh=${(loads += 1)}`)) as Client
}

const LAYA = laya()
const KEY = 'ts-test-key'

const question = { type: 'noul', instructions: 'Is it done?' } as const
const ask = (overrides: Partial<Ask> = {}): Ask => ({ boundMs: 5_000, questions: { finished: question }, state: { laya: 'laya text', jev: 'jev text' }, ...overrides })

type Options = Record<string, unknown>
const LOCAL_FIRST: Options = { modelChoice: 'local first', jevApiKey: KEY }
const HOSTED_FIRST: Options = { modelChoice: 'hosted first', jevApiKey: KEY }

const done = (noul: number): Reading => ({ finished: { noul } })

/** Starts an ask and reports whether it has settled, so a test can watch a bound run out. */
function watch<T>(promise: Promise<T>): { isSettled: () => boolean; result: Promise<T> } {
  let settled = false
  const result = promise.finally(() => {
    settled = true
  })
  return { isSettled: () => settled, result }
}

async function setup(options: Options = {}, fakeOptions: { port?: number } = {}): Promise<{ client: Client; fake: Fake; settings: SystemOneSettings; once: (overrides?: Partial<Ask>) => ReturnType<Client['askSystemOne']> }> {
  const client = await load()
  const fake = fakeIo(fakeOptions)
  const settings = client.parseSystemOne(options)
  return { client, fake, settings, once: overrides => client.askSystemOne(fake.io, settings, ask(overrides)) }
}

// --- the answer a judgment gets back ---------------------------------------------------------

test('Laya is asked after the identity check, and its readable answer comes back with the model that gave it', async () => {
  const { fake, once } = await setup()
  fake.laya = () => ({ status: 200, body: layaAnswer(done(0.9)) })
  assert.deepEqual(await once(), { backend: 'laya', answers: { finished: { type: 'noul', noul: 0.9 } } })
  assert.deepEqual(fake.calls.map(call => `${call.method} ${call.url}`), [`GET ${LAYA}/openapi.json`, `POST ${LAYA}/v1/systemone`])
  const body = JSON.parse(fake.calls[1]?.body ?? '{}') as Record<string, unknown>
  assert.deepEqual(Object.keys(body).sort(), ['questions', 'state'])
  assert.equal(body.state, 'laya text')
  assert.deepEqual(body.questions, { finished: question })
})

test('a Choice answer keeps its confidence when it is between 0 and 1, and drops it otherwise', async () => {
  const { fake, once } = await setup()
  const questions = { kind: { type: 'choice', instructions: 'Which?', criteria: { a: 'A', b: 'B' } } } as const
  fake.laya = () => ({ status: 200, body: layaAnswer({ kind: { choice: 'a', confidence: 0.8 } }) })
  assert.deepEqual((await once({ questions }))?.answers, { kind: { type: 'choice', choice: 'a', confidence: 0.8 } })
  fake.laya = () => ({ status: 200, body: layaAnswer({ kind: { choice: 'b', confidence: 1.5 } }) })
  assert.deepEqual((await once({ questions }))?.answers, { kind: { type: 'choice', choice: 'b', confidence: undefined } })
  fake.laya = () => ({ status: 200, body: layaAnswer({ kind: { choice: 'c', confidence: 0.9 } }) })
  assert.equal(await once({ questions }), undefined)
})

test('Laya is asked at 127.0.0.1 on the Laya port setting', async () => {
  const { fake, once } = await setup({ layaPort: 8123 }, { port: 8123 })
  fake.laya = () => ({ status: 200, body: layaAnswer(done(0.5)) })
  await once()
  assert.deepEqual(fake.calls.map(call => call.url), ['http://127.0.0.1:8123/openapi.json', 'http://127.0.0.1:8123/v1/systemone'])
})

for (const layaPort of [0, 65_536, 8000.5, -1, '8123', undefined]) {
  test(`a Laya port of ${String(layaPort)} reads as 8000`, async () => {
    const client = await load()
    assert.equal(client.parseSystemOne({ layaPort }).layaPort, 8000)
  })
}

test('the client reads an unrecognised model choice as local only, and then never looks at the key', async () => {
  const client = await load()
  assert.deepEqual(client.parseSystemOne({ modelChoice: 'everywhere', jevApiKey: KEY }), { modelChoice: 'local only', keyState: undefined, key: undefined, layaPort: 8000 })
  assert.equal(client.keyProblem(client.parseSystemOne({ modelChoice: 'local only', jevApiKey: 'not a key' })), undefined)
  assert.equal(client.keyProblem(client.parseSystemOne({ modelChoice: 'hosted first' })), 'absent')
})

// --- the identity check ----------------------------------------------------------------------

test('the identity check runs before the first ask and again after each window Laya was unavailable, and another app on the port fails it', async () => {
  const { fake, once } = await setup()
  fake.laya = () => ({ status: 200, body: layaAnswer(done(0.5)) })
  await once()
  await once()
  assert.deepEqual(fake.calls.map(call => call.url), [`${LAYA}/openapi.json`, `${LAYA}/v1/systemone`, `${LAYA}/v1/systemone`])

  // Laya stops and another FastAPI app takes the port: Laya fails, and after its window the check runs again and fails.
  fake.laya = () => 'refused'
  assert.equal(await once(), undefined)
  fake.openapi = () => ({ status: 200, body: { openapi: '3.1.0', info: { title: 'FastAPI', version: '0.1.0' }, paths: { '/health': {} } } })
  fake.laya = () => ({ status: 200, body: layaAnswer(done(0.99)) })
  await fake.advance(30_000)
  assert.equal(await once(), undefined)
  assert.deepEqual(fake.calls.map(call => call.url).slice(3), [`${LAYA}/v1/systemone`, `${LAYA}/openapi.json`])

  // A check answered with something other than 200, or that is not JSON, or whose paths lack the route, fails as well.
  for (const reply of [
    { status: 404, body: LAYA_OPENAPI },
    { status: 200, body: '<html>laya-serve</html>' },
    { status: 200, body: { info: { title: 'laya-serve' }, paths: { '/health': {} } } },
  ]) {
    fake.openapi = () => reply
    await fake.advance(300_000)
    assert.equal(await once(), undefined)
  }
  assert.equal(fake.to(`${LAYA}/v1/systemone`).length, 3)

  // Laya is back on its port: the check passes, then the ask goes out.
  fake.openapi = () => ({ status: 200, body: LAYA_OPENAPI })
  await fake.advance(300_000)
  assert.equal((await once())?.backend, 'laya')
  assert.deepEqual(fake.calls.map(call => call.url).slice(-2), [`${LAYA}/openapi.json`, `${LAYA}/v1/systemone`])
})

// --- unavailable for a while -----------------------------------------------------------------

test('each failure in a row keeps Laya unavailable twice as long, up to 5 min; a readable answer starts over at 30 s', async () => {
  const { fake, once } = await setup()
  const asks = () => fake.to(`${LAYA}/openapi.json`).length

  assert.equal(await once(), undefined)
  assert.equal(asks(), 1)
  let expected = 1
  for (const window of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
    await fake.advance(window - 1)
    assert.equal(await once(), undefined)
    assert.equal(asks(), expected, `still unavailable ${window - 1} ms after the failure`)
    await fake.advance(1)
    assert.equal(await once(), undefined)
    expected += 1
    assert.equal(asks(), expected, `asked again ${window} ms after the failure`)
  }

  // Laya comes up: its answer is readable, so the next failure opens a 30 s window again.
  const sent = () => fake.to(`${LAYA}/v1/systemone`).length
  fake.laya = () => ({ status: 200, body: layaAnswer(done(0.5)) })
  await fake.advance(300_000)
  assert.equal((await once())?.backend, 'laya')
  const first = sent()
  fake.laya = () => ({ status: 500, body: { detail: 'inference failed' } })
  assert.equal(await once(), undefined)
  assert.equal(sent(), first + 1)
  await fake.advance(29_999)
  assert.equal(await once(), undefined)
  assert.equal(sent(), first + 1)
  fake.laya = () => ({ status: 200, body: layaAnswer(done(0.5)) })
  await fake.advance(1)
  assert.equal((await once())?.backend, 'laya')
  assert.equal(sent(), first + 2)
})

test('a status other than 2xx and a refused connection are each a failure that opens a window', async () => {
  for (const reply of [{ status: 503, body: { detail: 'busy' } }, { status: 301, body: '' }, 'refused' as const]) {
    const { fake, once } = await setup()
    fake.laya = () => reply
    assert.equal(await once(), undefined)
    const sent = fake.calls.length
    assert.equal(await once(), undefined)
    assert.equal(fake.calls.length, sent, 'nothing is sent while the window is open')
    await fake.advance(30_000)
    assert.equal(await once(), undefined)
    assert.ok(fake.calls.length > sent, 'asked again once the window is over')
  }
})

test('a reading Laya reports as cut counts as no answer, and is not a failure', async () => {
  const { fake, once } = await setup()
  fake.laya = () => ({ status: 200, body: layaAnswer(done(0.97), true) })
  assert.equal(await once(), undefined)
  fake.laya = () => ({ status: 200, body: layaAnswer(done(0.97)) })
  assert.equal((await once())?.backend, 'laya')
  assert.equal(fake.to(`${LAYA}/openapi.json`).length, 1)
})

// --- the bound and the one call in flight ----------------------------------------------------

test('a call that outlasts its bound is no answer, and the model is unavailable for 30 s', async () => {
  const { fake, once } = await setup()
  const hung = held()
  fake.laya = () => hung.reply
  const asked = watch(once({ boundMs: 5_000 }))
  await fake.advance(4_999)
  assert.equal(asked.isSettled(), false)
  await fake.advance(1)
  assert.equal(await asked.result, undefined)

  hung.answer(200, layaAnswer(done(0.9)))
  await fake.settle()
  const before = fake.calls.length
  await fake.advance(29_999)
  assert.equal(await once(), undefined)
  assert.equal(fake.calls.length, before)
})

test('no judgment waits longer than 10 s, whatever bound it names', async () => {
  const { client, fake, once } = await setup()
  fake.laya = () => held().reply
  const asked = watch(once({ boundMs: 60_000 }))
  await fake.advance(client.BOUND_CAP_MS - 1)
  assert.equal(asked.isSettled(), false)
  await fake.advance(1)
  assert.equal(await asked.result, undefined)
})

test('an ask that finds Laya still busy takes the fallback at once, asks no other model and leaves Laya available', async () => {
  const { fake, once } = await setup(LOCAL_FIRST)
  fake.jev = () => ({ status: 200, body: jevAnswer(done(0.95)) })
  const first = held()
  fake.laya = () => first.reply
  const open = watch(once({ boundMs: 5_000 }))
  await fake.advance(0)
  assert.equal(fake.to(`${LAYA}/v1/systemone`).length, 1)

  // The first ask's request is still open: the second takes the fallback without a request of its own.
  await fake.advance(1_000)
  assert.equal(await once(), undefined)
  assert.equal(fake.to(`${LAYA}/v1/systemone`).length, 1)
  assert.deepEqual(fake.to(JEV), [])

  // The first request answers within its bound.
  first.answer(200, layaAnswer(done(0.05)))
  assert.equal((await open.result)?.backend, 'laya')

  // Busy was not a failure: the next ask goes straight to Laya, with no identity check before it.
  fake.laya = () => ({ status: 200, body: layaAnswer(done(0.05)) })
  assert.equal((await once())?.backend, 'laya')
  assert.equal(fake.to(`${LAYA}/v1/systemone`).length, 2)
  assert.equal(fake.to(`${LAYA}/openapi.json`).length, 1)
})

test('a request that lost its race holds Laya until the server answers', async () => {
  const { fake, once } = await setup()
  const late = held()
  fake.laya = () => late.reply
  const lost = watch(once({ boundMs: 5_000 }))
  await fake.advance(5_000)
  assert.equal(await lost.result, undefined)

  // Past the 30 s window the timeout opened, the old request is still open: no new one is sent.
  await fake.advance(30_000)
  assert.equal(await once(), undefined)
  assert.equal(fake.to(`${LAYA}/v1/systemone`).length, 1)

  // Once it answers, the slot is free again; the late answer itself changes nothing.
  late.answer(200, layaAnswer(done(0.99)))
  await fake.settle()
  fake.laya = () => ({ status: 200, body: layaAnswer(done(0.05)) })
  assert.deepEqual((await once())?.answers, { finished: { type: 'noul', noul: 0.05 } })
  assert.equal(fake.to(`${LAYA}/v1/systemone`).length, 2)
})

// --- which model, in what order, with what ---------------------------------------------------

test('under local first Jev is asked only while Laya is unavailable, with the key in its header alone', async () => {
  const { fake, once } = await setup(LOCAL_FIRST)
  fake.jev = () => ({ status: 200, body: jevAnswer(done(0.05)) })

  // Laya is refused: this judgment falls back, and does not ask Jev too.
  assert.equal(await once(), undefined)
  assert.deepEqual(fake.to(JEV), [])

  // While Laya is unavailable, Jev answers alone.
  assert.equal((await once())?.backend, 'jev')
  const [request] = fake.to(JEV)
  assert.equal(request?.method, 'POST')
  assert.deepEqual(request?.headers, { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` })
  const body = JSON.parse(request?.body ?? '{}') as Record<string, unknown>
  assert.deepEqual(Object.keys(body).sort(), ['model', 'questions', 'state'])
  assert.equal(body.model, 'jev-latest')
  assert.equal(body.state, 'jev text')

  // The one-host rule: the key is in no URL, every URL is one of the three addresses, and Laya never gets an Authorization header.
  for (const call of fake.calls) {
    assert.equal(call.url.includes(KEY), false)
    assert.ok([`${LAYA}/openapi.json`, `${LAYA}/v1/systemone`, JEV].includes(call.url), call.url)
    if (call.url !== JEV) assert.equal(Object.keys(call.headers).some(name => name.toLowerCase() === 'authorization'), false)
  }
})

test('under hosted first Jev is asked first, and Laya only while Jev is unavailable; a judgment never asks both', async () => {
  const { fake, once } = await setup(HOSTED_FIRST)
  fake.laya = () => ({ status: 200, body: layaAnswer(done(0.05)) })
  fake.jev = () => ({ status: 529, body: { detail: 'overloaded' } })

  assert.equal(await once(), undefined)
  assert.deepEqual(fake.calls.map(call => call.url), [JEV])

  assert.equal((await once())?.backend, 'laya')
  assert.deepEqual(fake.calls.map(call => call.url), [JEV, `${LAYA}/openapi.json`, `${LAYA}/v1/systemone`])

  // Jev's window over, it is first again.
  fake.jev = () => ({ status: 200, body: jevAnswer(done(0.93)) })
  await fake.advance(30_000)
  assert.deepEqual(await once(), { backend: 'jev', answers: { finished: { type: 'noul', noul: 0.93 } } })
  assert.deepEqual(fake.calls.map(call => call.url).slice(3), [JEV])
})

test('under local only nothing goes to api.typesafe.ai, whatever key is set, and no folder is looked at', async () => {
  const { fake, once } = await setup({ jevApiKey: KEY })
  fake.jev = () => ({ status: 200, body: jevAnswer(done(0.99)) })
  assert.equal(await once(), undefined)
  assert.equal(await once(), undefined)
  assert.deepEqual(fake.to(JEV), [])
  assert.deepEqual(fake.checked, [])
})

// --- the key ---------------------------------------------------------------------------------

for (const status of [401, 403]) {
  test(`a ${status} from Jev is a rejected key: Jev stays off for the life of the module, Laya still answers, and the key is named`, async () => {
    const { client, fake, settings, once } = await setup(HOSTED_FIRST)
    fake.laya = () => ({ status: 200, body: layaAnswer(done(0.05)) })
    fake.jev = () => ({ status: status, body: { detail: 'invalid api key' } })
    assert.equal(client.keyProblem(settings), undefined)

    assert.equal(await once(), undefined)
    assert.equal(client.keyProblem(settings), 'rejected')

    // An hour on, Jev is still never asked: Laya is, and answers.
    fake.jev = () => ({ status: 200, body: jevAnswer(done(0.99)) })
    for (const wait of [0, 3_600_000]) {
      await fake.advance(wait)
      assert.equal((await once())?.backend, 'laya')
    }
    assert.equal(fake.to(JEV).length, 1)
  })
}

test('an absent key is named under a choice that allows Jev, and nothing goes to Jev', async () => {
  const { client, fake, settings, once } = await setup({ modelChoice: 'local first' })
  fake.jev = () => ({ status: 200, body: jevAnswer(done(0.05)) })
  assert.equal(client.keyProblem(settings), 'absent')
  await once()
  await once()
  assert.deepEqual(fake.to(JEV), [])
})

for (const key of ['ts test key', 'ts-k\u00e9y', 'ts-key\u0007']) {
  test(`a key that is not printable ASCII without spaces (${JSON.stringify(key)}) is named and never sent`, async () => {
    const { client, fake, settings, once } = await setup({ modelChoice: 'local first', jevApiKey: key })
    fake.jev = () => ({ status: 200, body: jevAnswer(done(0.05)) })
    assert.equal(client.keyProblem(settings), 'malformed')
    await once()
    await once()
    assert.deepEqual(fake.to(JEV), [])
  })
}

test('a key is trimmed before it is sent', async () => {
  const { fake, once } = await setup({ modelChoice: 'hosted first', jevApiKey: '  ts-test-key\n' })
  fake.jev = () => ({ status: 200, body: jevAnswer(done(0.05)) })
  await once()
  assert.equal(fake.to(JEV)[0]?.headers.Authorization, 'Bearer ts-test-key')
})

// --- an answer of the wrong shape ------------------------------------------------------------

test('an answer of the wrong shape is unreadable: no answer, and the model is unavailable for a while', async () => {
  const unreadable: unknown[] = [
    'not json',
    { answers: { finished: { type: 'noul', noul: 0.99 } } },
    { model: 'jev-1.13.0', answers: { finished: { type: 'noul', noul: 0.99 }, extra: { type: 'noul', noul: 0.5 } } },
    { model: 'jev-1.13.0', answers: { done: { type: 'noul', noul: 0.99 } } },
    { model: 'jev-1.13.0', answers: { finished: { type: 'choice', choice: 'yes' } } },
    { model: 'jev-1.13.0', answers: { finished: { type: 'noul', noul: 1.5 } } },
    { model: 'jev-1.13.0', answers: { finished: { type: 'noul', noul: '0.99' } } },
    { model: 'jev-1.13.0', answers: [] },
  ]
  for (const body of unreadable) {
    const { fake, once } = await setup(HOSTED_FIRST)
    fake.laya = () => ({ status: 200, body: layaAnswer(done(0.01)) })
    fake.jev = () => ({ status: 200, body })
    assert.equal(await once(), undefined, JSON.stringify(body))
    assert.equal(fake.to(JEV).length, 1)
    // Jev is unavailable now: Laya is asked in its place.
    assert.equal((await once())?.backend, 'laya')
    assert.equal(fake.to(JEV).length, 1)
  }
})

test('a Laya answer without its usage facts is unreadable', async () => {
  const { fake, once } = await setup()
  fake.laya = () => ({ status: 200, body: jevAnswer(done(0.99)) })
  assert.equal(await once(), undefined)
  fake.laya = () => ({ status: 200, body: layaAnswer(done(0.99)) })
  await fake.advance(30_000)
  assert.equal((await once())?.backend, 'laya')
})

// --- the local-only mark ---------------------------------------------------------------------

const MARK = '.claude/system-one-local-only'

test('before each call to Jev the session\'s folder and every folder above it are checked for the local-only mark, one check a level', async () => {
  const { fake, once } = await setup(HOSTED_FIRST)
  fake.laya = () => ({ status: 200, body: layaAnswer(done(0.05)) })
  fake.jev = () => ({ status: 200, body: jevAnswer(done(0.05)) })

  assert.equal((await once())?.backend, 'jev')
  assert.deepEqual(fake.checked, [`/work/repo/${MARK}`, `/work/${MARK}`, `/${MARK}`])

  // Marked mid-session above the folder: the next judgment sends nothing to Jev and asks Laya.
  fake.marked.push(`/work/${MARK}`)
  fake.checked.length = 0
  assert.equal((await once())?.backend, 'laya')
  assert.deepEqual(fake.checked, [`/work/repo/${MARK}`, `/work/${MARK}`])
  assert.equal(fake.to(JEV).length, 1)

  // A lookup that cannot complete counts as marked.
  fake.marked = []
  fake.existsThrows = true
  assert.equal((await once())?.backend, 'laya')
  assert.equal(fake.to(JEV).length, 1)
})

test('a folder that is not absolute counts as marked; a Windows folder is checked a level at a time with its own separator', async () => {
  const { fake, once } = await setup(HOSTED_FIRST)
  fake.laya = () => ({ status: 200, body: layaAnswer(done(0.05)) })
  fake.jev = () => ({ status: 200, body: jevAnswer(done(0.05)) })

  fake.folder = 'work/repo'
  assert.equal((await once())?.backend, 'laya')
  assert.deepEqual(fake.to(JEV), [])

  fake.folder = 'C:\\work\\repo'
  assert.equal((await once())?.backend, 'jev')
  assert.deepEqual(fake.checked, ['C:\\work\\repo\\.claude\\system-one-local-only', 'C:\\work\\.claude\\system-one-local-only', 'C:\\.claude\\system-one-local-only'])
})

test('under local first a marked folder leaves the judgment to the fallback while Laya is unavailable', async () => {
  const { fake, once } = await setup(LOCAL_FIRST)
  fake.jev = () => ({ status: 200, body: jevAnswer(done(0.05)) })
  fake.marked = [`/${MARK}`]
  assert.equal(await once(), undefined)
  assert.equal(await once(), undefined)
  assert.deepEqual(fake.to(JEV), [])
  assert.equal(fake.checked.length, 3)
})

// --- no surface ------------------------------------------------------------------------------

test('a session no surface shows asks neither model, and looks at no folder', async () => {
  const { fake, once } = await setup(HOSTED_FIRST)
  fake.laya = () => ({ status: 200, body: layaAnswer(done(0.99)) })
  fake.jev = () => ({ status: 200, body: jevAnswer(done(0.99)) })
  fake.isShown = false
  assert.equal(await once(), undefined)
  assert.deepEqual(fake.calls, [])
  assert.deepEqual(fake.checked, [])
})
