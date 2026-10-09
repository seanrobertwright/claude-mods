// The world beneath archon-panel in a test: the Archon CLI, Archon's server,
// the disk, git and the session's surfaces, all answered from memory through
// the test's own `on` (no network, no real Archon), with every call recorded.

import type { On } from 'claude-code'

import { CODEBASES, listBody, OUTPUT_ROOT, PRIMARY } from './runs'
import type { Row } from './runs'

export const VERSION = 'Archon CLI v0.11.1\n'
export const OLD_VERSION = 'Archon CLI v0.10.1\n'
export const HOME = 'C:/home'
export const HOME_ARCHON = 'C:/home/.archon/bin/archon.exe'

/** A spawned follower the test feeds by hand: chunks, then an exit. */
export type Feed = {
  chunks: string[]
  /** Set to end the child; undefined while it runs. */
  code?: number
  wake?: () => void
}

/** A follower that waits for the test's chunks. */
export function feed(): Feed {
  return { chunks: [] }
}

/** Hands a waiting follower one chunk. */
export function send(f: Feed, text: string): void {
  f.chunks.push(text)
  f.wake?.()
}

/** Ends a waiting follower with an exit code. */
export function end(f: Feed, code = 0): void {
  f.code = code
  f.wake?.()
}

export type Reply = { exitCode: number; stdout: string; stderr?: string } | 'hang' | 'cannot-start'
export type HttpReply = { status: number; body: string; type?: string } | 'refused' | 'hang'

export type World = {
  /** Where the CLI is: the setting's path, the PATH, `~/.archon/bin`, or nowhere. */
  archonAt: 'setting' | 'path' | 'home' | 'none'
  settingPath: string
  version: string
  /** How the server answers: up, refusing, hanging past 2 s, or with the web UI's HTML. */
  server: 'up' | 'down' | 'hang' | 'html'
  codebases: Record<string, unknown>[]
  rows: Row[]
  events: Record<string, Record<string, unknown>[]>
  artifacts: Record<string, { path: string; size: number; modifiedAt: string }[]>
  /** Artifact contents by `<runId>/<path>`. */
  artifactText: Record<string, string>
  transcripts: Record<string, string>
  /** Files on disk, by absolute path with forward slashes. */
  disk: Record<string, string>
  git: { common: string; top: string; branch: string } | null
  cwd: string
  surfaces: string[]
  panes: { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }[]
  commands: string[]
  sessionId: string
  /** A reply for a CLI argv or a server request, ahead of the world's own answer. */
  cliReply?: (argv: readonly string[]) => Reply | undefined
  httpReply?: (method: string, path: string, body: string) => HttpReply | undefined
  feeds: Record<string, Feed>
  /** Releases a held reply. */
  release: () => void
  // What happened, oldest first.
  argv: string[][]
  fetches: { method: string; url: string; body: string }[]
  spawned: string[][]
  killed: string[][]
  toasts: { text: string; timeoutMs: number }[]
  status: (string | undefined)[]
  opened: string[]
  filled: string[]
  copied: string[]
}

export function world(over: Partial<World> = {}): World {
  return {
    archonAt: 'home',
    settingPath: '',
    version: VERSION,
    server: 'up',
    codebases: CODEBASES,
    rows: [],
    events: {},
    artifacts: {},
    artifactText: {},
    transcripts: {},
    disk: {},
    git: { common: `${PRIMARY}/.git`, top: PRIMARY, branch: 'main' },
    cwd: PRIMARY,
    surfaces: ['terminal'],
    panes: [],
    commands: [],
    sessionId: 'session-a',
    feeds: {},
    release: () => {},
    argv: [],
    fetches: [],
    spawned: [],
    killed: [],
    toasts: [],
    status: [],
    opened: [],
    filled: [],
    copied: [],
    ...over,
  }
}

const done = (stdout: string, exitCode = 0, stderr = '') =>
  ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })

/** Whether argv[0] names the CLI where the world has it. */
function isArchon(w: World, command: string): boolean {
  if (w.archonAt === 'none') return false
  if (w.archonAt === 'setting') return command === w.settingPath
  if (w.archonAt === 'path') return command === 'archon'
  return command.replace(/\\/g, '/') === HOME_ARCHON
}

