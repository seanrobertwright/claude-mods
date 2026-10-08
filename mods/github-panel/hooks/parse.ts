import type { Blocker, Checks, Issue, PullRequest } from '../types'

/** The fields asked of `gh pr list` and `gh issue list`; parsePrs and parseIssues read these. */
export const PR_FIELDS = 'number,title,author,isDraft,reviewDecision,statusCheckRollup'
export const ISSUE_FIELDS = 'number,title,url,author,labels,blockedBy'

/** A button on each issue row that fills `<command> <issue url>` into the prompt. */
export type Fill = { key: 'implement' | 'wayfinder'; command: string; label: string }

export type Config = {
  limit: number
  refreshMs: number
  /** The fill buttons, in order; a command set empty has none. */
  fills: Fill[]
  /** One line per setting that fell back to its default, to tell the person. */
  problems: string[]
}

const FILLS = [
  { key: 'implement', setting: 'implementCommand', fallback: '/implement' },
  { key: 'wayfinder', setting: 'wayfinderCommand', fallback: '/wayfinder' },
] as const

/** A slash command: a `/` and a name, with no whitespace. */
const COMMAND = /^\/[^\s/]\S*$/

/**
 * Parses the manifest's userConfig values; a value out of range falls back to
 * its default. A fill command that is not a slash command falls back to its
 * default with a problem naming it; an empty one hides its button.
 */
export function parseConfig(options: Readonly<Record<string, unknown>>): Config {
  const limit = options.limit
  const minutes = options.refreshMinutes
  const problems: string[] = []
  const fills = FILLS.flatMap(({ key, setting, fallback }): Fill[] => {
    const value = options[setting]
    let command: string = fallback
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed === '') return []
      if (COMMAND.test(trimmed)) command = trimmed
      else problems.push(`GitHub: ${setting} "${fit(text(trimmed), 40)}" is not a slash command, such as ${fallback}; using ${fallback}.`)
    }
    return [{ key, command, label: command.slice(1) }]
  })
  return {
    limit: typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : 30,
    refreshMs:
      typeof minutes === 'number' && Number.isInteger(minutes) && minutes >= 0 && minutes <= 120
        ? minutes * 60_000
        : 5 * 60_000,
    fills,
    problems,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\p{Cc}/gu, ' ') : ''
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function login(author: unknown): string {
  return isRecord(author) ? text(author.login) : ''
}

/**
 * Folds a status check rollup to one word: any failure fails, then anything
 * still running is pending, then any success passes. Check runs report
 * `status` and `conclusion`; commit statuses report `state`.
 */
export function foldChecks(rollup: unknown): Checks {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none'
  let isPending = false
  let isPassing = false
  for (const check of rollup) {
    if (!isRecord(check)) continue
    const outcome = text(check.conclusion || check.state).toUpperCase()
    const status = text(check.status).toUpperCase()
    if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(outcome)) {
      return 'failing'
    }
    if (outcome === '' || outcome === 'PENDING' || outcome === 'EXPECTED' || (status !== '' && status !== 'COMPLETED')) {
      isPending = true
    } else if (outcome === 'SUCCESS') {
      isPassing = true
    }
  }
  if (isPending) return 'pending'
  return isPassing ? 'passing' : 'none'
}

/** Reads `gh pr list --json` output; entries without a number and title are dropped. */
export function parsePrs(json: string): PullRequest[] {
  const rows: unknown = JSON.parse(json)
  if (!Array.isArray(rows)) throw new Error('gh pr list did not answer a list')
  return rows.filter(isRecord).flatMap(row => {
    if (!isNumber(row.number) || text(row.title) === '') return []
    return [{
      number: row.number,
      title: text(row.title),
      author: login(row.author),
      isDraft: row.isDraft === true,
      review: text(row.reviewDecision),
      checks: foldChecks(row.statusCheckRollup),
    }]
  })
}

/** The open issues of a `blockedBy` connection; a closed blocker no longer blocks. */
function openBlockers(connection: unknown): Blocker[] {
  const nodes = isRecord(connection) && Array.isArray(connection.nodes) ? connection.nodes : []
  return nodes.filter(isRecord).flatMap(node =>
    isNumber(node.number) && text(node.state) === 'OPEN' ? [{ number: node.number, title: text(node.title) }] : [],
  )
}

