// A run's graph: its nodes read from its frozen workflow source, and their
// layout as box-drawing text that gives way one step at a time when it is
// wider than the pane (#165; the prototype on `prototype/165-graph-width` is
// the reference for the layering, the lanes and the give-way steps).

import type { GraphNode } from '../types'
import { fit, glyph } from './text'
import type { Look } from './text'
import { parseYaml } from './yaml'

const KINDS = ['command', 'prompt', 'bash', 'script', 'loop', 'loop_group', 'approval', 'cancel', 'wait', 'workflow', 'include']

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function depsOf(value: unknown): string[] {
  if (typeof value === 'string' && value !== '') return [value]
  return Array.isArray(value) ? value.filter((dep): dep is string => typeof dep === 'string' && dep !== '') : []
}

function rawNodes(source: unknown): Record<string, unknown>[] {
  return isObject(source) && Array.isArray(source.nodes) ? source.nodes.filter(isObject).filter(node => typeof node.id === 'string') : []
}

function readNode(node: Record<string, unknown>): GraphNode {
  const kind = KINDS.find(k => node[k] !== undefined) ?? 'command'
  const group = isObject(node.loop_group) ? node.loop_group : {}
  return {
    id: String(node.id),
    deps: depsOf(node.depends_on),
    kind,
    block: '',
    workflow: kind === 'workflow' && typeof node.workflow === 'string' ? node.workflow : '',
    body: rawNodes(group).map(readNode),
  }
}

/**
 * The nodes of a workflow, with every plain `include:` expanded at load time
 * as Archon does: `<include>__<node>`, the include's own waits attached to the
 * block's entry nodes, and a node waiting on the include waiting on the
 * block's end nodes. `find` reads another workflow of the same frozen source
 * by name; an include it cannot find stays one node.
 */
export function workflowNodes(yaml: string, find: (name: string) => string | undefined, depth = 0): GraphNode[] {
  const nodes = rawNodes(parseYaml(yaml))
  const out: GraphNode[] = []
  const ends = new Map<string, string[]>()
  for (const raw of nodes) {
    const node = readNode(raw)
    const target = typeof raw.include === 'string' && raw.fan_out === undefined && depth < 3 ? find(raw.include) : undefined
    if (target === undefined) {
      out.push(node)
      continue
    }
    const inner = workflowNodes(target, find, depth + 1)
    const ids = new Set(inner.map(n => n.id))
    const waitedOn = new Set(inner.flatMap(n => n.deps))
    for (const n of inner) {
      const own = n.deps.filter(dep => ids.has(dep)).map(dep => `${node.id}__${dep}`)
      out.push({ ...n, id: `${node.id}__${n.id}`, deps: own.length === 0 ? node.deps : own, block: n.block === '' ? node.id : `${node.id}__${n.block}` })
    }
    ends.set(node.id, inner.filter(n => !waitedOn.has(n.id)).map(n => `${node.id}__${n.id}`))
  }
  return out.map(node => ({ ...node, deps: node.deps.flatMap(dep => ends.get(dep) ?? [dep]) }))
}

/** What reading a frozen workflow source needs: a folder's entries and a file's text, each of which may throw. */
export type SourceIo = {
  list: (path: string) => Promise<readonly { name: string; kind: string }[]>
  read: (path: string) => Promise<string>
}

/** The files under `root` whose name ends `.yaml` or `.yml`, a few folders deep. */
async function yamlFiles(io: SourceIo, root: string, depth = 0): Promise<string[]> {
  const entries = await io.list(root).catch(() => [])
  const found: string[] = []
  for (const entry of entries) {
    const path = `${root}/${entry.name}`
    if (entry.kind === 'dir' && depth < 5) found.push(...(await yamlFiles(io, path, depth + 1)))
    else if (entry.kind === 'file' && /\.ya?ml$/i.test(entry.name)) found.push(path)
  }
  return found
}

/** How a workflow of a frozen source ranks when two share a name: a project's over a global one over a bundled one. */
function rankOf(path: string): number {
  return /\/bundled\//.test(path) ? 0 : /\/global\//.test(path) ? 1 : 2
}

