import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { OutputFile, OutputsView } from '../types'
import { ago, fit, isOutput, isScanned, joined, MOST_DEPTH, MOST_FOLDERS, nativePath, newestFirst, openers, outputFile, windowsFolder } from './files'

const PANE = 'outputs'
const TITLE = 'Outputs'
/** The settings dialog's command and its gear's key (ADR-0005). mod-settings takes the press; the gear's onPress is the fallback. */
const SETTINGS = 'mod-settings'
/** A scan after a tool call is skipped when the last one was this recent. */
const SCAN_GAP_MS = 2_000
/** The most rows of each kind the pane draws. */
const MOST_ROWS = 20

const EMPTY: OutputsView = { since: 0, files: [], isCut: false, isOtherOpen: false, error: '' }
const view = atom({ plugin: 'outputs', key: 'view' } as const, EMPTY)

// Dies with the module on a reload, which only brings the next scan forward.
let lastScanAt = 0

// Each mod carries its own copy (ADR-0001): a session shown on no surface is headless.
async function isShown($: EngineInterface): Promise<boolean> {
  return (await $.session.surfaces()).length > 0
}

function report($: EngineInterface): (error: unknown) => void {
  return error => $.ui.toast(`Outputs: ${error instanceof Error ? error.message : String(error)}`)
}

async function isWindows($: EngineInterface): Promise<boolean> {
  return (await $.env.get('OS')) === 'Windows_NT'
}

/** Lists the files under the project folder changed since the session began, folder by folder, within a bound. */
async function scan($: EngineInterface): Promise<void> {
  const { since } = await read($, view)
  if (since === 0) return
  lastScanAt = await $.clock.now()
  const root = await $.session.cwd()
  const found: OutputFile[] = []
  const waiting: { folder: string; depth: number }[] = [{ folder: '', depth: 0 }]
  let listed = 0
  let error = ''
  let isTooDeep = false
  for (let next = waiting.shift(); next !== undefined && listed < MOST_FOLDERS; next = waiting.shift()) {
    const { folder, depth } = next
    listed += 1
    const entries = await $.fs.list(folder === '' ? root : `${root}/${folder}`).catch((caught: unknown) => {
      // The project folder itself unreadable is worth saying; one folder inside it is passed over.
      if (folder === '') error = `Could not list the project folder: ${caught instanceof Error ? caught.message : String(caught)}`
      return []
    })
    for (const entry of entries) {
      if (isOutput(entry, since)) found.push(outputFile(root, folder, entry))
      else if (isScanned(entry)) {
        if (depth < MOST_DEPTH) waiting.push({ folder: joined(folder, entry.name), depth: depth + 1 })
        else isTooDeep = true
      }
    }
  }
  const isCut = waiting.length > 0 || isTooDeep
  await update($, view, (current): OutputsView => ({ ...current, files: newestFirst(found), isCut, error }))
}

/**
 * Opens the file with its own application, or says it could not: when the file is gone since the scan, or
 * when no opener both started and, where its exit code is trusted, exited 0.
 */
async function openFile($: EngineInterface, file: OutputFile): Promise<void> {
  // A network location is not looked at; the openers try it as they would any file.
  if (await $.fs.exists(file.path).catch(() => true)) {
    const windows = (await isWindows($)) ? windowsFolder(await $.env.get('SystemRoot')) : undefined
    for (const { argv, isExitTrusted } of openers(file.path, windows)) {
      const run = await $.process.run(argv).catch(() => undefined)
      if (run !== undefined && (run.exitCode === 0 || !isExitTrusted)) return
    }
  }
  $.ui.toast(`Outputs: could not open ${file.name}`)
}

async function copyPath($: EngineInterface, file: OutputFile): Promise<void> {
  const copied = await $.ui.copy({ text: nativePath(file.path, await isWindows($)) })
  $.ui.toast(copied.isCopied ? `Copied the path of ${file.name}.` : `Could not copy: ${copied.reason}`)
}

