import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'
import type { On } from 'claude-code'

import { actionNeeded, approval, event, iso, MINUTE, onSubRun, row, T0 } from './fixtures/runs'
import type { Row } from './fixtures/runs'
import { archonCalls, COLD, fake, IN_FRONT, paneProps, world } from './fixtures/world'
import type { World } from './fixtures/world'

const START = { cwd: 'D:/repos/widgets', surface: 'terminal', isInteractive: true } as const
const NOW = T0 + 20 * MINUTE
const hhmm = (ms: number) => {
  const at = new Date(ms)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}
/** The working path on disk, so resume is offered. */
const THERE = { 'D:/repos/widgets/README.md': '# widgets' }

const gated = (id: string, gate: Record<string, unknown> = {}, over: Record<string, unknown> = {}) =>
  row(id, { workflow_name: 'archon-plan', status: 'paused', ...over, metadata: { approval: approval(gate) } })

async function open($: Engine, on: On, rows: Row[], id: string, over: Partial<World> = {}, surface: 'terminal' | 'mobile' = 'terminal') {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const w = world({ rows, panes: IN_FRONT(), disk: { ...THERE }, ...over })
  fake(on, w)
  await $.session.start(START)
  await clock.settle()
  // Typed as the terminal's: a test on the phone never types into an Input.
  const pane = (await $.ui.mount({ plugin: 'archon-panel', surface, component: 'Pane', requestId: 'archon', props: paneProps(100, 120) })) as Mounted<'terminal', 'Pane'>
  await pane.press({ key: `pick-${id}` })
  await clock.settle()
  return { clock, w, pane }
}

type Pane = Awaited<ReturnType<typeof open>>['pane']
const buttons = async (pane: Pane) => (await pane.findAll({ type: 'Button' })).filter(b => /^(decide-|resume$|abandon$|confirm$|back$)/.test(b.key ?? '')).map(b => `${b.key}=${b.text}`)
const texts = async (pane: Pane) => (await pane.findAll({ type: 'Text' })).map(t => t.text)

// ---------- the approval view ----------

test('picking a run on an approval opens Log on its gate: header, message, what it asks about, files, then the answer area', COLD, async ($, on) => {
  const { pane } = await open($, on, [gated('1a2b3c4d', { nodeId: 'review-gate', waitingSince: iso(NOW - 4 * MINUTE) })], '1a2b3c4d', {
    events: { '1a2b3c4d': [event('node_completed', 'plan', { node_output: 'The plan:\nstep one\nstep two' })] },
    artifacts: { '1a2b3c4d': [{ path: 'plan.md', size: 900, modifiedAt: iso(T0) }] },
  })
  expect((await pane.find({ key: 'tab-log' }))?.props.dimColor).toBe(false)
  const all = await texts(pane)
  expect(all).toContain('archon-plan · 1a2b3c4 · waited 4m')
  expect((await pane.find({ type: 'Markdown' }))?.props.text).toBe('Review the plan\nbefore it ships')
  expect(await buttons(pane)).toEqual(['decide-approve=y: Approve', 'decide-reject=n: Reject (cancels the run)'])
  expect((await pane.find({ key: 'decide-approve' }))?.props.variant).toBe('primary')
  expect((await pane.find({ key: 'decide-approve' }))?.props.hotkey).toBe('y')
  expect((await pane.find({ key: 'comment' }))?.props.label).toBe('Comment or reason (optional)')
  // The files the run kept are unfolded.
  expect((await pane.findAll({ type: 'Button' })).some(b => b.key === 'file-plan.md')).toBe(true)
  await pane.unmount()
})

/** A run whose gate waits on `plan` but not on `other`: its frozen workflow on disk, and both nodes' output. */
const SOURCE = 'C:/home/.archon/workspaces/octo/widgets/workflow-source/runs/g'
const ASKING: Partial<World> = {
  disk: {
    ...THERE,
    [`${SOURCE}/manifest.json`]: JSON.stringify({ workflow_name: 'archon-plan' }),
    [`${SOURCE}/bundled/workflows/archon-plan.yaml`]: 'name: archon-plan\nnodes:\n  - id: plan\n    command: plan\n  - id: other\n    command: other\n  - id: review-gate\n    approval:\n      message: Review\n    depends_on: [plan]\n',
  },
  events: { g: [event('node_completed', 'plan', { node_output: 'The plan, in short.' }), event('node_completed', 'other', { node_output: 'Not asked about.' })] },
}

