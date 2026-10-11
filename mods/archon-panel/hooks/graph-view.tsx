// The Graph sub-tab: the picked run's nodes as box-drawing text, include
// blocks, loop groups and sub-runs folded, each box a press that opens Log.

import type { Elements, RenderElement } from 'claude-code'

import type { ArchonView, Detail, GraphNode, Run, RunEvent } from '../types'
import { layout } from './graph'
import type { DrawNode, Seg } from './graph'
import type { Live } from './log'
import { hasEnded, needsYou, standing, subRunsOf, waitNode } from './runs'
import type { Look } from './text'
import { duration, fit } from './text'

/** A node's look from the events naming it: the last of started, completed, failed, skipped. */
function lookFrom(events: readonly RunEvent[], step: string, iteration?: number): Look {
  let look: Look = 'pending'
  for (const e of events) {
    if (e.step !== step || (iteration !== undefined && e.iteration !== iteration)) continue
    if (e.type === 'node_started') look = 'running'
    else if (e.type === 'node_completed') look = 'completed'
    else if (e.type === 'node_failed') look = 'failed'
    else if (e.type === 'node_skipped') look = 'skipped'
    else if (e.type === 'node_suspended') look = 'paused'
  }
  return look
}

/** How a set of looks reads as one: any failure, then any work, then all done, else waiting. */
function foldLook(looks: readonly Look[]): Look {
  if (looks.some(look => look === 'failed')) return 'failed'
  if (looks.some(look => look === 'running' || look === 'paused' || look === 'approval' || look === 'action')) return 'running'
  if (looks.length > 0 && looks.every(look => look === 'completed' || look === 'skipped')) return 'completed'
  return 'pending'
}

const isDone = (look: Look) => look === 'completed' || look === 'skipped'

/** The rounds a loop group has started, from its body's events. */
export function roundsOf(events: readonly RunEvent[], group: string): number {
  return Math.max(0, ...events.filter(e => e.step.startsWith(`${group}.`)).map(e => e.iteration))
}

function subRunLook(subRun: Run, runs: readonly Run[], details: Readonly<Record<string, Detail>>): { look: Look; isGate: boolean } {
  if (needsYou(subRun, runs, details) !== undefined) return { look: 'approval', isGate: true }
  return { look: subRun.status === 'paused' ? 'paused' : subRun.status, isGate: false }
}

/** The sub-runs a `workflow:` node started. */
export function nodeSubRuns(run: Run, node: GraphNode, runs: readonly Run[], workflowNodes: number): Run[] {
  return subRunsOf(run, runs).filter(subRun => subRun.parentNodeId === node.id || (subRun.parentNodeId === '' && workflowNodes === 1))
}

export type Graphed = {
  draw: DrawNode[]
  /** What a press on each box picks. */
  picks: Map<string, { kind: 'node' | 'block' | 'loop' | 'workflow'; id: string; subRuns: Run[] }>
}

/**
 * A node's look from the followed run log, where it names the node: a loop
 * group runs while any of its body runs. Undefined where the log is silent.
 */
function liveLook(live: ReadonlyMap<string, Look> | undefined, node: GraphNode): Look | undefined {
  if (live === undefined) return undefined
  if (node.kind === 'loop_group' && [...live].some(([id, look]) => id.startsWith(`${node.id}.`) && look === 'running')) return 'running'
  return live.get(node.id)
}

/**
 * The boxes of a run's graph: node states from its events, or from `live`, its
 * followed run log, where that names them; gates in `warning`, blocks and loops
 * folded unless opened. A gate's look wins over both.
 */
