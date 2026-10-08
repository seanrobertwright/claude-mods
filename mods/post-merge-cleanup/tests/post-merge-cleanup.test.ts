import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

import { decide, isSamePath, NEEDS_GH, NOT_LOGGED_IN, parsePrs, parseWorktrees, pickPr } from '../hooks/plan'
import type { Facts } from '../hooks/plan'

const HEAD = 'a1b2c3d4'
const MAIN = '/repo'
const WORKTREE = '/repo-worktrees/feat-x'

/** The repo and gh beneath the mod: what each git and gh call answers, and every call made. */
type Repo = {
  top: string
  current: string
  base: string
  prs: { number: number; state: string; headRefOid: string }[]
  /** Local branch tips by name. */
  tips: Record<string, string>
  /** `git status --porcelain` by folder; a folder left out is clean. */
  dirty: Record<string, string>
  worktrees: string
  gh: 'ok' | 'missing' | 'logged-out'
  /** A command, as joined words, that fails. */
  failing: string
  runs: { argv: string; cwd: string }[]
}

function worktreeList(...entries: [string, string][]): string {
  return entries.map(([path, branch]) => `worktree ${path}\nHEAD ${HEAD}\nbranch refs/heads/${branch}\n`).join('\n')
}

function repoOn(on: On, change: Partial<Repo> = {}): Repo {
  const repo: Repo = {
    top: MAIN,
    current: 'feat/x',
    base: 'main',
    prs: [{ number: 12, state: 'MERGED', headRefOid: HEAD }],
    tips: { 'feat/x': HEAD, main: 'f00d' },
    dirty: {},
    worktrees: worktreeList([MAIN, 'feat/x']),
    gh: 'ok',
    failing: '',
    runs: [],
    ...change,
  }
  const answer = (exitCode: number, stdout: string, stderr = '') =>
    ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', (_$, e) => {
    const argv = e.argv.join(' ')
    const cwd = e.init?.cwd ?? repo.top
    repo.runs.push({ argv, cwd })
    if (e.argv[0] === 'gh') {
      if (repo.gh === 'missing') throw new Error('spawn gh ENOENT')
      if (argv === 'gh --version') return answer(0, 'gh version 2.80.0\n')
      if (repo.gh === 'logged-out') return answer(4, '', 'To get started with GitHub CLI, please run:  gh auth login')
      if (argv.startsWith('gh repo view')) return answer(0, `${repo.base}\n`)
      if (argv.startsWith('gh pr list')) return answer(0, JSON.stringify(repo.prs))
    }
    if (repo.failing !== '' && argv.startsWith(repo.failing)) return answer(1, '', 'fatal: the remote hung up')
    if (argv === 'git rev-parse --show-toplevel') return answer(0, `${repo.top}\n`)
    if (argv === 'git branch --show-current') return answer(0, `${repo.current}\n`)
    if (argv === 'git status --porcelain') return answer(0, repo.dirty[cwd] ?? '')
    if (argv === 'git worktree list --porcelain') return answer(0, repo.worktrees)
    const tip = argv.match(/^git rev-parse --verify --quiet refs\/heads\/(.+)$/)
    if (tip) return repo.tips[tip[1]!] === undefined ? answer(1, '') : answer(0, `${repo.tips[tip[1]!]}\n`)
    return answer(0, '')
  })
  return repo
}

/** The commands that change the checkout, in the order they ran. */
function changes(repo: Repo): string[] {
  return repo.runs
    .map(run => run.argv)
    .filter(argv => /^git (switch|pull|worktree remove|branch -D|fetch)/.test(argv))
}

/** The person: answers each question in turn; none left is a dismissal. */
function personOn(on: On, answers: string[]): string[] {
  const asked: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const question = e.questions[0]?.question ?? ''
    asked.push(question)
    const answer = answers.shift()
    if (answer === undefined) return { deny: 'dismissed' }
    return { result: { questions: e.questions, answers: { [question]: answer } } }
  })
  return asked
}

function toastsOn(on: On): string[] {
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return toasts
}

function sessionOn(on: On, surfaces: RenderSurface[]): void {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.surfaces', () => ({ value: [...surfaces] }))
  on('ui.log', () => ({ value: undefined }))
}

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const

const FACTS: Facts = {
  branch: 'feat/x',
  currentBranch: 'feat/x',
  defaultBranch: 'main',
  pr: { number: 12, state: 'MERGED', headRefOid: HEAD },
  tip: HEAD,
  isTreeClean: true,
  checkout: { path: MAIN, isMain: true, isSession: true, isClean: true },
}