test('what an approval asks about is the output of each node its gate waits on', COLD, async ($, on) => {
  const { pane } = await open($, on, [gated('g')], 'g', ASKING)
  const all = await texts(pane)
  expect(all).toContain('The plan, in short.')
  expect(all).not.toContain('Not asked about.')
  await pane.unmount()
})

test('a widens what an approval asks about to the whole run log', COLD, async ($, on) => {
  const { clock, pane } = await open($, on, [gated('g')], 'g', ASKING)
  const all = await pane.find({ key: 'asks-all' })
  expect(all?.props.hotkey).toBe('a')
  expect(all?.props.label).toBe('whole run log')
  await pane.press({ key: 'asks-all' })
  await clock.settle()
  const shown = await texts(pane)
  expect(shown).toContain('The plan, in short.')
  expect(shown).toContain('Not asked about.')
  expect((await pane.findAll({ type: 'Button' })).some(b => b.props.hotkey === 'a')).toBe(false)
  // Still the approval view: the answer area stays.
  expect((await pane.find({ key: 'decide-approve' }))?.text).toBe('y: Approve')
  await pane.unmount()
})

test('declared decisions take y, n, or the first free letter of their label, never r, a, b, o or x', COLD, async ($, on) => {
  const { pane } = await open($, on, [gated('g', { decisions: [
    { id: 'approve', label: 'Approve' },
    { id: 'needs-revision', label: 'Needs revision' },
    { id: 'abort-all', label: 'Abort all' },
    { id: 'reject', label: 'Reject' },
  ] })], 'g')
  expect(await buttons(pane)).toEqual([
    'decide-approve=y: Approve',
    'decide-needs-revision=e: Needs revision',
    'decide-abort-all=t: Abort all',
    'decide-reject=n: Reject (cancels the run)',
  ])
  expect((await pane.find({ key: 'decide-abort-all' }))?.props.hotkey).toBe('t')
  await pane.unmount()
})

test('a loop gate whose round said it is done finishes on a bare approve, and goes another round once there is text', COLD, async ($, on) => {
  const { pane } = await open($, on, [gated('g', { type: 'interactive_loop', roundDone: true })], 'g')
  expect((await pane.find({ key: 'decide-approve' }))?.text).toBe('y: Approve and finish')
  expect(await texts(pane)).toContain('A bare approve finishes the loop; with a comment it runs another round.')
  await pane.input({ key: 'comment', text: 'one more pass', kind: 'change' })
  expect((await pane.find({ key: 'decide-approve' }))?.text).toBe('y: Another round')
  await pane.unmount()
})

test('on the phone the buttons answer with no text, and a dim line says a comment needs the terminal or the desktop app', COLD, async ($, on) => {
  const { pane } = await open($, on, [gated('g')], 'g', {}, 'mobile')
  expect(await pane.find({ key: 'comment' })).toBeUndefined()
  expect((await pane.find({ type: 'Text', text: 'A comment needs the terminal or the desktop app.' }))?.props.dimColor).toBe(true)
  await pane.unmount()
})

// ---------- confirming ----------

test('a decision is confirmed with Send, restating the action, the run and the text; b goes back and keeps the text', COLD, async ($, on) => {
  const { w, pane } = await open($, on, [gated('1a2b3c4d')], '1a2b3c4d')
  await pane.input({ key: 'comment', text: 'looks good', kind: 'change' })
  await pane.press({ key: 'decide-approve' })
  expect(await buttons(pane)).toEqual(['confirm=Send', 'back=b: Back'])
  expect((await pane.find({ key: 'confirm' }))?.props.autoFocus).toBe(true)
  expect(await texts(pane)).toContain('Approve archon-plan 1a2b3c4 · "looks good"')
  expect(archonCalls(w).some(call => call.startsWith('workflow approve'))).toBe(false)
  await pane.press({ key: 'back' })
  expect(await buttons(pane)).toEqual(['decide-approve=y: Approve', 'decide-reject=n: Reject (cancels the run)'])
  expect((await pane.find({ key: 'comment' }))?.props.value).toBe('looks good')
  await pane.unmount()
})

