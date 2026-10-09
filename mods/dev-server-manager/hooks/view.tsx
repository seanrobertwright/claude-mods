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

/** Where the output sits: the rows above it, its own rows, whether it is bounded, and the picked server's lines. */
export type Geometry = { used: number; outputRows: number; isBounded: boolean; lines: OutputLine[] }

/**
 * The pane's rows above the output (title, table, hidden line, hint or detail
 * block), the output box's height (one row under the body, so the engine has
 * nothing to scroll and keeps its window at the top), and whether it is at
 * least the floor; below it the engine scrolls the whole body.
 */
export function paneGeometry(data: Omit<PaneData, 'actions' | 'hasSettings'>, columns: number, bodyRows: number): Geometry {
  const width = Math.max(20, columns)
  const { shown, hidden } = paneRows(data)
  const picked = shown.find(row => row.def.name === data.view.picked)
  const empty = shown.length === 0 && hidden.length === 0
  let used = 1 + shown.length + (hidden.length > 0 ? 1 : 0) + (empty ? rowsOf(EMPTY_TEXT, width) : 0)
  let lines: OutputLine[] = []
  if (picked === undefined) {
    if (!empty) used += rowsOf(HINT_TEXT, width)
  } else {
    const isPeer = isPeerRow(picked)
    const url = isPeer ? picked.peer?.url ?? '' : picked.run?.url ?? ''
    const head = !isPeer && statusOf(picked) === 'crashed' ? errorHead(picked.run) : ''
    used += 4 + (url !== '' ? 1 : 0) + (head !== '' ? 1 : 0) + rowsOf(rowWords(picked, data.now).text, width) + (data.view.isFillRefused ? 1 : 0)
    lines = data.output[picked.def.name] ?? []
  }
  const outputRows = bodyRows - 1 - used
  return { used, outputRows, isBounded: picked !== undefined && outputRows >= OUTPUT_FLOOR, lines }
}

/** A move of the person's, in the pane's own terms: lines, a page of the box, or the first line or the end. */
export type Move = { lines: number } | { pages: number } | 'first' | 'end'

/**
 * What a `ui.scroll` move means for the output box. The engine sizes page keys
 * by its own body (`bodyRows`) and Home and End by the whole tree (`contentRows`),
 * which the bounded pane keeps one row under the body.
 */
export function moveOf(by: number, bodyRows: number, contentRows: number): Move {
  if (contentRows !== bodyRows && Math.abs(by) === contentRows) return by < 0 ? 'first' : 'end'
  if (Math.abs(by) >= bodyRows) return { pages: Math.sign(by) }
  return { lines: by }
}

/** Where the output's view goes after a move: the seq of its first drawn line, or null to follow the tail again. */
export function scrollAnchor(lines: readonly OutputLine[], rows: number, anchor: number | null, move: Move): number | null {
  const last = Math.max(0, lines.length - rows)
  const pinnedAt = anchor === null ? -1 : lines.findIndex(line => line.seq >= anchor)
  const first = pinnedAt < 0 ? last : pinnedAt
  let next: number
  if (move === 'first') next = 0
  else if (move === 'end') next = last
  else if ('pages' in move) next = first + move.pages * Math.max(1, rows - 1)
  else next = first + move.lines
  next = Math.max(0, Math.min(last, next))
  return next >= last ? null : lines[next]?.seq ?? null
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

  const geometry = paneGeometry(data, columns, bodyRows)
  const table = shown.map(row => {
    const name = row.def.name
    const port = portOf(row) > 0 ? `:${portOf(row)}` : ''
    const lead = `${row === picked ? '▸' : ' '}${glyph(row)} `
    const middle = ` ${pad(port, portWidth)}  `
    const words = tableWords(row, now)
    const room = width - Array.from(lead).length - nameWidth - Array.from(middle).length
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
  const empty = shown.length === 0 && hidden.length === 0

  let detail = null
  if (picked !== undefined) {
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
  }

  const { lines, outputRows, isBounded } = geometry
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
