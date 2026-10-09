import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { event, iso, MINUTE, OUTPUT_ROOT, row, T0 } from './fixtures/runs'
import type { Row } from './fixtures/runs'
import { BIG, CHAIN, EXEC, FAN, line } from './fixtures/transcripts'
import { archonCalls, end, fake, feed, IN_FRONT, paneProps, PHONE, send, world } from './fixtures/world'
import type { World } from './fixtures/world'

const START = { cwd: 'D:/repos/widgets', surface: 'terminal', isInteractive: true } as const

const done = (id: string, over: Record<string, unknown> = {}) =>
  row(id, { status: 'completed', started_at: iso(T0), completed_at: iso(T0 + 37 * MINUTE), metadata: { total_cost_usd: 4.12 }, ...over })

async function logOf($: Engine, on: On, rows: Row[], id: string, over: Partial<World> = {}, rowsShown = 200) {
  const clock = mock.clock(on, { now: T0 + 40 * MINUTE })
  mock.store(on)
  const w = world({ rows, panes: IN_FRONT(), ...over })
  fake(on, w)
  await $.session.start(START)
  await clock.settle()
  const pane = await $.ui.mount({ plugin: 'archon-panel', surface: 'terminal', component: 'Pane', requestId: 'archon', props: paneProps(100, rowsShown) })
  await pane.press({ key: `pick-${id}` })
  await pane.press({ key: 'tab-log' })
  await clock.settle()
  return { clock, w, pane }
}

const lines = async (pane: { findAll: (q: { type: 'Box' }) => Promise<{ text: string; key: string | undefined }[]> }) =>
  (await pane.findAll({ type: 'Box' })).filter(box => box.key?.startsWith('log-')).map(box => box.text)

test('a finished run\'s log is one replay: tool calls on a line, model text whole, node markers, and its end line', async ($, on) => {
  const { w, pane } = await logOf($, on, [done('chain-1')], 'chain-1', {
    transcripts: { 'chain-1': CHAIN },
    events: { 'chain-1': [event('node_completed', 'plan', { node_output: 'The plan, in short.' })] },
  })
  expect(archonCalls(w).filter(call => call === 'workflow logs chain-1')).toHaveLength(1)
  const shown = await lines(pane)
  expect(shown).toContain('▶ plan')
  // With no node picked, Log shows all nodes, each row tagged with its node.
  expect(shown).toContain('plan · I will look at the repo first.')
  expect(shown).toContain('Then write the plan.')
  expect(shown).toContain('plan · Bash git status --short && ls -la')
  expect(shown).toContain('plan · Write mods/widgets/README.md (35 KB) ▸')
  expect(shown).toContain('✓ plan 2m $0.42')
  expect(shown).toContain('The plan, in short.')
  expect(shown[shown.length - 1]).toBe('✓ completed 37m $4.12')
  expect((await pane.find({ type: 'Text', text: 'The plan, in short.' }))?.props.dimColor).toBe(true)
  await pane.unmount()
})

test('a bash node shows the last 20 lines of its output, and heartbeats stay hidden', async ($, on) => {
  const { pane } = await logOf($, on, [done('exec-1')], 'exec-1', { transcripts: { 'exec-1': EXEC } })
  const shown = await lines(pane)
  expect(shown).toContain('test · ok 11')
  expect(shown).toContain('ok 30')
  expect(shown).not.toContain('ok 10')
  expect(shown).toContain('warn: slow test')
  expect(shown.some(text => text.includes('watchdog'))).toBe(false)
  await pane.unmount()
})

test('a node\'s error from the events shows in error under its end marker, cut at 10 lines with the rest folded', async ($, on) => {
  const error = Array.from({ length: 14 }, (_, i) => `trace ${i + 1}`).join('\n')
  const { pane } = await logOf($, on, [done('exec-1', { status: 'failed' })], 'exec-1', {
    transcripts: { 'exec-1': EXEC },
    events: { 'exec-1': [event('node_failed', 'test', { error })] },
  })
  const shown = await lines(pane)
  expect(shown).toContain('trace 10')
  expect(shown).not.toContain('trace 11')
  expect((await pane.find({ type: 'Text', text: 'trace 1' }))?.props.color).toBe('error')
  expect(shown.some(text => text.includes('▸ 4 more lines'))).toBe(true)
  await pane.unmount()
})

test('with all nodes, tool rows take their node from the run\'s tool_called events, and fan-out text is marked ∥', async ($, on) => {
  const { pane } = await logOf($, on, [done('fan-1')], 'fan-1', {
    transcripts: { 'fan-1': FAN },
    events: { 'fan-1': [event('tool_called', 'code', { tool_name: 'Read' }), event('tool_called', 'docs', { tool_name: 'Grep' })] },
  })
  const shown = await lines(pane)
  expect(shown).toContain('code · Read src/code.ts')
  expect(shown).toContain('docs · Grep TODO')
  expect(shown).toContain('code ∥ docs · Reviewing both at once.')
  await pane.unmount()
})

