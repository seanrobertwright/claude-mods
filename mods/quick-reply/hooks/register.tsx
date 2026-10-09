import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { optionReply, parseReplies, readAnswer } from './detect'
import { buildEndingAsk, keyMessage, readSettled } from './ending'
import { askSystemOne, keyProblem, parseSystemOne } from './system-one'
import type { SystemOneIo, SystemOneSettings } from './system-one'
import { mapFromArgs, nextMap, readBash, skillArgs } from './wayfinder'

const reading = atom({ plugin: 'quick-reply', key: 'reading' } as const, null)
const offer = atom({ plugin: 'quick-reply', key: 'offer' } as const, null)
const keyNote = atom({ plugin: 'quick-reply', key: 'keyNote' } as const, null)

async function send($: EngineInterface, text: string): Promise<void> {
  await update($, reading, () => null)
  await update($, offer, () => null)
  await $.prompt.submit({ text, asUser: true })
}

/** Starts a Fail verdict in the prompt, where the person says what went wrong (and can paste an image); nothing is sent. */
async function fail($: EngineInterface): Promise<void> {
  await $.prompt.fill({ text: 'Fail: ' })
}

/** Takes the next ticket of `map`: a fresh session, as the skill wants one ticket per session, then the skill itself. */
async function takeNext($: EngineInterface, map: number): Promise<void> {
  await update($, reading, () => null)
  await update($, offer, () => null)
  await update($, keyNote, () => null)
  await $.command.run({ command: 'clear' })
  await $.command.run({ command: 'wayfinder', args: String(map) })
}

function report($: EngineInterface): (error: unknown) => void {
  return error => $.ui.toast(`quick-reply: ${error instanceof Error ? error.message : String(error)}`)
}

/**
 * Whether any surface shows the session right now. Asked before each model call
 * and never kept: a reload or a missed attach would leave a kept flag wrong.
 * Each mod carries its own copy (ADR-0001).
 */
async function isShown($: EngineInterface): Promise<boolean> {
  return (await $.session.surfaces()).length > 0
}

/**
 * The engine calls the System One client makes, handed over as closures: the
 * shared client never touches `$` (ADR-0004). The bound's sleep takes no signal
 * (see SystemOneIo.sleep): the reading runs after turn.complete has returned.
 */
function systemOneIo($: EngineInterface): SystemOneIo {
  return {
    fetch: (url, init) => $.http.fetch(url, init),
    sleep: ms => $.clock.sleep(ms),
    now: () => $.clock.now(),
    exists: path => $.fs.exists(path),
    folder: () => $.session.cwd(),
    isShown: () => isShown($),
  }
}

/**
 * Asks a System One model how `answer` ends and, while `isCurrent` still says
 * nothing has moved the band on, draws the parts it settled in place of the
 * regexes'. No answer, or one too unsure, leaves the regexes' reading drawn. A
 * key the ask found rejected is named under the replies.
 */
async function readWithModel($: EngineInterface, systemOne: SystemOneSettings, answer: string, isCurrent: () => boolean): Promise<void> {
  const asked = await askSystemOne(systemOneIo($), systemOne, buildEndingAsk(answer))
  if (!isCurrent()) return
  await update($, keyNote, () => keyProblem(systemOne) ?? null)
  if (asked === undefined) return
  const settled = readSettled(asked)
  await update($, reading, current => (current === null || !isCurrent() ? current : readAnswer(answer, settled)))
}

/** The wayfinder skill, by its own name or a plugin's `<plugin>:wayfinder`. */
function isWayfinder(skill: string): boolean {
  return skill === 'wayfinder' || skill.endsWith(':wayfinder')
}

