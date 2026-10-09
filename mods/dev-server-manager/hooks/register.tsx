import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register, Timer } from 'claude-code'

import type { OutputLine, PaneView, PeerEntry, RowDef, Rows, ServerRun } from '../types'
import { ADD_USAGE, parseAdd } from './add'
import type { AddedServer } from './add'
import { detectRows, LOCKFILES, parseScripts } from './detect'
import { endWords, errorLines, errorPrompt, findLocalUrl, hhmm, keep, splitPiece, stripAnsi } from './output'
import { COMPOSE_ID, composeText, otherSessions, peerKey, peerPrefix, REFRESH_MS } from './peers'
import { checkPort } from './port'
import type { PortCheck } from './port'
import { commandText, isQuiet, isUp, newRun, RESTART_CAP, RESTART_WINDOW_MS, rowWords, statusLine } from './servers'
import { lineCount, OUTPUT_SPEC, OUTPUT_TOOL, outputText, RESTART_SPEC, RESTART_TOOL, RESTART_WAIT_MS } from './tools'
import type { ToolServer } from './tools'
import { moveOf, paneGeometry, renderPane, scrollAnchor } from './view'
import type { PaneActions } from './view'

const PLUGIN = 'dev-server-manager'
const PANE = 'dev-servers'
const TITLE = 'Dev servers'
const COMMAND = 'dev-servers'
/** Output reaches `$.state` at most about once a second. */
const FLUSH_MS = 1000
/** How long a death's toast stays, and Claude's restart's. */
const DEATH_TOAST_MS = 8000
const CLAUDE_TOAST_MS = 4000
/** After its own stop the mod waits this long at most for the listener to let go, polling every POLL_MS. */
const RELEASE_MS = 3000
const POLL_MS = 100

const rowsAtom = atom({ plugin: 'dev-server-manager', key: 'rows' } as const, { defs: [], hidden: [] } as Rows)
const runsAtom = atom({ plugin: 'dev-server-manager', key: 'runs' } as const, {} as Record<string, ServerRun>)
const outputAtom = atom({ plugin: 'dev-server-manager', key: 'output' } as const, {} as Record<string, OutputLine[]>)
const viewAtom = atom(
  { plugin: 'dev-server-manager', key: 'view' } as const,
  { picked: null, anchor: null, isShowingHidden: false, isFillRefused: false } as PaneView,
)
const peersAtom = atom({ plugin: 'dev-server-manager', key: 'peers' } as const, [] as PeerEntry[])

/** A child this module runs: its stream, and whether the mod itself is ending it. */
type Live = {
  stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  isStopping: boolean
}

// What dies with the module on a reload: the children (the engine kills them with it) and the output not yet written.
const live = new Map<string, Live>()
let memory: Record<string, OutputLine[]> = {}
let seq = 0
let flushedAt = 0
let isFlushPending = false
// The servers whose start is under way (the port check), so a second press starts nothing more; a stop calls the start off.
const opening = new Map<string, { isCancelled: boolean }>()
// The servers the mod itself stopped, whose port may linger before the next start.
const stoppedByMod = new Set<string>()
// Death toasts raised in this tick, shown as one.
let pendingToasts: string[] = []
// The status line last shown, so an unchanged one is not set again.
let shownStatus: string | undefined
// Claude's restarts waiting for a run's URL or end, by server.
const waiters = new Map<string, (() => void)[]>()
// Refreshes this session's store entries and reads the other sessions'; dies with the module.
let ticker: Timer | undefined
// The pane's width at its last drawing, which a scroll event does not carry.
let paneColumns = 60
// The store entries this module wrote: still its own after /clear gives the session another id.
const ownEntries = new Set<string>()
// What a /clear may take from $.state while the servers run on: written back if it does.
let carried: { rows: Rows; runs: Record<string, ServerRun>; view: PaneView } | undefined

type Config = { isRestartOn: boolean; scripts: string[] }

// The settings as this module's register read them.
let settings: Config = { isRestartOn: true, scripts: [] }

function parseConfig(options: Record<string, unknown>): Config {
  return { isRestartOn: options.restart !== false, scripts: parseScripts(options.scripts) }
}

/** Whether any surface shows the session; asked before each thing the mod starts on its own. */
async function isShown($: EngineInterface): Promise<boolean> {
  return (await $.session.surfaces()).length > 0
}

async function isWindows($: EngineInterface): Promise<boolean> {
  return (await $.env.get('OS')) === 'Windows_NT'
}

