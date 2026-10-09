import type { Failure, GateState } from '../types'

/** The package.json scripts run when the setting lists no checks, in this order. */
export const SCRIPT_NAMES = ['lint', 'typecheck', 'check', 'test'] as const

/** `$.process.run`'s longest time limit, and the default. */
const MAX_TIMEOUT_MINUTES = 10

/** A failing check's output is cut to its last TAIL_LINES lines, and to at most TAIL_CHARS characters of them. */
export const TAIL_LINES = 40
export const TAIL_CHARS = 4000

export type Config = {
  /** The checks the setting lists, each an argument vector; empty runs the package.json scripts. */
  argvs: string[][]
  timeoutMs: number
  /** Why the checks setting was refused; the gate then has nothing to run. */
  problem: string | undefined
}

/** One check to run: its argument vector, or why it cannot start. */
export type Check = { name: string; argv: string[] } | { name: string; problem: string }

const EXAMPLE = '[["npx","eslint","."],["pytest","-q"]]'

function isArgv(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(arg => typeof arg === 'string' && arg !== '' && !/\p{Cc}/u.test(arg))
}

/** Parses the checks setting: a JSON list of argument lists, never a shell string. */
function parseChecks(setting: unknown): { argvs: string[][] } | { problem: string } {
  if (typeof setting !== 'string' || setting.trim() === '') return { argvs: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(setting)
  } catch {
    return { problem: `lint-test-gate: the checks setting is not JSON. Write a list of commands, each a list of its arguments, such as ${EXAMPLE}.` }
  }
  if (!Array.isArray(parsed)) {
    return { problem: `lint-test-gate: the checks setting is not a list. Write a list of commands, each a list of its arguments, such as ${EXAMPLE}.` }
  }
  const bad = parsed.findIndex(argv => !isArgv(argv))
  if (bad >= 0) {
    return {
      problem: `lint-test-gate: check ${bad + 1} of the checks setting is not a list of non-empty strings. Write each command as a list of its arguments, such as ${EXAMPLE}.`,
    }
  }
  return { argvs: parsed as string[][] }
}

/** Parses the manifest's userConfig values; a time limit out of range falls back to ten minutes. */
export function parseConfig(options: Readonly<Record<string, unknown>>): Config {
  const minutes = options.timeoutMinutes
  const timeoutMinutes =
    typeof minutes === 'number' && Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_TIMEOUT_MINUTES ? minutes : MAX_TIMEOUT_MINUTES
  const checks = parseChecks(options.checks)
  return {
    argvs: 'argvs' in checks ? checks.argvs : [],
    timeoutMs: timeoutMinutes * 60_000,
    problem: 'problem' in checks ? checks.problem : undefined,
  }
}

/** The scripts of SCRIPT_NAMES that package.json defines, in that order; none for a file that is not JSON. */
export function scriptNames(packageJson: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(packageJson)
  } catch {
    return []
  }
  const scripts = typeof parsed === 'object' && parsed !== null ? (parsed as { scripts?: unknown }).scripts : undefined
  if (typeof scripts !== 'object' || scripts === null) return []
  return SCRIPT_NAMES.filter(name => typeof (scripts as Record<string, unknown>)[name] === 'string')
}

/** npm's own CLI script in a Windows Node.js install: `node_modules\npm\bin\npm-cli.js` beside node.exe. */
export function npmCliBeside(nodePath: string): string {
  const sep = nodePath.includes('\\') ? '\\' : '/'
  const folder = nodePath.replace(/[\\/][^\\/]*$/, '')
  return [folder, 'node_modules', 'npm', 'bin', 'npm-cli.js'].join(sep)
}

/**
 * Whether a shell command runs `git commit`: `git`, any global options
 * (`-C <path>`, `-c <name>=<value>`, `--flag`), then `commit` as the
 * subcommand. Found by pattern, so a `git commit` inside a quoted string counts too.
 */
export function isGitCommit(command: string): boolean {
  return /(?<![\w./\\-])git(?:\.exe)?(?:\s+(?:-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|--?[\w-]+(?:=\S+)?))*\s+commit(?![\w-])/.test(command)
}

/** Colour and cursor sequences a check may print; a prompt shows them as junk. */
// eslint-disable-next-line no-control-regex -- the escape character is what the pattern matches
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g

/** The end of a check's output: its last TAIL_LINES lines, then at most TAIL_CHARS characters, starting at a line. */
export function tail(output: string): string {
  const lines = output.replace(ANSI, '').replace(/\r\n?/g, '\n').trimEnd().split('\n')
  const kept = lines.slice(-TAIL_LINES).join('\n').replace(/^\n+/, '')
  if (kept.length <= TAIL_CHARS) return kept
  const cut = kept.slice(-TAIL_CHARS)
  const start = cut.indexOf('\n')
  return start < 0 ? cut : cut.slice(start + 1)
}

/** A time limit as a person reads it. */
export function duration(ms: number): string {
  return `${ms / 60_000} min`
}

/** The failures, each by name and why, with the end of its output: what the fill button and a refused commit hand over. */
export function failureReport(failures: readonly Failure[]): string {
  const count = failures.length === 1 ? '1 check failed' : `${failures.length} checks failed`
  const sections = failures.map(failure =>
    failure.tail === '' ? `${failure.name} (${failure.why})` : `${failure.name} (${failure.why}):\n\`\`\`\n${failure.tail}\n\`\`\``,
  )
  return [`${count}:`, ...sections].join('\n\n')
}

/** Why a model's commit is refused. */
export function refusal(failures: readonly Failure[]): string {
  return `lint-test-gate refused the commit: ${failureReport(failures)}\n\nFix the failures, then commit again.`
}

/** The gate button's label. */
export function label(state: GateState): string {
  switch (state.kind) {
    case 'idle':
      return 'gate'
    case 'running':
      return 'gate: running'
    case 'passed':
      return 'gate: passed'
    case 'failed':
      return `gate: ${state.failures.length} failing`
    case 'empty':
      return 'gate: nothing to run'
  }
}

/** What the person sees when nothing is set and package.json has none of SCRIPT_NAMES. */
export const NOTHING_TO_RUN = `lint-test-gate: nothing to run. The checks setting is empty, and package.json has no ${SCRIPT_NAMES.join(', ')} script.`

/** What a script check says when node cannot start, on Windows, where npm runs through it. */
export const NEEDS_NODE = 'lint-test-gate runs npm scripts on Windows through node, which did not start. Put node on the PATH, or list the checks in the setting.'
