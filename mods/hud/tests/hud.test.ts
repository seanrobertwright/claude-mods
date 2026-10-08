import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

import type { HudView } from '../types'
import { cells, coarse, duration, folderName, gauge, level, limitsToWarn, limitWarning, parseConfig, parseGit, parseWorktree, resetTime, rows, rowWidth, shortModel } from '../hooks/hud'

const START = 1_800_000_000_000
const MINUTE = 60_000

const GIT_STATUS = ['# branch.oid abc', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +1 -2', '1 .M N... 100644 100644 100644 a b README.md', '? notes.md', ''].join('\n')

/** What `git rev-parse --show-toplevel` prints in the main checkout, and in a linked worktree. */
const MAIN_CHECKOUT = '/work/claude-mods\n'
const LINKED = 'C:/repos/claude-mods-121\n'

const HINT = { isDraft: false, isWorking: false, hint: '? for shortcuts' } as const
const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200, scroll: { offset: 0, bodyRows: 10 }, view: {} } as const

const VIEW: HudView = {
  model: 'claude-fable-5-1[1m]',
  effort: 'high',
  contextPercent: 42,
  limits: [{ kind: 'five_hour', percent: 31, resetsAt: new Date(START + 125 * MINUTE).toISOString() }],
  costUsd: 1.239,
  startedAt: START - 72 * MINUTE,
  git: { branch: 'main', changed: 3, ahead: 1, behind: 0 },
  worktree: 'C:\\repos\\claude-mods-121',
  folder: 'C:\\repos\\claude-mods',
  agents: 2,
  toolsTurn: 4,
  toolsSession: 19,
  isWorking: true,
  turnStartedAt: START - 192_000,
}

/** The engine beneath the mod: the figures it reports, and the processes the mod started and the toasts it showed. */
type World = {
  contextPercent: number
  limitPercent: number
  /** When the 5h window resets, as the engine reports it; undefined when it reports none. */
  resetsAt: string | undefined
  agents: number
  isRepo: boolean
  /** Whether the session's folder is a linked worktree rather than the main checkout, which names another top folder. */
  isLinked: boolean
  runs: (readonly string[])[]
  usageReads: number
  toasts: string[]
}