function join(root: string, path: string): string {
  return path === '' ? root : `${root.replace(/[\\/]$/, '')}/${path}`
}

/** Store keys, per project folder. */
const addedKey = (root: string) => `added:${root}`
const hiddenKey = (root: string) => `hidden:${root}`
const portsKey = (root: string) => `ports:${root}`

async function storedAdded($: EngineInterface, root: string): Promise<AddedServer[]> {
  const value = await $.store.get(addedKey(root)).catch(() => undefined)
  return Array.isArray(value) ? (value as AddedServer[]) : []
}

async function storedHidden($: EngineInterface, root: string): Promise<string[]> {
  const value = await $.store.get(hiddenKey(root)).catch(() => undefined)
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : []
}

async function storedPorts($: EngineInterface, root: string): Promise<Record<string, number>> {
  const value = await $.store.get(portsKey(root)).catch(() => undefined)
  return typeof value === 'object' && value !== null ? (value as Record<string, number>) : {}
}

/** Reads the project's rows afresh: the root package.json's scripts, the added servers, the hidden rows, the learned ports. */
async function loadRows($: EngineInterface, config: Config): Promise<Rows> {
  const root = await $.session.root()
  const packageJson = await $.fs.read(join(root, 'package.json')).catch(() => undefined)
  const present: string[] = []
  for (const [file] of LOCKFILES) {
    if (await $.fs.exists(join(root, file)).catch(() => false)) present.push(file)
  }
  const detected = detectRows(typeof packageJson === 'string' ? packageJson : undefined, present, config.scripts)
  const ports = await storedPorts($, root)
  const blocked = detected.conflict.length > 0 ? `lockfiles disagree: ${detected.conflict.join(', ')}` : ''
  const defs: RowDef[] = detected.rows.map(row => ({ name: row.name, source: 'detected', argv: row.argv, cwd: '', port: ports[row.name] ?? 0, blocked }))
  for (const added of await storedAdded($, root)) {
    if (defs.some(def => def.name === added.name)) continue
    defs.push({ name: added.name, source: 'added', argv: added.argv, cwd: added.cwd ?? '', port: added.port ?? ports[added.name] ?? 0, blocked: '' })
  }
  const rows: Rows = { defs, hidden: await storedHidden($, root) }
  await update($, rowsAtom, () => rows)
  return rows
}

/** Adds lines to a server's kept output and writes it to `$.state` at most about once a second. */
async function addOutput($: EngineInterface, name: string, lines: Omit<OutputLine, 'seq'>[]): Promise<void> {
  if (lines.length === 0) return
  memory = { ...memory, [name]: keep(memory[name] ?? [], lines.map(line => ({ ...line, seq: ++seq }))) }
  if (isFlushPending) return
  const now = await $.clock.now()
  const wait = flushedAt + FLUSH_MS - now
  if (wait <= 0) return flushOutput($)
  isFlushPending = true
  $.clock.after(wait, () => {
    isFlushPending = false
    void flushOutput($).catch(report($))
  })
}

async function flushOutput($: EngineInterface): Promise<void> {
  await restoreCarried($)
  flushedAt = await $.clock.now()
  const snapshot = memory
  await update($, outputAtom, () => snapshot)
}

async function setRun($: EngineInterface, name: string, change: (run: ServerRun) => ServerRun): Promise<void> {
  // The first write after /clear brings back what the old session held, so it is not written over.
  await restoreCarried($)
  await update($, runsAtom, runs => ({ ...runs, [name]: change(runs[name] ?? newRun()) }))
  await showStatus($)
}

/** The status line from the servers as they stand, in row order; none in a headless session. */
async function showStatus($: EngineInterface): Promise<void> {
  if (!(await isShown($))) return
  const runs = await read($, runsAtom)
  const { defs } = await read($, rowsAtom)
  const entries = defs.flatMap(def => {
    const run = runs[def.name]
    if (run === undefined || !(isUp(run.status) || run.status === 'crashed')) return []
    const port = Number(/:(\d+)$/.exec(run.url)?.[1] ?? def.port)
    return [{ name: def.name, port, isCrashed: run.status === 'crashed' }]
  })
  const line = statusLine(entries)
  if (line === shownStatus) return
  shownStatus = line
  $.ui.status(line)
}

async function defOf($: EngineInterface, name: string): Promise<RowDef | undefined> {
  return (await read($, rowsAtom)).defs.find(def => def.name === name)
}