test('cut to a node, Log shows only its rows, model text written during a fan-out under each open node', async ($, on) => {
  const root = `${OUTPUT_ROOT}/workflow-source/runs/fan-1`
  const { pane } = await logOf($, on, [done('fan-1')], 'fan-1', {
    disk: {
      [`${root}/manifest.json`]: JSON.stringify({ workflow_name: 'archon-plan' }),
      [`${root}/bundled/workflows/archon-plan.yaml`]: 'name: archon-plan\nnodes:\n  - id: code\n    command: code\n  - id: docs\n    command: docs\n',
    },
    transcripts: { 'fan-1': FAN },
    events: { 'fan-1': [event('tool_called', 'code', { tool_name: 'Read' }), event('tool_called', 'docs', { tool_name: 'Grep' })] },
  })
  await pane.press({ key: 'tab-graph' })
  await pane.press({ key: 'node-docs' })
  let shown = await lines(pane)
  expect(shown).toContain('Grep TODO')
  expect(shown).not.toContain('Read src/code.ts')
  expect(shown).toContain('∥ Reviewing both at once.')
  await pane.press({ key: 'log-all' })
  shown = await lines(pane)
  expect(shown).toContain('code · Read src/code.ts')
  await pane.unmount()
})

test('one fold open at a time, drawing at most 4,000 characters', async ($, on) => {
  const { pane } = await logOf($, on, [done('chain-1')], 'chain-1', { transcripts: { 'chain-1': CHAIN } })
  await pane.press({ key: 'fold-l5' })
  let shown = await lines(pane)
  expect(shown.some(text => text.includes('# Widgets'))).toBe(true)
  expect(shown.some(text => /… 3\d KB more not shown/.test(text))).toBe(true)
  await pane.press({ key: 'fold-l6' })
  shown = await lines(pane)
  expect(shown.some(text => text.includes('# Widgets'))).toBe(false)
  expect(shown.some(text => text.includes('old_string: a widget'))).toBe(true)
  await pane.unmount()
})

test('the window keeps the newest 60,000 drawn characters, saying how many earlier rows it dropped', async ($, on) => {
  const { pane } = await logOf($, on, [done('big-1')], 'big-1', { transcripts: { 'big-1': BIG } })
  const shown = await lines(pane)
  expect(shown[0]).toMatch(/^… \d+ earlier rows not kept$/)
  const drawn = shown.slice(1).map(text => text.replace(/^write · /, '')).filter(text => text.startsWith('row ')).reduce((sum, text) => sum + text.length, 0)
  expect(drawn).toBeLessThanOrEqual(60_000)
  expect(shown.some(text => text.startsWith('write · row 79'))).toBe(true)
  expect(shown.some(text => text.includes('row 00'))).toBe(false)
  await pane.unmount()
})

test('a missing transcript gets a dim line, and node output still shows from the events', async ($, on) => {
  const { pane } = await logOf($, on, [done('gone-1')], 'gone-1', {
    events: { 'gone-1': [event('node_completed', 'plan', { node_output: 'Planned anyway.' })] },
  })
  const shown = await lines(pane)
  expect(shown.some(text => text.includes("This run's transcript is missing"))).toBe(true)
  expect(shown).toContain('Planned anyway.')
  await pane.unmount()
})

test('a live run\'s log is followed, holding a line split across two chunks until it is whole', async ($, on) => {
  const f = feed()
  const { clock, w, pane } = await logOf($, on, [row('live-1')], 'live-1', { feeds: { 'live-1': f } })
  expect(w.spawned.map(argv => argv.slice(1).join(' '))).toEqual(['workflow logs live-1 --follow'])
  const whole = line('assistant', { content: 'Halfway there.' })
  send(f, `${line('node_start', { step: 'plan' })}\n${whole.slice(0, 20)}`)
  await clock.settle()
  expect(await lines(pane)).toEqual(['▶ plan'])
  send(f, `${whole.slice(20)}\n`)
  await clock.settle()
  expect(await lines(pane)).toEqual(['▶ plan', 'plan · Halfway there.'])
  end(f, 0)
  await clock.settle()
  await pane.unmount()
})

test('the follower runs only while the live run\'s log is in front, and the last detach kills it', async ($, on) => {
  const f = feed()
  const { clock, w, pane } = await logOf($, on, [row('live-1')], 'live-1', { feeds: { 'live-1': f } })
  expect(w.spawned).toHaveLength(1)
  await pane.press({ key: 'tab-runs' })
  await clock.settle()
  expect(w.killed).toHaveLength(1)
  await pane.press({ key: 'tab-log' })
  await clock.settle()
  expect(w.spawned).toHaveLength(2)
  w.surfaces.length = 0
  await $.session.detach({ ...PHONE, reason: 'detach' })
  await clock.settle()
  expect(w.killed).toHaveLength(2)
  await pane.unmount()
})

