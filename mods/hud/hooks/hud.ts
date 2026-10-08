import type { Git, HudView, Limit } from '../types'

export const SEGMENTS = ['model', 'effort', 'context', 'limits', 'turn', 'tools', 'agents', 'git', 'worktree', 'cost', 'session', 'folder'] as const
export type SegmentId = (typeof SEGMENTS)[number]

export type Theme = 'neon' | 'ocean' | 'ember' | 'mono'
export type Config = { theme: Theme; animate: boolean; placement: 'below' | 'above'; hidden: ReadonlySet<SegmentId> }

/** One figure of the row: the label that names it, its text, and how the text is painted. */
export type Segment = { id: string; kind: SegmentId; label: string; text: string; color: string | undefined; isBold: boolean; isInverse: boolean }

type Level = 'ok' | 'warn' | 'danger'

/** Left out first when the row is too wide; what is not named here goes last. */
const DROP_ORDER: readonly SegmentId[] = ['folder', 'session', 'cost', 'tools', 'worktree', 'git', 'agents', 'effort', 'model', 'turn', 'limits', 'context']
const GAP = 2
const GAUGE_CELLS = 8
const LEVEL_COLORS: Readonly<Record<Level, string>> = { ok: '#5fff87', warn: '#ffd75f', danger: '#ff5f5f' }
const PALETTES: Readonly<Record<Theme, readonly string[]>> = {
  neon: ['#ff5fd7', '#af87ff', '#5fafff', '#5fffd7', '#d7ff5f', '#ffaf5f'],
  ocean: ['#5fd7ff', '#5fafff', '#5f87ff', '#87afff', '#5fffd7', '#87ffd7'],
  ember: ['#ffd75f', '#ffaf5f', '#ff875f', '#ff5f5f', '#ff5f87', '#ffaf87'],
  mono: [],
}
/** The worktree figure's label: the leafless tree, then its name. */
const WORKTREE_LABEL = '\u{1FABE} worktree'
const LIMIT_NAMES: Readonly<Record<string, string>> = { five_hour: '5h limit', seven_day: '7d limit', spend_limit: 'spend limit' }
/** The share of a rate limit at which its figure turns yellow, and red. */
const LIMIT_WARN_AT = 75
const LIMIT_DANGER_AT = 90
/** The figures of the first line; the rest go on the second. */
const FIRST_LINE: ReadonlySet<SegmentId> = new Set(['model', 'effort', 'context', 'limits'])

function isSegment(name: string): name is SegmentId {
  return (SEGMENTS as readonly string[]).includes(name)
}

export function parseConfig(options: Readonly<Record<string, unknown>>): Config {
  const theme = options.theme
  const hide = typeof options.hide === 'string' ? options.hide : ''
  return {
    theme: theme === 'ocean' || theme === 'ember' || theme === 'mono' ? theme : 'neon',
    animate: options.animate !== false,
    placement: options.placement === 'above' ? 'above' : 'below',
    hidden: new Set(hide.split(',').map(name => name.trim().toLowerCase()).filter(isSegment)),
  }
}

/** `claude-fable-5-1[1m]` as `fable 5.1`: the family and its version, without the vendor, the date or the window. */
export function shortModel(model: string): string {
  const bare = model.replace(/\[.*\]$/, '').replace(/^claude-/, '').replace(/-\d{8}$/, '')
  const [, family = bare, version = ''] = /^([a-z]+)-(\d+(?:-\d+)*)$/i.exec(bare) ?? []
  return version === '' ? family : `${family} ${version.replace(/-/g, '.')}`
}

/** A length of time in its two largest parts: `42s`, `4m 12s`, `1h 6m`, `2d 3h`. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** A length of time to the minute, for figures that move slowly: `under 1m`, `12m`, `1h 6m`. */
export function coarse(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return 'under 1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`
}

export function gauge(percent: number, cells = GAUGE_CELLS): string {
  const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)))
  return '█'.repeat(filled) + '░'.repeat(cells - filled)
}

export function level(percent: number, warnAt: number, dangerAt: number): Level {
  if (percent >= dangerAt) return 'danger'
  return percent >= warnAt ? 'warn' : 'ok'
}

