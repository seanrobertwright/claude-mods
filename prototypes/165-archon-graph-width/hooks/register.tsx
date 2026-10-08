// PROTOTYPE for claude-mods #165 ("How does the Graph sub-tab cope with a pane
// narrower than the graph?"). Throwaway: it answers a question and is deleted.
// Draws fixture runs as archon-panel's Graph sub-tab would, at the pane's real
// width, and switches what a too-wide layer and a layer-skipping edge become.

import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { LastScroll, SkipMode, WideMode } from '../types'

const PANE = 'archon-graph-proto'
const fixtureA = atom({ plugin: 'archon-graph-proto', key: 'fixture' } as const, 0)
const wideA = atom({ plugin: 'archon-graph-proto', key: 'wide' } as const, 'list' as WideMode)
const skipA = atom({ plugin: 'archon-graph-proto', key: 'skip' } as const, 'lane' as SkipMode)
const pinnedA = atom({ plugin: 'archon-graph-proto', key: 'pinned' } as const, false)
const ownA = atom({ plugin: 'archon-graph-proto', key: 'own' } as const, 0)
const askedA = atom({ plugin: 'archon-graph-proto', key: 'asked' } as const, 0)
const lastScrollA = atom({ plugin: 'archon-graph-proto', key: 'lastScroll' } as const, null as LastScroll | null)

// ---------- fixtures (shapes from Archon's bundled workflows) ----------

type Status = 'done' | 'run' | 'wait' | 'fail' | 'skip'
type Node = { id: string; label: string; s: Status; deps: string[] }
const GLYPH: Record<Status, string> = { done: '✓', run: '●', wait: '○', fail: '✗', skip: '–' }

const n = (id: string, s: Status, deps: string[] = [], label = id): Node => ({ id, label, s, deps })

function chain(prefix: string, names: string[], deps: string[], status: (i: number) => Status): Node[] {
  return names.map((name, i) =>
    n(prefix + name, status(i), i === 0 ? deps : [prefix + names[i - 1]]),
  )
}

const SIX = ['code', 'seams', 'simplify', 'tests', 'errors', 'docs']
const review: Node[] = [
  n('mode', 'done'),
  n('scope', 'done', ['mode']),
  n('code', 'run', ['scope']),
  n('seams', 'done', ['scope']),
  n('simplify', 'run', ['scope']),
  n('tests', 'done', ['scope']),
  n('errors', 'run', ['scope']),
  n('docs', 'wait', ['scope']),
  n('review-complete', 'wait', SIX),
  n('synthesize', 'wait', ['scope', 'review-complete']),
  n('publish', 'wait', ['synthesize']),
]

const shipFolded: Node[] = [
  n('triage', 'done', [], 'triage 3/3'),
  n('inv', 'done', ['triage'], 'inv 4/4'),
  n('gate-direct', 'skip', ['triage']),
  n('planned', 'skip', ['triage'], 'planned 0/6'),
  n('gate-rooted', 'done', ['inv']),
  n('gate-planned', 'skip', ['planned']),
  n('deliver', 'run', ['gate-direct', 'gate-rooted', 'gate-planned'], 'deliver 12/53'),
  n('outcome', 'wait', ['triage', 'deliver']),
]

const prd: Node[] = chain('', ['read-issue', 'research', 'draft-prd', 'review-prd', 'publish'], [], i =>
  i < 2 ? 'done' : i === 2 ? 'run' : 'wait',
)

const DELIVER = [
  'setup', 'read-plan', 'branch', 'slice-1', 'test-1', 'fix-1', 'slice-2', 'test-2', 'fix-2',
  'slice-3', 'test-3', 'fix-3', 'slice-4', 'test-4', 'fix-4', 'lint', 'typecheck', 'unit',
  'e2e', 'review-code', 'review-tests', 'review-docs', 'address-1', 'address-2', 'address-3',
  'revalidate', 'changelog', 'commit', 'push', 'open-pr', 'ci-wait', 'ci-fix-1', 'ci-fix-2',
  'ci-green', 'pr-review', 'pr-address', 'pr-recheck', 'merge-ready', 'summary', 'report',
  'cleanup', 'archive', 'done',
]
let k = 0
const doneFirst = (): Status => (k++ < 25 ? 'done' : k === 26 ? 'run' : 'wait')
const shipExpanded: Node[] = (() => {
  k = 0
  const t = chain('triage__', ['classify', 'size', 'route'], [], doneFirst)
  const inv = chain('inv__', ['reproduce', 'trace', 'hypothesis', 'report'], ['triage__route'], doneFirst)
  const gd = n('gate-direct', 'skip', ['triage__route'])
  const pl = chain('planned__', ['scope', 'explore', 'design', 'slice', 'review', 'write'], ['triage__route'], () => 'skip')
  const gr = n('gate-rooted', 'done', ['inv__report'])
  const gp = n('gate-planned', 'skip', ['planned__write'])
  const de = chain('deliver__', DELIVER, ['gate-direct', 'gate-rooted', 'gate-planned'], doneFirst)
  const out = n('outcome', 'wait', ['triage__route', 'deliver__done'])
  return [...t, ...inv, gd, ...pl, gr, gp, ...de, out]
})()

