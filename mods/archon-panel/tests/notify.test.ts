import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { approval, attention, event, iso, MINUTE, onChild, otherRow, row, T0 } from './fixtures/runs'
import type { Row } from './fixtures/runs'
import { COLD, fake, IN_FRONT, world } from './fixtures/world'
import type { World } from './fixtures/world'

const START = { cwd: 'D:/repos/widgets', surface: 'terminal', isInteractive: true } as const

async function session($: Engine, on: On, rows: Row[], over: Partial<World> = {}, isStore = true) {
  const clock = mock.clock(on, { now: T0 + 20 * MINUTE })
  if (isStore) mock.store(on)
  const w = world({ rows, panes: IN_FRONT(), ...over })
  fake(on, w)
  await $.session.start(START)
  await clock.settle()
  await clock.advance(1_000)
  return { clock, w }
}

const lastStatus = (w: World) => w.status[w.status.length - 1]

// ---------- the status line ----------

const STATUS_CASES: { why: string; rows: Row[]; says: string | undefined }[] = [
  { why: 'one run on an approval, named', rows: [row('a', { workflow_name: 'archon-fix-issue', status: 'paused', metadata: { approval: approval() } })], says: 'Archon · ⏸ archon-fix-issue needs approval' },
  { why: 'one run on action needed, named', rows: [row('a', { workflow_name: 'archon-x', status: 'paused', metadata: { wait: attention() } })], says: 'Archon · ⏸ archon-x needs you' },
  {
    why: 'two needing you, counted, beside what runs',
    rows: [
      row('a', { status: 'paused', metadata: { approval: approval() } }),
      row('b', { status: 'paused', metadata: { wait: attention() } }),
      row('c'),
      row('d', { status: 'pending' }),
      row('e', { status: 'paused', metadata: { wait: { kind: 'time', nodeId: 'w', until: iso(T0 + 50 * MINUTE) } } }),
    ],
    says: 'Archon · ⏸ 2 need you · 3 running',
  },
  {
    why: 'a parent and its sub-run counted once, with another project\'s run that needs you',
    rows: [row('p'), row('c', { parent_run_id: 'p' }), otherRow('o', { status: 'paused', metadata: { approval: approval() } })],
    says: 'Archon · 1 running · ⏸ 1 elsewhere',
  },
  { why: 'only another project needing you', rows: [otherRow('o', { status: 'paused', metadata: { approval: approval() } })], says: 'Archon · ⏸ 1 elsewhere' },
  { why: 'nothing live', rows: [row('a', { status: 'completed', completed_at: iso(T0) }), otherRow('o')], says: undefined },
]

for (const { why, rows, says } of STATUS_CASES) {
  test(`status line: ${why}`, COLD, async ($, on) => {
    const { w } = await session($, on, rows)
    expect(lastStatus(w)).toBe(says)
  })
}

test('status line: cut to about 60 characters by dropping elsewhere, then running, then naming no run', COLD, async ($, on) => {
  const name = 'archon-a-longish-workflow-name'
  const others = [otherRow('o', { status: 'paused', metadata: { approval: approval() } })]
  const { w } = await session($, on, [row('a', { workflow_name: name, status: 'paused', metadata: { approval: approval() } }), row('b'), ...others])
  expect(lastStatus(w)).toBe(`Archon · ⏸ ${name} needs approval`)
})

test('status line: a named run too long for any part shrinks to a count', COLD, async ($, on) => {
  const name = 'archon-a-workflow-with-a-name-so-long-it-cannot-fit-in-sixty'
  const { w } = await session($, on, [row('a', { workflow_name: name, status: 'paused', metadata: { approval: approval() } })])
  expect(lastStatus(w)).toBe('Archon · ⏸ 1 needs you')
})

test('status line: off in the settings, it is cleared and never set', { ...COLD, options: { statusLine: false } }, async ($, on) => {
  const { w } = await session($, on, [row('a', { status: 'paused', metadata: { approval: approval() } })])
  expect(w.status.every(text => text === undefined)).toBe(true)
})

test('status line: cleared once nothing is live', COLD, async ($, on) => {
  const { clock, w } = await session($, on, [row('a')])
  expect(lastStatus(w)).toBe('Archon · 1 running')
  w.rows = [row('a', { status: 'completed', completed_at: iso(T0 + 21 * MINUTE) })]
  await clock.advance(2_000)
  expect(lastStatus(w)).toBe(undefined)
})

// ---------- toasts ----------

const gated = (id: string, name: string, message = 'Review the plan\nbefore it ships') =>
  row(id, { workflow_name: name, status: 'paused', metadata: { approval: approval({ message }) } })

