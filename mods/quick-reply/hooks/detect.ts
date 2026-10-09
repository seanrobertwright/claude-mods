import type { Reading, ReplyOption } from '../types'

const MAX_OPTIONS = 9
const LABEL_CHARS = 40
/** How many non-blank lines at the end of an answer are read for a question. */
const CLOSING_LINES = 5

/**
 * A line that opens a choice: `1. x`, `2) x`, `a. x`, `(b) x`, `**C.** x`,
 * `- **Option A:** x`, `B - x`. Group 1 is the marker, group 2 the rest.
 */
const OPTION_LINE =
  /^\s*(?:[-*+]\s+)?(?:\*\*|__)?(?:option\s+)?\(?([1-9]|[a-h])(?:[.):]|\s+[-–—:])\)?(?:\*\*|__)?\s*(?:[-–—:]\s*)?(.+?)\s*$/i

const ASKING = /\b(which|would you like|should i|do you want|shall i|let me know|prefer|choose|pick|ok to|okay to|go ahead)\b/i

/** Asking for a verdict by setting pass against fail: "Pass or fail?", "passed/failed". */
const PASS_OR_FAIL = /\bpass(?:ed|es)?\s*(?:\/|,|\bor\b)\s*fail(?:ed|s)?\b/i

/**
 * Asking whether something passed: "Did it pass?", "Does test 3 pass for you?". The thing asked
 * about is a few words and not the person ("Do you want me to see if they pass?" asks something
 * else), and a "to pass" is a requirement, not a result ("Does it need to pass?").
 */
const DID_IT_PASS = /\b(?:did|does|do)\s+(?!(?:you|i|we)\b)(?:[\w#-]+\s+){1,4}?(?<!\bto\s+)pass(?:\s+(?:for you|on your (?:end|side|machine)|now|too))?\s*\?/i

/** Telling the person what to answer with: "Type `pass` or describe what's wrong", as /gsd:verify-work does. */
const TYPE_PASS = /\b(?:type|reply(?:\s+with)?|say|answer(?:\s+with)?|respond\s+with|enter)\s+["'“‘]?pass["'”’]?(?![\w-])/i

/** Inline code that is one word, such as the `pass` a verify-work checkpoint asks for. */
const ONE_WORD_CODE = /`(\w+)`/g

/** A `?` that ends a word, as a question's does. The one in `/search?q=mods` or `a?.b` does not. */
const QUESTION_MARK = /\?(?!\.?\w)/

/**
 * What makes an asking sentence more than a yes-or-no question: it is open
 * ("What would you like to do?"), words a choice ("Which do you prefer?"),
 * sets alternatives against each other ("the quick fix or the refactor?") or
 * leads into the list ("Should I:").
 */
const OPEN = /\b(what|which|how|prefer|choose|pick|options?|alternatives?|either|one of|or|thoughts|preference)\b|:\W*$/i

/**
 * A marker named on its own, not counting something: "go with 1?", "I recommend b.", "1, 2 or both".
 * Letters match in either case, as `OPTION_LINE` does. Neither the `e` of "e.g." nor the `f` of
 * "for" is one: a mark after a marker has to end the word, and an "or" or "and" has to be a word.
 */
const NAMED_MARKER = /(?<![\w.-])\(?(?:[1-9]|[a-h])\)?(?=\s*(?:$|[,.;:?!](?!\w))|\s+(?:or|and)\b)/i

/** Each way an answer negates its "recommend". A "not" that belongs to something else is none of them. */
const NOT_RECOMMENDED = [
  // "would not recommend", "wouldn't really recommend", "would not, however, recommend", "is not recommended"
  /(?:\b(?:not|never|cannot)|n['’]t)(?:[ \t,]+(?:however|though|\w+ly|ever|even|to|be))*[ \t,]+recommend\w*/gi,
  // "no strong recommendation", "don't have a recommendation"
  /(?:\bno|(?:\bnot|n['’]t)[ \t]+have[ \t]+(?:an?|any))[ \t]+(?:[\w-]+[ \t]+)?recommendations?\b/gi,
  // "not an approach I would recommend", "neither is one I can recommend"
  /\b(?:not[ \t]+(?:an?|the|something|anything|one|what)|neither|nothing)\b[^.,;:!?\n]*?\b(?:i|we)(?:['’]d|[ \t]+(?:would|can|could))[ \t]+(?:ever[ \t]+)?recommend\w*/gi,
  // "recommend against B"
  /\brecommend\w*[ \t]+against\b/gi,
]

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

/** `text` without its inline code and URLs: a `?` or an asking word in those is not the answer's own. */
function withoutInlineCodeAndUrls(text: string): string {
  return text.replace(/`[^`\n]*`/g, '').replace(/\bhttps?:\/\/\S*[^\s.,;:!?)\]}>"'*_]/gi, '')
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

/** One sentence of the answer's own words, and whether it is on a line that opens a choice. */
type Sentence = { text: string; isOnOptionLine: boolean }

/** The sentences of the closing non-blank lines of `text`, inline code and URLs left out. */
function closingSentences(text: string): Sentence[] {
  return text
    .split('\n')
    .map(line => ({ text: withoutInlineCodeAndUrls(line).trim(), isOnOptionLine: OPTION_LINE.test(line) }))
    .filter(line => line.text !== '')
    .slice(-CLOSING_LINES)
    .flatMap(line => line.text.split(/(?<=[.?!])\s+/).map(sentence => ({ ...line, text: sentence })))
}

function asks(sentence: string): boolean {
  return QUESTION_MARK.test(sentence) || ASKING.test(sentence)
}

/** Whether `sentence` asks for a pass/fail verdict on a test or a check. */
function isVerdictQuestion(sentence: string): boolean {
  return (asks(sentence) && PASS_OR_FAIL.test(sentence)) || DID_IT_PASS.test(sentence) || TYPE_PASS.test(sentence)
}

/**
 * Whether the closing sentences ask the person to pick among the listed items.
 * A plain yes-or-no question does not: a report followed by "Shall I commit?"
 * lists what was done. Naming a marker ("I recommend 1. Sound good?") does.
 */
function asksToChoose(closing: Sentence[]): boolean {
  const around = closing.filter(sentence => !sentence.isOnOptionLine)
  const asking = around.filter(sentence => asks(sentence.text))
  return (
    asking.length === 0 || asking.some(sentence => OPEN.test(sentence.text)) || around.some(sentence => NAMED_MARKER.test(sentence.text))
  )
}

/** Whether `text` recommends something. "would not recommend B" and "recommend against B" advise against. */
function recommends(text: string): boolean {
  const affirmed = NOT_RECOMMENDED.reduce((rest, negated) => rest.replace(negated, ''), withoutInlineCodeAndUrls(text))
  return /\brecommend/i.test(affirmed)
}

/** Reads an answer: whether it ends by asking, recommends something, and offers choices. */
export function readAnswer(answer: string): Reading {
  const text = withoutCode(answer.replace(/\r\n?/g, '\n'))
  const closing = closingSentences(text)
  const isQuestion = closing.some(sentence => asks(sentence.text))
  // A one-word code span is read as its word here only, so what counts as a question is unchanged.
  const asksForVerdict = closingSentences(text.replace(ONE_WORD_CODE, '$1')).some(sentence => isVerdictQuestion(sentence.text))
  return {
    isQuestion,
    asksForVerdict,
    hasRecommendation: recommends(text),
    // A test's numbered lines are its steps, not choices: a verdict answers it.
    options: isQuestion && !asksForVerdict && asksToChoose(closing) ? findOptions(text) : [],
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
