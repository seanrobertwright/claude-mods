import { atom, update } from 'claude-code'
import type { EngineInterface, ProcessRunResult, Register } from 'claude-code'

import {
  decide,
  isSamePath,
  lastLine,
  missingRequirement,
  NEEDS_GH,
  NEEDS_GIT,
  NOT_A_REPO,
  parsePrs,
  parseWorktrees,
  pickPr,
  PR_FIELDS,
  question,
  summary,
} from './plan'
import type { Checkout, Facts, PullRequest, Step } from './plan'

const COMMAND = 'cleanup'
const GO = 'Go'
const CANCEL = 'Cancel'
/** A pull or a prune talks to the remote; give it longer than the 30 s default. */
const STEP_TIMEOUT_MS = 120_000
/** The start-up suggestion stays long enough to read the command in it. */
const SUGGEST_MS = 8_000

const hasChecked = atom({ plugin: 'post-merge-cleanup', key: 'hasChecked' } as const, false)

/** A requirement the mod lacks, carrying the sentence that names it. */
class Missing extends Error {}

/**
 * Whether any surface shows the session right now. Asked before the start-up
 * check, never kept. Each mod carries its own copy (ADR-0001).
 */
async function isShown($: EngineInterface): Promise<boolean> {
  return (await $.session.surfaces()).length > 0
}

/** Runs git or gh by bare name; one that cannot start is a missing requirement. */
async function run($: EngineInterface, argv: readonly string[], cwd?: string): Promise<ProcessRunResult> {
  try {
    return await $.process.run(argv, cwd === undefined ? {} : { cwd })
  } catch (error) {
    // A timeout rejects too; tell it from a missing tool by whether the tool starts at all.
    const tool = argv[0] ?? ''
    if (!(await canStart($, tool))) throw new Missing(tool === 'gh' ? NEEDS_GH : NEEDS_GIT)
    throw error
  }
}

async function canStart($: EngineInterface, tool: string): Promise<boolean> {
  try {
    await $.process.run([tool, '--version'])
    return true
  } catch {
    return false
  }
}

/** Runs a command that must succeed and answers its trimmed output. */
async function ask($: EngineInterface, argv: readonly string[], cwd?: string): Promise<string> {
  const result = await run($, argv, cwd)
  if (result.exitCode !== 0) {
    if (argv[0] === 'gh') {
      const missing = missingRequirement(result.exitCode, result.stderr)
      if (missing !== undefined) throw new Missing(missing)
    }
    throw new Error(`${argv.slice(0, 3).join(' ')} failed: ${lastLine(result.stderr) || `exit ${result.exitCode}`}`)
  }
  return result.stdout.trim()
}

async function defaultBranch($: EngineInterface): Promise<string> {
  return ask($, ['gh', 'repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'])
}

async function findPr($: EngineInterface, branch: string): Promise<PullRequest | undefined> {
  const json = await ask($, ['gh', 'pr', 'list', '--head', branch, '--state', 'all', '--limit', '10', '--json', PR_FIELDS])
  return pickPr(parsePrs(json))
}

