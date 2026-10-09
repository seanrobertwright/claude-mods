import { expect, test } from 'claude-code/testing'

import { openPane, ROOT, script, startSession, world } from './world'

test('a detected server starts with no shell, starting until its URL, then running there', async ($, on) => {
  const w = world(on)
  script(w, 'npm run dev', {
    pieces: [
      { text: '\n  VITE v8 ready\n  \x1b[32m➜\x1b[39m  Local:   \x1b[36mhttp://localhost:\x1b[1m51', afterMs: 4_000 },
      { text: '73\x1b[22m/\x1b[39m\n  ➜  Network: use --host\n' },
    ],
  })
  await startSession($)
  const pane = await openPane($)
  await pane.press({ key: 'row-dev' })
  await pane.press({ key: 'start' })

  expect(w.spawned).toHaveLength(1)
  expect(w.spawned[0]).toMatchObject({ argv: ['npm', 'run', 'dev'], cwd: ROOT, env: { PYTHONUNBUFFERED: '1' } })
  expect((await pane.find({ key: 'words-dev' }))?.text).toBe('starting… 0s')

  await w.clock.advance(4_000)
  expect((await pane.find({ key: 'words-dev' }))?.text).toBe('up 4s')
  expect((await pane.find({ type: 'Link' }))?.props).toMatchObject({ href: 'http://localhost:5173', label: 'localhost:5173' })
  expect((await pane.find({ key: 'port-dev' }))?.text).toContain(':5173')
  expect(w.store.get(`ports:${ROOT}`)).toEqual({ dev: 5173 })
})

test('stop closes the stream: the tree is killed, the row is stopped, and nothing toasts', async ($, on) => {
  const w = world(on)
  script(w, 'npm run dev', { pieces: [{ text: 'Local: http://localhost:5173/\n' }] })
  await startSession($)
  const pane = await openPane($)
  await pane.press({ key: 'row-dev' })
  await pane.press({ key: 'start' })
  await w.clock.settle()
  await pane.press({ key: 'stop' })
  await w.clock.settle()
  expect(w.killed).toEqual(['npm run dev'])
  expect((await pane.find({ key: 'words-dev' }))?.text).toBe('stopped')
  expect(w.toasts).toEqual([])
  expect(await pane.find({ key: 'start' })).toBeDefined()
})

test('a command that cannot start shows the engine message on the row, in yellow', async ($, on) => {
  const w = world(on, { lockfiles: ['pnpm-lock.yaml'] })
  script(w, 'pnpm run dev', { cannotStart: "ENOENT: Command 'pnpm' not found or is in an unsafe location (current directory)" })
  await startSession($)
  const pane = await openPane($)
  await pane.press({ key: 'row-dev' })
  await pane.press({ key: 'start' })
  await w.clock.settle()
  const words = await pane.find({ key: 'words-dev' })
  expect(words?.text).toStartWith("ENOENT: Command 'pnpm' not found")
  expect((await pane.findAll({ type: 'Text' })).find(text => text.text.startsWith('ENOENT'))?.props.color).toBe('warning')
  expect(w.spawned.map(request => request.argv)).toEqual([['pnpm', 'run', 'dev']])
  expect(w.toasts).toEqual([])
})

test('two lockfiles block the start and the row names them', async ($, on) => {
  const w = world(on, { lockfiles: ['package-lock.json', 'yarn.lock'] })
  await startSession($)
  const pane = await openPane($)
  expect((await pane.find({ key: 'words-dev' }))?.text).toBe('lockfiles disagree: package-lock.json, yarn.lock')
  await pane.press({ key: 'row-dev' })
  await pane.press({ key: 'start' })
  expect(w.spawned).toEqual([])
})

test('session end stops every server, unless it ends for /clear', async ($, on) => {
  const w = world(on, { packageJson: JSON.stringify({ scripts: { dev: 'vite', preview: 'vite preview' } }) })
  await startSession($)
  const pane = await openPane($)
  for (const name of ['dev', 'preview']) {
    await pane.press({ key: `row-${name}` })
    await pane.press({ key: 'start' })
  }
  await w.clock.settle()
  await $.session.end({ reason: 'clear', sessionId: 'session-a', resume: { id: 'session-a' } } as never)
  await w.clock.settle()
  expect(w.killed).toEqual([])
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-b', resume: { id: 'session-b' } } as never)
  await w.clock.settle()
  expect(w.killed.sort()).toEqual(['npm run dev', 'npm run preview'])
})

