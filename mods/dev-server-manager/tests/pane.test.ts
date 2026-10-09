import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { openPane, PANE_ID, ROOT, script, startSession, world } from './world'

const SCRIPTS = JSON.stringify({ scripts: { dev: 'vite', storybook: 'storybook dev -p 6006', 'worker-queue-consumer': 'node worker.js' } })
const URL_LINE = { text: '  ➜  Local:   http://localhost:5173/\n' }

function scroll($: Engine, by: number, bodyRows: number, contentRows: number, row?: number) {
  return $.ui.scroll({
    component: 'Pane',
    requestId: PANE_ID,
    offset: 0,
    by,
    bodyRows,
    contentRows,
    origin: { kind: 'person' },
    ...(row === undefined ? {} : { pointer: { column: 2, row } }),
  } as never)
}

for (const columns of [44, 60, 90]) {
  test(`at ${columns} columns every row is one line, names padded to the longest up to 12, words cut with …`, { options: { scripts: 'dev, storybook, worker-queue-consumer' } }, async ($, on) => {
    const w = world(on, { packageJson: SCRIPTS, store: { [`ports:${ROOT}`]: { storybook: 6006 } } })
    w.runs.set('netstat -ano', { stdout: '  TCP    [::1]:6006    [::]:0    LISTENING    18244\n' })
    w.runs.set('tasklist /FI PID eq 18244 /FO CSV /NH', { stdout: '"node.exe","18244","Console","1","37,592 K"\r\n' })
    await startSession($)
    const pane = await openPane($, columns)
    await pane.press({ key: 'row-storybook' })
    await pane.press({ key: 'start' })
    for (const name of ['dev', 'storybook', 'worker-queue-consumer']) {
      const line = await pane.find({ key: `line-${name}` })
      expect(Array.from(line?.text ?? '').length).toBeLessThanOrEqual(columns)
    }
    expect((await pane.find({ key: 'row-dev' }))?.props.label).toBe('dev         ')
    expect((await pane.find({ key: 'row-worker-queue-consumer' }))?.props.label).toBe('worker-queue')
    const taken = (await pane.find({ key: 'words-storybook' }))?.text ?? ''
    // 44 columns less the lead (3), the name (12) and the port column (8) leave 21.
    if (columns === 44) expect(taken).toBe(':6006 taken by node.…')
    else expect(taken).toBe(':6006 taken by node.exe 18244')
    expect((await pane.find({ key: 'line-storybook' }))?.text).toStartWith('▸! storybook    :6006  ')
    expect((await pane.find({ key: 'line-dev' }))?.text).toStartWith(' ○ dev                 stopped')
  })
}

test('the title sits at the top left, and the gear at the right only while /mod-settings exists', async ($, on) => {
  world(on, { hasSettings: true })
  await startSession($)
  const pane = await openPane($)
  const tree = (await pane.drawn()) as { children?: unknown[] }
  expect(JSON.stringify(tree.children?.[0])).toContain('Dev servers')
  expect((await pane.find({ key: 'mod-settings' }))?.props.label).toBe('⚙️')
})

test('without /mod-settings there is no gear', async ($, on) => {
  world(on)
  await startSession($)
  const pane = await openPane($)
  expect(await pane.find({ key: 'mod-settings' })).toBeUndefined()
})

test('nothing picked shows a dim hint; picking a row twice closes its detail and output', async ($, on) => {
  world(on)
  await startSession($)
  const pane = await openPane($)
  expect((await pane.find({ key: 'hint' }))?.text).toBe('Pick a server to act on it and see its output.')
  await pane.press({ key: 'row-dev' })
  expect(await pane.find({ key: 'hint' })).toBeUndefined()
  expect(await pane.find({ key: 'detail' })).toBeDefined()
  expect((await pane.find({ key: 'line-dev' }))?.text).toStartWith('▸')
  await pane.press({ key: 'row-dev' })
  expect(await pane.find({ key: 'detail' })).toBeUndefined()
  expect(await pane.find({ key: 'output' })).toBeUndefined()
})

test('the buttons and their keys follow the state', { options: { restart: false } }, async ($, on) => {
  const w = world(on)
  script(w, 'npm run dev', { pieces: [{ text: 'booting\n' }] }, { pieces: [URL_LINE, { text: 'Error: boom\n', afterMs: 1_000 }], exit: { code: 1, signal: null } })
  await startSession($)
  const pane = await openPane($)
  await pane.press({ key: 'row-dev' })
  const buttons = async () => (await pane.findAll({ type: 'Button' })).filter(button => button.key !== 'row-dev').map(button => `${button.props.hotkey}:${button.key}`)
  expect(await buttons()).toEqual(['s:start', 'h:hide'])
  await pane.press({ key: 'start' })
  expect(await buttons()).toEqual(['x:stop'])
  await pane.press({ key: 'stop' })
  await pane.press({ key: 'start' })
  await w.clock.settle()
  expect(await buttons()).toEqual(['x:stop', 'r:restart'])
  await w.clock.advance(1_000)
  expect(await buttons()).toEqual(['s:start', 'e:error', 'h:hide'])
})

