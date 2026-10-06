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

/** A process that opens a file with its own application, and whether its exit code tells an open from a failure. */
export type Opener = { argv: string[]; isExitTrusted: boolean }

/** The Windows folder from `SystemRoot`, taken only as an absolute folder on a drive; else `C:\Windows`. */
export function windowsFolder(systemRoot: string | undefined): string {
  const trimmed = (systemRoot ?? '').replace(/\\+$/, '')
  return /^[A-Za-z]:\\[^"<>|?*]*$/.test(trimmed) ? trimmed : 'C:\\Windows'
}

/**
 * The processes that open a file with its own application, tried in turn: on Windows (`windows`, its
 * Windows folder) explorer.exe with the path as its one argument, so no shell reads the name; else `open`,
 * then `xdg-open`. explorer.exe is named by its full path in the Windows folder, so no other explorer.exe
 * on PATH runs in its place, and its exit code is not trusted: it can exit 1 when it opened the file.
 */
export function openers(path: string, windows: string | undefined): Opener[] {
  if (windows !== undefined) return [{ argv: [`${windows}\\explorer.exe`, path.replace(/\//g, '\\')], isExitTrusted: false }]
  return [
    { argv: ['open', path], isExitTrusted: true },
    { argv: ['xdg-open', path], isExitTrusted: true },
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