test('uvicorn prints its URL on stderr, and Django its banner once unbuffered', async ($, on) => {
  const w = world(on)
  await startSession($)
  await $.command.run({ command: 'dev-servers', args: 'add api uv run uvicorn app:main' } as never)
  await $.command.run({ command: 'dev-servers', args: 'add django uv run manage.py runserver' } as never)
  script(w, 'uv run uvicorn app:main', { pieces: [{ stream: 'stderr', text: 'INFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)\r\n' }] })
  script(w, 'uv run manage.py runserver', { pieces: [{ stream: 'stderr', text: 'Watching for file changes with StatReloader\r\n' }, { text: 'Starting development server at http://127.0.0.1:8001/\r\n' }] })
  const pane = await openPane($)
  for (const name of ['api', 'django']) {
    await pane.press({ key: `row-${name}` })
    await pane.press({ key: 'start' })
  }
  await w.clock.settle()
  expect((await pane.find({ key: 'port-api' }))?.text).toContain(':8000')
  expect((await pane.find({ key: 'port-django' }))?.text).toContain(':8001')
  expect(w.spawned.every(request => request.env?.PYTHONUNBUFFERED === '1')).toBe(true)
})

test('after /clear the servers run on, and the fresh session lists them even if $.state was cleared', async ($, on) => {
  const w = world(on)
  // An engine whose /clear empties the mod's values: they read unwritten until the mod writes them again.
  let clearedAt = -1
  const isUnwritten = (key: string) => clearedAt >= 0 && !w.stateWrites.slice(clearedAt).includes(key)
  on('state.get', (_$, e, next) => (isUnwritten(e.key) ? ({ value: { value: undefined, version: 0 } } as never) : next(e)))
  on('prompt.compose', () => ({ sections: [] }) as never)
  script(w, 'npm run dev', { pieces: [{ text: 'Local: http://localhost:5173/\n' }] })
  await startSession($)
  const pane = await openPane($)
  await pane.press({ key: 'row-dev' })
  await pane.press({ key: 'start' })
  await w.clock.settle()
  await pane.unmount()
  await $.session.end({ reason: 'clear', sessionId: 'session-a', resume: { id: 'session-a' } } as never)
  clearedAt = w.stateWrites.length
  const composed = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as never)
  expect(composed.sections.find(section => section.id === 'dev-server-manager:servers')?.text).toContain('- dev: npm run dev, http://localhost:5173, running')
  expect(w.killed).toEqual([])
  const again = await openPane($)
  expect((await again.find({ key: 'words-dev' }))?.text).toBe('up 0s')
})

test('a server that dies after /clear, before the fresh session first prompt, leaves the others listed', { options: { restart: false } }, async ($, on) => {
  const w = world(on, { packageJson: JSON.stringify({ scripts: { dev: 'vite', preview: 'vite preview' } }) })
  let clearedAt = -1
  const isUnwritten = (key: string) => clearedAt >= 0 && !w.stateWrites.slice(clearedAt).includes(key)
  on('state.get', (_$, e, next) => (isUnwritten(e.key) ? ({ value: { value: undefined, version: 0 } } as never) : next(e)))
  on('prompt.compose', () => ({ sections: [] }) as never)
  script(w, 'npm run dev', { pieces: [{ text: 'Local: http://localhost:5173/\n' }] })
  script(w, 'npm run preview', { pieces: [{ text: 'Local: http://localhost:4173/\n' }, { text: 'boom\n', afterMs: 5_000 }], exit: { code: 1, signal: null } })
  await startSession($)
  const pane = await openPane($)
  for (const name of ['dev', 'preview']) {
    await pane.press({ key: `row-${name}` })
    await pane.press({ key: 'start' })
  }
  await w.clock.settle()
  await pane.unmount()
  await $.session.end({ reason: 'clear', sessionId: 'session-a', resume: { id: 'session-a' } } as never)
  clearedAt = w.stateWrites.length
  await w.clock.advance(5_000)
  const composed = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as never)
  expect(composed.sections.find(section => section.id === 'dev-server-manager:servers')?.text).toContain('- dev: npm run dev, http://localhost:5173, running')
  const again = await openPane($)
  expect((await again.find({ key: 'words-preview' }))?.text).toStartWith('crashed (exit 1)')
})
