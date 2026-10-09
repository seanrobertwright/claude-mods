// The System One client (ADR-0004): asks Laya, the local model, or Jev, the
// hosted model, one typed question set per judgment.
//
// shared/system-one.ts is the one source. Each mod that uses it carries a byte
// for byte copy as hooks/system-one.ts (npm run sync:system-one refreshes the
// copies, and npm run check fails when one differs). Nothing imports across mods.
//
// It never touches `$`: the mod's hooks file hands it closures (SystemOneIo), so
// the load checks trace every engine call to that file. Its state (the windows a
// backend is unavailable for, the slot each backend's one call holds, a rejected
// key, whether Laya was identified) lives in this module, so a reload starts it over.

/** The person's Model choice: which models a mod may ask, and in what order (ADR-0003). */
export type ModelChoice = 'local only' | 'local first' | 'hosted first'

export const MODEL_CHOICES: readonly ModelChoice[] = ['local only', 'local first', 'hosted first']

/** Laya, at this machine's own address, or Jev, at TypeSafe's own endpoint. */
export type Backend = 'laya' | 'jev'

/** The key as the settings hold it: none, one that cannot be a key, or one that may be. */
export type KeyState = 'absent' | 'malformed' | 'present'

/** What a mod names in its pane about the key, under a model choice that allows the hosted model. */
export type KeyProblem = 'absent' | 'malformed' | 'rejected'

export type SystemOneSettings = {
  modelChoice: ModelChoice
  /** Undefined under local only, where the key is not looked at at all. */
  keyState: KeyState | undefined
  /** The key, only when present. */
  key: string | undefined
  layaPort: number
}

/** A yes-or-no question (Noul) or a pick-one question (Choice), in the wire protocol's shape. */
export type Question =
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }

/** One question's answer: the probability of yes, or the option picked. */
export type Answer = { type: 'noul'; noul: number } | { type: 'choice'; choice: string }

/** What a judgment gets back: which model answered, and its answers by question id. */
export type Answers = { backend: Backend; answers: Record<string, Answer> }

/** One judgment's ask. */
export type Ask = {
  /** How long the judgment waits, in milliseconds; capped at BOUND_CAP_MS. */
  boundMs: number
  /** The questions, by id. */
  questions: Record<string, Question>
  /** The text each model reads, fitted to that model by the mod. */
  state: Record<Backend, string>
}

/** The engine calls the client needs, as the mod's hooks file hands them over. */
export type SystemOneIo = {
  /** `$.http.fetch`, resolving its status and body text. */
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; text: string }>
  /**
   * `$.clock.sleep(ms)`, with no signal. The bound's sleep races a request in a
   * judgment that may run after its hook returned (whats-next's judge runs
   * unawaited after turn.complete), so `next.signal`, which aborts when that
   * hook's dispatch settles, could end the bound early. A sleep that rejects all
   * the same ends the ask with no answer, and the backend is not marked unavailable.
   */
  sleep: (ms: number) => Promise<void>
  /** `$.clock.now()`: the unavailable windows run on the engine's clock. */
  now: () => Promise<number>
  /** `$.fs.exists(path)`; a rejection counts as the local-only mark. */
  exists: (path: string) => Promise<boolean>
  /** `$.session.cwd()`: the session's folder, where the local-only lookup starts. */
  folder: () => Promise<string>
  /** Whether any surface shows the session now: a headless session asks neither model. */
  isShown: () => Promise<boolean>
}

/** No judgment waits longer than this, the default of TypeSafe's Python SDK. */
export const BOUND_CAP_MS = 10_000
/** The first unavailable window after a failure; it doubles with each failure in a row. */
const WINDOW_MS = 30_000
/** The longest unavailable window. */
const WINDOW_CAP_MS = 300_000
const DEFAULT_LAYA_PORT = 8000
/** Jev's one address: no trailing slash, which TypeSafe redirects to plain http. */
const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
const JEV_MODEL = 'jev-latest'
/** Laya's address on this machine, before the port. */
const LAYA_HOST = 'http://127.0.0.1:'
/** The mark, under a folder, that keeps everything from that folder and below off the hosted model. */
const LOCAL_ONLY_MARK = ['.claude', 'system-one-local-only']

/** Present means trimmed, non-empty, printable ASCII with no whitespace. */
const KEY = /^[\x21-\x7e]+$/

