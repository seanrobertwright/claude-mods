// Reading runs: Archon's server first, the CLI in the same tick when the
// server does not answer (ADR-0005). The server is preferred, never required.

import type { Detail, Project, Run, RunEvent, RunFile } from '../types'
import type { Runner } from './cli'
import { parseRun, parseRuns } from './runs'
import { belongs, projectFromCodebases, projectFromRows } from './scope'
import type { Platform } from './scope'
import { lastLine } from './text'

/** What reading needs from the engine. */
export type Io = {
  run: Runner
  fetch: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; ok: boolean; headers: Record<string, string>; text: string }>
  sleep: (ms: number) => Promise<void>
}

/** How long the server has to answer: `$.http.fetch` has no timeout of its own. */
export const SERVER_TIMEOUT_MS = 2_000
export const LIST_LIMIT = 50

export type Listing = {
  source: 'server' | 'cli'
  /** The project's codebase ids and which source matched them. */
  ids: string[]
  from: Project['from']
  /** This project's rows. */
  mine: Run[]
  /** Every row listed on the machine, this project's included. */
  all: Run[]
}

const TIMED_OUT = Symbol('timed out')

/** `work` raced against `ms` of the clock; TIMED_OUT when the clock wins. */
export async function within<T>(io: Io, ms: number, work: Promise<T>): Promise<T | typeof TIMED_OUT> {
  work.catch(() => {})
  return Promise.race<T | typeof TIMED_OUT>([work, io.sleep(ms).then((): typeof TIMED_OUT => TIMED_OUT)])
}

export function isTimedOut(value: unknown): value is typeof TIMED_OUT {
  return value === TIMED_OUT
}

/**
 * A request to the server, raced against 2 s. Any failure is undefined:
 * refused, timed out, non-2xx, or HTML, which an `/api/` path the server does
 * not know answers with a 200.
 */
export async function serverText(io: Io, url: string): Promise<{ text: string; type: string } | undefined> {
  try {
    const reply = await within(io, SERVER_TIMEOUT_MS, io.fetch(url))
    if (isTimedOut(reply) || !reply.ok) return undefined
    const type = reply.headers['content-type'] ?? ''
    if (type.includes('text/html') || /^\s*</.test(reply.text)) return undefined
    return { text: reply.text, type }
  } catch {
    return undefined
  }
}

/** A JSON body from the server; undefined on any failure, an unparseable body included. */
export async function serverJson(io: Io, url: string): Promise<unknown> {
  const reply = await serverText(io, url)
  if (reply === undefined) return undefined
  try {
    return JSON.parse(reply.text)
  } catch {
    return undefined
  }
}

async function fromServer(io: Io, base: string, project: Project, platform: Platform): Promise<Listing | undefined> {
  let ids = project.from === 'server' ? project.ids : []
  if (ids.length === 0) {
    const codebases = await serverJson(io, `${base}/api/codebases`)
    if (!Array.isArray(codebases)) return undefined
    ids = projectFromCodebases(codebases, project.primary, platform)
  }
  const bodies = await Promise.all([
    serverText(io, `${base}/api/dashboard/runs?limit=${LIST_LIMIT}`),
    ...ids.map(id => serverText(io, `${base}/api/dashboard/runs?codebaseId=${encodeURIComponent(id)}&limit=${LIST_LIMIT}`)),
  ])
  if (bodies.some(body => body === undefined)) return undefined
  try {
    const [everyone, ...own] = bodies.map(body => parseRuns(body!.text))
    const mine = new Map<string, Run>()
    for (const run of own.flat()) mine.set(run.id, run)
    const all = new Map<string, Run>()
    for (const run of [...everyone!, ...mine.values()]) all.set(run.id, run)
    return { source: 'server', ids, from: 'server', mine: [...mine.values()], all: [...all.values()] }
  } catch {
    return undefined
  }
}

async function fromCli(io: Io, archon: string, project: Project, platform: Platform): Promise<Listing> {
  const listed = await io.run([archon, 'workflow', 'runs', '--json', '--all', '--limit', String(LIST_LIMIT)])
  if (listed.exitCode !== 0) throw new Error(lastLine(listed.stderr) || `archon exited with ${listed.exitCode}`)
  const all = parseRuns(listed.stdout)
  // A set the server matched is reused; a set the CLI matched is kept until r; an empty one is tried again.
  const isKept = project.ids.length > 0 && project.from !== ''
  const ids = isKept ? project.ids : projectFromRows(all, project.primary, project.top, platform)
  const from = isKept ? project.from : ids.length > 0 ? 'cli' : ''
  const mine = all.filter(run => belongs(run, ids, project.primary, project.top, platform))
  return { source: 'cli', ids, from, mine, all }
}

/** Lists the runs: the server when it answers, else the CLI in the same tick. */
export async function listRuns(io: Io, port: number, archon: string, project: Project, platform: Platform): Promise<Listing> {
  return (await fromServer(io, `http://localhost:${port}`, project, platform)) ?? fromCli(io, archon, project, platform)
}

/** What reading details needs beyond listing: the disk. */
export type DiskIo = Io & {
  exists: (path: string) => Promise<boolean>
  list: (path: string) => Promise<{ name: string; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number }[]>
}

