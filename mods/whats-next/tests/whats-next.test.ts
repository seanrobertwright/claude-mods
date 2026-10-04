import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  isMissingSkillReply,
  buildAsk,
  buildJudge,
  DENIED_TOOLS,
  isDone,
  matchStep,
  parseCached,
  parseConfig,
  parseSteps,
  READ_ONLY_TOOLS,
  shimmer,
  withIds,
} from '../hooks/parse'

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

/** The configured skill as the session's command list shows a user skill. */
const ASK_SEAN = { name: 'ask-sean', description: "What's next?", source: 'user' } as const

/** A headless run of the skill, as opposed to a quick `claude --version` probe. */
const isHeadlessRun = (argv: readonly string[]) => argv[0] === 'claude' && argv[1] === '-p'

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
  on('command.list', () => ({ value: [ASK_SEAN] }))
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
  const claudeRun = runs.find(isHeadlessRun)
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
  on('command.list', () => ({ value: [ASK_SEAN] }))
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

test('matchStep finds the step a submitted prompt starts, words added after it allowed', () => {
  const steps = parseSteps(REPLY, 5)
  expect(matchStep(steps, '/implement GitHub issue #52\n  Branch from main.')?.title).toBe('Push the auth branch and open its PR')
  expect(matchStep(steps, '/triage and start with the oldest')?.title).toBe('Triage incoming bugs')
  expect(matchStep(steps, 'please /triage')).toBeUndefined()
  expect(matchStep(steps, '')).toBeUndefined()
})

test('isDone reads DONE alone as done, and the judge sees the step and the answer', () => {
  expect(isDone('DONE')).toBe(true)
  expect(isDone(' done.')).toBe(true)
  expect(isDone('NOT_DONE')).toBe(false)
  expect(isDone('DONE, but the implementation failed')).toBe(false)
  expect(isDone('')).toBe(false)
  const ask = buildJudge({ title: 'Triage', why: '', prompt: '/triage' }, 'Triaged all three.')
  expect(ask).toContain('Step: Triage')
  expect(ask).toContain('<message>\nTriaged all three.\n</message>')
})

test('shimmer sweeps a lit band across the line and starts over', () => {
  expect(shimmer('abcdef', 0)).toEqual(['', '', 'abcdef'])
  expect(shimmer('abcdef', 2)).toEqual(['', 'ab', 'cdef'])
  expect(shimmer('abcdef', 5)).toEqual(['ab', 'cde', 'f'])
  expect(shimmer('abcdef', 8)).toEqual(['abcde', 'f', ''])
  expect(shimmer('abcdef', 9)).toEqual(shimmer('abcdef', 0))
})

