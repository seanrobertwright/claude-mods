// Which runs are this project's. The mod scopes runs itself and never uses
// Archon's own folder scoping (`scopeFallback`), which compares paths as exact
// strings and misses a project registered with the other kind of slash.

import type { Run } from '../types'

export type Platform = 'windows' | 'mac' | 'linux'

/**
 * One spelling of a path for comparing, the same on both sides: `\` to `/`,
 * repeated slashes collapsed, `.` and `..` resolved, the trailing slash dropped
 * except on a root (`D:/`, `/`), and lower case on Windows and macOS. No
 * `realpath`: a project registered through a junction is a known miss.
 */
export function normalize(path: string, platform: Platform): string {
  const slashed = path.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  const drive = /^[A-Za-z]:/.exec(slashed)?.[0] ?? ''
  const rest = slashed.slice(drive.length)
  const isRooted = rest.startsWith('/')
  const parts: string[] = []
  for (const part of rest.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  const joined = `${drive}${isRooted || drive !== '' ? '/' : ''}${parts.join('/')}`
  return platform === 'linux' ? joined : joined.toLowerCase()
}

/** Whether `inner` is `outer` or a folder inside it, both normalized. */
function isInside(inner: string, outer: string): boolean {
  return inner === outer || inner.startsWith(outer.endsWith('/') ? outer : `${outer}/`)
}

/**
 * The server path (`GET /api/codebases`): the ids whose `default_cwd` is the
 * primary checkout; failing that, the deepest `default_cwd` holding it; failing
 * that, none. Never "list everything".
 */
export function projectFromCodebases(codebases: readonly unknown[], primary: string, platform: Platform): string[] {
  const p = normalize(primary, platform)
  const known = codebases.flatMap(entry => {
    if (typeof entry !== 'object' || entry === null) return []
    const { id, default_cwd: cwd } = entry as Record<string, unknown>
    return typeof id === 'string' && typeof cwd === 'string' && cwd !== '' ? [{ id, cwd: normalize(cwd, platform) }] : []
  })
  const exact = known.filter(entry => entry.cwd === p)
  if (exact.length > 0) return exact.map(entry => entry.id)
  const holding = known.filter(entry => isInside(p, entry.cwd))
  const deepest = Math.max(-1, ...holding.map(entry => entry.cwd.length))
  return holding.filter(entry => entry.cwd.length === deepest).map(entry => entry.id)
}

/** Whether a row itself names the project: its origin is the primary checkout, or its working path is that or the top level. */
export function namesProject(run: Run, primary: string, top: string, platform: Platform): boolean {
  const p = normalize(primary, platform)
  const t = normalize(top, platform)
  const origin = run.origin === '' ? '' : normalize(run.origin, platform)
  const working = run.workingPath === '' ? '' : normalize(run.workingPath, platform)
  return origin === p || working === p || working === t
}

/**
 * The CLI path, since no CLI command lists projects: the codebase ids of the
 * rows that name the project. `output_root` is never used: it is built from the
 * repo's name and would merge two clones.
 */
export function projectFromRows(runs: readonly Run[], primary: string, top: string, platform: Platform): string[] {
  const ids = runs.filter(run => run.codebaseId !== '' && namesProject(run, primary, top, platform)).map(run => run.codebaseId)
  return [...new Set(ids)]
}

/** Whether a row belongs: its codebase is in the set, or, with no codebase, it names the project itself. */
export function belongs(run: Run, ids: readonly string[], primary: string, top: string, platform: Platform): boolean {
  if (run.codebaseId === '') return namesProject(run, primary, top, platform)
  return ids.includes(run.codebaseId)
}

/** Whether a run is pinned first: only in a linked worktree, for runs working in it. */
export function isPinned(run: Run, primary: string, top: string, platform: Platform): boolean {
  const t = normalize(top, platform)
  return t !== normalize(primary, platform) && run.workingPath !== '' && normalize(run.workingPath, platform) === t
}
