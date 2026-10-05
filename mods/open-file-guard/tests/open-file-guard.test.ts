import { expect, test } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

import { lockPaths, officeFile, officeFilesIn } from '../hooks/office'

const DECK = 'C:\\Work\\Audit Summary.pptx'
const DECK_LOCK = 'C:\\Work\\~$Audit Summary.pptx'

/** The world beneath the mod: which lock files exist, what the person answers, and the calls that got through. */
type World = { locks: Set<string>; answers: string[]; asked: string[]; ran: string[]; isStuck: boolean }

function engineBeneath(on: On, surfaces: readonly RenderSurface[] = ['terminal']): World {
  const world: World = { locks: new Set(), answers: [], asked: [], ran: [], isStuck: false }
  on('session.surfaces', () => ({ value: surfaces }))
  on('fs.exists', (_$, e) => ({ value: world.locks.has(e.path) }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const question = e.questions[0]?.question ?? ''
    world.asked.push(question)
    const answer = world.answers.shift()
    // No answer left stands for the person dismissing the dialog.
    if (answer === undefined) return { deny: 'dismissed' }
    // Answering "I closed it" is the person closing the file, unless the test keeps it open.
    if (answer === 'I closed it' && !world.isStuck) world.locks.clear()
    return { result: { questions: e.questions, answers: { [question]: answer } } }
  })
  on('tool.call', { tool: 'Write' }, (_$, e) => {
    world.ran.push(e.file_path)
    return { result: { type: 'create', filePath: e.file_path, content: e.content, structuredPatch: [], originalFile: null } }
  })
  on('tool.call', { tool: 'PowerShell' }, (_$, e) => {
    world.ran.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  return world
}

test('officeFile reads the folder, the name and the application, and passes over what is not one file', () => {
  expect(officeFile(DECK)).toEqual({ path: DECK, folder: 'C:\\Work\\', name: 'Audit Summary.pptx', app: 'PowerPoint' })
  expect(officeFile('/c/Work/plan.DOCX')).toEqual({ path: 'c:/Work/plan.DOCX', folder: 'c:/Work/', name: 'plan.DOCX', app: 'Word' })
  expect(officeFile('grid.xlsx')?.folder).toBe('')
  expect(officeFile('notes.md')).toBeUndefined()
  expect(officeFile('out/*.docx')).toBeUndefined()
  expect(officeFile('$OUT/report.docx')).toBeUndefined()
  expect(officeFile('C:\\Work\\~$plan.docx')).toBeUndefined()
})

test('officeFilesIn finds quoted and bare paths in a command, each once', () => {
  const command = `python build.py --out "${DECK}" && cp 'my grid.xlsx' backup/grid.xlsx; echo "${DECK}"`
  expect(officeFilesIn(command).map(file => file.path)).toEqual([DECK, 'my grid.xlsx', 'backup/grid.xlsx'])
  expect(officeFilesIn('python build.py && ls')).toEqual([])
})

test('lockPaths gives the one lock Excel and PowerPoint leave and the three forms Word may', () => {
  expect(lockPaths(officeFile(DECK)!)).toEqual([DECK_LOCK])
  expect(lockPaths(officeFile('C:\\Work\\Procedure.docx')!)).toEqual([
    'C:\\Work\\~$Procedure.docx',
    'C:\\Work\\~$rocedure.docx',
    'C:\\Work\\~$ocedure.docx',
  ])
})

test('a call that names no open Office file is not asked about', async ($, on) => {
  const world = engineBeneath(on)
  await $.tool.call({ tool: 'Write', file_path: DECK, content: 'x' })
  await $.tool.call({ tool: 'PowerShell', command: 'python build.py' })
  expect(world.asked).toEqual([])
  expect(world.ran).toEqual([DECK, 'python build.py'])
})

test('an open file is asked about by name, and the call goes on once the person has closed it', async ($, on) => {
  const world = engineBeneath(on)
  world.locks.add(DECK_LOCK)
  world.answers.push('I closed it')
  const ran = await $.tool.call({ tool: 'PowerShell', command: `python build.py "${DECK}"` })
  expect(world.asked.length).toBe(1)
  expect(world.asked[0]).toContain('"Audit Summary.pptx" is open in PowerPoint')
  expect(ran.deny).toBeUndefined()
  expect(world.ran).toEqual([`python build.py "${DECK}"`])
})

test('a dismissed question refuses the call with a reason that names the file', async ($, on) => {
  const world = engineBeneath(on)
  world.locks.add(DECK_LOCK)
  const ran = await $.tool.call({ tool: 'Write', file_path: DECK, content: 'x' })
  expect(ran.deny).toContain('"Audit Summary.pptx" is open in PowerPoint')
  expect(world.ran).toEqual([])
})

test('"Go ahead anyway" lets the call on and is not asked again for that file in the turn', async ($, on) => {
  const world = engineBeneath(on)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  world.locks.add(DECK_LOCK)
  world.answers.push('Go ahead anyway', 'Go ahead anyway')
  await $.tool.call({ tool: 'PowerShell', command: `python read.py "${DECK}"` })
  await $.tool.call({ tool: 'PowerShell', command: `python read.py "${DECK}"` })
  expect(world.asked.length).toBe(1)
  expect(world.ran.length).toBe(2)

  // The next turn asks afresh.
  await $.turn.complete({ answer: 'Done.', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.tool.call({ tool: 'PowerShell', command: `python read.py "${DECK}"` })
  expect(world.asked.length).toBe(2)
})

test('a file still open after "I closed it" is asked about again, then refused', async ($, on) => {
  const world = engineBeneath(on)
  world.locks.add(DECK_LOCK)
  world.isStuck = true
  world.answers.push('I closed it', 'I closed it', 'I closed it')
  const ran = await $.tool.call({ tool: 'Write', file_path: DECK, content: 'x' })
  expect(world.asked.length).toBe(3)
  expect(world.asked[1]).toContain('still open')
  expect(ran.deny).toContain('Ask the person to close it')
  expect(world.ran).toEqual([])
})

test('in a headless session nothing is asked and the call goes on', async ($, on) => {
  const world = engineBeneath(on, [])
  world.locks.add(DECK_LOCK)
  await $.tool.call({ tool: 'Write', file_path: DECK, content: 'x' })
  expect(world.asked).toEqual([])
  expect(world.ran).toEqual([DECK])
})