const FIXTURES = [
  { name: 'archon-review', why: 'six-wide fan-out, scope skips to synthesize', nodes: review },
  { name: 'archon-ship (folded)', why: '3 wide, two skip edges', nodes: shipFolded },
  { name: 'archon-prd chain', why: 'fits anywhere', nodes: prd },
  { name: 'archon-ship (61, expanded)', why: 'long: for scrolling', nodes: shipExpanded },
]

// ---------- layout ----------

type Item =
  | { kind: 'node'; id: string; node: Node }
  | { kind: 'dummy'; id: string }
  | { kind: 'stack'; id: string; nodes: Node[] }
type Line = { t: string; dim?: boolean }

const stackTitle = (count: number) => ` ${count} at once `
const cutName = (s: string, cut: number) => (s.length > cut ? s.slice(0, cut - 1) + '…' : s)

function depthsOf(nodes: Node[]): Map<string, number> {
  const byId = new Map(nodes.map(x => [x.id, x]))
  const d = new Map<string, number>()
  const of = (id: string): number => {
    if (d.has(id)) return d.get(id)!
    const node = byId.get(id)!
    const v = node.deps.length ? 1 + Math.max(...node.deps.map(of)) : 0
    d.set(id, v)
    return v
  }
  nodes.forEach(x => of(x.id))
  return d
}

function layerWidth(items: Item[], cut: number): number {
  return items.reduce((sum, it, i) => sum + itemWidth(it, cut) + (i ? 1 : 0), 0)
}
function itemWidth(it: Item, cut: number): number {
  if (it.kind === 'dummy') return 1
  if (it.kind === 'node') return cutName(it.node.label, cut).length + 6
  return Math.max(...it.nodes.map(x => x.label.length + 6), stackTitle(it.nodes.length).length + 4)
}

type Built = { lines: Line[]; cut: number | null; need10: number; mode: string }