export function drawNodes(nodes: readonly GraphNode[], run: Run, runs: readonly Run[], details: Readonly<Record<string, Detail>>, view: ArchonView, live?: ReadonlyMap<string, Look>): Graphed {
  const events = details[run.id]?.events ?? []
  const found = standing(run, runs, details[run.id])
  const gateNode = waitNode(found)
  const picks: Graphed['picks'] = new Map()
  const workflows = nodes.filter(node => node.kind === 'workflow').length
  const looks = new Map<string, DrawNode>()
  for (const node of nodes) {
    let look = lookFrom(events, node.id)
    let label = node.id
    let isGate = node.id === gateNode
    picks.set(node.id, { kind: 'node', id: node.id, subRuns: [] })
    let isFromSubRuns = false
    if (node.kind === 'loop_group') {
      const round = roundsOf(events, node.id)
      if (round > 0) look = foldLook(node.body.map(body => lookFrom(events, `${node.id}.${body.id}`, round)))
      label = round > 0 ? `${node.id} ⟳${round}` : node.id
      picks.set(node.id, { kind: 'loop', id: node.id, subRuns: [] })
    } else if (node.kind === 'workflow') {
      const subRuns = nodeSubRuns(run, node, runs, workflows)
      picks.set(node.id, { kind: 'workflow', id: node.id, subRuns })
      if (subRuns.length === 1) {
        const shown = subRunLook(subRuns[0]!, runs, details)
        look = shown.look
        isGate = isGate || shown.isGate
        label = `↳ ${subRuns[0]!.workflow}`
        isFromSubRuns = true
      } else if (subRuns.length > 1) {
        const subLooks = subRuns.map(subRun => subRunLook(subRun, runs, details))
        look = foldLook(subLooks.map(s => s.look))
        isGate = isGate || subLooks.some(s => s.isGate)
        label = `↳ ${subRuns.filter(subRun => hasEnded(subRun)).length}/${subRuns.length}`
        isFromSubRuns = true
      } else label = `↳ ${node.workflow || node.id}`
    }
    // A sub-run's own status says more than the parent's log about its node.
    if (!isFromSubRuns) look = liveLook(live, node) ?? look
    if (node.id === gateNode) look = found.kind === 'approval' ? 'approval' : 'action'
    looks.set(node.id, { id: node.id, label, look, deps: node.deps, isGate, block: node.block })
  }

  // Include blocks fold to one box unless opened: `deliver 3/5`.
  const blockOf = (node: DrawNode) => node.block.split('__')[0] ?? ''
  const folded = new Set(nodes.map(node => blockOf(looks.get(node.id)!)).filter(block => block !== '' && !view.includes.includes(`${run.id}:${block}`)))
  const out: DrawNode[] = []
  const placed = new Set<string>()
  for (const node of nodes) {
    const drawn = looks.get(node.id)!
    const block = blockOf(drawn)
    if (!folded.has(block)) {
      out.push(drawn)
      continue
    }
    if (placed.has(block)) continue
    placed.add(block)
    const members = [...looks.values()].filter(n => blockOf(n) === block)
    const ids = new Set(members.map(n => n.id))
    const done = members.filter(n => isDone(n.look)).length
    out.push({
      id: `block:${block}`,
      label: `${block} ${done}/${members.length}`,
      look: foldLook(members.map(n => n.look)),
      deps: [...new Set(members.flatMap(n => n.deps).filter(dep => !ids.has(dep)))],
      isGate: members.some(n => n.isGate),
      block: '',
    })
    picks.set(`block:${block}`, { kind: 'block', id: block, subRuns: [] })
  }
  // Waits on a folded block's nodes wait on the block.
  const boxOf = (id: string) => {
    const drawn = looks.get(id)
    const block = drawn === undefined ? '' : blockOf(drawn)
    return folded.has(block) ? `block:${block}` : id
  }
  return {
    draw: out.map(node => ({ ...node, deps: [...new Set(node.deps.map(boxOf).filter(dep => dep !== node.id))] })),
    picks,
  }
}

/** A loop group's body as one round drew it: the current one, or an earlier one picked with ‹ ›. `live` speaks only for the current round. */
export function roundNodes(group: GraphNode, events: readonly RunEvent[], round: number, live?: ReadonlyMap<string, Look>): DrawNode[] {
  return group.body.map(body => {
    const id = `${group.id}.${body.id}`
    return { id, label: body.id, look: live?.get(id) ?? lookFrom(events, id, round), deps: body.deps.map(dep => `${group.id}.${dep}`), isGate: false, block: '' }
  })
}

/** When a node's current run started, from its events: the last `node_started` naming it; 0 when none does. */
function startedAt(events: readonly RunEvent[], step: string): number {
  return [...events].reverse().find(e => e.type === 'node_started' && e.step === step)?.at ?? 0
}

/**
 * The line under a live run's header saying what runs now: the running nodes,
 * how long the longest has run, and the newest tool call or model text, once
 * it was written after the newest of them started. Undefined when nothing runs.
 */
export function activityLine(live: Live | undefined, events: readonly RunEvent[], now: number): string | undefined {
  if (live === undefined || live.running.length === 0) return undefined
  const starts = live.running.map(({ node, since }) => since || startedAt(events, node))
  const known = starts.filter(at => at > 0)
  const longest = known.length === 0 ? '' : ` ${duration(now - Math.min(...known))}`
  const newestStart = Math.max(0, ...known)
  const latest = live.latest !== undefined && live.latest.text !== '' && live.latest.at >= newestStart ? live.latest : undefined
  const doing = latest === undefined ? '' : ` · ${latest.text}${latest.at > 0 ? ` · ${duration(now - latest.at)} ago` : ''}`
  return `${live.running.map(({ node }) => node).join(', ')}${longest}${doing}`
}

