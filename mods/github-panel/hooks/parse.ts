import type { Checks, Issue, PullRequest } from '../types'

/** The fields asked of `gh pr list` and `gh issue list`; parsePrs and parseIssues read these. */
export const PR_FIELDS = 'number,title,author,isDraft,reviewDecision,statusCheckRollup'
export const ISSUE_FIELDS = 'number,title,author,labels'

export type Config = { limit: number; refreshMs: number }

/** Parses the manifest's userConfig values; a value out of range falls back to its default. */
export function parseConfig(options: Readonly<Record<string, unknown>>): Config {
  const limit = options.limit
  const minutes = options.refreshMinutes
  return {
    limit: typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : 30,
    refreshMs:
      typeof minutes === 'number' && Number.isInteger(minutes) && minutes >= 0 && minutes <= 120
        ? minutes * 60_000
        : 5 * 60_000,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ') : ''
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

/** Reads `gh issue list --json` output; entries without a number and title are dropped. */
export function parseIssues(json: string): Issue[] {
  const rows: unknown = JSON.parse(json)
  if (!Array.isArray(rows)) throw new Error('gh issue list did not answer a list')
  return rows.filter(isRecord).flatMap(row => {
    if (!isNumber(row.number) || text(row.title) === '') return []
    const labels = Array.isArray(row.labels)
      ? row.labels.flatMap(label => (isRecord(label) && text(label.name) !== '' ? [text(label.name)] : []))
      : []
    return [{ number: row.number, title: text(row.title), author: login(row.author), labels }]
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

/** The dim line under an issue: labels, author. */
export function issueDetail(issue: Issue): string {
  return [issue.labels.join(', '), issue.author === '' ? '' : `@${issue.author}`]
    .filter(part => part !== '')
    .join(' · ')
}

/** Cuts `line` to `max` code points with an ellipsis, never splitting an emoji. */
export function fit(line: string, max: number): string {
  const chars = Array.from(line)
  return chars.length <= max ? line : `${chars.slice(0, Math.max(1, max - 1)).join('')}…`
}

export function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  return minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`
}