/** The engine beneath the plugin: the skill's reply, one surface showing, what the judge answers, a store it records. */
function fakeEngine(
  on: On,
  verdicts: string[],
  toasts: string[],
  stored: Map<string, unknown>,
  surfaces = ['terminal'],
  reply = REPLY,
): void {
  on('store.get', (_$, e) => ({ value: stored.get(e.key) }))
  on('store.set', (_$, e) => {
    stored.set(e.key, e.value)
    return { value: undefined }
  })
  mock.env(on, {})
  on('session.cwd', () => ({ value: '/work/repo' }))
  on('session.surfaces', () => ({ value: [...surfaces] as never }))
  on('command.list', () => ({ value: [ASK_SEAN] }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('model.complete', () => ({ value: { isAnswered: true, text: verdicts.shift() ?? 'NOT_DONE', usage: {} as never } }))
  on('process.run', (_$, e) => ({
    value: { exitCode: 0, stdout: e.argv[0] === 'git' ? 'true\n' : reply, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
}

const submit = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as const
const turn = (answer: string) => ({ answer, durationMs: 10, isAborted: false, turnId: 't', reason: 'answer' }) as const

test('a submitted step glows until the judge calls it done, then leaves the list', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const verdicts = ['NOT_DONE', 'DONE']
  const toasts: string[] = []
  const stored = new Map<string, unknown>()
  fakeEngine(on, verdicts, toasts, stored)

  const pane = await $.ui.mount({ plugin: 'whats-next', surface: 'terminal', component: 'Pane', requestId: 'whats-next', props: PANE_PROPS })
  await pane.press({ key: 'refresh' })
  expect(await pane.find({ type: 'Text', text: 'working on it' })).toBeUndefined()

  await $.prompt.submit(submit('/triage'))
  expect(await pane.find({ type: 'Text', text: 'working on it' })).toBeDefined()
  expect(await pane.find({ key: 'done' })).toBeDefined()
  const lit = async () => JSON.stringify((await pane.find({ type: 'Text', text: 'working on it' }))?.children)
  const first = await lit()
  await clock.advance(360)
  expect(await lit()).not.toBe(first)

  await $.turn.complete(turn('Labelled two of the three.'))
  expect((await pane.find({ key: 'open-2' }))?.text).toContain('Triage incoming bugs')

  await $.turn.complete(turn('All three are triaged.'))
  expect(await pane.find({ key: 'open-2' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: 'working on it' })).toBeUndefined()
  expect(toasts).toContain(`What's next: done with "Triage incoming bugs".`)
  const kept = stored.get('list:/work/repo') as { steps: { title: string }[] }
  expect(kept.steps.map(step => step.title)).toEqual(['Push the auth branch and open its PR'])
  await pane.unmount()
})

test('the done button drops the active step', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const verdicts: string[] = []
  const toasts: string[] = []
  fakeEngine(on, verdicts, toasts, new Map())

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'whats-next', surface, component: 'Pane', requestId: 'whats-next', props: PANE_PROPS })
    await pane.press({ key: 'refresh' })
    await $.prompt.submit(submit('/implement GitHub issue #52\nBranch from main.'))
    await pane.press({ key: 'done' })
    expect(await pane.find({ key: 'open-2' })).toBeUndefined()
    expect((await pane.find({ key: 'open-1' }))?.text).toContain('Triage incoming bugs')
    await pane.unmount()
  }
})

test('a headless session never starts a step, so no judge runs there', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const verdicts = ['DONE']
  fakeEngine(on, verdicts, [], new Map(), [])

  const pane = await $.ui.mount({ plugin: 'whats-next', surface: 'terminal', component: 'Pane', requestId: 'whats-next', props: PANE_PROPS })
  await pane.press({ key: 'refresh' })
  await $.prompt.submit(submit('/triage'))
  expect(await pane.find({ type: 'Text', text: 'working on it' })).toBeUndefined()
  await $.turn.complete(turn('All three are triaged.'))
  expect(verdicts).toEqual(['DONE'])
  expect((await pane.find({ key: 'open-2' }))?.text).toContain('Triage incoming bugs')
  await pane.unmount()
})

test('withIds names each step apart, and parseCached names an old or clashing list afresh', () => {
  const drafts = parseSteps(REPLY, 5)
  expect(withIds(drafts, 7).map(step => step.id)).toEqual(['7-1', '7-2'])
  expect(parseCached({ steps: drafts, updatedAt: 9 })?.steps.map(step => step.id)).toEqual(['9-1', '9-2'])
  const clashing = withIds(drafts, 7).map(step => ({ ...step, id: 'same' }))
  expect(parseCached({ steps: clashing, updatedAt: 9 })?.steps.map(step => step.id)).toEqual(['9-1', '9-2'])
  expect(parseCached({ steps: withIds(drafts, 7), updatedAt: 9 })?.steps.map(step => step.id)).toEqual(['7-1', '7-2'])
})

const TWINS = [
  '### Fix the login bug',
  'Users are locked out.',
  'Prompt =',
  FENCE,
  '/triage',
  FENCE,
  '',
  '### Triage the new reports',
  'Two more arrived.',
  'Prompt =',
  FENCE,
  '/triage',
  FENCE,
].join('\n')

