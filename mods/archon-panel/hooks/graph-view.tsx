// The Graph sub-tab: the picked run's nodes as box-drawing text, include
// blocks, loop groups and sub-runs folded, each box a press that opens Log.

import type { Elements, RenderElement } from 'claude-code'

import type { ArchonView, Detail, GraphNode, Run, RunEvent } from '../types'
import { layout } from './graph'
import type { DrawNode, Seg } from './graph'
import { attention, childrenOf, hasEnded, needsYou } from './runs'
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

function childLook(child: Run, runs: readonly Run[], details: Readonly<Record<string, Detail>>): { look: Look; isGate: boolean } {
  const byId = new Map(runs.map(run => [run.id, run]))
  if (needsYou(child, byId, details) !== undefined) return { look: 'approval', isGate: true }
  return { look: child.status === 'paused' ? 'paused' : child.status, isGate: false }
}

/** The sub-runs a `workflow:` node started. */
export function subRunsOf(run: Run, node: GraphNode, runs: readonly Run[], workflowNodes: number): Run[] {
  return childrenOf(run, runs).filter(child => child.parentNodeId === node.id || (child.parentNodeId === '' && workflowNodes === 1))
}

export type Graphed = {
  draw: DrawNode[]
  /** What a press on each box picks. */
  picks: Map<string, { kind: 'node' | 'block' | 'loop' | 'workflow'; id: string; children: Run[] }>
}

/** The boxes of a run's graph: node states from its events, gates in `warning`, blocks and loops folded unless opened. */
export function drawNodes(nodes: readonly GraphNode[], run: Run, runs: readonly Run[], details: Readonly<Record<string, Detail>>, view: ArchonView): Graphed {
  const events = details[run.id]?.events ?? []
  const found = attention(run, new Map(runs.map(r => [r.id, r])), details[run.id])
  const gateNode = found.kind === 'approval' || found.kind === 'stranded' ? found.gate.nodeId : found.kind === 'action' ? found.wait.nodeId : ''
  const picks: Graphed['picks'] = new Map()
  const workflows = nodes.filter(node => node.kind === 'workflow').length
  const looks = new Map<string, DrawNode>()
  for (const node of nodes) {
    let look = lookFrom(events, node.id)
    let label = node.id
    let isGate = node.id === gateNode && found.kind !== 'none'
    if (isGate) look = found.kind === 'approval' ? 'approval' : 'action'
    picks.set(node.id, { kind: 'node', id: node.id, children: [] })
    if (node.kind === 'loop_group') {
      const round = roundsOf(events, node.id)
      if (round > 0) look = foldLook(node.body.map(body => lookFrom(events, `${node.id}.${body.id}`, round)))
      label = round > 0 ? `${node.id} ⟳${round}` : node.id
      picks.set(node.id, { kind: 'loop', id: node.id, children: [] })
    } else if (node.kind === 'workflow') {
      const children = subRunsOf(run, node, runs, workflows)
      picks.set(node.id, { kind: 'workflow', id: node.id, children })
      if (children.length === 1) {
        const shownChild = childLook(children[0]!, runs, details)
        look = shownChild.look
        isGate = isGate || shownChild.isGate
        label = `↳ ${children[0]!.workflow}`
      } else if (children.length > 1) {
        const childLooks = children.map(child => childLook(child, runs, details))
        look = foldLook(childLooks.map(c => c.look))
        isGate = isGate || childLooks.some(c => c.isGate)
        label = `↳ ${children.filter(child => hasEnded(child)).length}/${children.length}`
      } else label = `↳ ${node.workflow || node.id}`
    }
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
    picks.set(`block:${block}`, { kind: 'block', id: block, children: [] })
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

/** A loop group's body as one round drew it: the current one, or an earlier one picked with ‹ ›. */
export function roundNodes(group: GraphNode, events: readonly RunEvent[], round: number): DrawNode[] {
  return group.body.map(body => ({ id: `${group.id}.${body.id}`, label: body.id, look: lookFrom(events, `${group.id}.${body.id}`, round), deps: body.deps.map(dep => `${group.id}.${dep}`), isGate: false, block: '' }))
}

export type GraphProps = {
  ui: Elements[keyof Elements]
  run: Run | undefined
  runs: readonly Run[]
  details: Readonly<Record<string, Detail>>
  nodes: GraphNode[] | null | undefined
  view: ArchonView
  now: number
  width: number
  /** The run's page in Archon's web UI, or '' when it is not linked. */
  link: string
  onPick: (id: string) => void
  onFold: (block: string) => void
  onRound: (round: number) => void
  onParent: (parent: Run) => void
  onChild: (child: Run) => void
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
  if (props.nodes === undefined) return [...lines, <Text dimColor>Reading the run's workflow…</Text>]
  if (props.nodes === null || props.nodes.length === 0) return [...lines, <Text dimColor>This run's workflow source can't be read.</Text>]

  const graphed = drawNodes(props.nodes, run, props.runs, props.details, view)
  for (const block of view.includes.filter(entry => entry.startsWith(`${run.id}:`)).map(entry => entry.slice(run.id.length + 1))) {
    lines.push(<Button key={`fold-${block}`} plain dimColor label={`▾ ${block}`} onPress={() => props.onFold(block)} />)
  }
  lines.push(...segLines(ui, layout(graphed.draw, width).lines, props.onPick))

  // A picked loop group: its round's body as a small graph, stepping through earlier rounds.
  const group = view.loop.startsWith(`${run.id}:`) ? props.nodes.find(node => node.id === view.loop.slice(run.id.length + 1)) : undefined
  if (group !== undefined) {
    const events = props.details[run.id]?.events ?? []
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
    lines.push(...segLines(ui, layout(roundNodes(group, events, round), width).lines, props.onPick, 'body'))
  }

  // A fan-out's children, listed once its box is picked.
  for (const node of props.nodes.filter(n => n.kind === 'workflow' && view.fanouts.includes(`${run.id}:${n.id}`))) {
    const pick = graphed.picks.get(node.id)
    for (const child of pick?.children ?? []) {
      lines.push(<Button key={`child-${child.id}`} plain label={fit(`↳ ${child.workflow}  ${child.status}`, width - 2)} onPress={() => props.onChild(child)} />)
    }
  }
  return lines
}