/** Remembers the port a server printed, per project and server, unless one was declared. */
async function learnPort($: EngineInterface, name: string, port: number): Promise<void> {
  const def = await defOf($, name)
  if (def === undefined || def.port > 0) return
  const root = await $.session.root()
  await $.store.set(portsKey(root), { ...(await storedPorts($, root)), [name]: port })
  await update($, rowsAtom, rows => ({ ...rows, defs: rows.defs.map(d => (d.name === name ? { ...d, port } : d)) }))
}

/** Reads a child's pieces as lines until it ends; the first local URL makes it running. */
async function follow($: EngineInterface, name: string, entry: Live): Promise<void> {
  const pending = { stdout: '', stderr: '' }
  let hasStarted = false
  let isUrlSeen = false
  let result: ProcessSpawnResult | undefined
  try {
    for (;;) {
      const step = await entry.stream.next()
      if (step.done === true) {
        result = step.value
        break
      }
      hasStarted = true
      const { stream, text } = step.value
      const split = splitPiece(pending[stream], text)
      pending[stream] = split.rest
      const at = await $.clock.now()
      const lines = split.lines.map(line => stripAnsi(line))
      await addOutput($, name, lines.map(line => ({ stream, text: line, at })))
      if (!isUrlSeen) {
        const found = lines.map(findLocalUrl).find(url => url !== undefined)
        if (found !== undefined) {
          isUrlSeen = true
          const known = (await defOf($, name))?.port ?? 0
          const movedFrom = known > 0 && known !== found.port ? known : 0
          await setRun($, name, run => ({ ...run, status: 'running', url: found.url, movedFrom }))
          await learnPort($, name, found.port)
          await recordRunning($, name)
          wake(name)
        }
      }
    }
  } catch (error) {
    // A stream that fails after output is a death like any other, so it goes on to the end below with no exit code.
    if (!hasStarted && !entry.isStopping) {
      if (live.get(name) === entry) live.delete(name)
      wake(name)
      await forgetRunning($, name)
      // A command that cannot start rejects the first pull: its message is the row's words.
      const message = (error instanceof Error ? error.message : String(error)).replace(/^dev-server-manager: \$\.process\.spawn: /, '')
      await setRun($, name, run => ({ ...run, status: 'stopped', problem: message }))
      return
    }
  }
  if (live.get(name) === entry) live.delete(name)
  if (entry.isStopping) return
  wake(name)
  await forgetRunning($, name)
  const at = await $.clock.now()
  const rest = (['stdout', 'stderr'] as const).filter(stream => pending[stream] !== '')
  await addOutput($, name, rest.map(stream => ({ stream, text: stripAnsi(pending[stream]), at })))
  const code = result?.code ?? null
  const signal = result?.signal ?? null
  if (code === 0 && signal === null) {
    await setRun($, name, run => ({ ...run, ...(isQuiet(run, at) ? { crashes: [], restarts: [], isGaveUp: false } : {}), status: 'exited', endedAt: at, lastExit: 0, hasNote: false }))
  } else await die($, name, code, signal, at)
}

/** Records a server this session runs in the shared store, for the project's other sessions. */
async function recordRunning($: EngineInterface, name: string): Promise<void> {
  const def = await defOf($, name)
  const run = (await read($, runsAtom))[name]
  if (def === undefined || run === undefined || !isUp(run.status)) return
  const port = Number(/:(\d+)$/.exec(run.url)?.[1] ?? def.port)
  const entry: PeerEntry = { sessionId: await $.session.id(), name, command: commandText(def), port, url: run.url, refreshedAt: await $.clock.now() }
  const key = peerKey(await $.session.root(), name)
  ownEntries.add(key)
  await $.store.set(key, entry)
}

/** Clears this session's entry for a server that no longer runs. */
async function forgetRunning($: EngineInterface, name: string): Promise<void> {
  const key = peerKey(await $.session.root(), name)
  const entry = (await $.store.get(key).catch(() => undefined)) as PeerEntry | undefined
  if (ownEntries.delete(key) || entry?.sessionId === (await $.session.id())) await $.store.delete(key)
}

/** The servers the project's other sessions run, from their fresh store entries. */
async function readPeers($: EngineInterface): Promise<PeerEntry[]> {
  const prefix = peerPrefix(await $.session.root())
  const keys = (await $.store.keys().catch(() => [])).filter(key => key.startsWith(prefix) && !ownEntries.has(key))
  const values = await Promise.all(keys.map(key => $.store.get(key).catch(() => undefined)))
  return otherSessions(values, await $.session.id(), await $.clock.now())
}

