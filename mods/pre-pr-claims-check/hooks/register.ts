import type { EngineInterface, Register } from 'claude-code'

import { findingsInDiff, findingsInText, refusal } from './claims'
import type { Finding } from './claims'
import { prCalls } from './command'
import type { Body, PrCall } from './command'

/** More context than any Markdown file has lines, so each changed file comes whole and fences can be followed. */
const WHOLE_FILE = 1_000_000

function logQuietly($: EngineInterface, what: string, error: unknown): void {
  $.ui.log(`pre-pr-claims-check: ${what}: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
}

/** Runs a command that must succeed and answers its output. */
async function output($: EngineInterface, argv: readonly string[]): Promise<string> {
  const result = await $.process.run(argv)
  if (result.exitCode !== 0) throw new Error(`${argv.slice(0, 3).join(' ')} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
  return result.stdout
}

async function defaultBranch($: EngineInterface): Promise<string> {
  return (await output($, ['gh', 'repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'])).trim()
}

/** The findings on the lines the branch adds to Markdown files since it left `base`. */
async function findingsOnBranch($: EngineInterface, base: string): Promise<Finding[]> {
  const diff = await output($, [
    'git',
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--no-prefix',
    '--find-renames',
    `--unified=${WHOLE_FILE}`,
    `origin/${base}...HEAD`,
    '--',
    ':(icase)*.md',
    ':(icase)*.markdown',
  ])
  return findingsInDiff(diff)
}

async function findingsInBody($: EngineInterface, body: Body | undefined): Promise<Finding[]> {
  if (body === undefined) return []
  if ('text' in body) return findingsInText(body.text, 'PR body')
  let text: string
  try {
    text = await $.fs.read(body.file)
  } catch (error) {
    // A file that cannot be read is gh's to report when the command runs.
    logQuietly($, `reading ${body.file}`, error)
    return []
  }
  return findingsInText(text, 'PR body')
}

/**
 * Every finding in the calls' titles and bodies and in the branch's added Markdown lines.
 * A git or gh call that fails leaves the branch unchecked rather than blocking the command.
 */
async function findingsFor($: EngineInterface, calls: readonly PrCall[]): Promise<Finding[]> {
  const found: Finding[] = []
  const bases = new Set<string | undefined>()
  for (const call of calls) {
    if (call.title !== undefined) found.push(...findingsInText(call.title, 'PR title'))
    found.push(...(await findingsInBody($, call.body)))
    bases.add(call.base)
  }
  for (const base of bases) {
    try {
      found.push(...(await findingsOnBranch($, base ?? (await defaultBranch($)))))
    } catch (error) {
      logQuietly($, 'checking the branch', error)
    }
  }
  return found
}

export const register: Register = on => {
  // Matched by pattern: which shell tools a session has depends on the machine.
  // It runs in a headless session too: it asks no one, and starts no prompt and no headless run.
  on('tool.call', { tool: /^(Bash|PowerShell)$/ }, async ($, e, next) => {
    const command = 'command' in e && typeof e.command === 'string' ? e.command : ''
    const calls = prCalls(command, e.tool === 'PowerShell' ? 'powershell' : 'bash')
    if (calls.length === 0) return next(e)
    const findings = await findingsFor($, calls)
    return findings.length === 0 ? next(e) : { deny: refusal(findings) }
  })
}
