import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fit, isLive, parseConfig, parseNodes, parseRuns, runTime, stateOf } from '../hooks/parse'

const RUNS = JSON.stringify({
  runs: [
    { id: 'run-live', workflow_name: 'archon-plan', status: 'running', user_message: 'Plan the thing', started_at: '2026-10-07T20:00:00.000Z', completed_at: null },
    { id: 'run-done', workflow_name: 'archon-assist', status: 'completed', user_message: 'Old\nrequest', started_at: '2026-10-07T19:00:00.000Z', completed_at: '2026-10-07T19:00:30.000Z' },
    { status: 'running', workflow_name: 'no id, dropped' },
  ],
})

const node = (type: string, id: string) => JSON.stringify({ type, step: id, execution: { node: { id } } })
const TRANSCRIPT = [
  JSON.stringify({ type: 'workflow_start', workflow_name: 'archon-plan' }),
  node('node_start', 'research'),
  JSON.stringify({ type: 'assistant', content: 'hello' }),
  node('node_complete', 'research'),
  node('node_start', 'write'),
  'not json at all',
].join('\n')

const PANE = {
  title: 'Archon',
  isFocused: false,
  bodyColumns: 50,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

function ok(stdout: string) {
  return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
}

/** The Archon CLI beneath the mod: answers the runs list and each run's transcript, and records every argv. */
function fakeArchon(on: On, runs: (readonly string[])[]): void {
  on('process.run', (_$, e) => {
    runs.push(e.argv)
    const [, noun, verb] = e.argv
    if (noun === 'workflow' && verb === 'runs') return ok(RUNS)
    if (noun === 'workflow' && verb === 'logs') return ok(TRANSCRIPT)
    return ok('')
  })
}

test('parseRuns reads the runs list and drops rows without an id', () => {
  const runs = parseRuns(RUNS)
  expect(runs.map(run => [run.id, run.state])).toEqual([['run-live', 'running'], ['run-done', 'completed']])
  expect(runs[1]?.message).toBe('Old request')
  expect(runTime(runs[1]!, 0)).toBe('30s')
  expect(isLive(runs[0]!)).toBe(true)
  expect(() => parseRuns('[]')).toThrow()
})

test('parseNodes folds node events in start order and skips noise', () => {
  expect(parseNodes(TRANSCRIPT)).toEqual([
    { id: 'research', state: 'completed' },
    { id: 'write', state: 'running' },
  ])
  expect(parseNodes(`${TRANSCRIPT}\n${node('node_failed', 'write')}`)[1]).toEqual({ id: 'write', state: 'failed' })
})

test('stateOf, parseConfig and fit hold their bounds', () => {
  expect(stateOf('Running')).toBe('running')
  expect(stateOf('weird')).toBe('other')
  expect(parseConfig({ limit: 0, refreshSeconds: 1, archonPath: ' ' })).toEqual({ archon: 'archon', limit: 10, refreshMs: 5000 })
  expect(parseConfig({ limit: 50, refreshSeconds: 0, archonPath: 'C:\\a\\archon.exe' })).toEqual({ archon: 'C:\\a\\archon.exe', limit: 50, refreshMs: 0 })
  expect(fit('a long workflow', 8)).toBe('a long …')
})

test('the pane lists runs and shows the nodes of a live one', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-07T20:01:00.000Z') })
  on('ui.toast', () => ({ value: undefined }))
  const argvs: (readonly string[])[] = []
  fakeArchon(on, argvs)

  const pane = await $.ui.mount({ plugin: 'archon-panel', surface: 'terminal', component: 'Pane', requestId: 'archon', props: PANE })
  await pane.press({ key: 'refresh' })
  expect(await pane.find({ type: 'Text', text: 'Archon · 1 running' })).toBeDefined()
  expect((await pane.find({ key: 'run-run-live' }))?.text).toContain('archon-plan')
  expect(await pane.find({ type: 'Text', text: /✓ research/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /● write/ })).toBeDefined()
  expect(argvs.some(argv => argv.includes('--json'))).toBe(true)
  await pane.unmount()
})