test('parsePrs, pickPr and parseWorktrees read gh and git output', () => {
  const prs = parsePrs(JSON.stringify([
    { number: 3, state: 'CLOSED', headRefOid: 'x' },
    { number: 4, state: 'MERGED', headRefOid: 'y' },
    { number: 'five', state: 'OPEN', headRefOid: 'z' },
  ]))
  expect(prs.map(pr => pr.number)).toEqual([3, 4])
  expect(pickPr(prs)?.number).toBe(4)
  expect(pickPr([])).toBeUndefined()
  expect(() => parsePrs('{}')).toThrow()
  expect(parseWorktrees(`${worktreeList([MAIN, 'main'], [WORKTREE, 'feat/x'])}\nworktree /tmp/d\nHEAD ${HEAD}\ndetached\n`)).toEqual([
    { path: MAIN, branch: 'main' },
    { path: WORKTREE, branch: 'feat/x' },
    { path: '/tmp/d', branch: '' },
  ])
  expect(isSamePath('D:/Repos/x/', 'd:\\repos\\x')).toBe(true)
  expect(isSamePath('/repo/X', '/repo/x')).toBe(false)
})

test('decide refuses with the check that failed, and otherwise plans the steps in order', () => {
  const refusal = (change: Partial<Facts>) => {
    const decision = decide({ ...FACTS, ...change })
    return 'refuse' in decision ? decision.refuse : ''
  }
  expect(refusal({ branch: '' })).toMatch(/Not on a branch/)
  expect(refusal({ branch: 'main' })).toMatch(/default branch/)
  expect(refusal({ pr: undefined })).toMatch(/no pull request/)
  expect(refusal({ pr: { number: 12, state: 'OPEN', headRefOid: HEAD } })).toMatch(/still open/)
  expect(refusal({ pr: { number: 12, state: 'CLOSED', headRefOid: HEAD } })).toMatch(/closed without merging/)
  expect(refusal({ tip: '' })).toMatch(/no local branch/)
  expect(refusal({ tip: 'beef' })).toMatch(/commits that are not in PR #12/)
  expect(refusal({ checkout: { path: WORKTREE, isMain: false, isSession: true, isClean: true } })).toMatch(/inside feat\/x's own worktree/)
  expect(refusal({ currentBranch: 'main', checkout: { path: MAIN, isMain: true, isSession: false, isClean: true } })).toMatch(/main checkout/)
  expect(refusal({ isTreeClean: false })).toMatch(/working tree has uncommitted/)
  expect(refusal({ checkout: { path: WORKTREE, isMain: false, isSession: false, isClean: false } })).toMatch(/worktree at .* has uncommitted/)

  const plan = decide(FACTS)
  expect('steps' in plan && plan.steps.map(step => step.argv.join(' '))).toEqual([
    'git switch main',
    'git pull --ff-only',
    'git branch -D feat/x',
    'git fetch --prune',
  ])
})

test('/cleanup on a merged branch asks once, then switches, pulls, deletes and prunes', async ($, on) => {
  sessionOn(on, ['terminal'])
  const repo = repoOn(on)
  const asked = personOn(on, ['Go'])
  const toasts = toastsOn(on)

  const result = await $.command.run({ command: 'cleanup', args: '', ...RUN })

  expect(asked).toEqual([
    'PR #12 merged. Clean up: switch to main, pull main, delete feat/x (PR #12 merged), prune remote-tracking branches?',
  ])
  // -D: a squash merge leaves the branch unmerged in git's eyes; the tip matched the PR's head.
  expect(changes(repo)).toEqual(['git switch main', 'git pull --ff-only', 'git branch -D feat/x', 'git fetch --prune'])
  expect(toasts).toEqual(['Cleaned up feat/x: switched to main, pulled main, deleted feat/x, pruned.'])
  expect(result.text).toBe(toasts[0])
})

test('Cancel or a dismissal changes nothing', async ($, on) => {
  sessionOn(on, ['terminal'])
  const repo = repoOn(on)
  const asked = personOn(on, ['Cancel'])

  expect((await $.command.run({ command: 'cleanup', args: '', ...RUN })).text).toMatch(/cancelled; nothing was changed/)
  expect((await $.command.run({ command: 'cleanup', args: '', ...RUN })).text).toMatch(/cancelled; nothing was changed/)
  expect(asked.length).toBe(2)
  expect(changes(repo)).toEqual([])
})

const REFUSALS: { name: string; change: Partial<Repo>; says: RegExp }[] = [
  { name: 'a dirty tree', change: { dirty: { [MAIN]: ' M src/app.ts\n' } }, says: /working tree has uncommitted/ },
  { name: 'a local commit not in the PR', change: { tips: { 'feat/x': 'beef' } }, says: /commits that are not in PR #12/ },
  {
    name: 'the session inside the branch\'s worktree',
    change: { top: WORKTREE, worktrees: worktreeList([MAIN, 'main'], [WORKTREE, 'feat/x']) },
    says: /Run \/cleanup feat\/x from the main checkout/,
  },
  { name: 'no PR', change: { prs: [] }, says: /no pull request/ },
  { name: 'an open PR', change: { prs: [{ number: 12, state: 'OPEN', headRefOid: HEAD }] }, says: /still open/ },
]

for (const { name, change, says } of REFUSALS) {
  test(`/cleanup refuses ${name}, naming it, and changes nothing`, async ($, on) => {
    sessionOn(on, ['terminal'])
    const repo = repoOn(on, change)
    const asked = personOn(on, ['Go'])

    expect((await $.command.run({ command: 'cleanup', args: '', ...RUN })).text).toMatch(says)
    expect(asked).toEqual([])
    expect(changes(repo)).toEqual([])
  })
}

test('/cleanup <branch> from the main checkout removes that branch\'s clean worktree and deletes it', async ($, on) => {
  sessionOn(on, ['terminal'])
  const repo = repoOn(on, { current: 'main', worktrees: worktreeList([MAIN, 'main'], [WORKTREE, 'feat/x']) })
  const asked = personOn(on, ['Go'])
  toastsOn(on)

  await $.command.run({ command: 'cleanup', args: ' feat/x ', ...RUN })

  expect(asked[0]).toMatch(/remove the worktree at \/repo-worktrees\/feat-x/)
  expect(repo.runs.some(run => run.argv === 'git status --porcelain' && run.cwd === WORKTREE)).toBe(true)
  expect(changes(repo)).toEqual(['git pull --ff-only', `git worktree remove ${WORKTREE}`, 'git branch -D feat/x', 'git fetch --prune'])
})

test('/cleanup <branch> refuses when that branch\'s worktree is dirty', async ($, on) => {
  sessionOn(on, ['terminal'])
  const repo = repoOn(on, {
    current: 'main',
    worktrees: worktreeList([MAIN, 'main'], [WORKTREE, 'feat/x']),
    dirty: { [WORKTREE]: '?? notes.txt\n' },
  })
  personOn(on, ['Go'])

  expect((await $.command.run({ command: 'cleanup', args: 'feat/x', ...RUN })).text).toMatch(/worktree at \/repo-worktrees\/feat-x has uncommitted/)
  expect(changes(repo)).toEqual([])
})

test('a failing step stops the cleanup with a toast naming it', async ($, on) => {
  sessionOn(on, ['terminal'])
  const repo = repoOn(on, { failing: 'git pull' })
  personOn(on, ['Go'])
  const toasts = toastsOn(on)

  await $.command.run({ command: 'cleanup', args: '', ...RUN })

  expect(changes(repo)).toEqual(['git switch main', 'git pull --ff-only'])
  expect(toasts).toEqual(['Cleanup stopped at "pull main": fatal: the remote hung up'])
})

test('a missing or logged-out gh is named as a requirement', async ($, on) => {
  sessionOn(on, ['terminal'])
  const repo = repoOn(on, { gh: 'missing' })
  personOn(on, [])

  expect((await $.command.run({ command: 'cleanup', args: '', ...RUN })).text).toBe(NEEDS_GH)
  repo.gh = 'logged-out'
  expect((await $.command.run({ command: 'cleanup', args: '', ...RUN })).text).toBe(NOT_LOGGED_IN)
  expect(changes(repo)).toEqual([])
})

test('at session start a merged PR\'s branch gets one toast suggesting /cleanup, even after a reload', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  sessionOn(on, ['terminal'])
  repoOn(on)
  const toasts = toastsOn(on)

  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(toasts).toEqual(['PR #12 for feat/x merged. Run /cleanup to switch to main, pull and delete the branch.'])

  // A reload runs session.start again; the suggestion is not repeated.
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(toasts.length).toBe(1)
})

test('a headless session makes no gh call at start, and checks once when a surface attaches', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const surfaces: RenderSurface[] = []
  sessionOn(on, surfaces)
  const repo = repoOn(on)
  const toasts = toastsOn(on)

  await $.session.start({ cwd: MAIN, surface: null, isInteractive: false })
  await clock.settle()
  expect(repo.runs).toEqual([])
  expect(toasts).toEqual([])

  surfaces.push('desktop')
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default', viewport: { columns: 200, rows: 50, isFullscreen: true } })
  await clock.settle()
  expect(toasts.length).toBe(1)
})

test('no toast at start when the branch\'s PR is still open', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  sessionOn(on, ['terminal'])
  repoOn(on, { prs: [{ number: 12, state: 'OPEN', headRefOid: HEAD }] })
  const toasts = toastsOn(on)

  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(toasts).toEqual([])
})
