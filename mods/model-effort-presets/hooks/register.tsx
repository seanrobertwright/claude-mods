import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Current, Preset } from '../types'
import { currentPreset, findPreset, parseConfig, usage } from './presets'

const LABEL = 'Preset:'

const current = atom({ plugin: 'model-effort-presets', key: 'current' } as const, { model: '', effort: null } as Current)

function report($: EngineInterface): (error: unknown) => void {
  return error => $.ui.toast(`model-effort-presets: ${error instanceof Error ? error.message : String(error)}`)
}

/** Switches the session to the preset: its model, then its effort, each through the built-in command. */
async function apply($: EngineInterface, preset: Preset): Promise<void> {
  await $.command.run({ command: 'model', args: preset.model })
  await $.command.run({ command: 'effort', args: preset.effort })
  const model = await $.session.model()
  await update($, current, () => ({ model, effort: preset.effort }))
}

export const register: Register = (on, options) => {
  const config = parseConfig(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'preset', description: 'Switch the model and the effort to a preset', argumentHint: config.presets.map(preset => preset.name).join('|') })
    const model = await $.session.model()
    await update($, current, () => ({ model, effort: null }))
    return started
  })

  on('command.run', { command: 'preset' }, async ($, e) => {
    const preset = findPreset(config.presets, e.args)
    if (preset === undefined) return { text: usage(config.presets) }
    // The engine refuses a command run from inside another, so the switch follows this one's answer.
    $.clock.after(0, () => void apply($, preset).catch(report($)))
    return { text: `Switching to ${preset.name}: ${preset.model}, ${preset.effort} effort.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const beneath = await next(e)
    if (e.props.hasSurvey || e.props.view.agentId !== undefined) return beneath
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
