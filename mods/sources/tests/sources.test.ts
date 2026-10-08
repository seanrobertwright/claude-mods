import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

import { fullPath, grouped, isUnder, normal, parseRequest, reached, rootOf, shown, withSource } from '../hooks/paths'

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

/** mod-settings' command as the session's command list shows it. */
const MOD_SETTINGS = { name: 'mod-settings', description: 'Open the mod settings dialog', source: 'plugin' } as const

/**
 * The engine beneath the mod: the reads that got through, and the panes it opened.
 * `landing` is the file system: each path that exists and where it lands; any other path is missing.
 */
function engineBeneath(on: On, surfaces: readonly RenderSurface[] = ['terminal'], landing: Readonly<Record<string, string>> = {}) {
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
  on('tool.call', { tool: 'Glob' }, (_$, e) => {
    ran.push(`Glob ${e.path ?? '.'} ${e.pattern}`)
    return { result: { durationMs: 0, numFiles: 0, filenames: [], truncated: false } }
  })
  on('tool.call', { tool: 'Grep' }, (_$, e) => {
    ran.push(`Grep ${e.path ?? '.'} ${e.pattern}`)
    return { result: { numFiles: 0, filenames: [] } }
  })
  on('fs.stat', (_$, e) => {
    // The engine hands the path over in the machine's own spelling; the test keeps one.
    const path = e.path.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')
    const realPath = Object.hasOwn(landing, path) ? landing[path] : undefined
    // A path that leads nowhere comes back without realPath, as the engine answers one it cannot resolve.
    return { value: { kind: 'file', size: 0, mtimeMs: 0, isLink: realPath !== undefined && realPath !== path, ...(e.resolve && realPath !== undefined ? { realPath } : {}) } }
  })
  return { ran, opened, clock }
}

async function locked($: Engine) {
  const pane = await $.ui.mount({ plugin: 'sources', surface: 'terminal', component: 'Pane', requestId: 'sources', props: PANE })
  await pane.press({ key: 'lock' })
  return pane
}

test('paths compare whatever their slashes and case, and a relative one is under the project folder', () => {
  expect(fullPath('notes\\plan.md', 'C:\\Work\\audit')).toBe('C:/Work/audit/notes/plan.md')
  expect(fullPath(PERMIT, ROOT)).toBe('N:/RECORDS/Permits/2026/permit.pdf')
  expect(isUnder('c:/work/AUDIT/notes/plan.md', 'C:\\Work\\audit\\')).toBe(true)
  expect(isUnder('C:/Work/audit-old/plan.md', 'C:/Work/audit')).toBe(false)
  expect(isUnder('C:/Work/audit', 'C:/Work/audit')).toBe(true)
})

test('a path is compared where its . and .. segments lead, never above a drive, share or root', () => {
  expect(fullPath('E:\\Projects\\claude-mods\\..\\other\\secret.txt', 'E:\\Projects\\claude-mods')).toBe('E:/Projects/other/secret.txt')
  expect(fullPath('../..', 'E:/Projects/claude-mods')).toBe('E:/')
  expect(fullPath('./sub/../plan.md', ROOT)).toBe('/work/audit/plan.md')
  expect(normal('C:/..')).toBe('C:/')
  expect(normal('/../etc/passwd')).toBe('/etc/passwd')
  expect(normal('\\\\server\\share\\..\\..\\x')).toBe('//server/share/x')
  expect(normal('../x/./y/')).toBe('../x/y')
  expect(isUnder(`${ROOT}/../x`, ROOT)).toBe(false)
  expect(isUnder(`${ROOT}/sub/../file.md`, ROOT)).toBe(true)
  expect(isUnder('C:/Work/audit/../audit-old/plan.md', 'C:/Work/audit')).toBe(false)
})

