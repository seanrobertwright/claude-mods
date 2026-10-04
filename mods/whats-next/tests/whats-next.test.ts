import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { buildAsk, DENIED_TOOLS, parseConfig, parseSteps, READ_ONLY_TOOLS } from '../hooks/parse'

const FENCE = '```'

const REPLY = [
  '### Push the auth branch and open its PR',
  'Two commits sit unpushed on feat/auth; nothing else can merge before it.',
  'Prompt =',
  FENCE,
  '/implement GitHub issue #52',
  'Branch from main.',
  FENCE,
  '',
  '### 2. **Triage incoming bugs**',
  'Three new issues arrived overnight.',
  'Prompt =',
  FENCE,
  '/triage',
  FENCE,
].join('\r\n')

const PANE_PROPS = {
  title: "What's next",
  isFocused: false,
  bodyColumns: 40,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

test('parseSteps splits a reply into titled steps with their prompts', () => {
  const steps = parseSteps(REPLY, 5)
  expect(steps).toEqual([
    {
      title: 'Push the auth branch and open its PR',
      why: 'Two commits sit unpushed on feat/auth; nothing else can merge before it.',
      prompt: '/implement GitHub issue #52\nBranch from main.',
    },
    { title: 'Triage incoming bugs', why: 'Three new issues arrived overnight.', prompt: '/triage' },
  ])
  expect(parseSteps(REPLY, 1).length).toBe(1)
})

test("parseSteps falls back to the skill's single untagged prompt", () => {
  const steps = parseSteps(['Do this next.', 'Prompt =', FENCE, '/to-tickets from the spec', FENCE].join('\n'), 5)
  expect(steps).toEqual([{ title: '/to-tickets from the spec', why: '', prompt: '/to-tickets from the spec' }])
  expect(parseSteps('Nothing to do.', 5)).toEqual([])
})

test('parseConfig rejects out-of-range options', () => {
  const config = parseConfig({ skill: 'ask-sean; rm', maxSteps: 40, allowedTools: ' , ', model: 'bad model' })
  expect(config.skill).toBe('/ask-sean')
  expect(config.maxSteps).toBe(5)
  expect(config.allowedTools).toEqual([...READ_ONLY_TOOLS])
  expect(config.model).toBe('')
  expect(buildAsk('/ask-sean', 3).startsWith('/ask-sean ')).toBe(true)
  expect(parseConfig({ allowedTools: 'Read, Bash(git log:*)' }).allowedTools).toEqual(['Read', 'Bash(git log:*)'])
})

test('the default rules allow no blanket git or gh access', () => {
  for (const rule of READ_ONLY_TOOLS) {
    expect(rule === 'Bash(git:*)' || rule === 'Bash(gh:*)' || rule.startsWith('Bash(git push')).toBe(false)
  }
  expect(DENIED_TOOLS).toContain('Bash(git push:*)')
  expect(DENIED_TOOLS).toContain('Bash(gh api:*)')
})

test('refresh lists the steps and a press opens the prompt popup', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  mock.store(on)
  mock.env(on, {})
  on('session.cwd', () => ({ value: '/work/repo' }))
  const opened: string[] = []
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  const filled: string[] = []
  on('prompt.fill', (_$, e) => {
    filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  const runs: (readonly string[])[] = []
  on('process.run', (_$, e) => {
    runs.push(e.argv)
    const isGit = e.argv[0] === 'git'
    return {
      value: {
        exitCode: 0,
        stdout: isGit ? 'true\n' : REPLY,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({
      plugin: 'whats-next',
      surface,
      component: 'Pane',
      requestId: 'whats-next',
      props: PANE_PROPS,
    })
    await pane.press({ key: 'refresh' })
    expect((await pane.find({ key: 'open-1' }))?.text).toContain('Push the auth branch')
    expect((await pane.find({ key: 'open-2' }))?.text).toContain('Triage incoming bugs')

    await pane.press({ key: 'open-2' })
    const popup = await $.ui.mount({
      plugin: 'whats-next',
      surface,
      component: 'Pane',
      requestId: 'whats-next-prompt',
      props: { ...PANE_PROPS, title: 'Triage incoming bugs' },
    })
    expect(await popup.find({ type: 'Text', text: '/triage' })).toBeDefined()
    await popup.press({ key: 'paste' })
    expect(filled[filled.length - 1]).toBe('/triage')
    await popup.unmount()
    await pane.unmount()
  }

  expect(opened).toContain('whats-next-prompt')
  const claudeRun = runs.find(argv => argv[0] === 'claude')
  expect(claudeRun).toContain('dontAsk')
  expect(claudeRun).toContain('Bash(git log:*)')
  expect(claudeRun).not.toContain('Bash(git:*)')
  expect(claudeRun).toContain('Bash(git push:*)')
  const sources = claudeRun?.indexOf('--setting-sources') ?? -1
  expect(claudeRun?.[sources + 1]).toBe('user')
  // Every deny rule follows --disallowedTools, after the allow list.
  expect(claudeRun?.indexOf('--disallowedTools') ?? -1).toBeGreaterThan(claudeRun?.indexOf('--allowedTools') ?? 0)
})

const DESKTOP = { surface: 'desktop', clientId: 'desktop:default', viewport: { columns: 200, rows: 50, isFullscreen: true } } as const
const PHONE = { surface: 'mobile', clientId: 'mobile:default', viewport: { columns: 40, rows: 60, isFullscreen: false } } as const

/**
 * The engine beneath the plugin for a session's life: the surfaces showing it
 * (the test edits the list), every pane opened and every process run, with
 * git answering whether the folder is a repo and claude answering REPLY.
 */
type World = { surfaces: string[]; opened: string[]; runs: (readonly string[])[]; isGitRepo: boolean }

function fakeSession(on: On, world: World): void {
  mock.store(on)
  mock.env(on, {})
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  on('session.cwd', () => ({ value: '/work/repo' }))
  on('session.surfaces', () => ({ value: [...world.surfaces] as never }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', (_$, e) => {
    world.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('process.run', (_$, e) => {
    world.runs.push(e.argv)
    const isGit = e.argv[0] === 'git'
    const exitCode = isGit && !world.isGitRepo ? 128 : 0
    return { value: { exitCode, stdout: isGit ? 'true\n' : REPLY, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

const isHeadlessRun = (argv: readonly string[]) => argv[0] === 'claude'
const HEADLESS_START = { cwd: '/work/repo', surface: null, isInteractive: false } as const

test('a headless session opens no pane and starts no headless run', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world: World = { surfaces: [], opened: [], runs: [], isGitRepo: true }
  fakeSession(on, world)

  await $.session.start(HEADLESS_START)
  await clock.settle()
  expect(world.runs.filter(isHeadlessRun)).toEqual([])
  expect(world.opened).toEqual([])
})

test('the first attach refreshes once and opens the pane where it docks', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world: World = { surfaces: [], opened: [], runs: [], isGitRepo: true }
  fakeSession(on, world)

  await $.session.start(HEADLESS_START)
  await clock.settle()
  expect(world.runs).toEqual([])
  world.surfaces.push('desktop')
  await $.session.attach(DESKTOP)
  await clock.settle()
  expect(world.runs.filter(isHeadlessRun).length).toBe(1)
  expect(world.opened).toEqual(['whats-next'])

  world.surfaces.push('mobile')
  await $.session.attach(PHONE)
  await clock.settle()
  expect(world.runs.filter(isHeadlessRun).length).toBe(1)
  expect(world.opened).toEqual(['whats-next'])
})

test('a phone attaching first refreshes but waits for /whats-next to open the pane', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world: World = { surfaces: [], opened: [], runs: [], isGitRepo: true }
  fakeSession(on, world)

  await $.session.start(HEADLESS_START)
  world.surfaces.push('mobile')
  await $.session.attach(PHONE)
  await clock.settle()
  expect(world.runs.filter(isHeadlessRun).length).toBe(1)
  expect(world.opened).toEqual([])

  await $.command.run({ command: 'whats-next', args: '', origin: { kind: 'bridge' }, presentation: { isFullscreen: false, columns: 40 } })
  expect(world.opened).toEqual(['whats-next'])
})

test('attaching outside a git repo starts no headless run', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world: World = { surfaces: [], opened: [], runs: [], isGitRepo: false }
  fakeSession(on, world)

  await $.session.start(HEADLESS_START)
  world.surfaces.push('desktop')
  await $.session.attach(DESKTOP)
  await clock.settle()
  expect(world.runs.filter(isHeadlessRun)).toEqual([])
  expect(world.opened).toEqual(['whats-next'])
})

test('attaching with refresh on start turned off starts no headless run', { options: { refreshOnStart: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world: World = { surfaces: [], opened: [], runs: [], isGitRepo: true }
  fakeSession(on, world)

  await $.session.start(HEADLESS_START)
  world.surfaces.push('desktop')
  await $.session.attach(DESKTOP)
  await clock.settle()
  expect(world.runs.filter(isHeadlessRun)).toEqual([])
  expect(world.opened).toEqual(['whats-next'])
})