function rowOf(w: World, id: string): Row | undefined {
  return w.rows.find(r => r.id === id)
}

/** What `archon workflow get <id> --json` prints: the row, its transcript path and what it left behind. */
function getBody(w: World, id: string, withEvents: boolean): string | undefined {
  const r = rowOf(w, id)
  if (r === undefined) return undefined
  const files = (w.artifacts[id] ?? []).map(f => f.path)
  return JSON.stringify({
    ...r,
    transcript_path: `${OUTPUT_ROOT}/logs/${id}.jsonl`,
    leave_behind: { artifactFiles: files, worktreeLive: true },
    ...(withEvents ? { events: w.events[id] ?? [] } : {}),
  })
}

async function cli(w: World, argv: readonly string[], hold: Promise<void>) {
  const [, noun, verb, id] = argv
  if (noun === '--version') return done(w.version)
  if (noun !== 'workflow') return done('', 1, `unknown command ${noun}`)
  if (verb === 'runs') return done(listBody(w.rows))
  if (verb === 'get' && id !== undefined) {
    const body = getBody(w, id, argv.includes('--events'))
    return body === undefined ? done('', 1, `Workflow run not found: ${id}`) : done(body)
  }
  if (verb === 'logs' && id !== undefined) {
    const text = w.transcripts[id]
    return text === undefined ? done('', 1, `No transcript found for run ${id}`) : done(text)
  }
  if (['approve', 'reject', 'respond', 'resume'].includes(verb ?? '')) {
    return done(JSON.stringify({ ok: true, runId: id, action: verb, detached: true, continues: true, workflowName: rowOf(w, id ?? '')?.workflow_name, logPath: `${HOME}/.archon/logs/detached-run-cli-1.log` }))
  }
  if (verb === 'abandon') return done(JSON.stringify({ ok: true, runId: id, action: 'abandon' }))
  void hold
  return done('', 1, `unknown workflow command ${verb}`)
}

function json(body: unknown, status = 200) {
  return { value: { status, ok: status >= 200 && status < 300, headers: { 'content-type': 'application/json; charset=utf-8' }, text: JSON.stringify(body) } }
}

