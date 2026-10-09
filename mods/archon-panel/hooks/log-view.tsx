// The Log sub-tab: the picked run's run log, cut to the picked node, with the
// files the run kept and a read view for one of them.

import type { Elements, RenderElement } from 'claude-code'

import type { ArchonView, Detail, LogRow, LogWindow, Run, RunFile } from '../types'
import { FOLD_CHARS, isUnder, nodesOf, toolSteps, WINDOW_CHARS } from './log'
import { shortId } from './runs-view'
import { size } from './text'

/** The most wrapped lines a node's output or error shows before the rest folds. */
const OUTPUT_LINES = 10

/** A file of the run, as opened in the read view. */
export type OpenedFile = {
  path: string
  text: string
  isBinary: boolean
  size: number
}

export type LogProps = {
  ui: Elements[keyof Elements]
  run: Run | undefined
  runs: readonly Run[]
  detail: Detail | undefined
  window: LogWindow
  view: ArchonView
  width: number
  /** The run's page in Archon's web UI, or '' when it is not linked. */
  link: string
  /** The run's files folder on disk, to tell a Write row of a file it kept. */
  filesFolder: string
  file: OpenedFile | undefined
  notice: string
  onFold: (key: string) => void
  onAll: () => void
  onFiles: () => void
  onFile: (path: string) => void
  onBack: () => void
  onOpen: () => void
  onMention: () => void
}

/** A run log's file path relative to the run's files folder; '' when it is outside it. */
export function keptPath(path: string, folder: string): string {
  const slashed = path.replace(/\\/g, '/')
  const base = folder.replace(/\\/g, '/').replace(/\/+$/, '')
  if (base === '') return ''
  return slashed.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? slashed.slice(base.length + 1) : ''
}

/** Lines of `text` cut at `count` wrapped lines at `width`, and how many lines were left out. */
function cutLines(text: string, count: number, width: number): { shown: string[]; more: number } {
  const lines = text.replace(/\n+$/, '').split('\n')
  const shown: string[] = []
  let used = 0
  for (const line of lines) {
    const rows = Math.max(1, Math.ceil(Array.from(line).length / Math.max(8, width)))
    if (used + rows > count) break
    shown.push(line)
    used += rows
  }
  return { shown, more: lines.length - shown.length }
}

function header(props: LogProps, run: Run): RenderElement {
  const { Box, Text, Link } = props.ui
  const parent = props.runs.find(other => other.id === run.parentId)
  const name = `${parent === undefined ? '' : `${parent.workflow} › `}${run.workflow}`
  return (
    <Box key="loghead" flexDirection="row" columnGap={1}>
      <Text bold wrap="truncate-end">{`${name} · ${shortId(run.id)} · ${run.status}`}</Text>
      {props.link !== '' && <Link key="archon-link" href={props.link} label="↗ Archon" />}
    </Box>
  )
}

function filesLines(props: LogProps, files: readonly RunFile[]): RenderElement[] {
  const { Box, Button } = props.ui
  if (files.length === 0) return []
  const count = `${files.length} file${files.length === 1 ? '' : 's'}`
  const names = files.map(file => file.path.slice(file.path.lastIndexOf('/') + 1)).join(' · ')
  if (!props.view.isFilesOpen) return [<Button key="files" plain label={`▸ ${count}: ${names}`} onPress={props.onFiles} />]
  return [
    <Button key="files" plain label={`▾ ${count}`} onPress={props.onFiles} />,
    ...files.map(file => (
      <Box key={`filerow-${file.path}`} flexDirection="row">
        <Box flexShrink={0}><Button key={`file-${file.path}`} plain label={`${file.path}  ${size(file.size)}`} onPress={() => props.onFile(file.path)} /></Box>
      </Box>
    )),
  ]
}

/** The read view of one file the run kept: Markdown for `.md`, Code for anything else, capped at 60,000 characters. */
function readView(props: LogProps): RenderElement[] {
  const { Box, Text, Button, Markdown, Code } = props.ui
  const lines: RenderElement[] = [
    <Box key="filehead" flexDirection="row" columnGap={2}>
      <Button key="file-back" plain hotkey="b" label="back" onPress={props.onBack} />
      <Button key="file-open" plain hotkey="o" label="open" onPress={props.onOpen} />
      <Button key="file-mention" plain dimColor label="@ prompt" onPress={props.onMention} />
    </Box>,
    <Text bold wrap="truncate-end">{props.view.file}</Text>,
  ]
  if (props.notice !== '') lines.push(<Text dimColor>{props.notice}</Text>)
  const file = props.file
  if (file === undefined || file.path !== props.view.file) return [...lines, <Text dimColor>Reading…</Text>]
  if (file.isBinary) return [...lines, <Text dimColor>{`A binary file, ${size(file.size)}.`}</Text>]
  const shown = file.text.slice(0, WINDOW_CHARS)
  lines.push(file.path.toLowerCase().endsWith('.md') ? <Markdown key="filetext" text={shown} /> : <Code key="filetext" source={shown} />)
  if (file.text.length > WINDOW_CHARS) lines.push(<Text dimColor>{`… ${size(file.text.length - WINDOW_CHARS)} more: open it outside`}</Text>)
  return lines
}