test('a switch of sub-tab drops the pending action', COLD, async ($, on) => {
  const { pane } = await open($, on, [gated('g')], 'g')
  await pane.press({ key: 'decide-approve' })
  await pane.press({ key: 'tab-runs' })
  await pane.press({ key: 'tab-log' })
  expect(await buttons(pane)).toEqual(['decide-approve=y: Approve', 'decide-reject=n: Reject (cancels the run)'])
  await pane.unmount()
})

// ---------- routing ----------

test('a CLI-started run is answered through the CLI with --detach, and the answer becomes a record line', COLD, async ($, on) => {
  const { clock, w, pane } = await open($, on, [gated('g')], 'g')
  w.cliReply = argv => {
    if (argv[2] === 'approve') {
      w.rows = [row('g', { workflow_name: 'archon-plan', status: 'running' })]
      w.events.g = [event('approval_requested', 'review-gate'), event('approval_received', 'review-gate', { decision: 'approve', comment: 'ship it' })]
    }
    return undefined
  }
  await pane.input({ key: 'comment', text: 'ship it', kind: 'change' })
  await pane.press({ key: 'decide-approve' })
  await pane.press({ key: 'confirm' })
  await clock.settle()
  expect(w.argv.filter(argv => argv[2] === 'approve').map(argv => argv.slice(1))).toEqual([['workflow', 'approve', 'g', 'ship it', '--detach', '--json']])
  expect(w.fetches.some(f => f.method === 'POST')).toBe(false)
  expect(await texts(pane)).toContain(`✓ Approved ${hhmm(NOW)} · "ship it"`)
  expect(w.toasts).toEqual([])
  await pane.unmount()
})

test('a reject is sent through reject, with its reason', COLD, async ($, on) => {
  const { clock, w, pane } = await open($, on, [gated('g')], 'g')
  await pane.input({ key: 'comment', text: 'no', kind: 'change' })
  await pane.press({ key: 'decide-reject' })
  await pane.press({ key: 'confirm' })
  await clock.settle()
  expect(w.argv.filter(a => a[2] === 'reject').map(a => a.slice(1))).toEqual([['workflow', 'reject', 'g', 'no', '--detach', '--json']])
  await pane.unmount()
})

test('a declared decision is sent through respond', COLD, async ($, on) => {
  const { clock, w, pane } = await open($, on, [gated('g', { decisions: [{ id: 'approve', label: 'Approve' }, { id: 'needs-revision', label: 'Needs revision' }] })], 'g')
  await pane.press({ key: 'decide-needs-revision' })
  await pane.press({ key: 'confirm' })
  await clock.settle()
  expect(w.argv.filter(a => a[2] === 'respond').map(a => a.slice(1))).toEqual([['workflow', 'respond', 'g', 'needs-revision', '--detach', '--json']])
  await pane.unmount()
})

test('a web-started run is answered through the server while it answers', COLD, async ($, on) => {
  const { clock, w, pane } = await open($, on, [gated('g', {}, { parent_conversation_id: 'conv-1' })], 'g')
  await pane.input({ key: 'comment', text: 'not this', kind: 'change' })
  await pane.press({ key: 'decide-reject' })
  await pane.press({ key: 'confirm' })
  await clock.settle()
  expect(w.fetches.filter(f => f.method === 'POST')).toEqual([{ method: 'POST', url: 'http://localhost:3090/api/workflows/runs/g/reject', body: JSON.stringify({ reason: 'not this' }) }])
  expect(archonCalls(w).some(call => call.startsWith('workflow reject'))).toBe(false)
  expect((await pane.find({ type: 'Text', text: `✗ Rejected ${hhmm(NOW)} · "not this"` }))?.props.color).toBe('error')
  await pane.unmount()
})

test('with the server down a web-started run is answered through the CLI, and the confirming line says its chat won\'t show the rest', COLD, async ($, on) => {
  const { clock, w, pane } = await open($, on, [gated('g', {}, { parent_conversation_id: 'conv-1' })], 'g', { server: 'down' })
  await pane.press({ key: 'decide-approve' })
  expect((await texts(pane)).some(t => t.includes("The server isn't answering, so the rest of this run won't show in its chat."))).toBe(true)
  await pane.press({ key: 'confirm' })
  await clock.settle()
  expect(w.argv.filter(a => a[2] === 'approve').map(a => a.slice(1))).toEqual([['workflow', 'approve', 'g', '--detach', '--json']])
  await pane.unmount()
})

