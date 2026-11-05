import type { EngineInterface, Register } from 'claude-code'

import { findingsInDiff, findingsInText, refusal, vendoredFolders } from './claims'
import type { Finding } from './claims'
import { isAbsolute, isSameRepo, nativeDir, prCalls } from './command'
import type { Body, PrCall } from './command'

/** More context than any Markdown file has lines, so each changed file comes whole and fences can be followed. */
const WHOLE_FILE = 1_000_000

function logQuietly($: EngineInterface, what: string, error: unknown): void {
  $.ui.log(`pre-pr-claims-check: ${what}: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
}

/** Runs a command that must succeed, in `dir` or else the session's folder, and answers its output. */
async function output($: EngineInterface, argv: readonly string[], dir: string | undefined): Promise<string> {
  const result = await $.process.run(argv, dir === undefined ? undefined : { cwd: dir })
  if (result.exitCode !== 0) throw new Error(`${argv.slice(0, 3).join(' ')} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
  return result.stdout
}

async function defaultBranch($: EngineInterface, dir: string | undefined): Promise<string> {
  return (await output($, ['gh', 'repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], dir)).trim()
}

/** The repo `dir` is a checkout of, as `owner/name`. */
async function localRepo($: EngineInterface, dir: string | undefined): Promise<string> {
  return (await output($, ['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], dir)).trim()
}

/** The folders exempt from the branch check. A list git cannot give exempts nothing, so every file is still checked. */
async function exemptFolders($: EngineInterface, dir: string | undefined): Promise<string[]> {
  try {
    return vendoredFolders((await output($, ['git', 'ls-files', '-z', '--', ':(glob)**/.vendor.json'], dir)).split('\0'))
  } catch (error) {
    logQuietly($, 'listing vendored folders', error)
    return []
  }
}

/** The findings on the lines the branch adds to Markdown files since it left `base`, outside vendored folders. */
async function findingsOnBranch($: EngineInterface, base: string, dir: string | undefined): Promise<Finding[]> {
  const diff = await output(
    $,
    [
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
    ],
    dir,
  )
  return findingsInDiff(diff, await exemptFolders($, dir))
}

async function findingsInBody($: EngineInterface, body: Body | undefined, dir: string | undefined): Promise<Finding[]> {
  if (body === undefined) return []
  if ('text' in body) return findingsInText(body.text, 'PR body')
  let text: string
  try {
    text = await $.fs.read(dir === undefined || isAbsolute(body.file) ? body.file : `${dir}/${body.file}`)
  } catch (error) {
    // A file that cannot be read is gh's to report when the command runs.
    logQuietly($, `reading ${body.file}`, error)
    return []
  }
  return findingsInText(text, 'PR body')
}

/**
 * Every finding in the calls' titles and bodies and in the branch's added Markdown lines.
 * The branch is the one in the folder the call runs in. It goes unchecked, rather than blocking the command,
 * when git or gh fails, when a `cd` went somewhere unknown, or when `-R` names a repo other than that folder's.
 */
async function findingsFor($: EngineInterface, calls: readonly PrCall[]): Promise<Finding[]> {
  const found: Finding[] = []
  const checked = new Set<string>()
  for (const call of calls) {
    const dir = call.dir === undefined ? undefined : nativeDir(call.dir, await $.session.cwd())
    if (call.title !== undefined) found.push(...findingsInText(call.title, 'PR title'))
    found.push(...(await findingsInBody($, call.body, dir)))
    const branch = JSON.stringify([dir, call.base, call.repo])
    if (call.isDirUnknown === true || checked.has(branch)) continue
    checked.add(branch)
    try {
      if (call.repo !== undefined && !isSameRepo(call.repo, await localRepo($, dir))) continue
      found.push(...(await findingsOnBranch($, call.base ?? (await defaultBranch($, dir)), dir)))
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
