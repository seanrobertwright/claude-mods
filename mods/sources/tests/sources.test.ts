import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

import { fullPath, grouped, isUnder, parseRequest, rootOf, shown, withSource } from '../hooks/paths'

const ROOT = '/work/audit'
const PERMIT = 'N:\\RECORDS\\Permits\\2026\\permit.pdf'

const PANE = {
  title: 'Sources',
  isFocused: false,
  bodyColumns: 50,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

const COMPOSER = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 60 } } as const

/** The engine beneath the mod: the reads that got through, and the panes it opened. */
function engineBeneath(on: On, surfaces: readonly RenderSurface[] = ['terminal']) {
  const ran: string[] = []
  const opened: { id: string; focus: boolean }[] = []
  const clock = mock.clock(on, { now: 1_000 })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.surfaces', () => ({ value: surfaces }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', (_$, e) => {
    opened.push({ id: e.id, focus: e.focus === true })
    return { value: { isPlaced: true } }
  })
  on('tool.call', { tool: 'Read' }, (_$, e) => {
    ran.push(e.file_path)
    return { result: { type: 'text', file: { filePath: e.file_path, content: '', numLines: 0, startLine: 1, totalLines: 0 } } }
  })
  return { ran, opened, clock }
}

test('paths compare whatever their slashes and case, and a relative one is under the project folder', () => {
  expect(fullPath('notes\\plan.md', 'C:\\Work\\audit')).toBe('C:/Work/audit/notes/plan.md')
  expect(fullPath(PERMIT, ROOT)).toBe('N:/RECORDS/Permits/2026/permit.pdf')
  expect(isUnder('c:/work/AUDIT/notes/plan.md', 'C:\\Work\\audit\\')).toBe(true)
  expect(isUnder('C:/Work/audit-old/plan.md', 'C:/Work/audit')).toBe(false)
  expect(isUnder('C:/Work/audit', 'C:/Work/audit')).toBe(true)
})

test('rootOf names a drive or share with its first two folders', () => {
  expect(rootOf(PERMIT)).toBe('N:/RECORDS/Permits')
  expect(rootOf('N:\\top.pdf')).toBe('N:')
  expect(rootOf('\\\\server\\share\\a\\b\\c\\file.docx')).toBe('//server/share/a/b')
  expect(rootOf('/home/sam/kb/raw/permit.md')).toBe('/home/sam')
})

test('sources keep each path once, newest first, and group the project folder first', () => {
  const held = withSource(withSource(withSource([], '/work/audit/a.md', 1), 'N:/RECORDS/Permits/p.pdf', 2), '/work/audit/A.md', 3)
  expect(held).toEqual([
    { path: '/work/audit/A.md', at: 3 },
    { path: 'N:/RECORDS/Permits/p.pdf', at: 2 },
  ])
  expect(grouped(held, ROOT).map(group => [group.label, group.sources.length])).toEqual([
    ['This folder', 1],
    ['N:/RECORDS/Permits', 1],
  ])
  expect(shown('/work/audit/notes/plan.md', ROOT, 40)).toBe('notes/plan.md')
  expect(shown('/work/audit/notes/a-very-long-file-name.md', ROOT, 12)).toBe('…ile-name.md')
})

test('parseRequest reads open, the allowed list, allow with a path, and anything else as usage', () => {
  expect(parseRequest('')).toEqual({ kind: 'open' })
  expect(parseRequest('allow')).toEqual({ kind: 'allowed' })
  expect(parseRequest('allow "N:\\RECORDS\\Permits and Plans"')).toEqual({ kind: 'allow', path: 'N:\\RECORDS\\Permits and Plans' })
  expect(parseRequest('lock')).toEqual({ kind: 'usage' })
})

