import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { openPane, ROOT, script, startSession, world } from './world'
import type { World } from './world'

const KNOWN = { store: { [`ports:${ROOT}`]: { dev: 5173 } } }
const LISTENING = (address: string, pid: number) => `  TCP    ${address}    ${address.startsWith('[') ? '[::]:0' : '0.0.0.0:0'}    LISTENING    ${pid}\n`

async function pressStart($: Engine) {
  const pane = await openPane($)
  await pane.press({ key: 'row-dev' })
  await pane.press({ key: 'start' })
  return pane
}

function spawnedCount(w: World): number {
  return w.spawned.length
}

test('a free port starts the server; no port known means no check at all', async ($, on) => {
  const w = world(on, KNOWN)
  w.runs.set('netstat -ano', { stdout: '  TCP    127.0.0.1:5173    127.0.0.1:50122    TIME_WAIT    0\n' })
  await startSession($)
  const pane = await pressStart($)
  expect(w.ran).toEqual(['netstat -ano'])
  expect(spawnedCount(w)).toBe(1)
  expect((await pane.find({ key: 'words-dev' }))?.text).toBe('starting… 0s')
})

test('with no port known, nothing is checked', async ($, on) => {
  const w = world(on)
  await startSession($)
  await pressStart($)
  expect(w.ran).toEqual([])
  expect(spawnedCount(w)).toBe(1)
})

test('a taken port names its holder, does not start, and offers start and hide', async ($, on) => {
  const w = world(on, KNOWN)
  w.runs.set('netstat -ano', { stdout: LISTENING('[::1]:5173', 18244) })
  w.runs.set('tasklist /FI PID eq 18244 /FO CSV /NH', { stdout: '"node.exe","18244","Console","1","37,592 K"\r\n' })
  await startSession($)
  const pane = await pressStart($)
  expect(spawnedCount(w)).toBe(0)
  expect((await pane.find({ key: 'words-dev' }))?.text).toBe(':5173 taken by node.exe 18244')
  expect((await pane.findAll({ type: 'Button' })).map(button => button.key)).toEqual(['row-dev', 'start', 'hide'])
})

test('a holder that cannot be named is left out; a listener on another address still takes the port', async ($, on) => {
  const w = world(on, KNOWN)
  w.runs.set('netstat -ano', { stdout: LISTENING('192.168.1.20:5173', 777) })
  w.runs.set('tasklist /FI PID eq 777 /FO CSV /NH', { stdout: 'INFO: No tasks are running which match the specified criteria.\r\n' })
  await startSession($)
  const pane = await pressStart($)
  expect(spawnedCount(w)).toBe(0)
  expect((await pane.find({ key: 'words-dev' }))?.text).toBe(':5173 taken')
})

test('a missing port tool skips the check: the server starts and the row says port not checked', async ($, on) => {
  const w = world(on, KNOWN)
  w.runs.delete('netstat -ano')
  script(w, 'npm run dev', { pieces: [{ text: 'Local: http://localhost:5173/\n' }] })
  await startSession($)
  const pane = await pressStart($)
  await w.clock.settle()
  expect(spawnedCount(w)).toBe(1)
  expect((await pane.find({ key: 'words-dev' }))?.text).toBe('up 0s · port not checked')
})

test('on Linux ss checks the port and names the holder; where ss is missing, lsof does', async ($, on) => {
  const w = world(on, { ...KNOWN, os: '' })
  w.runs.set("ss -ltnpH sport = :5173", { stdout: 'LISTEN 0 511 *:5173 *:* users:(("node",pid=812,fd=3))\n' })
  await startSession($)
  const pane = await pressStart($)
  expect((await pane.find({ key: 'words-dev' }))?.text).toBe(':5173 taken by node 812')

  w.runs.delete("ss -ltnpH sport = :5173")
  w.runs.set('lsof -nP -iTCP:5173 -sTCP:LISTEN', { stdout: 'COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\nnode    41236 me    23u  IPv6 0x1      0t0  TCP [::1]:5173 (LISTEN)\n' })
  await pane.press({ key: 'start' })
  expect((await pane.find({ key: 'words-dev' }))?.text).toBe(':5173 taken by node 41236')
  expect(spawnedCount(w)).toBe(0)
})

test('after its own stop the mod polls until the listener lets go, then starts again', async ($, on) => {
  const w = world(on, KNOWN)
  const free = { stdout: '' }
  const held = { stdout: LISTENING('[::1]:5173', 41236) }
  w.runs.set('netstat -ano', [free, held, held, held, free])
  script(w, 'npm run dev', { pieces: [{ text: 'Local: http://localhost:5173/\n' }] }, { pieces: [{ text: 'Local: http://localhost:5173/\n' }] })
  await startSession($)
  const pane = await pressStart($)
  await w.clock.settle()
  await pane.press({ key: 'restart' })
  for (let n = 0; n < 5; n += 1) await w.clock.advance(100)
  expect(spawnedCount(w)).toBe(2)
  expect(w.ran.filter(argv => argv === 'netstat -ano').length).toBe(5)
  expect(w.ran.some(argv => argv.startsWith('tasklist'))).toBe(false)
  expect((await pane.find({ key: 'words-dev' }))?.text).toBe('up 0s')
})

test('a listener that outlasts the 3 s poll after a stop reads as taken', async ($, on) => {
  const w = world(on, KNOWN)
  w.runs.set('netstat -ano', [{ stdout: '' }, { stdout: LISTENING('0.0.0.0:5173', 5100) }])
  w.runs.set('tasklist /FI PID eq 5100 /FO CSV /NH', { stdout: '"python.exe","5100","Console","1","9,000 K"\r\n' })
  script(w, 'npm run dev', { pieces: [{ text: 'Local: http://localhost:5173/\n' }] })
  await startSession($)
  const pane = await pressStart($)
  await w.clock.settle()
  await pane.press({ key: 'restart' })
  await w.clock.advance(3_500)
  expect(spawnedCount(w)).toBe(1)
  expect((await pane.find({ key: 'words-dev' }))?.text).toBe(':5173 taken by python.exe 5100')
})

test('a server that moves to another port by itself is running, moved from the known one', async ($, on) => {
  const w = world(on, KNOWN)
  w.runs.set('netstat -ano', { stdout: '' })
  script(w, 'npm run dev', { pieces: [{ text: 'Port 5173 is in use, trying another one...\n  ➜  Local:   http://localhost:5174/\n' }] })
  await startSession($)
  const pane = await pressStart($)
  await w.clock.settle()
  const words = await pane.find({ key: 'words-dev' })
  expect(words?.text).toBe('up 0s · moved from :5173')
  expect((await pane.findAll({ type: 'Text' })).find(text => text.text === 'up 0s · moved from :5173')?.props.color).toBe('warning')
  expect(w.store.get(`ports:${ROOT}`)).toEqual({ dev: 5173 })
})

test('a second start pressed while the port check runs starts nothing more', async ($, on) => {
  const w = world(on, KNOWN)
  await startSession($)
  const pane = await openPane($)
  await pane.press({ key: 'row-dev' })
  await Promise.all([pane.press({ key: 'start' }), pane.press({ key: 'start' })])
  await w.clock.settle()
  expect(spawnedCount(w)).toBe(1)
})
