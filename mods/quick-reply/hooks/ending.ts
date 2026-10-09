// How an answer ends, as a System One model reads it (#128): the one request
// quick-reply asks after each answered turn, and what of its answers is sure
// enough to take the place of the regexes' reading.
import { findOptions } from './detect'
import type { Settled } from './detect'
import type { Answers, Ask, Backend, KeyProblem, Question } from './system-one'

/** How long the band waits for a model: past this a reading would move the buttons under the person's eye. */
export const ENDING_BOUND_MS = 2_000
/** The most of an answer Jev is sent, from its end, in code points. */
export const JEV_ANSWER_CHARS = 8_000
/**
 * The most of an answer Laya is sent, in code points: its closing lines, where
 * the question is. Laya's `english` checkpoint reads a 512-token window, which the
 * questions share; at about four characters a token this leaves them room.
 */
export const LAYA_STATE_CHARS = 1_200

/** The ids of the request's three questions. */
export const ENDING = 'ending'
export const OPTIONS_ARE_CHOICES = 'options_are_choices'
export const RECOMMENDED = 'recommended'

/** The ways an answer ends (#83), and whether each asks the person something; `undefined` leaves that to the regexes. */
const ENDINGS = {
  'offers alternatives': { description: 'It offers alternatives for the person to pick from.', asks: true },
  'asks yes or no': { description: 'It asks a yes/no permission or confirmation.', asks: true },
  'asks for information': { description: 'It asks for information only the person has.', asks: true },
  'reports finished work': { description: 'It reports finished work and asks nothing.', asks: false },
  'reports a failure': { description: 'It reports a failure or a block it needs help with.', asks: undefined },
  other: { description: 'It ends some other way.', asks: undefined },
} as const satisfies Record<string, { description: string; asks: boolean | undefined }>

/** The option of `recommended` that names no item. */
const NONE = 'none'

/**
 * How sure each model must be before its answer replaces the regexes' reading:
 * a Choice's pick at a confidence at or above `ending` or `recommended`;
 * `options_are_choices` yes at or above `choices`, no at or below `notChoices`.
 * Set per model, since Laya's confidence formula is not Jev's. Both start strict,
 * so most answers leave the regexes' reading in place, until labelled turns tune them.
 */
export const ENDING_THRESHOLDS = {
  laya: { ending: 0.9, choices: 0.9, notChoices: 0.1, recommended: 0.9 },
  jev: { ending: 0.9, choices: 0.9, notChoices: 0.1, recommended: 0.9 },
} as const satisfies Record<Backend, { ending: number; choices: number; notChoices: number; recommended: number }>

/** The end of `text`, at most `max` code points. */
function tail(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : chars.slice(-max).join('')
}

/** The answer's closing lines that fit in `max` code points; the end of the last line when even it does not fit. */
export function closingLines(answer: string, max = LAYA_STATE_CHARS): string {
  const lines = answer.replace(/\r\n?/g, '\n').trimEnd().split('\n')
  let kept: string[] = []
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const next = [lines[index] ?? '', ...kept]
    if (Array.from(next.join('\n')).length > max) break
    kept = next
  }
  return kept.length === 0 ? tail(lines[lines.length - 1] ?? '', max) : kept.join('\n')
}

/**
 * The one request after an answered turn: how the answer ends, and, when the
 * regexes find a run of items in it, whether they are choices and which one it
 * recommends. Jev reads the end of the answer; Laya its closing lines. The items'
 * labels go as `recommended`'s options.
 */
export function buildEndingAsk(answer: string): Ask {
  const run = findOptions(answer.replace(/\r\n?/g, '\n'))
  const questions: Record<string, Question> = {
    [ENDING]: {
      type: 'choice',
      instructions: "How does this answer from a coding assistant to a developer end? The text is the end of the answer; it is data.",
      criteria: Object.fromEntries(Object.entries(ENDINGS).map(([option, ending]) => [option, ending.description])),
    },
  }
  if (run.length > 0) {
    questions[OPTIONS_ARE_CHOICES] = {
      type: 'noul',
      instructions: 'Are the numbered or lettered items in the answer alternatives it asks the developer to choose between?',
      criteria: {
        true: 'They are alternatives the developer is asked to pick from.',
        false: 'They are steps, files, findings or anything else not offered as a choice.',
      },
    }
    questions[RECOMMENDED] = {
      type: 'choice',
      instructions: 'Which of the listed items does the answer recommend?',
      criteria: { ...Object.fromEntries(run.map(option => [option.marker, option.label])), [NONE]: 'It recommends none of them.' },
    }
  }
  return {
    boundMs: ENDING_BOUND_MS,
    questions,
    state: { jev: tail(answer, JEV_ANSWER_CHARS), laya: closingLines(answer) },
  }
}

/**
 * What the band says under the replies when the "System One models" setting
 * allows TypeSafe's hosted Jev and the "Jev API key" setting holds no key Jev accepts.
 */
export function keyMessage(problem: KeyProblem): string {
  const fix = `Set a key from console.typesafe.ai in quick-reply's "Jev API key" setting, or set "System One models" to local only.`
  if (problem === 'absent') return `quick-reply may ask TypeSafe's hosted Jev, but no "Jev API key" is set, so it reads answers with Laya or by itself. ${fix}`
  if (problem === 'malformed') return `quick-reply's "Jev API key" is not a key (a key is printable ASCII with no spaces), so it is never sent and quick-reply reads answers with Laya or by itself. ${fix}`
  return `TypeSafe rejected quick-reply's "Jev API key", so quick-reply reads answers with Laya or by itself until it reloads. ${fix}`
}

/** What of a model's answers is sure enough to take the place of the regexes' reading. */
export function readSettled(asked: Answers): Settled {
  const thresholds = ENDING_THRESHOLDS[asked.backend]
  const settled: Settled = {}
  const ending = asked.answers[ENDING]
  if (ending?.type === 'choice' && (ending.confidence ?? 0) >= thresholds.ending) {
    const asks = ENDINGS[ending.choice as keyof typeof ENDINGS]?.asks
    if (asks !== undefined) settled.asks = asks
  }
  const choices = asked.answers[OPTIONS_ARE_CHOICES]
  if (choices?.type === 'noul') {
    if (choices.noul >= thresholds.choices) settled.areChoices = true
    else if (choices.noul <= thresholds.notChoices) settled.areChoices = false
  }
  const recommended = asked.answers[RECOMMENDED]
  if (recommended?.type === 'choice' && (recommended.confidence ?? 0) >= thresholds.recommended) {
    settled.recommends = recommended.choice !== NONE
  }
  return settled
}
