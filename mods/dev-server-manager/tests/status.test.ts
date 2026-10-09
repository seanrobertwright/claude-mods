import { expect, test } from 'claude-code/testing'

import { statusLine } from '../hooks/servers'
import { openPane, script, startSession, world } from './world'

test('the status line names the running servers and their ports, a crashed one as crashed', () => {
  expect(statusLine([{ name: 'web', port: 5173, isCrashed: false }, { name: 'api', port: 8000, isCrashed: false }])).toBe('dev: web :5173 · api :8000')
  expect(statusLine([{ name: 'web', port: 0, isCrashed: true }, { name: 'api', port: 8000, isCrashed: false }])).toBe('dev: web crashed · api :8000')
  expect(statusLine([{ name: 'web', port: 5173, isCrashed: true }])).toBeUndefined()
  expect(statusLine([])).toBeUndefined()
})

test('past about 60 characters later ports drop first, then the running ones are counted; a crashed name stays', () => {
  const running = ['storybook', 'frontend', 'backend-api', 'websockets'].map((name, at) => ({ name, port: 5000 + at, isCrashed: false }))
  expect(statusLine(running)).toBe('dev: storybook :5000 · frontend · backend-api · websockets')
  const more = [...running, { name: 'docs-site', port: 8080, isCrashed: false }, { name: 'worker', port: 0, isCrashed: true }]
  expect(statusLine(more)).toBe('dev: 5 running · worker crashed')
})

test('the status line follows the servers in a shown session and clears when none runs', { options: { restart: false } }, async ($, on) => {
  const w = world(on, { packageJson: JSON.stringify({ scripts: { dev: 'vite', preview: 'vite preview' } }) })
  script(w, 'npm run dev', { pieces: [{ text: 'Local: http://localhost:5173/\n' }] })
  script(w, 'npm run preview', { pieces: [{ text: 'Local: http://localhost:4173/\n' }, { text: 'boom\n', afterMs: 5_000 }], exit: { code: 1, signal: null } })
  await startSession($)
  const pane = await openPane($)
  for (const name of ['dev', 'preview']) {
    await pane.press({ key: `row-${name}` })
    await pane.press({ key: 'start' })
  }
  await w.clock.settle()
  expect(w.status[w.status.length - 1]).toBe('dev: dev :5173 · preview :4173')
  await w.clock.advance(5_000)
  expect(w.status[w.status.length - 1]).toBe('dev: dev :5173 · preview crashed')
  await pane.press({ key: 'row-dev' })
  await pane.press({ key: 'stop' })
  expect(w.status[w.status.length - 1]).toBeUndefined()
})

test('a headless session shows no status line', async ($, on) => {
  const w = world(on)
  await startSession($)
  const pane = await openPane($)
  await pane.press({ key: 'row-dev' })
  w.surfaces.splice(0)
  await pane.press({ key: 'start' })
  expect(w.spawned).toEqual([])
  expect(w.status).toEqual([])
})
