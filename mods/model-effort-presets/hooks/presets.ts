import type { Current, Preset } from '../types'

/** The settings as the mod runs on them. */
export type Config = { presets: Preset[]; commands: Map<string, Preset> }

function entries(text: string): [string, string][] {
  return text
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry !== '')
    .map(entry => {
      const at = entry.indexOf('=')
      return [entry.slice(0, at).trim(), entry.slice(at + 1).trim()]
    })
}

export function parseConfig(options: Readonly<Record<string, unknown>>): Config {
  const presets = entries(typeof options.presets === 'string' ? options.presets : '').map(([name, value]): Preset => {
    const slash = value.lastIndexOf('/')
    return { name, model: value.slice(0, slash).trim(), effort: value.slice(slash + 1).trim() }
  })
  const commands = new Map(
    entries(typeof options.commands === 'string' ? options.commands : '').flatMap(([command, name]): [string, Preset][] => {
      const preset = findPreset(presets, name)
      return preset === undefined ? [] : [[command.replace(/^\//, ''), preset]]
    }),
  )
  return { presets, commands }
}

/**
 * Whether the session's model id is the model a preset names: the same id, or
 * an alias that is one of the id's words (`opus` in `claude-opus-5-5`).
 */
export function isModel(id: string, model: string): boolean {
  const wanted = model.toLowerCase()
  const held = id.toLowerCase()
  return held === wanted || held.split('-').includes(wanted)
}

/** The preset the session is on: its model and, once known, its effort. */
export function currentPreset(presets: readonly Preset[], current: Current): Preset | undefined {
  return presets.find(preset => isModel(current.model, preset.model) && (current.effort === null || current.effort === preset.effort))
}

/** The preset `/preset` was given, by name in any case. */
export function findPreset(presets: readonly Preset[], name: string): Preset | undefined {
  const wanted = name.trim().toLowerCase()
  return presets.find(preset => preset.name.toLowerCase() === wanted)
}

export function usage(presets: readonly Preset[]): string {
  return `Usage: /preset <${presets.map(preset => preset.name).join('|')}>`
}