/** Every 30 s: this session's entries refreshed, the other sessions' read again (which redraws the pane's times too). */
async function refresh($: EngineInterface): Promise<void> {
  for (const name of live.keys()) await recordRunning($, name)
  const peers = await readPeers($)
  await update($, peersAtom, () => peers)
}

function startTicker($: EngineInterface): void {
  ticker?.cancel()
  ticker = $.clock.every(REFRESH_MS, () => void refresh($).catch(report($)))
}

/** The system prompt's section on what runs, here and in the project's other sessions; none while nothing runs. */
async function composeSection($: EngineInterface): Promise<string | undefined> {
  const { defs } = await read($, rowsAtom)
  const runs = await read($, runsAtom)
  const own = defs.flatMap(def => {
    const run = runs[def.name]
    return run !== undefined && isUp(run.status) ? [{ name: def.name, command: commandText(def), url: run.url, state: run.status }] : []
  })
  const others = (await readPeers($))
    .filter(peer => !own.some(server => server.name === peer.name))
    .map(peer => ({ name: peer.name, command: peer.command, url: peer.url, state: 'running in another session' }))
  return composeText([...own, ...others])
}

/**
 * After /clear the module and its servers run on under a new session. Should
 * the engine have emptied the mod's `$.state` with the old session, the rows,
 * runs, output and pane place it held are written back.
 */
async function restoreCarried($: EngineInterface): Promise<void> {
  const held = carried
  if (held === undefined) return
  carried = undefined
  await update($, rowsAtom, rows => (rows.defs.length === 0 ? held.rows : rows))
  await update($, runsAtom, runs => ({ ...held.runs, ...runs }))
  await update($, viewAtom, view => (view.picked === null && view.anchor === null ? held.view : view))
  await flushOutput($)
}

/** Marks the lines a death picked as its error in the kept output. */
function markError(name: string, count: number): void {
  const list = memory[name] ?? []
  let left = count
  const marked = [...list]
  for (let at = marked.length - 1; at >= 0 && left > 0; at -= 1) {
    const line = marked[at]!
    if (line.stream === 'divider') break
    if (line.stream === 'note') continue
    marked[at] = { ...line, isError: true }
    left -= 1
  }
  memory = { ...memory, [name]: marked }
}

/**
 * A death: a non-zero exit, or a signal the mod did not send. It toasts, and
 * restarts while the setting is on and the cap of 3 in 2 minutes allows; in a
 * headless session it does neither, and the row stays crashed.
 */
async function die($: EngineInterface, name: string, code: number | null, signal: string | null, at: number): Promise<void> {
  const def = await defOf($, name)
  const lines = errorLines(memory[name] ?? [])
  markError(name, lines.length)
  await flushOutput($)
  const death = { at, code, signal, command: def === undefined ? name : commandText(def), lines }
  const isShowing = await isShown($)
  let restartNumber = 0
  await setRun($, name, run => {
    // After 10 quiet minutes the earlier deaths are behind it, and this one counts from 1.
    const earlier = isQuiet(run, at) ? { crashes: [], restarts: [] } : run
    const restarts = earlier.restarts.filter(time => at - time < RESTART_WINDOW_MS)
    const canRestart = isShowing && settings.isRestartOn && restarts.length < RESTART_CAP
    restartNumber = canRestart ? restarts.length + 1 : 0
    return {
      ...run,
      status: 'crashed',
      endedAt: at,
      lastExit: code,
      death,
      crashes: [...earlier.crashes, at],
      restarts,
      isGaveUp: isShowing && settings.isRestartOn && !canRestart,
      hasNote: false,
    }
  })
  if (!isShowing) return
  const ended = endWords(death)
  // The restart is charged and told only once it has spawned: a port taken, say, leaves the row as that and the cap whole.
  const isRestarted = restartNumber > 0 && (await start($, name, { divider: `crashed (${ended}) · restarted` }))
  if (isRestarted) await setRun($, name, run => ({ ...run, restarts: [...run.restarts, at], hasNote: true }))
  toastDeath($, isRestarted ? `✗ ${name} crashed (${ended}), restarting (${restartNumber}/${RESTART_CAP})` : `✗ ${name} crashed (${ended})`)
}

