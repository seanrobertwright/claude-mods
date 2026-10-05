/** An Office file a tool call names: the path as written and the application that would hold it open. */
export type OfficeFile = { path: string; folder: string; name: string; app: string }

const APPS: Readonly<Record<string, string>> = {
  docx: 'Word',
  docm: 'Word',
  dotx: 'Word',
  xlsx: 'Excel',
  xlsm: 'Excel',
  pptx: 'PowerPoint',
}
const EXTENSION = `\\.(?:${Object.keys(APPS).join('|')})`
// A path in double quotes, in single quotes, or bare up to the next space or shell mark.
const IN_COMMAND = new RegExp(`"([^"\\n]+${EXTENSION})"|'([^'\\n]+${EXTENSION})'|([^\\s"'\`|<>;()=,]+${EXTENSION})(?![\\w.])`, 'gi')
const MOST_FILES = 5

/** The path as an Office file, or undefined when it is not one or cannot be a single file. */
export function officeFile(path: string): OfficeFile | undefined {
  const extension = /\.([a-z]+)$/i.exec(path)?.[1]?.toLowerCase() ?? ''
  const app = APPS[extension]
  // A glob or a variable names no one file.
  if (app === undefined || /[*?$%{}]/.test(path.replace(/~\$/g, ''))) return undefined
  // Git Bash writes C:\Users as /c/Users.
  const native = path.replace(/^\/([a-zA-Z])\//, '$1:/')
  const cut = Math.max(native.lastIndexOf('/'), native.lastIndexOf('\\'))
  const name = native.slice(cut + 1)
  // A lock file is never the target.
  if (name.startsWith('~$')) return undefined
  return { path: native, folder: native.slice(0, cut + 1), name, app }
}

/** The Office files a shell command names, each once, the first few. */
export function officeFilesIn(command: string): OfficeFile[] {
  const found = new Map<string, OfficeFile>()
  for (const match of command.matchAll(IN_COMMAND)) {
    const file = officeFile(match[1] ?? match[2] ?? match[3] ?? '')
    if (file !== undefined && !found.has(file.path.toLowerCase())) found.set(file.path.toLowerCase(), file)
  }
  return [...found.values()].slice(0, MOST_FILES)
}

/**
 * Where Office leaves its lock while the file is open: `~$` and the name, beside the file.
 * Word drops the name's first one or two characters when the name is long, so each form is given.
 */
export function lockPaths(file: OfficeFile): string[] {
  const names = file.app === 'Word' ? [file.name, file.name.slice(1), file.name.slice(2)] : [file.name]
  return names.map(name => `${file.folder}~$${name}`)
}
