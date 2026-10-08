/** How a PR's checks stand, folded from its status check rollup. */
export type Checks = 'none' | 'pending' | 'passing' | 'failing'

export type PullRequest = {
  number: number
  title: string
  author: string
  isDraft: boolean
  /** `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or '' when GitHub gives none. */
  review: string
  checks: Checks
}

/** An open issue that blocks another, as GitHub's issue dependencies record it. */
export type Blocker = {
  number: number
  title: string
}

export type Issue = {
  number: number
  title: string
  /** The issue's page on GitHub; '' when gh gives none. */
  url: string
  author: string
  labels: string[]
  /** The open issues this one is blocked by; empty when nothing open blocks it. */
  blockedBy: Blocker[]
}

export type GitHubView = {
  status: 'idle' | 'loading' | 'error' | 'unavailable'
  /** `owner/name` of the repo listed; '' before the first load. */
  repo: string
  prs: PullRequest[]
  issues: Issue[]
  /** Why the lists could not load (status `error` or `unavailable`). */
  error: string
  /** Milliseconds since the epoch of the last successful load; 0 before it. */
  updatedAt: number
  /** Bumped by each load; a load whose id is no longer current is dropped. */
  runId: number
}

declare module 'claude-code' {
  interface PluginState {
    'github-panel': {
      view: GitHubView
      /** True once this session's start-up load has run: at start, or at the first attach. */
      hasStartedUp: boolean
    }
  }
}
