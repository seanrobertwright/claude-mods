// A fake SystemOneIo for shared/system-one.test.ts: the client's one test surface
// (CONTEXT.md, System One client). Time is virtual, the two models answer by URL,
// and every request is recorded. Nothing here needs Claude Code.
import type { SystemOneIo } from './system-one.ts'

export const JEV = 'https://api.typesafe.ai/v1/systemone'
export const laya = (port = 8000): string => `http://127.0.0.1:${port}`

/** laya-serve's /openapi.json as FastAPI writes it for `create_app` (docs/research/laya-on-windows.md). */
export const LAYA_OPENAPI = {
  openapi: '3.1.0',
  info: { title: 'laya-serve', version: '0.1.0' },
  paths: { '/health': {}, '/v1/systemone': {}, '/v1/systemone/batch': {} },
}

/** What a test has a model answer: a pick with its confidence for a Choice, a probability of yes for a Noul. */
export type Reading = Record<string, { choice: string; confidence?: number } | { noul: number }>

/** A Laya answer, with the extra fields Laya's docs list (docs/http-api.md "Response"). */
export function layaAnswer(reading: Reading, truncated = false): unknown {
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
    usage: {
      input_tokens: 120,
      output_tokens: 0,
      state_tokens: truncated ? 700 : 120,
      state_tokens_dropped: truncated ? 188 : 0,
      truncated,
      truncated_questions: truncated ? Object.keys(reading) : [],
    },
    routing: { model: 'english', repo: 'convaiinnovations/laya', reason: 'English text.', detection: null, workflow: null },
  }
}

/** A Jev answer, as TypeSafe's API reference shows one. */
export function jevAnswer(reading: Reading): unknown {
  const answers = Object.fromEntries(
    Object.entries(reading).map(([id, answer]) => [id, 'noul' in answer ? { type: 'noul', noul: answer.noul } : { type: 'choice', choice: answer.choice, confidence: answer.confidence }]),
  )
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: 360, output_tokens: 1 } }
}

/** What a model answers: a status and body, or a refused connection. */
export type Reply = { status: number; body: unknown } | 'refused'
type Route = () => Reply | Promise<Reply>

/** A reply the test settles later, to hold a request open. */
export function held(): { reply: Promise<Reply>; answer: (status: number, body: unknown) => void } {
  let answer: (status: number, body: unknown) => void = () => {}
  const reply = new Promise<Reply>(resolve => {
    answer = (status, body) => resolve({ status, body })
  })
  return { reply, answer }
}

export type Call = { url: string; method: string; headers: Record<string, string>; body: string }

export type Fake = {
  io: SystemOneIo
  /** Moves the clock on, waking each sleeper when its time comes and letting what it started run. */
  advance: (ms: number) => Promise<void>
  /** Lets what is ready to run run, without moving the clock. */
  settle: () => Promise<void>
  /** Every request, in order. */
  calls: Call[]
  /** The requests to one URL. */
  to: (url: string) => Call[]
  /** What each address answers next: Laya's ask, Laya's identity check, and Jev. */
  laya: Route
  openapi: Route
  jev: Route
  /** Every path the client asked `exists` about, in order. */
  checked: string[]
  /** The paths `exists` says are there. */
  marked: string[]
  /** Makes `exists` reject, as a folder that cannot be read does. */
  existsThrows: boolean
  folder: string
  isShown: boolean
}

/** Time starts at 1_000 so that a window ending "at 0" never reads as the future. */
export function fakeIo(options: { port?: number } = {}): Fake {
  const base = laya(options.port)
  let time = 1_000
  let sleepers: { at: number; wake: () => void }[] = []
  const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

  const fake: Fake = {
    io: undefined as never,
    advance: async ms => {
      // What was just started gets to register its sleep before the clock moves.
      await settle()
      const target = time + ms
      for (;;) {
        const due = sleepers.filter(sleeper => sleeper.at <= target).sort((a, b) => a.at - b.at)[0]
        if (due === undefined) break
        sleepers = sleepers.filter(sleeper => sleeper !== due)
        time = Math.max(time, due.at)
        due.wake()
        await settle()
      }
      time = target
      await settle()
    },
    settle,
    calls: [],
    to: url => fake.calls.filter(call => call.url === url),
    laya: () => 'refused',
    openapi: () => ({ status: 200, body: LAYA_OPENAPI }),
    jev: () => 'refused',
    checked: [],
    marked: [],
    existsThrows: false,
    folder: '/work/repo',
    isShown: true,
  }

  fake.io = {
    fetch: async (url, init) => {
      fake.calls.push({ url, method: init.method, headers: { ...init.headers }, body: init.body ?? '' })
      const route = url === `${base}/openapi.json` ? fake.openapi : url === `${base}/v1/systemone` ? fake.laya : url === JEV ? fake.jev : undefined
      const reply = route === undefined ? 'refused' : await route()
      if (reply === 'refused') throw new Error('connect ECONNREFUSED')
      return { status: reply.status, text: typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body) }
    },
    sleep: ms =>
      new Promise<void>(resolve => {
        sleepers.push({ at: time + ms, wake: resolve })
      }),
    now: async () => time,
    exists: async path => {
      fake.checked.push(path)
      if (fake.existsThrows) throw new Error('EACCES')
      return fake.marked.includes(path)
    },
    folder: async () => fake.folder,
    isShown: async () => fake.isShown,
  }
  return fake
}
