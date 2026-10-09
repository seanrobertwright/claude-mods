import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { openPane, ROOT, script, startSession, world } from './world'

const URL_LINE = { text: '  ➜  Local:   http://localhost:5173/\n' }
const NOW = new Date(2026, 9, 9, 14, 0).getTime()
const KEY = `running:${ROOT}:dev`

function peerEntry(refreshedAt: number) {
  return { sessionId: 'session-b', name: 'dev', command: 'npm run dev', port: 5173, url: 'http://localhost:5173', refreshedAt }
}

/** The engine's own composition beneath the mod: one shared section and one session section. */
function engineSections(on: On): void {
  on('prompt.compose', () => ({
    sections: [
      { id: 'intro', text: 'You are Claude Code.', scope: 'shared' },
      { id: 'env', text: 'Working directory: /work/app', scope: 'session' },
    ],
  }) as never)
}

async function compose($: Engine, surfaces: string[] = ['terminal']) {
  const composed = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces, tools: [], outputStyle: null, traits: [] } as never)
  return composed.sections.find(section => section.id === 'dev-server-manager:servers')
}

test('a running server is recorded in the shared store, refreshed every 30 s, and cleared on stop', async ($, on) => {
  const w = world(on)
  script(w, 'npm run dev', { pieces: [URL_LINE] })
  await startSession($)
  const pane = await openPane($)
  await pane.press({ key: 'row-dev' })
  await pane.press({ key: 'start' })
  await w.clock.settle()
  expect(w.store.get(KEY)).toEqual({ sessionId: 'session-a', name: 'dev', command: 'npm run dev', port: 5173, url: 'http://localhost:5173', refreshedAt: NOW })
  await w.clock.advance(30_000)
  expect(w.store.get(KEY)).toMatchObject({ refreshedAt: NOW + 30_000 })
  await pane.press({ key: 'stop' })
  expect(w.store.has(KEY)).toBe(false)
})

test('another session server shows read-only, with its URL and no buttons, and Claude cannot restart it', async ($, on) => {
  const w = world(on, { store: { [KEY]: peerEntry(NOW - 10_000) } })
  on('tool.check', () => ({ decision: 'allow' }))
  await startSession($)
  const pane = await openPane($)
  expect((await pane.find({ key: 'words-dev' }))?.text).toBe('running in another session · :5173')
  await pane.press({ key: 'row-dev' })
  expect((await pane.find({ type: 'Link' }))?.props).toMatchObject({ href: 'http://localhost:5173', label: 'localhost:5173' })
  expect((await pane.findAll({ type: 'Button' })).map(button => button.key)).toEqual(['row-dev'])
  const refused = await $.tool.call({ tool: 'mcp__dev-server-manager__restart', server: 'dev' } as never)
  expect(refused.deny).toBe("dev runs in another session; restart it from that session's dev-servers pane.")
  expect(w.spawned).toEqual([])
})

test('an entry not refreshed for 90 s is stale: the row falls back to stopped', async ($, on) => {
  const w = world(on, { store: { [KEY]: peerEntry(NOW - 70_000) } })
  await startSession($)
  const pane = await openPane($)
  expect((await pane.find({ key: 'words-dev' }))?.text).toBe('running in another session · :5173')
  await w.clock.advance(30_000)
  expect((await pane.find({ key: 'words-dev' }))?.text).toBe('stopped')
  await pane.press({ key: 'row-dev' })
  expect(await pane.find({ key: 'start' })).toBeDefined()
})

test('prompt.compose lists what runs, here and in another session, and names the two tools', async ($, on) => {
  const w = world(on, { packageJson: JSON.stringify({ scripts: { dev: 'vite', preview: 'vite preview' } }) })
  engineSections(on)
  await startSession($)
  expect(await compose($)).toBeUndefined()
  w.store.set(`running:${ROOT}:docs`, { ...peerEntry(NOW), name: 'docs', command: 'mkdocs serve', port: 8001, url: 'http://127.0.0.1:8001' })
  script(w, 'npm run dev', { pieces: [URL_LINE] })
  const pane = await openPane($)
  await pane.press({ key: 'row-dev' })
  await pane.press({ key: 'start' })
  await w.clock.settle()
  const section = await compose($)
  expect(section?.scope).toBe('session')
  expect(section?.text).toBe([
    'Dev servers: the dev-servers pane started these, so do not start another copy of one.',
    '- dev: npm run dev, http://localhost:5173, running',
    '- docs: mkdocs serve, http://127.0.0.1:8001, running in another session',
    'Read a server output with mcp__dev-server-manager__output; restart one with mcp__dev-server-manager__restart.',
  ].join('\n'))
  expect(await compose($, [])).toBeUndefined()
})

test('after /clear gives the session another id, its own servers are still its own', async ($, on) => {
  const w = world(on)
  script(w, 'npm run dev', { pieces: [URL_LINE] })
  await startSession($)
  const pane = await openPane($)
  await pane.press({ key: 'row-dev' })
  await pane.press({ key: 'start' })
  await w.clock.settle()
  await $.session.end({ reason: 'clear', sessionId: 'session-a', resume: { id: 'session-a' } } as never)
  w.sessionId = 'session-c'
  await w.clock.advance(1_000)
  await pane.press({ key: 'stop' })
  await w.clock.advance(30_000)
  expect(w.store.has(KEY)).toBe(false)
  expect((await pane.find({ key: 'words-dev' }))?.text).toBe('stopped')
})

const PEER_WORDS = 'running in another session · :5173'

test('a headless attach starts no ticker, and a shown one does', async ($, on) => {
  const w = world(on, { surfaces: [] })
  await startSession($)
  await $.session.attach({ surface: 'terminal', clientId: 'terminal:default' } as never)
  // Another session's fresh entry: only a tick of the 30 s refresh makes the pane read it.
  w.store.set(KEY, peerEntry(NOW))
  await w.clock.advance(30_000)
  w.surfaces.push('terminal')
  const pane = await openPane($)
  expect((await pane.find({ key: 'words-dev' }))?.text).toBe('stopped')
  await $.session.attach({ surface: 'terminal', clientId: 'terminal:other' } as never)
  await w.clock.advance(30_000)
  await pane.redraw()
  expect((await pane.find({ key: 'words-dev' }))?.text).toBe(PEER_WORDS)
})

for (const [reason, words] of [['logout', 'stopped'], ['clear', PEER_WORDS]] as const) {
  test(`a session end for ${reason} ${reason === 'clear' ? 'keeps' : 'cancels'} the ticker`, async ($, on) => {
    const w = world(on)
    await startSession($)
    await $.session.end({ reason, sessionId: 'session-a', resume: { id: 'session-a' } } as never)
    w.store.set(KEY, peerEntry(NOW))
    await w.clock.advance(30_000)
    expect((await (await openPane($)).find({ key: 'words-dev' }))?.text).toBe(words)
  })
}
