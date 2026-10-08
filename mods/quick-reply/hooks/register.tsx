import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { optionReply, parseReplies, readAnswer } from './detect'

const reading = atom({ plugin: 'quick-reply', key: 'reading' } as const, null)

async function send($: EngineInterface, text: string): Promise<void> {
  await update($, reading, () => null)
  await $.prompt.submit({ text, asUser: true })
}

function report($: EngineInterface): (error: unknown) => void {
  return error => $.ui.toast(`quick-reply: ${error instanceof Error ? error.message : String(error)}`)
}

export const register: Register = (on, options) => {
  const questionReplies = parseReplies(options.questionReplies)
  const idleReplies = parseReplies(options.idleReplies)

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    // A subagent's turn is not one the person answers.
    if (e.agentId !== undefined) return done
    await update($, reading, () => (e.reason === 'answer' ? readAnswer(e.answer) : null))
    return done
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, reading, () => null)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Whatever is beneath (another mod's band, the engine's own) keeps its row under the replies.
    const beneath = await next(e)
    const current = await read($, reading)
    if (current === null || e.props.hasSurvey || e.props.isWorking || e.props.view.agentId !== undefined) {
      return beneath
    }
    const replies = current.isQuestion ? questionReplies : idleReplies
    if (current.options.length === 0 && replies.length === 0) return beneath

    const { Box, Text, Button } = $.ui.resolve(e)

    // The outer Box takes no width: the engine refuses its own band under a Box that sets one.
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} width={e.props.bodyColumns}>
          <Text dimColor>Reply:</Text>
          {current.options.map(option => (
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
              variant={current.hasRecommendation && /recommend/i.test(reply) ? 'primary' : 'secondary'}
              onPress={() => void send($, reply).catch(report($))}
            />
          ))}
        </Box>
        {beneath}
      </Box>
    )
  })
}
