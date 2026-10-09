// The engine beneath dev-server-manager in a test: a project folder, scripted
// children for $.process.spawn, canned port tools for $.process.run, the
// surfaces, a clock and a store, and records of what the mod did.
import { mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, ProcessSpawnRequest, RenderSurface } from 'claude-code'

export const ROOT = '/work/app'
export const PLUGIN = 'dev-server-manager'
export const PANE_ID = 'dev-servers'

/** One piece a scripted child writes, after an optional pause on the mocked clock. */
export type Piece = { text: string; stream?: 'stdout' | 'stderr'; afterMs?: number }

/** A scripted child: its pieces, then its exit (none: it runs until stopped), a failure of its stream after them, or a refusal to start. */
export type Child = {
  pieces?: Piece[]
  exit?: { code: number | null; signal: string | null }
  exitAfterMs?: number
  cannotStart?: string
  failsWith?: string
}

export type World = {
  clock: MockClock
  surfaces: RenderSurface[]
  /** What a fill of the prompt box answers; `no_composer` refuses it. */
  composer: 'ok' | 'no_composer'
  /** The children each argv (joined by spaces) starts, in turn; one not listed runs silently until stopped. */
  children: Map<string, Child[]>
  /** Answers for `$.process.run` by argv joined by spaces; a missing one rejects as a command not found. */
  runs: Map<string, { stdout: string; exitCode?: number }[] | { stdout: string; exitCode?: number }>
  spawned: ProcessSpawnRequest[]
  /** The argv of each child stopped by the mod (its stream closed). */
  killed: string[]
  ran: string[]
  toasts: { text: string; timeoutMs?: number }[]
  status: (string | undefined)[]
  filled: { text: string; mode: string }[]
  sent: string[]
  panes: string[]
  tools: string[]
  store: Map<string, unknown>
  stateWrites: string[]
  sessionId: string
  toolSpecs: { name: string; isDeferred: unknown }[]
  isToolRegisterRefused: boolean
  logs: string[]
}

export type WorldOptions = {
  packageJson?: string
  lockfiles?: string[]
  surfaces?: RenderSurface[]
  os?: string
  now?: number
  store?: Record<string, unknown>
  sessionId?: string
  hasSettings?: boolean
}

export const DEFAULT_PACKAGE = JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' } })

