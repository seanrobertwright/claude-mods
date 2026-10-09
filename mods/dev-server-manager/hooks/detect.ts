// Which package.json scripts become rows, and which package manager runs them.

/** The scripts setting's default: the names a dev server's script usually has. */
export const DEFAULT_SCRIPTS: readonly string[] = ['dev', 'start', 'serve', 'preview']

/** Each lockfile and the package manager that writes it, in the order a conflict names them. */
export const LOCKFILES: readonly (readonly [file: string, manager: string])[] = [
  ['package-lock.json', 'npm'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
]

/** A row detected from the root package.json: the script's name and the argv that runs it. */
export type DetectedRow = {
  name: string
  argv: string[]
}

export type Detected = {
  rows: DetectedRow[]
  /** The lockfiles that disagree when package.json names no packageManager; empty when the manager is known. */
  conflict: string[]
}

/** The scripts setting: split on commas, trimmed, empties dropped; nothing left reads the default. */
export function parseScripts(value: unknown): string[] {
  const names = typeof value === 'string' ? value.split(',').map(name => name.trim()).filter(name => name !== '') : []
  return names.length === 0 ? [...DEFAULT_SCRIPTS] : names
}

function parsePackage(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/**
 * The package manager: the packageManager field (`pnpm@9.1.0` is pnpm), else
 * the one lockfile present, else npm. More than one lockfile with no field is
 * a conflict the mod does not guess through, since the wrong manager can stall.
 */
function pickManager(field: unknown, lockfiles: readonly string[]): { manager: string; conflict: string[] } {
  if (typeof field === 'string' && field.trim() !== '') return { manager: field.trim().split('@')[0] ?? 'npm', conflict: [] }
  const present = LOCKFILES.filter(([file]) => lockfiles.includes(file))
  if (present.length > 1) return { manager: '', conflict: present.map(([file]) => file) }
  return { manager: present[0]?.[1] ?? 'npm', conflict: [] }
}

/**
 * The rows the root package.json gives: its scripts the setting names, in the
 * setting's order, each run as `<manager> run <script>`. `packageJson` is the
 * file's text, undefined when there is none; `lockfiles` the lockfile names
 * present beside it.
 */
export function detectRows(packageJson: string | undefined, lockfiles: readonly string[], scripts: readonly string[]): Detected {
  const parsed = parsePackage(packageJson)
  const defined = parsed?.scripts
  if (parsed === undefined || typeof defined !== 'object' || defined === null) return { rows: [], conflict: [] }
  const { manager, conflict } = pickManager(parsed.packageManager, lockfiles)
  const rows = scripts
    .filter(name => typeof (defined as Record<string, unknown>)[name] === 'string')
    .map(name => ({ name, argv: [manager, 'run', name] }))
  return { rows, conflict }
}