export const register: Register = (on, options) => {
  const questionReplies = parseReplies(options.questionReplies)
  const idleReplies = parseReplies(options.idleReplies)
  const isNextOffered = options.wayfinderNext !== false
  const systemOne = parseSystemOne(options)
  // Counts the answers read and the prompts sent: a model's reading is drawn only
  // while neither has happened since the answer it reads.
  let moves = 0

  // The loop's memory is the module's own, so it outlives a /clear, which starts a new session
  // without reloading the mod. `map` is the one the skill last ran with, or the one a turn made.
  let hasWayfinder = false
  let map: number | undefined
  let turnClosed: number[] = []
  let turnCreated: number | undefined

  on('skill.prompt', async ($, e, next) => {
    if (isNextOffered && isWayfinder(e.skill)) {
      hasWayfinder = true
      const args = skillArgs(e.text)
      if (args !== undefined) map = mapFromArgs(args)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    turnClosed = []
    turnCreated = undefined
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const done = await next(e)
    // A subagent's closes are not the turn's, and a command that failed or was refused closed nothing.
    if (!hasWayfinder || e.agentId !== undefined || done.isError === true || done.deny !== undefined) return done
    const bash = readBash(e.command, done.text ?? done.result.stdout)
    turnClosed.push(...bash.closed)
    if (bash.created !== undefined) turnCreated = bash.created
    return done
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    // A subagent's turn is not one the person answers.
    if (e.agentId !== undefined) return done
    const shown = hasWayfinder && e.reason === 'answer' ? nextMap({ map, closed: turnClosed, created: turnCreated }) : undefined
    if (turnCreated !== undefined) map = turnCreated
    // A turn that closed the map ends the loop: no later close offers it again.
    if (map !== undefined && turnClosed.includes(map)) map = undefined
    turnClosed = []
    turnCreated = undefined
    moves += 1
    await update($, reading, () => (e.reason === 'answer' ? readAnswer(e.answer) : null))
    await update($, offer, () => shown ?? null)
    if (e.reason === 'answer') {
      await update($, keyNote, () => keyProblem(systemOne) ?? null)
      const at = moves
      void readWithModel($, systemOne, e.answer, () => moves === at).catch(report($))
    }
    return done
  })

  on('prompt.submit', async ($, e, next) => {
    moves += 1
    await update($, reading, () => null)
    await update($, offer, () => null)
    await update($, keyNote, () => null)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Whatever is beneath (another mod's band, the engine's own) keeps its row under the replies.
    const beneath = await next(e)
    const current = await read($, reading)
    const nextTicket = await read($, offer)
    const note = await read($, keyNote)
    if ((current === null && nextTicket === null) || e.props.hasSurvey || e.props.isWorking || e.props.view.agentId !== undefined) {
      return beneath
    }
    const choices = current?.options ?? []
    // A verdict question is answered with a verdict: the verdict buttons stand in for the replies.
    const asksForVerdict = current?.asksForVerdict === true
    const replies = current === null || asksForVerdict ? [] : current.isQuestion ? questionReplies : idleReplies
    if (nextTicket === null && choices.length === 0 && replies.length === 0 && !asksForVerdict && note === null) return beneath

    const { Box, Text, Button } = $.ui.resolve(e)

    // The outer Box takes no width: the engine refuses its own band under a Box that sets one.
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} width={e.props.bodyColumns}>
          <Text dimColor>Reply:</Text>
          {nextTicket !== null && (
            <Button
              key="next-ticket"
              label={`Next ticket: /wayfinder ${nextTicket}`}
              onPress={() => void takeNext($, nextTicket).catch(report($))}
            />
          )}
          {choices.map(option => (
            <Button
              key={`option-${option.marker}`}
              label={`${option.marker}: ${option.label}`}
              onPress={() => void send($, optionReply(option)).catch(report($))}
            />
          ))}
          {asksForVerdict && (
            <>
              <Button key="verdict-pass" label="Pass" onPress={() => void send($, 'pass').catch(report($))} />
              <Button key="verdict-fail" label="Fail…" onPress={() => void fail($).catch(report($))} />
              <Button key="verdict-skip" label="Skip" onPress={() => void send($, 'skip').catch(report($))} />
            </>
          )}
          {replies.map(reply => (
            <Button
              key={`reply-${reply}`}
              label={reply}
              variant={current?.hasRecommendation === true && /recommend/i.test(reply) ? 'primary' : 'secondary'}
              onPress={() => void send($, reply).catch(report($))}
            />
          ))}
        </Box>
        {note !== null && <Text dimColor wrap="wrap">{keyMessage(note)}</Text>}
        {beneath}
      </Box>
    )
  })
}