test('finishing a step drops only that step, not another with the same prompt', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const verdicts = ['DONE']
  const stored = new Map<string, unknown>()
  fakeEngine(on, verdicts, [], stored, ['terminal'], TWINS)

  const pane = await $.ui.mount({ plugin: 'whats-next', surface: 'terminal', component: 'Pane', requestId: 'whats-next', props: PANE_PROPS })
  await pane.press({ key: 'refresh' })
  await $.prompt.submit(submit('/triage'))
  await $.turn.complete(turn('Fixed the login bug.'))
  expect(await pane.find({ key: 'open-2' })).toBeUndefined()
  expect((await pane.find({ key: 'open-1' }))?.text).toContain('Triage the new reports')
  const kept = stored.get('list:/work/repo') as { steps: { title: string }[] }
  expect(kept.steps.map(step => step.title)).toEqual(['Triage the new reports'])
  await pane.unmount()
})

/**
 * The engine beneath the plugin for the requirement tests: a terminal shows
 * the session in a git repo; `world.skills` is the command list and
 * `world.hasClaude` whether a claude process can start; `world.reply` is what
 * a headless run answers.
 */
type Needs = {
  skills: { name: string; description: string; source: 'user' | 'plugin' }[]
  hasClaude: boolean
  reply: string
  opened: string[]
  runs: (readonly string[])[]
  toasts: string[]
}

function fakeNeeds(on: On, needs: Needs): void {
  mock.store(on)
  mock.env(on, {})
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work/repo' }))
  on('session.surfaces', () => ({ value: ['terminal'] as never }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({ value: [...needs.skills] }))
  on('ui.open', (_$, e) => {
    needs.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.toast', (_$, e) => {
    needs.toasts.push(e.text)
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    needs.runs.push(e.argv)
    if (e.argv[0] === 'claude' && !needs.hasClaude) throw new Error('spawn claude ENOENT')
    const stdout = e.argv[0] === 'git' ? 'true\n' : e.argv[1] === '--version' ? '2.1.289 (Claude Code)\n' : needs.reply
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

const TERMINAL_START = { cwd: '/work/repo', surface: 'terminal', isInteractive: true } as const

test('a missing skill is named in the pane, no claude process starts and the pane does not open unasked', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const needs: Needs = { skills: [], hasClaude: true, reply: REPLY, opened: [], runs: [], toasts: [] }
  fakeNeeds(on, needs)

  await $.session.start(TERMINAL_START)
  await clock.settle()
  expect(needs.opened).toEqual([])
  const pane = await $.ui.mount({ plugin: 'whats-next', surface: 'terminal', component: 'Pane', requestId: 'whats-next', props: PANE_PROPS })
  expect(await pane.find({ type: 'Text', text: /\/ask-sean.*not installed.*press r/ })).toBeDefined()

  await pane.press({ key: 'refresh' })
  expect(needs.runs.filter(argv => argv[0] === 'claude')).toEqual([])
  expect(needs.toasts).toEqual([])

  // Installed now: r asks the skill.
  needs.skills.push(ASK_SEAN)
  await pane.press({ key: 'refresh' })
  expect((await pane.find({ key: 'open-1' }))?.text).toContain('Push the auth branch')
  await pane.unmount()
})

test('a plugin copy of the skill under its prefix does not answer to the bare name', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const skills = [{ name: 'lril:ask-sean', description: "What's next?", source: 'plugin' as const }]
  const needs: Needs = { skills, hasClaude: true, reply: REPLY, opened: [], runs: [], toasts: [] }
  fakeNeeds(on, needs)

  const pane = await $.ui.mount({ plugin: 'whats-next', surface: 'terminal', component: 'Pane', requestId: 'whats-next', props: PANE_PROPS })
  await pane.press({ key: 'refresh' })
  await clock.settle()
  expect(await pane.find({ type: 'Text', text: /\/ask-sean.*not installed/ })).toBeDefined()
  expect(needs.runs.filter(isHeadlessRun)).toEqual([])
  await pane.unmount()
})

test('a claude CLI that cannot start is named in the pane, which does not open unasked', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const needs: Needs = { skills: [ASK_SEAN], hasClaude: false, reply: REPLY, opened: [], runs: [], toasts: [] }
  fakeNeeds(on, needs)

  await $.session.start(TERMINAL_START)
  await clock.settle()
  expect(needs.opened).toEqual([])
  const pane = await $.ui.mount({ plugin: 'whats-next', surface: 'terminal', component: 'Pane', requestId: 'whats-next', props: PANE_PROPS })
  await pane.press({ key: 'refresh' })
  expect(await pane.find({ type: 'Text', text: /claude CLI.*PATH.*press r/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /ENOENT/ })).toBeUndefined()
  expect(needs.toasts).toEqual([])

  needs.hasClaude = true
  await pane.press({ key: 'refresh' })
  expect((await pane.find({ key: 'open-1' }))?.text).toContain('Push the auth branch')
  await pane.unmount()
})

test('a headless run that answers it has no such skill says the skill is missing for claude -p', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const reply = "I don't have a skill or command called `/ask-sean`, and I don't see any prior context."
  const needs: Needs = { skills: [ASK_SEAN], hasClaude: true, reply, opened: [], runs: [], toasts: [] }
  fakeNeeds(on, needs)

  const pane = await $.ui.mount({ plugin: 'whats-next', surface: 'terminal', component: 'Pane', requestId: 'whats-next', props: PANE_PROPS })
  await pane.press({ key: 'refresh' })
  await clock.settle()
  expect(await pane.find({ type: 'Text', text: /\/ask-sean.*installed here but not for claude -p.*press r/ })).toBeDefined()
  await pane.unmount()
})