test('reads from the project folder and from another drive show under two groups with their counts', async ($, on) => {
  const { clock } = engineBeneath(on)
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/plan.md` })
  await clock.advance(1_000)
  await $.tool.call({ tool: 'Read', file_path: 'notes/gaps.md' })
  await clock.advance(1_000)
  await $.tool.call({ tool: 'Read', file_path: PERMIT })

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'sources', surface, component: 'Pane', requestId: 'sources', props: PANE })
    expect(await pane.find({ type: 'Text', text: 'This folder  2' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'N:/RECORDS/Permits  1' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '  notes/gaps.md' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '  2026/permit.pdf' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Reads: anywhere' })).toBeDefined()
    await pane.unmount()
  }
})

test('with the lock on a read outside the project folder is refused with the reason, and one inside goes through', async ($, on) => {
  const { ran } = engineBeneath(on)
  const pane = await $.ui.mount({ plugin: 'sources', surface: 'terminal', component: 'Pane', requestId: 'sources', props: PANE })
  await pane.press({ key: 'lock' })
  expect(await pane.find({ type: 'Text', text: 'Reads: this folder only' })).toBeDefined()

  const outside = await $.tool.call({ tool: 'Read', file_path: PERMIT })
  expect(outside.deny).toContain('N:/RECORDS/Permits/2026/permit.pdf is outside it')
  expect(outside.deny).toContain('/sources allow <path>')
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/plan.md` })
  expect(ran).toEqual([`${ROOT}/plan.md`])
  // A refused read is not a source.
  expect(await pane.find({ type: 'Text', text: 'N:/RECORDS/Permits  1' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: 'This folder  1' })).toBeDefined()

  await pane.press({ key: 'lock' })
  await $.tool.call({ tool: 'Read', file_path: PERMIT })
  expect(ran).toEqual([`${ROOT}/plan.md`, PERMIT])
  await pane.unmount()
})

test('after /sources allow a read under that folder goes through with the lock on', async ($, on) => {
  const { ran } = engineBeneath(on)
  const pane = await $.ui.mount({ plugin: 'sources', surface: 'terminal', component: 'Pane', requestId: 'sources', props: PANE })
  await pane.press({ key: 'lock' })
  expect((await $.command.run({ command: 'sources', args: 'allow', ...COMPOSER })).text).toBe('No folder outside the project folder is allowed.')

  const allowed = await $.command.run({ command: 'sources', args: 'allow N:\\RECORDS\\Permits', ...COMPOSER })
  expect(allowed.text).toBe('Reads are allowed in N:/RECORDS/Permits for this session.')
  await $.tool.call({ tool: 'Read', file_path: PERMIT })
  expect(ran).toEqual([PERMIT])
  expect((await $.tool.call({ tool: 'Read', file_path: 'N:\\RECORDS\\Other\\x.pdf' })).deny).toBeDefined()
  expect((await $.command.run({ command: 'sources', args: 'allow', ...COMPOSER })).text).toContain('N:/RECORDS/Permits')
  await pane.unmount()
})

test('/sources opens the pane in front with the keyboard, and nothing opens it unasked', async ($, on) => {
  const { opened } = engineBeneath(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: PERMIT })
  expect(opened).toEqual([])
  const ran = await $.command.run({ command: 'sources', args: '', ...COMPOSER })
  expect(ran.text).toBe('Sources pane opened.')
  expect(opened).toEqual([{ id: 'sources', focus: true }])
  expect((await $.command.run({ command: 'sources', args: 'frobnicate', ...COMPOSER })).text).toContain('Usage:')
})

test('in a headless session a read goes through, nothing is kept and nothing opens', async ($, on) => {
  const { ran, opened } = engineBeneath(on, [])
  await $.session.start({ cwd: ROOT, surface: null, isInteractive: false })
  await $.tool.call({ tool: 'Read', file_path: PERMIT })
  expect(ran).toEqual([PERMIT])
  expect(opened).toEqual([])
  const pane = await $.ui.mount({ plugin: 'sources', surface: 'terminal', component: 'Pane', requestId: 'sources', props: PANE })
  expect(await pane.find({ type: 'Text', text: 'Nothing read yet this session.' })).toBeDefined()
  await pane.unmount()
})