/** The local branch's tip, or '' when there is no such branch. */
async function tipOf($: EngineInterface, branch: string): Promise<string> {
  const result = await run($, ['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  return result.exitCode === 0 ? result.stdout.trim() : ''
}

async function isClean($: EngineInterface, cwd?: string): Promise<boolean> {
  return (await ask($, ['git', 'status', '--porcelain'], cwd)) === ''
}

/** Everything decide() needs, read from git and gh; nothing here changes the checkout. */
async function gather($: EngineInterface, args: string): Promise<Facts> {
  const top = await run($, ['git', 'rev-parse', '--show-toplevel'])
  if (top.exitCode !== 0) throw new Missing(NOT_A_REPO)
  const sessionPath = top.stdout.trim()
  const currentBranch = await ask($, ['git', 'branch', '--show-current'])
  const branch = args.trim() === '' ? currentBranch : args.trim()
  const base = await defaultBranch($)
  if (branch === '' || branch === base) {
    return { branch, currentBranch, defaultBranch: base, pr: undefined, tip: '', isTreeClean: true, checkout: undefined }
  }

  const [pr, tip, isTreeClean, worktrees] = await Promise.all([
    findPr($, branch),
    tipOf($, branch),
    isClean($),
    ask($, ['git', 'worktree', 'list', '--porcelain']).then(parseWorktrees),
  ])
  const index = worktrees.findIndex(worktree => worktree.branch === branch)
  let checkout: Checkout | undefined
  if (index >= 0) {
    const path = worktrees[index]!.path
    const isSession = isSamePath(path, sessionPath)
    const isMain = index === 0
    // Only a worktree that would be removed needs its own check.
    checkout = { path, isMain, isSession, isClean: isSession || isMain ? true : await isClean($, path) }
  }
  return { branch, currentBranch, defaultBranch: base, pr, tip, isTreeClean, checkout }
}

/** Runs the steps in order, stopping at the first failure; answers what to tell the person. */
async function carryOut($: EngineInterface, branch: string, steps: readonly Step[]): Promise<string> {
  for (const step of steps) {
    let result: ProcessRunResult
    try {
      result = await $.process.run(step.argv, { timeoutMs: STEP_TIMEOUT_MS })
    } catch (error) {
      return `Cleanup stopped at "${step.todo}": ${error instanceof Error ? error.message : String(error)}`
    }
    if (result.exitCode !== 0) {
      return `Cleanup stopped at "${step.todo}": ${lastLine(result.stderr) || lastLine(result.stdout) || `exit ${result.exitCode}`}`
    }
  }
  return summary(branch, steps)
}

async function cleanup($: EngineInterface, args: string): Promise<string> {
  const facts = await gather($, args)
  const decision = decide(facts)
  if ('refuse' in decision) return decision.refuse

  let answer: string
  try {
    answer = await $.ui.ask(question(decision.pr, decision.steps), { options: [GO, CANCEL], header: 'Cleanup' })
  } catch {
    // Dismissed, or nobody to ask (a -p run).
    return 'Cleanup cancelled; nothing was changed.'
  }
  if (answer !== GO) return 'Cleanup cancelled; nothing was changed.'

  const said = await carryOut($, facts.branch, decision.steps)
  $.ui.toast(said)
  return said
}

/** The start-up check: one look at the session's branch, and a toast when its PR has merged. */
async function suggest($: EngineInterface): Promise<void> {
  const branch = await ask($, ['git', 'branch', '--show-current'])
  if (branch === '') return
  const [base, pr] = await Promise.all([defaultBranch($), findPr($, branch)])
  if (branch === base || pr?.state !== 'MERGED') return
  $.ui.toast(`PR #${pr.number} for ${branch} merged. Run /${COMMAND} to switch to ${base}, pull and delete the branch.`, {
    timeoutMs: SUGGEST_MS,
  })
}

/** Runs the start-up check once per session, and only while a surface shows it. */
async function checkOnce($: EngineInterface): Promise<void> {
  if (!(await isShown($))) return
  let isFirst = false
  await update($, hasChecked, was => {
    isFirst = !was
    return true
  })
  if (isFirst) await suggest($)
}

/** Quiet on failure: a missing gh is named when the person runs /cleanup, not at start. */
function logQuietly($: EngineInterface): (error: unknown) => void {
  return error => $.ui.log(`post-merge-cleanup: start-up check: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'After a PR merges: switch to the default branch, pull, and delete the branch and its worktree',
      argumentHint: '[branch]',
    })
    const done = await next(e)
    void checkOnce($).catch(logQuietly($))
    return done
  })

  // A session that started headless checks once when a surface first shows it.
  on('session.attach', async ($, e, next) => {
    const done = await next(e)
    void checkOnce($).catch(logQuietly($))
    return done
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    try {
      return { text: await cleanup($, e.args) }
    } catch (error) {
      return { text: error instanceof Missing ? error.message : `Cleanup failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  })
}
