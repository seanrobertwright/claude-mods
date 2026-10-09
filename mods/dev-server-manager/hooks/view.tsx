// The dev-servers pane: the title and gear, one line per server, the picked
// server's detail block and buttons, and its output docked below in a window
// of the mod's own, so the title and table never scroll away.
import type { Elements } from 'claude-code'

import type { OutputLine, PaneView, PeerEntry, Rows, ServerRun } from '../types'
import { ADD_USAGE } from './add'
import { actions, commandText, errorHead, glyph, isPeerRow, portOf, rowWords, statusOf } from './servers'
import type { Action, Row, Tone } from './servers'

/** The longest a name column grows; longer names are cut. */
export const NAME_COLUMNS = 12
/** Below this many output rows the pane lets the engine scroll the whole body instead. */
export const OUTPUT_FLOOR = 4
/** The most lines drawn when the engine scrolls the body. */
const UNBOUNDED_LINES = 100

export const EMPTY_TEXT = `Nothing to run here. Add one: ${ADD_USAGE}`
export const HINT_TEXT = 'Pick a server to act on it and see its output.'

export type PaneActions = {
  pick: (name: string) => void
  start: (name: string) => void
  stop: (name: string) => void
  restart: (name: string) => void
  fillError: (name: string) => void
  hide: (name: string) => void
  unhide: (name: string) => void
  toggleHidden: () => void
  latest: () => void
  settings: () => void
}

export type PaneData = {
  rows: Rows
  runs: Record<string, ServerRun>
  output: Record<string, OutputLine[]>
  view: PaneView
  peers: PeerEntry[]
  now: number
  hasSettings: boolean
  actions: PaneActions
}

const LABELS: Record<Action, string> = { start: 'start', stop: 'stop', restart: 'restart', error: 'error → prompt', hide: 'hide' }
const HOTKEYS: Record<Action, string> = { start: 's', stop: 'x', restart: 'r', error: 'e', hide: 'h' }

/** Text cut to `width` cells with `…`. */
export function cut(text: string, width: number): string {
  const chars = Array.from(text)
  if (chars.length <= width) return text
  return width <= 0 ? '' : `${chars.slice(0, width - 1).join('')}…`
}

function pad(text: string, width: number): string {
  const chars = Array.from(text)
  return chars.length >= width ? chars.slice(0, width).join('') : text + ' '.repeat(width - chars.length)
}

/** The rows the pane lists: this project's rows, hidden ones only while unfolded, then other sessions' servers it has no row for. */
export function paneRows(data: Pick<PaneData, 'rows' | 'runs' | 'peers' | 'view'>): { shown: Row[]; hidden: string[] } {
  const { rows, runs, peers, view } = data
  const peerOf = (name: string) => peers.find(peer => peer.name === name)
  const hidden = rows.defs.filter(def => def.source === 'detected' && rows.hidden.includes(def.name)).map(def => def.name)
  const shown: Row[] = rows.defs
    .filter(def => view.isShowingHidden || !hidden.includes(def.name))
    .map(def => ({ def, run: runs[def.name], peer: peerOf(def.name) }))
  for (const peer of peers) {
    if (rows.defs.some(def => def.name === peer.name)) continue
    shown.push({ def: { name: peer.name, source: 'added', argv: [peer.command], cwd: '', port: peer.port, blocked: '' }, run: undefined, peer })
  }
  return { shown, hidden }
}

/** The words a table row shows: a dead row adds its error's first line. */
function tableWords(row: Row, now: number): { text: string; tone: Tone } {
  const words = rowWords(row, now)
  const head = statusOf(row) === 'crashed' && !isPeerRow(row) ? errorHead(row.run) : ''
  return head === '' ? words : { ...words, text: `${words.text} · ${head}` }
}

function toneProps(tone: Tone): { color?: string; dimColor?: boolean } {
  if (tone === 'dim') return { dimColor: true }
  if (tone === 'yellow') return { color: 'warning' }
  if (tone === 'red') return { color: 'error' }
  return {}
}

/** How many rows a text takes wrapped at `width`. */
function rowsOf(text: string, width: number): number {
  return Math.max(1, Math.ceil(Array.from(text).length / Math.max(1, width)))
}

/** The output lines drawn in a window of `rows` rows: the tail while following, else from the pinned line. */
export function outputWindow(lines: readonly OutputLine[], rows: number, anchor: number | null): { drawn: OutputLine[]; isPinned: boolean } {
  if (anchor !== null) {
    const from = lines.findIndex(line => line.seq >= anchor)
    if (from >= 0 && from + rows < lines.length) return { drawn: lines.slice(from, from + rows - 1), isPinned: true }
  }
  return { drawn: lines.slice(Math.max(0, lines.length - rows)), isPinned: false }
}

/** The elements the pane draws with, as `$.ui.resolve(e)` gives them on every surface. */
export type Kit = Pick<Elements['mobile'], 'Box' | 'Text' | 'Button' | 'Link'>

