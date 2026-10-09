import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

import { parseConfig } from '../hooks/presets'

const PLUGIN = 'model-effort-presets'

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
} as const

const INTERACTIVE = { cwd: '/work/repo', surface: 'terminal', isInteractive: true } as const

const COMPOSER = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const

/** The ids `/model` resolves its aliases to, as Claude Code 2.1.295 does. */
const IDS: Readonly<Record<string, string>> = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
}

/**
 * The engine beneath the mod: its own band, and the built-in /model and /effort,
 * which record what they were asked and set the session's model as core does.
 */
function engineBeneath(on: On, { model: startModel = IDS.sonnet ?? '', surfaces = ['terminal'] }: { model?: string; surfaces?: readonly RenderSurface[] } = {}): { ran: string[]; toasts: string[] } {
  const ran: string[] = []
  const toasts: string[] = []
  let model = startModel
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 0 }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: surfaces }))
  on('session.model', () => ({ value: model }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('command.run', { command: 'model' }, (_$, e) => {
    ran.push(`/model ${e.args}`)
    model = IDS[e.args] ?? model
    return { text: `Set model to ${e.args} for this session only` }
  })
  on('command.run', { command: 'effort' }, (_$, e) => {
    ran.push(`/effort ${e.args}`)
    return { text: `Set effort level to ${e.args} (this session only)` }
  })
  // eslint-disable-next-line require-yield -- the stand-in sends no chunks, only the step's result
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  // The person's own commands, as a skill's: each records that it ran, and with what.
  for (const command of ['lril:plan-feature', 'lril:review']) {
    on('command.run', { command }, (_$, e) => {
      ran.push(`/${command} ${e.args}`)
      return {}
    })
  }
  return { ran, toasts }
}

async function variantOf(band: { find: (query: { key: string }) => Promise<{ props: Record<string, unknown> } | undefined> }, key: string): Promise<unknown> {
  const found = await band.find({ key })
  expect(found, `${key} is drawn`).toBeDefined()
  return found?.props.variant
}

test('pressing plan sets its model and effort, and the band marks plan', async ($, on) => {
  const { ran } = engineBeneath(on)
  await $.session.start(INTERACTIVE)
  const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })

  await band.press({ key: 'preset-plan' })
  expect(ran).toEqual(['/model opus', '/effort high'])
  expect(await variantOf(band, 'preset-plan')).toBe('primary')
  expect(await variantOf(band, 'preset-execute')).toBeUndefined()
  await band.unmount()
})

test('/preset execute switches to execute once it has answered, and /preset nope shows the usage line', async ($, on) => {
  const { ran } = engineBeneath(on, { model: IDS.opus })
  const clock = mock.clock(on)
  await $.session.start(INTERACTIVE)
  const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })

  const answered = await $.command.run({ command: 'preset', args: 'execute', ...COMPOSER })
  expect(answered.text).toBe('Switching to execute: sonnet, medium effort.')
  // The engine refuses /model from inside a command, so the switch follows the answer.
  await clock.settle()
  expect(ran).toEqual(['/model sonnet', '/effort medium'])
  expect(await variantOf(band, 'preset-execute')).toBe('primary')
  expect(await variantOf(band, 'preset-plan')).toBeUndefined()

  for (const args of ['nope', '']) {
    expect((await $.command.run({ command: 'preset', args, ...COMPOSER })).text).toBe('Usage: /preset <plan|execute>')
  }
  await clock.settle()
  expect(ran).toEqual(['/model sonnet', '/effort medium'])
  await band.unmount()
})

test('a mapped command switches to its preset before it runs; an unmapped one changes nothing', { options: { commands: 'lril:plan-feature=plan' } }, async ($, on) => {
  const { ran } = engineBeneath(on)
  const clock = mock.clock(on)
  await $.session.start(INTERACTIVE)

  await $.command.run({ command: 'lril:review', args: 'the diff', ...COMPOSER })
  await clock.settle()
  expect(ran).toEqual(['/lril:review the diff'])

  await $.command.run({ command: 'lril:plan-feature', args: 'presets', ...COMPOSER })
  await clock.settle()
  expect(ran).toEqual(['/lril:review the diff', '/model opus', '/effort high', '/lril:plan-feature presets'])
})