/** Whether mod-settings is installed: the gear shows only then. A command list that cannot be read shows none. */
async function isSettingsInstalled($: EngineInterface): Promise<boolean> {
  return (await $.command.list().catch(() => [])).some(command => command.name === SETTINGS)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'outputs', description: 'Open the Outputs pane: the files this session has made or changed' })
    // A reload starts the module again within one session: the session's own start time stands.
    const now = await $.clock.now()
    await update($, view, (current): OutputsView => (current.since === 0 ? { ...current, since: now } : current))
    return started
  })

  // The tools that can write a file; a shell tool's name depends on the machine.
  on('tool.call', { tool: /^(Write|Edit|NotebookEdit|Bash|PowerShell)$/ }, async ($, e, next) => {
    const called = await next(e)
    // Awaited: work left running when a hook returns is dropped with its dispatch.
    const isDue = (await $.clock.now().catch(() => 0)) - lastScanAt >= SCAN_GAP_MS
    if (isDue && (await isShown($).catch(() => false))) await scan($).catch(() => undefined)
    return called
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && (await isShown($).catch(() => false))) await scan($).catch(() => undefined)
    return done
  })

  on('command.run', { command: 'outputs' }, async $ => {
    // Asked, the pane comes in front of the others and takes the keyboard, which Esc hands back.
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    await scan($).catch(report($))
    return { text: 'Outputs pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const hasSettings = await isSettingsInstalled($)
    const current = await read($, view)
    const now = await $.clock.now()
    const width = Math.max(16, e.props.bodyColumns)
    const room = width - 1
    const documents = current.files.filter(file => file.isDocument)
    const others = current.files.filter(file => !file.isDocument)

    const rows = (files: readonly OutputFile[], prefix: string) =>
      files.slice(0, MOST_ROWS).map((file, index) => (
        <Box key={`${prefix}-row-${index}`} flexDirection="column">
          <Button key={`${prefix}-open-${index}`} plain label={fit(file.name, room)} onPress={() => void openFile($, file).catch(report($))} />
          <Box flexDirection="row" columnGap={2}>
            <Text dimColor wrap="truncate-end">  {file.folder === '' ? '' : `${fit(file.folder, Math.max(8, room - 24))} · `}{ago(now - file.mtimeMs)}</Text>
            <Button
              key={`${prefix}-copy-${index}`}
              plain
              dimColor
              hotkey={prefix === 'doc' && index === 0 ? 'c' : undefined}
              label="copy path"
              onPress={() => void copyPath($, file).catch(report($))}
            />
          </Box>
        </Box>
      ))

    return (
      <Box flexDirection="column" width={width}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>{TITLE}</Text>
          <Box flexDirection="row" columnGap={1}>
            <Button key="refresh" plain dimColor hotkey="r" label="refresh" onPress={() => void scan($).catch(report($))} />
            {hasSettings && <Button key={SETTINGS} plain dimColor label="⚙" onPress={() => void $.command.run({ command: SETTINGS }).catch(report($))} />}
          </Box>
        </Box>
        {current.error !== '' && <Text color="red" wrap="wrap">{current.error}</Text>}
        {current.files.length === 0 && current.error === '' && (
          <Text dimColor wrap="wrap">Nothing made or changed in this folder since the session began.</Text>
        )}
        {rows(documents, 'doc')}
        {documents.length > MOST_ROWS && <Text dimColor>{`+${documents.length - MOST_ROWS} more`}</Text>}
        {others.length > 0 && (
          <Box flexDirection="column" marginTop={documents.length > 0 ? 1 : 0}>
            <Button
              key="other"
              plain
              dimColor
              hotkey="o"
              label={`${others.length} other file${others.length === 1 ? '' : 's'} ${current.isOtherOpen ? '(hide)' : '(show)'}`}
              onPress={() => void update($, view, (held): OutputsView => ({ ...held, isOtherOpen: !held.isOtherOpen })).catch(report($))}
            />
            {current.isOtherOpen && rows(others, 'other')}
          </Box>
        )}
        {current.isCut && <Text dimColor wrap="wrap">This folder is large: only part of it was looked through.</Text>}
      </Box>
    )
  })
}