test('reached names the file Read takes, and the folder Grep or Glob searches and where its pattern starts', () => {
  expect(reached('Read', { file_path: `${ROOT}/../x` }, ROOT)).toEqual({ kind: 'places', places: ['/work/x'] })
  expect(reached('Grep', { pattern: 'a/../b', path: '..' }, ROOT)).toEqual({ kind: 'places', places: ['/work'] })
  expect(reached('Glob', { pattern: '**/*.md' }, ROOT)).toEqual({ kind: 'places', places: [ROOT, ROOT] })
  expect(reached('Glob', { pattern: '../**' }, ROOT)).toEqual({ kind: 'places', places: [ROOT, '/work'] })
  expect(reached('Glob', { pattern: 'sub/../notes/*.md', path: ROOT }, ROOT)).toEqual({ kind: 'places', places: [ROOT, `${ROOT}/notes`] })
  expect(reached('Glob', { pattern: 'N:\\RECORDS\\**\\*.pdf' }, ROOT)).toEqual({ kind: 'places', places: [ROOT, 'N:/RECORDS'] })
  expect(reached('Glob', { pattern: '/**' }, ROOT)).toEqual({ kind: 'places', places: [ROOT, '/'] })
  expect(reached('Grep', { pattern: 'x', glob: '../*.md' }, ROOT)).toEqual({ kind: 'places', places: [ROOT, '/work'] })
  // A .. after a wildcard, or inside braces, has no one folder it stays under.
  expect(reached('Glob', { pattern: '**/../../x' }, ROOT)).toEqual({ kind: 'unplaced', spelling: '**/../../x' })
  expect(reached('Glob', { pattern: '{..,notes}/*.md' }, ROOT)).toEqual({ kind: 'unplaced', spelling: '{..,notes}/*.md' })
  // The tool takes ~ as the home folder and D:x from that drive's own current folder.
  expect(reached('Read', { file_path: '~/.ssh/id_rsa' }, ROOT)).toEqual({ kind: 'unplaced', spelling: '~/.ssh/id_rsa' })
  expect(reached('Read', { file_path: 'D:secret.txt' }, ROOT)).toEqual({ kind: 'unplaced', spelling: 'D:secret.txt' })
  expect(reached('Read', { file_path: '~$plan.docx' }, ROOT)).toEqual({ kind: 'places', places: [`${ROOT}/~$plan.docx`] })
})

