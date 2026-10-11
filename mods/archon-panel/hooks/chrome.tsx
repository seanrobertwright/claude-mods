// The pane's chrome: the pinned row of sub-tabs, and the body window under
// it that the mod scrolls itself, so the row never scrolls away.

import type { Elements, RenderElement } from 'claude-code'

import type { Tab } from '../types'

/** The settings dialog's command and its gear's key (ADR-0007). mod-settings takes the press; the gear's onPress is the fallback. */
export const SETTINGS = 'mod-settings'
/** Columns between sub-tabs at full width, and when shortened. */
const GAP = 2
const NARROW_GAP = 1

export const TABS: readonly { tab: Tab; hotkey: string; label: string; short: string }[] = [
  { tab: 'runs', hotkey: '1', label: 'Runs', short: 'Runs' },
  { tab: 'graph', hotkey: '2', label: 'Graph', short: 'Graph' },
  { tab: 'log', hotkey: '3', label: 'Log', short: 'Log' },
  { tab: 'archon-log', hotkey: '4', label: "Archon's log", short: 'Arch' },
]

export type ChromeProps = {
  ui: Elements[keyof Elements]
  width: number
  shown: Tab
  /** This project's live runs, and how many need you. */
  live: number
  needsYou: number
  hasSettings: boolean
  /** False while a Resume button holds `r`. */
  isReloadKey: boolean
  onTab: (tab: Tab) => void
  onReload: () => void
  onSettings: () => void
}

/** The columns a button takes: its `k: ` hotkey prefix and its label, wide characters counting two. */
function buttonWidth(label: string, hotkey: string | undefined): number {
  const cells = [...label].reduce((sum, char) => sum + (/\p{Extended_Pictographic}/u.test(char) ? 2 : /️/u.test(char) ? 0 : 1), 0)
  return (hotkey === undefined ? 0 : hotkey.length + 2) + cells
}

/**
 * The pinned row: exactly one line, the reload and gear at its right end. The
 * sub-tab labels shorten when the full row would not fit beside them, and a
 * column always separates the two, so a cut label never runs into `r: ↻`.
 */
export function pinnedRow(props: ChromeProps): RenderElement {
  const { Box, Button } = props.ui
  const counted = (tab: Tab) => (tab === 'runs' ? `${props.live > 0 ? ` ${props.live}` : ''}${props.needsYou > 0 ? ` ⏸${props.needsYou}` : ''}` : '')
  const tabsWidth = TABS.reduce((sum, { tab, hotkey, label }) => sum + buttonWidth(`${label}${counted(tab)}`, hotkey), 0) + GAP * (TABS.length - 1)
  const actionsWidth = buttonWidth('↻', props.isReloadKey ? 'r' : undefined) + (props.hasSettings ? 1 + buttonWidth('⚙️', undefined) : 0)
  const isNarrow = props.width < tabsWidth + 1 + actionsWidth
  return (
    <Box key="pinned" flexDirection="row" justifyContent="space-between" columnGap={1} height={1} overflow="hidden">
      <Box flexDirection="row" columnGap={isNarrow ? NARROW_GAP : GAP} flexShrink={1} overflow="hidden">
        {TABS.map(({ tab, hotkey, label, short }) => (
          <Button
            key={`tab-${tab}`}
            plain
            hotkey={hotkey}
            dimColor={tab !== props.shown}
            label={`${isNarrow ? short : label}${counted(tab)}`}
            onPress={() => props.onTab(tab)}
          />
        ))}
      </Box>
      <Box flexDirection="row" columnGap={1} flexShrink={0}>
        <Button key="reload" plain dimColor {...(props.isReloadKey ? { hotkey: 'r' } : {})} label="↻" onPress={props.onReload} />
        {props.hasSettings && <Button key={SETTINGS} plain dimColor label="⚙️" onPress={props.onSettings} />}
      </Box>
    </Box>
  )
}

/** The furthest a sub-tab can scroll: its last rows fill the window. */
export function lastPosition(count: number, bodyRows: number): number {
  return Math.max(0, count - Math.max(1, bodyRows - 1))
}

/**
 * The rows the window shows: from `at`, sliced to the body's height under the
 * pinned row, with a `… N more` line counted in that height.
 */
export function bodyWindow(ui: ChromeProps['ui'], lines: readonly RenderElement[], at: number, bodyRows: number): RenderElement[] {
  const { Text } = ui
  const room = Math.max(1, bodyRows - 1)
  const from = Math.min(Math.max(0, at), lastPosition(lines.length, bodyRows))
  if (lines.length - from <= room) return lines.slice(from)
  const shown = lines.slice(from, from + room - 1)
  return [...shown, <Text key="more" dimColor>… {lines.length - from - shown.length} more</Text>]
}
