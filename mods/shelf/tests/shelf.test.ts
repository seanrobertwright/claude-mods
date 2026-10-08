import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fitCount, parseRequest, parseStored, promptText, withEntry, withoutEntry } from '../hooks/shelf'

const BRAND = { name: 'brand', path: 'C:\\Docs\\Branding Docs' }
const RECORDS = { name: 'records', path: 'N:\\RECORDS' }

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
} as const

const COMPOSER = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const

/** The engine beneath the mod: its own band (a node, as core answers), a store in memory, a prompt box that records what it is given. */
function engineBeneath(on: On, stored?: Readonly<Record<string, unknown>>): { filled: { text: string; mode: string }[]; sent: string[] } {
  const filled: { text: string; mode: string }[] = []
  const sent: string[] = []
  mock.store(on, stored)
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 0 }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work/repo' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('prompt.fill', (_$, e) => {
    filled.push({ text: e.text, mode: e.mode })
    return { isFilled: true }
  })
  on('prompt.submit', (_$, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  return { filled, sent }
}

test('parseRequest reads list, add with and without a path, and remove', () => {
  expect(parseRequest('  ')).toEqual({ kind: 'list' })
  expect(parseRequest('add brand "C:\\Docs\\Branding Docs"')).toEqual({ kind: 'add', name: 'brand', path: 'C:\\Docs\\Branding Docs' })
  expect(parseRequest('add brand C:\\Docs\\Branding Docs')).toEqual({ kind: 'add', name: 'brand', path: 'C:\\Docs\\Branding Docs' })
  expect(parseRequest('add here')).toEqual({ kind: 'add', name: 'here', path: null })
  expect(parseRequest('remove brand')).toEqual({ kind: 'remove', name: 'brand' })
  expect(parseRequest('add')).toEqual({ kind: 'usage' })
  expect(parseRequest('remove brand now')).toEqual({ kind: 'usage' })
  expect(parseRequest('open brand')).toEqual({ kind: 'usage' })
})

test('the shelf replaces an entry by name, whatever its case, and drops one', () => {
  const moved = { name: 'Brand', path: 'D:\\New' }
  expect(withEntry([BRAND, RECORDS], moved)).toEqual([moved, RECORDS])
  expect(withEntry([BRAND], RECORDS)).toEqual([BRAND, RECORDS])
  expect(withoutEntry([BRAND, RECORDS], 'BRAND')).toEqual([RECORDS])
  expect(parseStored([BRAND, { name: 3 }, null, 'x'])).toEqual([BRAND])
  expect(parseStored('nonsense')).toEqual([])
})

test('a path with a space is quoted for the prompt, and only whole buttons are counted as fitting', () => {
  expect(promptText(BRAND.path)).toBe('"C:\\Docs\\Branding Docs"')
  expect(promptText(RECORDS.path)).toBe('N:\\RECORDS')
  expect(fitCount([BRAND, RECORDS], 100, 7)).toBe(2)
  expect(fitCount([BRAND, RECORDS], 20, 7)).toBe(1)
  expect(fitCount([BRAND, RECORDS], 10, 7)).toBe(0)
})

test('an empty shelf draws no band', async ($, on) => {
  engineBeneath(on)
  await $.session.start({ cwd: '/work/repo', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'shelf', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: 'Shelf:' })).toBeUndefined()
  await band.unmount()
})

test('a stored entry shows as a button that puts its path at the cursor and sends nothing', async ($, on) => {
  const { filled, sent } = engineBeneath(on, { entries: [BRAND, RECORDS] })
  await $.session.start({ cwd: '/work/repo', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'shelf', surface, component: 'AbovePrompt', props: BAND })
    expect(await band.find({ type: 'Text', text: 'Shelf:' })).toBeDefined()
    expect(await band.find({ key: 'entry-brand' })).toBeDefined()
    expect(await band.find({ key: 'entry-records' })).toBeDefined()
    await band.press({ key: 'entry-brand' })
    expect(filled[filled.length - 1]).toEqual({ text: '"C:\\Docs\\Branding Docs"', mode: 'insert' })
    await band.unmount()
  }
  expect(sent).toEqual([])
})

test('a narrow band shows the buttons that fit and counts the rest', async ($, on) => {
  engineBeneath(on, { entries: [BRAND, RECORDS] })
  await $.session.start({ cwd: '/work/repo', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'shelf', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, bodyColumns: 20 } })
  expect(await band.find({ key: 'entry-brand' })).toBeDefined()
  expect(await band.find({ key: 'entry-records' })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: '+1 in /shelf' })).toBeDefined()
  await band.unmount()
})

test('/shelf adds, lists and removes, and the band follows', async ($, on) => {
  engineBeneath(on)
  await $.session.start({ cwd: '/work/repo', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'shelf', surface: 'terminal', component: 'AbovePrompt', props: BAND })

  const added = await $.command.run({ command: 'shelf', args: 'add brand "C:\\Docs\\Branding Docs"', ...COMPOSER })
  expect(added.text).toContain('brand is on the shelf')
  expect(await band.find({ key: 'entry-brand' })).toBeDefined()

  // With no path the session's project folder goes on the shelf.
  await $.command.run({ command: 'shelf', args: 'add here', ...COMPOSER })
  const listed = await $.command.run({ command: 'shelf', args: '', ...COMPOSER })
  expect(listed.text).toBe('brand: C:\\Docs\\Branding Docs\nhere: /work/repo')

  await $.command.run({ command: 'shelf', args: 'remove brand', ...COMPOSER })
  expect(await band.find({ key: 'entry-brand' })).toBeUndefined()
  expect(await band.find({ key: 'entry-here' })).toBeDefined()

  expect((await $.command.run({ command: 'shelf', args: 'frobnicate', ...COMPOSER })).text).toContain('Usage:')
  await band.unmount()
})

test('an entry added in one session is on the shelf at the start of the next', async ($, on) => {
  engineBeneath(on)
  await $.session.start({ cwd: '/work/repo', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'shelf', args: 'add records N:\\RECORDS', ...COMPOSER })

  // A new session reads the store again.
  await $.session.start({ cwd: '/elsewhere', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'shelf', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ key: 'entry-records' })).toBeDefined()
  await band.unmount()
})

test('in a headless session the mod fills no prompt, sends none and starts no process', async ($, on) => {
  const { filled, sent } = engineBeneath(on, { entries: [BRAND] })
  const runs: (readonly string[])[] = []
  on('session.surfaces', () => ({ value: [] }))
  on('process.run', (_$, e) => {
    runs.push(e.argv)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/work/repo', surface: null, isInteractive: false })
  expect(filled).toEqual([])
  expect(sent).toEqual([])
  expect(runs).toEqual([])
})