test('a sub-run\'s approval is answered on the sub-run\'s own id, and says what a reject does to its parent', COLD, async ($, on) => {
  const parent = row('p', { workflow_name: 'archon-ship', status: 'paused', metadata: { approval: onSubRun('c') } })
  const child = row('c', { workflow_name: 'archon-fix', parent_run_id: 'p', status: 'paused', metadata: { approval: approval() } })
  const { clock, w, pane } = await open($, on, [parent, child], 'p')
  expect(await texts(pane)).toContain('archon-ship › sub-run archon-fix · c · waited 18m')
  expect((await pane.find({ key: 'decide-reject' }))?.text).toBe('n: Reject (cancels this sub-run; archon-ship stays paused)')
  await pane.press({ key: 'decide-approve' })
  await pane.press({ key: 'confirm' })
  await clock.settle()
  expect(w.argv.filter(a => a[2] === 'approve').map(a => a[3])).toEqual(['c'])
  await pane.unmount()
})

test('when Archon still refuses with a childRunId, the answer follows that id', COLD, async ($, on) => {
  const { clock, w, pane } = await open($, on, [gated('p', {}, { parent_conversation_id: 'conv-1' })], 'p')
  w.httpReply = (method, path) => {
    if (method === 'POST' && path === '/api/workflows/runs/p/approve') return { status: 400, body: JSON.stringify({ error: 'Run is paused waiting on sub-run c2. Approve or reject the child run instead.', childRunId: 'c2' }) }
    if (method === 'POST' && path === '/api/workflows/runs/c2/approve') return { status: 200, body: JSON.stringify({ success: true, message: 'Approved' }) }
    return undefined
  }
  await pane.press({ key: 'decide-approve' })
  await pane.press({ key: 'confirm' })
  await clock.settle()
  expect(w.fetches.filter(f => f.method === 'POST').map(f => f.url)).toEqual([
    'http://localhost:3090/api/workflows/runs/p/approve',
    'http://localhost:3090/api/workflows/runs/c2/approve',
  ])
  await pane.unmount()
})

// ---------- refusals, silence and races ----------

test('a refusal shows Archon\'s message in error, and the buttons come back while the run still needs you', COLD, async ($, on) => {
  const { clock, w, pane } = await open($, on, [gated('g')], 'g')
  w.cliReply = argv => (argv[2] === 'approve' ? { exitCode: 1, stdout: JSON.stringify({ ok: false, runId: 'g', action: 'approve', error: 'Run g is not paused.' }) } : undefined)
  await pane.press({ key: 'decide-approve' })
  await pane.press({ key: 'confirm' })
  await clock.settle()
  expect((await pane.find({ type: 'Text', text: 'Run g is not paused.' }))?.props.color).toBe('error')
  expect(await buttons(pane)).toEqual(['decide-approve=y: Approve', 'decide-reject=n: Reject (cancels the run)'])
  await pane.unmount()
})

test('no reply in 30 s says it may still have gone through', COLD, async ($, on) => {
  const { clock, w, pane } = await open($, on, [gated('g')], 'g')
  w.cliReply = argv => (argv[2] === 'approve' ? 'hang' : undefined)
  await pane.press({ key: 'decide-approve' })
  void pane.press({ key: 'confirm' })
  await clock.settle()
  expect((await pane.find({ type: 'Text', text: 'Sending approve…' }))?.props.dimColor).toBe(true)
  expect(await buttons(pane)).toEqual([])
  await clock.advance(30_000)
  expect((await pane.find({ type: 'Text', text: 'No reply from Archon in 30 s; it may still have gone through' }))?.props.color).toBe('error')
  expect(await buttons(pane)).toEqual(['decide-approve=y: Approve', 'decide-reject=n: Reject (cancels the run)'])
  w.release()
  await pane.unmount()
})

test('an answer Archon accepted but has not recorded after 30 s says so, names the detached log, and brings the buttons back with the text', COLD, async ($, on) => {
  const { clock, pane } = await open($, on, [gated('g')], 'g')
  await pane.input({ key: 'comment', text: 'go', kind: 'change' })
  await pane.press({ key: 'decide-approve' })
  await pane.press({ key: 'confirm' })
  await clock.settle()
  await clock.advance(30_000)
  const all = await texts(pane)
  expect(all.some(t => t.startsWith("Archon accepted the answer but hasn't recorded it") && t.includes('C:/home/.archon/logs/detached-run-cli-1.log'))).toBe(true)
  expect(await buttons(pane)).toEqual(['decide-approve=y: Approve', 'decide-reject=n: Reject (cancels the run)'])
  expect((await pane.find({ key: 'comment' }))?.props.value).toBe('go')
  await pane.unmount()
})