test('toast: an approval, with the gate message\'s first line, for 15 s', COLD, async ($, on) => {
  const { w } = await session($, on, [gated('a', 'archon-plan')])
  expect(w.toasts).toEqual([{ text: '⏸ archon-plan needs approval: Review the plan', timeoutMs: 15_000 }])
})

test('toast: a sub-run\'s approval is raised for its parent, naming the sub-run', COLD, async ($, on) => {
  const { w } = await session($, on, [
    row('p', { workflow_name: 'archon-ship', status: 'paused', metadata: { approval: onChild('c') } }),
    row('c', { workflow_name: 'archon-fix', parent_run_id: 'p', status: 'paused', metadata: { approval: approval({ message: 'Ship it?' }) } }),
  ])
  expect(w.toasts).toEqual([{ text: '⏸ archon-ship needs approval: Ship it? (in sub-run archon-fix)', timeoutMs: 15_000 }])
})

test('toast: action needed and a stranded parent', COLD, async ($, on) => {
  const { w } = await session($, on, [
    row('a', { workflow_name: 'archon-release', status: 'paused', metadata: { wait: attention('Push the tag\nthen resume') } }),
  ])
  expect(w.toasts).toEqual([{ text: '⏸ archon-release needs you: Push the tag', timeoutMs: 15_000 }])
})

test('toast: a parent stranded by a sub-run that ended', COLD, async ($, on) => {
  const { w } = await session($, on, [
    row('p', { workflow_name: 'archon-ship', status: 'paused', metadata: { approval: onChild('c') } }),
    row('c', { workflow_name: 'archon-fix', parent_run_id: 'p', status: 'cancelled', completed_at: iso(T0 + 3 * MINUTE) }),
  ])
  expect(w.toasts).toEqual([{ text: '⏸ archon-ship needs you: sub-run archon-fix was cancelled', timeoutMs: 15_000 }])
})

test('toast: a failure names its node and error, for 8 s; a finish its time, for 4 s, with a failed sub-run', COLD, async ($, on) => {
  const { clock, w } = await session($, on, [row('f', { workflow_name: 'archon-broke' })])
  expect(w.toasts).toEqual([])
  w.rows = [row('f', { workflow_name: 'archon-broke', status: 'failed', completed_at: iso(T0 + 21 * MINUTE), last_activity_at: iso(T0 + 21 * MINUTE) })]
  w.events.f = [event('node_started', 'build'), event('node_failed', 'build', { error: 'tsc exited 2\nmore detail' })]
  await clock.advance(2_000)
  await clock.advance(1_000)
  expect(w.toasts).toEqual([{ text: '✗ archon-broke failed at build: tsc exited 2', timeoutMs: 8_000 }])

  w.rows.push(row('g', { workflow_name: 'archon-good', status: 'completed', started_at: iso(T0 + 9 * MINUTE), completed_at: iso(T0 + 21 * MINUTE) }))
  w.rows.push(row('g-sub', { workflow_name: 'archon-sub', parent_run_id: 'g', status: 'failed', completed_at: iso(T0 + 20 * MINUTE + 30_000) }))
  await clock.advance(10_000)
  await clock.advance(1_000)
  expect(w.toasts[1]).toEqual({ text: '✓ archon-good finished in 12m, 1 sub-run failed', timeoutMs: 4_000 })
  expect(w.toasts).toHaveLength(2)
})

test('toast: several events in one poll collapse into one, counted in order, for the longest part\'s time', COLD, async ($, on) => {
  const { w } = await session($, on, [
    gated('a', 'archon-plan'),
    row('f', { workflow_name: 'archon-broke', status: 'failed', completed_at: iso(T0 + 20 * MINUTE + 1) }),
    row('g', { workflow_name: 'archon-good', status: 'completed', completed_at: iso(T0 + 20 * MINUTE + 1) }),
    row('h', { workflow_name: 'archon-also', status: 'completed', completed_at: iso(T0 + 20 * MINUTE + 1) }),
  ])
  expect(w.toasts).toEqual([{ text: '⏸ 1 needs you · ✗ 1 failed · ✓ 2 finished', timeoutMs: 15_000 }])
})

test('toast: two runs of one workflow are told apart by the start of their ids', COLD, async ($, on) => {
  const { w } = await session($, on, [gated('1a2b3c4d', 'archon-plan'), row('9f8e7d6c', { workflow_name: 'archon-plan' })])
  expect(w.toasts[0]?.text).toBe('⏸ archon-plan 1a2b3c needs approval: Review the plan')
})