/** Raises a death's toast; several deaths in one tick are one toast. */
function toastDeath($: EngineInterface, text: string): void {
  pendingToasts.push(text)
  if (pendingToasts.length > 1) return
  $.clock.after(0, () => {
    const texts = pendingToasts
    pendingToasts = []
    $.ui.toast(texts.join(' · '), { timeoutMs: DEATH_TOAST_MS })
  })
}

/**
 * The port check before a start. After the mod's own stop the listener lingers
 * up to most of a second, so it polls until the port is free, about 3 s at most,
 * and only then names a holder that is still there.
 */
async function portCheck($: EngineInterface, name: string, port: number): Promise<PortCheck> {
  const run = (argv: readonly string[]) => $.process.run(argv)
  const windows = await isWindows($)
  if (stoppedByMod.delete(name)) {
    const deadline = (await $.clock.now()) + RELEASE_MS
    for (;;) {
      const polled = await checkPort(run, windows, port, false)
      if (polled.status !== 'taken') return polled
      if ((await $.clock.now()) + POLL_MS > deadline) break
      await $.clock.sleep(POLL_MS)
    }
  }
  return checkPort(run, windows, port)
}

/** How a start came about: the divider's words, and whether the person (or Claude) handled the server by hand. */
type StartReason = { divider: string; isByHand?: boolean; isAfterReload?: boolean }

/** Starts a server: the port check first, then the child, with no shell. One start at a time per server. True when the child spawned. */
async function start($: EngineInterface, name: string, reason: StartReason): Promise<boolean> {
  if (live.has(name) || opening.has(name)) return false
  const pending = { isCancelled: false }
  opening.set(name, pending)
  try {
    return await open($, name, reason, pending)
  } finally {
    if (opening.get(name) === pending) opening.delete(name)
  }
}

async function open($: EngineInterface, name: string, reason: StartReason, pending: { isCancelled: boolean }): Promise<boolean> {
  if (!(await isShown($))) return false
  const def = await defOf($, name)
  if (def === undefined || def.blocked !== '') return false
  let problem = ''
  if (def.port > 0) {
    const check = await portCheck($, name, def.port)
    if (pending.isCancelled) return false
    if (check.status === 'taken') {
      await setRun($, name, run => ({ ...run, status: 'port taken', holder: check.words, problem: '' }))
      return false
    }
    if (check.status === 'unchecked') problem = 'port not checked'
  }
  const root = await $.session.root()
  const now = await $.clock.now()
  if (pending.isCancelled) return false
  await addOutput($, name, [{ stream: 'divider', text: `── ${reason.divider} ${hhmm(now)} ──`, at: now }])
  const handled = reason.isByHand === true ? { crashes: [], restarts: [], isGaveUp: false, hasNote: false } : {}
  await setRun($, name, run => ({
    ...run,
    ...handled,
    status: 'starting',
    url: '',
    startedAt: now,
    endedAt: 0,
    movedFrom: 0,
    isAfterReload: reason.isAfterReload === true,
    problem,
    holder: '',
  }))
  if (pending.isCancelled) return false
  const entry: Live = {
    stream: $.process.spawn({ argv: def.argv, cwd: join(root, def.cwd), env: { PYTHONUNBUFFERED: '1' } }),
    isStopping: false,
  }
  live.set(name, entry)
  void follow($, name, entry).catch(report($))
  await recordRunning($, name)
  await offerTools($, name)
  return true
}

/**
 * Registers the two tools at every bring-up: the first time a server runs in
 * the session, and again after a reload, a name registered again being
 * replaced. Before the session binds the call rejects: a dim line in the output says so.
 */
async function offerTools($: EngineInterface, name: string): Promise<void> {
  try {
    await $.tool.register(OUTPUT_SPEC)
    await $.tool.register(RESTART_SPEC)
  } catch (error) {
    const at = await $.clock.now()
    const message = error instanceof Error ? error.message : String(error)
    await addOutput($, name, [{ stream: 'note', text: `could not offer Claude the dev-servers tools: ${message}`, at }])
  }
}

/** Resolves when `name`'s current run prints its URL or ends. */
function untilUp(name: string): Promise<void> {
  return new Promise(resolve => waiters.set(name, [...(waiters.get(name) ?? []), resolve]))
}

function wake(name: string): void {
  const waiting = waiters.get(name) ?? []
  waiters.delete(name)
  for (const resolve of waiting) resolve()
}

/**
 * Stops a server the mod runs: closing its stream kills the whole tree, and
 * reads no exit code. A start still under way is called off, and nothing spawns.
 */
