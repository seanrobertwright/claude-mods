import { expect, test } from 'claude-code/testing'

import { activityLine } from '../hooks/graph-view'
import { EMPTY_WINDOW, liveOf, take } from '../hooks/log'
import { msOf } from '../hooks/text'
import { MINUTE, T0 } from './fixtures/runs'
import { line } from './fixtures/transcripts'

const body = (id: string) => ({ execution: { path: `fix-cycle.${id}`, node: { id, kind: 'command' } } })

test('Archon\'s times read as UTC, SQLite\'s zoneless form included; anything else is 0', () => {
  expect(msOf('2026-10-11 15:09:34')).toBe(Date.UTC(2026, 9, 11, 15, 9, 34))
  expect(msOf('2026-10-11T15:09:34')).toBe(Date.UTC(2026, 9, 11, 15, 9, 34))
  expect(msOf('2026-10-11T15:09:28.000Z')).toBe(Date.UTC(2026, 9, 11, 15, 9, 28))
  expect(msOf('2026-10-11T11:09:28-04:00')).toBe(Date.UTC(2026, 9, 11, 15, 9, 28))
  expect(msOf(1234)).toBe(1234)
  expect(msOf('soon')).toBe(0)
  expect(msOf(undefined)).toBe(0)
  expect(msOf(Number.NaN)).toBe(0)
})

test('a loop\'s body node is named by its path, as the run\'s events name it, and each row keeps its time', () => {
  const win = take({ ...EMPTY_WINDOW, runId: 'r' }, [line('node_start', { step: 'fix', ...body('fix') }, 4)], 0, 0)
  expect(win.open).toEqual(['fix-cycle.fix'])
  expect(win.rows[0]).toMatchObject({ kind: 'start', text: '▶ fix-cycle.fix', nodes: ['fix-cycle.fix'], at: T0 + 4000 })
})

test('the live look of each node is its last marker; open nodes run, with when they started and the newest thing done', () => {
  const win = take({ ...EMPTY_WINDOW, runId: 'r' }, [
    line('node_start', { step: 'plan' }, 1),
    line('node_complete', { step: 'plan' }, 2),
    line('node_start', { step: 'lint' }, 3),
    line('node_skipped', { step: 'docs' }, 3),
    line('node_error', { step: 'lint', error: 'boom' }, 4),
    line('node_start', { step: 'fix', ...body('fix') }, 5),
    line('assistant', { content: 'Reading the failure.\nThen fixing it.' }, 6),
    line('tool', { tool_name: 'Bash', tool_input: { command: 'npm test' } }, 7),
  ], 0, 0)
  const live = liveOf(win)
  expect(Object.fromEntries(live.looks)).toEqual({ 'plan': 'completed', 'lint': 'failed', 'docs': 'skipped', 'fix-cycle.fix': 'running' })
  expect(live.running).toEqual([{ node: 'fix-cycle.fix', since: T0 + 5000 }])
  expect(live.latest).toEqual({ text: 'Bash npm test', at: T0 + 7000 })
})

test('a loop running its body is named by the body alone, and a tool row\'s fold mark is left off', () => {
  const live = liveOf(take({ ...EMPTY_WINDOW, runId: 'r' }, [
    line('node_start', { step: 'fix-cycle', execution: { path: 'fix-cycle' } }, 1),
    line('node_start', { step: 'fix', ...body('fix') }, 2),
    line('tool', { tool_name: 'Bash', tool_input: { command: 'npm test\nnpm run lint' } }, 3),
  ], 0, 0))
  expect(live.looks.get('fix-cycle')).toBe('running')
  expect(live.running.map(r => r.node)).toEqual(['fix-cycle.fix'])
  expect(live.latest?.text).toBe('Bash npm test')
})

test('the activity line names what runs, for how long, and the newest thing it did', () => {
  const live = liveOf(take({ ...EMPTY_WINDOW, runId: 'r' }, [
    line('assistant', { content: 'Before.' }, 1),
    line('node_start', { step: 'build' }, 60),
  ], 0, 0))
  // Text written before the newest start is not what runs now.
  expect(activityLine(live, [], T0 + 3 * MINUTE)).toBe('build 2m')
  const busy = liveOf(take({ ...EMPTY_WINDOW, runId: 'r' }, [
    line('node_start', { step: 'build' }, 60),
    line('tool', { tool_name: 'Read', tool_input: { file_path: 'src/app.ts' } }, 170),
  ], 0, 0))
  expect(activityLine(busy, [], T0 + 3 * MINUTE)).toBe('build 2m · Read src/app.ts · 10s ago')
  expect(activityLine(liveOf({ ...EMPTY_WINDOW, runId: 'r' }), [], T0)).toBeUndefined()
  expect(activityLine(undefined, [], T0)).toBeUndefined()
})

test('a start that dropped off the window is timed from the run\'s events', () => {
  const live = { looks: new Map(), running: [{ node: 'build', since: 0 }], latest: undefined }
  const events = [{ type: 'node_started', step: 'build', at: T0, output: '', error: '', iteration: 0, decision: '', text: '', reason: '', durationMs: 0, costUsd: 0 }]
  expect(activityLine(live, events, T0 + 90 * MINUTE)).toBe('build 1h 30m')
  expect(activityLine(live, [], T0 + 90 * MINUTE)).toBe('build')
})
