import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ConfigRow, ConfigValue, On } from 'claude-code'

import { isChanged, modsOf, settingRows, valueOf } from '../hooks/settings'

const ROOT = '/work/audit'

const DIALOG = {
  title: 'Mod settings',
  isFocused: true,
  bodyColumns: 50,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

const COMPOSER = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 60 } } as const

function hud(field: string, row: Omit<ConfigRow, 'key' | 'provider' | 'isLocked'> & { isLocked?: boolean }): ConfigRow {
  return { key: `hud.${field}`, provider: { plugin: 'hud@claude-mods', tier: 'user' }, isLocked: false, ...row }
}

/** The settings menu's rows: the engine's own, two claude-mods, a locked row, and another marketplace's plugin. */
function menuRows(): ConfigRow[] {
  return [
    { key: 'verbose', label: 'Verbose output', kind: 'boolean', value: false, provider: { plugin: 'engine', tier: 'core' }, isLocked: false },
    hud('theme', { label: 'Colour theme', kind: 'choice', value: 'neon', options: ['neon', 'ocean', 'ember', 'mono'] }),
    hud('animate', { label: 'Animate while working', kind: 'boolean', value: true }),
    hud('placement', { label: 'Where the row is drawn', kind: 'choice', value: 'below', options: ['below', 'above'], isLocked: true }),
    hud('hide', { label: 'Segments to hide', description: 'Comma-separated segment names', kind: 'text', value: 'folder' }),
    {
      key: 'auto-resume.maxRetries',
      label: 'Most retries in a row',
      kind: 'number',
      value: 3,
      provider: { plugin: 'auto-resume@claude-mods', tier: 'user' },
      isLocked: false,
    },
    { key: 'other.mode', label: 'Mode', kind: 'text', value: 'fast', provider: { plugin: 'other@elsewhere', tier: 'user' }, isLocked: false },
  ]
}

/** The world beneath the mod: the settings menu, and what the mod saved, opened, closed and toasted. */
type World = {
  rows: ConfigRow[]
  sets: { key: string; value: ConfigValue }[]
  opened: { id: string; focus: boolean; closeOnEscape: boolean; holdToasts: boolean }[]
  closed: string[]
  toasts: string[]
}

