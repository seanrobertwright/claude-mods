// A server's output: whole lines from the pieces, ANSI stripped, the local URL,
// the kept list, and the lines a death picks as its error.

import type { Death, OutputLine } from '../types'

/** The most lines kept per server, dividers included. */
export const KEPT_LINES = 500
/** The longest line kept; longer ones are cut with `…`. */
export const LINE_CHARS = 2000
/** The most lines a death's error takes, and the most characters, cut from the top. */
export const ERROR_LINES = 40
export const ERROR_CHARS = 4000

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]/g
const LOCAL_URL = /(https?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{1,5})/

/** Text without colour and cursor codes. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

/**
 * Adds a piece to what was pending and splits off the whole lines: a line may
 * span two pieces and one piece may hold several. `rest` waits for its end.
 */
export function splitPiece(pending: string, piece: string): { lines: string[]; rest: string } {
  const parts = (pending + piece).split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts.map(part => (part.endsWith('\r') ? part.slice(0, -1) : part)), rest }
}

/** The first local URL a stripped line prints, scheme, host and port only; `0.0.0.0` reads as localhost. */
export function findLocalUrl(line: string): { url: string; port: number } | undefined {
  const match = LOCAL_URL.exec(line)
  if (match === null) return undefined
  const [, scheme, host, digits] = match
  const port = Number(digits)
  if (port < 1 || port > 65535) return undefined
  return { url: `${scheme}://${host === '0.0.0.0' ? 'localhost' : host}:${port}`, port }
}

/** A line cut to the kept length. */
export function cutLine(text: string): string {
  return text.length > LINE_CHARS ? `${text.slice(0, LINE_CHARS)}…` : text
}

/** The kept list with `added` after it: each line cut, the oldest dropped past the cap. */
export function keep(list: readonly OutputLine[], added: readonly OutputLine[]): OutputLine[] {
  const next = [...list, ...added.map(line => (line.text.length > LINE_CHARS ? { ...line, text: cutLine(line.text) } : line))]
  return next.length > KEPT_LINES ? next.slice(next.length - KEPT_LINES) : next
}

/** The lines of the current run: everything after the last divider. */
export function currentRun(list: readonly OutputLine[]): OutputLine[] {
  let start = 0
  list.forEach((line, at) => {
    if (line.stream === 'divider') start = at + 1
  })
  return list.slice(start).filter(line => line.stream === 'stdout' || line.stream === 'stderr')
}

/** A death's error: the last 40 lines of the run that died, both streams in order, at most 4,000 characters cut from the top. */
export function errorLines(list: readonly OutputLine[]): string[] {
  const lines = currentRun(list).slice(-ERROR_LINES).map(line => line.text)
  let size = lines.join('\n').length
  while (size > ERROR_CHARS && lines.length > 0) {
    size -= (lines.shift()?.length ?? 0) + 1
  }
  return lines
}

/** `14:02`, in the machine's own time. */
export function hhmm(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** How a death ended, in words: `exit 3` or `signal SIGTERM`. */
export function endWords(death: Pick<Death, 'code' | 'signal'>): string {
  return death.signal !== null ? `signal ${death.signal}` : `exit ${death.code ?? '?'}`
}

/** What error → prompt fills: a header naming the server and its death, then its last lines in a fenced block. */
export function errorPrompt(name: string, death: Death): string {
  const header = `The dev server ${name} (${death.command}) crashed with ${endWords(death)} at ${hhmm(death.at)}.`
  if (death.lines.length === 0) return `${header} It printed nothing before it exited.`
  const longest = Math.max(2, ...death.lines.map(line => Math.max(0, ...(line.match(/`+/g) ?? []).map(run => run.length))))
  const fence = '`'.repeat(longest + 1)
  return `${header} Its last output:\n\n${fence}\n${death.lines.join('\n')}\n${fence}`
}
