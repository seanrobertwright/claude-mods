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