test('a running server cannot be hidden, and the detail block shows its command and URL without the scheme', async ($, on) => {
  const w = world(on)
  script(w, 'npm run dev', { pieces: [URL_LINE] })
  await startSession($)
  const pane = await openPane($)
  await pane.press({ key: 'row-dev' })
  await pane.press({ key: 'start' })
  await w.clock.settle()
  expect(await pane.find({ key: 'hide' })).toBeUndefined()
  expect((await pane.find({ key: 'command' }))?.text).toBe('npm run dev')
  expect((await pane.find({ type: 'Link' }))?.props.label).toBe('localhost:5173')
})

/** A pane 20 rows down with dev running and 200 lines printed. */
async function longOutput($: Engine, w: ReturnType<typeof world>) {
  const lines = Array.from({ length: 200 }, (_, n) => ({ text: `line ${n}\n` }))
  script(w, 'npm run dev', { pieces: [URL_LINE, ...lines, { text: 'late line\n', afterMs: 60_000 }] })
  await startSession($)
  const pane = await openPane($, 60, 20)
  await pane.press({ key: 'row-dev' })
  await pane.press({ key: 'start' })
  await w.clock.advance(1_000)
  return pane
}

async function outputTexts(pane: Awaited<ReturnType<typeof openPane>>): Promise<string[]> {
  const output = await pane.find({ key: 'output' })
  return (output?.children ?? []).map(child => {
    const element = child as { children?: unknown[]; props?: { label?: string } }
    return element.props?.label ?? element.children?.join('') ?? ''
  })
}

test('the output is a bounded box under a fixed title and table, following its tail', async ($, on) => {
  const w = world(on)
  const pane = await longOutput($, w)
  const output = await pane.find({ key: 'output' })
  const height = Number(output?.props.height)
  expect(output?.props.overflow).toBe('hidden')
  expect(height).toBeGreaterThanOrEqual(4)
  const shown = await outputTexts(pane)
  expect(shown).toHaveLength(height)
  expect(shown[shown.length - 1]).toBe('line 199')
  const tree = (await pane.drawn()) as { children?: unknown[] }
  expect(JSON.stringify(tree.children?.[0])).toContain('Dev servers')
})

test('a wheel up pins the view: new lines do not move it, ↓ latest shows, and the end follows again', async ($, on) => {
  const w = world(on)
  const pane = await longOutput($, w)
  const height = Number((await pane.find({ key: 'output' }))?.props.height)
  const result = await scroll($, -5, 20, 19, 18)
  expect(result).toEqual({})
  const pinned = await outputTexts(pane)
  expect(pinned[pinned.length - 1]).toBe('↓ latest')
  expect(pinned[pinned.length - 2]).toBe(`line ${199 - 5 - 1}`)
  await w.clock.advance(61_000)
  expect(await outputTexts(pane)).toEqual(pinned)

  await scroll($, 20, 20, 19)
  const paged = await outputTexts(pane)
  expect(paged[paged.length - 1]).toBe('late line')
  expect(paged).toHaveLength(height)
})

test('Home goes to the first kept line, a page moves by the box, and ↓ latest follows again', async ($, on) => {
  const w = world(on)
  const pane = await longOutput($, w)
  await scroll($, -19, 20, 19)
  expect((await outputTexts(pane))[0]).toBe('── started 14:00 ──')
  const height = Number((await pane.find({ key: 'output' }))?.props.height)
  await scroll($, 20, 20, 19)
  expect((await outputTexts(pane))[0]).toBe(`line ${height - 1 - 2}`)
  await pane.press({ key: 'latest' })
  const following = await outputTexts(pane)
  expect(following[following.length - 1]).toBe('line 199')
})

test('a wheel over the title or table leaves the output where it is', async ($, on) => {
  const w = world(on)
  const pane = await longOutput($, w)
  const before = await outputTexts(pane)
  expect(await scroll($, -3, 20, 19, 0)).toEqual({})
  expect(await outputTexts(pane)).toEqual(before)
})

test('below the floor of output rows the engine scrolls the whole body', async ($, on) => {
  const w = world(on)
  const passed: number[] = []
  on('ui.scroll', (_$, e) => {
    passed.push(e.by)
    return {}
  })
  script(w, 'npm run dev', { pieces: [URL_LINE, { text: 'one\n' }, { text: 'two\n' }] })
  await startSession($)
  const pane = await openPane($, 60, 10)
  await pane.press({ key: 'row-dev' })
  await pane.press({ key: 'start' })
  await w.clock.advance(1_000)
  expect((await pane.find({ key: 'output' }))?.props.height).toBeUndefined()
  await scroll($, -1, 10, 14)
  expect(passed).toEqual([-1])
})

test('below the floor the whole kept list is drawn for the engine to scroll', async ($, on) => {
  const w = world(on)
  const pieces = Array.from({ length: 600 }, (_unused, at) => ({ text: `line ${at}
` }))
  script(w, 'npm run dev', { pieces: [URL_LINE, ...pieces] })
  await startSession($)
  const pane = await openPane($, 60, 10)
  await pane.press({ key: 'row-dev' })
  await pane.press({ key: 'start' })
  await w.clock.advance(1_000)
  const drawn = (await pane.findAll({ type: 'Text' })).map(found => found.text).filter(text => text.startsWith('line '))
  expect(drawn).toHaveLength(500)
  expect(drawn[0]).toBe('line 100')
})