/** The last part of a path, whatever its slashes. */
export function folderName(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(part => part !== '')
  return parts[parts.length - 1] ?? cwd
}

/** Reads `git status --porcelain=v2 --branch`: the branch, commits ahead and behind, and the count of changed files. */
export function parseGit(output: string): Git | null {
  const lines = output.split(/\r?\n/)
  const head = lines.find(line => line.startsWith('# branch.head '))
  if (head === undefined) return null
  const [, ahead = '0', behind = '0'] = /^# branch\.ab \+(\d+) -(\d+)/.exec(lines.find(line => line.startsWith('# branch.ab ')) ?? '') ?? []
  const changed = lines.filter(line => /^[12u?] /.test(line)).length
  return { branch: head.slice('# branch.head '.length).trim(), changed, ahead: Number(ahead), behind: Number(behind) }
}

/** Whether two paths name one folder: one kind of slash, no trailing one, either case. */
function samePath(a: string, b: string): boolean {
  const norm = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/**
 * Reads `git rev-parse --path-format=absolute --git-dir --git-common-dir --show-toplevel`: the top folder of a
 * linked worktree, whose own git directory is not the one its repository shares; null for the main checkout.
 */
export function parseWorktree(output: string): string | null {
  const [gitDir = '', commonDir = '', top = ''] = output.split(/\r?\n/).map(line => line.trim())
  if (gitDir === '' || commonDir === '' || top === '') return null
  return samePath(gitDir, commonDir) ? null : top
}

function gitText(git: Git): string {
  const marks = [git.changed > 0 ? `${git.changed} changed` : '', git.ahead > 0 ? `${git.ahead} ahead` : '', git.behind > 0 ? `${git.behind} behind` : '']
  return [git.branch, ...marks.filter(mark => mark !== '')].join(' · ')
}

/**
 * When a rate-limit window resets, in milliseconds since the epoch; NaN when the engine gave no time or one
 * that cannot be read. A time without a zone is read as UTC, never as the machine's local time.
 */
export function resetTime(resetsAt: string | null): number {
  if (resetsAt === null) return Number.NaN
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(resetsAt) ? resetsAt : `${resetsAt}Z`)
}

function limitText(percent: number, resetsAt: string | null, now: number): string {
  const at = resetTime(resetsAt)
  const left = Number.isFinite(at) && at > now ? ` · resets in ${coarse(at - now)}` : ''
  return `${Math.round(percent)}%${left}`
}

/**
 * The limits to warn about now: each at the red level, unless already warned about in its window. `warned`
 * holds, by limit, the reset time of the window it was last warned in (null for a limit with none). A limit
 * is warned about again only in a new window: a reset time other than the warned one, once the warned one
 * has passed. A limit with no reset time is warned about once.
 */
export function limitsToWarn(limits: readonly Limit[], warned: Readonly<Record<string, string | null>>, now: number): Limit[] {
  return limits.filter(limit => {
    if (level(limit.percent, LIMIT_WARN_AT, LIMIT_DANGER_AT) !== 'danger') return false
    if (!Object.hasOwn(warned, limit.kind)) return true
    const last = warned[limit.kind] ?? null
    const lastReset = resetTime(last)
    return limit.resetsAt !== last && Number.isFinite(lastReset) && now >= lastReset
  })
}

/** What the toast for a limit at the red level says: `5h limit at 91% · resets in 2h 5m`. */
export function limitWarning(limit: Limit, now: number): string {
  return `${LIMIT_NAMES[limit.kind] ?? limit.kind} at ${limitText(limit.percent, limit.resetsAt, now)}`
}

type Figure = { kind: SegmentId; id: string; label: string; text: string; level?: Level }

