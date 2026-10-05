import type { Source } from '../types'

/** The most sources the pane keeps. */
export const MOST_SOURCES = 300

export type Group = { label: string; isProject: boolean; sources: Source[] }

/** What `/sources` was asked to do, read from everything typed after the name. */
export type Request = { kind: 'open' } | { kind: 'allowed' } | { kind: 'allow'; path: string } | { kind: 'usage' }

export const USAGE = 'Usage: /sources, /sources allow, /sources allow <path>'

/** The path with forward slashes and no trailing one, so two spellings of a folder compare equal. */
export function normal(path: string): string {
  const slashed = path.replace(/\\/g, '/')
  const trimmed = slashed.replace(/\/+$/, '')
  // A bare drive or the root keeps its slash.
  return trimmed === '' || /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}/` : trimmed
}

function isAbsolute(path: string): boolean {
  return /^([A-Za-z]:[\\/]|[\\/])/.test(path)
}

/** The full path of what a tool named, which may be given from the project folder. */
export function fullPath(path: string, cwd: string): string {
  return normal(isAbsolute(path) ? path : `${cwd}/${path}`)
}

/** Whether `path` is the folder or lies inside it. Letter case is passed over, as Windows does. */
export function isUnder(path: string, folder: string): boolean {
  const inner = normal(path).toLowerCase()
  const outer = normal(folder).toLowerCase()
  return inner === outer || inner.startsWith(outer.endsWith('/') ? outer : `${outer}/`)
}

export function isAllowed(path: string, cwd: string, allowed: readonly string[]): boolean {
  return [cwd, ...allowed].some(folder => isUnder(path, folder))
}

/** Where a path outside the project folder came from: its drive or share with its first two folders. */
export function rootOf(path: string): string {
  const clean = normal(path)
  const [, head = '', rest = ''] = /^([A-Za-z]:|\/\/[^/]+\/[^/]+|)\/?(.*)$/.exec(clean) ?? []
  // The last part is the file itself.
  const folders = rest.split('/').slice(0, -1).slice(0, 2)
  return `${head}/${folders.join('/')}`.replace(/\/$/, '') || '/'
}

/** The sources with `path` newest, each path once, within the bound. */
export function withSource(sources: readonly Source[], path: string, at: number): Source[] {
  const key = path.toLowerCase()
  return [{ path, at }, ...sources.filter(held => held.path.toLowerCase() !== key)].slice(0, MOST_SOURCES)
}

/** The project folder's group first, then each other root in the order it was last read. */
export function grouped(sources: readonly Source[], cwd: string): Group[] {
  const groups = new Map<string, Group>()
  const project: Group = { label: 'This folder', isProject: true, sources: [] }
  for (const source of sources) {
    if (isUnder(source.path, cwd)) {
      project.sources.push(source)
      continue
    }
    const label = rootOf(source.path)
    const group = groups.get(label.toLowerCase()) ?? { label, isProject: false, sources: [] }
    group.sources.push(source)
    groups.set(label.toLowerCase(), group)
  }
  return [...(project.sources.length > 0 ? [project] : []), ...groups.values()]
}

/** The path as a group's line shows it: without the group's own folder, cut from the front to fit. */
export function shown(path: string, folder: string, max: number): string {
  const inner = isUnder(path, folder) && normal(path).length > normal(folder).length ? normal(path).slice(normal(folder).replace(/\/$/, '').length + 1) : normal(path)
  const chars = Array.from(inner)
  return chars.length <= max ? inner : `…${chars.slice(chars.length - Math.max(1, max - 1)).join('')}`
}

export function parseRequest(args: string): Request {
  const trimmed = args.trim()
  if (trimmed === '') return { kind: 'open' }
  const [, verb = '', rest = ''] = /^(\S+)\s*(.*)$/.exec(trimmed) ?? []
  if (verb !== 'allow') return { kind: 'usage' }
  const path = (/^"(.*)"$/.exec(rest) ?? /^'(.*)'$/.exec(rest))?.[1] ?? rest
  return path === '' ? { kind: 'allowed' } : { kind: 'allow', path }
}

/** Why a read outside the allowed folders is refused, for the model to pass on. */
export function refusal(path: string): string {
  return `sources: reads are kept to the project folder while the lock is on, and ${path} is outside it. The person can allow a folder with /sources allow <path>, or turn the lock off with l in the Sources pane.`
}