test('grouped lists a path that climbs out under its own root, and one that only looks like it under the project folder', () => {
  const held = [{ path: `${ROOT}/../other/x.md`, at: 2 }, { path: `${ROOT}/sub/../plan.md`, at: 1 }]
  expect(grouped(held, ROOT).map(group => [group.label, group.sources.length])).toEqual([
    ['This folder', 1],
    ['/work/other', 1],
  ])
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

test('with the lock on a read or search that climbs out with .. is refused, and one that climbs back in goes through', async ($, on) => {
  const { ran } = engineBeneath(on)
  const pane = await locked($)

  const read = await $.tool.call({ tool: 'Read', file_path: `${ROOT}/../other/secret.txt` })
  expect(read.deny).toContain('/work/other/secret.txt is outside it')
  expect(read.deny).toContain('/sources allow <path>')
  expect((await $.tool.call({ tool: 'Grep', pattern: 'password', path: '..' })).deny).toContain('/work is outside it')
  expect((await $.tool.call({ tool: 'Glob', pattern: '*.md', path: '../..' })).deny).toContain('/ is outside it')
  expect((await $.tool.call({ tool: 'Glob', pattern: '../**/*.md' })).deny).toContain('/work is outside it')
  expect((await $.tool.call({ tool: 'Glob', pattern: '/home/sam/**' })).deny).toContain('/home/sam is outside it')
  expect((await $.tool.call({ tool: 'Glob', pattern: 'notes/**/../../../x' })).deny).toContain('notes/**/../../../x is outside it')
  expect((await $.tool.call({ tool: 'Read', file_path: '~/.ssh/id_rsa' })).deny).toContain('~/.ssh/id_rsa is outside it')
  expect(ran).toEqual([])

  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/sub/../plan.md` })
  await $.tool.call({ tool: 'Glob', pattern: 'sub/../notes/*.md' })
  // A regex is not a path, so Grep's pattern is never taken for one.
  await $.tool.call({ tool: 'Grep', pattern: '\\.\\./', path: 'notes' })
  expect(ran).toEqual([`${ROOT}/sub/../plan.md`, 'Glob . sub/../notes/*.md', 'Grep notes \\.\\./'])
  expect(await pane.find({ type: 'Text', text: 'This folder  3' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '  plan.md' })).toBeDefined()
  await pane.unmount()
})

test('with the lock on a path under an allowed folder that climbs out of it is refused', async ($, on) => {
  const { ran } = engineBeneath(on)
  const pane = await locked($)
  const allowed = await $.command.run({ command: 'sources', args: 'allow N:\\RECORDS\\Permits\\2026\\..', ...COMPOSER })
  expect(allowed.text).toBe('Reads are allowed in N:/RECORDS/Permits for this session.')

  expect((await $.tool.call({ tool: 'Read', file_path: 'N:\\RECORDS\\Permits\\..\\Payroll\\2026.xlsx' })).deny).toContain('N:/RECORDS/Payroll/2026.xlsx is outside it')
  await $.tool.call({ tool: 'Read', file_path: 'N:/RECORDS/Permits/../Permits/2026/permit.pdf' })
  expect(ran).toEqual(['N:/RECORDS/Permits/../Permits/2026/permit.pdf'])
  expect(await pane.find({ type: 'Text', text: 'N:/RECORDS/Permits  1' })).toBeDefined()
  await pane.unmount()
})

test('with the lock on a link inside the project folder is judged by where it lands', async ($, on) => {
  const { ran } = engineBeneath(on, ['terminal'], {
    [ROOT]: '/data/audit',
    [`${ROOT}/plan.md`]: '/data/audit/plan.md',
    [`${ROOT}/linked/secret.txt`]: '/home/sam/secret.txt',
    [`${ROOT}/linked`]: '/home/sam',
  })
  const pane = await locked($)

  expect((await $.tool.call({ tool: 'Read', file_path: 'linked/secret.txt' })).deny).toContain('/home/sam/secret.txt is outside it')
  expect((await $.tool.call({ tool: 'Grep', pattern: 'x', path: 'linked' })).deny).toContain('/home/sam is outside it')
  expect((await $.tool.call({ tool: 'Glob', pattern: 'linked/**' })).deny).toContain('/home/sam is outside it')
  // The project folder is itself a link: what lands inside it, or is not there yet, goes through.
  await $.tool.call({ tool: 'Read', file_path: 'plan.md' })
  await $.tool.call({ tool: 'Read', file_path: 'drafts/new.md' })
  expect(ran).toEqual(['plan.md', 'drafts/new.md'])
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

test('the header draws the settings gear only while mod-settings is installed, and the gear runs /mod-settings', async ($, on) => {
  engineBeneath(on)
  let commands: (typeof MOD_SETTINGS)[] = [MOD_SETTINGS]
  on('command.list', () => ({ value: commands }))
  const ran: string[] = []
  on('command.run', { command: 'mod-settings' }, (_$, e) => {
    ran.push(e.command)
    return { text: 'Mod settings opened.' }
  })

  const pane = await $.ui.mount({ plugin: 'sources', surface: 'terminal', component: 'Pane', requestId: 'sources', props: PANE })
  expect((await pane.find({ key: 'mod-settings' }))?.props.label).toBe('⚙')
  await pane.press({ key: 'mod-settings' })
  expect(ran).toEqual(['mod-settings'])

  commands = []
  await pane.redraw()
  expect(await pane.find({ key: 'mod-settings' })).toBeUndefined()
  await pane.unmount()
})