test('isMissingSkillReply needs the skill named and a no-such-skill phrase', () => {
  expect(isMissingSkillReply("I don't have a skill or command called `/ask-sean`.", '/ask-sean')).toBe(true)
  expect(isMissingSkillReply('I don’t have a /ask-sean skill.', '/ask-sean')).toBe(true)
  expect(isMissingSkillReply("I couldn't find a command called ask-sean.", '/ask-sean')).toBe(true)
  expect(isMissingSkillReply('There is no such skill as /ask-sean here.', '/ask-sean')).toBe(true)
  // A skill that ran but wrote no fence: its words are not a missing skill.
  expect(isMissingSkillReply('ask-sean: gh was not found, so the state of issue #12 is unknown.', '/ask-sean')).toBe(false)
  expect(isMissingSkillReply("I don't have a skill called /other.", '/ask-sean')).toBe(false)
})

test('a later start with the requirement met clears the message and opens the pane', { options: { refreshOnStart: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const needs: Needs = { skills: [], hasClaude: true, reply: REPLY, opened: [], runs: [], toasts: [] }
  fakeNeeds(on, needs)

  await $.session.start(TERMINAL_START)
  await clock.settle()
  expect(needs.opened).toEqual([])

  // The skill is installed and the plugin reloads: session.start runs again.
  needs.skills.push(ASK_SEAN)
  await $.session.start(TERMINAL_START)
  await clock.settle()
  expect(needs.opened).toEqual(['whats-next'])
  const pane = await $.ui.mount({ plugin: 'whats-next', surface: 'terminal', component: 'Pane', requestId: 'whats-next', props: PANE_PROPS })
  // No refresh runs at start here, so only start-up itself can have cleared the message.
  expect(await pane.find({ type: 'Text', text: /not installed/ })).toBeUndefined()
  expect(needs.runs.filter(isHeadlessRun)).toEqual([])
  await pane.unmount()
})

test('with steps kept from before, a missing skill still lets the pane open for them, and starts no run', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const needs: Needs = { skills: [ASK_SEAN], hasClaude: true, reply: REPLY, opened: [], runs: [], toasts: [] }
  fakeNeeds(on, needs)

  await $.session.start(TERMINAL_START)
  await clock.settle()
  expect(needs.runs.filter(isHeadlessRun).length).toBe(1)

  // A later session in the same folder: the kept list loads, but the skill is gone.
  needs.skills.length = 0
  needs.opened.length = 0
  await $.session.start(TERMINAL_START)
  await clock.settle()
  expect(needs.opened).toEqual(['whats-next'])
  expect(needs.runs.filter(isHeadlessRun).length).toBe(1)
  const pane = await $.ui.mount({ plugin: 'whats-next', surface: 'terminal', component: 'Pane', requestId: 'whats-next', props: PANE_PROPS })
  expect((await pane.find({ key: 'open-1' }))?.text).toContain('Push the auth branch')
  expect(await pane.find({ type: 'Text', text: /\/ask-sean.*not installed/ })).toBeDefined()
  await pane.unmount()
})