/** Reads the three shared fields; anything unrecognised reads as its default. */
export function parseSystemOne(options: Readonly<Record<string, unknown>>): SystemOneSettings {
  const choice = options.modelChoice
  const modelChoice = MODEL_CHOICES.find(known => known === choice) ?? 'local only'
  const port = options.layaPort
  const layaPort = typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_LAYA_PORT
  if (modelChoice === 'local only') return { modelChoice, keyState: undefined, key: undefined, layaPort }
  const raw = typeof options.jevApiKey === 'string' ? options.jevApiKey.trim() : ''
  if (raw === '') return { modelChoice, keyState: 'absent', key: undefined, layaPort }
  if (!KEY.test(raw)) return { modelChoice, keyState: 'malformed', key: undefined, layaPort }
  return { modelChoice, keyState: 'present', key: raw, layaPort }
}

type Health = {
  /** Failures in a row. */
  failures: number
  /** Unavailable until this time, in milliseconds since the epoch. */
  until: number
  /** True while a call holds the backend's one slot, a call that lost its race included. */
  isBusy: boolean
}

const health: Record<Backend, Health> = {
  laya: { failures: 0, until: 0, isBusy: false },
  jev: { failures: 0, until: 0, isBusy: false },
}
/** Set by a 401 or 403 from Jev, for the life of this module. */
let isKeyRejected = false
/** Whether Laya answered the identity check since it was last unavailable. */
let isLayaIdentified = false

/** The key's problem for the mod to name, or undefined: none, or local only. */
export function keyProblem(settings: SystemOneSettings): KeyProblem | undefined {
  if (settings.keyState === undefined) return undefined
  if (settings.keyState !== 'present') return settings.keyState
  return isKeyRejected ? 'rejected' : undefined
}

/**
 * Asks one model the judgment's questions and resolves its answers, or
 * undefined for the Fallback: in a headless session, with no model available,
 * when the model asked is busy, fails, outlasts the bound, or reports cut text.
 * One model per judgment: whatever happens, the other is not asked.
 */
export async function askSystemOne(io: SystemOneIo, settings: SystemOneSettings, ask: Ask): Promise<Answers | undefined> {
  if (!(await io.isShown())) return undefined
  const now = await io.now()
  for (const backend of order(settings.modelChoice)) {
    if (health[backend].until > now) continue
    if (backend === 'jev') {
      if (settings.key === undefined || isKeyRejected) continue
      if (await isLocalOnly(io)) continue
    }
    return run(io, settings, ask, backend)
  }
  return undefined
}

function order(choice: ModelChoice): Backend[] {
  if (choice === 'local first') return ['laya', 'jev']
  if (choice === 'hosted first') return ['jev', 'laya']
  return ['laya']
}

/**
 * Whether the session's folder, or any folder above it up to the root, holds the
 * local-only mark: one existence check per level. A lookup that cannot complete
 * counts as marked.
 */
async function isLocalOnly(io: SystemOneIo): Promise<boolean> {
  try {
    for (const path of markPaths(await io.folder())) {
      if (await io.exists(path)) return true
    }
    return false
  } catch {
    return true
  }
}

/** Where the mark would sit for `folder` and each folder above it, nearest first. Throws on a relative folder. */
function markPaths(folder: string): string[] {
  if (!/^([A-Za-z]:)?[\\/]/.test(folder)) throw new Error(`not an absolute folder: ${folder}`)
  const separator = folder.includes('\\') ? '\\' : '/'
  const [root = '', ...rest] = folder.split(/[\\/]+/)
  const levels = rest.filter(part => part !== '')
  const paths: string[] = []
  for (let depth = levels.length; depth >= 0; depth -= 1) {
    paths.push([root, ...levels.slice(0, depth), ...LOCAL_ONLY_MARK].join(separator))
  }
  return paths
}

/** How one call to a backend ended. */
type Outcome =
  | { kind: 'answer'; answers: Record<string, Answer> }
  | { kind: 'cut' }
  | { kind: 'failure' }
  | { kind: 'rejected' }