test('toast: cancelled, unreadable, waits, answered gates, a parent blocked on a working sub-run and other projects stay silent', COLD, async ($, on) => {
  const answered = row('ans', { status: 'paused', metadata: { approval: approval() } })
  const { clock, w } = await session($, on, [
    row('a', { status: 'cancelled', completed_at: iso(T0 + 20 * MINUTE + 1) }),
    row('b', { status: 'paused', metadata: {} }),
    row('c', { status: 'paused', metadata: { wait: { kind: 'time', nodeId: 'w', until: iso(T0 + 50 * MINUTE) } } }),
    answered,
    row('p', { status: 'paused', metadata: { approval: onChild('k') } }),
    row('k', { parent_run_id: 'p' }),
    otherRow('o', { status: 'paused', metadata: { approval: approval() } }),
    otherRow('o2', { status: 'failed', completed_at: iso(T0 + 20 * MINUTE + 1) }),
  ], { events: { ans: [event('approval_requested', 'review-gate'), event('approval_received', 'review-gate', { decision: 'approve' })] } })
  await clock.advance(2_000)
  expect(w.toasts).toEqual([])
})

test('toast: finishes and failures from before this session started never toast; a run that needs you does', COLD, async ($, on) => {
  const { w } = await session($, on, [
    row('old-done', { workflow_name: 'archon-old', status: 'completed', completed_at: iso(T0) }),
    row('old-fail', { workflow_name: 'archon-older', status: 'failed', completed_at: iso(T0) }),
    gated('gate', 'archon-plan'),
  ])
  expect(w.toasts).toEqual([{ text: '⏸ archon-plan needs approval: Review the plan', timeoutMs: 15_000 }])
})

test('toast: a key already claimed keeps a reload, or a later poll, from toasting again', COLD, async ($, on) => {
  const { clock, w } = await session($, on, [gated('a', 'archon-plan')])
  expect(w.toasts).toHaveLength(1)
  await $.session.start(START)
  await clock.settle()
  await clock.advance(5_000)
  expect(w.toasts).toHaveLength(1)
})

test('toast: the toasts setting at needs you keeps finishes quiet', { ...COLD, options: { toasts: 'needs you' } }, async ($, on) => {
  const { w } = await session($, on, [gated('a', 'archon-plan'), row('g', { workflow_name: 'archon-good', status: 'completed', completed_at: iso(T0 + 20 * MINUTE + 1) })])
  expect(w.toasts).toEqual([{ text: '⏸ archon-plan needs approval: Review the plan', timeoutMs: 15_000 }])
})

function sharedStore(on: On, readBack: (key: string, mine: unknown) => unknown, claims: string[]) {
  const store = new Map<string, unknown>()
  const asked = new Map<string, number>()
  on('store.get', (_$, e) => {
    const times = (asked.get(e.key) ?? 0) + 1
    asked.set(e.key, times)
    // The first read finds no claim; the read-back answers as the test says.
    return { value: times === 1 ? undefined : readBack(e.key, store.get(e.key)) }
  })
  on('store.set', (_$, e) => {
    claims.push(e.key)
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.delete', (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
}

test('toast: two sessions claiming one toast through the shared store: another session\'s id on the read-back keeps this one silent', COLD, async ($, on) => {
  const claims: string[] = []
  sharedStore(on, () => ({ session: 'session-b' }), claims)
  const { w } = await session($, on, [gated('a', 'archon-plan')], {}, false)
  expect(claims).toContain('toasted/a/needs-you')
  expect(w.toasts).toEqual([])
})

test('toast: two sessions claiming one toast through the shared store: this session\'s id on the read-back toasts', COLD, async ($, on) => {
  const claims: string[] = []
  sharedStore(on, () => 'session-a', claims)
  const { w } = await session($, on, [gated('a', 'archon-plan')], {}, false)
  expect(w.toasts).toHaveLength(1)
})

test('toast: a headless session and a toasts-off session never claim', { ...COLD, options: { toasts: 'off' } }, async ($, on) => {
  const claims: string[] = []
  sharedStore(on, (_key, mine) => mine, claims)
  const { w } = await session($, on, [gated('a', 'archon-plan')], {}, false)
  expect(claims).toEqual([])
  expect(w.toasts).toEqual([])
})

test('toast: a headless session never claims', COLD, async ($, on) => {
  const claims: string[] = []
  sharedStore(on, (_key, mine) => mine, claims)
  const clock = mock.clock(on, { now: T0 })
  const w = world({ surfaces: [], rows: [gated('a', 'archon-plan')] })
  fake(on, w)
  await $.session.start({ ...START, surface: null, isInteractive: false })
  await clock.advance(5 * MINUTE)
  expect(claims).toEqual([])
})

test('toast: claims are pruned once their run drops out of the listed rows', COLD, async ($, on) => {
  const store = new Map<string, unknown>([['toasted/gone/completed', { session: 'session-b' }]])
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.delete', (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  await session($, on, [gated('a', 'archon-plan')], {}, false)
  expect([...store.keys()]).toEqual(['toasted/a/needs-you'])
})
