import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

import { isDocument, isOutput, isScanned, newestFirst, openers, outputFile } from '../hooks/files'
import type { Entry } from '../hooks/files'

const ROOT = '/work/audit'
const START = 1_000_000
const MINUTE = 60_000

const PANE = {
  title: 'Outputs',
  isFocused: false,
  bodyColumns: 50,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

const COMPOSER = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 60 } } as const

function file(name: string, mtimeMs: number): Entry & { size: number } {
  return { name, kind: 'file', size: 10, mtimeMs, isLink: false }
}

function dir(name: string): Entry & { size: number } {
  return { name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }
}

/** The world beneath the mod: the folders on disk, and what the mod opened, copied, toasted and listed. */
type World = {
  folders: Map<string, (Entry & { size: number })[]>
  listed: string[]
  opened: { id: string; focus: boolean }[]
  runs: (readonly string[])[]
  copied: string[]
  toasts: string[]
  /** Every folder holds two more, without end. */
  isEndless: boolean
}

function engineBeneath(on: On, { surfaces = ['terminal'], os = '' }: { surfaces?: readonly RenderSurface[]; os?: string } = {}) {
  const world: World = { folders: new Map(), listed: [], opened: [], runs: [], copied: [], toasts: [], isEndless: false }
  const clock = mock.clock(on, { now: START })
  mock.env(on, os === '' ? {} : { OS: os })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.surfaces', () => ({ value: surfaces }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('fs.list', (_$, e) => {
    // The engine hands the path over in the machine's own spelling; the test keeps one.
    const path = e.path.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')
    world.listed.push(path)
    if (world.isEndless) return { value: [dir('a'), dir('b')] }
    return { value: world.folders.get(path) ?? [] }
  })
  on('ui.open', (_$, e) => {
    world.opened.push({ id: e.id, focus: e.focus === true })
    return { value: { isPlaced: true } }
  })
  on('ui.toast', (_$, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', (_$, e) => {
    world.copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('process.run', (_$, e) => {
    world.runs.push(e.argv)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('tool.call', { tool: 'Write' }, (_$, e) => ({
    result: { type: 'create', filePath: e.file_path, content: e.content, structuredPatch: [], originalFile: null },
  }))
  return { world, clock }
}

const DONE = { answer: 'Done.', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' } as const

test('isDocument tells what a person reads from scripts, images and data', () => {
  expect(['Plan.DOCX', 'grid.xlsx', 'deck.pptx', 'memo.pdf', 'notes.md', 'page.html', 'log.txt'].every(isDocument)).toBe(true)
  expect(['build.py', 'chart.png', 'rows.json', 'Makefile'].some(isDocument)).toBe(false)
})

test('a scan passes over hidden and dependency folders, links, old files and Office lock files', () => {
  expect(isScanned(dir('reports'))).toBe(true)
  expect(isScanned(dir('.git'))).toBe(false)
  expect(isScanned(dir('node_modules'))).toBe(false)
  expect(isScanned({ ...dir('linked'), isLink: true })).toBe(false)
  expect(isOutput(file('new.docx', START + 1), START)).toBe(true)
  expect(isOutput(file('old.docx', START - 1), START)).toBe(false)
  expect(isOutput(file('~$new.docx', START + 1), START)).toBe(false)
})

test('outputFile, newestFirst and openers give the path, the order and the process', () => {
  const made = outputFile('C:\\Work\\audit\\', 'reports/final', file('memo.pdf', 5))
  expect(made).toEqual({ path: 'C:\\Work\\audit/reports/final/memo.pdf', name: 'memo.pdf', folder: 'reports/final', mtimeMs: 5, isDocument: true })
  expect(newestFirst([made, { ...made, name: 'later.pdf', mtimeMs: 9 }]).map(each => each.name)).toEqual(['later.pdf', 'memo.pdf'])
  expect(openers(made.path, true)).toEqual([['cmd', '/c', 'start', '', 'C:\\Work\\audit\\reports\\final\\memo.pdf']])
  expect(openers('/work/memo.pdf', false)).toEqual([
    ['open', '/work/memo.pdf'],
    ['xdg-open', '/work/memo.pdf'],
  ])
})

test('a file written during the session tops the pane after the call that wrote it, and an older one is left out', async ($, on) => {
  const { world, clock } = engineBeneath(on)
  world.folders.set(ROOT, [file('old-plan.docx', START - MINUTE), dir('reports'), dir('.git')])
  world.folders.set(`${ROOT}/reports`, [])
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  await clock.advance(MINUTE)
  world.folders.set(`${ROOT}/reports`, [file('summary.docx', START + MINUTE)])
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/reports/build.py`, content: 'x' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'outputs', surface, component: 'Pane', requestId: 'outputs', props: PANE })
    expect((await pane.find({ key: 'doc-open-0' }))?.text).toContain('summary.docx')
    expect(await pane.find({ type: 'Text', text: 'old-plan.docx' })).toBeUndefined()
    expect(await pane.find({ key: 'doc-open-1' })).toBeUndefined()
    await pane.unmount()
  }
  expect(world.listed).not.toContain(`${ROOT}/.git`)
})

test('a script and a document from one turn show as a document line and one folded line of other files', async ($, on) => {
  const { world, clock } = engineBeneath(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.advance(MINUTE)
  world.folders.set(ROOT, [file('build.py', START + 10), file('chart.png', START + 20), file('summary.docx', START + 30)])
  await $.turn.complete(DONE)

  const pane = await $.ui.mount({ plugin: 'outputs', surface: 'terminal', component: 'Pane', requestId: 'outputs', props: PANE })
  expect((await pane.find({ key: 'doc-open-0' }))?.text).toContain('summary.docx')
  expect((await pane.find({ key: 'other' }))?.text).toContain('2 other files')
  expect(await pane.find({ key: 'other-open-0' })).toBeUndefined()

  await pane.press({ key: 'other' })
  expect((await pane.find({ key: 'other-open-0' }))?.text).toContain('chart.png')
  expect((await pane.find({ key: 'other-open-1' }))?.text).toContain('build.py')
  await pane.unmount()
})

test('clicking a file starts the process that opens it, and copy puts its path on the clipboard', async ($, on) => {
  const { world, clock } = engineBeneath(on, { os: 'Windows_NT' })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.advance(MINUTE)
  world.folders.set(ROOT, [file('summary.docx', START + 30)])
  await $.turn.complete(DONE)

  const pane = await $.ui.mount({ plugin: 'outputs', surface: 'terminal', component: 'Pane', requestId: 'outputs', props: PANE })
  await pane.press({ key: 'doc-open-0' })
  expect(world.runs).toEqual([['cmd', '/c', 'start', '', '\\work\\audit\\summary.docx']])
  await pane.press({ key: 'doc-copy-0' })
  expect(world.copied).toEqual(['\\work\\audit\\summary.docx'])
  expect(world.toasts).toEqual(['Copied the path of summary.docx.'])
  await pane.unmount()
})

test('/outputs opens the pane in front with the keyboard and lists afresh; nothing opens it unasked', async ($, on) => {
  const { world, clock } = engineBeneath(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.advance(MINUTE)
  world.folders.set(ROOT, [file('summary.docx', START + 30)])
  await $.turn.complete(DONE)
  expect(world.opened).toEqual([])

  const ran = await $.command.run({ command: 'outputs', args: '', ...COMPOSER })
  expect(ran.text).toBe('Outputs pane opened.')
  expect(world.opened).toEqual([{ id: 'outputs', focus: true }])
})

test('a scan stops at its bound in a huge folder and the pane says so', async ($, on) => {
  const { world, clock } = engineBeneath(on)
  world.isEndless = true
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.advance(MINUTE)
  await $.turn.complete(DONE)
  expect(world.listed.length).toBeLessThanOrEqual(300)

  const pane = await $.ui.mount({ plugin: 'outputs', surface: 'terminal', component: 'Pane', requestId: 'outputs', props: PANE })
  expect(await pane.find({ type: 'Text', text: 'This folder is large: only part of it was looked through.' })).toBeDefined()
  await pane.unmount()
})

test('in a headless session nothing is listed, opened or shown', async ($, on) => {
  const { world, clock } = engineBeneath(on, { surfaces: [] })
  world.folders.set(ROOT, [file('summary.docx', START + 30)])
  await $.session.start({ cwd: ROOT, surface: null, isInteractive: false })
  await clock.advance(MINUTE)
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/summary.docx`, content: 'x' })
  await $.turn.complete(DONE)
  expect(world.listed).toEqual([])
  expect(world.opened).toEqual([])
  expect(world.runs).toEqual([])
  expect(world.toasts).toEqual([])
})
