import { expect, test } from 'claude-code/testing'

import { layout, workflowNodes } from '../hooks/graph'
import type { DrawNode } from '../hooks/graph'
import { parseYaml } from '../hooks/yaml'
import { DELIVER, REVIEW, SHIP } from './fixtures/workflows'

test('the YAML reader takes the workflow shapes Archon writes', () => {
  const ship = parseYaml(SHIP) as { name: string; interactive: boolean; nodes: Record<string, unknown>[] }
  expect(ship.name).toBe('archon-ship')
  expect(ship.interactive).toBe(true)
  expect(ship.nodes.map(node => node.id)).toEqual(['plan', 'deliver', 'fix-cycle', 'review-gate', 'child'])
  expect(ship.nodes[1]).toEqual({ id: 'deliver', include: 'archon-deliver', depends_on: ['plan'] })
  expect(ship.nodes[2]).toEqual({
    id: 'fix-cycle',
    depends_on: ['deliver'],
    loop_group: {
      nodes: [{ id: 'fix', prompt: 'Address findings' }, { id: 'recheck', prompt: 'Verify each finding', depends_on: ['fix'] }],
      until_bash: 'test "$recheck.output.ready" = "true"',
      max_iterations: 5,
    },
  })
  expect((ship.nodes[3]!.approval as { decisions: unknown }).decisions).toEqual([
    { id: 'approve', label: 'Approve' },
    { id: 'needs-revision', label: 'Needs revision' },
    { id: 'reject', label: 'Reject' },
  ])
  const review = parseYaml(REVIEW) as { description: string; nodes: Record<string, unknown>[] }
  expect(review.description).toBe('Review a change: six reviewers in parallel,\njoined by one node.\n')
  expect(review.nodes[1]).toEqual({ id: 'scope', command: 'scope', depends_on: ['mode'] })
  expect(review.nodes[8]!.depends_on).toEqual(['code', 'seams', 'simplify', 'tests', 'errors', 'docs'])
  expect(review.nodes[8]!.bash).toBe("echo 'all six: done'")
  expect(review.nodes[9]!.prompt).toBe('Fold the six reviews into one report.\n')
})

const box = (id: string, deps: string[] = [], label = id): DrawNode => ({ id, label, look: 'completed', deps, isGate: false, block: '' })

/** archon-review: six reviewers in parallel, and scope skipping two layers to synthesize. */
const review = (prefix = ''): DrawNode[] => {
  const six = ['code', 'seams', 'simplify', 'tests', 'errors', 'docs']
  return [
    box(`${prefix}mode`),
    box(`${prefix}scope`, [`${prefix}mode`]),
    ...six.map(name => box(`${prefix}${name}`, [`${prefix}scope`])),
    box(`${prefix}review-complete`, six.map(name => `${prefix}${name}`)),
    box(`${prefix}synthesize`, [`${prefix}scope`, `${prefix}review-complete`]),
    box(`${prefix}publish`, [`${prefix}synthesize`]),
  ].map(node => ({ ...node, block: prefix === '' ? '' : prefix.slice(0, -2) }))
}

const text = (lines: { text: string }[][]) => lines.map(line => line.map(seg => seg.text).join(''))
const widest = (lines: { text: string }[][]) => Math.max(...text(lines).map(line => Array.from(line.trimEnd()).length))

test('a layer of n boxes needs n × (name + 7) − 1 columns', () => {
  const three = [box('alpha'), box('bravo'), box('gamma')]
  const fits = layout(three, 35)
  expect(fits.step).toBe(1)
  expect(widest(fits.lines)).toBe(35)
  expect(layout(three, 34).step).toBe(5)
})

test('whole names first, with the skip edge drawn as a lane', () => {
  const drawn = layout(review(), 120)
  expect(drawn.step).toBe(1)
  const all = text(drawn.lines).join('\n')
  expect(all).toContain('review-complete')
  expect(all).not.toContain('also waits on')
  // The reviewers' layer is 10 + 11 + 14 + 11 + 12 + 10 columns of boxes and 5 gaps, then the lane and its gap.
  expect(widest(drawn.lines)).toBe(75)
})

test('then names without their include prefix', () => {
  const nodes = review('deliver__')
  const step1 = layout(nodes, 1000)
  expect(step1.step).toBe(1)
  const drawn = layout(nodes, widest(step1.lines) - 1)
  expect(drawn.step).toBe(2)
  const all = text(drawn.lines).join('\n')
  expect(all).toContain('✓ seams')
  expect(all).not.toContain('deliver__seams')
})

test('then names cut to 10 characters', () => {
  const nodes = [box('start'), box('implementation-a', ['start']), box('implementation-b', ['start']), box('implementation-c', ['start'])]
  // Three 16-character names need 3 × 23 − 1 = 68 columns; cut to 10, 3 × 17 − 1 = 50.
  expect(layout(nodes, 68).step).toBe(1)
  const drawn = layout(nodes, 67)
  expect(drawn.step).toBe(3)
  expect(widest(drawn.lines)).toBe(50)
  expect(text(drawn.lines).join('\n')).toContain('✓ implement…')
})