test('answered elsewhere before sending: nothing is sent, and the answer found is shown', COLD, async ($, on) => {
  const { clock, w, pane } = await open($, on, [gated('g')], 'g')
  await pane.press({ key: 'decide-approve' })
  w.rows = [row('g', { workflow_name: 'archon-plan', status: 'running' })]
  w.events.g = [event('approval_requested', 'review-gate'), event('approval_received', 'review-gate', { decision: 'approve', comment: 'from the web' }, T0 + 19 * MINUTE)]
  await pane.press({ key: 'confirm' })
  await clock.settle()
  expect(w.argv.some(a => a[2] === 'approve')).toBe(false)
  expect(await texts(pane)).toContain(`Answered elsewhere · ✓ Approved ${hhmm(T0 + 19 * MINUTE)} · "from the web"`)
  await pane.unmount()
})

test('answered elsewhere during confirmation: a poll drops the pending action, the typed text stays, dim', COLD, async ($, on) => {
  const { clock, w, pane } = await open($, on, [gated('g')], 'g')
  await pane.input({ key: 'comment', text: 'my words', kind: 'change' })
  await pane.press({ key: 'decide-approve' })
  w.rows = [row('g', { workflow_name: 'archon-plan', status: 'running' })]
  await clock.advance(2_000)
  expect(await buttons(pane)).toEqual([])
  expect((await pane.find({ type: 'Text', text: 'my words' }))?.props.dimColor).toBe(true)
  await pane.unmount()
})

// ---------- resume and abandon ----------

const actionRow = (over: Record<string, unknown> = {}) =>
  row('a', { workflow_name: 'archon-release', status: 'paused', ...over, metadata: { wait: { ...actionNeeded('Push the release tag, then resume.'), waitingSince: iso(NOW - 14 * MINUTE) } } })

test('action needed offers resume and abandon, each confirmed with a button naming it', COLD, async ($, on) => {
  const { clock, w, pane } = await open($, on, [actionRow()], 'a')
  const all = await texts(pane)
  expect(all).toContain('⏸ Action needed · waiting 14m')
  expect(all).toContain('Push the release tag, then resume.')
  expect(await buttons(pane)).toEqual(["resume=r  Resume: I've done it", 'abandon=x  Abandon run'])
  await pane.press({ key: 'resume' })
  expect(await texts(pane)).toContain('Resume: the run carries on from tag.')
  expect(await buttons(pane)).toEqual(['confirm=Resume archon-release', 'back=b: Back'])
  await pane.press({ key: 'confirm' })
  await clock.settle()
  expect(w.argv.filter(a => a[2] === 'resume').map(a => a.slice(1))).toEqual([['workflow', 'resume', 'a', '--detach', '--json']])
  expect(await texts(pane)).toContain(`▶ resumed by you ${hhmm(NOW)}`)
  await pane.unmount()
})

test('abandon confirms with its own line and button, and goes through the CLI for a CLI-started run', COLD, async ($, on) => {
  const { clock, w, pane } = await open($, on, [actionRow()], 'a')
  await pane.press({ key: 'abandon' })
  expect(await texts(pane)).toContain("Abandon: ends this run and anything it started. It can't be resumed.")
  expect(await buttons(pane)).toEqual(['confirm=Abandon archon-release', 'back=b: Back'])
  await pane.press({ key: 'confirm' })
  await clock.settle()
  expect(w.argv.filter(a => a[2] === 'abandon').map(a => a.slice(1))).toEqual([['workflow', 'abandon', 'a', '--json']])
  expect(await texts(pane)).toContain(`✗ abandoned by you ${hhmm(NOW)}`)
  await pane.unmount()
})

test('a web-started run is resumed and abandoned through the server while it answers; resume is sent to its chat', COLD, async ($, on) => {
  const { clock, w, pane } = await open($, on, [actionRow({ parent_conversation_id: 'conv-1' })], 'a')
  await pane.press({ key: 'resume' })
  await pane.press({ key: 'confirm' })
  await clock.settle()
  expect(w.fetches.filter(f => f.method === 'POST').map(f => f.url)).toEqual(['http://localhost:3090/api/workflows/runs/a/resume'])
  expect(await texts(pane)).toContain(`▶ sent to its chat ${hhmm(NOW)}`)
  // Still paused two polls later: the chat may need a look.
  await clock.advance(2_000)
  await clock.advance(2_000)
  expect((await pane.find({ type: 'Text', text: 'still paused: check its chat' }))?.props.dimColor).toBe(true)
  await pane.unmount()
})

