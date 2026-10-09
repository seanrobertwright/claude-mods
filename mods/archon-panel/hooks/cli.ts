// Finding and calling the Archon CLI, the pane's one Requirement.

import type { Requirement } from '../types'

/** What the CLI calls need from the engine: a run that rejects when the command cannot start. */
export type Runner = (argv: readonly string[], timeoutMs?: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>

/** The oldest CLI with `workflow logs --follow`. */
const MINIMUM = [0, 11, 0] as const

export const NEEDS_CLI = 'The Archon pane needs the Archon CLI, v0.11.0 or later. Install it from https://archon.diy, or set its path in the mod settings, then press r.'

export function needsNewer(version: string): string {
  return `The Archon pane needs Archon v0.11.0 or later; this is ${version}. Update it, then press r.`
}

/** The line the pane shows for a Requirement not met; undefined when it is met or not yet checked. */
export function requirementLine(requirement: Requirement): string | undefined {
  if (requirement.state === 'missing') return NEEDS_CLI
  if (requirement.state === 'old') return needsNewer(requirement.version)
  return undefined
}

/** `v0.11.1` from what `archon --version` prints; '' when it names no version. */
export function parseVersion(output: string): string {
  const found = /v?(\d+)\.(\d+)\.(\d+)/.exec(output)
  return found === null ? '' : `v${found[1]}.${found[2]}.${found[3]}`
}

function isNewEnough(version: string): boolean {
  const parts = version.slice(1).split('.').map(Number)
  for (let i = 0; i < MINIMUM.length; i++) {
    const have = parts[i] ?? 0
    if (have !== MINIMUM[i]) return have > MINIMUM[i]!
  }
  return true
}

/**
 * Where to look for the CLI, in order: the setting, `archon` on Claude Code's
 * PATH, then `<home>/.archon/bin/archon(.exe)`. The engine expands no `~` and
 * sees no PATH set in `init.env`, so the last is an absolute path.
 */
export function candidates(setting: string, home: string, isWindows: boolean): string[] {
  if (setting !== '') return [setting]
  const found = ['archon']
  if (home !== '') found.push(`${home.replace(/[\\/]+$/, '')}/.archon/bin/archon${isWindows ? '.exe' : ''}`)
  return found
}

/** Checks the CLI: the first candidate that starts names the version; older than v0.11.0 counts as missing. */
export async function findArchon(run: Runner, places: readonly string[]): Promise<Requirement> {
  for (const path of places) {
    let output
    try {
      output = await run([path, '--version'])
    } catch {
      continue
    }
    const version = parseVersion(`${output.stdout}\n${output.stderr}`)
    if (output.exitCode !== 0 || version === '') continue
    return { state: isNewEnough(version) ? 'ok' : 'old', path, version }
  }
  return { state: 'missing', path: '', version: '' }
}
