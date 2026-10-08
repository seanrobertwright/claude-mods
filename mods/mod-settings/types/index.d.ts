/** How a setting takes its value, as Claude Code's settings menu names it. */
export type SettingKind = 'boolean' | 'choice' | 'text' | 'number'

/** One setting of an installed mod, as Claude Code's settings menu holds it now. */
export type SettingRow = {
  /** `<mod>.<field>`: what Claude Code saves it by. */
  key: string
  /** The field's title in the mod's manifest. */
  label: string
  description?: string
  kind: SettingKind
  /** The saved value, else the manifest's default. */
  value: boolean | string | number | readonly string[]
  /** The values a `choice` setting takes, in the manifest's order. */
  options?: readonly string[]
  /** The mod's id, `<mod>@claude-mods`. */
  modId: string
  /** True when managed settings own the value, so it cannot be changed here. */
  isLocked: boolean
}

export type SettingsView = {
  rows: SettingRow[]
  /** The mod whose settings are shown; null for the list of mods. */
  modId: string | null
  /** What the person has entered and not yet saved, by setting key: a boolean for a toggle, else the text or the option. */
  drafts: Record<string, string | boolean>
  /** Why the last save refused a setting, by setting key. */
  problems: Record<string, string>
  /** What the last save did. */
  notice: string
}

declare module 'claude-code' {
  interface PluginState {
    'mod-settings': { view: SettingsView }
  }
}