test('a web-started run is abandoned through the server while it answers', COLD, async ($, on) => {
  const { clock, w, pane } = await open($, on, [actionRow({ parent_conversation_id: 'conv-1' })], 'a')
  await pane.press({ key: 'abandon' })
  await pane.press({ key: 'confirm' })
  await clock.settle()
  expect(w.fetches.filter(f => f.method === 'POST').map(f => f.url)).toEqual(['http://localhost:3090/api/workflows/runs/a/abandon'])
  expect(archonCalls(w).some(call => call.startsWith('workflow abandon'))).toBe(false)
  await pane.unmount()
})

test('with the server down a web-started run is resumed through the CLI', COLD, async ($, on) => {
  const { clock, w, pane } = await open($, on, [actionRow({ parent_conversation_id: 'conv-1' })], 'a', { server: 'down' })
  await pane.press({ key: 'resume' })
  await pane.press({ key: 'confirm' })
  await clock.settle()
  expect(w.argv.filter(a => a[2] === 'resume').map(a => a.slice(1))).toEqual([['workflow', 'resume', 'a', '--detach', '--json']])
  await pane.unmount()
})

test('a Slack run is never resumed from the pane, but can be abandoned, through the CLI', COLD, async ($, on) => {
  const { clock, w, pane } = await open($, on, [actionRow({ parent_conversation_id: 'slack-1', platform_type: 'slack' })], 'a')
  expect(await buttons(pane)).toEqual(['abandon=x  Abandon run'])
  expect((await pane.find({ type: 'Text', text: 'resume it from Slack' }))?.props.dimColor).toBe(true)
  await pane.press({ key: 'abandon' })
  await pane.press({ key: 'confirm' })
  await clock.settle()
  expect(w.argv.filter(a => a[2] === 'abandon').map(a => a.slice(1))).toEqual([['workflow', 'abandon', 'a', '--json']])
  await pane.unmount()
})

test('a run whose working path is gone offers only abandon', COLD, async ($, on) => {
  const { pane } = await open($, on, [actionRow({ working_path: 'D:/gone/worktree' })], 'a')
  expect(await buttons(pane)).toEqual(['abandon=x  Abandon run'])
  expect((await pane.find({ type: 'Text', text: "can't resume: D:/gone/worktree is gone" }))?.props.dimColor).toBe(true)
  await pane.unmount()
})

const STRANDS = [
  { ending: 'cancelled', head: `! Sub-run archon-fix was cancelled (rejected ${hhmm(T0 + 5 * MINUTE)})`, label: 'r  Resume without it', line: 'Resume: node fix fails ("Sub-run \'archon-fix\' was cancelled") and the run goes on by its rules, which usually fail it.' },
  { ending: 'failed', head: '! Sub-run archon-fix failed', label: 'r  Resume: run archon-fix again, once', line: 'Resume: node fix runs archon-fix again, once.' },
  { ending: 'completed', head: '! Sub-run archon-fix finished', label: "r  Resume: go on with archon-fix's output", line: "Resume: node fix goes on with archon-fix's output." },
] as const

for (const strand of STRANDS) {
  test(`a parent stranded by a ${strand.ending} sub-run names how it ended, and its resume follows`, COLD, async ($, on) => {
    const parent = row('p', { workflow_name: 'archon-ship', status: 'paused', metadata: { approval: onSubRun('c') } })
    const child = row('c', { workflow_name: 'archon-fix', parent_run_id: 'p', status: strand.ending, completed_at: iso(T0 + 5 * MINUTE) })
    const { pane } = await open($, on, [parent, child], 'p')
    const all = await texts(pane)
    expect(all).toContain(strand.head)
    expect(all).toContain("Node fix can't go on.")
    expect(await buttons(pane)).toEqual([`resume=${strand.label}`, 'abandon=x  Abandon run'])
    await pane.press({ key: 'resume' })
    expect(await texts(pane)).toContain(strand.line)
    await pane.unmount()
  })
}

