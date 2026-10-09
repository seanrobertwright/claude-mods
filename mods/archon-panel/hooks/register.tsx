import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, Timer } from 'claude-code'

import type { ArchonActions, ArchonData, ArchonView, Detail, LogWindow, Notice, Pending, Project, Run, Tab } from '../types'
import { deliver, hasMoved, movedElsewhere, recordLine, REPLY_MS } from './actions'
import { actionBody, offersResume } from './actions-view'
import { bodyWindow, lastPosition, pinnedRow, SETTINGS } from './chrome'
import { candidates, findArchon, requirementLine } from './cli'
import { readWorkflow } from './graph'
import { drawNodes, graphBody } from './graph-view'
import { EMPTY_WINDOW, isUnder, splitChunk, take, toolSteps } from './log'
import { logBody } from './log-view'
import type { OpenedFile } from './log-view'
import { claimKey, collapse, isClaimed, isMine, statusText, toastEvents } from './notify'
import type { Runner } from './cli'
import { parseConfig } from './config'
import type { Config } from './config'
import { hasEnded, liveCount, needsYou, needsYouCount, sortRuns, topRuns, waitNode } from './runs'
import { runsBody } from './runs-view'
import { capLines, expandHome, serveLine } from './serve-log'
import type { Platform } from './scope'
import { listRuns, readDetail, serverText, signature } from './source'
import { clockTime, dollars, duration, firstLine } from './text'
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
const logWindow = atom({ plugin: 'archon-panel', key: 'log' } as const, EMPTY_WINDOW)
const EMPTY_ACTIONS: ArchonActions = { pending: null, text: {}, sending: '', notices: {}, records: {}, checks: {} }
const actions = atom({ plugin: 'archon-panel', key: 'actions' } as const, EMPTY_ACTIONS)
const serveLog = atom({ plugin: 'archon-panel', key: 'serveLog' } as const, { lines: [] as string[], size: 0, isMissing: false })

// Dies with the module on a reload; session.start or the next attach starts it again.
let timer: Timer | undefined
// Counts attaches, so a surfaces check answered before an attach cannot stop
// the polling that attach kept going.
let attaches = 0
// The run log follower: one spawned `archon workflow logs <id> --follow`, for the one live run whose log is in front.
let follower: { runId: string; stream: AsyncGenerator<unknown, unknown> } | undefined
// The file open in Log's read view, fetched only when opened.
let opened: OpenedFile | undefined
// A line the read view shows under its buttons, such as the prompt box refusing.
let fileNotice = ''
// The furthest each sub-tab can scroll, as last drawn; a scroll never goes past it.
const furthest: Record<Tab, number> = { 'runs': 0, 'graph': 0, 'log': 0, 'archon-log': 0 }
// Whether each log sits at its end, and so follows its tail as rows arrive.
const atEnd: Record<'log' | 'archon-log', boolean> = { 'log': true, 'archon-log': true }
// Whether the pane was in front when a tick or a draw last looked; undefined until one has.
let wasInFront: boolean | undefined

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
  const isFront = await isInFront($)
  wasInFront = isFront
  schedule($, config, interval(current.source, isFront, hasLiveRun(current)))
}

/**
 * Loads at once when a draw finds the pane come forward since a tick or a
 * draw last looked: no event fires when its tab is brought forward, and the
 * tick it set while behind could be a minute off. A draw writes nothing, so
 * the load starts from a timer of its own.
 */
async function loadIfForward($: EngineInterface, config: Config): Promise<void> {
  const isFront = await isInFront($)
  const was = wasInFront
  wasInFront = isFront
  if (was === false && isFront) $.clock.after(0, () => void load($, config).catch(report($)))
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
      others: { live: liveCount(others), needsYou: needsYouCount(others, {}) },
      listed: listing.all.map(run => run.id),
      seen,
      details,
      loadedAt,
    }))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await finish(current => ({ ...current, status: 'idle', error: reason }))
  }
  if ((await read($, data)).loadId !== loadId) return
  await scheduleNext($, config)
  void notify($, config).catch(report($))
  void syncLog($, config).catch(report($))
  await settleActions($)
}

/** A moment for another session's claim on the same toast to land before this one reads its own back. */
const CLAIM_WAIT_MS = 300

/**
 * Sets the status line and raises this poll's toasts. Each toast is claimed
 * in the shared store first, so one event toasts once across sessions, best
 * effort: a session that is headless or has toasts off never claims.
 */