test('a reload restarts the follower, which replays from line 1 while the lines already taken are skipped', async ($, on) => {
  const f = feed()
  const { clock, w, pane } = await logOf($, on, [row('live-1')], 'live-1', { feeds: { 'live-1': f } })
  const first = [line('node_start', { step: 'plan' }), line('assistant', { content: 'One.' })]
  send(f, `${first.join('\n')}\n`)
  await clock.settle()
  expect(await lines(pane)).toEqual(['▶ plan', 'plan · One.'])

  const again = feed()
  w.feeds['live-1'] = again
  await $.session.start(START)
  await clock.settle()
  expect(w.spawned).toHaveLength(2)
  send(again, `${[...first, line('assistant', { content: 'Two.' })].join('\n')}\n`)
  await clock.settle()
  expect(await lines(pane)).toEqual(['▶ plan', 'plan · One.', 'plan · Two.'])
  await pane.unmount()
})

test('a followed run that ends keeps its window with the end line until another run is picked', async ($, on) => {
  const f = feed()
  const { clock, w, pane } = await logOf($, on, [row('live-1', { started_at: iso(T0) })], 'live-1', { feeds: { 'live-1': f } })
  send(f, `${line('node_start', { step: 'plan' })}\n`)
  await clock.settle()
  w.rows = [row('live-1', { status: 'failed', started_at: iso(T0), completed_at: iso(T0 + 12 * MINUTE) })]
  w.events['live-1'] = [event('node_failed', 'plan', { error: 'boom' })]
  end(f, 0)
  await clock.settle()
  await clock.advance(1_000)
  let shown = await lines(pane)
  expect(shown[shown.length - 1]).toBe('✗ failed 12m at plan: boom')
  // A reload keeps it, with no replay.
  await $.session.start(START)
  await clock.settle()
  shown = await lines(pane)
  expect(shown[shown.length - 1]).toBe('✗ failed 12m at plan: boom')
  expect(archonCalls(w).filter(call => call.startsWith('workflow logs live-1'))).toHaveLength(0)
  await pane.unmount()
})

test('the files line lists the run\'s files newest first; a file opens in a read view, and b goes back', async ($, on) => {
  const files = [
    { path: 'plan.md', size: 35_248, modifiedAt: iso(T0 + 3 * MINUTE) },
    { path: 'review/report.md', size: 5_503, modifiedAt: iso(T0 + 9 * MINUTE) },
    { path: 'nodes/plan.meta.json', size: 251, modifiedAt: iso(T0 + 1 * MINUTE) },
  ]
  const { pane } = await logOf($, on, [done('chain-1')], 'chain-1', {
    transcripts: { 'chain-1': CHAIN },
    artifacts: { 'chain-1': files },
    artifactText: { 'chain-1/review/report.md': '# Report\n\nAll good.', 'chain-1/nodes/plan.meta.json': '{"nodeId":"plan"}' },
  })
  expect((await pane.find({ key: 'files' }))?.text).toBe('▸ 3 files: report.md · plan.md · plan.meta.json')
  await pane.press({ key: 'files' })
  expect((await pane.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('file-')).map(b => b.text)).toEqual([
    'review/report.md  5 KB',
    'plan.md  34 KB',
    'nodes/plan.meta.json  251 B',
  ])
  await pane.press({ key: 'file-review/report.md' })
  expect((await pane.find({ type: 'Markdown' }))?.props.text).toBe('# Report\n\nAll good.')
  await pane.press({ key: 'file-back' })
  await pane.press({ key: 'file-nodes/plan.meta.json' })
  expect((await pane.find({ type: 'Code' }))?.props.source).toBe('{"nodeId":"plan"}')
  await pane.unmount()
})

test('with the server down, the files come from the run\'s folder on disk, skipping Archon\'s own store', async ($, on) => {
  const folder = `${OUTPUT_ROOT}/artifacts/runs/chain-1`
  const { pane } = await logOf($, on, [done('chain-1')], 'chain-1', {
    server: 'down',
    transcripts: { 'chain-1': CHAIN },
    disk: { [`${folder}/plan.md`]: '# Plan', [`${folder}/.archon/typed-artifacts/x.json`]: '{}' },
  })
  expect((await pane.find({ key: 'files' }))?.text).toBe('▸ 1 file: plan.md')
  await pane.press({ key: 'files' })
  await pane.press({ key: 'file-plan.md' })
  expect((await pane.find({ type: 'Markdown' }))?.props.text).toBe('# Plan')
  await pane.unmount()
})