/** Takes the backend's one slot, races the call against the bound, and keeps what its outcome says about the backend. */
async function run(io: SystemOneIo, settings: SystemOneSettings, ask: Ask, backend: Backend): Promise<Answers | undefined> {
  const slot = health[backend]
  if (slot.isBusy) return undefined
  slot.isBusy = true
  const call = (backend === 'laya' ? callLaya(io, settings.layaPort, ask) : callJev(io, settings.key ?? '', ask)).finally(() => {
    slot.isBusy = false
  })
  const bound = Math.min(Number.isFinite(ask.boundMs) ? Math.max(ask.boundMs, 0) : 0, BOUND_CAP_MS)
  const timer = io.sleep(bound).then(
    (): Outcome => ({ kind: 'failure' }),
    (): undefined => undefined,
  )
  const outcome = await Promise.race([call, timer])
  if (outcome === undefined) return undefined
  if (outcome.kind === 'rejected') {
    isKeyRejected = true
    return undefined
  }
  if (outcome.kind === 'failure') {
    slot.failures += 1
    slot.until = (await io.now()) + Math.min(WINDOW_MS * 2 ** (slot.failures - 1), WINDOW_CAP_MS)
    if (backend === 'laya') isLayaIdentified = false
    return undefined
  }
  slot.failures = 0
  slot.until = 0
  if (backend === 'laya') isLayaIdentified = true
  return outcome.kind === 'answer' ? { backend, answers: outcome.answers } : undefined
}

async function callLaya(io: SystemOneIo, port: number, ask: Ask): Promise<Outcome> {
  const base = `${LAYA_HOST}${port}`
  try {
    if (!isLayaIdentified) {
      const check = await io.fetch(`${base}/openapi.json`, { method: 'GET', headers: {} })
      if (check.status !== 200 || !isLayaOpenapi(parseJson(check.text))) return { kind: 'failure' }
    }
    const response = await io.fetch(`${base}/v1/systemone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: ask.state.laya, questions: ask.questions }),
    })
    if (response.status < 200 || response.status > 299) return { kind: 'failure' }
    const body = parseJson(response.text)
    const answers = readAnswers(body, ask.questions)
    const truncated = isObject(body) && isObject(body.usage) ? body.usage.truncated : undefined
    if (answers === undefined || typeof truncated !== 'boolean') return { kind: 'failure' }
    return truncated ? { kind: 'cut' } : { kind: 'answer', answers }
  } catch {
    return { kind: 'failure' }
  }
}

async function callJev(io: SystemOneIo, key: string, ask: Ask): Promise<Outcome> {
  try {
    const response = await io.fetch(JEV_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: JEV_MODEL, state: ask.state.jev, questions: ask.questions }),
    })
    if (response.status === 401 || response.status === 403) return { kind: 'rejected' }
    if (response.status < 200 || response.status > 299) return { kind: 'failure' }
    const answers = readAnswers(parseJson(response.text), ask.questions)
    return answers === undefined ? { kind: 'failure' } : { kind: 'answer', answers }
  } catch {
    return { kind: 'failure' }
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** laya-serve's /openapi.json: its title, and the route the client asks. */
function isLayaOpenapi(body: unknown): boolean {
  return isObject(body) && isObject(body.info) && body.info.title === 'laya-serve' && isObject(body.paths) && '/v1/systemone' in body.paths
}

/**
 * The answers of a readable reply: a `model` and an `answers` map keyed by
 * exactly the questions asked, each of its question's type with a value it can
 * take. Anything else is unreadable, so undefined.
 */
function readAnswers(body: unknown, questions: Record<string, Question>): Record<string, Answer> | undefined {
  if (!isObject(body) || typeof body.model !== 'string' || !isObject(body.answers)) return undefined
  const ids = Object.keys(questions)
  const given = body.answers
  if (Object.keys(given).length !== ids.length) return undefined
  const answers: Record<string, Answer> = {}
  for (const id of ids) {
    const question = questions[id]
    const answer = given[id]
    if (question === undefined || !isObject(answer) || answer.type !== question.type) return undefined
    if (question.type === 'noul') {
      const noul = answer.noul
      if (typeof noul !== 'number' || !Number.isFinite(noul) || noul < 0 || noul > 1) return undefined
      answers[id] = { type: 'noul', noul }
    } else {
      const choice = answer.choice
      if (typeof choice !== 'string' || !Object.hasOwn(question.criteria, choice)) return undefined
      answers[id] = { type: 'choice', choice }
    }
  }
  return answers
}
