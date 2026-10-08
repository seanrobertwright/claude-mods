import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SettingRow, SettingsView } from '../types'
import { draftOf, isChanged, modsOf, savedNotice, settingCount, settingRows, shownValue, valueOf } from './settings'
import type { Draft } from './settings'

/** The command, the dialog's pane id, and the key of the gear the pane mods draw (ADR-0007). */
const NAME = 'mod-settings'
const TITLE = 'Mod settings'

const EMPTY: SettingsView = { rows: [], modId: null, drafts: {}, problems: {}, notice: '' }
const view = atom({ plugin: 'mod-settings', key: 'view' } as const, EMPTY)

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function report($: EngineInterface): (error: unknown) => void {
  return error => $.ui.toast(`Mod settings: ${message(error)}`)
}

/** The dialog holds toasts while it shows, so what goes wrong in it is said on its notice line. */
function notify($: EngineInterface): (error: unknown) => void {
  return error => void update($, view, (current): SettingsView => ({ ...current, notice: message(error) })).catch(report($))
}

async function load($: EngineInterface): Promise<void> {
  const rows = settingRows(await $.config.list())
  await update($, view, (current): SettingsView => ({ ...current, rows }))
}

/** Opens the dialog in front on the list of mods, read afresh, as an answer to the person's press or command. */
async function openDialog($: EngineInterface): Promise<void> {
  const rows = settingRows(await $.config.list())
  await update($, view, (): SettingsView => ({ ...EMPTY, rows }))
  await $.ui.open({ id: NAME, title: TITLE, focus: true, closeOnEscape: true, holdToasts: true })
}

async function choose($: EngineInterface, modId: string | null): Promise<void> {
  await update($, view, (current): SettingsView => ({ ...current, modId, drafts: {}, problems: {}, notice: '' }))
  await load($)
}

async function setDraft($: EngineInterface, key: string, draft: Draft): Promise<void> {
  await update($, view, (current): SettingsView => ({ ...current, drafts: { ...current.drafts, [key]: draft } }))
}

/**
 * Saves the shown mod's changed settings through Claude Code's settings menu, one at a time in their order,
 * so one refused does not stop the rest. A refused setting keeps its draft and its reason; the values shown
 * after are the ones Claude Code holds.
 */
async function save($: EngineInterface): Promise<void> {
  const { rows, modId, drafts } = await read($, view)
  const changed = rows.filter(row => row.modId === modId && !row.isLocked && isChanged(row, draftOf(row, drafts)))
  const problems: Record<string, string> = {}
  const saved: string[] = []
  for (const row of changed) {
    const converted = valueOf(row, draftOf(row, drafts))
    const refusal = 'problem' in converted
      ? converted.problem
      : (await $.config.set({ key: row.key, value: converted.value }).catch((error: unknown) => ({ deny: message(error) }))).deny
    if (refusal === undefined) saved.push(row.key)
    else problems[row.key] = refusal
  }
  const after = changed.length === 0 ? rows : settingRows(await $.config.list())
  await update($, view, (current): SettingsView => ({
    ...current,
    rows: after,
    drafts: Object.fromEntries(Object.entries(current.drafts).filter(([key]) => !saved.includes(key))),
    problems,
    notice: savedNotice(saved.length, Object.keys(problems).length),
  }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: NAME, description: 'Open the mod settings dialog: change and save any claude-mods setting' })
    return started
  })

  on('command.run', { command: NAME }, async $ => {
    await openDialog($)
    return { text: 'Mod settings opened.' }
  })

  // Taken here, the gear's press opens the dialog as the person's own act; the gear's onPress is not run.
  on('ui.press', { element: NAME }, async ($, e) => {
    await openDialog($).catch(report($))
    return { element: e.element }
  })

  on('ui.render', { component: 'Pane', requestId: NAME }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const current = await read($, view)
    const width = Math.max(16, e.props.bodyColumns)
    const close = (
      <Button key="close" plain dimColor role="dismiss" label="close" onPress={() => void $.ui.close({ id: NAME }).catch(notify($))} />
    )

    if (current.modId === null) {
      const mods = modsOf(current.rows)
      return (
        <Box flexDirection="column" width={width}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text bold>{TITLE}</Text>
            {close}
          </Box>
          {mods.length === 0 && <Text dimColor wrap="wrap">No installed claude-mods have settings.</Text>}
          {mods.map(mod => (
            <Box key={`mod-row-${mod.name}`} flexDirection="row" columnGap={2}>
              <Button key={`mod-${mod.name}`} plain label={mod.name} onPress={() => void choose($, mod.id).catch(notify($))} />
              <Text dimColor>{settingCount(mod.count)}</Text>
            </Box>
          ))}
          <Text dimColor wrap="wrap">Mods with no settings are not listed.</Text>
          {current.notice !== '' && <Text dimColor wrap="wrap">{current.notice}</Text>}
        </Box>
      )
    }

    const shown = current.rows.filter(row => row.modId === current.modId)
    const control = (row: SettingRow) => {
      const draft = draftOf(row, current.drafts)
      if (row.isLocked) return <Text dimColor wrap="wrap">{`${shownValue(row.value)} (locked)`}</Text>
      if (row.kind === 'boolean') {
        return <Button key={`set-${row.key}`} label={draft === true ? 'on' : 'off'} onPress={() => void setDraft($, row.key, draft !== true).catch(notify($))} />
      }
      if (row.kind === 'choice') {
        return (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {(row.options ?? []).map(option => (
              <Button
                key={`set-${row.key}-${option}`}
                variant={option === draft ? 'primary' : 'secondary'}
                label={option}
                onPress={() => void setDraft($, row.key, option).catch(notify($))}
              />
            ))}
          </Box>
        )
      }
      if (e.surface === 'mobile') return <Text dimColor wrap="wrap">{`${shownValue(String(draft))} (change it on another surface)`}</Text>
      const { Input } = $.ui.resolve(e)
      return (
        <Input
          key={`input-${row.key}`}
          value={String(draft)}
          submitLabel="save"
          onInput={value => void setDraft($, row.key, value).catch(notify($))}
          onSubmit={value => void setDraft($, row.key, value).then(() => save($)).catch(notify($))}
        />
      )
    }

    return (
      <Box flexDirection="column" width={width}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold wrap="truncate-end">{modsOf(shown)[0]?.name ?? TITLE}</Text>
          <Box flexDirection="row" columnGap={1}>
            <Button key="back" plain dimColor label="back" onPress={() => void choose($, null).catch(notify($))} />
            {close}
          </Box>
        </Box>
        {shown.map(row => (
          <Box key={`row-${row.key}`} flexDirection="column" marginTop={1}>
            <Text bold wrap="wrap">{row.label}</Text>
            {row.description !== undefined && <Text dimColor wrap="wrap">{row.description}</Text>}
            {control(row)}
            {current.problems[row.key] !== undefined && <Text color="red" wrap="wrap">{current.problems[row.key]}</Text>}
          </Box>
        ))}
        <Box flexDirection="row" columnGap={2} marginTop={1}>
          <Button key="save" variant="primary" label="Save" onPress={() => void save($).catch(notify($))} />
          {current.notice !== '' && <Text dimColor wrap="wrap">{current.notice}</Text>}
        </Box>
      </Box>
    )
  })
}