/** Sets up the world beneath the mod; call before the test's first call on `$`. */
export function world(on: On, options: WorldOptions = {}): World {
  const clock = mock.clock(on, { now: options.now ?? new Date(2026, 9, 9, 14, 0).getTime() })
  const w: World = {
    clock,
    surfaces: options.surfaces ?? ['terminal'],
    composer: 'ok',
    children: new Map(),
    runs: new Map(),
    spawned: [],
    killed: [],
    ran: [],
    toasts: [],
    status: [],
    filled: [],
    sent: [],
    panes: [],
    tools: [],
    store: new Map(Object.entries(options.store ?? {})),
    stateWrites: [],
    sessionId: options.sessionId ?? 'session-a',
    toolSpecs: [],
    isToolRegisterRefused: false,
    logs: [],
  }
  // The machine's port tools: netstat answers with no listener unless a test says otherwise.
  w.runs.set('netstat -ano', { stdout: '' })
  const packageJson = 'packageJson' in options ? options.packageJson : DEFAULT_PACKAGE
  const lockfiles = options.lockfiles ?? ['package-lock.json']
  mock.env(on, options.os === undefined ? { OS: 'Windows_NT' } : options.os === '' ? {} : { OS: options.os })

  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: w.sessionId }))
  on('session.surfaces', () => ({ value: [...w.surfaces] }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({
    value: options.hasSettings === true ? [{ name: 'mod-settings', description: 'Open the mod settings dialog', source: 'plugin' }] : [],
  }) as never)
  on('fs.read', (_$, e) => {
    const path = e.path.replace(/\\/g, '/')
    if (packageJson !== undefined && path.endsWith(`${ROOT}/package.json`)) return { value: packageJson }
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('fs.exists', (_$, e) => ({ value: lockfiles.some(file => e.path.replace(/\\/g, '/').endsWith(`${ROOT}/${file}`)) }))

  on('store.get', (_$, e) => ({ value: w.store.get(e.key) }))
  on('store.set', (_$, e) => {
    w.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    w.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  on('state.set', (_$, e, next) => {
    w.stateWrites.push(e.key)
    return next(e)
  })

  on('ui.toast', (_$, e) => {
    w.toasts.push({ text: e.text, timeoutMs: e.timeoutMs })
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    w.status.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    w.panes.push(`open ${e.id}${e.focus === true ? '+focus' : ''}`)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$, e) => {
    w.panes.push(`close ${e.id}`)
    return { value: undefined }
  })
  on('prompt.fill', (_$, e) => {
    w.filled.push({ text: e.text, mode: e.mode })
    // The kit has no prompt box of its own, and a hook's refusal reaches the mod without its cause.
    return w.composer === 'ok' ? { isFilled: true, text: e.text, cursor: e.text.length } : { isFilled: false }
  })
  on('ui.log', (_$, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => {
    w.sent.push(e.text)
    return { text: e.text }
  })
  on('tool.register', (_$, e) => {
    if (w.isToolRegisterRefused) return { deny: 'the session is not bound yet' }
    w.tools.push(e.name)
    w.toolSpecs.push({ name: e.name, isDeferred: e.isDeferred })
    return { value: { tool: `mcp__${PLUGIN}__${e.name}` } }
  })

  on('process.run', (_$, e) => {
    const key = e.argv.join(' ')
    w.ran.push(key)
    const answer = w.runs.get(key)
    const one = Array.isArray(answer) ? (answer.length > 1 ? answer.shift() : answer[0]) : answer
    if (one === undefined) throw new Error(`ENOENT: Command '${e.argv[0]}' not found or is in an unsafe location (current directory)`)
    return { value: { exitCode: one.exitCode ?? 0, stdout: one.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  on('process.spawn', async function* (_$, e, next) {
    w.spawned.push(e)
    const key = e.argv.join(' ')
    const child = w.children.get(key)?.shift() ?? {}
    if (child.cannotStart !== undefined) return { deny: child.cannotStart }
    const stopped = new Promise<'stopped'>(resolve => next.signal.addEventListener('abort', () => resolve('stopped')))
    let isEnded = false
    try {
      for (const piece of child.pieces ?? []) {
        if (piece.afterMs !== undefined && (await Promise.race([clock.sleep(piece.afterMs), stopped])) === 'stopped') return { value: { code: null, signal: null } }
        yield { stream: piece.stream ?? 'stdout', text: piece.text }
      }
      if (child.failsWith !== undefined) throw new Error(child.failsWith)
      if (child.exit === undefined) {
        await stopped
        return { value: { code: null, signal: null } }
      }
      if (child.exitAfterMs !== undefined && (await Promise.race([clock.sleep(child.exitAfterMs), stopped])) === 'stopped') {
        return { value: { code: null, signal: null } }
      }
      isEnded = true
      return { value: child.exit }
    } finally {
      if (!isEnded) w.killed.push(key)
    }
  })
  return w
}

/** Scripts the next child `argv` starts. */
export function script(w: World, argv: string, ...children: Child[]): void {
  w.children.set(argv, [...(w.children.get(argv) ?? []), ...children])
}

export const PANE = {
  title: 'Dev servers',
  isFocused: true,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

/** Starts the session and mounts the pane at `columns` across and `rows` down. */
export async function openPane($: Engine, columns = 60, rows = 30) {
  return $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE_ID,
    props: { ...PANE, bodyColumns: columns, scroll: { offset: 0, bodyRows: rows } },
  })
}

export async function startSession($: Engine): Promise<void> {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
}