function engineBeneath(on: On) {
  const world: World = { rows: menuRows(), sets: [], opened: [], closed: [], toasts: [] }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('config.list', () => ({ value: world.rows.map(row => ({ ...row })) }))
  // As the engine's core: a number row refuses anything but a number; otherwise the value is written.
  on('config.set', (_$, e) => {
    world.sets.push({ key: e.key, value: e.value })
    const row = world.rows.find(each => each.key === e.key)
    if (row === undefined) throw new Error(`no row ${e.key}`)
    if (row.kind === 'number' && typeof e.value !== 'number') return { deny: 'takes a number' }
    row.value = e.value
    return { value: e.value }
  })
  on('ui.open', (_$, e) => {
    world.opened.push({ id: e.id, focus: e.focus === true, closeOnEscape: e.closeOnEscape === true, holdToasts: e.holdToasts === true })
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$, e) => {
    world.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  return world
}

async function openedDialog($: Engine) {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect((await $.command.run({ command: 'mod-settings', args: '', ...COMPOSER })).text).toBe('Mod settings opened.')
  return $.ui.mount({ plugin: 'mod-settings', surface: 'terminal', component: 'Pane', requestId: 'mod-settings', props: DIALOG })
}

test('settingRows, modsOf, valueOf and isChanged keep to claude-mods and the CLI text rules', () => {
  const rows = settingRows(menuRows())
  expect(rows.map(row => row.key)).toEqual(['hud.theme', 'hud.animate', 'hud.placement', 'hud.hide', 'auto-resume.maxRetries'])
  expect(modsOf(rows)).toEqual([
    { id: 'auto-resume@claude-mods', name: 'auto-resume', count: 1 },
    { id: 'hud@claude-mods', name: 'hud', count: 4 },
  ])
  const [theme, animate, , hide, retries] = rows
  expect(valueOf(retries!, ' 12 ')).toEqual({ value: 12 })
  expect(valueOf(retries!, 'abc')).toEqual({ value: 'abc' })
  expect(valueOf(retries!, '')).toEqual({ value: '' })
  expect(valueOf(animate!, false)).toEqual({ value: false })
  expect(valueOf(theme!, 'ember')).toEqual({ value: 'ember' })
  expect(valueOf(hide!, 'cost\nfolder')).toEqual({ problem: 'Segments to hide must be a single line.' })
  expect(valueOf(hide!, 'é'.repeat(32_768) + 'x')).toEqual({ problem: 'Segments to hide is too long (over 64 KB).' })
  expect(valueOf(hide!, 'x'.repeat(65_536))).toEqual({ value: 'x'.repeat(65_536) })
  expect(isChanged(retries!, '3')).toBe(false)
  expect(isChanged(retries!, '4')).toBe(true)
  expect(isChanged(hide!, 'folder')).toBe(false)
  expect(isChanged(hide!, 'folder\n')).toBe(true)
})

test('save writes each changed setting through the settings menu and shows the values it holds', async ($, on) => {
  const world = engineBeneath(on)
  const dialog = await openedDialog($)
  expect((await dialog.find({ key: 'mod-hud' }))?.text).toBe('hud')
  expect(await dialog.find({ key: 'mod-other' })).toBeUndefined()

  await dialog.press({ key: 'mod-hud' })
  await dialog.press({ key: 'set-hud.theme-ember' })
  await dialog.input({ key: 'input-hud.hide', text: 'cost', kind: 'change' })
  await dialog.press({ key: 'save' })

  expect(world.sets).toEqual([{ key: 'hud.theme', value: 'ember' }, { key: 'hud.hide', value: 'cost' }])
  expect((await dialog.find({ key: 'set-hud.theme-ember' }))?.props.variant).toBe('primary')
  expect((await dialog.find({ key: 'set-hud.theme-neon' }))?.props.variant).toBe('secondary')
  expect((await dialog.find({ key: 'input-hud.hide' }))?.props.value).toBe('cost')
  expect(await dialog.find({ type: 'Text', text: 'Saved 2 settings.' })).toBeDefined()
  expect(await dialog.find({ type: 'Text', text: 'below (locked)' })).toBeDefined()
  expect(await dialog.find({ key: 'set-hud.placement-above' })).toBeUndefined()

  await dialog.press({ key: 'close' })
  expect(world.closed).toEqual(['mod-settings'])
  await dialog.unmount()
})

test('a refused value shows in red under its setting, keeps what was typed, and does not stop the others', async ($, on) => {
  const world = engineBeneath(on)
  const dialog = await openedDialog($)

  await dialog.press({ key: 'mod-auto-resume' })
  await dialog.input({ key: 'input-auto-resume.maxRetries', text: 'abc', kind: 'change' })
  await dialog.press({ key: 'save' })
  expect((await dialog.find({ type: 'Text', text: 'takes a number' }))?.props.color).toBe('red')
  expect((await dialog.find({ key: 'input-auto-resume.maxRetries' }))?.props.value).toBe('abc')

  await dialog.input({ key: 'input-auto-resume.maxRetries', text: '12' })
  expect(world.sets).toEqual([{ key: 'auto-resume.maxRetries', value: 'abc' }, { key: 'auto-resume.maxRetries', value: 12 }])
  expect(await dialog.find({ type: 'Text', text: 'takes a number' })).toBeUndefined()
  expect(await dialog.find({ type: 'Text', text: 'Saved 1 setting.' })).toBeDefined()

  world.sets.length = 0
  await dialog.press({ key: 'back' })
  await dialog.press({ key: 'mod-hud' })
  await dialog.press({ key: 'set-hud.theme-ocean' })
  await dialog.input({ key: 'input-hud.hide', text: 'cost\nfolder', kind: 'change' })
  await dialog.press({ key: 'save' })
  expect(world.sets).toEqual([{ key: 'hud.theme', value: 'ocean' }])
  expect((await dialog.find({ type: 'Text', text: 'Segments to hide must be a single line.' }))?.props.color).toBe('red')
  expect((await dialog.find({ key: 'input-hud.hide' }))?.props.value).toBe('cost\nfolder')
  expect(await dialog.find({ type: 'Text', text: 'Saved 1 setting; 1 refused.' })).toBeDefined()
  await dialog.unmount()
})

test('saving with nothing changed sends nothing', async ($, on) => {
  const world = engineBeneath(on)
  const dialog = await openedDialog($)

  await dialog.press({ key: 'mod-hud' })
  await dialog.press({ key: 'save' })
  expect(await dialog.find({ type: 'Text', text: 'No changes.' })).toBeDefined()

  await dialog.input({ key: 'input-hud.hide', text: 'cost', kind: 'change' })
  await dialog.input({ key: 'input-hud.hide', text: 'folder', kind: 'change' })
  await dialog.press({ key: 'set-hud.animate' })
  await dialog.press({ key: 'set-hud.animate' })
  await dialog.press({ key: 'save' })
  expect(world.sets).toEqual([])
  await dialog.unmount()
})

test(
  "the gear's press on another mod's pane opens the dialog in front, and the gear's own press does not run",
  {
    plugins: [
      {
        name: 'outputs',
        register(on) {
          on('ui.render', { component: 'Pane', requestId: 'outputs' }, async ($, e) => {
            const { Button } = $.ui.resolve(e)
            return <Button key="mod-settings" plain dimColor label="⚙️" onPress={() => $.ui.toast('the gear ran its own press')} />
          })
        },
      },
    ],
  },
  async ($, on) => {
    const world = engineBeneath(on)
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    const pane = await $.ui.mount({ plugin: 'outputs', surface: 'terminal', component: 'Pane', requestId: 'outputs', props: { ...DIALOG, title: 'Outputs' } })

    expect(await pane.press({ key: 'mod-settings' })).toEqual({ element: 'mod-settings' })
    expect(world.opened).toEqual([{ id: 'mod-settings', focus: true, closeOnEscape: true, holdToasts: true }])
    expect(world.toasts).toEqual([])
    await pane.unmount()
  },
)

test('on a phone a text or number setting shows its value without a field', async ($, on) => {
  engineBeneath(on)
  await $.session.start({ cwd: ROOT, surface: 'mobile', isInteractive: true })
  await $.command.run({ command: 'mod-settings', args: '', ...COMPOSER })
  const dialog = await $.ui.mount({ plugin: 'mod-settings', surface: 'mobile', component: 'Pane', requestId: 'mod-settings', props: DIALOG })
  await dialog.press({ key: 'mod-hud' })
  expect(await dialog.find({ type: 'Input' })).toBeUndefined()
  expect(await dialog.find({ type: 'Text', text: 'folder (change it on another surface)' })).toBeDefined()
  expect(await dialog.find({ key: 'set-hud.theme-neon' })).toBeDefined()
  await dialog.unmount()
})