async function notify($: EngineInterface, config: Config): Promise<void> {
  if (!(await isShown($))) return
  const current = await read($, data)
  $.ui.status(config.isStatusLine ? statusText(current.runs, current.details, current.others.needsYou) : undefined)
  await prune($, current.listed)
  if (config.toasts === 'off') return
  const events = toastEvents(current.runs, current.details, await read($, startedAt))
    .filter(event => config.toasts === 'all' || event.event === 'needs-you')
  const session = await $.session.id()
  const claimed = []
  for (const event of events) {
    if (isClaimed(event, await $.store.get(claimKey(event)))) continue
    await $.store.set(claimKey(event), { session, gate: event.gate })
    claimed.push(event)
  }
  if (claimed.length === 0) return
  await $.clock.sleep(CLAIM_WAIT_MS)
  const won = []
  for (const event of claimed) if (isMine(await $.store.get(claimKey(event)), session)) won.push(event)
  const toast = collapse(won)
  if (toast !== undefined) $.ui.toast(toast.text, { timeoutMs: toast.timeoutMs })
}

/** Drops the toast claims of runs no longer among the listed rows. */
async function prune($: EngineInterface, listed: readonly string[]): Promise<void> {
  if (listed.length === 0) return
  const ids = new Set(listed)
  for (const key of await $.store.keys()) {
    const [kind, runId] = key.split('/')
    if (kind === 'toasted' && runId !== undefined && !ids.has(runId)) await $.store.delete(key)
  }
}

/** Picks a run: one that needs you opens Log on its gate or wait node; any other opens its Graph. */
async function pick($: EngineInterface, config: Config, run: Run): Promise<void> {
  // Picking a run, even the one in front, starts its window afresh, unless it is being followed.
  if (follower?.runId !== run.id) {
    stopFollower()
    await update($, logWindow, () => EMPTY_WINDOW)
    atEnd.log = true
  }
  await update($, actions, (a): ArchonActions => ({ ...a, pending: null, records: Object.fromEntries(Object.entries(a.records).filter(([id]) => id === run.id)) }))
  const current = await read($, data)
  const need = needsYou(run, current.runs, current.details)
  if (need === undefined) {
    await openGraph($, run.id)
    return
  }
  await changeView($, config, (v): ArchonView => ({ ...v, tab: 'log', run: need.holder.id, node: waitNode(need.standing), file: '' }))
}

/** Reads a run's graph once from its frozen workflow source, which never changes. */
async function ensureGraph($: EngineInterface, runId: string): Promise<void> {
  const current = await read($, data)
  const run = current.runs.find(r => r.id === runId)
  if (run === undefined || current.graphs[runId] !== undefined) return
  const nodes = await readWorkflow({ list: path => $.fs.list(path), read: path => $.fs.read(path) }, run.sourceRoot, run.workflow)
  await update($, data, (d): ArchonData => ({ ...d, graphs: { ...d.graphs, [runId]: nodes } }))
}

/** Picks a box in the Graph: a node opens Log cut to it; a block, loop or sub-run box opens what it folds. */
async function pickNode($: EngineInterface, config: Config, runId: string, id: string): Promise<void> {
  const current = await read($, data)
  const shown = await read($, view)
  const run = current.runs.find(r => r.id === runId)
  const nodes = current.graphs[runId]
  if (run === undefined) return
  if (id.includes('.')) {
    await openNode($, config, run, id)
    return
  }
  const pickOf = nodes === undefined || nodes === null ? undefined : drawNodes(nodes, run, current.runs, current.details, shown).picks.get(id)
  if (pickOf?.kind === 'block') {
    const key = `${runId}:${pickOf.id}`
    await update($, view, (v): ArchonView => ({ ...v, includes: v.includes.includes(key) ? v.includes : [...v.includes, key] }))
  } else if (pickOf?.kind === 'loop') {
    const key = `${runId}:${pickOf.id}`
    await update($, view, (v): ArchonView => ({ ...v, loop: v.loop === key ? '' : key, round: 0 }))
  } else if (pickOf?.kind === 'workflow' && pickOf.subRuns.length > 0) {
    const waiting = pickOf.subRuns.find(subRun => needsYou(subRun, current.runs, current.details) !== undefined)
    if (waiting !== undefined) await pick($, config, waiting)
    else if (pickOf.subRuns.length > 1) {
      const key = `${runId}:${pickOf.id}`
      await update($, view, (v): ArchonView => ({ ...v, fanouts: v.fanouts.includes(key) ? v.fanouts.filter(f => f !== key) : [...v.fanouts, key] }))
    } else await openGraph($, pickOf.subRuns[0]!.id)
  } else {
    await openNode($, config, run, id)
  }
}

