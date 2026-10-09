import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { issueIn, nameFor } from './name'

/** A title gh has not read by then is not waited for. */
const GH_TIMEOUT_MS = 10_000

const suggestion = atom({ plugin: 'session-auto-namer', key: 'suggestion' } as const, null)

// Each mod carries its own copy (ADR-0001): a session shown on no surface is headless.
async function isShown($: EngineInterface): Promise<boolean> {
  return (await $.session.surfaces()).length > 0
}

/**
 * The title of the issue or pull request at `endpoint`, read by gh, or
 * undefined when gh does not start or cannot read it. gh is not a requirement:
 * without it a name comes from the other rules.
 */
async function titleOf($: EngineInterface, endpoint: string): Promise<string | undefined> {
  try {
    const run = await $.process.run(['gh', 'api', '--jq', '.title', endpoint], { timeoutMs: GH_TIMEOUT_MS })
    const title = run.stdout.trim()
    return run.exitCode === 0 && title !== '' ? title : undefined
  } catch {
    return undefined
  }
}

/** The name the rules give the session's first prompt. */
async function suggestFor($: EngineInterface, prompt: string): Promise<string | undefined> {
  const issue = issueIn(prompt)
  const title = issue === undefined ? undefined : await titleOf($, issue.endpoint)
  return nameFor(prompt, issue === undefined || title === undefined ? undefined : { number: issue.number, title })
}

async function suggest($: EngineInterface, prompt: string): Promise<void> {
  const name = await suggestFor($, prompt)
  await update($, suggestion, () => name ?? null)
}

async function dismiss($: EngineInterface): Promise<void> {
  await update($, suggestion, () => null)
}

/** Renames the session to `name`, as `/rename <name>` typed by the person does; the button goes first. */
async function rename($: EngineInterface, name: string): Promise<void> {
  await dismiss($)
  await $.command.run({ command: 'rename', args: name })
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
      await dismiss($)
    }
    return done
  })

  on('prompt.submit', async ($, e, next) => {
    // Asked before the prompt enters: a session's first prompt finds no earlier one, a resumed session's does.
    const isFirst = isCleared || (await $.session.turns()) === 0
    isCleared = false
    const done = await next(e)
    // Nobody sees a headless session's band: suggest nothing there.
    // gh may take seconds to read a title: the prompt's hook does not wait for it.
    if (isFirst && (await isShown($))) void suggest($, e.text).catch(report($))
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
