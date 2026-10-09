import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { openPane, ROOT, script, startSession, world } from './world'

const OUTPUT = 'mcp__dev-server-manager__output'
const RESTART = 'mcp__dev-server-manager__restart'
const URL_LINE = { text: '  ➜  Local:   http://localhost:5173/\n' }
const TWO = JSON.stringify({ scripts: { dev: 'vite', preview: 'vite preview' } })

type Pane = Awaited<ReturnType<typeof openPane>>

/** Picks a row in the pane, mounted once per test, and presses start. */
async function startRow($: Engine, name: string, mounted?: Pane): Promise<Pane> {
  const pane = mounted ?? (await openPane($, 90))
  await pane.press({ key: `row-${name}` })
  await pane.press({ key: 'start' })
  return pane
}

async function call($: Engine, tool: string, input: Record<string, unknown> = {}) {
  return $.tool.call({ tool, ...input } as never)
}

/** The permission check beneath the mod: what the engine decides for a tool no hook of the mod's answers. */
function allow(on: Parameters<typeof world>[0], decision: 'allow' | 'ask' = 'allow') {
  on('tool.check', () => ({ decision }))
}

test('the tools are registered the first time a server runs, deferred, and again at every bring-up', async ($, on) => {
  const w = world(on)
  script(w, 'npm run dev', { pieces: [URL_LINE] }, { pieces: [URL_LINE] })
  await startSession($)
  expect(w.tools).toEqual([])
  const pane = await startRow($, 'dev')
  await w.clock.settle()
  expect(w.tools).toEqual(['output', 'restart'])
  expect(w.toolSpecs.every(spec => spec.isDeferred === true)).toBe(true)
  await pane.press({ key: 'restart' })
  await w.clock.settle()
  expect(w.tools).toEqual(['output', 'restart', 'output', 'restart'])
})

test('a registration that fails is a dim line in the server output, and the server runs on', async ($, on) => {
  const w = world(on)
  w.isToolRegisterRefused = true
  script(w, 'npm run dev', { pieces: [URL_LINE] })
  await startSession($)
  const pane = await startRow($, 'dev')
  await w.clock.advance(1_000)
  const note = (await pane.findAll({ type: 'Text' })).find(found => found.text.startsWith('could not offer Claude'))
  expect(note?.props.dimColor).toBe(true)
  expect((await pane.find({ key: 'words-dev' }))?.text).toBe('up 1s')
})

test('output reads the one running server: a header, then the current run since its divider', async ($, on) => {
  const w = world(on)
  allow(on)
  const lines = Array.from({ length: 150 }, (_, n) => ({ text: `line ${n}\n` }))
  script(w, 'npm run dev', { pieces: [URL_LINE, { text: 'old run\n' }], exit: { code: 3, signal: null }, exitAfterMs: 1_000 }, { pieces: [URL_LINE, ...lines] })
  await startSession($)
  await startRow($, 'dev')
  await w.clock.advance(1_000)
  const answer = await call($, OUTPUT)
  const text = String(answer.result)
  expect(text).toStartWith('Server: dev\nCommand: npm run dev\nState: running\nURL: http://localhost:5173\nLast exit code: 3\n')
  expect(text).toContain('Output, the last 100 lines of the current run:\n')
  expect(text).not.toContain('old run')
  expect(text.trimEnd().split('\n').slice(-100)[0]).toBe('line 50')
  expect(text.trimEnd()).toEndWith('line 149')

  const fewer = String((await call($, OUTPUT, { server: 'dev', lines: 3 })).result)
  expect(fewer.trimEnd().split('\n').slice(-3)).toEqual(['line 147', 'line 148', 'line 149'])
  const most = String((await call($, OUTPUT, { server: 'dev', lines: 9_000 })).result)
  expect(most).toContain('Output, the last 151 lines of the current run:\n')
})

test('output with several servers running lists their names; an unknown name errors with the known ones', async ($, on) => {
  world(on, { packageJson: TWO })
  allow(on)
  await startSession($)
  const pane = await startRow($, 'dev')
  await startRow($, 'preview', pane)
  const several = await call($, OUTPUT)
  expect(String(several.result)).toBe('Several dev servers run: dev, preview. Call again with server set to one of them.')
  const unknown = await call($, OUTPUT, { server: 'api' })
  expect(unknown.deny).toBe('No dev server is named api. The servers are: dev, preview.')
})

test('output reads in a headless session too', async ($, on) => {
  const w = world(on)
  allow(on)
  script(w, 'npm run dev', { pieces: [URL_LINE, { text: 'hello\n' }] })
  await startSession($)
  await startRow($, 'dev')
  w.surfaces.splice(0)
  expect(String((await call($, OUTPUT, { server: 'dev' })).result)).toContain('hello')
})

test('output is allowed without asking; restart goes through the normal permission check', async ($, on) => {
  world(on)
  allow(on, 'ask')
  await startSession($)
  expect((await $.tool.check({ tool: OUTPUT, input: {} })).decision).toBe('allow')
  expect((await $.tool.check({ tool: RESTART, input: { server: 'dev' } })).decision).toBe('ask')
})