/** The pane's tree for a body `columns` across and `bodyRows` down. */
export function renderPane(kit: Kit, columns: number, bodyRows: number, data: PaneData) {
  const { Box, Text, Button, Link } = kit
  const { view, now, actions: act } = data
  const width = Math.max(20, columns)
  const { shown, hidden } = paneRows(data)
  const nameWidth = Math.min(NAME_COLUMNS, Math.max(0, ...shown.map(row => Array.from(row.def.name).length)))
  const portWidth = Math.max(0, ...shown.map(row => (portOf(row) > 0 ? `:${portOf(row)}`.length : 0)))
  const picked = shown.find(row => row.def.name === view.picked)

  let used = 1
  const table = shown.map(row => {
    const name = row.def.name
    const port = portOf(row) > 0 ? `:${portOf(row)}` : ''
    const lead = `${row === picked ? '▸' : ' '}${glyph(row)} `
    const middle = ` ${pad(port, portWidth)}  `
    const words = tableWords(row, now)
    const room = width - Array.from(lead).length - nameWidth - Array.from(middle).length
    used += 1
    return (
      <Box key={`line-${name}`} flexDirection="row">
        <Text>{lead}</Text>
        <Button key={`row-${name}`} plain label={pad(name, nameWidth)} onPress={() => act.pick(name)} />
        <Box key={`port-${name}`}><Text>{middle}</Text></Box>
        <Box key={`words-${name}`}><Text wrap="truncate-end" {...toneProps(words.tone)}>{cut(words.text, room)}</Text></Box>
      </Box>
    )
  })

  const hiddenLine = hidden.length > 0 && (
    <Button
      key="hidden"
      plain
      dimColor
      label={cut(view.isShowingHidden ? `hide ${hidden.length} again` : `${hidden.length} hidden: ${hidden.join(', ')}`, width)}
      onPress={() => act.toggleHidden()}
    />
  )
  if (hidden.length > 0) used += 1
  const empty = shown.length === 0 && hidden.length === 0
  if (empty) used += rowsOf(EMPTY_TEXT, width)

  let detail = null
  let lines: OutputLine[] = []
  if (picked === undefined) {
    if (!empty) used += rowsOf(HINT_TEXT, width)
  } else {
    const name = picked.def.name
    const run = picked.run
    const isPeer = isPeerRow(picked)
    const url = isPeer ? picked.peer?.url ?? '' : run?.url ?? ''
    const status = statusOf(picked)
    const head = !isPeer && status === 'crashed' ? errorHead(run) : ''
    const words = rowWords(picked, now)
    const buttons = actions(picked, now)
    const rule = '─'.repeat(width)
    const hiddenRow = picked.def.source === 'detected' && data.rows.hidden.includes(name)
    used += 4 + (url !== '' ? 1 : 0) + (head !== '' ? 1 : 0) + rowsOf(words.text, width) + (view.isFillRefused ? 1 : 0)
    detail = (
      <Box key="detail" flexDirection="column">
        <Text dimColor>{rule}</Text>
        <Box flexDirection="row" columnGap={2}>
          <Text bold>{name}</Text>
          <Box key="command"><Text dimColor wrap="truncate-end">{commandText(picked.def)}</Text></Box>
        </Box>
        {url !== '' && <Link key="url" href={url} label={url.replace(/^https?:\/\//, '')} />}
        {head !== '' && <Box key="error-head"><Text color="error" wrap="truncate-end">{head}</Text></Box>}
        <Box key="words"><Text wrap="wrap" {...toneProps(words.tone)}>{words.text}</Text></Box>
        {view.isFillRefused && <Box key="fill-refused"><Text dimColor>can{"'"}t reach the prompt here</Text></Box>}
        <Box flexDirection="row" columnGap={2}>
          {hiddenRow
            ? <Button key="unhide" plain hotkey="u" label="unhide" onPress={() => act.unhide(name)} />
            : buttons.map(action => (
              <Button
                key={action}
                plain
                hotkey={HOTKEYS[action]}
                label={LABELS[action]}
                onPress={() => {
                  if (action === 'error') act.fillError(name)
                  else act[action](name)
                }}
              />
            ))}
        </Box>
        <Text dimColor>{rule}</Text>
      </Box>
    )
    lines = data.output[name] ?? []
  }

  // One row under the body, so the engine has nothing to scroll and keeps its window at the top.
  const outputRows = bodyRows - 1 - used
  const isBounded = outputRows >= OUTPUT_FLOOR
  const window = isBounded ? outputWindow(lines, outputRows, view.anchor) : { drawn: lines.slice(-UNBOUNDED_LINES), isPinned: false }
  const drawLine = (line: OutputLine) => (
    <Text
      key={`out-${line.seq}`}
      wrap="truncate-end"
      {...(line.isError === true ? { color: 'error' } : line.stream === 'divider' || line.stream === 'note' ? { dimColor: true } : {})}
    >
      {line.text === '' ? ' ' : line.text}
    </Text>
  )

  return (
    <Box flexDirection="column" width={width}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold>Dev servers</Text>
        {data.hasSettings && <Button key="mod-settings" plain dimColor label="⚙️" onPress={() => act.settings()} />}
      </Box>
      {empty && <Box key="empty"><Text wrap="wrap">{EMPTY_TEXT}</Text></Box>}
      {table}
      {hiddenLine}
      {picked === undefined && !empty && <Box key="hint"><Text dimColor wrap="wrap">{HINT_TEXT}</Text></Box>}
      {detail}
      {picked !== undefined && (isBounded
        ? (
          <Box key="output" flexDirection="column" height={outputRows} overflow="hidden">
            {window.drawn.map(drawLine)}
            {window.isPinned && <Button key="latest" plain dimColor label="↓ latest" onPress={() => act.latest()} />}
          </Box>
        )
        : <Box key="output" flexDirection="column">{window.drawn.map(drawLine)}</Box>)}
    </Box>
  )
}
