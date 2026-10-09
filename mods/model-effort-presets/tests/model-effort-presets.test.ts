import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

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
function engineBeneath(on: On, startModel = IDS.sonnet ?? ''): { ran: string[]; toasts: string[] } {
  const ran: string[] = []
  const toasts: string[] = []
  let model = startModel
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 0 }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
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
