import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Entry } from '../types'
import { fitCount, listing, parseRequest, parseStored, promptText, USAGE, withEntry, withoutEntry } from './shelf'

const STORE_KEY = 'entries'
const LABEL = 'Shelf:'

const entries = atom({ plugin: 'shelf', key: 'entries' } as const, [] as Entry[])

function report($: EngineInterface): (error: unknown) => void {
  return error => $.ui.toast(`shelf: ${error instanceof Error ? error.message : String(error)}`)
}

/** Writes the shelf where the band reads it and where the next session finds it. */
async function keep($: EngineInterface, change: (held: readonly Entry[]) => Entry[]): Promise<void> {
  const next = change(parseStored(await $.store.get(STORE_KEY)))
  await $.store.set(STORE_KEY, next)
  await update($, entries, () => next)
}

async function drop($: EngineInterface, entry: Entry): Promise<void> {
  // Nothing is sent: the path lands at the cursor and the person carries on typing.
  await $.prompt.fill({ text: promptText(entry.path), mode: 'insert' })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'shelf', description: 'List the shelf, or add or remove a named path: add <name> [path], remove <name>' })
    const stored = parseStored(await $.store.get(STORE_KEY))
    await update($, entries, () => stored)
    return started
  })

  on('command.run', { command: 'shelf' }, async ($, e) => {
    const request = parseRequest(e.args)
    if (request.kind === 'usage') return { text: USAGE }
    if (request.kind === 'list') return { text: listing(parseStored(await $.store.get(STORE_KEY))) }
    if (request.kind === 'remove') {
      await keep($, held => withoutEntry(held, request.name))
      return { text: `Removed ${request.name} from the shelf.` }
    }
    const entry = { name: request.name, path: request.path ?? (await $.session.cwd()) }
    await keep($, held => withEntry(held, entry))
    return { text: `${entry.name} is on the shelf: ${entry.path}` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Whatever is beneath (another mod's band, the engine's own) keeps its row under the shelf.
    const beneath = await next(e)
    const held = await read($, entries)
    if (held.length === 0 || e.props.hasSurvey || e.props.view.agentId !== undefined) return beneath

    const { Box, Text, Button } = $.ui.resolve(e)
    const shown = held.slice(0, fitCount(held, e.props.bodyColumns, LABEL.length + 1))
    const hidden = held.length - shown.length

    // The outer Box takes no width: the engine refuses its own band under a Box that sets one.
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1} width={e.props.bodyColumns}>
          <Text dimColor>{LABEL}</Text>
          {shown.map(entry => (
            <Button key={`entry-${entry.name}`} label={entry.name} onPress={() => void drop($, entry).catch(report($))} />
          ))}
          {hidden > 0 ? <Text dimColor>{`+${hidden} in /shelf`}</Text> : null}
        </Box>
        {beneath}
      </Box>
    )
  })
}