export type GraphProps = {
  ui: Elements[keyof Elements]
  run: Run | undefined
  runs: readonly Run[]
  details: Readonly<Record<string, Detail>>
  nodes: GraphNode[] | null | undefined
  view: ArchonView
  /** The run's followed run log, while the follower is on this run; undefined otherwise. */
  live: Live | undefined
  /** The flash's beat: on for heavy, bold borders on running nodes, off for light, dim ones. */
  pulse: boolean
  now: number
  width: number
  /** The run's page in Archon's web UI, or '' when it is not linked. */
  link: string
  onPick: (id: string) => void
  onFold: (block: string) => void
  onRound: (round: number) => void
  onParent: (parent: Run) => void
  onSubRun: (subRun: Run) => void
}

/** The drawn lines of a graph as elements: a box's name is a press that picks it. */
export function segLines(ui: GraphProps['ui'], lines: readonly Seg[][], onPick: (id: string) => void, prefix = 'node'): RenderElement[] {
  const { Box, Text, Button } = ui
  return lines.map(line => (
    <Box flexDirection="row">
      {line.map(seg => (seg.pick !== undefined
        ? <Button key={`${prefix}-${seg.pick}`} plain label={seg.text} onPress={() => onPick(seg.pick!)} />
        : <Text {...(seg.tone === undefined ? {} : { color: seg.tone })} {...(seg.bold === true ? { bold: true } : {})} {...(seg.dim === true ? { dimColor: true } : {})}>{seg.text}</Text>))}
    </Box>
  ))
}

export function graphBody(props: GraphProps): RenderElement[] {
  const { ui, run, view, width } = props
  const { Box, Text, Button, Link } = ui
  if (run === undefined) return [<Text dimColor>Pick a run in Runs to see its graph.</Text>]
  const parent = props.runs.find(other => other.id === run.parentId)
  const lines: RenderElement[] = []
  const status = `${run.status}  ${duration((hasEnded(run) ? run.completedAt : props.now) - run.startedAt)}`
  lines.push(
    <Box flexDirection="row" columnGap={1}>
      {parent !== undefined && <Button key="graph-parent" plain dimColor hotkey="b" label={`‹ ${parent.workflow}`} onPress={() => props.onParent(parent)} />}
      <Text bold wrap="truncate-end">{fit(`${parent === undefined ? '' : `${parent.workflow} › `}${run.workflow}  ${status}`, Math.max(8, width - 12))}</Text>
      {props.link !== '' && <Link key="archon-link" href={props.link} label="↗ Archon" />}
    </Box>,
  )
  const events = props.details[run.id]?.events ?? []
  const doing = hasEnded(run) ? undefined : activityLine(props.live, events, props.now)
  if (doing !== undefined) {
    lines.push(
      <Box flexDirection="row">
        <Text color="success" {...(props.pulse ? { bold: true } : { dimColor: true })}>●</Text>
        <Text wrap="truncate-end">{` ${fit(doing, Math.max(8, width - 2))}`}</Text>
      </Box>,
    )
  }
  if (props.nodes === undefined) return [...lines, <Text dimColor>Reading the run's workflow…</Text>]
  if (props.nodes === null || props.nodes.length === 0) return [...lines, <Text dimColor>This run's workflow source can't be read.</Text>]

  const graphed = drawNodes(props.nodes, run, props.runs, props.details, view, props.live?.looks)
  for (const block of view.includes.filter(entry => entry.startsWith(`${run.id}:`)).map(entry => entry.slice(run.id.length + 1))) {
    lines.push(<Button key={`fold-${block}`} plain dimColor label={`▾ ${block}`} onPress={() => props.onFold(block)} />)
  }
  lines.push(...segLines(ui, layout(graphed.draw, width, props.pulse).lines, props.onPick))

  // A picked loop group: its round's body as a small graph, stepping through earlier rounds.
  const group = view.loop.startsWith(`${run.id}:`) ? props.nodes.find(node => node.id === view.loop.slice(run.id.length + 1)) : undefined
  if (group !== undefined) {
    const current = roundsOf(events, group.id)
    const round = view.round > 0 && view.round <= current ? view.round : current
    lines.push(
      <Box flexDirection="row">
        <Text>{`round ${round} · `}</Text>
        <Button key="round-back" plain label="‹" onPress={() => props.onRound(Math.max(1, round - 1))} />
        <Text> </Text>
        <Button key="round-on" plain label="›" onPress={() => props.onRound(Math.min(current, round + 1))} />
      </Box>,
    )
    lines.push(...segLines(ui, layout(roundNodes(group, events, round, round === current ? props.live?.looks : undefined), width, props.pulse).lines, props.onPick, 'body'))
  }

  // A fan-out's sub-runs, listed once its box is picked.
  for (const node of props.nodes.filter(n => n.kind === 'workflow' && view.fanouts.includes(`${run.id}:${n.id}`))) {
    const pick = graphed.picks.get(node.id)
    for (const subRun of pick?.subRuns ?? []) {
      lines.push(<Button key={`sub-run-${subRun.id}`} plain label={fit(`↳ ${subRun.workflow}  ${subRun.status}`, width - 2)} onPress={() => props.onSubRun(subRun)} />)
    }
  }
  return lines
}