async function server(w: World, method: string, url: URL, body: string) {
  const path = decodeURIComponent(url.pathname)
  if (method === 'GET' && path === '/api/health') return json({ status: 'ok', version: '0.11.1', runningWorkflows: 0, activePlatforms: ['web'] })
  if (method === 'GET' && path === '/api/codebases') return json(w.codebases)
  if (method === 'GET' && path === '/api/dashboard/runs') {
    const codebase = url.searchParams.get('codebaseId')
    const rows = codebase === null ? w.rows : w.rows.filter(r => r.codebase_id === codebase)
    return { value: { status: 200, ok: true, headers: { 'content-type': 'application/json' }, text: listBody(rows) } }
  }
  const one = /^\/api\/workflows\/runs\/([^/]+)$/.exec(path)
  if (method === 'GET' && one !== null) {
    const r = rowOf(w, one[1]!)
    return r === undefined ? json({ error: 'Workflow run not found' }, 404) : json({ run: r, events: w.events[r.id] ?? [] })
  }
  const listed = /^\/api\/runs\/([^/]+)\/artifacts$/.exec(path)
  if (method === 'GET' && listed !== null) return json({ files: w.artifacts[listed[1]!] ?? [] })
  const file = /^\/api\/artifacts\/([^/]+)\/(.+)$/.exec(path)
  if (method === 'GET' && file !== null) {
    const text = w.artifactText[`${file[1]}/${file[2]}`]
    if (text === undefined) return json({ error: 'Artifact file not found' }, 404)
    return { value: { status: 200, ok: true, headers: { 'content-type': file[2]!.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8' }, text } }
  }
  const act = /^\/api\/workflows\/runs\/([^/]+)\/(approve|reject|respond|resume|abandon)$/.exec(path)
  if (method === 'POST' && act !== null) return json({ success: true, message: `${act[2]} recorded` })
  void body
  // An /api/ path the server does not know answers 200 with the web UI.
  return { value: { status: 200, ok: true, headers: { 'content-type': 'text/html; charset=utf-8' }, text: '<!doctype html><html><body>Archon</body></html>' } }
}

/** Hooks the world beneath the plugins. Register before the test's first call on `$`. */
export function fake(on: On, w: World): void {
  let held = Promise.resolve()
  w.release = () => {}
  const hold = () => {
    held = new Promise(resolve => (w.release = resolve))
    return held
  }

  on('env.get', (_$, e) => ({ value: e.name === 'USERPROFILE' || e.name === 'HOME' ? HOME : e.name === 'OS' ? 'Windows_NT' : e.name === 'SystemRoot' ? 'C:\\Windows' : undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  on('session.detach', (_$, e) => ({ clientId: e.clientId }))
  on('session.surfaces', () => ({ value: [...w.surfaces] as never }))
  on('session.cwd', () => ({ value: w.cwd }))
  on('session.id', () => ({ value: w.sessionId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }) as never)
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({ value: w.commands.map(name => ({ name, description: name, source: 'plugin' })) as never }))
  on('command.run', (_$, e) => ({ value: { text: `ran /${e.command}` } }) as never)
  on('ui.toast', (_$, e) => {
    w.toasts.push({ text: e.text, timeoutMs: e.timeoutMs ?? 4000 })
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    w.status.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    w.opened.push(e.focus === true ? `${e.id}+focus${e.columns === undefined ? '' : '+columns'}` : `${e.id}${e.columns === undefined ? '' : '+columns'}`)
    if (!w.panes.some(p => p.id === e.id)) w.panes.push({ id: e.id, title: e.title ?? e.id, isShown: true, isFocused: e.focus === true, isPlaced: true })
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: w.panes.map(p => ({ ...p })) }))
  on('ui.copy', (_$, e) => {
    w.copied.push(e.text)
    return { value: { isCopied: true } } as never
  })
  on('prompt.fill', (_$, e) => {
    w.filled.push(e.text)
    return { value: { isFilled: true, text: e.text, cursor: e.text.length } } as never
  })
  on('fs.read', (_$, e) => {
    const text = w.disk[e.path.replace(/\\/g, '/')]
    if (text === undefined) throw new Error(`ENOENT: no such file or directory, open '${e.path}'`)
    return { value: text }
  })
  on('fs.exists', (_$, e) => {
    const path = e.path.replace(/\\/g, '/').replace(/\/$/, '')
    return { value: Object.keys(w.disk).some(key => key === path || key.startsWith(`${path}/`)) }
  })
  on('fs.stat', (_$, e) => {
    const path = e.path.replace(/\\/g, '/').replace(/\/$/, '')
    const text = w.disk[path]
    if (text !== undefined) return { value: { kind: 'file', size: text.length, mtimeMs: 0, isLink: false } }
    if (Object.keys(w.disk).some(key => key.startsWith(`${path}/`))) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
    throw new Error(`ENOENT: no such file or directory, stat '${e.path}'`)
  })
  on('fs.list', (_$, e) => {
    const path = e.path.replace(/\\/g, '/').replace(/\/$/, '')
    const names = new Map<string, 'file' | 'dir'>()
    for (const key of Object.keys(w.disk)) {
      if (!key.startsWith(`${path}/`)) continue
      const rest = key.slice(path.length + 1)
      const [name = '', ...more] = rest.split('/')
      names.set(name, more.length > 0 ? 'dir' : 'file')
    }
    if (names.size === 0) throw new Error(`ENOENT: no such file or directory, scandir '${e.path}'`)
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: kind === 'file' ? (w.disk[`${path}/${name}`] ?? '').length : 0, mtimeMs: 0, isLink: false })) }
  })
  on('process.run', async (_$, e) => {
    const argv = [...e.argv]
    w.argv.push(argv)
    if (argv[0] === 'git') {
      if (w.git === null) return done('', 128, 'fatal: not a git repository (or any of the parent directories): .git')
      if (argv.includes('--git-common-dir')) return done(`${w.git.common}\n`)
      if (argv.includes('--show-toplevel')) return done(`${w.git.top}\n`)
      if (argv.includes('--show-current')) return done(`${w.git.branch}\n`)
      return done('')
    }
    const reply = w.cliReply?.(argv)
    if (reply === 'cannot-start') throw new Error(`ENOENT: Command '${argv[0]}' not found`)
    if (reply === 'hang') {
      await hold()
      return done('')
    }
    if (reply !== undefined) return done(reply.stdout, reply.exitCode, reply.stderr ?? '')
    if (!isArchon(w, argv[0] ?? '')) throw new Error(`ENOENT: Command '${argv[0]}' not found or is in an unsafe location (current directory)`)
    return cli(w, argv, held)
  })
  on('process.spawn', async function* (_$, e) {
    const argv = [...e.argv]
    w.spawned.push(argv)
    const id = argv[3] ?? ''
    if (!isArchon(w, argv[0] ?? '')) throw new Error(`ENOENT: Command '${argv[0]}' not found`)
    let isEnded = false
    try {
      const feed = w.feeds[id]
      if (feed === undefined) {
        const text = w.transcripts[id] ?? ''
        // A line split across two chunks, as a spawn delivers them.
        const cut = Math.floor(text.length / 2)
        if (text.slice(0, cut) !== '') yield { stream: 'stdout' as const, text: text.slice(0, cut) }
        if (text.slice(cut) !== '') yield { stream: 'stdout' as const, text: text.slice(cut) }
        isEnded = true
        return { value: { code: 0, signal: null } }
      }
      for (;;) {
        const chunk = feed.chunks.shift()
        if (chunk !== undefined) {
          yield { stream: 'stdout' as const, text: chunk }
          continue
        }
        if (feed.code !== undefined) {
          isEnded = true
          return { value: { code: feed.code, signal: null } }
        }
        await new Promise<void>(resolve => (feed.wake = resolve))
        feed.wake = undefined
      }
    } finally {
      if (!isEnded) w.killed.push(argv)
    }
  })
  on('http.fetch', async (_$, e) => {
    const method = e.init?.method ?? 'GET'
    const body = e.init?.body ?? ''
    w.fetches.push({ method, url: e.url, body })
    const url = new URL(e.url)
    const reply = w.httpReply?.(method, decodeURIComponent(url.pathname), body)
    if (reply === 'refused' || (reply === undefined && w.server === 'down')) throw new Error('connect ECONNREFUSED 127.0.0.1:3090')
    if (reply === 'hang' || (reply === undefined && w.server === 'hang')) {
      await hold()
      throw new Error('socket hang up')
    }
    if (reply !== undefined) return { value: { status: reply.status, ok: reply.status >= 200 && reply.status < 300, headers: { 'content-type': reply.type ?? 'application/json' }, text: reply.body } }
    if (w.server === 'html') return { value: { status: 200, ok: true, headers: { 'content-type': 'text/html; charset=utf-8' }, text: '<!doctype html><html></html>' } }
    return server(w, method, url, body)
  })
}

/** The argv of every CLI call, with the CLI's own path left out. */
export function archonCalls(w: World): string[] {
  return w.argv.filter(argv => argv[0] !== 'git').map(argv => argv.slice(1).join(' '))
}

/** The pane's render props at a width. */
export function paneProps(bodyColumns = 60, bodyRows = 40, isFocused = true) {
  return { title: 'Archon', isFocused, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows }, view: {} } as const
}

/** The Archon pane, open and in front. */
export const IN_FRONT = () => [{ id: 'archon', title: 'Archon', isShown: true, isFocused: false, isPlaced: true }]

export const TERMINAL = { surface: 'terminal', clientId: 'terminal:default', viewport: { columns: 200, rows: 50, isFullscreen: true } } as const
export const PHONE = { surface: 'mobile', clientId: 'mobile:default', viewport: { columns: 40, rows: 60, isFullscreen: false } } as const
