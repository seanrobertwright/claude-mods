import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SourcesView } from '../types'
import { fullPath, grouped, isAllowed, named, normal, parseRequest, reached, refusal, shown, USAGE, withSource } from './paths'
import type { Reach } from './paths'

const PANE = 'sources'
const TITLE = 'Sources'
/** The settings dialog's command and its gear's key (ADR-0005). mod-settings takes the press; the gear's onPress is the fallback. */
const SETTINGS = 'mod-settings'
/** The most files a group lists before it counts the rest. */
const MOST_ROWS = 8

const EMPTY: SourcesView = { sources: [], isLocked: false, allowed: [] }
const view = atom({ plugin: 'sources', key: 'view' } as const, EMPTY)

// Each mod carries its own copy (ADR-0001): a session shown on no surface is headless.
async function isShown($: EngineInterface): Promise<boolean> {
  return (await $.session.surfaces()).length > 0
}

function report($: EngineInterface): (error: unknown) => void {
  return error => $.ui.toast(`Sources: ${error instanceof Error ? error.message : String(error)}`)
}

/** Where a full path lands, symlinks and junctions followed, when it exists and can be looked at; else the path as folded. */
async function landed($: EngineInterface, path: string): Promise<string> {
  const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
  return normal(stat?.realPath ?? path)
}

/**
 * The first place the call reaches outside the project folder and the allowed folders, or undefined when
 * all are inside. Each place is compared where it lands; each folder both as folded and where it lands,
 * so a place not there yet still counts as inside a folder that is itself a link.
 */
async function outside($: EngineInterface, reach: Reach, folders: readonly string[]): Promise<string | undefined> {
  if (reach.kind === 'unplaced') return reach.spelling
  const bounds = (await Promise.all(folders.map(async folder => [normal(folder), await landed($, normal(folder))]))).flat()
  for (const place of reach.places) {
    const real = await landed($, place)
    if (!isAllowed(real, bounds)) return real
  }
  return undefined
}

/** Whether mod-settings is installed: the gear shows only then. A command list that cannot be read shows none. */
async function isSettingsInstalled($: EngineInterface): Promise<boolean> {
  return (await $.command.list().catch(() => [])).some(command => command.name === SETTINGS)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'sources', description: 'Open the Sources pane: the files read this session. allow <path> lets reads into a folder while the lock is on' })
    return started
  })

  // Matched by pattern: which read tools a session has depends on the machine.
  on('tool.call', { tool: /^(Read|Grep|Glob)$/ }, async ($, e, next) => {
    // Quiet in a headless session: nothing is refused and nothing is kept.
    if (!(await isShown($).catch(() => false))) return next(e)
    const cwd = await $.session.cwd()
    const path = fullPath(named(e), cwd)
    const current = await read($, view)
    if (current.isLocked) {
      const refused = await outside($, reached(e.tool, e, cwd), [cwd, ...current.allowed])
      if (refused !== undefined) return { deny: refusal(refused) }
    }
    const called = await next(e)
    if (called.deny === undefined) {
      const at = await $.clock.now()
      await update($, view, (held): SourcesView => ({ ...held, sources: withSource(held.sources, path, at) })).catch(() => undefined)
    }
    return called
  })

  on('command.run', { command: 'sources' }, async ($, e) => {
    const request = parseRequest(e.args)
    if (request.kind === 'usage') return { text: USAGE }
    if (request.kind === 'allowed') {
      const { allowed } = await read($, view)
      return { text: allowed.length === 0 ? 'No folder outside the project folder is allowed.' : `Allowed besides the project folder:\n${allowed.join('\n')}` }
    }
    if (request.kind === 'allow') {
      const folder = fullPath(request.path, await $.session.cwd())
      await update($, view, (held): SourcesView => ({
        ...held,
        allowed: held.allowed.some(each => each.toLowerCase() === folder.toLowerCase()) ? held.allowed : [...held.allowed, folder],
      }))
      return { text: `Reads are allowed in ${folder} for this session.` }
    }
    // Asked, the pane comes in front of the others and takes the keyboard, which Esc hands back.
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    return { text: 'Sources pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const hasSettings = await isSettingsInstalled($)
    const current = await read($, view)
    const cwd = normal(await $.session.cwd())
    const width = Math.max(16, e.props.bodyColumns)
    const room = width - 3
    const groups = grouped(current.sources, cwd)

    return (
      <Box flexDirection="column" width={width}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold={current.isLocked} color={current.isLocked ? 'yellow' : undefined}>
            {current.isLocked ? 'Reads: this folder only' : 'Reads: anywhere'}
          </Text>
          <Box flexDirection="row" columnGap={1}>
            <Button
              key="lock"
              plain
              dimColor
              hotkey="l"
              label={current.isLocked ? 'unlock' : 'lock'}
              onPress={() => void update($, view, (held): SourcesView => ({ ...held, isLocked: !held.isLocked })).catch(report($))}
            />
            {hasSettings && <Button key={SETTINGS} plain dimColor label="⚙" onPress={() => void $.command.run({ command: SETTINGS }).catch(report($))} />}
          </Box>
        </Box>
        {current.isLocked && current.allowed.map((folder, index) => (
          <Text key={`allowed-${index}`} dimColor wrap="truncate-start">{`  also ${folder}`}</Text>
        ))}
        {groups.length === 0 && <Text dimColor wrap="wrap">Nothing read yet this session.</Text>}
        {groups.map((group, at) => (
          <Box key={`group-${at}`} flexDirection="column" marginTop={1}>
            <Text key={`group-title-${at}`} bold wrap="truncate-start">{`${group.label}  ${group.sources.length}`}</Text>
            {group.sources.slice(0, MOST_ROWS).map((source, index) => (
              <Text key={`source-${at}-${index}`} dimColor>{`  ${shown(source.path, group.isProject ? cwd : group.label, room)}`}</Text>
            ))}
            {group.sources.length > MOST_ROWS && <Text dimColor>{`  +${group.sources.length - MOST_ROWS} more`}</Text>}
          </Box>
        ))}
      </Box>
    )
  })
}
