import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { openPane, ROOT, script, startSession, world } from './world'

async function devServers($: Engine, args: string): Promise<string | undefined> {
  return (await $.command.run({ command: 'dev-servers', args } as never)).text
}

test('an added server is kept per project, runs from its folder, and is removed by name', async ($, on) => {
  const w = world(on)
  await startSession($)
  expect(await devServers($, 'add api --port 8000 --cwd backend uv run uvicorn app:main --port 8000')).toBe('Added api: uv run uvicorn app:main --port 8000')
  expect(w.store.get(`added:${ROOT}`)).toEqual([{ name: 'api', port: 8000, cwd: 'backend', argv: ['uv', 'run', 'uvicorn', 'app:main', '--port', '8000'] }])

  w.runs.set('netstat -ano', { stdout: '' })
  script(w, 'uv run uvicorn app:main --port 8000', { pieces: [{ text: 'INFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)\n', stream: 'stderr' }] })
  const pane = await openPane($)
  await pane.press({ key: 'row-api' })
  await pane.press({ key: 'start' })
  await w.clock.settle()
  expect(w.spawned[0]).toMatchObject({ cwd: `${ROOT}/backend` })
  expect((await pane.find({ key: 'words-api' }))?.text).toBe('up 0s')
  expect(await pane.find({ key: 'hide' })).toBeUndefined()

  expect(await devServers($, 'add dev vite')).toBe('dev is already a server here (a package.json script). Pick another name.')
  expect(await devServers($, 'add web vite && echo hi')).toMatch(/without a shell/)
  await pane.press({ key: 'stop' })
  expect(await devServers($, 'remove api')).toBe('Removed api.')
  expect(w.store.get(`added:${ROOT}`)).toEqual([])
  expect(await pane.find({ key: 'row-api' })).toBeUndefined()
  expect(await devServers($, 'remove api')).toBe('No added server is named api. Added servers: none.')
})

test('a detected row hides, folds into a dim line, unfolds in place, and unhides', async ($, on) => {
  const w = world(on, { packageJson: JSON.stringify({ scripts: { dev: 'vite', storybook: 'storybook dev', preview: 'vite preview' } }) })
  await startSession($)
  await devServers($, 'add docs mkdocs serve')
  const pane = await openPane($)
  await pane.press({ key: 'row-preview' })
  await pane.press({ key: 'hide' })
  expect(w.store.get(`hidden:${ROOT}`)).toEqual(['preview'])
  expect(await pane.find({ key: 'row-preview' })).toBeUndefined()
  expect((await pane.find({ key: 'hidden' }))?.text).toBe('1 hidden: preview')

  await pane.press({ key: 'hidden' })
  expect((await pane.find({ key: 'hidden' }))?.text).toBe('1 hidden: preview')
  expect((await pane.find({ key: 'line-preview' }))?.text).toContain('unhide')
  await pane.press({ key: 'hidden' })
  expect(await pane.find({ key: 'row-preview' })).toBeUndefined()
  await pane.press({ key: 'hidden' })
  await pane.press({ key: 'row-preview' })
  expect(await pane.find({ key: 'start' })).toBeUndefined()
  await pane.press({ key: 'unhide-preview' })
  expect(w.store.get(`hidden:${ROOT}`)).toEqual([])
  expect(await pane.find({ key: 'hidden' })).toBeUndefined()

  await pane.press({ key: 'row-docs' })
  expect(await pane.find({ key: 'hide' })).toBeUndefined()
  expect(await devServers($, 'unhide dev')).toBe('dev is not hidden.')
})

test('/dev-servers unhide shows a hidden row again', async ($, on) => {
  const w = world(on, { store: { [`hidden:${ROOT}`]: ['dev'] } })
  await startSession($)
  const pane = await openPane($)
  expect(await pane.find({ key: 'row-dev' })).toBeUndefined()
  expect(await devServers($, 'unhide dev')).toBe('dev is shown again.')
  expect(w.store.get(`hidden:${ROOT}`)).toEqual([])
  expect(await pane.find({ key: 'row-dev' })).toBeDefined()
})

test('/dev-servers alone opens the pane with the keys; the empty pane says how to add one', async ($, on) => {
  const w = world(on, { packageJson: undefined })
  await startSession($)
  await devServers($, '')
  expect(w.panes).toEqual(['open dev-servers+focus'])
  const pane = await openPane($)
  expect((await pane.find({ key: 'empty' }))?.text).toBe('Nothing to run here. Add one: /dev-servers add <name> [--port N] [--cwd dir] <command…>')
  expect(await pane.findAll({ type: 'Button' })).toHaveLength(0)
})
