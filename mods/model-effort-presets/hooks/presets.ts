import type { Current, Preset } from '../types'

/** The settings as the mod runs on them. */
export type Config = { presets: Preset[]; commands: Map<string, Preset> }

/** The settings parsed at load: the config, or why it was rejected. */
export type Parsed = { kind: 'ok'; config: Config } | { kind: 'rejected'; problem: string }

/** The levels /effort takes and a preset may name. */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** Whether /effort was given a level a preset may name, rather than `auto` or something it refuses. */
export function isEffort(text: string): boolean {
  return (EFFORTS as readonly string[]).includes(text)
}

/** The commands a preset switches through, and /preset itself: mapping one would switch inside a switch. */
const SWITCHES: readonly string[] = ['model', 'effort', 'preset']

/** A setting the person wrote that the mod will not run on. */
class Rejected extends Error {}

/** One `key=value` of a comma-separated setting, as written and as read. */
type Entry = { text: string; key: string; value: string }

function entries(text: string, shape: string): Entry[] {
  return text
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry !== '')
    .map(entry => {
      const at = entry.indexOf('=')
      const key = entry.slice(0, at).trim()
      const value = entry.slice(at + 1).trim()
      if (at === -1 || key === '' || value === '') throw new Rejected(`"${entry}" is not ${shape}.`)
      return { text: entry, key, value }
    })
}

function parsePreset({ text, key: name, value }: Entry): Preset {
  const slash = value.lastIndexOf('/')
  if (slash === -1) throw new Rejected(`"${text}" is not name=model/effort.`)
  if (/\s/.test(name)) throw new Rejected(`the preset name "${name}" is not one word.`)
  const preset = { name, model: value.slice(0, slash).trim(), effort: value.slice(slash + 1).trim() }
  if (preset.model === '') throw new Rejected(`${name} has no model.`)
  if (!isEffort(preset.effort)) {
    throw new Rejected(`the effort of ${name} is "${preset.effort}", not one of ${EFFORTS.join(', ')}.`)
  }
  return preset
}

function parsePresets(text: string): Preset[] {
  const presets: Preset[] = []
  for (const entry of entries(text, 'name=model/effort')) {
    const preset = parsePreset(entry)
    const twin = findPreset(presets, preset.name)
    if (twin !== undefined) throw new Rejected(`two presets are named ${twin.name}.`)
    presets.push(preset)
  }
  if (presets.length === 0) throw new Rejected('no preset is set.')
  return presets
}

function parseCommands(text: string, presets: readonly Preset[]): Map<string, Preset> {
  const commands = new Map<string, Preset>()
  for (const { key, value } of entries(text, 'command=preset')) {
    const command = key.replace(/^\//, '')
    if (SWITCHES.includes(command)) throw new Rejected(`/${command} cannot be mapped: /model, /effort and /preset are how a preset switches.`)
    if (commands.has(command)) throw new Rejected(`${command} is mapped twice.`)
    const preset = findPreset(presets, value)
    if (preset === undefined) {
      throw new Rejected(`${command} is mapped to ${value}, which is not a preset; the presets are ${presets.map(held => held.name).join(', ')}.`)
    }
    commands.set(command, preset)
  }
  return commands
}

/** Reads the settings; anything malformed rejects them whole, so a half-read setting is never applied. */
export function parseConfig(options: Readonly<Record<string, unknown>>): Parsed {
  try {
    const presets = parsePresets(typeof options.presets === 'string' ? options.presets : '')
    const commands = parseCommands(typeof options.commands === 'string' ? options.commands : '', presets)
    return { kind: 'ok', config: { presets, commands } }
  } catch (error) {
    if (error instanceof Rejected) return { kind: 'rejected', problem: error.message }
    throw error
  }
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
