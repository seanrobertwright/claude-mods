import type { Source } from '../types'

/** The most sources the pane keeps. */
export const MOST_SOURCES = 300

export type Group = { label: string; isProject: boolean; sources: Source[] }

/** What `/sources` was asked to do, read from everything typed after the name. */
export type Request = { kind: 'open' } | { kind: 'allowed' } | { kind: 'allow'; path: string } | { kind: 'usage' }

export const USAGE = 'Usage: /sources, /sources allow, /sources allow <path>'

/**
 * The path with forward slashes, its `.` and `..` segments folded and no trailing slash, so two spellings
 * of a place compare equal. A `..` at a drive, share or root stays there, as the file system has it;
 * one at the start of a relative path is kept.
 */
export function normal(path: string): string {
  const slashed = path.replace(/\\/g, '/')
  const [, head = '', rest = ''] = /^(\/\/[^/]+\/[^/]+|[A-Za-z]:(?=\/|$)|\/?)(.*)$/.exec(slashed) ?? []
  const parts: string[] = []
  for (const part of rest.split('/')) {
    if (part === '' || part === '.') continue
    if (part !== '..') parts.push(part)
    else if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop()
    else if (head === '') parts.push(part)
  }
  const body = parts.join('/')
  if (head === '') return body === '' ? '.' : body
  // A bare drive or the root keeps its slash; a share has none of its own.
  if (head.startsWith('//')) return body === '' ? head : `${head}/${body}`
  return head === '/' ? `/${body}` : `${head}/${body}`
}

function isAbsolute(path: string): boolean {
  return /^([A-Za-z]:[\\/]|[\\/])/.test(path)
}

/**
 * Whether the tool reads the path from somewhere its spelling does not say: `~` is the home folder to it,
 * and `D:x` is relative to that drive's own current folder.
 */
function isUnplaceable(path: string): boolean {
  return /^~\w*(?:[\\/]|$)/.test(path) || /^[A-Za-z]:(?![\\/])/.test(path)
}

/** The full path of what a tool named, which may be given from the project folder, with its `.` and `..` folded. */
export function fullPath(path: string, cwd: string): string {
  return normal(isAbsolute(path) ? path : `${cwd}/${path}`)
}

/** Whether `path` is the folder or lies inside it, once both are folded. Letter case is passed over, as Windows does. */
export function isUnder(path: string, folder: string): boolean {
  const inner = normal(path).toLowerCase()
  const outer = normal(folder).toLowerCase()
  return inner === outer || inner.startsWith(outer.endsWith('/') ? outer : `${outer}/`)
}

/** Whether `path` is one of the folders or lies inside one. */
export function isAllowed(path: string, folders: readonly string[]): boolean {
  return folders.some(folder => isUnder(path, folder))
}

/** What a read tool's call names: a file for Read, the folder searched for Grep and Glob (the project folder when none is given). */
export function named(input: object): string {
  const { file_path: file, path } = input as { file_path?: unknown; path?: unknown }
  if (typeof file === 'string') return file
  return typeof path === 'string' ? path : '.'
}

/** Where a read tool's call reaches: full paths, or the spelling no folder bounds. */
export type Reach = { kind: 'places'; places: string[] } | { kind: 'unplaced'; spelling: string }

/**
 * The places a read tool's call reaches, each a full path: the file Read names; for Grep and Glob, the folder
 * searched and, for Glob's `pattern` or Grep's `glob`, the folder before its first wildcard (the whole
 * pattern when it has none). Grep's own
 * `pattern` is a regex, not a path. A spelling no folder bounds is given back instead: `~`, `D:x`, or a `..`
 * after a wildcard or among braces.
 */
export function reached(tool: string, input: object, cwd: string): Reach {
  const { pattern, glob } = input as { pattern?: unknown; glob?: unknown }
  const filter = tool === 'Glob' ? pattern : tool === 'Grep' ? glob : undefined
  const spellings = [named(input), ...(typeof filter === 'string' ? [filter] : [])]
  const unplaced = spellings.find(isUnplaceable)
  if (unplaced !== undefined) return { kind: 'unplaced', spelling: unplaced }
  const [searched = '.', ...filters] = spellings
  const folder = fullPath(searched, cwd)
  const places = [folder]
  for (const each of filters) {
    const slashed = each.replace(/\\/g, '/')
    const parts = slashed.split('/')
    const wild = parts.findIndex(part => /[*?[\]{}]/.test(part))
    const literal = wild === -1 ? parts : parts.slice(0, wild)
    if (wild !== -1 && parts.slice(wild).some(part => /(?:^|[{,])\.\.(?:$|[},])/.test(part))) return { kind: 'unplaced', spelling: each }
    // A pattern that starts at the root keeps it.
    places.push(fullPath(literal.join('/') || (slashed.startsWith('/') ? '/' : '.'), folder))
  }
  return { kind: 'places', places }
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