/**
 * Opens Log cut to a node. A finished run whose window lost that node's rows
 * off its top refills it with one replay of that node's rows.
 */
async function openNode($: EngineInterface, config: Config, run: Run, node: string): Promise<void> {
  await changeView($, config, (v): ArchonView => ({ ...v, tab: 'log', run: run.id, node, file: '' }))
  const win = await read($, logWindow)
  if (hasEnded(run) && win.runId === run.id && win.dropped > 0 && !win.rows.some(row => row.nodes.includes(node))) await replay($, config, run, node)
}

/** `a`: Log widened to all nodes, back to the run's newest rows. */
async function showAll($: EngineInterface, config: Config): Promise<void> {
  await update($, view, (v): ArchonView => ({ ...v, node: '' }))
  const current = await read($, data)
  const picked = (await read($, view)).run
  const run = current.runs.find(r => r.id === picked)
  const win = await read($, logWindow)
  if (run !== undefined && win.runId === run.id && win.node !== '') {
    if (hasEnded(run)) await replay($, config, run)
    else {
      stopFollower()
      await update($, logWindow, () => EMPTY_WINDOW)
      await syncLog($, config)
    }
  }
}

/** Shows a run's Graph, reading its source the first time. */
async function openGraph($: EngineInterface, runId: string): Promise<void> {
  await update($, view, (v): ArchonView => ({ ...v, tab: 'graph', run: runId, node: '' }))
  await ensureGraph($, runId)
}

/** Reads one run again by id, keeping its row and detail: before an action, and when its follower ends. */
async function refreshRun($: EngineInterface, config: Config, runId: string): Promise<{ run: Run; detail: Detail } | undefined> {
  const current = await read($, data)
  const known = current.runs.find(r => r.id === runId)
  const got = await readDetail(io($), config.port, current.requirement.path, runId, current.source !== 'cli', known).catch(() => undefined)
  if (got?.run === undefined) return undefined
  const run = got.run
  await update($, data, (d): ArchonData => ({
    ...d,
    runs: d.runs.some(r => r.id === run.id) ? d.runs.map(r => (r.id === run.id ? run : r)) : [...d.runs, run],
    details: { ...d.details, [run.id]: got.detail },
  }))
  return { run, detail: got.detail }
}

/** A finished run's end line: `✓ completed 37m $4.12`, or how it failed. */
function endLine(run: Run, detail: Detail | undefined): string {
  const spent = duration(run.completedAt - run.startedAt)
  const cost = run.costUsd > 0 ? ` ${dollars(run.costUsd)}` : ''
  if (run.status === 'completed') return `✓ completed ${spent}${cost}`
  if (run.status === 'cancelled') return `✗ cancelled ${spent}${cost}`
  const failed = [...(detail?.events ?? [])].reverse().find(e => e.type === 'node_failed')
  const error = firstLine(failed?.error ?? '')
  return `✗ failed ${spent}${cost}${failed === undefined ? '' : ` at ${failed.step}`}${error === '' ? '' : `: ${error}`}`
}

function stopFollower(): void {
  const own = follower
  follower = undefined
  void own?.stream.return(undefined).catch(() => {})
}

/**
 * Follows a live run's log with `archon workflow logs <id> --follow`, which
 * starts at line 1 and exits once the run reaches a final status. A spawn
 * delivers chunks, not lines, so a partial last line waits for the next. A
 * restart after a reload replays from line 1, skipping the lines already taken.
 */
async function follow($: EngineInterface, config: Config, runId: string): Promise<void> {
  const archon = (await read($, data)).requirement.path
  let win = await read($, logWindow)
  if (win.runId !== runId || win.node !== '') {
    win = { ...EMPTY_WINDOW, runId }
    await update($, logWindow, () => win)
  }
  const skip = win.taken
  const stream = $.process.spawn({ argv: [archon, 'workflow', 'logs', runId, '--follow'] })
  const own = { runId, stream }
  follower = own
  let held = ''
  let lineNo = 0
  let isOver: boolean
  let code: number | null = null
  try {
    for await (const chunk of stream) {
      if (follower !== own) break
      if (chunk.stream !== 'stdout') continue
      const split = splitChunk(held, chunk.text)
      held = split.held
      const from = lineNo
      lineNo += split.lines.length
      if (split.lines.length > 0) await update($, logWindow, (w): LogWindow => (w.runId === runId ? take(w, split.lines, from, skip) : w))
    }
    isOver = follower === own
    if (isOver) code = (await stream.result).code
  } catch {
    isOver = follower === own
  } finally {
    if (follower === own) follower = undefined
  }
  if (!isOver) return
  if (code !== 0 && lineNo === 0) await update($, logWindow, (w): LogWindow => (w.runId === runId ? { ...w, isMissing: true } : w))
  const got = await refreshRun($, config, runId)
  if (got !== undefined && hasEnded(got.run)) {
    await update($, logWindow, (w): LogWindow => (w.runId === runId ? { ...w, end: endLine(got.run, got.detail) } : w))
  }
}

