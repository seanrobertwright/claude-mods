import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { openPane, script, startSession, world } from './world'
import type { Child, World } from './world'

const URL_LINE = { text: '  ➜  Local:   http://localhost:5173/\n' }
const STACK = { stream: 'stderr' as const, text: "Error: Cannot find module './jobs'\n    at main.js:3:9\n" }

/** A child that serves, prints a stack after `afterMs` and exits with `code`. */
function crashing(afterMs: number, code = 3): Child {
  return { pieces: [URL_LINE, { ...STACK, afterMs }], exit: { code, signal: null } }
}

async function startDev($: Engine) {
  const pane = await openPane($, 90)
  await pane.press({ key: 'row-dev' })
  await pane.press({ key: 'start' })
  return pane
}

async function textColor(pane: Awaited<ReturnType<typeof startDev>>, text: string) {
  return (await pane.findAll({ type: 'Text' })).find(found => found.text === text)?.props.color
}

function toastTexts(w: World): string[] {
  return w.toasts.map(toast => `${toast.text} [${toast.timeoutMs ?? 4000}]`)
}

test('a crash toasts and restarts (1/3); the running row keeps a note and the error button', async ($, on) => {
  const w = world(on)
  script(w, 'npm run dev', crashing(60_000), { pieces: [URL_LINE] })
  await startSession($)
  const pane = await startDev($)
  await w.clock.advance(60_000)
  expect(toastTexts(w)).toEqual(['✗ dev crashed (exit 3), restarting (1/3) [8000]'])
  expect(w.spawned).toHaveLength(2)
  expect((await pane.find({ key: 'words-dev' }))?.text).toBe('crashed 14:01, restarted (1/3)')
  expect(await textColor(pane, 'crashed 14:01, restarted (1/3)')).toBe('warning')
  expect((await pane.findAll({ type: 'Button' })).map(button => button.key)).toEqual(['row-dev', 'stop', 'restart', 'error', 'hide'].filter(key => key !== 'hide'))
  await w.clock.advance(1_000)
  const texts = await pane.findAll({ type: 'Text' })
  expect(texts.map(found => found.text)).toContain('── crashed (exit 3) · restarted 14:01 ──')
  expect(texts.find(found => found.text === "Error: Cannot find module './jobs'")?.props.color).toBe('error')
})

test('the restart cap: 3 in 2 minutes, then the row stays crashed and gives up', async ($, on) => {
  const w = world(on)
  script(w, 'npm run dev', crashing(10_000), crashing(10_000), crashing(10_000), crashing(10_000))
  await startSession($)
  const pane = await startDev($)
  for (let n = 0; n < 4; n += 1) await w.clock.advance(10_000)
  expect(w.spawned).toHaveLength(4)
  expect(w.toasts.map(toast => toast.text)).toEqual([
    '✗ dev crashed (exit 3), restarting (1/3)',
    '✗ dev crashed (exit 3), restarting (2/3)',
    '✗ dev crashed (exit 3), restarting (3/3)',
    '✗ dev crashed (exit 3)',
  ])
  const words = "crashed 4× since 14:00, gave up · Error: Cannot find module './jobs'"
  expect((await pane.find({ key: 'words-dev' }))?.text).toBe(words)
  expect(await textColor(pane, words)).toBe('error')
  expect((await pane.findAll({ type: 'Button' })).map(button => button.key)).toEqual(['row-dev', 'start', 'error', 'hide'])
})

test('crashes spread past the 2-minute window keep restarting', async ($, on) => {
  const w = world(on)
  script(w, 'npm run dev', crashing(50_000), crashing(50_000), crashing(50_000), crashing(50_000), {})
  await startSession($)
  await startDev($)
  for (let n = 0; n < 4; n += 1) await w.clock.advance(50_000)
  expect(w.spawned).toHaveLength(5)
  expect(w.toasts[3]?.text).toBe('✗ dev crashed (exit 3), restarting (3/3)')
})

test('with restart off a death toasts and stays crashed with its error', { options: { restart: false } }, async ($, on) => {
  const w = world(on)
  script(w, 'npm run dev', crashing(1_000, 1))
  await startSession($)
  const pane = await startDev($)
  await w.clock.advance(1_000)
  expect(w.spawned).toHaveLength(1)
  expect(w.toasts.map(toast => toast.text)).toEqual(['✗ dev crashed (exit 1)'])
  expect((await pane.find({ key: 'words-dev' }))?.text).toBe("crashed (exit 1) · Error: Cannot find module './jobs'")
  expect((await pane.find({ key: 'error-head' }))?.text).toBe("Error: Cannot find module './jobs'")
})