test('then the skip edge as a dim note under the layer it lands in', () => {
  const nodes = review()
  // The reviewers' layer needs 75 columns with the lane, 73 without it.
  expect(layout(nodes, 75).step).toBe(1)
  const drawn = layout(nodes, 74)
  expect(drawn.step).toBe(4)
  const note = drawn.lines.find(line => line.some(seg => seg.text.includes('↑ synthesize also waits on scope')))
  expect(note?.every(seg => seg.dim === true)).toBe(true)
  const synth = text(drawn.lines).findIndex(line => line.includes('✓ synthesize'))
  expect(text(drawn.lines).findIndex(line => line.includes('↑ synthesize also waits on scope'))).toBeGreaterThan(synth)
})

test('then the whole run as a list, parallel nodes marked, carrying the same notes', () => {
  const drawn = layout(review(), 60)
  expect(drawn.step).toBe(5)
  const lines = text(drawn.lines)
  expect(lines).toContain('├ ✓ code')
  expect(lines).toContain('└ ✓ docs')
  expect(lines).toContain('✓ scope')
  expect(lines).toContain('  ↑ synthesize also waits on scope')
})

test('at every width the graph fits or turns into the list, never stacks a layer, and never drops a skip edge', () => {
  for (let width = 12; width <= 140; width++) {
    const drawn = layout(review(), width)
    const lines = text(drawn.lines)
    if (drawn.step <= 4) expect(widest(drawn.lines)).toBeLessThanOrEqual(width)
    expect(lines.some(line => line.includes(' at once '))).toBe(false)
    const isLane = drawn.step <= 3
    expect(isLane || lines.some(line => line.includes('↑ synthesize also waits on scope'))).toBe(true)
  }
})

test('the run\'s nodes come from its workflow, includes expanded under their block', () => {
  const nodes = workflowNodes(SHIP, name => (name === 'archon-deliver' ? DELIVER : undefined))
  expect(nodes.map(node => [node.id, node.deps, node.kind, node.block])).toEqual([
    ['plan', [], 'command', ''],
    ['deliver__implement', ['plan'], 'command', 'deliver'],
    ['deliver__fix-1', ['deliver__implement'], 'command', 'deliver'],
    ['fix-cycle', ['deliver__fix-1'], 'loop_group', ''],
    ['review-gate', ['fix-cycle'], 'approval', ''],
    ['child', ['review-gate'], 'workflow', ''],
  ])
  expect(nodes[3]!.body.map(node => node.id)).toEqual(['fix', 'recheck'])
  expect(nodes[5]!.workflow).toBe('archon-fix')
})

/** archon-ship with its includes folded, as the prototype on prototype/165-graph-width drew it: two waits skip a layer. */
const shipFolded: DrawNode[] = [
  box('triage', [], 'triage 3/3'),
  box('inv', ['triage'], 'inv 4/4'),
  box('gate-direct', ['triage']),
  box('planned', ['triage'], 'planned 0/6'),
  box('gate-rooted', ['inv']),
  box('gate-planned', ['planned']),
  box('deliver', ['gate-direct', 'gate-rooted', 'gate-planned'], 'deliver 12/53'),
  box('outcome', ['triage', 'deliver']),
]

/** archon-ship with every include expanded: 61 nodes. */
const shipExpanded: DrawNode[] = (() => {
  const chain = (prefix: string, names: string[], deps: string[]) =>
    names.map((name, i) => ({ ...box(`${prefix}__${name}`, i === 0 ? deps : [`${prefix}__${names[i - 1]}`]), block: prefix }))
  const deliver = Array.from({ length: 44 }, (_, i) => `step-${i + 1}`)
  return [
    ...chain('triage', ['classify', 'size', 'route'], []),
    ...chain('inv', ['reproduce', 'trace', 'hypothesis', 'report'], ['triage__route']),
    box('gate-direct', ['triage__route']),
    ...chain('planned', ['scope', 'explore', 'design', 'slice', 'review', 'write'], ['triage__route']),
    box('gate-rooted', ['inv__report']),
    box('gate-planned', ['planned__write']),
    ...chain('deliver', deliver, ['gate-direct', 'gate-rooted', 'gate-planned']),
    box('outcome', ['triage__route', 'deliver__step-44']),
  ]
})()

/** The widest line of boxes and connectors; a skip edge's note is prose, and wraps. */
const boxesWidest = (lines: { text: string }[][]) => widest(lines.filter(line => !line.some(seg => seg.text.includes('↑ '))))

test('archon-ship, folded and expanded, fits at every width or turns into the list, its skip edges kept', () => {
  expect(shipExpanded).toHaveLength(61)
  for (let width = 12; width <= 160; width++) {
    const folded = layout(shipFolded, width)
    const lines = text(folded.lines)
    if (folded.step <= 4) expect(boxesWidest(folded.lines)).toBeLessThanOrEqual(width)
    if (folded.step >= 4) {
      expect(lines).toContain('  ↑ outcome also waits on triage')
      expect(lines).toContain('  ↑ deliver also waits on gate-direct')
    }
    const expanded = layout(shipExpanded, width)
    if (expanded.step <= 4) expect(boxesWidest(expanded.lines)).toBeLessThanOrEqual(width)
    if (expanded.step === 5) expect(text(expanded.lines).filter(line => /[✓●○]/.test(line))).toHaveLength(61)
    if (expanded.step >= 4) expect(text(expanded.lines)).toContain('  ↑ outcome also waits on triage__route')
  }
})
