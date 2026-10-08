import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { optionReply, parseReplies, readAnswer } from './detect'
import { mapFromArgs, nextMap, readBash, skillArgs } from './wayfinder'

const reading = atom({ plugin: 'quick-reply', key: 'reading' } as const, null)
const offer = atom({ plugin: 'quick-reply', key: 'offer' } as const, null)

async function send($: EngineInterface, text: string): Promise<void> {
  await update($, reading, () => null)
  await update($, offer, () => null)
  await $.prompt.submit({ text, asUser: true })
}

/** Takes the next ticket of `map`: a fresh session, as the skill wants one ticket per session, then the skill itself. */
async function takeNext($: EngineInterface, map: number): Promise<void> {
  await update($, reading, () => null)
  await update($, offer, () => null)
  await $.command.run({ command: 'clear' })
  await $.command.run({ command: 'wayfinder', args: String(map) })
}

function report($: EngineInterface): (error: unknown) => void {
  return error => $.ui.toast(`quick-reply: ${error instanceof Error ? error.message : String(error)}`)
}

/** The wayfinder skill, by its own name or a plugin's `<plugin>:wayfinder`. */
function isWayfinder(skill: string): boolean {
  return skill === 'wayfinder' || skill.endsWith(':wayfinder')
}

export const register: Register = (on, options) => {
  const questionReplies = parseReplies(options.questionReplies)
  const idleReplies = parseReplies(options.idleReplies)
  const isNextOffered = options.wayfinderNext !== false

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
    await update($, reading, () => (e.reason === 'answer' ? readAnswer(e.answer) : null))
    await update($, offer, () => shown ?? null)
    return done
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, reading, () => null)
    await update($, offer, () => null)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Whatever is beneath (another mod's band, the engine's own) keeps its row under the replies.
    const beneath = await next(e)
    const current = await read($, reading)
    const nextTicket = await read($, offer)
    if ((current === null && nextTicket === null) || e.props.hasSurvey || e.props.isWorking || e.props.view.agentId !== undefined) {
      return beneath
    }
    const choices = current?.options ?? []
    const replies = current === null ? [] : current.isQuestion ? questionReplies : idleReplies
    if (nextTicket === null && choices.length === 0 && replies.length === 0) return beneath

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
          {replies.map(reply => (
            <Button
              key={`reply-${reply}`}
              label={reply}
              variant={current?.hasRecommendation === true && /recommend/i.test(reply) ? 'primary' : 'secondary'}
              onPress={() => void send($, reply).catch(report($))}
            />
          ))}
        </Box>
        {beneath}
      </Box>
    )
  })
}
