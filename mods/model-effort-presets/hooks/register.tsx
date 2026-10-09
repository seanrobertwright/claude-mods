import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Current, Preset } from '../types'
import { currentPreset, findPreset, isEffort, parseConfig, usage } from './presets'
import type { Config } from './presets'

const LABEL = 'Preset:'
const HEADLESS = 'model-effort-presets switches nothing in a headless session.'

const current = atom({ plugin: 'model-effort-presets', key: 'current' } as const, { model: '', effort: null } as Current)

function report($: EngineInterface): (error: unknown) => void {
  return error => $.ui.toast(`model-effort-presets: ${error instanceof Error ? error.message : String(error)}`)
}

/**
 * Whether any surface shows the session right now. Asked before each switch
 * and each drawing, never kept. Each mod carries its own copy (ADR-0001).
 */
async function isShown($: EngineInterface): Promise<boolean> {
  return (await $.session.surfaces()).length > 0
}

/** Switches the session to the preset: its model, then its effort, each through the built-in command. */
async function apply($: EngineInterface, preset: Preset): Promise<void> {
  await $.command.run({ command: 'model', args: preset.model })
  await $.command.run({ command: 'effort', args: preset.effort })
  const model = await $.session.model()
  await update($, current, () => ({ model, effort: preset.effort }))
}

/**
 * Switches to the preset once this command has answered, then runs `then` as the person typed it, and says so.
 * The engine refuses a command run from inside another, so the switch cannot happen in the answer itself.
 */
function switchAfter($: EngineInterface, preset: Preset, then?: { command: string; args: string }): { text: string } {
  $.clock.after(0, () => {
    void (async () => {
      await apply($, preset)
      if (then !== undefined) await $.command.run(then)
    })().catch(report($))
  })
  const running = then === undefined ? '' : `, then running /${then.command}`
  return { text: `Switching to ${preset.name}: ${preset.model}, ${preset.effort} effort${running}.` }
}

/** Moves the mark after /model or /effort ran, whoever ran it: the model as the session now reads it, the effort as given. */
async function follow($: EngineInterface, command: 'model' | 'effort', args: string): Promise<void> {
  if (command === 'model') {
    const model = await $.session.model()
    await update($, current, held => ({ ...held, model }))
    return
  }
  const level = args.trim().toLowerCase()
  // `auto` hands the effort back to the model's default, which no command reads; anything else /effort refused.
  if (isEffort(level) || level === 'auto') await update($, current, held => ({ ...held, effort: isEffort(level) ? level : null }))
}

export const register: Register = (on, options) => {
  const parsed = parseConfig(options)
  // Rejected settings run as no presets and no commands: nothing drawn, nothing switched.
  const config: Config = parsed.kind === 'ok' ? parsed.config : { presets: [], commands: new Map() }
  const rejected = parsed.kind === 'rejected' ? `model-effort-presets: settings not applied: ${parsed.problem}` : undefined

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'preset', description: 'Switch the model and the effort to a preset', argumentHint: config.presets.map(preset => preset.name).join('|') })
    if (rejected !== undefined && (await isShown($))) $.ui.toast(rejected)
    const model = await $.session.model()
    await update($, current, () => ({ model, effort: null }))
    return started
  })

  on('command.run', { command: 'preset' }, async ($, e) => {
    if (!(await isShown($))) return { text: HEADLESS }
    if (rejected !== undefined) return { text: rejected }
    const preset = findPreset(config.presets, e.args)
    if (preset === undefined) return { text: usage(config.presets) }
    return switchAfter($, preset)
  })

  on('command.run', async ($, e, next) => {
    if (e.command === 'model' || e.command === 'effort') {
      const done = await next(e)
      await follow($, e.command, e.args).catch(() => undefined)
      return done
    }
    const preset = config.commands.get(e.command)
    // A mod's run, this one's own among them, is not the person sending it.
    if (preset === undefined || e.origin.kind === 'plugin' || !(await isShown($))) return next(e)
    // Held until the preset is on, as /preset's switch is.
    return switchAfter($, preset, { command: e.command, args: e.args })
  })

  on('turn.step', async function* ($, e, next) {
    // The request says what the session runs on; a subagent's own settings are not the session's.
    if (e.agentId === undefined) {
      const effort = e.effort === undefined ? null : String(e.effort)
      await update($, current, held => (held.model === e.model && held.effort === effort ? held : { model: e.model, effort })).catch(() => undefined)
    }
    // The response streams through untouched.
    return yield* next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const beneath = await next(e)
    if (config.presets.length === 0 || e.props.hasSurvey || e.props.view.agentId !== undefined || !(await isShown($))) return beneath
    const marked = currentPreset(config.presets, await read($, current))
    const { Box, Text, Button } = $.ui.resolve(e)

    // The outer Box takes no width: the engine refuses its own band under a Box that sets one.
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1} width={e.props.bodyColumns}>
          <Text dimColor>{LABEL}</Text>
          {config.presets.map(preset => (
            <Button
              key={`preset-${preset.name}`}
              label={preset.name}
              variant={preset === marked ? 'primary' : undefined}
              onPress={() => void apply($, preset).catch(report($))}
            />
          ))}
        </Box>
        {beneath}
      </Box>
    )
  })
}
