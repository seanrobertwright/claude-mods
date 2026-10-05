import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

import { length, parseConfig, windowsPlayer } from '../hooks/chime'

const MINUTE = 60_000
const QUESTION = { questions: [{ question: 'Which one?', header: 'Pick', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }], multiSelect: false }] }

/** What the person would hear and see: sounds the engine played, processes started, toasts shown. */
type Heard = { clips: string[]; runs: (readonly string[])[]; toasts: string[] }

/** The engine beneath the mod, on the given surfaces and operating system. */
function engineBeneath(on: On, { surfaces = ['terminal'], os = '' }: { surfaces?: readonly RenderSurface[]; os?: string } = {}) {
  const heard: Heard = { clips: [], runs: [], toasts: [] }
  const clock = mock.clock(on, { now: 1_000 })
  mock.env(on, os === '' ? {} : { OS: os })
  on('session.surfaces', () => ({ value: surfaces }))
  on('ui.toast', (_$, e) => {
    heard.toasts.push(e.text)
    return { value: undefined }
  })
  on('audio.play', (_$, e) => {
    heard.clips.push(e.clip.asset ?? '')
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    heard.runs.push(e.argv)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => ({ result: { questions: e.questions, answers: {} } }))
  return { heard, clock }
}

function ended(durationMs: number, turnId = 't1') {
  return { answer: 'Done.', durationMs, isAborted: false, turnId, reason: 'answer' } as const
}

test('parseConfig reads the threshold in minutes and falls back to three', () => {
  expect(parseConfig({ thresholdMinutes: 10 })).toEqual({ thresholdMs: 10 * MINUTE })
  expect(parseConfig({ thresholdMinutes: 0.5 })).toEqual({ thresholdMs: 30_000 })
  expect(parseConfig({})).toEqual({ thresholdMs: 3 * MINUTE })
  expect(parseConfig({ thresholdMinutes: 0 })).toEqual({ thresholdMs: 3 * MINUTE })
  expect(parseConfig({ thresholdMinutes: 'soon' })).toEqual({ thresholdMs: 3 * MINUTE })
})

test('length says seconds, minutes and hours as a person would', () => {
  expect(length(45_400)).toBe('45s')
  expect(length(252_000)).toBe('4m 12s')
  expect(length(66 * MINUTE + 20_000)).toBe('1h 6m')
})

test('windowsPlayer plays the sound under the mod folder, quoting a folder with an apostrophe', () => {
  const argv = windowsPlayer("C:\\Mods\\Sam's\\turn-chime\\")
  expect(argv[0]).toBe('powershell')
  expect(argv[argv.length - 1]).toBe("(New-Object System.Media.SoundPlayer 'C:\\Mods\\Sam''s\\turn-chime\\sounds\\chime.wav').PlaySync()")
})

test('a turn longer than the threshold ends with one sound and one toast naming its length', async ($, on) => {
  const { heard } = engineBeneath(on)
  await $.turn.complete(ended(4 * MINUTE + 12_000))
  expect(heard.clips).toEqual(['sounds/chime.wav'])
  expect(heard.toasts).toEqual(['Turn finished after 4m 12s.'])
  expect(heard.runs).toEqual([])
})

test('on Windows the sound is played by a process, since the engine plays none there', async ($, on) => {
  const { heard } = engineBeneath(on, { os: 'Windows_NT' })
  await $.turn.complete(ended(5 * MINUTE))
  expect(heard.clips).toEqual([])
  expect(heard.runs.length).toBe(1)
  expect(heard.runs[0]?.[0]).toBe('powershell')
  expect(heard.runs[0]?.[heard.runs[0].length - 1]).toContain('chime.wav')
  expect(heard.toasts).toEqual(['Turn finished after 5m 0s.'])
})

test('a shorter turn, a stopped one and a subagent turn end with neither', async ($, on) => {
  const { heard } = engineBeneath(on)
  await $.turn.complete(ended(2 * MINUTE))
  await $.turn.complete({ ...ended(9 * MINUTE), isAborted: true, reason: 'aborted' })
  await $.turn.complete({ ...ended(9 * MINUTE), agentId: 'agent-1' })
  expect(heard.clips).toEqual([])
  expect(heard.toasts).toEqual([])
})

test('a question asked after the threshold plays the sound once, and the turn end still chimes', async ($, on) => {
  const { heard, clock } = engineBeneath(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(MINUTE)
  await $.tool.call({ tool: 'AskUserQuestion', ...QUESTION })
  expect(heard.clips).toEqual([])

  await clock.advance(3 * MINUTE)
  await $.tool.call({ tool: 'AskUserQuestion', ...QUESTION })
  await $.tool.call({ tool: 'AskUserQuestion', ...QUESTION })
  expect(heard.clips.length).toBe(1)
  expect(heard.toasts).toEqual(['Claude needs an answer, 4m 0s into the turn.'])

  await $.turn.complete(ended(6 * MINUTE))
  expect(heard.clips.length).toBe(2)
  expect(heard.toasts[1]).toBe('Turn finished after 6m 0s.')
})

test('a subagent starting its own turn mid-turn does not restart the count', async ($, on) => {
  const { heard, clock } = engineBeneath(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(4 * MINUTE)
  await $.turn.start({ text: 'look this up', turnId: 'sub-1' })
  await clock.advance(1_000)
  await $.tool.call({ tool: 'AskUserQuestion', ...QUESTION })
  expect(heard.toasts).toEqual(['Claude needs an answer, 4m 1s into the turn.'])
})

test('changing the option changes the threshold', { options: { thresholdMinutes: 10 } }, async ($, on) => {
  const { heard } = engineBeneath(on)
  await $.turn.complete(ended(9 * MINUTE))
  expect(heard.toasts).toEqual([])
  await $.turn.complete(ended(10 * MINUTE, 't2'))
  expect(heard.toasts).toEqual(['Turn finished after 10m 0s.'])
  expect(heard.clips.length).toBe(1)
})

test('in a headless session a long turn and a late question play nothing, show nothing and start nothing', async ($, on) => {
  const { heard, clock } = engineBeneath(on, { surfaces: [], os: 'Windows_NT' })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(5 * MINUTE)
  await $.tool.call({ tool: 'AskUserQuestion', ...QUESTION })
  await $.turn.complete(ended(5 * MINUTE))
  expect(heard).toEqual({ clips: [], runs: [], toasts: [] })
})