function build(nodes: Node[], cols: number, wide: WideMode, skip: SkipMode): Built {
  const depth = depthsOf(nodes)
  const maxD = Math.max(...depth.values())
  const layers: Item[][] = Array.from({ length: maxD + 1 }, () => [])
  nodes.forEach(x => layers[depth.get(x.id)!]!.push({ kind: 'node', id: x.id, node: x }))

  // edges between adjacent layers, by item id; skip edges become dummies or notes
  const edges: [string, string][] = []
  const notes = new Map<number, string[]>()
  const skips: [string, string][] = []
  for (const c of nodes) {
    for (const p of c.deps) {
      const gap = depth.get(c.id)! - depth.get(p)!
      if (gap === 1) edges.push([p, c.id])
      else {
        skips.push([p, c.id])
        if (skip === 'lane') {
          let prev = p
          for (let l = depth.get(p)! + 1; l < depth.get(c.id)!; l++) {
            const id = `~${p}>${c.id}@${l}`
            layers[l]!.push({ kind: 'dummy', id })
            edges.push([prev, id])
            prev = id
          }
          edges.push([prev, c.id])
        } else if (skip === 'note') {
          const l = depth.get(c.id)!
          notes.set(l, [...(notes.get(l) ?? []), `  ↑ ${c.id} also waits on ${p}`])
        }
      }
    }
  }

  // order each layer by the mean position of its parents
  for (let l = 1; l <= maxD; l++) {
    const prevIdx = new Map(layers[l - 1]!.map((it, i) => [it.id, i]))
    const bary = (it: Item) => {
      const ps = edges.filter(([, c]) => c === it.id).map(([p]) => prevIdx.get(p) ?? 0)
      return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 0
    }
    layers[l] = layers[l]!.map((it, i) => ({ it, b: bary(it), i })).sort((a, b) => a.b - b.b || a.i - b.i).map(x => x.it)
  }

  const maxLabel = Math.max(...nodes.map(x => x.label.length))
  const need = (cut: number) => Math.max(...layers.map(l => layerWidth(l, cut)))
  const need10 = need(Math.min(10, maxLabel))
  let cut: number | null = null
  for (let c = maxLabel; c >= Math.min(10, maxLabel); c--) {
    if (need(c) <= cols) {
      cut = c
      break
    }
  }

  if (cut === null && wide === 'list') return { lines: listLines(layers, skip, notes), cut, need10, mode: 'list (too wide)' }

  let shown = layers
  let mode = 'graph'
  const useCut = cut ?? 10
  if (cut === null) {
    // stack each layer too wide for the pane into one box; edges re-point at it
    mode = 'graph, wide layers stacked'
    const remap = new Map<string, string>()
    shown = layers.map((items, l) => {
      if (layerWidth(items, useCut) <= cols) return items
      const ns = items.flatMap(it => (it.kind === 'node' ? [it.node] : []))
      const id = `#stack${l}`
      ns.forEach(x => remap.set(x.id, id))
      return [...items.filter(it => it.kind === 'dummy'), { kind: 'stack', id, nodes: ns } as Item]
    })
    const seen = new Set<string>()
    const re = edges
      .map(([p, c]) => [remap.get(p) ?? p, remap.get(c) ?? c] as [string, string])
      .filter(([p, c]) => {
        const key = p + '>' + c
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    edges.length = 0
    edges.push(...re)
  }
  return { lines: graphLines(shown, edges, useCut, cols, notes), cut, need10, mode }
}

function listLines(layers: Item[][], skip: SkipMode, notes: Map<number, string[]>): Line[] {
  const out: Line[] = []
  layers.forEach((items, l) => {
    const ns = items.flatMap(it => (it.kind === 'node' ? [it.node] : []))
    ns.forEach((x, i) => {
      const mark = ns.length === 1 ? '' : i === ns.length - 1 ? '└ ' : '├ '
      out.push({ t: `${mark}${GLYPH[x.s]} ${x.label}` })
    })
    if (skip === 'note') (notes.get(l) ?? []).forEach(t => out.push({ t, dim: true }))
  })
  return out
}

function graphLines(layers: Item[][], edges: [string, string][], cut: number, cols: number, notes: Map<number, string[]>): Line[] {
  const W = Math.max(...layers.map(l => layerWidth(l, cut)))
  const center = new Map<string, number>()
  const out: Line[] = []
  const hasOut = new Set(edges.map(([p]) => p))
  const hasIn = new Set(edges.map(([, c]) => c))

  layers.forEach((items, l) => {
    // positions
    // line the layer up under its parents' mean centre, else centre it
    const lw = layerWidth(items, cut)
    let x = Math.floor((W - lw) / 2)
    if (l > 0) {
      const ids = new Set(items.map(it => it.id))
      const pcs = edges.filter(([p, c]) => ids.has(c) && center.has(p)).map(([p]) => center.get(p)!)
      if (pcs.length) {
        let rx = 0
        const rcs = items.map(it => {
          const w = itemWidth(it, cut)
          const c = rx + Math.floor(w / 2)
          rx += w + 1
          return c
        })
        const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
        x = Math.max(0, Math.min(W - lw, Math.round(mean(pcs) - mean(rcs))))
      }
    }
    const pos = items.map(it => {
      const w = itemWidth(it, cut)
      const at = { it, x, w }
      center.set(it.id, x + Math.floor(w / 2))
      x += w + 1
      return at
    })

    // connector row from the layer above
    if (l > 0) {
      const arms = Array.from({ length: W }, () => ({ u: false, d: false, l: false, r: false }))
      const prevIds = new Set(layers[l - 1]!.map(it => it.id))
      const mine = new Set(items.map(it => it.id))
      const es = edges.filter(([p, c]) => prevIds.has(p) && mine.has(c))
      // group edges into connected parts so unrelated edges don't share one bus
      const parent = new Map<string, string>()
      const find = (a: string): string => (parent.get(a) ?? a) === a ? a : find(parent.get(a)!)
      es.forEach(([p, c]) => parent.set(find(c), find(p)))
      const groups = new Map<string, [string, string][]>()
      es.forEach(e => groups.set(find(e[0]), [...(groups.get(find(e[0])) ?? []), e]))
      for (const g of groups.values()) {
        const ups = new Set(g.map(([p]) => center.get(p)!))
        const downs = new Set(g.map(([, c]) => center.get(c)!))
        const xs = [...ups, ...downs]
        const lo = Math.min(...xs)
        const hi = Math.max(...xs)
        for (let i = lo; i <= hi; i++) {
          const a = arms[i]!
          if (ups.has(i)) a.u = true
          if (downs.has(i)) a.d = true
          if (i > lo) a.l = true
          if (i < hi) a.r = true
        }
      }
      const CH: Record<string, string> = {
        udlr: '┼', udl: '┤', udr: '├', ulr: '┴', dlr: '┬', ud: '│', lr: '─',
        ul: '┘', ur: '└', dl: '┐', dr: '┌', u: '│', d: '│', l: '─', r: '─', '': ' ',
      }
      const key = (a: { u: boolean; d: boolean; l: boolean; r: boolean }) =>
        (a.u ? 'u' : '') + (a.d ? 'd' : '') + (a.l ? 'l' : '') + (a.r ? 'r' : '')
      out.push({ t: arms.map(a => CH[key(a)]!).join('').trimEnd() })
    }

    // the layer's boxes
    const H = Math.max(...pos.map(({ it }) => (it.kind === 'stack' ? it.nodes.length + 2 : 3)))
    const grid = Array.from({ length: H }, () => Array(W).fill(' '))
    const put = (r: number, c: number, s: string) => [...s].forEach((ch, i) => (grid[r]![c + i] = ch))
    for (const { it, x: bx, w } of pos) {
      const cx = bx + Math.floor(w / 2) - bx
      if (it.kind === 'dummy') {
        for (let r = 0; r < H; r++) grid[r]![bx] = '│'
        continue
      }
      const rows = it.kind === 'node' ? [it.node] : it.nodes
      const top = [...('┌' + '─'.repeat(w - 2) + '┐')]
      if (it.kind === 'stack') {
        stackTitle(rows.length).split('').forEach((ch, i) => (top[2 + i] = ch))
      }
      if (hasIn.has(it.id) && top[cx] === '─') top[cx] = '┴'
      put(0, bx, top.join(''))
      rows.forEach((x, i) => {
        const body = `${GLYPH[x.s]} ${it.kind === 'stack' ? x.label : cutName(x.label, cut)}`
        put(1 + i, bx, '│ ' + body.padEnd(w - 4) + ' │')
      })
      const bot = [...('└' + '─'.repeat(w - 2) + '┘')]
      if (hasOut.has(it.id)) bot[cx] = '┬'
      put(rows.length + 1, bx, bot.join(''))
      if (hasOut.has(it.id)) for (let r = rows.length + 2; r < H; r++) grid[r]![bx + cx] = '│'
    }
    grid.forEach(r => out.push({ t: r.join('').trimEnd() }))
    ;(notes.get(l) ?? []).forEach(t => out.push({ t, dim: true }))
  })
  return out
}

// ---------- the pane ----------

const WIDES: WideMode[] = ['list', 'stack']
const SKIPS: SkipMode[] = ['lane', 'note', 'none']
const ASKS = [0, 58, 72, 104]
const next1 = <T,>(xs: T[], x: T): T => xs[(xs.indexOf(x) + 1) % xs.length]!

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'archon-graph',
      description: 'PROTOTYPE (#165): open the archon-panel Graph width prototype; optional column count',
    })
    return next(e)
  })

  on('command.run', { command: 'archon-graph' }, async ($, e) => {
    const cols = parseInt(e.args.trim(), 10)
    const asked = Number.isFinite(cols) && cols > 0 ? cols : 0
    await update($, askedA, () => asked)
    await $.ui.open({ id: PANE, title: 'Archon (prototype)', focus: true, ...(asked ? { columns: asked } : {}) })
    return { text: asked ? `Prototype pane opened, asking for ${asked} columns.` : 'Prototype pane opened at the dock\'s default share.' }
  })

  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    await update($, lastScrollA, () => ({
      by: e.by,
      origin: e.origin.kind === 'plugin' ? `plugin ${e.origin.name}` : 'person',
      pointerRow: e.pointer ? e.pointer.row : null,
      at: new Date().toISOString().slice(11, 19),
    }))
    if (!(await read($, pinnedA))) return next(e)
    // pinned: keep the engine's window at 0 and move our own index instead
    await update($, ownA, own => Math.max(0, own + e.by))
    return next({ ...e, offset: 0 })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const cols = e.props.bodyColumns
    const rows = e.props.scroll.bodyRows
    const fx = await read($, fixtureA)
    const wide = await read($, wideA)
    const skip = await read($, skipA)
    const pinned = await read($, pinnedA)
    const asked = await read($, askedA)
    const last = await read($, lastScrollA)
    const f = FIXTURES[fx % FIXTURES.length]!
    const b = build(f.nodes, cols, wide, skip)

    const tabs = ' 1: Runs 3   [2: Graph]   3: Log   4: Archon\'s log'
    const info = `${cols} cols · ${e.props.placement} · ${rows} rows · asked ${asked || 'none'} · needs ${b.need10} at 10-char names · ${b.cut === null ? 'too wide' : `names cut to ${b.cut}`}`
    const scrollInfo = `scroll: ${last ? `by ${last.by} · ${last.origin} · row ${last.pointerRow ?? '-'} · ${last.at}` : 'none yet'} · window ${e.props.scroll.offset}${pinned ? ` · own ${await read($, ownA)}` : ''}`

    const reset = async () => {
      await update($, ownA, () => 0)
      await $.ui.scroll({ in: PANE, to: 'start' })
    }
    const controls = (
      <Box flexDirection="row" flexWrap="wrap">
        <Box marginRight={2}><Button plain hotkey="f" label={`run: ${f.name}`} onPress={async () => { await update($, fixtureA, x => (x + 1) % FIXTURES.length); await reset() }} /></Box>
        <Box marginRight={2}><Button plain hotkey="w" label={`wide layer: ${wide}`} onPress={async () => { await update($, wideA, x => next1(WIDES, x)); await reset() }} /></Box>
        <Box marginRight={2}><Button plain hotkey="s" label={`skip edge: ${skip}`} onPress={async () => { await update($, skipA, x => next1(SKIPS, x)); await reset() }} /></Box>
        <Box marginRight={2}><Button plain hotkey="p" label={`tab row: ${pinned ? 'pinned' : 'scrolls'}`} onPress={async () => { await update($, pinnedA, x => !x); await reset() }} /></Box>
        <Box marginRight={2}><Button plain hotkey="c" label={`ask cols: ${asked || 'none'}`} onPress={async () => {
          const a = next1(ASKS, asked)
          await update($, askedA, () => a)
          await $.ui.open({ id: PANE, title: 'Archon (prototype)', ...(a ? { columns: a } : {}) })
        }} /></Box>
      </Box>
    )

    const head = [
      <Text bold wrap="wrap">{tabs}</Text>,
      <Text dimColor wrap="wrap">{info}</Text>,
      controls,
      <Text dimColor wrap="wrap">{`${f.why} · ${b.mode} · ${scrollInfo}`}</Text>,
      <Text> </Text>,
    ]
    const body = b.lines.map(l => <Text dimColor={l.dim} wrap="truncate-end">{l.t || ' '}</Text>)

    if (!pinned) return <Box flexDirection="column">{head}{body}</Box>

    // pinned: estimate the header's height, show a slice of the body under it,
    // and pad one row so the engine still has rows to scroll (keys raise ui.scroll)
    const wrapRows = (s: string) => Math.max(1, Math.ceil(s.length / Math.max(1, cols)))
    const ctlLen = [f.name, wide, skip, 'scrolls', String(asked || 'none')].join('').length + 5 * 16
    const headRows = wrapRows(tabs) + wrapRows(info) + wrapRows('x'.repeat(ctlLen)) + wrapRows(`${f.why} · ${b.mode} · ${scrollInfo}`) + 1
    const room = Math.max(1, rows - headRows)
    const maxOwn = Math.max(0, b.lines.length - room)
    const own = Math.min(await read($, ownA), maxOwn)
    return (
      <Box flexDirection="column">
        {head}
        {body.slice(own, own + room)}
        <Text dimColor>{own + room < b.lines.length ? `… ${b.lines.length - own - room} more rows` : ' '}</Text>
      </Box>
    )
  })
}
