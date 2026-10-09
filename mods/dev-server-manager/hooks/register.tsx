import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register } from 'claude-code'

import type { OutputLine, PaneView, PeerEntry, RowDef, Rows, ServerRun } from '../types'
import { ADD_USAGE, parseAdd } from './add'
import type { AddedServer } from './add'
import { detectRows, LOCKFILES, parseScripts } from './detect'
import { findLocalUrl, hhmm, keep, splitPiece, stripAnsi } from './output'
import { checkPort } from './port'
import type { PortCheck } from './port'
import { commandText, newRun } from './servers'
import { renderPane } from './view'
import type { PaneActions } from './view'

const PLUGIN = 'dev-server-manager'
const PANE = 'dev-servers'
const TITLE = 'Dev servers'
const COMMAND = 'dev-servers'
/** Output reaches `$.state` at most about once a second. */
const FLUSH_MS = 1000
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
// The servers the mod itself stopped, whose port may linger before the next start.
const stoppedByMod = new Set<string>()

type Config = { isRestartOn: boolean; scripts: string[] }

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
  flushedAt = await $.clock.now()
  const snapshot = memory
  await update($, outputAtom, () => snapshot)
}

async function setRun($: EngineInterface, name: string, change: (run: ServerRun) => ServerRun): Promise<void> {
  await update($, runsAtom, runs => ({ ...runs, [name]: change(runs[name] ?? newRun()) }))
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
        }
      }
    }
  } catch (error) {
    if (live.get(name) === entry) live.delete(name)
    if (entry.isStopping || hasStarted) return
    // A command that cannot start rejects the first pull: its message is the row's words.
    const message = (error instanceof Error ? error.message : String(error)).replace(/^dev-server-manager: \$\.process\.spawn: /, '')
    await setRun($, name, run => ({ ...run, status: 'stopped', problem: message }))
    return
  }
  if (live.get(name) === entry) live.delete(name)
  if (entry.isStopping) return
  const at = await $.clock.now()
  const rest = (['stdout', 'stderr'] as const).filter(stream => pending[stream] !== '')
  await addOutput($, name, rest.map(stream => ({ stream, text: stripAnsi(pending[stream]), at })))
  const code = result?.code ?? null
  const signal = result?.signal ?? null
  if (code === 0 && signal === null) {
    await setRun($, name, run => ({ ...run, status: 'exited', endedAt: at, lastExit: 0, hasNote: false }))
  } else {
    await setRun($, name, run => ({ ...run, status: 'crashed', endedAt: at, lastExit: code }))
  }
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

/** Starts a server: the port check first, then the child, with no shell. */
async function start($: EngineInterface, name: string, divider: string): Promise<void> {
  if (live.has(name) || !(await isShown($))) return
  const def = await defOf($, name)
  if (def === undefined || def.blocked !== '') return
  let problem = ''
  if (def.port > 0) {
    const check = await portCheck($, name, def.port)
    if (check.status === 'taken') {
      await setRun($, name, run => ({ ...run, status: 'port taken', holder: check.words, problem: '' }))
      return
    }
    if (check.status === 'unchecked') problem = 'port not checked'
  }
  const root = await $.session.root()
  const now = await $.clock.now()
  await addOutput($, name, [{ stream: 'divider', text: `── ${divider} ${hhmm(now)} ──`, at: now }])
  await setRun($, name, run => ({ ...run, status: 'starting', url: '', startedAt: now, endedAt: 0, movedFrom: 0, problem, holder: '' }))
  const entry: Live = {
    stream: $.process.spawn({ argv: def.argv, cwd: join(root, def.cwd), env: { PYTHONUNBUFFERED: '1' } }),
    isStopping: false,
  }
  live.set(name, entry)
  void follow($, name, entry).catch(report($))
}

/** Stops a server the mod runs: closing its stream kills the whole tree, and reads no exit code. */
async function stop($: EngineInterface, name: string): Promise<void> {
  const entry = live.get(name)
  if (entry === undefined) return
  entry.isStopping = true
  live.delete(name)
  stoppedByMod.add(name)
  await entry.stream.return(undefined as never).catch(() => undefined)
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
    start: name => void start($, name, 'started').catch(report($)),
    stop: name => void stop($, name).catch(report($)),
    restart: name => void restartByHand($, name).catch(report($)),
    fillError: () => undefined,
    hide: name =>
      void (async () => {
        await setHidden($, config, name, true)
        await update($, viewAtom, view => (view.picked === name ? { ...view, picked: null } : view))
      })().catch(report($)),
    unhide: name => void setHidden($, config, name, false).catch(report($)),
    toggleHidden: () => void update($, viewAtom, view => ({ ...view, isShowingHidden: !view.isShowingHidden })),
    latest: () => undefined,
    settings: () => void $.command.run({ command: 'mod-settings' }).catch(report($)),
  }
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

/** The person's restart: stop, then start again. */
async function restartByHand($: EngineInterface, name: string): Promise<void> {
  await stop($, name)
  await start($, name, 'restarted')
}

export const register: Register = (on, options) => {
  const config = parseConfig(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: COMMAND, description: 'Open the dev servers pane: start, stop and watch the project dev servers' })
    await loadRows($, config)
    return started
  })

  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    // After /clear the process goes on under a new session, and so do its servers.
    if (e.reason !== 'clear') {
      for (const name of [...live.keys()]) await stop($, name).catch(report($))
    }
    return ended
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    if (e.args.trim() !== '') return { text: await runSubcommand($, config, e.args) }
    await loadRows($, config)
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    return { text: 'Dev servers pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
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