/** `owner/pack:entry`: how Archon names a run of an installed workflow pack's entry point. */
const PACK_ENTRY = /^([^/\s:]+)\/([^/\s:]+):([^/\s:]+)$/

/**
 * The file of an installed pack's entry point in a frozen source. Archon freezes
 * the pack under `installed/<owner>.<pack>/`, and its `archon-plugin.json` maps
 * each entry point to a workflow file whose own `name:` differs from the run's
 * workflow name. Undefined for any other name, or when the pack or the entry
 * point can't be read.
 */
async function packEntryFile(io: SourceIo, root: string, workflow: string): Promise<string | undefined> {
  const match = PACK_ENTRY.exec(workflow)
  if (match === null) return undefined
  const dir = `${root}/installed/${match[1]}.${match[2]}`
  const pack = await io.read(`${dir}/archon-plugin.json`).then(text => JSON.parse(text) as unknown).catch(() => undefined)
  const entries = isObject(pack) && isObject(pack.entrypoints) ? pack.entrypoints : {}
  const file = Object.hasOwn(entries, match[3]!) ? entries[match[3]!] : undefined
  if (typeof file !== 'string') return undefined
  const relative = file.replace(/\\/g, '/').replace(/^\.\//, '')
  return relative === '' || relative.startsWith('/') || relative.split('/').includes('..') ? undefined : `${dir}/${relative}`
}

/** The workflow names a workflow's plain `include:` nodes refer to. */
function includesOf(yaml: string): string[] {
  return [...yaml.matchAll(/^\s*(?:-\s+)?include:\s*["']?([^"'\s#]+)/gm)].map(match => match[1]!)
}

/**
 * A run's nodes, read from its frozen workflow source
 * (`metadata.workflow_source.root`), which never changes: the workflow
 * `manifest.json` names (else `workflow`), and any workflow it includes. A
 * pack's entry point (`owner/pack:entry`) is read from the file its pack maps
 * it to. Null when the source has no such workflow or can't be read.
 */
export async function readWorkflow(io: SourceIo, sourceRoot: string, workflow: string): Promise<GraphNode[] | null> {
  const root = sourceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  if (root === '') return null
  const manifest = await io.read(`${root}/manifest.json`).then(text => JSON.parse(text) as { workflow_name?: unknown }).catch(() => undefined)
  const name = typeof manifest?.workflow_name === 'string' ? manifest.workflow_name : workflow
  const files = await yamlFiles(io, root)
  const texts = new Map<string, string>()
  const textOf = async (path: string) => {
    if (!texts.has(path)) texts.set(path, await io.read(path).catch(() => ''))
    return texts.get(path)!
  }
  const nameIn = (text: string) => /^name:\s*["']?([^"'\n#]+?)["']?\s*$/m.exec(text)?.[1] ?? ''
  // A workflow's file is usually named for it; any other file is read only when that misses.
  const byName = new Map<string, { text: string; rank: number }>()
  const consider = (path: string, text: string) => {
    const found = nameIn(text)
    const known = byName.get(found)
    if (found !== '' && (known === undefined || rankOf(path) > known.rank)) byName.set(found, { text, rank: rankOf(path) })
  }
  const base = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.ya?ml$/i, '')
  const entry = await packEntryFile(io, root, name)
  let main: string | undefined
  if (entry !== undefined) {
    const text = await textOf(entry)
    main = text === '' ? undefined : text
  } else {
    for (const path of files) if (base(path) === name || /^archon-/.test(base(path))) consider(path, await textOf(path))
    if (!byName.has(name)) for (const path of files) consider(path, await textOf(path))
    main = byName.get(name)?.text
  }
  if (main === undefined) return null
  // Included workflows the files read so far don't name: first a file named for each, then every file.
  let pending = includesOf(main)
  for (let depth = 0; depth < 3 && pending.length > 0; depth++) {
    const missing = pending.filter(wanted => !byName.has(wanted))
    for (const path of files) if (missing.includes(base(path))) consider(path, await textOf(path))
    if (missing.some(wanted => !byName.has(wanted))) for (const path of files) consider(path, await textOf(path))
    pending = pending.flatMap(wanted => includesOf(byName.get(wanted)?.text ?? ''))
  }
  const sync = new Map([...byName].map(([key, value]) => [key, value.text]))
  return workflowNodes(main, wanted => sync.get(wanted))
}

/** One box of the drawn graph. */
export type DrawNode = {
  id: string
  /** What the box names: the node, or a folded block's, loop's or sub-run's summary. */
  label: string
  look: Look
  deps: string[]
  /** A gate waiting on the person: drawn with a bold border in `warning`. */
  isGate: boolean
  /** The include block it came from, whose prefix step 2 leaves out. */
  block: string
}

/** A run of text in one drawn line, with how it looks and what a press on it picks. */
export type Seg = {
  text: string
  tone?: 'success' | 'error' | 'warning'
  dim?: boolean
  bold?: boolean
  /** The node a press on this segment picks. */
  pick?: string
}

export type Drawn = {
  lines: Seg[][]
  /** The give-way step that fit: 1 whole names, 2 no include prefix, 3 names cut to 10, 4 skip edges as notes, 5 a list. */
  step: 1 | 2 | 3 | 4 | 5
}

type Item = { kind: 'node'; id: string; node: DrawNode; name: string } | { kind: 'lane'; id: string }

function toneOf(look: Look): Seg['tone'] {
  if (look === 'running' || look === 'completed') return 'success'
  if (look === 'failed') return 'error'
  if (look === 'approval' || look === 'action' || look === 'unreadable') return 'warning'
  return undefined
}

function depthsOf(nodes: readonly DrawNode[]): Map<string, number> {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const depth = new Map<string, number>()
  const of = (id: string, seen: Set<string>): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    const node = byId.get(id)
    if (node === undefined || seen.has(id)) return 0
    seen.add(id)
    const deps = node.deps.filter(dep => byId.has(dep))
    const value = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(dep => of(dep, seen)))
    depth.set(id, value)
    return value
  }
  for (const node of nodes) of(node.id, new Set())
  return depth
}

const width = (name: string) => Array.from(name).length

function itemWidth(item: Item): number {
  return item.kind === 'lane' ? 1 : width(item.name) + 6
}

function layerWidth(items: readonly Item[]): number {
  return items.reduce((sum, item, i) => sum + itemWidth(item) + (i === 0 ? 0 : 1), 0)
}

/** The name a box shows at a give-way step. */
function nameAt(node: DrawNode, step: number): string {
  const name = step >= 2 && node.block !== '' && node.label.startsWith(`${node.block}__`) ? node.label.slice(node.block.length + 2) : node.label
  return step >= 3 ? fit(name, 10) : name
}

type Plan = { layers: Item[][]; edges: [string, string][]; notes: Map<number, string[]> }

function plan(nodes: readonly DrawNode[], step: number): Plan {
  const depth = depthsOf(nodes)
  const ids = new Set(nodes.map(node => node.id))
  const deepest = Math.max(0, ...depth.values())
  const layers: Item[][] = Array.from({ length: deepest + 1 }, () => [])
  for (const node of nodes) layers[depth.get(node.id) ?? 0]!.push({ kind: 'node', id: node.id, node, name: nameAt(node, step) })
  const edges: [string, string][] = []
  const notes = new Map<number, string[]>()
  for (const node of nodes) {
    for (const dep of node.deps.filter(d => ids.has(d))) {
      const from = depth.get(dep)!
      const to = depth.get(node.id)!
      if (to - from === 1) edges.push([dep, node.id])
      else if (step <= 3) {
        // A lane: a one-column stand-in in each layer the edge passes.
        let previous = dep
        for (let layer = from + 1; layer < to; layer++) {
          const id = `~${dep}>${node.id}@${layer}`
          layers[layer]!.push({ kind: 'lane', id })
          edges.push([previous, id])
          previous = id
        }
        edges.push([previous, node.id])
      } else {
        notes.set(to, [...(notes.get(to) ?? []), `↑ ${node.id} also waits on ${dep}`])
      }
    }
  }
  // Each layer in the mean order of what it waits on, so edges cross least.
  for (let layer = 1; layer < layers.length; layer++) {
    const above = new Map(layers[layer - 1]!.map((item, i) => [item.id, i]))
    const mean = (item: Item) => {
      const at = edges.filter(([, to]) => to === item.id).map(([from]) => above.get(from) ?? 0)
      return at.length === 0 ? 0 : at.reduce((a, b) => a + b, 0) / at.length
    }
    layers[layer] = layers[layer]!.map((item, i) => ({ item, m: mean(item), i })).sort((a, b) => a.m - b.m || a.i - b.i).map(entry => entry.item)
  }
  return { layers, edges, notes }
}

const CORNERS: Record<string, string> = {
  udlr: '┼', udl: '┤', udr: '├', ulr: '┴', dlr: '┬', ud: '│', lr: '─',
  ul: '┘', ur: '└', dl: '┐', dr: '┌', u: '│', d: '│', l: '─', r: '─', '': ' ',
}

/** A box's border: a gate's in bold `warning`; a running node's flashes `success`, heavy and bold on one beat, light and dim on the next. */
function borderOf(node: DrawNode, pulse: boolean): { chars: string[]; seg: Seg; isHeavy: boolean } {
  const heavy = ['━', '┃', '┏', '┓', '┗', '┛']
  const light = ['─', '│', '┌', '┐', '└', '┘']
  if (node.isGate) return { chars: heavy, seg: { text: '', tone: 'warning', bold: true }, isHeavy: true }
  if (node.look === 'running') return pulse ? { chars: heavy, seg: { text: '', tone: 'success', bold: true }, isHeavy: true } : { chars: light, seg: { text: '', tone: 'success', dim: true }, isHeavy: false }
  return { chars: light, seg: { text: '' }, isHeavy: false }
}

function graphLines({ layers, edges, notes }: Plan, pulse: boolean): Seg[][] {
  const total = Math.max(...layers.map(layerWidth))
  const centre = new Map<string, number>()
  const out: Seg[][] = []
  const hasOut = new Set(edges.map(([from]) => from))
  const hasIn = new Set(edges.map(([, to]) => to))

  layers.forEach((items, l) => {
    const own = layerWidth(items)
    let x = Math.floor((total - own) / 2)
    if (l > 0) {
      // Line the layer up under its parents' mean centre.
      const ids = new Set(items.map(item => item.id))
      const parents = edges.filter(([from, to]) => ids.has(to) && centre.has(from)).map(([from]) => centre.get(from)!)
      if (parents.length > 0) {
        let rx = 0
        const centres = items.map(item => {
          const w = itemWidth(item)
          const c = rx + Math.floor(w / 2)
          rx += w + 1
          return c
        })
        const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
        x = Math.max(0, Math.min(total - own, Math.round(mean(parents) - mean(centres))))
      }
    }
    const placed = items.map(item => {
      const w = itemWidth(item)
      const at = { item, x, w }
      centre.set(item.id, x + Math.floor(w / 2))
      x += w + 1
      return at
    })

    if (l > 0) {
      // The connector row: unrelated edge groups get their own spans, and crossings draw ┼.
      const arms = Array.from({ length: total }, () => ({ u: false, d: false, l: false, r: false }))
      const above = new Set(layers[l - 1]!.map(item => item.id))
      const mine = new Set(items.map(item => item.id))
      const here = edges.filter(([from, to]) => above.has(from) && mine.has(to))
      const parent = new Map<string, string>()
      const find = (a: string): string => {
        const p = parent.get(a) ?? a
        return p === a ? a : find(p)
      }
      for (const [from, to] of here) parent.set(find(to), find(from))
      const groups = new Map<string, [string, string][]>()
      for (const edge of here) groups.set(find(edge[0]), [...(groups.get(find(edge[0])) ?? []), edge])
      for (const group of groups.values()) {
        const ups = new Set(group.map(([from]) => centre.get(from)!))
        const downs = new Set(group.map(([, to]) => centre.get(to)!))
        const xs = [...ups, ...downs]
        const lo = Math.min(...xs)
        const hi = Math.max(...xs)
        for (let i = lo; i <= hi; i++) {
          const arm = arms[i]!
          if (ups.has(i)) arm.u = true
          if (downs.has(i)) arm.d = true
          if (i > lo) arm.l = true
          if (i < hi) arm.r = true
        }
      }
      const key = (a: { u: boolean; d: boolean; l: boolean; r: boolean }) => (a.u ? 'u' : '') + (a.d ? 'd' : '') + (a.l ? 'l' : '') + (a.r ? 'r' : '')
      out.push([{ text: arms.map(arm => CORNERS[key(arm)]!).join('').trimEnd() }])
    }

    // Three rows of boxes, each row cut into segments so a box takes its state's colour.
    for (let r = 0; r < 3; r++) {
      const segs: Seg[] = []
      let cursor = 0
      for (const { item, x: bx, w } of placed) {
        if (bx > cursor) segs.push({ text: ' '.repeat(bx - cursor) })
        if (item.kind === 'lane') {
          segs.push({ text: '│' })
          cursor = bx + 1
          continue
        }
        const node = item.node
        const mid = Math.floor(w / 2)
        const { chars, seg: border, isHeavy } = borderOf(node, pulse)
        const [h, v, tl, tr, bl, br] = chars as [string, string, string, string, string, string]
        if (r === 0) {
          const top = [...`${tl}${h.repeat(w - 2)}${tr}`]
          if (hasIn.has(item.id)) top[mid] = isHeavy ? '┻' : '┴'
          segs.push({ ...border, text: top.join('') })
        } else if (r === 2) {
          const bottom = [...`${bl}${h.repeat(w - 2)}${br}`]
          if (hasOut.has(item.id)) bottom[mid] = isHeavy ? '┳' : '┬'
          segs.push({ ...border, text: bottom.join('') })
        } else {
          const name = item.name + ' '.repeat(Math.max(0, w - 6 - width(item.name)))
          const tone = toneOf(node.look)
          segs.push({ ...border, text: `${v} ` })
          segs.push({ text: glyph(node.look), ...(tone === undefined ? {} : { tone }), dim: node.look === 'cancelled' || node.look === 'skipped' })
          segs.push({ text: ` ${name}`, pick: node.id })
          segs.push({ ...border, text: ` ${v}` })
        }
        cursor = bx + w
      }
      out.push(segs)
    }
    for (const note of notes.get(l) ?? []) out.push([{ text: `  ${note}`, dim: true }])
  })
  return out
}

function listLines({ layers, notes }: Plan, pulse: boolean): Seg[][] {
  const out: Seg[][] = []
  layers.forEach((items, l) => {
    const nodes = items.flatMap(item => (item.kind === 'node' ? [item.node] : []))
    nodes.forEach((node, i) => {
      const mark = nodes.length === 1 ? '' : i === nodes.length - 1 ? '└ ' : '├ '
      const tone = toneOf(node.look)
      // A running node's mark flashes as its box would: bold on one beat, dim on the next.
      const flash = node.look === 'running' && !node.isGate ? (pulse ? { bold: true } : { dim: true }) : {}
      out.push([
        { text: `${mark}` },
        { text: glyph(node.look), ...(tone === undefined ? {} : { tone }), ...(node.isGate ? { bold: true } : {}), ...flash },
        { text: ` ${nameAt(node, 2)}`, pick: node.id },
      ].filter(seg => seg.text !== ''))
    })
    for (const note of notes.get(l) ?? []) out.push([{ text: `  ${note}`, dim: true }])
  })
  return out
}

/**
 * Lays the nodes out in layers by depth, giving way one step at a time while
 * the widest layer is wider than `columns`: whole names, names without their
 * include prefix, names cut to 10 characters, skip edges as notes instead of
 * lanes, then the whole run as a list. A wide layer is never stacked into one
 * box, and a skip edge is never dropped. `pulse` is the flash's beat: a running
 * node is drawn heavy and bold while it is on, light and dim while it is off.
 * With no flash running it stays on.
 */
export function layout(nodes: readonly DrawNode[], columns: number, pulse = true): Drawn {
  if (nodes.length === 0) return { lines: [], step: 1 }
  for (const step of [1, 2, 3, 4] as const) {
    const planned = plan(nodes, step)
    if (Math.max(...planned.layers.map(layerWidth)) <= columns) return { lines: graphLines(planned, pulse), step }
  }
  return { lines: listLines(plan(nodes, 4), pulse), step: 5 }
}
