import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { nameFor } from './name'

const suggestion = atom({ plugin: 'session-auto-namer', key: 'suggestion' } as const, null)

export const register: Register = on => {
  // A /clear goes on under a new session id, but the transcript's count of prompts does not start
  // again, so the module remembers it. It outlives the /clear, which does not reload the mod.
  let isCleared = false

  on('session.end', async ($, e, next) => {
    const done = await next(e)
    if (e.reason === 'clear') {
      isCleared = true
      await update($, suggestion, () => null)
    }
    return done
  })

  on('prompt.submit', async ($, e, next) => {
    // Asked before the prompt enters: a session's first prompt finds no earlier one, a resumed session's does.
    const isFirst = isCleared || (await $.session.turns()) === 0
    isCleared = false
    const done = await next(e)
    if (isFirst) await update($, suggestion, () => nameFor(e.text) ?? null)
    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const beneath = await next(e)
    const name = await read($, suggestion)
    if (name === null) return beneath

    const { Box, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1} width={e.props.bodyColumns}>
          <Button key="name" label={`Name: ${name}`} onPress={() => undefined} />
        </Box>
        {beneath}
      </Box>
    )
  })
}
