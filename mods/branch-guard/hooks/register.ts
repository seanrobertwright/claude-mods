import type { EngineInterface, Register } from 'claude-code'

import { branchesChanged, DEFAULT_BRANCH_REFS, defaultBranch, gitCallsIn } from './git'
import type { GitCall } from './git'

const BRANCH_FIRST = 'Branch first'
const GIT_TIMEOUT_MS = 5_000

async function isShown($: EngineInterface): Promise<boolean> {
  return (await $.session.surfaces()).length > 0
}

/** What git printed, or undefined when it failed, is missing or is not in a repository. */
async function git($: EngineInterface, call: GitCall, args: readonly string[]): Promise<string | undefined> {
  const argv = ['git', ...call.dirs.flatMap(dir => ['-C', dir]), ...args]
  const run = await $.process.run(argv, { timeoutMs: GIT_TIMEOUT_MS }).catch(() => undefined)
  return run === undefined || run.exitCode !== 0 ? undefined : run.stdout
}

/** The default branch when the call would change it; undefined when it would not, or git cannot say the branch. */
async function guardedBranch($: EngineInterface, call: GitCall): Promise<string | undefined> {
  const [current, refs] = await Promise.all([
    git($, call, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    git($, call, ['for-each-ref', '--format=%(refname) %(symref)', ...DEFAULT_BRANCH_REFS]),
  ])
  if (current === undefined || refs === undefined) return undefined
  const branch = defaultBranch(refs)
  return branchesChanged(call, current.trim()).includes(branch) ? branch : undefined
}

/** Undefined when the person lets the call go ahead on the branch, or why it is refused. */
async function ask($: EngineInterface, action: GitCall['action'], branch: string): Promise<string | undefined> {
  const goAhead = `Go ahead on ${branch}`
  const question = `Claude is about to ${action} to ${branch}, the default branch. Create a branch first?`
  const answer = await $.ui.ask(question, { header: 'Branch', options: [BRANCH_FIRST, goAhead] }).catch(() => undefined)
  if (answer === goAhead) return undefined
  // Dismissed, or answered in other words: the call does not go on.
  return `branch-guard: ${branch} is the default branch, and the person did not let this ${action} go ahead on it. Create a branch first (git switch -c <name>), then run this again.`
}

/** Undefined to let the call through, or why it is refused. */
async function guard($: EngineInterface, command: string): Promise<string | undefined> {
  const calls = gitCallsIn(command)
  if (calls.length === 0 || !(await isShown($))) return undefined
  // One answer covers the whole command, so a commit and a push in it are asked about once.
  for (const call of calls) {
    const branch = await guardedBranch($, call)
    if (branch !== undefined) return ask($, call.action, branch)
  }
  return undefined
}

export const register: Register = on => {
  // Matched by pattern: which shell tools a session has depends on the machine.
  on('tool.call', { tool: /^(Bash|PowerShell)$/ }, async ($, e, next) => {
    const command = 'command' in e && typeof e.command === 'string' ? e.command : ''
    const deny = await guard($, command)
    return deny === undefined ? next(e) : { deny }
  })
}
