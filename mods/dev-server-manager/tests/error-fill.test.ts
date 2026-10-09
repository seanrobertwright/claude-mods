import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { openPane, script, startSession, world } from './world'

const URL_LINE = { text: '  ➜  Local:   http://localhost:5173/\n' }
const STACK = { stream: 'stderr' as const, text: "Error: Cannot find module './jobs'\n    at main.js:3:9\n" }
const ERROR = [
  'The dev server dev (npm run dev) crashed with exit 3 at 14:01. Its last output:',
  '',
  '```',
  '  ➜  Local:   http://localhost:5173/',
  "Error: Cannot find module './jobs'",
  '    at main.js:3:9',
  '```',
].join('\n')

async function startDev($: Engine) {
  const pane = await openPane($, 90)
  await pane.press({ key: 'row-dev' })
  await pane.press({ key: 'start' })
  return pane
}

test('error → prompt appends the error after a blank line, sends nothing, and hands the keys to the prompt', { options: { restart: false } }, async ($, on) => {
  const w = world(on)
  script(w, 'npm run dev', { pieces: [URL_LINE, { ...STACK, afterMs: 60_000 }], exit: { code: 3, signal: null } })
  await startSession($)
  const pane = await startDev($)
  await w.clock.advance(60_000)
  w.panes.splice(0)
  await pane.press({ key: 'error' })
  expect(w.filled).toEqual([{ text: `\n\n${ERROR}`, mode: 'append' }])
  expect(w.sent).toEqual([])
  expect(w.panes).toEqual(['close dev-servers', 'open dev-servers'])
  await pane.press({ key: 'error' })
  expect(w.filled).toHaveLength(2)
  expect(await pane.find({ key: 'error' })).toBeDefined()
})

test('where no prompt box can take it, the pane says so', { options: { restart: false } }, async ($, on) => {
  const w = world(on)
  script(w, 'npm run dev', { pieces: [URL_LINE, { ...STACK, afterMs: 1_000 }], exit: { code: 3, signal: null } })
  await startSession($)
  const pane = await startDev($)
  await w.clock.advance(1_000)
  w.composer = 'no_composer'
  await pane.press({ key: 'error' })
  expect((await pane.find({ key: 'fill-refused' }))?.text).toBe("can't reach the prompt here")
  expect((await pane.findAll({ type: 'Text' })).find(found => found.text === "can't reach the prompt here")?.props.dimColor).toBe(true)
})

test('after an automatic restart the button fills the death before the divider, then the note and button go', async ($, on) => {
  const w = world(on)
  script(w, 'npm run dev', { pieces: [URL_LINE, { ...STACK, afterMs: 60_000 }], exit: { code: 3, signal: null } }, { pieces: [URL_LINE, { text: 'fine now\n' }] })
  await startSession($)
  const pane = await startDev($)
  await w.clock.advance(60_000)
  await w.clock.advance(1_000)
  await pane.press({ key: 'error' })
  expect(w.filled).toEqual([{ text: `\n\n${ERROR}`, mode: 'append' }])
  expect(await pane.find({ key: 'error' })).toBeUndefined()
  expect((await pane.find({ key: 'words-dev' }))?.text).toBe('up 1s')
})

test('the note and button clear when the person stops the server by hand', async ($, on) => {
  const w = world(on)
  script(w, 'npm run dev', { pieces: [URL_LINE, { ...STACK, afterMs: 5_000 }], exit: { code: 3, signal: null } }, { pieces: [URL_LINE] }, { pieces: [URL_LINE] })
  await startSession($)
  const pane = await startDev($)
  await w.clock.advance(5_000)
  expect(await pane.find({ key: 'error' })).toBeDefined()
  await pane.press({ key: 'stop' })
  await pane.press({ key: 'start' })
  await w.clock.settle()
  expect(await pane.find({ key: 'error' })).toBeUndefined()
  expect((await pane.find({ key: 'words-dev' }))?.text).toBe('up 0s')
})

test('the note and button clear after 10 minutes without dying', async ($, on) => {
  const w = world(on)
  script(w, 'npm run dev', { pieces: [URL_LINE, { ...STACK, afterMs: 5_000 }], exit: { code: 3, signal: null } }, { pieces: [URL_LINE] })
  await startSession($)
  const pane = await startDev($)
  await w.clock.advance(5_000)
  await w.clock.advance(599_000)
  expect(await pane.find({ key: 'error' })).toBeDefined()
  await w.clock.advance(1_000)
  await pane.redraw()
  expect(await pane.find({ key: 'error' })).toBeUndefined()
  expect((await pane.find({ key: 'words-dev' }))?.text).toBe('up 10m')
})

test('a flood of output reaches $.state about once a second', async ($, on) => {
  const w = world(on)
  const flood = Array.from({ length: 200 }, (_, n) => ({ text: `line ${n}\n`, afterMs: 10 }))
  script(w, 'npm run dev', { pieces: [URL_LINE, ...flood] })
  await startSession($)
  const pane = await startDev($)
  w.stateWrites.splice(0)
  await w.clock.advance(2_000)
  const outputWrites = w.stateWrites.filter(key => key === 'output').length
  expect(outputWrites).toBeGreaterThanOrEqual(2)
  expect(outputWrites).toBeLessThanOrEqual(3)
  await w.clock.advance(1_000)
  expect((await pane.findAll({ type: 'Text' })).map(found => found.text)).toContain('line 199')
})
