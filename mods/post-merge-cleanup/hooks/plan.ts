/** The fields asked of `gh pr list`; parsePrs reads these. */
export const PR_FIELDS = 'number,state,headRefOid'

export type PullRequest = {
  number: number
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  /** The commit the PR's head pointed at: for a merged PR, the commit it merged. */
  headRefOid: string
}

/** One entry of `git worktree list --porcelain`; `branch` is '' for a detached head. */
export type Worktree = { path: string; branch: string }

/** Where the branch to clean up is checked out, if anywhere. */
export type Checkout = {
  path: string
  /** The main checkout: the first worktree git lists. It is never removed. */
  isMain: boolean
  /** The checkout this session runs in. */
  isSession: boolean
  /** Nothing staged, unstaged or untracked; only asked of a worktree that would be removed. */
  isClean: boolean
}

/** What the mod found before deciding: every answer is git's or gh's. */
export type Facts = {
  /** The branch to clean up: the argument, or the session's branch. */
  branch: string
  /** The session's branch; '' for a detached head. */
  currentBranch: string
  defaultBranch: string
  pr: PullRequest | undefined
  /** The local branch's tip; '' when there is no such local branch. */
  tip: string
  /** The session's tree has nothing staged, unstaged or untracked. */
  isTreeClean: boolean
  checkout: Checkout | undefined
}

/** One git command of the cleanup, run in the session's folder. */
export type Step = {
  /** What it will do, for the question. */
  todo: string
  /** What it did, for the closing toast. */
  done: string
  argv: string[]
}

export type Decision = { refuse: string } | { pr: number; steps: Step[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parses `gh pr list --json PR_FIELDS`, dropping malformed rows; throws on output that is not a list. */
export function parsePrs(json: string): PullRequest[] {
  const rows: unknown = JSON.parse(json)
  if (!Array.isArray(rows)) throw new Error('gh pr list did not answer a list')
  return rows.flatMap((row): PullRequest[] => {
    if (!isRecord(row)) return []
    const { number, state, headRefOid } = row
    if (typeof number !== 'number' || typeof headRefOid !== 'string') return []
    if (state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED') return []
    return [{ number, state, headRefOid }]
  })
}

/** The PR that speaks for a branch: a merged one first, then an open one, then any. gh lists the newest first. */
export function pickPr(prs: readonly PullRequest[]): PullRequest | undefined {
  return prs.find(pr => pr.state === 'MERGED') ?? prs.find(pr => pr.state === 'OPEN') ?? prs[0]
}

/** Parses `git worktree list --porcelain`: blocks of `worktree <path>`, then `branch refs/heads/<name>` or `detached`. */
export function parseWorktrees(porcelain: string): Worktree[] {
  const worktrees: Worktree[] = []
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) worktrees.push({ path: line.slice('worktree '.length), branch: '' })
    const last = worktrees[worktrees.length - 1]
    if (line.startsWith('branch refs/heads/') && last !== undefined) last.branch = line.slice('branch refs/heads/'.length)
  }
  return worktrees
}

/** Whether two paths git printed name the same folder: slashes folded, and case too for a Windows drive path. */
export function isSamePath(a: string, b: string): boolean {
  const fold = (path: string) => {
    const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '')
    return /^[a-z]:\//i.test(slashed) ? slashed.toLowerCase() : slashed
  }
  return fold(a) === fold(b)
}

/**
 * Decides from the facts: a refusal naming the first check that failed, or the
 * steps to run. Nothing here changes the checkout; the steps run only after the
 * person says Go.
 */