/** A finished run's log, in one `archon workflow logs <id>`; with `node`, only that node's rows are kept. */
async function replay($: EngineInterface, config: Config, run: Run, node = ''): Promise<void> {
  const archon = (await read($, data)).requirement.path
  const out = await runner($)([archon, 'workflow', 'logs', run.id]).catch(() => undefined)
  if ((await read($, data)).details[run.id] === undefined) await refreshRun($, config, run.id)
  const detail = (await read($, data)).details[run.id]
  const steps = toolSteps(detail?.events ?? [])
  let win: LogWindow = { ...EMPTY_WINDOW, runId: run.id, node }
  if (out?.exitCode === 0) win = take(win, out.stdout.replace(/\n$/, '').split('\n'), 0, 0, row => isUnder(row, node, steps))
  else win = { ...win, isMissing: true }
  const latest = (await read($, data)).runs.find(r => r.id === run.id) ?? run
  if (hasEnded(latest)) win = { ...win, end: endLine(latest, detail) }
  await update($, logWindow, () => win)
}

/**
 * Keeps the run log in step with what the person sees: the follower runs only
 * while a live run's log is in front, one run at a time; a finished run is
 * replayed once, and its window kept until another run is picked.
 */
async function syncLog($: EngineInterface, config: Config): Promise<void> {
  const current = await read($, data)
  const shown = await read($, view)
  if (shown.tab === 'archon-log' && (await isShown($)) && (await isInFront($))) await readServeLog($, config)
  const run = current.runs.find(r => r.id === shown.run)
  const isWanted = run !== undefined && shown.tab === 'log' && current.requirement.state === 'ok' && (await isShown($)) && (await isInFront($))
  if (!isWanted || run === undefined) return stopFollower()
  if (!hasEnded(run)) {
    if (follower?.runId !== run.id) {
      stopFollower()
      void follow($, config, run.id).catch(report($))
    }
    return
  }
  if (follower?.runId === run.id) return
  stopFollower()
  const win = await read($, logWindow)
  if (win.runId !== run.id) await replay($, config, run)
}

/** Reads Archon's log while its sub-tab is in front, keeping the newest lines under 60,000 characters. */
async function readServeLog($: EngineInterface, config: Config): Promise<void> {
  const path = expandHome(config.archonLog, await home($))
  const text = await $.fs.read(path).catch(() => undefined)
  await update($, serveLog, () => (text === undefined
    ? { lines: [], size: 0, isMissing: true }
    : { lines: capLines(text.split(/\r?\n/).filter(line => line !== '')), size: text.length, isMissing: false }))
}

/** Changes what the person sees, then brings the run log in step. */
async function changeView($: EngineInterface, config: Config, change: (v: ArchonView) => ArchonView): Promise<void> {
  const was = await read($, view)
  await update($, view, change)
  const now = await read($, view)
  // A change of run or sub-tab drops the pending action; any typed text stays.
  if (now.tab !== was.tab || now.run !== was.run) await update($, actions, (a): ArchonActions => (a.pending === null ? a : { ...a, pending: null }))
  await syncLog($, config)
}

/** Where a run's file is on disk. */
function filePath(run: Run, path: string): string {
  return `${run.outputRoot.replace(/\\/g, '/').replace(/\/+$/, '')}/artifacts/runs/${run.id}/${path}`
}

/** Opens one of the run's files in Log's read view: from the server while it answers, else from disk. */
async function openFile($: EngineInterface, config: Config, path: string): Promise<void> {
  const current = await read($, data)
  const shown = await read($, view)
  const run = current.runs.find(r => r.id === shown.run)
  await update($, view, (v): ArchonView => ({ ...v, tab: 'log', file: path }))
  fileNotice = ''
  if (run === undefined) return
  const listed = current.details[run.id]?.files.find(file => file.path === path)
  let text: string | undefined
  if (current.source === 'server') {
    const got = await serverText(io($), `http://localhost:${config.port}/api/artifacts/${encodeURIComponent(run.id)}/${path.split('/').map(encodeURIComponent).join('/')}`)
    text = got?.text
  }
  if (text === undefined) text = await $.fs.read(filePath(run, path)).catch(() => undefined)
  opened = { path, text: text ?? '', isBinary: text !== undefined && text.includes('\u0000'), size: listed?.size ?? text?.length ?? 0 }
  if (text === undefined) fileNotice = "This file can't be read."
  $.ui.invalidate('ui.render')
}