/** Reads `gh issue list --json` output; entries without a number and title are dropped. */
export function parseIssues(json: string): Issue[] {
  const rows: unknown = JSON.parse(json)
  if (!Array.isArray(rows)) throw new Error('gh issue list did not answer a list')
  return rows.filter(isRecord).flatMap(row => {
    if (!isNumber(row.number) || text(row.title) === '') return []
    const labels = Array.isArray(row.labels)
      ? row.labels.flatMap(label => (isRecord(label) && text(label.name) !== '' ? [text(label.name)] : []))
      : []
    return [{
      number: row.number,
      title: text(row.title),
      url: text(row.url),
      author: login(row.author),
      labels,
      blockedBy: openBlockers(row.blockedBy),
    }]
  })
}

const REVIEW_WORDS: Readonly<Record<string, string>> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes requested',
  REVIEW_REQUIRED: 'review required',
}

const CHECK_WORDS: Readonly<Record<Checks, string>> = {
  none: '',
  pending: '• checks running',
  passing: '✓ checks',
  failing: '✗ checks failing',
}

/** The dim line under a PR: draft, checks, review, author. */
export function prDetail(pr: PullRequest): string {
  const review = Object.hasOwn(REVIEW_WORDS, pr.review) ? REVIEW_WORDS[pr.review] ?? '' : ''
  return [pr.isDraft ? 'draft' : '', CHECK_WORDS[pr.checks], review, pr.author === '' ? '' : `@${pr.author}`]
    .filter(part => part !== '')
    .join(' · ')
}

/** The line under an issue: what blocks it, labels, author. */
export function issueDetail(issue: Issue): string {
  const blockers = issue.blockedBy.map(blocker => `#${blocker.number}`).join(', ')
  return [blockers === '' ? '' : `blocked by ${blockers}`, issue.labels.join(', '), issue.author === '' ? '' : `@${issue.author}`]
    .filter(part => part !== '')
    .join(' · ')
}

/** Cuts `line` to `max` code points with an ellipsis, never splitting an emoji. */
export function fit(line: string, max: number): string {
  const chars = Array.from(line)
  return chars.length <= max ? line : `${chars.slice(0, Math.max(1, max - 1)).join('')}…`
}

/** The columns the fill buttons take on one line: their labels and the gaps between. */
export function fillsWidth(fills: readonly Fill[]): number {
  return fills.reduce((sum, fill) => sum + Array.from(fill.label).length, 0) + Math.max(0, fills.length - 1)
}

/**
 * The hover card's lines for an issue's blockers, each padded to `width` code
 * points so the card covers the rows it is drawn over.
 */
export function blockerLines(blockers: readonly Blocker[], width: number): string[] {
  return ['Blocked by', ...blockers.map(blocker => `#${blocker.number} ${blocker.title}`)].map(line => {
    const cut = fit(line, width)
    return cut + ' '.repeat(Math.max(0, width - Array.from(cut).length))
  })
}

export function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  return minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`
}

/** What the pane says when gh cannot be started. */
export const NEEDS_GH = 'The GitHub pane needs the GitHub CLI (gh). Install it from cli.github.com, then press r.'
/** What the pane says when gh is not logged in. */
export const NOT_LOGGED_IN = 'gh is not logged in. Run gh auth login in a terminal, then press r.'
/** What the pane says when the folder has no GitHub remote. */
export const NOT_A_GITHUB_REPO = 'This folder is not a GitHub repository. Add a GitHub remote, then press r.'

/** gh's exit code for a command that needs authentication (`gh help exit-codes`). */
const GH_AUTH_EXIT = 4

/**
 * gh's words for a login it lacks beyond exit 4: a token GitHub refuses, or
 * remotes on a GitHub host gh is not logged in to (its own advice there is
 * `gh auth login`).
 */
const NOT_LOGGED_IN_WORDS = /HTTP 401|Bad credentials|none of the git remotes configured for this repository point to a known GitHub host/i

/** gh's and git's words for a folder outside a repository, or a repository with no remote. */
const NO_GITHUB_REMOTE = /not a git repository|no git remotes found/i

/**
 * Names the requirement a failed `gh repo view` points at: a logged-out gh
 * (exit 4, or the words above) or a folder with no GitHub remote. Any other
 * failure is not a missing requirement: undefined.
 */
export function missingRequirement(exitCode: number, stderr: string): string | undefined {
  if (exitCode === GH_AUTH_EXIT || NOT_LOGGED_IN_WORDS.test(stderr)) return NOT_LOGGED_IN
  if (NO_GITHUB_REMOTE.test(stderr)) return NOT_A_GITHUB_REPO
  return undefined
}