function engineBeneath(on: On, surfaces: readonly RenderSurface[] = ['terminal']) {
  const world: World = { contextPercent: 42, limitPercent: 31, resetsAt: undefined, agents: 0, isRepo: true, isLinked: false, runs: [], usageReads: 0, toasts: [] }
  const clock = mock.clock(on, { now: START })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.attach', () => ({ clientId: 'c1' }))
  on('session.surfaces', () => ({ value: surfaces }))
  on('session.cwd', () => ({ value: '/work/claude-mods' }))
  on('session.model', () => ({ value: 'claude-fable-5-1[1m]' }))
  on('session.usage', () => {
    world.usageReads += 1
    return {
      value: {
        startedAt: START - 72 * MINUTE,
        context: { window: 1_000_000, percent: world.contextPercent },
        rateLimits: [{ kind: 'five_hour', percentUsed: world.limitPercent, ...(world.resetsAt === undefined ? {} : { resetsAt: world.resetsAt }) }],
        cost: { usd: 1.239 },
      },
    }
  })
  on('agent.list', () => ({
    value: Array.from({ length: world.agents }, (_unused, index) => ({ id: `a${index}`, description: 'look', type: 'Explore', status: 'running' as const })),
  }))
  on('process.run', (_$, e) => {
    world.runs.push(e.argv)
    const stdout = !world.isRepo ? '' : e.argv[1] === 'rev-parse' ? (world.isLinked ? LINKED : MAIN_CHECKOUT) : GIT_STATUS
    return { value: { exitCode: world.isRepo ? 0 : 128, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', (_$, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', { component: 'PromptHint' }, () => ({ type: 'Text', props: {}, children: ['? for shortcuts'] }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 0 }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  // eslint-disable-next-line require-yield -- the stand-in sends no chunks, only the step's result
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('tool.call', { tool: 'Read' }, (_$, e) => ({ result: { type: 'text', file: { filePath: e.file_path, content: '', numLines: 0, startLine: 1, totalLines: 0 } } }))
  return { world, clock }
}

const DONE = { answer: 'Done.', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' } as const

/** What the row says, figure by figure: each label with its text. */
function said(lines: ReturnType<typeof rows>): string[][] {
  return lines.map(line => line.map(segment => `${segment.label} ${segment.text}`))
}

test('the small formatters say what the row shows', () => {
  expect(shortModel('claude-fable-5-1[1m]')).toBe('fable 5.1')
  expect(shortModel('claude-haiku-4-5-20251001')).toBe('haiku 4.5')
  expect(shortModel('my-gateway-model')).toBe('my-gateway-model')
  expect(duration(42_000)).toBe('42s')
  expect(duration(252_000)).toBe('4m 12s')
  expect(duration(66 * MINUTE)).toBe('1h 6m')
  expect(coarse(20_000)).toBe('under 1m')
  expect(coarse(72 * MINUTE)).toBe('1h 12m')
  expect(coarse(27 * 60 * MINUTE)).toBe('1d 3h')
  expect(gauge(42)).toBe('███░░░░░')
  expect(gauge(100)).toBe('████████')
  expect(gauge(0)).toBe('░░░░░░░░')
  expect([level(10, 70, 85), level(70, 70, 85), level(85, 70, 85)]).toEqual(['ok', 'warn', 'danger'])
  expect(folderName('C:\\repos\\claude-mods\\')).toBe('claude-mods')
  expect(folderName('/work/audit')).toBe('audit')
})

test('parseGit reads the branch, what is ahead and behind, and the changed files', () => {
  expect(parseGit(GIT_STATUS)).toEqual({ branch: 'main', changed: 2, ahead: 1, behind: 2 })
  expect(parseGit('# branch.oid abc\n# branch.head feat/x\n')).toEqual({ branch: 'feat/x', changed: 0, ahead: 0, behind: 0 })
  expect(parseGit('fatal: not a git repository')).toBeNull()
})

test('parseWorktree names the top folder, of a linked worktree and of the main checkout alike', () => {
  expect(parseWorktree(LINKED)).toBe('C:/repos/claude-mods-121')
  expect(parseWorktree(MAIN_CHECKOUT)).toBe('/work/claude-mods')
  expect(parseWorktree('C:/repos/x\r\n')).toBe('C:/repos/x')
  expect(parseWorktree('')).toBeNull()
})

test('an emoji takes two cells and a variation selector none, so a row with one still fits', () => {
  expect([cells('worktree'), cells('🪾 worktree'), cells('⚙️')]).toEqual([8, 11, 1])
  expect(rowWidth([{ label: '🪾 worktree', text: 'x' }])).toBe(13)
})

test('parseConfig falls back to the defaults and reads the hidden segments', () => {
  const config = parseConfig({ theme: 'ocean', animate: false, placement: 'above', hide: ' Cost, folder ,nonsense' })
  expect([config.theme, config.animate, config.placement, [...config.hidden]]).toEqual(['ocean', false, 'above', ['cost', 'folder']])
  const plain = parseConfig({})
  expect([plain.theme, plain.animate, plain.placement, plain.hidden.size]).toEqual(['neon', true, 'below', 0])
})

test('every figure carries a label, on two lines, and a figure at its level takes that colour', () => {
  const lines = rows(VIEW, parseConfig({}), START, 0, 300)
  expect(said(lines)).toEqual([
    ['model fable 5.1', 'effort high', 'context ███░░░░░ 42%', '5h limit 31% · resets in 2h 5m'],
    ['turn 3m 12s', 'tools 4 this turn · 19 total', 'agents 2 running', 'git main · 3 changed · 1 ahead', '🪾 worktree claude-mods-121', 'cost $1.24', 'session 1h 12m', 'folder claude-mods'],
  ])
  expect(lines[0]?.[2]?.color).toBe('#5fff87')
  const hot = rows({ ...VIEW, contextPercent: 72, limits: [{ kind: 'seven_day', percent: 93, resetsAt: null }] }, parseConfig({}), START, 0, 300)[0]
  expect([hot?.[2]?.color, hot?.[3]?.label, hot?.[3]?.text, hot?.[3]?.color, hot?.[3]?.isBold]).toEqual(['#ffd75f', '7d limit', '93%', '#ff5f5f', true])
})

test('the empty figures are left out, and so are the hidden ones; a line with nothing is not drawn', () => {
  const quiet = { ...VIEW, effort: null, git: null, worktree: null, costUsd: null, agents: 0, toolsSession: 0, isWorking: false }
  expect(rows(quiet, parseConfig({ hide: 'model,session' }), START, 0, 300).map(line => line.map(segment => segment.kind))).toEqual([['context', 'limits'], ['folder']])
  expect(rows(quiet, parseConfig({ hide: 'model,session,folder' }), START, 0, 300).length).toBe(1)
})

test('a narrow row leaves out whole figures from each line, the least important first', () => {
  const config = parseConfig({})
  const kinds = (columns: number) => rows(VIEW, config, START, 0, columns).map(line => line.map(segment => segment.kind))
  expect(kinds(100)).toEqual([
    ['model', 'effort', 'context', 'limits'],
    ['turn', 'tools', 'agents', 'git'],
  ])
  expect(kinds(50)).toEqual([['context'], ['turn', 'agents']])
  for (const line of rows(VIEW, config, START, 0, 100)) expect(rowWidth(line)).toBeLessThanOrEqual(100)
})

test('while a turn runs the colours move and a figure in danger blinks; idle or with animation off the row is still', () => {
  const config = parseConfig({})
  const danger = { ...VIEW, contextPercent: 90 }
  const colors = (view: HudView, frame: number, options = config) => rows(view, options, START, frame, 300).flat().map(segment => segment.color)
  const context = (view: HudView, frame: number) => rows(view, config, START, frame, 300)[0]?.[2]
  expect(colors(VIEW, 0)).not.toEqual(colors(VIEW, 2))
  expect(colors({ ...VIEW, isWorking: false }, 0)).toEqual(colors({ ...VIEW, isWorking: false }, 2))
  expect(colors(VIEW, 0, parseConfig({ animate: false }))).toEqual(colors(VIEW, 2, parseConfig({ animate: false })))
  expect([context(danger, 0)?.isInverse, context(danger, 2)?.isInverse]).toEqual([true, false])
  expect(context({ ...danger, isWorking: false }, 0)?.isInverse).toBe(false)
  // The mono theme paints no theme colour, only the levels.
  expect(rows(VIEW, parseConfig({ theme: 'mono' }), START, 0, 300)[0]?.[0]?.color).toBeUndefined()
})

test('the row under the prompt names and shows what the engine reports, above its own hint line', async ($, on) => {
  const { world } = engineBeneath(on)
  await $.session.start({ cwd: '/work/claude-mods', surface: 'terminal', isInteractive: true })
  expect(world.runs).toEqual([
    ['git', 'status', '--porcelain=v2', '--branch'],
    ['git', 'rev-parse', '--show-toplevel'],
  ])

  for (const surface of ['terminal', 'desktop'] as const) {
    const hint = await $.ui.mount({ plugin: 'hud', surface, component: 'PromptHint', props: HINT })
    const texts = ['model', 'fable 5.1', 'context', '███░░░░░ 42%', '5h limit', '31%', 'git', 'main · 2 changed · 1 ahead · 2 behind', 'cost', '$1.24', 'session', '1h 12m', '? for shortcuts']
    for (const text of texts) expect(await hint.find({ type: 'Text', text })).toBeDefined()
    // Nothing has run yet: no turn timer, no tool calls, no agents, no effort.
    for (const label of ['turn', 'tools', 'agents', 'effort']) expect(await hint.find({ type: 'Text', text: label })).toBeUndefined()
    await hint.unmount()
  }
})

test('during a turn the effort, the timer and the tool calls show, and the end of the turn reads the figures again', async ($, on) => {
  const { world, clock } = engineBeneath(on)
  await $.session.start({ cwd: '/work/claude-mods', surface: 'terminal', isInteractive: true })
  const hint = await $.ui.mount({ plugin: 'hud', surface: 'terminal', component: 'PromptHint', props: HINT })

  await $.turn.start({ text: 'go', turnId: 't1' })
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-fable-5-1', effort: 'xhigh', messageCount: 1 })) void chunk
  // A subagent's request does not change what the session's effort reads.
  for await (const chunk of $.turn.step({ turnId: 's1', index: 0, model: 'claude-haiku-4-5', effort: 'low', messageCount: 1, agentId: 'a1' })) void chunk
  await $.tool.call({ tool: 'Read', file_path: 'a.md' })
  await $.tool.call({ tool: 'Read', file_path: 'b.md' })
  // The row is drawn again at each beat, so the timer reads as of the last one.
  await clock.advance(5_100)
  for (const text of ['effort', 'xhigh', 'turn', '5s', 'tools', '2 this turn · 2 total']) expect(await hint.find({ type: 'Text', text })).toBeDefined()

  world.contextPercent = 88
  world.agents = 1
  await $.turn.complete(DONE)
  expect(await hint.find({ type: 'Text', text: '███████░ 88%' })).toBeDefined()
  expect(await hint.find({ type: 'Text', text: '1 running' })).toBeDefined()
  // The turn is over: its timer is gone.
  expect(await hint.find({ type: 'Text', text: '5s' })).toBeUndefined()

  // The next turn counts its own tool calls and keeps the session's.
  await $.turn.start({ text: 'again', turnId: 't2' })
  await $.tool.call({ tool: 'Read', file_path: 'c.md' })
  expect(await hint.find({ type: 'Text', text: '1 this turn · 3 total' })).toBeDefined()
  await hint.unmount()
})

test('outside a git repository the git and worktree figures are absent', async ($, on) => {
  const { world } = engineBeneath(on)
  world.isRepo = false
  await $.session.start({ cwd: '/work/claude-mods', surface: 'terminal', isInteractive: true })
  const hint = await $.ui.mount({ plugin: 'hud', surface: 'terminal', component: 'PromptHint', props: HINT })
  expect(await hint.find({ type: 'Text', text: 'git' })).toBeUndefined()
  expect(await hint.find({ type: 'Text', text: '🪾 worktree' })).toBeUndefined()
  expect(await hint.find({ type: 'Text', text: 'claude-mods' })).toBeDefined()
  await hint.unmount()
})

test('the row names the worktree beside git, a linked one and the main checkout alike', async ($, on) => {
  const { world } = engineBeneath(on)
  world.isLinked = true
  await $.session.start({ cwd: 'C:/repos/claude-mods-121', surface: 'terminal', isInteractive: true })
  const hint = await $.ui.mount({ plugin: 'hud', surface: 'terminal', component: 'PromptHint', props: HINT })
  expect(await hint.find({ type: 'Text', text: '🪾 worktree' })).toBeDefined()
  expect(await hint.find({ type: 'Text', text: 'claude-mods-121' })).toBeDefined()

  world.isLinked = false
  await $.turn.complete(DONE)
  expect(await hint.find({ type: 'Text', text: '🪾 worktree' })).toBeDefined()
  expect(await hint.find({ type: 'Text', text: 'claude-mods-121' })).toBeUndefined()
  await hint.unmount()
})

test('placed above, the row is drawn in the band and the hint line is left alone', { options: { placement: 'above', hide: 'cost' } }, async ($, on) => {
  engineBeneath(on)
  await $.session.start({ cwd: '/work/claude-mods', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'hud', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: '███░░░░░ 42%' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '$1.24' })).toBeUndefined()
  await band.unmount()
  const hint = await $.ui.mount({ plugin: 'hud', surface: 'terminal', component: 'PromptHint', props: HINT })
  expect(await hint.find({ type: 'Text', text: '███░░░░░ 42%' })).toBeUndefined()
  expect(await hint.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
  await hint.unmount()
})

test('resetTime reads a reset time, a time without a zone as UTC, and nothing usable as no time', () => {
  expect(resetTime('2027-01-15T08:00:00Z')).toBe(Date.UTC(2027, 0, 15, 8))
  expect(resetTime('2027-01-15T08:00:00+02:00')).toBe(Date.UTC(2027, 0, 15, 6))
  expect(resetTime('2027-01-15T08:00:00')).toBe(Date.UTC(2027, 0, 15, 8))
  expect(resetTime(null)).toBeNaN()
  expect(resetTime('soon')).toBeNaN()
})

test('limitsToWarn picks a limit at the red level once in each window', () => {
  const resets = new Date(START + 125 * MINUTE).toISOString()
  const later = new Date(START + 425 * MINUTE).toISOString()
  const five = (percent: number, resetsAt: string | null = resets) => ({ kind: 'five_hour', percent, resetsAt })
  const seven = { kind: 'seven_day', percent: 93, resetsAt: null }
  expect(limitsToWarn([five(89)], {}, START)).toEqual([])
  expect(limitsToWarn([five(90)], {}, START)).toEqual([five(90)])
  expect(limitsToWarn([five(91), seven], {}, START)).toEqual([five(91), seven])
  // Warned in this window: not again, however high it goes.
  expect(limitsToWarn([five(99)], { five_hour: resets }, START + 60 * MINUTE)).toEqual([])
  // The engine still reporting the old window after its reset is not a new one.
  expect(limitsToWarn([five(95)], { five_hour: resets }, START + 130 * MINUTE)).toEqual([])
  // A new window, once the warned one has reset.
  expect(limitsToWarn([five(92, later)], { five_hour: resets }, START + 130 * MINUTE)).toEqual([five(92, later)])
  expect(limitsToWarn([five(92, later)], { five_hour: resets }, START + 60 * MINUTE)).toEqual([])
  // A limit with no reset time is warned about once in the session.
  expect(limitsToWarn([seven], { seven_day: null }, START + 9_999 * MINUTE)).toEqual([])
})

test('limitWarning names the limit, its share and the time to its reset', () => {
  expect(limitWarning({ kind: 'five_hour', percent: 91.4, resetsAt: new Date(START + 125 * MINUTE).toISOString() }, START)).toBe('5h limit at 91% · resets in 2h 5m')
  expect(limitWarning({ kind: 'seven_day', percent: 93, resetsAt: null }, START)).toBe('7d limit at 93%')
  expect(limitWarning({ kind: 'mystery', percent: 90, resetsAt: null }, START)).toBe('mystery at 90%')
})

test('a rate limit reaching the red level toasts once in its window, and again in the next', async ($, on) => {
  const { world, clock } = engineBeneath(on)
  world.limitPercent = 89
  world.resetsAt = new Date(START + 125 * MINUTE).toISOString()
  await $.session.start({ cwd: '/work/claude-mods', surface: 'terminal', isInteractive: true })
  expect(world.toasts).toEqual([])

  world.limitPercent = 91
  await $.turn.complete(DONE)
  expect(world.toasts).toEqual(['5h limit at 91% · resets in 2h 5m'])
  world.limitPercent = 95
  await $.turn.complete(DONE)
  await clock.advance(MINUTE)
  expect(world.toasts).toHaveLength(1)

  // The window resets and the next one reaches red too.
  await clock.advance(125 * MINUTE)
  world.resetsAt = new Date(START + 426 * MINUTE).toISOString()
  world.limitPercent = 90
  await $.turn.complete(DONE)
  expect(world.toasts).toEqual(['5h limit at 91% · resets in 2h 5m', '5h limit at 90% · resets in 5h 0m'])
})

test('a rate limit already at the red level when the session starts toasts once', async ($, on) => {
  const { world } = engineBeneath(on)
  world.limitPercent = 97
  await $.session.start({ cwd: '/work/claude-mods', surface: 'terminal', isInteractive: true })
  await $.turn.complete(DONE)
  expect(world.toasts).toEqual(['5h limit at 97%'])
})

test('in a headless session the mod reads nothing, runs no timer and starts no process', async ($, on) => {
  const { world, clock } = engineBeneath(on, [])
  world.limitPercent = 97
  await $.session.start({ cwd: '/work/claude-mods', surface: null, isInteractive: false })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: 'a.md' })
  await clock.advance(10 * MINUTE)
  await $.turn.complete(DONE)
  expect(world.runs).toEqual([])
  expect(world.usageReads).toBe(0)
  expect(world.toasts).toEqual([])
})
