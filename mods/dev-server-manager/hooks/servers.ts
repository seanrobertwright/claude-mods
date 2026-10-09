// The server list as the pane, the status line and the model see it: each
// row's state, glyph, words and buttons, and the restart policy.

import type { PeerEntry, RowDef, ServerRun, ServerStatus } from '../types'
import { endWords, hhmm } from './output'

/** The automatic restart cap: at most this many in the window. */
export const RESTART_CAP = 3
export const RESTART_WINDOW_MS = 120_000
/** How long a running server keeps its note and error button after an automatic restart. */
export const NOTE_MS = 600_000

/** A row as drawn: its definition, this session's run of it, and another session's entry for it. */
export type Row = {
  def: RowDef
  run: ServerRun | undefined
  peer: PeerEntry | undefined
}

/** A button of the detail block, by key; its hotkey is its first letter, error → prompt's `e`. */
export type Action = 'start' | 'stop' | 'restart' | 'error' | 'hide'

export type Tone = 'dim' | 'yellow' | 'red' | 'plain'

export function newRun(): ServerRun {
  return {
    status: 'stopped',
    url: '',
    startedAt: 0,
    endedAt: 0,
    movedFrom: 0,
    isAfterReload: false,
    problem: '',
    holder: '',
    crashes: [],
    restarts: [],
    isGaveUp: false,
    death: null,
    hasNote: false,
    lastExit: null,
  }
}

/** Where a row stands; a row this session never ran is stopped. */
export function statusOf(row: Row): ServerStatus {
  return row.run?.status ?? 'stopped'
}

/** Whether a row's server is up: starting or running. */
export function isUp(status: ServerStatus): boolean {
  return status === 'starting' || status === 'running'
}

/** Another session runs it, and this session does not. */
export function isPeerRow(row: Row): boolean {
  return row.peer !== undefined && !isUp(statusOf(row))
}

const GLYPHS: Record<ServerStatus, string> = {
  running: '●',
  starting: '◌',
  stopped: '○',
  'port taken': '!',
  crashed: '✗',
  exited: '–',
}

export function glyph(row: Row): string {
  return isPeerRow(row) ? '●' : GLYPHS[statusOf(row)]
}

/** `4s`, `12m`, `1h 5m`. */
export function span(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** Whether a running server still shows its note and error button: until 10 minutes without dying. */
export function showsNote(run: ServerRun | undefined, now: number): boolean {
  return run !== undefined && run.hasNote && run.status === 'running' && run.death !== null && now - run.startedAt < NOTE_MS
}

/** The crash count and first time since the person last handled the server: `14:02` or `3× since 14:02`. */
function crashWords(run: ServerRun): string {
  const first = run.crashes[0] ?? run.death?.at ?? 0
  return run.crashes.length > 1 ? `${run.crashes.length}× since ${hhmm(first)}` : hhmm(first)
}

/** The row's words and their tone, as the table and the detail block show them. */
export function rowWords(row: Row, now: number): { text: string; tone: Tone } {
  const { def, run, peer } = row
  if (isPeerRow(row) && peer !== undefined) return { text: `running in another session${peer.port > 0 ? ` · :${peer.port}` : ''}`, tone: 'plain' }
  const status = statusOf(row)
  if (def.blocked !== '' && !isUp(status)) return { text: def.blocked, tone: 'yellow' }
  if (run === undefined) return { text: 'stopped', tone: 'dim' }
  switch (status) {
    case 'starting':
      return { text: `starting… ${span(now - run.startedAt)}`, tone: 'yellow' }
    case 'running': {
      if (showsNote(run, now)) {
        const restarts = run.restarts.length
        const text = run.crashes.length > 1 ? `crashed ${crashWords(run)}` : `crashed ${crashWords(run)}, restarted (${restarts}/${RESTART_CAP})`
        return { text, tone: 'yellow' }
      }
      const extras = [run.isAfterReload ? 'restarted after reload' : '', run.movedFrom > 0 ? `moved from :${run.movedFrom}` : '', run.problem]
        .filter(extra => extra !== '')
      return { text: [`up ${span(now - run.startedAt)}`, ...extras].join(' · '), tone: run.movedFrom > 0 || run.problem !== '' ? 'yellow' : 'plain' }
    }
    case 'port taken':
      return { text: run.holder, tone: 'yellow' }
    case 'crashed':
      if (run.isGaveUp) return { text: `crashed ${crashWords(run)}, gave up`, tone: 'red' }
      return { text: `crashed (${endWords(run.death ?? { code: run.lastExit, signal: null })})`, tone: 'red' }
    case 'exited':
      return { text: `exited ${hhmm(run.endedAt)}`, tone: 'dim' }
    default:
      return run.problem !== '' ? { text: run.problem, tone: 'yellow' } : { text: 'stopped', tone: 'dim' }
  }
}

const ERROR_WORD = /\b(error|exception|traceback|fatal|panic)\b/i

/** The error's first line, which a dead row shows: the first line naming an error, else the last it printed; '' when it printed nothing. */
export function errorHead(run: ServerRun | undefined): string {
  const lines = (run?.death?.lines ?? []).map(line => line.trim()).filter(line => line !== '')
  return lines.find(line => ERROR_WORD.test(line)) ?? lines[lines.length - 1] ?? ''
}

/** The buttons the detail block shows for a row, in order. Another session's server has none. */
export function actions(row: Row, now: number): Action[] {
  if (isPeerRow(row)) return []
  const status = statusOf(row)
  const hide: Action[] = row.def.source === 'detected' ? ['hide'] : []
  switch (status) {
    case 'starting':
      return ['stop']
    case 'running':
      return showsNote(row.run, now) ? ['stop', 'restart', 'error'] : ['stop', 'restart']
    case 'crashed':
      return ['start', 'error', ...hide]
    default:
      return ['start', ...hide]
  }
}

/** The port a row shows: the URL's, else the known one; 0 for none. */
export function portOf(row: Row): number {
  if (isPeerRow(row)) return row.peer?.port ?? 0
  const url = row.run?.url ?? ''
  const match = /:(\d+)$/.exec(url)
  return match === null ? row.def.port : Number(match[1])
}

/** The command as the person reads it. */
export function commandText(def: RowDef): string {
  return def.argv.filter(word => word !== '').map(word => (/\s/.test(word) ? `"${word}"` : word)).join(' ')
}