async function stop($: EngineInterface, name: string): Promise<void> {
  const pending = opening.get(name)
  if (pending !== undefined) {
    pending.isCancelled = true
    opening.delete(name)
  }
  const entry = live.get(name)
  if (entry === undefined && pending === undefined) return
  if (entry !== undefined) {
    entry.isStopping = true
    live.delete(name)
    stoppedByMod.add(name)
    await entry.stream.return(undefined as never).catch(() => undefined)
    await forgetRunning($, name)
  }
  const now = await $.clock.now()
  await setRun($, name, run => ({ ...run, status: 'stopped', endedAt: now, hasNote: false, crashes: [], restarts: [], isGaveUp: false }))
}

/** Logs a failure of work the mod started on its own. */
function report($: EngineInterface): (error: unknown) => void {
  return error => $.ui.log(`${PLUGIN}: ${error instanceof Error ? error.message : String(error)}`)
}

/** What the pane's buttons do. */
function paneActions($: EngineInterface, config: Config): PaneActions {
  return {
    pick: name => void update($, viewAtom, view => ({ ...view, picked: view.picked === name ? null : name, anchor: null, isFillRefused: false })),
    start: name => void start($, name, { divider: 'started', isByHand: true }).catch(report($)),
    stop: name => void stop($, name).catch(report($)),
    restart: name => void restartByHand($, name).catch(report($)),
    fillError: name => void fillError($, name).catch(report($)),
    hide: name =>
      void (async () => {
        await setHidden($, config, name, true)
        await update($, viewAtom, view => (view.picked === name ? { ...view, picked: null } : view))
      })().catch(report($)),
    unhide: name => void setHidden($, config, name, false).catch(report($)),
    toggleHidden: () => void update($, viewAtom, view => ({ ...view, isShowingHidden: !view.isShowingHidden })),
    latest: () => void update($, viewAtom, view => ({ ...view, anchor: null })),
    settings: () => void $.command.run({ command: 'mod-settings' }).catch(report($)),
  }
}

/**
 * A fresh module after a reload that changed it: the old module's servers died
 * with it, so each one `$.state` still lists as up starts again. In a headless
 * session nothing new starts, and they read stopped.
 */
async function bringBack($: EngineInterface): Promise<void> {
  if (Object.keys(memory).length === 0) {
    memory = await read($, outputAtom)
    seq = Math.max(seq, ...Object.values(memory).flat().map(line => line.seq))
  }
  const runs = await read($, runsAtom)
  const isShowing = await isShown($)
  for (const [name, run] of Object.entries(runs)) {
    if (!isUp(run.status) || live.has(name)) continue
    if (isShowing) await start($, name, { divider: 'restarted after reload', isAfterReload: true })
    else await setRun($, name, current => ({ ...current, status: 'stopped' }))
  }
}

/**
 * error → prompt: appends the latest death's error to whatever is typed, after
 * a blank line, and sends nothing. The prompt box needs the keyboard, and
 * closing the pane is the one way a mod hands it back, so the pane is closed
 * and opened again without the keys. On a running server the note and button go.
 */
async function fillError($: EngineInterface, name: string): Promise<void> {
  const death = (await read($, runsAtom))[name]?.death
  if (death === null || death === undefined) return
  await $.ui.close({ id: PANE })
  let isFilled = false
  try {
    isFilled = (await $.prompt.fill({ text: `\n\n${errorPrompt(name, death)}`, mode: 'append' })).isFilled
  } finally {
    await $.ui.open({ id: PANE, title: TITLE })
  }
  // Only the engine's own refusal names its cause (no_composer, dialog), so any refusal says the prompt is out of reach.
  await update($, viewAtom, view => ({ ...view, isFillRefused: !isFilled }))
  if (isFilled) await setRun($, name, run => (run.status === 'running' ? { ...run, hasNote: false } : run))
}

/** Hides a detected row, or shows it again; kept per project. */
async function setHidden($: EngineInterface, config: Config, name: string, isHidden: boolean): Promise<void> {
  const root = await $.session.root()
  const hidden = (await storedHidden($, root)).filter(other => other !== name)
  await $.store.set(hiddenKey(root), isHidden ? [...hidden, name] : hidden)
  await loadRows($, config)
}