test('malformed settings are rejected with a message, and nothing is drawn or switched', { options: { presets: 'plan=opus/extreme, execute=sonnet/medium', commands: 'lril:plan-feature=plan' } }, async ($, on) => {
  const { ran, toasts } = engineBeneath(on)
  const clock = mock.clock(on)
  await $.session.start(INTERACTIVE)
  const rejected = 'model-effort-presets: settings not applied: the effort of plan is "extreme", not one of low, medium, high, xhigh, max.'
  expect(toasts).toEqual([rejected])

  const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: 'Preset:' })).toBeUndefined()
  expect(await band.find({ key: 'preset-execute' })).toBeUndefined()
  await band.unmount()

  expect((await $.command.run({ command: 'preset', args: 'execute', ...COMPOSER })).text).toBe(rejected)
  await $.command.run({ command: 'lril:plan-feature', args: 'presets', ...COMPOSER })
  await clock.settle()
  expect(ran).toEqual(['/lril:plan-feature presets'])
})

test('the settings are parsed at load, and each malformed one is rejected with what is wrong', () => {
  const plan = { name: 'plan', model: 'opus', effort: 'high' }
  const execute = { name: 'execute', model: 'sonnet', effort: 'medium' }
  const parsed = parseConfig({ presets: ' plan=opus/high ,execute = sonnet / medium', commands: '/lril:plan-feature=plan, lril:execute=Execute' })
  expect(parsed).toEqual({ kind: 'ok', config: { presets: [plan, execute], commands: new Map([['lril:plan-feature', plan], ['lril:execute', execute]]) } })

  const problems: [Record<string, string>, string][] = [
    [{ presets: 'plan=/high' }, 'plan has no model.'],
    [{ presets: 'plan=opus/extreme' }, 'the effort of plan is "extreme", not one of low, medium, high, xhigh, max.'],
    [{ presets: 'plan=opus' }, '"plan=opus" is not name=model/effort.'],
    [{ presets: 'opus/high' }, '"opus/high" is not name=model/effort.'],
    [{ presets: 'my plan=opus/high' }, 'the preset name "my plan" is not one word.'],
    [{ presets: 'plan=opus/high, Plan=sonnet/low' }, 'two presets are named plan.'],
    [{ presets: '' }, 'no preset is set.'],
    [{ presets: 'plan=opus/high', commands: 'lril:execute=execute' }, 'lril:execute is mapped to execute, which is not a preset; the presets are plan.'],
    [{ presets: 'plan=opus/high', commands: 'lril:execute' }, '"lril:execute" is not command=preset.'],
    [{ presets: 'plan=opus/high', commands: 'lril:a=plan, /lril:a=plan' }, 'lril:a is mapped twice.'],
    [{ presets: 'plan=opus/high', commands: 'model=plan' }, '/model cannot be mapped: /model, /effort and /preset are how a preset switches.'],
  ]
  for (const [options, problem] of problems) expect(parseConfig(options), JSON.stringify(options)).toEqual({ kind: 'rejected', problem })
})

test('in a headless session there is no band and no switching', { options: { commands: 'lril:plan-feature=plan' } }, async ($, on) => {
  const { ran, toasts } = engineBeneath(on, { surfaces: [] })
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/work/repo', surface: null, isInteractive: false })

  const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: 'Preset:' })).toBeUndefined()
  await band.unmount()

  expect((await $.command.run({ command: 'preset', args: 'plan', ...COMPOSER })).text).toBe('model-effort-presets switches nothing in a headless session.')
  await $.command.run({ command: 'lril:plan-feature', args: 'presets', ...COMPOSER })
  await clock.settle()
  expect(ran).toEqual(['/lril:plan-feature presets'])
  expect(toasts).toEqual([])
})

test('the band marks the preset the session is on, following a switch by hand and the effort a request shows', async ($, on) => {
  engineBeneath(on)
  await $.session.start(INTERACTIVE)
  const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })
  // Until a request or a switch shows the effort, the model alone marks a preset.
  expect(await variantOf(band, 'preset-execute')).toBe('primary')

  await $.command.run({ command: 'effort', args: 'low', ...COMPOSER })
  expect(await variantOf(band, 'preset-execute')).toBeUndefined()
  await $.command.run({ command: 'model', args: 'opus', ...COMPOSER })
  expect(await variantOf(band, 'preset-plan')).toBeUndefined()

  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 })) void chunk
  expect(await variantOf(band, 'preset-plan')).toBe('primary')
  // A subagent's request runs on its own settings, not the session's.
  for await (const chunk of $.turn.step({ turnId: 't1', index: 1, model: 'claude-haiku-5-5', effort: 'low', messageCount: 1, agentId: 'a1' })) void chunk
  expect(await variantOf(band, 'preset-plan')).toBe('primary')
  await band.unmount()
})