export function decide(facts: Facts): Decision {
  const { branch, currentBranch, defaultBranch, pr, tip, checkout } = facts
  if (branch === '') return { refuse: 'Not on a branch. Run /cleanup <branch> to name the branch to clean up.' }
  if (branch === defaultBranch) return { refuse: `${branch} is the default branch; there is nothing to clean up.` }
  if (pr === undefined) return { refuse: `${branch} has no pull request, so nothing was changed.` }
  if (pr.state === 'OPEN') return { refuse: `PR #${pr.number} for ${branch} is still open, so nothing was changed.` }
  if (pr.state === 'CLOSED') {
    return { refuse: `PR #${pr.number} for ${branch} was closed without merging, so nothing was changed.` }
  }
  if (tip === '') return { refuse: `There is no local branch ${branch}, so there is nothing to delete.` }
  if (tip !== pr.headRefOid) {
    return {
      refuse: `${branch} has commits that are not in PR #${pr.number}: its tip is not the commit the PR merged. Push or drop them first.`,
    }
  }
  if (checkout?.isSession === true && !checkout.isMain) {
    return {
      refuse: `This session runs inside ${branch}'s own worktree. Run /cleanup ${branch} from the main checkout.`,
    }
  }
  if (checkout?.isMain === true && !checkout.isSession) {
    return { refuse: `${branch} is checked out in the main checkout at ${checkout.path}. Run /cleanup there.` }
  }
  if (!facts.isTreeClean) {
    return { refuse: 'The working tree has uncommitted or untracked changes. Commit, stash or remove them first.' }
  }
  if (checkout !== undefined && !checkout.isSession && !checkout.isClean) {
    return {
      refuse: `The worktree at ${checkout.path} has uncommitted or untracked changes. Commit, stash or remove them first.`,
    }
  }

  const steps: Step[] = []
  if (currentBranch !== defaultBranch) {
    steps.push({ todo: `switch to ${defaultBranch}`, done: `switched to ${defaultBranch}`, argv: ['git', 'switch', defaultBranch] })
  }
  steps.push({ todo: `pull ${defaultBranch}`, done: `pulled ${defaultBranch}`, argv: ['git', 'pull', '--ff-only'] })
  if (checkout !== undefined && !checkout.isSession) {
    steps.push({
      todo: `remove the worktree at ${checkout.path}`,
      done: `removed the worktree at ${checkout.path}`,
      argv: ['git', 'worktree', 'remove', checkout.path],
    })
  }
  // -D, not -d: a squash merge leaves the branch unmerged in git's eyes. The tip check above is what makes it safe.
  steps.push({
    todo: `delete ${branch} (PR #${pr.number} merged)`,
    done: `deleted ${branch}`,
    argv: ['git', 'branch', '-D', branch],
  })
  steps.push({ todo: 'prune remote-tracking branches', done: 'pruned', argv: ['git', 'fetch', '--prune'] })
  return { pr: pr.number, steps }
}

/** The one question asked before anything changes. */
export function question(pr: number, steps: readonly Step[]): string {
  return `PR #${pr} merged. Clean up: ${steps.map(step => step.todo).join(', ')}?`
}

/** What the closing toast says. */
export function summary(branch: string, steps: readonly Step[]): string {
  return `Cleaned up ${branch}: ${steps.map(step => step.done).join(', ')}.`
}

/** What the person sees when gh cannot start. */
export const NEEDS_GH = 'post-merge-cleanup needs the GitHub CLI (gh). Install it from cli.github.com, then run /cleanup again.'
/** What the person sees when git cannot start. */
export const NEEDS_GIT = 'post-merge-cleanup needs git. Install it from git-scm.com, then run /cleanup again.'
/** What the person sees when gh is not logged in. */
export const NOT_LOGGED_IN = 'gh is not logged in. Run gh auth login in a terminal, then run /cleanup again.'
/** What the person sees outside a git repository. */
export const NOT_A_REPO = 'This folder is not a git repository, so there is nothing to clean up.'
/** What the person sees when the repository has no GitHub remote. */
export const NOT_A_GITHUB_REPO = 'This repository has no GitHub remote, so gh cannot tell whether a PR merged.'

/** gh's exit code for a command that needs authentication (`gh help exit-codes`). */
const GH_AUTH_EXIT = 4

/** The requirement a failed gh call names, or undefined when the failure is something else. */
export function missingRequirement(exitCode: number, stderr: string): string | undefined {
  if (exitCode === GH_AUTH_EXIT || /gh auth login|not logged in/i.test(stderr)) return NOT_LOGGED_IN
  if (/no git remotes|none of the git remotes|not a git repository/i.test(stderr)) return NOT_A_GITHUB_REPO
  return undefined
}

/** The last non-empty line of a command's output, cut short, for a toast. */
export function lastLine(output: string): string {
  const lines = output.trim().split(/\r?\n/)
  return lines[lines.length - 1]?.slice(0, 200) ?? ''
}