/** `/dev-servers add|remove|unhide`: the reply the transcript shows. */
async function runSubcommand($: EngineInterface, config: Config, args: string): Promise<string> {
  const [verb = '', ...words] = args.trim().split(/\s+/)
  const rest = args.trim().slice(verb.length).trim()
  const root = await $.session.root()
  const rows = await loadRows($, config)
  if (verb === 'add') {
    const added = await storedAdded($, root)
    const parsed = parseAdd(rest, { detected: rows.defs.filter(def => def.source === 'detected').map(def => def.name), added: added.map(server => server.name) })
    if ('error' in parsed) return parsed.error
    await $.store.set(addedKey(root), [...added, parsed.server])
    await loadRows($, config)
    return `Added ${parsed.server.name}: ${commandText({ ...parsed.server, source: 'added', cwd: '', port: 0, blocked: '' })}`
  }
  if (verb === 'remove') {
    const added = await storedAdded($, root)
    const name = words[0] ?? ''
    if (!added.some(server => server.name === name)) {
      return `No added server is named ${name}. Added servers: ${added.length === 0 ? 'none' : added.map(server => server.name).join(', ')}.`
    }
    await stop($, name)
    await $.store.set(addedKey(root), added.filter(server => server.name !== name))
    await update($, viewAtom, view => (view.picked === name ? { ...view, picked: null } : view))
    await loadRows($, config)
    return `Removed ${name}.`
  }
  if (verb === 'unhide') {
    const name = words[0] ?? ''
    if (!rows.hidden.includes(name)) return `${name} is not hidden.`
    await setHidden($, config, name, false)
    return `${name} is shown again.`
  }
  return `Use /dev-servers to open the pane, ${ADD_USAGE}, /dev-servers remove <name> or /dev-servers unhide <name>.`
}

/** A server as the tools describe it, its output the freshest the module holds. */
async function toolServer($: EngineInterface, def: RowDef): Promise<ToolServer> {
  const run = (await read($, runsAtom))[def.name] ?? newRun()
  return { name: def.name, command: commandText(def), status: run.status, url: run.url, lastExit: run.lastExit, lines: memory[def.name] ?? [] }
}

/** The tool's answer, or its refusal as the error the model reads. */
type ToolAnswer = { result: string } | { deny: string }

function unknownServer(name: string, defs: readonly RowDef[]): ToolAnswer {
  return { deny: `No dev server is named ${name}. The servers are: ${defs.length === 0 ? 'none' : defs.map(def => def.name).join(', ')}.` }
}

/**
 * `output`: the named server's header and current run, or with none named the
 * one running server, or the running names when several run. Works headless.
 */
async function answerOutput($: EngineInterface, server: unknown, lines: unknown): Promise<ToolAnswer> {
  const { defs } = await read($, rowsAtom)
  const runs = await read($, runsAtom)
  let def: RowDef | undefined
  if (typeof server === 'string' && server !== '') {
    def = defs.find(candidate => candidate.name === server)
    if (def === undefined) return unknownServer(server, defs)
  } else {
    const up = defs.filter(candidate => isUp(runs[candidate.name]?.status ?? 'stopped'))
    if (up.length > 1) return { result: `Several dev servers run: ${up.map(candidate => candidate.name).join(', ')}. Call again with server set to one of them.` }
    def = up[0] ?? (Object.keys(runs).length === 1 ? defs.find(candidate => candidate.name in runs) : undefined)
    if (def === undefined) return { result: `No dev server runs. The servers are: ${defs.map(candidate => candidate.name).join(', ') || 'none'}.` }
  }
  return { result: outputText(await toolServer($, def), lineCount(lines)) }
}

/**
 * `restart` from Claude: only a running or crashed server of this session, never
 * headless. It counts as handling the server by hand, toasts, and waits for the
 * new run's URL or end, 30 s at most, then answers what `output` would.
 */