export function logBody(props: LogProps): RenderElement[] {
  const { ui, run, view, width } = props
  const { Box, Text, Button } = ui
  if (run === undefined) return [<Text dimColor>Pick a run in Runs to see its log.</Text>]
  if (view.file !== '') return [header(props, run), ...readView(props)]
  const events = props.detail?.events ?? []
  const steps = toolSteps(events)
  const window = props.window.runId === run.id ? props.window : undefined
  const lines: RenderElement[] = [header(props, run)]
  if (view.node !== '') {
    lines.push(
      <Box key="logcut" flexDirection="row" columnGap={1}>
        <Text dimColor>{`cut to ${view.node} ·`}</Text>
        <Button key="log-all" plain dimColor hotkey="a" label="all nodes" onPress={props.onAll} />
      </Box>,
    )
  }
  lines.push(...filesLines(props, props.detail?.files ?? []))
  if (window === undefined) return [...lines, <Text dimColor>Reading the run log…</Text>]

  if (window.dropped > 0) lines.push(<Box key="log-dropped"><Text dimColor>{`… ${window.dropped} earlier rows not kept`}</Text></Box>)
  if (window.isMissing) lines.push(<Box key="log-missing"><Text dimColor>This run's transcript is missing; node output and errors still show from its events.</Text></Box>)

  const outputOf = (node: string, key: string) => {
    for (const e of events.filter(ev => ev.step === node && ((ev.type === 'node_completed' && ev.output !== '') || (ev.type === 'node_failed' && ev.error !== '')))) {
      const isError = e.type === 'node_failed'
      const foldKey = `out-${key}-${isError ? 'error' : 'output'}`
      const isOpen = view.fold === foldKey
      const cut = cutLines(isError ? e.error : e.output, isOpen ? Number.MAX_SAFE_INTEGER : OUTPUT_LINES, width)
      cut.shown.forEach((text, i) => lines.push(
        <Box key={`log-${foldKey}-${i}`}>{isError ? <Text color="error" wrap="wrap">{text}</Text> : <Text dimColor wrap="wrap">{text}</Text>}</Box>,
      ))
      if (cut.more > 0) lines.push(<Box key={`log-${foldKey}-more`}><Button key={foldKey} plain dimColor label={`▸ ${cut.more} more lines`} onPress={() => props.onFold(foldKey)} /></Box>)
    }
  }

  const ended = new Set<string>()
  for (const row of window.rows) {
    if (!isUnder(row, view.node, steps)) continue
    const nodes = nodesOf(row, steps)
    const isBody = row.kind === 'text' || row.kind === 'tool' || row.kind === 'exec'
    const tag = !isBody ? '' : view.node === '' ? (nodes.length === 0 ? '' : `${nodes.join(' ∥ ')} · `) : nodes.length > 1 ? '∥ ' : ''
    const tagText = tag === '' ? null : <Text dimColor>{tag}</Text>
    if (row.kind === 'tool' && row.full !== '') {
      lines.push(
        <Box key={`log-${row.key}`} flexDirection="row">
          {tagText}
          <Button key={`fold-${row.key}`} plain label={row.text} onPress={() => props.onFold(row.key)} />
        </Box>,
      )
      if (view.fold === row.key) lines.push(...foldLines(props, row))
      continue
    }
    const tone = row.kind === 'error' ? { color: 'error' as const } : row.kind === 'skip' ? { dimColor: true } : {}
    row.text.split('\n').forEach((text, i) => lines.push(
      <Box key={`log-${row.key}${i === 0 ? '' : `-${i}`}`} flexDirection="row">
        {i === 0 ? tagText : null}
        <Text {...tone} wrap="wrap">{text}</Text>
      </Box>,
    ))
    if (row.kind === 'end' || row.kind === 'error') {
      const node = nodes[0] ?? ''
      if (!ended.has(node)) {
        ended.add(node)
        outputOf(node, row.key)
      }
    }
  }
  // A skipped node never starts, so the transcript has no row for it: the events give it, with its cause.
  for (const skipped of events.filter(e => e.type === 'node_skipped' && (view.node === '' || view.node === e.step))) {
    lines.push(<Box key={`log-skip-${skipped.step}`}><Text dimColor wrap="wrap">{`– ${skipped.step} skipped${skipped.reason === '' ? '' : `: ${skipped.reason}`}`}</Text></Box>)
  }
  // Output and errors of nodes whose end marker is not in the window, as with a missing transcript.
  const seen = new Set(events.filter(e => e.type === 'node_completed' || e.type === 'node_failed').map(e => e.step))
  for (const node of seen) if (!ended.has(node) && (view.node === '' || view.node === node)) outputOf(node, `ev-${node}`)
  if (window.end !== '') lines.push(<Box key="log-end"><Text {...(window.end.startsWith('✗') ? { color: 'error' as const } : {})}>{window.end}</Text></Box>)
  return lines
}

function foldLines(props: LogProps, row: LogRow): RenderElement[] {
  const { Box, Text, Button } = props.ui
  const shown = row.full.slice(0, FOLD_CHARS)
  const lines: RenderElement[] = shown.split('\n').map((text, i) => (
    <Box key={`log-${row.key}-fold-${i}`}><Text dimColor wrap="wrap">{text}</Text></Box>
  ))
  if (row.full.length > FOLD_CHARS) lines.push(<Box key={`log-${row.key}-fold-more`}><Text dimColor>{`… ${size(row.full.length - FOLD_CHARS)} more not shown`}</Text></Box>)
  const path = /^file_path: (.*)$/m.exec(row.full)?.[1] ?? ''
  const kept = row.text.startsWith('Write ') ? keptPath(path, props.filesFolder) : ''
  if (kept !== '') lines.push(<Box key={`log-${row.key}-fold-open`}><Button key={`write-open-${row.key}`} plain label={`open ${kept}`} onPress={() => props.onFile(kept)} /></Box>)
  return lines
}
