import type { ConfigRow } from 'claude-code'

import type { SettingRow } from '../types'

/** The end of every claude-mods id, `<mod>@claude-mods`. */
const MARKETPLACE = '@claude-mods'
/** `claude plugin configure` refuses a text setting longer than this, in UTF-8 bytes. */
const MOST_TEXT_BYTES = 65_536

export type Draft = string | boolean
/** A draft as `$.config.set` takes it, or why it is refused before it gets there. */
export type Converted = { value: boolean | string | number } | { problem: string }

/** The settings of the installed claude-mods among every row of the settings menu, in its order. */
export function settingRows(rows: readonly ConfigRow[]): SettingRow[] {
  return rows
    .filter(row => row.provider.plugin.endsWith(MARKETPLACE))
    .map(row => ({
      key: row.key,
      label: row.label,
      ...(row.description === undefined ? {} : { description: row.description }),
      kind: row.kind,
      value: row.value,
      ...(row.options === undefined ? {} : { options: row.options }),
      modId: row.provider.plugin,
      isLocked: row.isLocked,
    }))
}

/** The mods that have settings, once each, by name. */
export function modsOf(rows: readonly SettingRow[]): { id: string; name: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.modId, (counts.get(row.modId) ?? 0) + 1)
  return [...counts]
    .map(([id, count]) => ({ id, name: id.slice(0, -MARKETPLACE.length), count }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** What the setting's control holds: the person's draft, else the value, as text but for a toggle. */
export function draftOf(row: SettingRow, drafts: Readonly<Record<string, Draft>>): Draft {
  return drafts[row.key] ?? (typeof row.value === 'boolean' ? row.value : String(row.value))
}

/**
 * The draft in the setting's kind. A number that does not read as one is passed on as typed, so Claude Code
 * refuses it in its own words; a text gets the two rules `claude plugin configure` has and the menu lacks.
 */
export function valueOf(row: SettingRow, draft: Draft): Converted {
  if (typeof draft === 'boolean' || row.kind === 'boolean' || row.kind === 'choice') return { value: draft }
  if (row.kind === 'number') {
    const number = Number(draft)
    return { value: draft.trim() !== '' && Number.isFinite(number) ? number : draft }
  }
  if (/[\r\n]/.test(draft)) return { problem: `${row.label} must be a single line.` }
  if (new TextEncoder().encode(draft).length > MOST_TEXT_BYTES) return { problem: `${row.label} is too long (over 64 KB).` }
  return { value: draft }
}

/** Whether saving the draft would change the setting, or be refused. */
export function isChanged(row: SettingRow, draft: Draft): boolean {
  const converted = valueOf(row, draft)
  return 'problem' in converted || converted.value !== row.value
}

export function settingCount(count: number): string {
  return `${count} setting${count === 1 ? '' : 's'}`
}

export function savedNotice(saved: number, refused: number): string {
  if (saved === 0 && refused === 0) return 'No changes.'
  return refused === 0 ? `Saved ${settingCount(saved)}.` : `Saved ${settingCount(saved)}; ${refused} refused.`
}

/** A value as the dialog shows it where it cannot be changed. */
export function shownValue(value: SettingRow['value']): string {
  const text = String(value)
  return text === '' ? 'empty' : text
}