async function restartByClaude($: EngineInterface, server: unknown): Promise<ToolAnswer> {
  if (!(await isShown($))) return { deny: 'Restart is not available in a headless session.' }
  const { defs } = await read($, rowsAtom)
  const name = typeof server === 'string' ? server : ''
  const def = defs.find(candidate => candidate.name === name)
  if (def === undefined) return unknownServer(name, defs)
  if ((await read($, peersAtom)).some(peer => peer.name === name) && !live.has(name)) {
    return { deny: `${name} runs in another session; restart it from that session's dev-servers pane.` }
  }
  const status = (await read($, runsAtom))[name]?.status ?? 'stopped'
  if (!isUp(status) && status !== 'crashed') {
    return { deny: `${name} ${status === 'exited' ? 'exited' : `is ${status}`}: start it from the dev-servers pane.` }
  }
  await stop($, name)
  if (!(await start($, name, { divider: 'restarted by Claude', isByHand: true }))) {
    // It did not spawn (the port is taken, say): the row's state and words say why.
    const run = (await read($, runsAtom))[name]
    const words = rowWords({ def, run, peer: undefined }, await $.clock.now()).text
    return { deny: `${name} did not restart (${run?.status ?? 'stopped'}): ${words}` }
  }
  $.ui.toast(`${name} restarted by Claude`, { timeoutMs: CLAUDE_TOAST_MS })
  if (live.has(name)) await Promise.race([untilUp(name), $.clock.sleep(RESTART_WAIT_MS)])
  return { result: outputText(await toolServer($, def), lineCount(undefined)) }
}

/** The person's restart: stop, then start again. */
async function restartByHand($: EngineInterface, name: string): Promise<void> {
  await stop($, name)
  await start($, name, { divider: 'restarted', isByHand: true })
}

export const register: Register = (on, options) => {
  const config = parseConfig(options)
  settings = config

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: COMMAND, description: 'Open the dev servers pane: start, stop and watch the project dev servers' })
    await loadRows($, config)
    await update($, peersAtom, () => [])
    await bringBack($)
    const peers = await readPeers($)
    await update($, peersAtom, () => peers)
    if (await isShown($)) startTicker($)
    return started
  })

  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    await restoreCarried($)
    if (await isShown($)) startTicker($)
    return attached
  })

  on('prompt.compose', async ($, e, next) => {
    await restoreCarried($)
    const composed = await next(e)
    // A headless session hears nothing of the servers.
    if (e.surfaces.length === 0) return composed
    const text = await composeSection($)
    return text === undefined ? composed : { ...composed, sections: [...composed.sections, { id: COMPOSE_ID, text, scope: 'session' as const }] }
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' && live.size > 0) {
      carried = { rows: await read($, rowsAtom), runs: await read($, runsAtom), view: await read($, viewAtom) }
    }
    const ended = await next(e)
    // After /clear the process goes on under a new session, and so do its servers.
    if (e.reason !== 'clear') {
      ticker?.cancel()
      ticker = undefined
      for (const name of new Set([...live.keys(), ...opening.keys()])) await stop($, name).catch(report($))
    }
    return ended
  })

  on('tool.call', { tool: OUTPUT_TOOL }, async ($, e) => answerOutput($, e.server, e.lines))
  on('tool.call', { tool: RESTART_TOOL }, async ($, e) => restartByClaude($, e.server))
  // Reading stored lines and a process's state asks no one; restart goes through the normal check.
  on('tool.check', { tool: OUTPUT_TOOL }, () => ({ decision: 'allow' }))

  on('command.run', { command: COMMAND }, async ($, e) => {
    await restoreCarried($)
    if (e.args.trim() !== '') return { text: await runSubcommand($, config, e.args) }
    await loadRows($, config)
    await refresh($)
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    return { text: 'Dev servers pane opened.' }
  })

  // The output pages under a title and table that never move: the engine's window stays put
  // (no next) while the mod moves its own slice; below the floor the engine scrolls the body.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const data = {
      rows: await read($, rowsAtom),
      runs: await read($, runsAtom),
      output: await read($, outputAtom),
      view: await read($, viewAtom),
      peers: await read($, peersAtom),
      now: await $.clock.now(),
    }
    const geometry = paneGeometry(data, paneColumns, e.bodyRows)
    if (!geometry.isBounded) return next(e)
    if (e.pointer !== undefined && e.pointer.row < geometry.used) return {}
    const anchor = scrollAnchor(geometry.lines, geometry.outputRows, data.view.anchor, moveOf(e.by, e.bodyRows, e.contentRows))
    await update($, viewAtom, view => ({ ...view, anchor }))
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    paneColumns = e.props.bodyColumns
    const hasSettings = (await $.command.list().catch(() => [])).some(command => command.name === 'mod-settings')
    return renderPane($.ui.resolve(e), e.props.bodyColumns, e.props.scroll.bodyRows, {
      rows: await read($, rowsAtom),
      runs: await read($, runsAtom),
      output: await read($, outputAtom),
      view: await read($, viewAtom),
      peers: await read($, peersAtom),
      now: await $.clock.now(),
      hasSettings,
      actions: paneActions($, config),
    })
  })
}
