import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { nameFor } from './name'

const suggestion = atom({ plugin: 'session-auto-namer', key: 'suggestion' } as const, null)

// Each mod carries its own copy (ADR-0001): a session shown on no surface is headless.
async function isShown($: EngineInterface): Promise<boolean> {
  return (await $.session.surfaces()).length > 0
}

/** Renames the session to `name`, as `/rename <name>` typed by the person does; the button goes first. */
async function rename($: EngineInterface, name: string): Promise<void> {
  await update($, suggestion, () => null)
  await $.command.run({ command: 'rename', args: name })
}

async function dismiss($: EngineInterface): Promise<void> {
  await update($, suggestion, () => null)
}

function report($: EngineInterface): (error: unknown) => void {
  return error => $.ui.toast(`session-auto-namer: ${error instanceof Error ? error.message : String(error)}`)
}

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
    // Nobody sees a headless session's band: suggest nothing there.
    if (isFirst && (await isShown($))) await update($, suggestion, () => nameFor(e.text) ?? null)
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
          <Button key="name" label={`Name: ${name}`} onPress={() => void rename($, name).catch(report($))} />
          <Button key="dismiss" label="×" onPress={() => void dismiss($).catch(report($))} />
        </Box>
        {beneath}
      </Box>
    )
  })
}
