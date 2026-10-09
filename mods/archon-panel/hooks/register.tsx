import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, Timer } from 'claude-code'

import type { ArchonData, ArchonView, Detail, Project, Run, Tab } from '../types'
import { bodyWindow, lastPosition, pinnedRow, SETTINGS } from './chrome'
import { candidates, findArchon, requirementLine } from './cli'
import type { Runner } from './cli'
import { parseConfig } from './config'
import type { Config } from './config'
import { hasEnded, liveCount, needsYou, needsYouCount } from './runs'
import { runsBody } from './runs-view'
import type { Platform } from './scope'
import { listRuns, readDetail, signature } from './source'
import type { DiskIo } from './source'

const PANE = 'archon'
const TITLE = 'Archon'
/** After a main-thread turn, load only when the runs are older than this. */
const AFTER_TURN_MS = 10_000

const EMPTY_DATA: ArchonData = {
  status: 'idle',
  loadId: 0,
  requirement: { state: 'unchecked', path: '', version: '' },
  project: null,
  source: '',
  loadedAt: 0,
  error: '',
  runs: [],
  others: { live: 0, needsYou: 0 },
  listed: [],
  seen: {},
  details: {},
  graphs: {},
}

const EMPTY_VIEW: ArchonView = {
  tab: 'runs',
  at: { 'runs': 0, 'graph': 0, 'log': 0, 'archon-log': 0 },
  run: '',
  node: '',
  fold: '',
  file: '',
  isFilesOpen: false,
  fanouts: [],
  includes: [],
  loop: '',
  round: 0,
}

const data = atom({ plugin: 'archon-panel', key: 'data' } as const, EMPTY_DATA)
const view = atom({ plugin: 'archon-panel', key: 'view' } as const, EMPTY_VIEW)
const hasStartedUp = atom({ plugin: 'archon-panel', key: 'hasStartedUp' } as const, false)
const startedAt = atom({ plugin: 'archon-panel', key: 'startedAt' } as const, 0)

// Dies with the module on a reload; session.start or the next attach starts it again.
let timer: Timer | undefined
// Counts attaches, so a surfaces check answered before an attach cannot stop
// the polling that attach kept going.
let attaches = 0
// The furthest each sub-tab can scroll, as last drawn; a scroll never goes past it.
const furthest: Record<Tab, number> = { 'runs': 0, 'graph': 0, 'log': 0, 'archon-log': 0 }

/**
 * Whether any surface shows the session right now. Asked before each action
 * the mod starts on its own and never kept: a reload or a missed attach would
 * leave a kept flag wrong. Each mod carries its own copy (ADR-0001).
 */
async function isShown($: EngineInterface): Promise<boolean> {
  return (await $.session.surfaces()).length > 0
}

/** Whether the Archon pane is the one shown, and placed: what "in front" means for polling. */
async function isInFront($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes().catch(() => [])).some(pane => pane.id === PANE && pane.isShown && pane.isPlaced)
}

function report($: EngineInterface): (error: unknown) => void {
  return error => $.ui.toast(`${error instanceof Error ? error.message : String(error)}`)
}

function runner($: EngineInterface): Runner {
  return (argv, timeoutMs) => $.process.run(argv, timeoutMs === undefined ? undefined : { timeoutMs })
}

function io($: EngineInterface): DiskIo {
  return {
    run: runner($),
    fetch: (url, init) => $.http.fetch(url, init),
    sleep: ms => $.clock.sleep(ms),
    exists: path => $.fs.exists(path),
    list: path => $.fs.list(path),
  }
}

async function isWindows($: EngineInterface): Promise<boolean> {
  return (await $.env.get('OS')) === 'Windows_NT'
}

async function home($: EngineInterface): Promise<string> {
  return ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '').replace(/\\/g, '/')
}

async function platformOf($: EngineInterface): Promise<Platform> {
  if (await isWindows($)) return 'windows'
  return ((await $.env.get('HOME')) ?? '').startsWith('/Users/') ? 'mac' : 'linux'
}

