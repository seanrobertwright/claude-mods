import type { OutputFile } from '../types'

/** One entry of a folder, as `$.fs.list` gives it. */
export type Entry = { name: string; kind: 'file' | 'dir' | 'other'; mtimeMs: number; isLink: boolean }

/** The most folders one scan lists, so a huge project folder cannot stall the session. */
export const MOST_FOLDERS = 300
export const MOST_DEPTH = 6
/** The most files the pane keeps. */
export const MOST_FILES = 60

const DOCUMENTS = new Set(['docx', 'doc', 'docm', 'dotx', 'xlsx', 'xlsm', 'xls', 'pptx', 'ppt', 'pdf', 'md', 'html', 'htm', 'txt'])
const SKIPPED_FOLDERS = new Set(['node_modules', '__pycache__', 'venv'])

export function isDocument(name: string): boolean {
  return DOCUMENTS.has(/\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '')
}

/** Whether a scan goes into the folder: not a hidden one (`.git`), nor one of dependencies. */
export function isScanned(entry: Entry): boolean {
  return entry.kind === 'dir' && !entry.isLink && !entry.name.startsWith('.') && !SKIPPED_FOLDERS.has(entry.name)
}

/** Whether the entry is a file to list: changed since `since`, and not the lock file Office leaves beside an open one. */
export function isOutput(entry: Entry, since: number): boolean {
  return entry.kind === 'file' && entry.mtimeMs >= since && !entry.name.startsWith('~$')
}

export function joined(folder: string, name: string): string {
  return folder === '' ? name : `${folder}/${name}`
}

/** The file as the pane keeps it, from its folder under the project folder `root`. */
export function outputFile(root: string, folder: string, entry: Entry): OutputFile {
  const base = root.replace(/[\\/]+$/, '')
  return { path: `${base}/${joined(folder, entry.name)}`, name: entry.name, folder, mtimeMs: entry.mtimeMs, isDocument: isDocument(entry.name) }
}

/** Newest first, the first `MOST_FILES`. */
export function newestFirst(files: readonly OutputFile[]): OutputFile[] {
  return [...files].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MOST_FILES)
}

/** The process that opens a file with its own application: `start` on Windows, else `open`, then `xdg-open`. */
export function openers(path: string, isWindows: boolean): string[][] {
  if (isWindows) return [['cmd', '/c', 'start', '', path.replace(/\//g, '\\')]]
  return [
    ['open', path],
    ['xdg-open', path],
  ]
}

/** The path as the clipboard takes it: with the machine's own separator. */
export function nativePath(path: string, isWindows: boolean): string {
  return isWindows ? path.replace(/\//g, '\\') : path
}

export function fit(line: string, max: number): string {
  const chars = Array.from(line)
  return chars.length <= max ? line : `${chars.slice(0, Math.max(1, max - 1)).join('')}…`
}

export function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  return minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`
}
