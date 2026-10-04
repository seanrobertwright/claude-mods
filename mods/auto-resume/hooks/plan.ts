import type { SessionRateLimit } from 'claude-code'

import type { Pending } from '../types'

const MINUTE = 60_000
const MAX_BACKOFF = 15 * MINUTE
/** Never resume sooner than this after a failure, whatever a window says. */
const FLOOR = 30_000

export type Config = {
  text: string
  graceMs: number
  retryOverloaded: boolean
  maxRetries: number
}

/** Parses the manifest's userConfig values; a value out of range falls back to its default. */
export function parseConfig(options: Readonly<Record<string, unknown>>): Config {
  const text = typeof options.text === 'string' ? options.text.replace(/\p{Cc}/gu, ' ').trim() : ''
  const grace = options.graceSeconds
  const retries = options.maxRetries
  return {
    text: text === '' ? 'continue' : text,
    graceMs: typeof grace === 'number' && Number.isFinite(grace) && grace >= 0 && grace <= 900 ? grace * 1000 : MINUTE,
    retryOverloaded: typeof options.retryOverloaded === 'boolean' ? options.retryOverloaded : true,
    maxRetries: typeof retries === 'number' && Number.isInteger(retries) && retries >= 1 && retries <= 20 ? retries : 5,
  }
}

/**
 * The mod's one date helper: an ISO 8601 instant to milliseconds since the
 * epoch. A string without a zone (`Z` or an offset) is refused rather than
 * read as local time.
 */
export function instantMs(iso: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(iso)) return undefined
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : undefined
}

const WINDOW_NAMES: Readonly<Record<string, string>> = {
  five_hour: '5-hour',
  seven_day: 'weekly',
  spend_limit: 'spend',
}

function windowName(kind: string): string {
  return Object.hasOwn(WINDOW_NAMES, kind) ? (WINDOW_NAMES[kind] ?? kind) : kind.replace(/_/g, ' ')
}

/**
 * When to resume after a turn died on `error`: at the latest reset of an
 * exhausted rate-limit window plus the grace, or else on a backoff of one
 * minute doubling to fifteen. Undefined when the error is not worth waiting
 * out or the retries are spent.
 */
export function planResume(input: {
  error: string
  rateLimits: readonly SessionRateLimit[]
  now: number
  attempts: number
  config: Config
}): Pending | undefined {
  const { error, rateLimits, now, attempts, config } = input
  if (attempts >= config.maxRetries) return undefined
  const isRateLimit = error === 'rate_limit'
  const isTransient = error === 'overloaded' || error === 'server_error'
  if (!isRateLimit && !(isTransient && config.retryOverloaded)) return undefined

  if (isRateLimit) {
    let latest: { at: number; kind: string } | undefined
    for (const window of rateLimits) {
      const at = window.resetsAt === undefined ? undefined : instantMs(window.resetsAt)
      if (window.percentUsed < 100 || at === undefined) continue
      if (latest === undefined || at > latest.at) latest = { at, kind: window.kind }
    }
    if (latest !== undefined) {
      return {
        resumeAt: Math.max(latest.at + config.graceMs, now + FLOOR),
        reason: `${windowName(latest.kind)} limit reached`,
      }
    }
  }

  const backoff = Math.min(MINUTE * 2 ** attempts, MAX_BACKOFF)
  return {
    resumeAt: now + backoff,
    reason: isRateLimit ? 'rate limited' : error === 'overloaded' ? 'API overloaded' : 'API server error',
  }
}

/** A wait as people say it: `45 s`, `12 min`, `1 h 12 min`. */
export function formatWait(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

/** `/auto-resume in <minutes>`: a whole number of minutes from 1 to 1440, else undefined. */
export function parseMinutes(text: string): number | undefined {
  if (!/^\d{1,4}$/.test(text)) return undefined
  const minutes = Number.parseInt(text, 10)
  return minutes >= 1 && minutes <= 1440 ? minutes : undefined
}