/** The output of a git command in the session's folder; '' when git cannot say. */
async function git($: EngineInterface, args: readonly string[]): Promise<string> {
  const run = await $.process.run(['git', ...args]).catch(() => undefined)
  return run?.exitCode === 0 ? run.stdout.trim() : ''
}

/**
 * The session's primary checkout (the parent of Git's common directory) and
 * top level; the session's folder outside Git. Worked out once per session and
 * again on r.
 */
async function findProject($: EngineInterface): Promise<Project> {
  const common = await git($, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const top = await git($, ['rev-parse', '--show-toplevel'])
  if (common === '' || top === '') {
    const cwd = await $.session.cwd()
    return { primary: cwd, top: cwd, branch: '', ids: [], from: '' }
  }
  const primary = common.replace(/\\/g, '/').replace(/\/+$/, '').replace(/\/[^/]+$/, '')
  return { primary, top, branch: await git($, ['branch', '--show-current']), ids: [], from: '' }
}

/** Checks the Requirement and keeps the result in `$.state`. */
async function checkCli($: EngineInterface, config: Config): Promise<boolean> {
  const places = candidates(config.archonPath, await home($), await isWindows($))
  const requirement = await findArchon(runner($), places)
  await update($, data, current => ({ ...current, requirement }))
  return requirement.state === 'ok'
}

/**
 * How long until the next poll, by what the person can see and which source
 * answered: in front with a live run here, in front with nothing live, or
 * behind another tab or closed (the status line and toasts only).
 */
function interval(source: ArchonData['source'], isFront: boolean, hasLive: boolean): number {
  const isServer = source === 'server'
  if (!isFront) return isServer ? 15_000 : 60_000
  if (hasLive) return isServer ? 2_000 : 10_000
  return isServer ? 10_000 : 30_000
}

function hasLiveRun(current: ArchonData): boolean {
  return current.runs.some(run => !hasEnded(run))
}

function stopPolling(): void {
  timer?.cancel()
  timer = undefined
}

/** Polls again after `ms`; a tick that finds no surface stops it until the next attach. */
function schedule($: EngineInterface, config: Config, ms: number): void {
  stopPolling()
  const own = $.clock.after(ms, () => {
    void (async () => {
      const seen = attaches
      if (!(await isShown($))) {
        if (timer === own && attaches === seen) stopPolling()
        return
      }
      if (timer !== own) return
      await load($, config)
    })().catch(report($))
  })
  timer = own
}

/** Arms the next poll at the interval what the person can see now asks for. */
async function scheduleNext($: EngineInterface, config: Config): Promise<void> {
  const current = await read($, data)
  if (current.requirement.state !== 'ok') return stopPolling()
  schedule($, config, interval(current.source, await isInFront($), hasLiveRun(current)))
}

/** Whether a changed row's detail is worth reading: it is live, ended while this session watched, or picked. */
function wantsDetail(run: Run, since: number, picked: string): boolean {
  return !hasEnded(run) || run.completedAt >= since || run.id === picked
}

/**
 * Loads the runs. One load at a time; a load superseded by a reload of the
 * module is dropped by its load id. With the Requirement not met nothing is
 * read, and polling stops until r, an attach or a reload.
 */
async function load($: EngineInterface, config: Config): Promise<void> {
  let loadId = 0
  await update($, data, (current): ArchonData => {
    if (current.status === 'loading') return current
    loadId = current.loadId + 1
    return { ...current, status: 'loading', loadId }
  })
  if (loadId === 0) return
  const finish = (change: (current: ArchonData) => ArchonData) =>
    update($, data, current => (current.loadId === loadId ? change(current) : current))

  const before = await read($, data)
  if (before.requirement.state !== 'ok') {
    stopPolling()
    await finish(current => ({ ...current, status: 'idle' }))
    return
  }
  try {
    const project = before.project ?? (await findProject($))
    const reader = io($)
    const archon = before.requirement.path
    const listing = await listRuns(reader, config.port, archon, project, await platformOf($))
    const isServer = listing.source === 'server'
    const since = await read($, startedAt)
    const picked = (await read($, view)).run
    const runs = new Map(listing.mine.map(run => [run.id, run]))
    const details: Record<string, Detail> = {}
    const seen: Record<string, string> = {}

    // A sub-run whose parent is not listed brings the parent in by id, again only when the sub-run's row changes.
    for (const run of listing.mine) {
      if (run.parentId === '' || runs.has(run.parentId)) continue
      const kept = before.runs.find(known => known.id === run.parentId)
      if (kept !== undefined && before.seen[run.id] === signature(run)) {
        runs.set(kept.id, kept)
        continue
      }
      const parent = await readDetail(reader, config.port, archon, run.parentId, isServer, kept)
      if (parent?.run !== undefined) {
        runs.set(parent.run.id, parent.run)
        details[parent.run.id] = parent.detail
        seen[parent.run.id] = signature(parent.run)
      }
    }

    for (const run of [...runs.values()]) {
      const sig = seen[run.id] ?? signature(run)
      seen[run.id] = sig
      if (details[run.id] !== undefined) continue
      const known = before.details[run.id]
      if (before.seen[run.id] === sig && known !== undefined) {
        details[run.id] = known
        continue
      }
      if (before.seen[run.id] === sig || !wantsDetail(run, since, picked)) continue
      const read = await readDetail(reader, config.port, archon, run.id, isServer, run)
      if (read !== undefined) details[run.id] = read.detail
    }

    const mine = new Set(runs.keys())
    const others = listing.all.filter(run => !mine.has(run.id))
    const loadedAt = await $.clock.now()
    await finish(current => ({
      ...current,
      status: 'idle',
      error: '',
      source: listing.source,
      project: { ...project, ids: listing.ids, from: listing.from },
      runs: [...runs.values()],
      others: { live: liveCount(others), needsYou: 0 },
      listed: listing.all.map(run => run.id),
      seen,
      details,
      loadedAt,
    }))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await finish(current => ({ ...current, status: 'idle', error: reason }))
  }
  if ((await read($, data)).loadId === loadId) await scheduleNext($, config)
}

/** Picks a run: one that needs you opens Log on its gate or wait node; any other opens its Graph. */
async function pick($: EngineInterface, run: Run): Promise<void> {
  const current = await read($, data)
  const byId = new Map(current.runs.map(r => [r.id, r]))
  const need = needsYou(run, byId, current.details)
  if (need === undefined) {
    await update($, view, (v): ArchonView => ({ ...v, tab: 'graph', run: run.id, node: '' }))
    return
  }
  const found = need.attention
  const node = found.kind === 'approval' ? found.gate.nodeId : found.kind === 'action' ? found.wait.nodeId : found.kind === 'stranded' ? found.gate.nodeId : ''
  await update($, view, (v): ArchonView => ({ ...v, tab: 'log', run: need.holder.id, node }))
}

/** Whether mod-settings is installed: the gear shows only then. A command list that cannot be read shows none. */
async function isSettingsInstalled($: EngineInterface): Promise<boolean> {
  return (await $.command.list().catch(() => [])).some(command => command.name === SETTINGS)
}

/** Rechecks the CLI and the project, then loads: at start, on attach, on reload and on r. */
async function reload($: EngineInterface, config: Config): Promise<void> {
  const project = await findProject($)
  await update($, data, current => ({ ...current, project }))
  if (await checkCli($, config)) await load($, config)
  else stopPolling()
}

/** The start-up work: loads, then opens the pane unasked when `isPaneWanted` and this project has a live run. */
async function startUp($: EngineInterface, config: Config, isPaneWanted: boolean): Promise<void> {
  await reload($, config)
  const current = await read($, data)
  if (isPaneWanted && current.requirement.state === 'ok' && hasLiveRun(current)) await $.ui.open({ id: PANE, title: TITLE })
}

export const register: Register = (on, options) => {
  const config = parseConfig(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'archon', description: "Open the Archon pane: this project's workflow runs, their graphs and logs, and the approvals that wait on you" })
    const now = await $.clock.now()
    await update($, startedAt, was => (was === 0 ? now : was))
    // A reload killed any load in flight: drop its loading state and its result.
    await update($, data, (current): ArchonData => ({
      ...current,
      status: 'idle',
      loadId: current.loadId + 1,
    }))
    stopPolling()
    // A headless session does nothing until a surface attaches (session.attach).
    if (await isShown($)) {
      const isFirst = !(await read($, hasStartedUp))
      await update($, hasStartedUp, () => true)
      void (isFirst ? startUp($, config, true) : reload($, config)).catch(report($))
    }
    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    attaches += 1
    const done = await next(e)
    let isFirst = false
    await update($, hasStartedUp, was => {
      isFirst = !was
      return true
    })
    // A session that started headless catches up once. The pane opens unasked
    // only on a surface that docks it beside the conversation; elsewhere, such as
    // on a phone, it waits for /archon.
    if (isFirst) void startUp($, config, e.viewport?.isFullscreen === true).catch(report($))
    else if (timer === undefined) void reload($, config).catch(report($))
    return done
  })

  on('session.detach', async ($, e, next) => {
    const seen = attaches
    const done = await next(e)
    if (!(await isShown($)) && attaches === seen) stopPolling()
    return done
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || !(await isShown($))) return done
    const current = await read($, data)
    if (current.requirement.state === 'ok' && (await $.clock.now()) - current.loadedAt > AFTER_TURN_MS) void load($, config).catch(report($))
    return done
  })

  on('command.run', { command: 'archon' }, async $ => {
    // Focus brings the pane in front of another mod's tab and gives it the keys.
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    void reload($, config).catch(report($))
    return { text: 'Archon pane opened.' }
  })

  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    // The engine's window stays at 0 so the pinned row never scrolls away; the shown sub-tab moves itself.
    await update($, view, (v): ArchonView => {
      const at = Math.min(Math.max(0, v.at[v.tab] + e.by), furthest[v.tab])
      return at === v.at[v.tab] ? v : { ...v, at: { ...v.at, [v.tab]: at } }
    })
    return next({ ...e, offset: 0 })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const current = await read($, data)
    const shown = await read($, view)
    const line = requirementLine(current.requirement)
    const width = Math.max(16, e.props.bodyColumns)
    const bodyRows = e.props.scroll.bodyRows
    const serverLine = `Archon's server isn't answering on port ${config.port}, so runs come from the CLI every ${interval('cli', true, hasLiveRun(current)) / 1000} s. archon serve makes them faster.`
    let lines: RenderElement[]
    if (line !== undefined) lines = [<Text wrap="wrap">{line}</Text>]
    else if (shown.tab === 'runs') {
      lines = runsBody({
        ui,
        data: current,
        view: shown,
        now: await $.clock.now(),
        width,
        platform: await platformOf($),
        serverLine,
        onPick: run => void pick($, run).catch(report($)),
        onFanout: id => void update($, view, (v): ArchonView => ({ ...v, fanouts: v.fanouts.includes(id) ? v.fanouts.filter(f => f !== id) : [...v.fanouts, id] })).catch(report($)),
      })
    } else if (shown.tab === 'archon-log') lines = [<Text dimColor wrap="wrap">No Archon's log at {config.archonLog}. Point Archon's log in the mod settings at the file archon serve writes to.</Text>]
    else lines = [<Text dimColor>Pick a run in Runs.</Text>]
    furthest[shown.tab] = lastPosition(lines.length, bodyRows)
    return (
      <Box flexDirection="column" width={width}>
        {pinnedRow({
          ui,
          width,
          shown: shown.tab,
          live: liveCount(current.runs),
          needsYou: needsYouCount(current.runs, current.details),
          hasSettings: await isSettingsInstalled($),
          onTab: tab => void update($, view, (v): ArchonView => ({ ...v, tab })).catch(report($)),
          onReload: () => void reload($, config).catch(report($)),
          onSettings: () => void $.command.run({ command: SETTINGS }).catch(report($)),
        })}
        {bodyWindow(ui, lines, shown.at[shown.tab], bodyRows)}
      </Box>
    )
  })
}