/** What each figure is called, what it says and at what level, in the order drawn; the empty ones left out. */
function figures(view: HudView, now: number): Figure[] {
  const out: Figure[] = []
  if (view.model !== '') out.push({ kind: 'model', id: 'model', label: 'model', text: shortModel(view.model) })
  if (view.effort !== null) out.push({ kind: 'effort', id: 'effort', label: 'effort', text: view.effort })
  if (view.contextPercent !== null) {
    const percent = Math.round(view.contextPercent)
    out.push({ kind: 'context', id: 'context', label: 'context', text: `${gauge(percent)} ${percent}%`, level: level(percent, 70, 85) })
  }
  for (const limit of view.limits) {
    out.push({
      kind: 'limits',
      id: `limit-${limit.kind}`,
      label: LIMIT_NAMES[limit.kind] ?? limit.kind,
      text: limitText(limit.percent, limit.resetsAt, now),
      level: level(limit.percent, LIMIT_WARN_AT, LIMIT_DANGER_AT),
    })
  }
  if (view.isWorking) out.push({ kind: 'turn', id: 'turn', label: 'turn', text: duration(now - view.turnStartedAt) })
  if (view.toolsSession > 0) out.push({ kind: 'tools', id: 'tools', label: 'tools', text: `${view.toolsTurn} this turn · ${view.toolsSession} total` })
  if (view.agents > 0) out.push({ kind: 'agents', id: 'agents', label: 'agents', text: `${view.agents} running` })
  if (view.git !== null) out.push({ kind: 'git', id: 'git', label: 'git', text: gitText(view.git) })
  if (view.worktree !== null) out.push({ kind: 'worktree', id: 'worktree', label: WORKTREE_LABEL, text: folderName(view.worktree) })
  if (view.costUsd !== null) out.push({ kind: 'cost', id: 'cost', label: 'cost', text: `$${view.costUsd.toFixed(2)}` })
  if (view.startedAt > 0) out.push({ kind: 'session', id: 'session', label: 'session', text: coarse(now - view.startedAt) })
  if (view.folder !== '') out.push({ kind: 'folder', id: 'folder', label: 'folder', text: folderName(view.folder) })
  return out
}

/** Cells a text takes on a terminal: an emoji from the pictograph planes two, a variation selector none, the rest one. */
export function cells(text: string): number {
  return Array.from(text).reduce((sum, char) => {
    const code = char.codePointAt(0) ?? 0
    return sum + (code === 0xfe0f ? 0 : code >= 0x1f000 ? 2 : 1)
  }, 0)
}

/** A line's width as drawn: each figure's label, a space and its text, with the gap between figures. */
export function rowWidth(segments: readonly { label: string; text: string }[]): number {
  return segments.reduce((sum, segment) => sum + cells(segment.label) + 1 + cells(segment.text), 0) + GAP * Math.max(0, segments.length - 1)
}

/**
 * The row as drawn at `frame`, in its lines: the figures that are not hidden, each line cut to fit `columns`.
 * A figure with a level takes that level's colour; the rest take the theme's, which move along the row while a turn runs.
 */
export function rows(view: HudView, config: Config, now: number, frame: number, columns: number): Segment[][] {
  const shown = figures(view, now).filter(figure => !config.hidden.has(figure.kind))
  const lines = [shown.filter(figure => FIRST_LINE.has(figure.kind)), shown.filter(figure => !FIRST_LINE.has(figure.kind))].map(line => {
    let kept = line
    for (const kind of DROP_ORDER) {
      if (rowWidth(kept) <= columns) break
      kept = kept.filter(figure => figure.kind !== kind)
    }
    return kept
  })
  const count = lines.reduce((sum, line) => sum + line.length, 0)
  const palette = PALETTES[config.theme]
  const isMoving = config.animate && view.isWorking
  const shift = isMoving ? Math.floor(frame / 2) : 0
  let index = 0
  return lines
    .filter(line => line.length > 0)
    .map(line =>
      line.map(figure => {
        const at = index
        index += 1
        const isLit = isMoving && (at + shift) % Math.max(3, count) === 0
        const themed = palette.length === 0 ? undefined : palette[(at + shift) % palette.length]
        const isAlarm = figure.level === 'danger'
        return {
          id: figure.id,
          kind: figure.kind,
          label: figure.label,
          text: figure.text,
          color: figure.level === undefined ? themed : LEVEL_COLORS[figure.level],
          isBold: isAlarm || isLit,
          isInverse: isAlarm && isMoving && frame % 4 < 2,
        }
      }),
    )
}