test('restart by Claude waits for the URL, returns the new run, toasts, and counts as handling it', async ($, on) => {
  const w = world(on)
  allow(on)
  script(w, 'npm run dev', { pieces: [URL_LINE, { stream: 'stderr', text: 'Error: boom\n', afterMs: 1_000 }], exit: { code: 3, signal: null } }, { pieces: [URL_LINE] }, {
    pieces: [{ text: 'compiling\n', afterMs: 2_000 }, URL_LINE],
  })
  await startSession($)
  const pane = await startRow($, 'dev')
  await w.clock.advance(1_000)
  expect(await pane.find({ key: 'error' })).toBeDefined()

  const answer = call($, RESTART, { server: 'dev' })
  await w.clock.advance(2_000)
  const text = String((await answer).result)
  expect(text).toStartWith('Server: dev\nCommand: npm run dev\nState: running\n')
  expect(text).toContain('compiling')
  expect(w.toasts.map(toast => `${toast.text} [${toast.timeoutMs ?? 4000}]`)).toContain('dev restarted by Claude [4000]')
  expect(await pane.find({ key: 'error' })).toBeUndefined()
  expect((await pane.find({ key: 'words-dev' }))?.text).toBe('up 2s')
  await w.clock.advance(1_000)
  expect((await pane.findAll({ type: 'Text' })).map(found => found.text)).toContain('── restarted by Claude 14:00 ──')
})

test('restart by Claude brings a crashed server back, and gives up waiting after 30 s', { options: { restart: false } }, async ($, on) => {
  const w = world(on)
  allow(on)
  script(w, 'npm run dev', { pieces: [URL_LINE], exit: { code: 1, signal: null }, exitAfterMs: 1_000 }, { pieces: [{ text: 'still thinking\n' }] })
  await startSession($)
  await startRow($, 'dev')
  await w.clock.advance(1_000)
  const answer = call($, RESTART, { server: 'dev' })
  await w.clock.advance(30_000)
  const text = String((await answer).result)
  expect(text).toStartWith('Server: dev\nCommand: npm run dev\nState: starting\n')
  expect(w.spawned).toHaveLength(2)
})

test('restart by Claude refuses a stopped or exited server, and a headless session', async ($, on) => {
  const w = world(on, { packageJson: TWO })
  allow(on)
  script(w, 'npm run preview', { pieces: [URL_LINE], exit: { code: 0, signal: null } })
  await startSession($)
  expect((await call($, RESTART, { server: 'dev' })).deny).toBe('dev is stopped: start it from the dev-servers pane.')
  const pane = await startRow($, 'preview')
  await w.clock.settle()
  expect((await call($, RESTART, { server: 'preview' })).deny).toBe('preview exited: start it from the dev-servers pane.')
  await startRow($, 'dev', pane)
  w.surfaces.splice(0)
  expect((await call($, RESTART, { server: 'dev' })).deny).toBe('Restart is not available in a headless session.')
  expect(w.spawned).toHaveLength(2)
})

test('restart by Claude resets the automatic restart count', async ($, on) => {
  const w = world(on)
  allow(on)
  const dies = { pieces: [URL_LINE, { stream: 'stderr' as const, text: 'Error: boom\n', afterMs: 1_000 }], exit: { code: 3, signal: null } }
  script(w, 'npm run dev', dies, dies, { pieces: [URL_LINE] }, dies, {})
  await startSession($)
  await startRow($, 'dev')
  await w.clock.advance(1_000)
  await w.clock.advance(1_000)
  expect(w.toasts.map(toast => toast.text)).toEqual(['✗ dev crashed (exit 3), restarting (1/3)', '✗ dev crashed (exit 3), restarting (2/3)'])
  const answer = call($, RESTART, { server: 'dev' })
  await w.clock.settle()
  await answer
  await w.clock.advance(1_000)
  expect(w.toasts.map(toast => toast.text).slice(-1)).toEqual(['✗ dev crashed (exit 3), restarting (1/3)'])
})

test('restart by Claude that cannot spawn answers the row state and words, with no toast', async ($, on) => {
  const w = world(on, { store: { [`ports:${ROOT}`]: { dev: 5173 } } })
  allow(on)
  w.runs.set('netstat -ano', [{ stdout: '' }, { stdout: '  TCP    0.0.0.0:5173    0.0.0.0:0    LISTENING    5100\n' }])
  w.runs.set('tasklist /FI PID eq 5100 /FO CSV /NH', { stdout: '"python.exe","5100","Console","1","9,000 K"\r\n' })
  script(w, 'npm run dev', { pieces: [URL_LINE] }, { pieces: [URL_LINE] })
  await startSession($)
  await startRow($, 'dev')
  await w.clock.settle()
  const answer = call($, RESTART, { server: 'dev' })
  await w.clock.advance(3_500)
  expect((await answer).deny).toBe('dev did not restart (port taken): :5173 taken by python.exe 5100')
  expect(w.toasts).toEqual([])
  expect(w.spawned).toHaveLength(1)
})