test('a resume raced: resumed elsewhere, or ended elsewhere, sends nothing', COLD, async ($, on) => {
  const { clock, w, pane } = await open($, on, [actionRow()], 'a')
  await pane.press({ key: 'resume' })
  w.rows = [actionRow({ status: 'running', metadata: {} })]
  await pane.press({ key: 'confirm' })
  await clock.settle()
  expect(w.argv.some(a => a[2] === 'resume')).toBe(false)
  expect(await texts(pane)).toContain('Resumed elsewhere')
  await pane.unmount()
})

test('an abandon raced by the run ending sends nothing', COLD, async ($, on) => {
  const { clock, w, pane } = await open($, on, [actionRow()], 'a')
  await pane.press({ key: 'abandon' })
  w.rows = [actionRow({ status: 'cancelled', completed_at: iso(NOW) })]
  await pane.press({ key: 'confirm' })
  await clock.settle()
  expect(w.argv.some(a => a[2] === 'abandon')).toBe(false)
  expect(await texts(pane)).toContain('Ended elsewhere')
  await pane.unmount()
})

test('a refused resume shows Archon\'s message', COLD, async ($, on) => {
  const { clock, w, pane } = await open($, on, [actionRow({ parent_conversation_id: 'conv-1' })], 'a')
  w.httpReply = (method, path) => (method === 'POST' && path === '/api/workflows/runs/a/resume' ? { status: 400, body: JSON.stringify({ error: "Cannot resume run with status 'running'." }) } : undefined)
  await pane.press({ key: 'resume' })
  await pane.press({ key: 'confirm' })
  await clock.settle()
  expect((await pane.find({ type: 'Text', text: "Cannot resume run with status 'running'." }))?.props.color).toBe('error')
  await pane.unmount()
})

test('a --detach resume the run has not moved on after 30 s says so', COLD, async ($, on) => {
  const { clock, pane } = await open($, on, [actionRow()], 'a')
  await pane.press({ key: 'resume' })
  await pane.press({ key: 'confirm' })
  await clock.settle()
  await clock.advance(30_000)
  expect((await texts(pane)).some(t => t.startsWith("Archon accepted the resume but the run hasn't moved"))).toBe(true)
  expect(await buttons(pane)).toEqual(["resume=r  Resume: I've done it", 'abandon=x  Abandon run'])
  await pane.unmount()
})

// ---------- /archon ----------

test('/archon opens Log on the run that has needed you longest, a sub-run\'s gate counted like any other', COLD, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const w = world({
    rows: [
      gated('newer', { waitingSince: iso(NOW - MINUTE) }),
      row('p', { workflow_name: 'archon-ship', status: 'paused', metadata: { approval: onSubRun('c') } }),
      row('c', { workflow_name: 'archon-fix', parent_run_id: 'p', status: 'paused', metadata: { approval: approval({ waitingSince: iso(NOW - 9 * MINUTE) }) } }),
    ],
    disk: { ...THERE },
  })
  fake(on, w)
  await $.session.start(START)
  await clock.settle()
  w.panes = IN_FRONT()
  await $.command.run({ command: 'archon', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  await clock.settle()
  const pane = await $.ui.mount({ plugin: 'archon-panel', surface: 'terminal', component: 'Pane', requestId: 'archon', props: paneProps(100, 120) })
  expect((await pane.find({ key: 'tab-log' }))?.props.dimColor).toBe(false)
  expect((await pane.findAll({ type: 'Text' })).map(t => t.text)).toContain('archon-ship › sub-run archon-fix · c · waited 9m')
  await pane.unmount()
})

// ---------- keys the pane shares ----------

const holders = async (pane: Pane, hotkey: string) => (await pane.findAll({ type: 'Button' })).filter(b => b.props.hotkey === hotkey).map(b => b.key)

test('r reloads from the pinned row, but in a Resume view it is Resume\'s alone', COLD, async ($, on) => {
  const { pane } = await open($, on, [actionRow()], 'a')
  expect(await holders(pane, 'r')).toEqual(['resume'])
  await pane.press({ key: 'tab-runs' })
  expect(await holders(pane, 'r')).toEqual(['reload'])
  await pane.unmount()
})

test('a gate that declares reject but has no rework step still says a reject cancels the run', COLD, async ($, on) => {
  const { pane } = await open($, on, [gated('g', { decisions: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }] })], 'g')
  expect(await buttons(pane)).toEqual(['decide-approve=y: Approve', 'decide-reject=n: Reject (cancels the run)'])
  await pane.unmount()
})
