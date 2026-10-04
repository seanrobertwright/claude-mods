import type { Reading, ReplyOption } from '../types'

const MAX_OPTIONS = 9
const LABEL_CHARS = 40

/**
 * A line that opens a choice: `1. x`, `2) x`, `a. x`, `(b) x`, `**C.** x`,
 * `- **Option A:** x`, `B - x`. Group 1 is the marker, group 2 the rest.
 */
const OPTION_LINE =
  /^\s*(?:[-*+]\s+)?(?:\*\*|__)?(?:option\s+)?\(?([1-9]|[a-h])(?:[.):]|\s+[-–—:])\)?(?:\*\*|__)?\s*(?:[-–—:]\s*)?(.+?)\s*$/i

const ASKING = /\b(which|would you like|should i|do you want|shall i|let me know|prefer|choose|pick|ok to|okay to|go ahead)\b/i

/** The position of a marker in its sequence: `1` and `a` are 0, `2` and `b` are 1. */
function ordinal(marker: string): number {
  return /\d/.test(marker) ? Number.parseInt(marker, 10) - 1 : marker.toLowerCase().charCodeAt(0) - 97
}

function isSameKind(a: string, b: string): boolean {
  return /\d/.test(a) === /\d/.test(b)
}

function cut(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`
}

function cleanLabel(raw: string): string {
  const plain = raw.replace(/\*\*|__|`/g, '').replace(/\p{Cc}/gu, '').trim()
  // "Postgres — durable, but heavier" reads as "Postgres" on a button.
  const head = plain.split(/\s+[-–—]\s+|:\s+/)[0]?.trim() ?? ''
  return cut(head.length >= 3 ? head : plain, LABEL_CHARS)
}

function withoutCode(text: string): string {
  return text.replace(/```[\s\S]*?(```|$)/g, '')
}

/**
 * The last run of choices in `text`: markers in sequence from `1` or `a`,
 * other lines (sub-bullets, explanations, blanks) allowed between them.
 */
export function findOptions(text: string): ReplyOption[] {
  let last: ReplyOption[] = []
  let current: ReplyOption[] = []
  for (const line of withoutCode(text).split('\n')) {
    const match = OPTION_LINE.exec(line)
    const marker = match?.[1]
    const rest = match?.[2]
    if (marker === undefined || rest === undefined) continue
    const position = ordinal(marker)
    const previous = current[current.length - 1]
    if (position === 0) {
      if (current.length >= 2) last = current
      current = [{ marker: marker.toLowerCase(), label: cleanLabel(rest) }]
    } else if (previous !== undefined && isSameKind(previous.marker, marker) && position === ordinal(previous.marker) + 1) {
      current.push({ marker: marker.toLowerCase(), label: cleanLabel(rest) })
    }
  }
  if (current.length >= 2) last = current
  return last.slice(0, MAX_OPTIONS)
}

/** Reads an answer: whether it ends by asking, recommends something, and offers choices. */
export function readAnswer(answer: string): Reading {
  const text = answer.replace(/\r\n?/g, '\n')
  const tail = withoutCode(text)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .slice(-5)
    .join('\n')
  const isQuestion = tail.includes('?') || ASKING.test(tail)
  return {
    isQuestion,
    hasRecommendation: /\brecommend/i.test(text),
    options: isQuestion ? findOptions(text) : [],
  }
}

/** Splits a `|`-separated option into at most six distinct, non-empty replies. */
export function parseReplies(value: unknown): string[] {
  if (typeof value !== 'string') return []
  const replies = value
    .split('|')
    .map(reply => reply.replace(/\p{Cc}/gu, '').trim())
    .filter(reply => reply !== '')
    .map(reply => cut(reply, 120))
  return [...new Set(replies)].slice(0, 6)
}

/** What a choice's button sends: its marker, with the label so the model cannot misread it. */
export function optionReply(option: ReplyOption): string {
  return `${option.marker}) ${option.label}`
}