test('a file over 60,000 characters is cut with a line to open it outside; o opens it, @ puts it in the prompt', async ($, on) => {
  const big = 'y'.repeat(70_000)
  const { w, pane } = await logOf($, on, [done('chain-1')], 'chain-1', {
    transcripts: { 'chain-1': CHAIN },
    artifacts: { 'chain-1': [{ path: 'big.log', size: 70_000, modifiedAt: iso(T0) }] },
    artifactText: { 'chain-1/big.log': big },
  })
  await pane.press({ key: 'files' })
  await pane.press({ key: 'file-big.log' })
  expect((await pane.find({ type: 'Code' }))?.props.source).toHaveLength(60_000)
  expect(await pane.find({ type: 'Text', text: '… 10 KB more: open it outside' })).toBeDefined()
  await pane.press({ key: 'file-open' })
  expect(w.argv.some(argv => argv[0] === 'C:\\Windows\\explorer.exe' && argv[1] === 'C:\\home\\.archon\\workspaces\\octo\\widgets\\artifacts\\runs\\chain-1\\big.log')).toBe(true)
  await pane.press({ key: 'file-mention' })
  expect(w.filled).toEqual([`@${OUTPUT_ROOT}/artifacts/runs/chain-1/big.log `])
  await pane.unmount()
})

test('the Write row of a file the run kept opens that file', async ($, on) => {
  const transcript = `${line('node_start', { step: 'plan' })}\n${line('tool', { tool_name: 'Write', tool_input: { file_path: `${OUTPUT_ROOT}/artifacts/runs/chain-1/plan.md`, content: '# The plan' } })}\n`
  const { pane } = await logOf($, on, [done('chain-1')], 'chain-1', {
    transcripts: { 'chain-1': transcript },
    artifacts: { 'chain-1': [{ path: 'plan.md', size: 10, modifiedAt: iso(T0) }] },
    artifactText: { 'chain-1/plan.md': '# The plan' },
  })
  await pane.press({ key: 'fold-l2' })
  await pane.press({ key: 'write-open-l2' })
  expect((await pane.find({ type: 'Markdown' }))?.props.text).toBe('# The plan')
  await pane.unmount()
})


test('while at its end, the log follows its tail as rows arrive', async ($, on) => {
  const f = feed()
  const { clock, pane } = await logOf($, on, [row('live-1')], 'live-1', { feeds: { 'live-1': f } }, 6)
  send(f, `${Array.from({ length: 12 }, (_, i) => line('assistant', { content: `step ${i}` })).join('\n')}\n`)
  await clock.settle()
  await pane.redraw()
  const shown = await lines(pane)
  expect(shown[shown.length - 1]).toBe('step 11')
  await pane.unmount()
})

test('picking a node whose rows dropped off the window refills it with one replay of that node\'s rows; a returns to the newest', async ($, on) => {
  const root = `${OUTPUT_ROOT}/workflow-source/runs/big-1`
  const transcript = `${line('node_start', { step: 'early' })}\n${line('assistant', { content: 'early words' })}\n${line('node_complete', { step: 'early' })}\n${BIG}`
  const { w, pane } = await logOf($, on, [done('big-1')], 'big-1', {
    transcripts: { 'big-1': transcript },
    disk: {
      [`${root}/manifest.json`]: JSON.stringify({ workflow_name: 'archon-plan' }),
      [`${root}/bundled/workflows/archon-plan.yaml`]: 'name: archon-plan\nnodes:\n  - id: early\n    command: early\n  - id: write\n    command: write\n    depends_on: [early]\n',
    },
  })
  expect((await lines(pane)).some(text => text.includes('early words'))).toBe(false)
  await pane.press({ key: 'tab-graph' })
  await pane.press({ key: 'node-early' })
  expect(await lines(pane)).toContain('early words')
  expect(archonCalls(w).filter(call => call === 'workflow logs big-1')).toHaveLength(2)
  await pane.press({ key: 'log-all' })
  expect((await lines(pane)).some(text => text.includes('early words'))).toBe(false)
  expect((await lines(pane)).some(text => text.includes('row 79'))).toBe(true)
  await pane.unmount()
})

test('where no prompt box can take it, @ says so', async ($, on) => {
  const { pane } = await logOf($, on, [done('chain-1')], 'chain-1', {
    composer: 'no_composer',
    transcripts: { 'chain-1': CHAIN },
    artifacts: { 'chain-1': [{ path: 'plan.md', size: 6, modifiedAt: iso(T0) }] },
    artifactText: { 'chain-1/plan.md': '# Plan' },
  })
  await pane.press({ key: 'files' })
  await pane.press({ key: 'file-plan.md' })
  await pane.press({ key: 'file-mention' })
  expect((await pane.find({ type: 'Text', text: "can't reach the prompt here" }))?.props.dimColor).toBe(true)
  await pane.unmount()
})