test('a clean exit is a dim exited row: no toast, no restart, no error button', async ($, on) => {
  const w = world(on)
  script(w, 'npm run dev', { pieces: [URL_LINE], exit: { code: 0, signal: null }, exitAfterMs: 120_000 })
  await startSession($)
  const pane = await startDev($)
  await w.clock.advance(120_000)
  expect(w.toasts).toEqual([])
  expect(w.spawned).toHaveLength(1)
  expect((await pane.find({ key: 'words-dev' }))?.text).toBe('exited 14:02')
  expect(await textColor(pane, 'exited 14:02')).toBeUndefined()
  expect((await pane.findAll({ type: 'Text' })).find(found => found.text === 'exited 14:02')?.props.dimColor).toBe(true)
  expect(await pane.find({ key: 'error' })).toBeUndefined()
})

test('an outside kill on Windows reads as exit 1 and counts as a crash', async ($, on) => {
  const w = world(on)
  script(w, 'npm run dev', { pieces: [URL_LINE], exit: { code: 1, signal: null }, exitAfterMs: 5_000 }, {})
  await startSession($)
  await startDev($)
  await w.clock.advance(5_000)
  expect(w.toasts.map(toast => toast.text)).toEqual(['✗ dev crashed (exit 1), restarting (1/3)'])
  expect(w.spawned).toHaveLength(2)
})

test('a signal the mod did not send is a death', async ($, on) => {
  const w = world(on, { os: '' })
  script(w, 'npm run dev', { pieces: [URL_LINE], exit: { code: null, signal: 'SIGKILL' }, exitAfterMs: 5_000 }, {})
  await startSession($)
  await startDev($)
  await w.clock.advance(5_000)
  expect(w.toasts.map(toast => toast.text)).toEqual(['✗ dev crashed (signal SIGKILL), restarting (1/3)'])
})

test('in a headless session a death neither restarts nor toasts', async ($, on) => {
  const w = world(on)
  script(w, 'npm run dev', crashing(5_000))
  await startSession($)
  const pane = await startDev($)
  w.surfaces.splice(0)
  await w.clock.advance(5_000)
  expect(w.toasts).toEqual([])
  expect(w.spawned).toHaveLength(1)
  expect((await pane.find({ key: 'words-dev' }))?.text).toBe("crashed (exit 3) · Error: Cannot find module './jobs'")
})

test('several deaths in one tick are one toast', async ($, on) => {
  const w = world(on, { packageJson: JSON.stringify({ scripts: { dev: 'vite', preview: 'vite preview' } }) })
  script(w, 'npm run dev', crashing(5_000), {})
  script(w, 'npm run preview', crashing(5_000, 1), {})
  await startSession($)
  const pane = await openPane($)
  for (const name of ['dev', 'preview']) {
    await pane.press({ key: `row-${name}` })
    await pane.press({ key: 'start' })
  }
  await w.clock.advance(5_000)
  expect(w.toasts.map(toast => toast.text)).toEqual(['✗ dev crashed (exit 3), restarting (1/3) · ✗ preview crashed (exit 1), restarting (1/3)'])
})

test('a fresh module after a reload starts each server the old one ran, restarted after reload', async ($, on) => {
  const w = world(on)
  let isFirst = true
  // The state the old module left: dev was running when the reload killed it.
  on('state.get', (_$, e, next) => {
    if (e.key !== 'runs' || !isFirst) return next(e)
    isFirst = false
    const running = { status: 'running', url: 'http://localhost:5173', startedAt: 1, endedAt: 0, movedFrom: 0, isAfterReload: false, problem: '', holder: '', crashes: [], restarts: [], isGaveUp: false, death: null, hasNote: false, lastExit: null }
    return { value: { value: { dev: running }, version: 0 } } as never
  })
  script(w, 'npm run dev', { pieces: [URL_LINE] })
  await startSession($)
  await w.clock.settle()
  expect(w.spawned).toHaveLength(1)
  const pane = await openPane($)
  expect((await pane.find({ key: 'words-dev' }))?.text).toBe('up 0s · restarted after reload')
  await pane.press({ key: 'row-dev' })
  expect((await pane.findAll({ type: 'Text' })).map(found => found.text)).toContain('── restarted after reload 14:00 ──')
})