/** Longest node output or error kept per event; the Log cuts them further. */
const MOST_OUTPUT = 20_000
/** The event types the pane draws from; heartbeats, hooks and sub-tasks are left out. */
const KEPT = /^(node_|approval_|workflow_|loop_iteration|tool_called$)/

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string {
  if (typeof value === 'string') return value
  return value === undefined || value === null ? '' : JSON.stringify(value)
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** The events a run's detail lists, either source's, kept to what the pane draws. */
export function parseEvents(value: unknown): RunEvent[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): RunEvent[] => {
    if (!isObject(entry)) return []
    const type = str(entry.event_type ?? entry.type)
    if (!KEPT.test(type)) return []
    const data = isObject(entry.data) ? entry.data : {}
    const node = isObject(data.node) ? data.node : {}
    const at = Date.parse(str(entry.created_at))
    return [{
      type,
      step: str(entry.step_name) || str(node.id),
      at: Number.isNaN(at) ? 0 : at,
      output: str(data.node_output ?? data.output).slice(0, MOST_OUTPUT),
      error: str(data.error).slice(0, MOST_OUTPUT),
      iteration: num(data.iteration),
      decision: str(data.decision),
      text: str(data.comment ?? data.text ?? data.reason),
      reason: str(data.reason ?? data.skip_reason),
      durationMs: num(data.duration_ms ?? data.durationMs),
      costUsd: num(data.cost_usd ?? data.costUsd),
    }]
  })
}

/** A run's files as either listing gives them, newest first. */
export function parseFiles(value: unknown): RunFile[] {
  if (!Array.isArray(value)) return []
  const files = value.flatMap((entry): RunFile[] => {
    if (typeof entry === 'string') return entry === '' || entry.startsWith('.archon/') ? [] : [{ path: entry, size: 0, modifiedAt: 0 }]
    if (!isObject(entry) || str(entry.path) === '' || str(entry.path).startsWith('.archon/')) return []
    const at = Date.parse(str(entry.modifiedAt))
    return [{ path: str(entry.path), size: num(entry.size), modifiedAt: Number.isNaN(at) ? num(entry.modifiedAt) : at }]
  })
  return files.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

/** The files under `<output_root>/artifacts/runs/<id>/` on disk, skipping Archon's own `.archon/`. */
async function filesOnDisk(io: DiskIo, run: Run): Promise<RunFile[]> {
  if (run.outputRoot === '') return []
  const root = `${run.outputRoot.replace(/\\/g, '/').replace(/\/+$/, '')}/artifacts/runs/${run.id}`
  const found: RunFile[] = []
  const walk = async (folder: string, prefix: string, depth: number): Promise<void> => {
    const entries = await io.list(folder).catch(() => [])
    for (const entry of entries) {
      if (prefix === '' && entry.name === '.archon') continue
      if (entry.kind === 'dir' && depth < 4) await walk(`${folder}/${entry.name}`, `${prefix}${entry.name}/`, depth + 1)
      else if (entry.kind === 'file') found.push({ path: `${prefix}${entry.name}`, size: entry.size, modifiedAt: entry.mtimeMs })
    }
  }
  await walk(root, '', 0)
  return found.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

export type Read = { run: Run | undefined; detail: Detail }

/** One run by id, with its events and files: the server's two routes, or the CLI's two `workflow get` calls. */
export async function readDetail(io: DiskIo, port: number, archon: string, id: string, isServer: boolean, known: Run | undefined): Promise<Read | undefined> {
  const base = `http://localhost:${port}`
  if (isServer) {
    const [one, listed] = await Promise.all([serverJson(io, `${base}/api/workflows/runs/${encodeURIComponent(id)}`), serverJson(io, `${base}/api/runs/${encodeURIComponent(id)}/artifacts`)])
    if (isObject(one)) {
      const run = parseRun(one.run) ?? known
      const files = isObject(listed) ? parseFiles(listed.files) : run === undefined ? [] : await filesOnDisk(io, run)
      return { run, detail: { events: parseEvents(one.events), files, transcriptPath: '', isWorkingPathThere: await isThere(io, run) } }
    }
  }
  const [verbose, plain] = await Promise.all([
    io.run([archon, 'workflow', 'get', id, '--json', '--verbose', '--events']).catch(() => undefined),
    io.run([archon, 'workflow', 'get', id, '--json']).catch(() => undefined),
  ])
  const body = (output: { exitCode: number; stdout: string } | undefined): Record<string, unknown> | undefined => {
    if (output?.exitCode !== 0) return undefined
    try {
      const parsed: unknown = JSON.parse(output.stdout)
      return isObject(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }
  const withEvents = body(verbose)
  const get = body(plain)
  if (withEvents === undefined && get === undefined) return undefined
  const run = parseRun(isObject(get?.run) ? get.run : get) ?? parseRun(isObject(withEvents?.run) ? withEvents.run : withEvents) ?? known
  return {
    run,
    detail: {
      events: parseEvents(withEvents?.events),
      files: run === undefined ? [] : await filesOnDisk(io, run),
      transcriptPath: str(get?.transcript_path),
      isWorkingPathThere: await isThere(io, run),
    },
  }
}

async function isThere(io: DiskIo, run: Run | undefined): Promise<boolean> {
  if (run === undefined || run.workingPath === '') return false
  return io.exists(run.workingPath).catch(() => false)
}

/** What a row looked like, to tell a changed one: status, last activity and its gate. */
export function signature(run: Run): string {
  return JSON.stringify([run.status, run.lastActivityAt, run.approval, run.wait])
}