/** Opens the file with the platform's opener, in the terminal only; elsewhere, or when no opener starts, its path is copied. */
async function openOutside($: EngineInterface, surface: string): Promise<void> {
  const current = await read($, data)
  const shown = await read($, view)
  const run = current.runs.find(r => r.id === shown.run)
  if (run === undefined || shown.file === '') return
  const path = filePath(run, shown.file)
  const windows = await isWindows($)
  const native = windows ? path.replace(/\//g, '\\') : path
  if (surface === 'terminal') {
    const root = ((await $.env.get('SystemRoot')) ?? 'C:\\Windows').replace(/\\+$/, '')
    const openers = windows ? [[`${root}\\explorer.exe`, native]] : [['open', path], ['xdg-open', path]]
    for (const argv of openers) {
      const ran = await $.process.run(argv).catch(() => undefined)
      // explorer.exe can exit 1 when it opened the file, so its exit code is not trusted.
      if (ran !== undefined && (windows || ran.exitCode === 0)) return
    }
  }
  await $.ui.copy({ text: native }).catch(() => undefined)
}

/** Adds `@<absolute path>` to the prompt box, wherever a surface has one. */
async function mention($: EngineInterface): Promise<void> {
  const current = await read($, data)
  const shown = await read($, view)
  const run = current.runs.find(r => r.id === shown.run)
  if (run === undefined || shown.file === '') return
  const filled = await $.prompt.fill({ text: `@${filePath(run, shown.file)} `, mode: 'append' }).catch(() => undefined)
  if (filled?.isFilled !== true) {
    fileNotice = "can't reach the prompt here"
    $.ui.invalidate('ui.render')
  }
}

function setNotices($: EngineInterface, runId: string, notices: Notice[]): Promise<unknown> {
  return update($, actions, (a): ArchonActions => ({ ...a, notices: { ...a.notices, [runId]: notices } }))
}

/**
 * Sends the confirmed action. Just before, the run is fetched again: one that
 * no longer needs you gets nothing. The call goes where the run lives, with 30 s
 * to reply; a refusal shows Archon's own words. Nothing here ever toasts.
 */
async function send($: EngineInterface, config: Config): Promise<void> {
  const before = await read($, actions)
  const pending = before.pending
  if (pending === null || before.sending !== '') return
  const runId = pending.runId
  const text = before.text[runId] ?? ''
  const word = pending.kind === 'answer' ? `Sending ${pending.decision}…` : pending.kind === 'resume' ? '… resuming' : '… abandoning'
  await update($, actions, (a): ArchonActions => ({ ...a, pending: null, sending: runId, notices: { ...a.notices, [runId]: [{ text: word, tone: 'dim' }] } }))
  try {
    const got = await refreshRun($, config, runId)
    const current = await read($, data)
    const race = movedElsewhere(pending, got?.run, current.runs, got?.detail)
    if (race !== undefined) {
      await setNotices($, runId, [{ text: race, tone: 'dim' }])
      return
    }
    const run = got?.run ?? current.runs.find(r => r.id === runId)
    if (run === undefined) return
    const reply = await deliver(io($), config.port, current.requirement.path, pending, run, text, current.source === 'server')
    if (reply.kind === 'silent') {
      await setNotices($, runId, [{ text: 'No reply from Archon in 30 s; it may still have gone through', tone: 'error' }])
      return
    }
    if (reply.kind === 'refused') {
      await setNotices($, runId, [{ text: reply.message, tone: 'error' }])
      return
    }
    const now = await $.clock.now()
    const isChatResume = pending.kind === 'resume' && reply.via === 'server'
    const record = pending.kind === 'answer'
      ? recordLine(pending.decision, pending.label, text, now)
      : pending.kind === 'abandon' ? `✗ abandoned by you ${clockTime(now)}` : isChatResume ? `▶ sent to its chat ${clockTime(now)}` : `▶ resumed by you ${clockTime(now)}`
    const isChecked = pending.kind !== 'abandon' && (reply.via === 'cli' || isChatResume)
    await update($, actions, (a): ArchonActions => ({
      ...a,
      text: pending.kind === 'answer' ? { ...a.text, [runId]: '' } : a.text,
      records: { ...a.records, [run.id]: [...(a.records[run.id] ?? []), record] },
      notices: { ...a.notices, [runId]: reply.message === '' || reply.via === 'cli' ? [] : [{ text: reply.message, tone: 'dim' }] },
      checks: isChecked ? { ...a.checks, [run.id]: { kind: pending.kind === 'answer' ? 'answer' : 'resume', at: now, polls: 0, log: reply.log, text, isChat: isChatResume } } : a.checks,
    }))
    // A --detach answer or resume is checked on once 30 s have passed; a chat resume over the next two polls.
    if (isChecked && !isChatResume) $.clock.after(REPLY_MS, () => void checkMoved($, config, run.id).catch(report($)))
  } finally {
    await update($, actions, (a): ArchonActions => ({ ...a, sending: a.sending === runId ? '' : a.sending }))
    await refreshRun($, config, runId)
  }
}

/** 30 s after a `--detach` answer or resume: a gate still unanswered, or a run still paused, says so, and the buttons come back with the text. */
async function checkMoved($: EngineInterface, config: Config, runId: string): Promise<void> {
  const check = (await read($, actions)).checks[runId]
  if (check === undefined) return
  const got = await refreshRun($, config, runId)
  const runs = (await read($, data)).runs
  const moved = hasMoved(got?.run, runs, got?.detail, check.kind)
  await update($, actions, (a): ArchonActions => {
    const { [runId]: _done, ...checks } = a.checks
    void _done
    if (moved) return { ...a, checks }
    const said = check.kind === 'answer' ? "Archon accepted the answer but hasn't recorded it" : "Archon accepted the resume but the run hasn't moved"
    return {
      ...a,
      checks,
      text: check.text === '' ? a.text : { ...a.text, [runId]: check.text },
      notices: { ...a.notices, [runId]: [{ text: `${said}${check.log === '' ? '.' : `; its log is ${check.log}`}`, tone: 'error' }] },
    }
  })
}

/**
 * After each poll: a pending confirmation for a run that no longer needs you
 * is dropped, its typed text left on screen, dim, to copy; a resume sent to a
 * chat that is still paused two polls later says to check the chat.
 */
async function settleActions($: EngineInterface): Promise<void> {
  const current = await read($, data)
  await update($, actions, (a): ArchonActions => {
    let next = a
    const pending = a.pending
    if (pending !== null) {
      const run = current.runs.find(r => r.id === pending.runId)
      const race = movedElsewhere(pending, run, current.runs, current.details[pending.runId])
      if (race !== undefined) {
        const typed = a.text[pending.runId] ?? ''
        next = { ...next, pending: null, notices: { ...next.notices, [pending.runId]: [{ text: race, tone: 'dim' }, ...(typed === '' ? [] : [{ text: typed, tone: 'dim' as const }])] } }
      }
    }
    for (const [runId, check] of Object.entries(a.checks)) {
      if (!check.isChat) continue
      const run = current.runs.find(r => r.id === runId)
      const polls = check.polls + 1
      const { [runId]: _done, ...rest } = next.checks
      void _done
      if (run === undefined || run.status !== 'paused') next = { ...next, checks: rest }
      else if (polls >= 2) next = { ...next, checks: rest, notices: { ...next.notices, [runId]: [{ text: 'still paused: check its chat', tone: 'dim' }] } }
      else next = { ...next, checks: { ...next.checks, [runId]: { ...check, polls } } }
    }
    return next
  })
}

/** The run that has needed you longest, a sub-run's gate counted like any other; undefined with none. */
function longestWaiting(current: ArchonData): Run | undefined {
  return sortRuns(topRuns(current.runs), current.runs, current.details).find(run => needsYou(run, current.runs, current.details) !== undefined)
}

/** Whether mod-settings is installed: the gear shows only then. A command list that cannot be read shows none. */
async function isSettingsInstalled($: EngineInterface): Promise<boolean> {
  return (await $.command.list().catch(() => [])).some(command => command.name === SETTINGS)
}

/**
 * Rechecks the CLI and the project, then loads: at start, on attach, on reload
 * and on r. A missing Requirement stops polling and takes down a status line
 * set while the CLI was there.
 */
async function reload($: EngineInterface, config: Config): Promise<void> {
  const project = await findProject($)
  await update($, data, current => ({ ...current, project }))
  if (await checkCli($, config)) await load($, config)
  else {
    stopPolling()
    $.ui.status(undefined)
  }
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
    // The follower died with the old module; the load below starts it again from line 1 if a live run's log is in front.
    stopFollower()
    for (const tab of Object.keys(furthest) as Tab[]) furthest[tab] = 0
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
    if (!(await isShown($)) && attaches === seen) {
      stopPolling()
      stopFollower()
    }
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
    void (async () => {
      await reload($, config)
      const longest = longestWaiting(await read($, data))
      if (longest !== undefined) await pick($, config, longest)
      else await changeView($, config, (v): ArchonView => ({ ...v, tab: 'runs' }))
    })().catch(report($))
    return { text: 'Archon pane opened.' }
  })

  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    // The engine's window stays at 0 so the pinned row never scrolls away; the shown sub-tab moves itself.
    await update($, view, (v): ArchonView => {
      const isLog = v.tab === 'log' || v.tab === 'archon-log'
      const from = isLog && atEnd[v.tab as 'log'] ? furthest[v.tab] : v.at[v.tab]
      const at = Math.min(Math.max(0, from + e.by), furthest[v.tab])
      if (isLog) atEnd[v.tab as 'log'] = at >= furthest[v.tab]
      return at === v.at[v.tab] ? v : { ...v, at: { ...v.at, [v.tab]: at } }
    })
    return next({ ...e, offset: 0 })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    void loadIfForward($, config).catch(report($))
    const current = await read($, data)
    const shown = await read($, view)
    const line = requirementLine(current.requirement)
    const width = Math.max(16, e.props.bodyColumns)
    const bodyRows = e.props.scroll.bodyRows
    const serverLine = `Archon's server isn't answering on port ${config.port}, so runs come from the CLI every ${interval('cli', true, hasLiveRun(current)) / 1000} s. archon serve makes them faster.`
    let lines: RenderElement[]
    let isResumeShown = false
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
        linkBase: current.source === 'server' && e.surface !== 'mobile' ? `http://localhost:${config.port}/console/r/` : '',
        onPick: run => void pick($, config, run).catch(report($)),
        onFanout: id => void update($, view, (v): ArchonView => ({ ...v, fanouts: v.fanouts.includes(id) ? v.fanouts.filter(f => f !== id) : [...v.fanouts, id] })).catch(report($)),
      })
    } else if (shown.tab === 'graph') {
      const run = current.runs.find(r => r.id === shown.run)
      if (run !== undefined && current.graphs[run.id] === undefined) void ensureGraph($, run.id).catch(report($))
      lines = graphBody({
        ui,
        run,
        runs: current.runs,
        details: current.details,
        nodes: run === undefined ? undefined : current.graphs[run.id],
        view: shown,
        now: await $.clock.now(),
        width,
        link: run !== undefined && current.source === 'server' && e.surface !== 'mobile' ? `http://localhost:${config.port}/console/r/${run.id}` : '',
        onPick: id => void pickNode($, config, shown.run, id).catch(report($)),
        onFold: block => void update($, view, (v): ArchonView => ({ ...v, includes: v.includes.filter(entry => entry !== `${shown.run}:${block}`) })).catch(report($)),
        onRound: round => void update($, view, (v): ArchonView => ({ ...v, round })).catch(report($)),
        onParent: parent => void openGraph($, parent.id).catch(report($)),
        onSubRun: subRun => void openGraph($, subRun.id).catch(report($)),
      })
    } else if (shown.tab === 'archon-log') {
      const served = await read($, serveLog)
      lines = served.isMissing
        ? [<Text dimColor wrap="wrap">{`No Archon's log at ${config.archonLog}. Point Archon's log in the mod settings at the file archon serve is redirected to.`}</Text>]
        : served.lines.map(text => {
          const drawn = serveLine(text)
          return <Text wrap="wrap" {...(drawn.tone === undefined ? {} : { color: drawn.tone })}>{drawn.text}</Text>
        })
    }
    else {
      const run = current.runs.find(r => r.id === shown.run)
      const acts = await read($, actions)
      const top = run === undefined ? undefined : topRuns(current.runs).find(t => needsYou(t, current.runs, current.details)?.holder.id === run.id)
      const need = top === undefined ? undefined : needsYou(top, current.runs, current.details)
      const link = run !== undefined && current.source === 'server' && e.surface !== 'mobile' ? `http://localhost:${config.port}/console/r/${run.id}` : ''
      if (run !== undefined && need !== undefined && current.graphs[run.id] === undefined) void ensureGraph($, run.id).catch(report($))
      const logLines = logBody({
        ui,
        run,
        runs: current.runs,
        detail: run === undefined ? undefined : current.details[run.id],
        window: await read($, logWindow),
        view: shown,
        width,
        link: run !== undefined && current.source === 'server' && e.surface !== 'mobile' ? `http://localhost:${config.port}/console/r/${run.id}` : '',
        filesFolder: run === undefined ? '' : filePath(run, '').replace(/\/$/, ''),
        file: opened,
        notice: fileNotice,
        onFold: key => void update($, view, (v): ArchonView => ({ ...v, fold: v.fold === key ? '' : key })).catch(report($)),
        onAll: () => void showAll($, config).catch(report($)),
        onFiles: () => void update($, view, (v): ArchonView => ({ ...v, isFilesOpen: !v.isFilesOpen })).catch(report($)),
        onFile: path => void openFile($, config, path).catch(report($)),
        onBack: () => void update($, view, (v): ArchonView => ({ ...v, file: '' })).catch(report($)),
        onOpen: () => void openOutside($, e.surface).catch(report($)),
        onMention: () => void mention($).catch(report($)),
      })
      const holderId = run?.id ?? ''
      const notes: RenderElement[] = [
        ...(acts.records[holderId] ?? []).map(record => <Text {...(record.startsWith('✗') ? { color: 'error' as const } : {})}>{record}</Text>),
        ...(acts.notices[holderId] ?? []).map(notice => (notice.tone === 'error'
          ? <Text color="error" wrap="wrap">{notice.text}</Text>
          : notice.tone === 'dim' ? <Text dimColor wrap="wrap">{notice.text}</Text> : <Text wrap="wrap">{notice.text}</Text>)),
      ]
      if (run !== undefined && need !== undefined && shown.file === '') {
        const set = (change: (a: ArchonActions) => ArchonActions) => void update($, actions, change).catch(report($))
        const ask = (kind: Pending['kind'], decision = '', label = '') => set((a): ArchonActions => ({ ...a, pending: { runId: run.id, kind, decision, label } }))
        isResumeShown = offersResume({ run: top!, need, detail: current.details[run.id], actions: acts })
        const files = (current.details[run.id]?.files ?? []).map(file => (
          <ui.Button key={`file-${file.path}`} plain label={`${file.path}  ${Math.round(file.size / 1024) === 0 ? `${file.size} B` : `${Math.round(file.size / 1024)} KB`}`} onPress={() => void openFile($, config, file.path).catch(report($))} />
        ))
        lines = [
          ...actionBody({
            ui,
            surface: e.surface,
            run: top!,
            need,
            parent: current.runs.find(r => r.id === run.parentId),
            detail: current.details[run.id],
            graph: current.graphs[run.id],
            actions: acts,
            now: await $.clock.now(),
            width,
            isServer: current.source === 'server',
            link,
            isCut: shown.node !== '',
            log: logLines.slice(1),
            files,
            onDecide: (decision, label) => ask('answer', decision, label),
            onResume: () => ask('resume'),
            onAbandon: () => ask('abandon'),
            onConfirm: () => void send($, config).catch(report($)),
            onBack: () => set((a): ArchonActions => ({ ...a, pending: null })),
            onText: text => set((a): ArchonActions => ({ ...a, text: { ...a.text, [run.id]: text } })),
            onAll: () => void showAll($, config).catch(report($)),
          }),
          ...notes,
        ]
      } else lines = [...logLines, ...notes]
    }
    // The logs follow their tail while at their end.
    const last = lastPosition(lines.length, bodyRows)
    const isLog = shown.tab === 'log' || shown.tab === 'archon-log'
    const at = isLog && atEnd[shown.tab as 'log'] ? last : shown.at[shown.tab]
    furthest[shown.tab] = last
    return (
      <Box flexDirection="column" width={width}>
        {pinnedRow({
          ui,
          width,
          shown: shown.tab,
          live: liveCount(current.runs),
          needsYou: needsYouCount(current.runs, current.details),
          hasSettings: await isSettingsInstalled($),
          isReloadKey: !isResumeShown,
          onTab: tab => void changeView($, config, (v): ArchonView => ({ ...v, tab })).catch(report($)),
          onReload: () => void reload($, config).catch(report($)),
          onSettings: () => void $.command.run({ command: SETTINGS }).catch(report($)),
        })}
        {bodyWindow(ui, lines, at, bodyRows)}
      </Box>
    )
  })
}
