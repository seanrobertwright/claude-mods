import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  blockerLines,
  fillsWidth,
  fit,
  fixPrompt,
  foldChecks,
  issueDetail,
  LOG_LINES,
  logTail,
  missingRequirement,
  parseConfig,
  parseIssues,
  parsePrs,
  prDetail,
  watchChecks,
} from '../hooks/parse'

const PRS = JSON.stringify([
  {
    number: 12,
    title: 'Add the GitHub tab',
    author: { login: 'octocat' },
    isDraft: false,
    reviewDecision: 'REVIEW_REQUIRED',
    statusCheckRollup: [
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'StatusContext', state: 'SUCCESS' },
    ],
  },
  { number: 13, title: 'Draft idea', author: { login: 'hubot' }, isDraft: true, reviewDecision: '', statusCheckRollup: [] },
])

const ISSUES = JSON.stringify([
  { number: 7, title: 'Sidebar flickers', url: 'https://github.com/octo/widgets/issues/7', author: { login: 'octocat' }, labels: [{ name: 'bug' }, { name: 'needs-triage' }] },
  {
    number: 9,
    title: 'Ship the pane',
    url: 'https://github.com/octo/widgets/issues/9',
    author: { login: 'hubot' },
    labels: [],
    blockedBy: {
      nodes: [
        { number: 7, state: 'OPEN', title: 'Sidebar flickers' },
        { number: 3, state: 'CLOSED', title: 'Done already' },
      ],
      totalCount: 2,
    },
  },
  { title: 'no number, dropped' },
])

const PANE = {
  title: 'GitHub',
  isFocused: false,
  bodyColumns: 50,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

/** mod-settings' command as the session's command list shows it. */
const MOD_SETTINGS = { name: 'mod-settings', description: 'Open the mod settings dialog', source: 'plugin' } as const

function ok(stdout: string) {
  return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
}

/** gh beneath the mod: answers the repo, PR and issue lists, and records every argv. */
function fakeGh(on: On, runs: (readonly string[])[], isRepo = true): void {
  on('process.run', (_$, e) => {
    runs.push(e.argv)
    const [, noun, verb] = e.argv
    if (noun === 'repo') {
      return isRepo
        ? ok('octo/widgets\n')
        : { value: { exitCode: 1, stdout: '', stderr: 'no git remotes found', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (verb === 'list' && !e.argv.includes('--web')) return ok(noun === 'pr' ? PRS : ISSUES)
    return ok('')
  })
}

test('foldChecks: any failure fails, then running is pending, then success passes', () => {
  expect(foldChecks([])).toBe('none')
  expect(foldChecks([{ status: 'COMPLETED', conclusion: 'SUCCESS' }])).toBe('passing')
  expect(foldChecks([{ status: 'IN_PROGRESS', conclusion: '' }, { state: 'SUCCESS' }])).toBe('pending')
  expect(foldChecks([{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }])).toBe('failing')
  expect(foldChecks([{ state: 'ERROR' }])).toBe('failing')
  expect(foldChecks('nonsense')).toBe('none')
})

test('parsePrs and parseIssues read gh JSON and drop malformed rows', () => {
  const prs = parsePrs(PRS)
  expect(prs.map(pr => pr.number)).toEqual([12, 13])
  expect(prDetail(prs[0]!)).toBe('✓ checks · review required · @octocat')
  expect(prDetail(prs[1]!)).toBe('draft · @hubot')
  const issues = parseIssues(ISSUES)
  expect(issues).toEqual([
    { number: 7, title: 'Sidebar flickers', url: 'https://github.com/octo/widgets/issues/7', author: 'octocat', labels: ['bug', 'needs-triage'], blockedBy: [] },
    { number: 9, title: 'Ship the pane', url: 'https://github.com/octo/widgets/issues/9', author: 'hubot', labels: [], blockedBy: [{ number: 7, title: 'Sidebar flickers' }] },
  ])
  expect(issueDetail(issues[0]!)).toBe('bug, needs-triage · @octocat')
  expect(issueDetail(issues[1]!)).toBe('blocked by #7 · @hubot')
  expect(() => parsePrs('{}')).toThrow()
})

test('parseConfig and fit hold their bounds', () => {
  expect(parseConfig({ limit: 0, refreshMinutes: -1 })).toMatchObject({ limit: 30, refreshMs: 300_000 })
  expect(parseConfig({ limit: 100, refreshMinutes: 0 })).toMatchObject({ limit: 100, refreshMs: 0 })
  expect(fit('#1 a long title', 8)).toBe('#1 a lo…')
  expect(fit('short', 8)).toBe('short')
  expect(blockerLines([{ number: 7, title: 'Sidebar flickers' }], 12)).toEqual(['Blocked by  ', '#7 Sidebar …'])
})

test('parseConfig reads the fill commands: a default, a custom one, an empty one hidden, an invalid one replaced', () => {
  expect(parseConfig({})).toMatchObject({
    fills: [
      { key: 'implement', command: '/implement', label: 'implement' },
      { key: 'wayfinder', command: '/wayfinder', label: 'wayfinder' },
    ],
    problems: [],
  })
  expect(parseConfig({ implementCommand: ' /build ', wayfinderCommand: '' })).toMatchObject({
    fills: [{ key: 'implement', command: '/build', label: 'build' }],
    problems: [],
  })
  const invalid = parseConfig({ implementCommand: 'implement', wayfinderCommand: '/way finder' })
  expect(invalid.fills.map(fill => fill.command)).toEqual(['/implement', '/wayfinder'])
  expect(invalid.problems).toEqual([
    'GitHub: implementCommand "implement" is not a slash command, such as /implement; using /implement.',
    'GitHub: wayfinderCommand "/way finder" is not a slash command, such as /wayfinder; using /wayfinder.',
  ])
  expect(parseConfig({ implementCommand: '/' }).problems).toHaveLength(1)
  expect(fillsWidth(parseConfig({}).fills)).toBe('implement wayfinder'.length)
  expect(fillsWidth([])).toBe(0)
})

test('the pane lists open PRs and issues and opens a click on GitHub', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('ui.toast', () => ({ value: undefined }))
  const runs: (readonly string[])[] = []
  fakeGh(on, runs)

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'github-panel', surface, component: 'Pane', requestId: 'github', props: PANE })
    await pane.press({ key: 'refresh' })
    expect(await pane.find({ type: 'Text', text: 'octo/widgets' })).toBeDefined()
    expect((await pane.find({ key: 'pr-12' }))?.text).toContain('Add the GitHub tab')
    expect((await pane.find({ key: 'issue-7' }))?.text).toContain('Sidebar flickers')
    expect((await pane.find({ type: 'Text', text: /bug, needs-triage/ }))?.props.color).toBeUndefined()
    expect((await pane.find({ type: 'Text', text: /blocked by #7/ }))?.props.color).toBe('red')
    expect(await pane.find({ type: 'Text', text: /#7 Sidebar flickers/ })).toBeDefined()

    await pane.press({ key: 'pr-12' })
    expect(runs[runs.length - 1]).toEqual(['gh', 'pr', 'view', '12', '--web'])
    await pane.press({ key: 'issue-7' })
    expect(runs[runs.length - 1]).toEqual(['gh', 'issue', 'view', '7', '--web'])
    await pane.press({ key: 'all-issues' })
    expect(runs[runs.length - 1]).toEqual(['gh', 'issue', 'list', '--web'])
    await pane.unmount()
  }
})

test('outside a GitHub repo the pane says why and lists nothing', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const runs: (readonly string[])[] = []
  fakeGh(on, runs, false)

  const pane = await $.ui.mount({ plugin: 'github-panel', surface: 'terminal', component: 'Pane', requestId: 'github', props: PANE })
  await pane.press({ key: 'refresh' })
  expect(await pane.find({ type: 'Text', text: /^This folder is not a GitHub repository\./ })).toBeDefined()
  expect(await pane.find({ key: 'pr-12' })).toBeUndefined()
  expect(runs.some(argv => argv.includes('list'))).toBe(false)
  await pane.unmount()
})

const DESKTOP = { surface: 'desktop', clientId: 'desktop:default', viewport: { columns: 200, rows: 50, isFullscreen: true } } as const
const PHONE = { surface: 'mobile', clientId: 'mobile:default', viewport: { columns: 40, rows: 60, isFullscreen: false } } as const
const FIVE_MINUTES = 300_000

/**
 * The engine beneath the mod: the surfaces showing the session (the test edits
 * the list) and every pane opened, by id, with `+focus` when the open asked
 * for the keyboard (and so to be brought to the front).
 */
function fakeSession(on: On, surfaces: string[], opened: string[]): void {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  on('session.detach', (_$, e) => ({ clientId: e.clientId }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.surfaces', () => ({ value: [...surfaces] as never }))
  on('ui.open', (_$, e) => {
    opened.push(e.focus === true ? `${e.id}+focus` : e.id)
    return { value: { isPlaced: true } }
  })
}

const isLoad = (argv: readonly string[]) => argv[1] === 'repo' && argv[2] === 'view'

test('a headless session runs no gh, starts no polling, opens no pane and toasts nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const runs: (readonly string[])[] = []
  const opened: string[] = []
  fakeGh(on, runs)
  fakeSession(on, [], opened)

  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await clock.advance(3 * FIVE_MINUTES)
  expect(runs).toEqual([])
  expect(opened).toEqual([])
  expect(toasts).toEqual([])
})

test('the first attach to a headless session loads once and opens the pane where it docks', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const runs: (readonly string[])[] = []
  const opened: string[] = []
  const surfaces: string[] = []
  fakeGh(on, runs)
  fakeSession(on, surfaces, opened)

  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await clock.settle()
  expect(runs).toEqual([])
  expect(opened).toEqual([])
  surfaces.push('desktop')
  await $.session.attach(DESKTOP)
  await clock.settle()
  expect(runs.filter(isLoad).length).toBe(1)
  expect(opened).toEqual(['github'])

  surfaces.push('mobile')
  await $.session.attach(PHONE)
  await clock.settle()
  expect(runs.filter(isLoad).length).toBe(1)
  expect(opened).toEqual(['github'])
})

test('a phone attaching first loads the lists but waits for /github to open the pane', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const runs: (readonly string[])[] = []
  const opened: string[] = []
  const surfaces: string[] = []
  fakeGh(on, runs)
  fakeSession(on, surfaces, opened)

  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  surfaces.push('mobile')
  await $.session.attach(PHONE)
  await clock.settle()
  expect(runs.filter(isLoad).length).toBe(1)
  expect(opened).toEqual([])

  await $.command.run({ command: 'github', args: '', origin: { kind: 'bridge' }, presentation: { isFullscreen: false, columns: 40 } })
  expect(opened).toEqual(['github+focus'])
})

test('/github asks focus, to bring GitHub in front of another pane, while the open at start asks none', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const runs: (readonly string[])[] = []
  const opened: string[] = []
  fakeGh(on, runs)
  fakeSession(on, ['terminal'], opened)

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(opened).toEqual(['github'])

  // Another mod's pane opened after GitHub's is in front; the command brings GitHub back.
  await $.command.run({ command: 'github', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(opened).toEqual(['github', 'github+focus'])
})

test('polling stops when the last surface detaches and picks up on the next attach', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const runs: (readonly string[])[] = []
  const opened: string[] = []
  const surfaces: string[] = ['terminal']
  fakeGh(on, runs)
  fakeSession(on, surfaces, opened)

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await clock.advance(FIVE_MINUTES)
  expect(runs.filter(isLoad).length).toBe(2)

  surfaces.length = 0
  await $.session.detach({ ...PHONE, reason: 'detach' })
  const before = runs.length
  await clock.advance(3 * FIVE_MINUTES)
  expect(runs.length).toBe(before)

  surfaces.push('mobile')
  await $.session.attach(PHONE)
  await clock.settle()
  expect(runs.length).toBe(before)
  await clock.advance(FIVE_MINUTES)
  expect(runs.filter(isLoad).length).toBe(3)
})

test('an attach while a detach is still checking the surfaces keeps polling going', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const runs: (readonly string[])[] = []
  fakeGh(on, runs)
  const surfaces: string[] = ['terminal']
  // The surfaces answer can be held, to put an attach between a detach's question and its answer.
  let hold: Promise<void> | undefined
  let reached: (() => void) | undefined
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  on('session.detach', (_$, e) => ({ clientId: e.clientId }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.surfaces', async () => {
    const answer = [...surfaces]
    reached?.()
    if (hold !== undefined) await hold
    return { value: answer as never }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()

  // The last surface leaves; the detach asks the surfaces and is told none, but the answer is held.
  surfaces.length = 0
  let release: () => void = () => {}
  hold = new Promise(resolve => (release = resolve))
  const asked = new Promise<void>(resolve => (reached = resolve))
  const detaching = $.session.detach({ ...PHONE, reason: 'detach' })
  await asked
  reached = undefined
  hold = undefined

  // A phone attaches before that answer lands; then the stale answer arrives.
  surfaces.push('mobile')
  await $.session.attach(PHONE)
  release()
  await detaching

  const before = runs.filter(isLoad).length
  await clock.advance(FIVE_MINUTES)
  expect(runs.filter(isLoad).length).toBe(before + 1)
})

test('missingRequirement names a logged-out gh and a folder with no GitHub remote', () => {
  expect(missingRequirement(4, 'To get started with GitHub CLI, please run:  gh auth login')).toMatch(/gh auth login/)
  expect(missingRequirement(1, 'HTTP 401: Bad credentials (https://api.github.com/graphql)')).toMatch(/gh auth login/)
  expect(missingRequirement(1, 'none of the git remotes configured for this repository point to a known GitHub host'))
    .toMatch(/gh auth login/)
  expect(missingRequirement(1, 'failed to run git: fatal: not a git repository (or any of the parent directories): .git'))
    .toMatch(/^This folder is not a GitHub repository\..*press r/)
  expect(missingRequirement(1, 'no git remotes found')).toMatch(/^This folder is not a GitHub repository\./)
  expect(missingRequirement(1, 'HTTP 502: Bad Gateway')).toBeUndefined()
})

type GhState = 'missing' | 'logged-out' | 'no-repo' | 'ok'

/** gh beneath the mod in a given state, which the test can change; records every argv that ran. */
function fakeGhIn(on: On, state: { gh: GhState }, runs: (readonly string[])[]): void {
  on('process.run', (_$, e) => {
    runs.push(e.argv)
    if (state.gh === 'missing') throw new Error('spawn gh ENOENT')
    const fail = (exitCode: number, stderr: string) =>
      ({ value: { exitCode, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    const [, noun, verb] = e.argv
    if (noun === '--version') return ok('gh version 2.80.0\n')
    if (state.gh === 'logged-out') return fail(4, 'To get started with GitHub CLI, please run:  gh auth login')
    if (noun === 'repo') {
      return state.gh === 'no-repo'
        ? fail(1, 'failed to run git: fatal: not a git repository (or any of the parent directories): .git')
        : ok('octo/widgets\n')
    }
    if (verb === 'list') return ok(noun === 'pr' ? PRS : ISSUES)
    return ok('')
  })
}

const REQUIREMENTS = [
  { gh: 'missing', says: /needs the GitHub CLI.*press r/ },
  { gh: 'logged-out', says: /gh auth login.*press r/ },
  { gh: 'no-repo', says: /^This folder is not a GitHub repository\..*press r/ },
] as const

for (const { gh, says } of REQUIREMENTS) {
  test(`a ${gh} requirement is named in the pane, which does not open unasked`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const toasts: string[] = []
    on('ui.toast', (_$, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    const opened: string[] = []
    const runs: (readonly string[])[] = []
    fakeGhIn(on, { gh }, runs)
    fakeSession(on, ['terminal'], opened)

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await clock.settle()
    const pane = await $.ui.mount({ plugin: 'github-panel', surface: 'terminal', component: 'Pane', requestId: 'github', props: PANE })
    expect(await pane.find({ type: 'Text', text: says })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /fatal|ENOENT|To get started/ })).toBeUndefined()
    expect(opened).toEqual([])
    expect(toasts).toEqual([])
    expect(runs.some(argv => argv.includes('list'))).toBe(false)
    expect(await pane.find({ key: 'all-prs' })).toBeUndefined()

    await $.command.run({ command: 'github', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
    expect(opened).toEqual(['github+focus'])
    await pane.unmount()
  })
}

for (const { gh, says } of REQUIREMENTS) {
  test(`once a ${gh} requirement is met, pressing r loads the lists`, async ($, on) => {
    mock.clock(on, { now: 1_000 })
    on('ui.toast', () => ({ value: undefined }))
    const state: { gh: GhState } = { gh }
    const runs: (readonly string[])[] = []
    fakeGhIn(on, state, runs)

    const pane = await $.ui.mount({ plugin: 'github-panel', surface: 'terminal', component: 'Pane', requestId: 'github', props: PANE })
    await pane.press({ key: 'refresh' })
    expect(await pane.find({ type: 'Text', text: says })).toBeDefined()

    state.gh = 'ok'
    await pane.press({ key: 'refresh' })
    expect(await pane.find({ type: 'Text', text: says })).toBeUndefined()
    expect((await pane.find({ key: 'pr-12' }))?.text).toContain('Add the GitHub tab')
    await pane.unmount()
  })
}

test('a gh failure that is not a missing requirement shows as an error and the pane opens at start', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  on('ui.toast', () => ({ value: undefined }))
  const opened: string[] = []
  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: 'error connecting to api.github.com', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  fakeSession(on, ['terminal'], opened)

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(opened).toEqual(['github'])
  const pane = await $.ui.mount({ plugin: 'github-panel', surface: 'terminal', component: 'Pane', requestId: 'github', props: PANE })
  expect(await pane.find({ type: 'Text', text: 'error connecting to api.github.com' })).toBeDefined()
  await pane.unmount()
})

test('polling runs no gh while a requirement is missing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  on('ui.toast', () => ({ value: undefined }))
  const runs: (readonly string[])[] = []
  fakeGhIn(on, { gh: 'logged-out' }, runs)
  fakeSession(on, ['terminal'], [])

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const before = runs.length
  await clock.advance(3 * FIVE_MINUTES)
  expect(runs.length).toBe(before)
})

test('the header draws the settings gear only while mod-settings is installed, and the gear runs /mod-settings', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('ui.toast', () => ({ value: undefined }))
  fakeGh(on, [])
  let commands: (typeof MOD_SETTINGS)[] = [MOD_SETTINGS]
  on('command.list', () => ({ value: commands }))
  const ran: string[] = []
  on('command.run', { command: 'mod-settings' }, (_$, e) => {
    ran.push(e.command)
    return { text: 'Mod settings opened.' }
  })

  const pane = await $.ui.mount({ plugin: 'github-panel', surface: 'terminal', component: 'Pane', requestId: 'github', props: PANE })
  expect((await pane.find({ key: 'mod-settings' }))?.props.label).toBe('⚙️')
  await pane.press({ key: 'mod-settings' })
  expect(ran).toEqual(['mod-settings'])

  commands = []
  await pane.redraw()
  expect(await pane.find({ key: 'mod-settings' })).toBeUndefined()
  await pane.unmount()
})

const RUNNING = [{ __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: '' }]
const PASSING = [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }]
const FAILING = [
  {
    __typename: 'CheckRun',
    name: 'test',
    status: 'COMPLETED',
    conclusion: 'FAILURE',
    detailsUrl: 'https://github.com/octo/widgets/actions/runs/4242/job/77',
  },
  { __typename: 'StatusContext', context: 'lint', state: 'FAILURE', targetUrl: 'https://ci.example/9' },
  { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
]

type Ci = {
  /** What `git branch --show-current` answers. */
  branch: string
  /** Each open PR's head branch and status check rollup. */
  prs: { number: number; branch: string; rollup: unknown[] }[]
  /** What `gh run view --log-failed` answers. */
  log: { exitCode: number; stdout: string }
}

/** gh and git beneath the mod, answering from `ci`, which the test changes between loads; records every argv. */
function fakeCi(on: On, ci: Ci, runs: (readonly string[])[]): void {
  on('process.run', (_$, e) => {
    runs.push(e.argv)
    if (e.argv[0] === 'git') return ok(`${ci.branch}\n`)
    const [, noun, verb] = e.argv
    if (noun === 'repo') return ok('octo/widgets\n')
    if (noun === 'pr' && verb === 'list') {
      return ok(JSON.stringify(ci.prs.map(pr => ({
        number: pr.number,
        title: `PR ${pr.number}`,
        author: { login: 'octocat' },
        isDraft: false,
        reviewDecision: '',
        headRefName: pr.branch,
        statusCheckRollup: pr.rollup,
      }))))
    }
    if (noun === 'issue') return ok('[]')
    if (noun === 'run') {
      return { value: { exitCode: ci.log.exitCode, stdout: ci.log.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return ok('')
  })
}

function onePr(number: number, branch: string, rollup: unknown[]) {
  return parsePrs(JSON.stringify([{ number, title: 'a PR', headRefName: branch, statusCheckRollup: rollup }]))[0]!
}

test('parsePrs reads the head branch and the failed checks, with the Actions run of each check run', () => {
  const failing = onePr(12, 'feat/x', FAILING)
  expect(failing.branch).toBe('feat/x')
  expect(failing.checks).toBe('failing')
  expect(failing.failed).toEqual([{ name: 'test', runId: '4242' }, { name: 'lint', runId: '' }])
  expect(onePr(12, 'feat/x', PASSING).failed).toEqual([])
})

test('watchChecks toasts a turn of the same PR to passing or failing, and only sets the start otherwise', () => {
  const prsWith = (rollup: unknown[]) => [onePr(12, 'feat/x', rollup), onePr(13, 'other', FAILING)]
  const first = watchChecks(null, 'feat/x', prsWith(RUNNING))
  expect(first).toEqual({ watch: { branch: 'feat/x', number: 12, checks: 'pending' } })
  expect(watchChecks(first.watch, 'feat/x', prsWith(PASSING)).toast).toBe('Checks passed on #12')
  expect(watchChecks(first.watch, 'feat/x', prsWith(FAILING)).toast).toBe('Checks failed on #12')
  expect(watchChecks(first.watch, 'feat/x', prsWith(RUNNING)).toast).toBeUndefined()
  const passed = watchChecks(first.watch, 'feat/x', prsWith(PASSING)).watch
  expect(watchChecks(passed, 'feat/x', prsWith(RUNNING)).toast).toBeUndefined()
  expect(watchChecks(first.watch, 'other', prsWith(RUNNING))).toEqual({ watch: { branch: 'other', number: 13, checks: 'failing' } })
  const none = watchChecks(null, 'feat/x', []).watch
  expect(none).toEqual({ branch: 'feat/x', number: 0, checks: 'none' })
  expect(watchChecks(none, 'feat/x', prsWith(FAILING)).toast).toBeUndefined()
  expect(watchChecks(first.watch, '', prsWith(FAILING)).watch.number).toBe(0)
})

test('logTail keeps the last LOG_LINES non-blank lines, without colour codes, each cut short', () => {
  const lines = Array.from({ length: LOG_LINES + 10 }, (_, index) => `test\tRun tests\tline ${index}`)
  const tail = logTail(`${lines.join('\r\n')}\n\n`)
  expect(tail.length).toBe(LOG_LINES)
  expect(tail[0]).toBe('test Run tests line 10')
  expect(tail[LOG_LINES - 1]).toBe(`test Run tests line ${LOG_LINES + 9}`)
  expect(logTail('\u001b[31mError:\u001b[0m expected 2 [INFO]')).toEqual(['Error: expected 2 [INFO]'])
  expect(Array.from(logTail('x'.repeat(5_000))[0]!).length).toBe(300)
})

test('fixPrompt names the failed checks, carries the log tail when there is one, then asks for the fix', () => {
  const failing = onePr(12, 'feat/x', FAILING)
  expect(fixPrompt(failing, ['Error: expected 2'])).toBe('CI failed on #12: test, lint.\n\n```\nError: expected 2\n```\n\nFix it.')
  expect(fixPrompt(failing, [])).toBe('CI failed on #12: test, lint.\n\nFix it.')
})

test("the current branch's PR toasts once when its checks turn passing or failing, and never for another PR", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const ci: Ci = {
    branch: 'feat/x',
    prs: [{ number: 12, branch: 'feat/x', rollup: FAILING }, { number: 13, branch: 'other', rollup: RUNNING }],
    log: { exitCode: 0, stdout: '' },
  }
  fakeCi(on, ci, [])
  fakeSession(on, ['terminal'], [])

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(toasts).toEqual([])

  ci.prs[0]!.rollup = RUNNING
  await clock.advance(FIVE_MINUTES)
  ci.prs[0]!.rollup = PASSING
  await clock.advance(FIVE_MINUTES)
  await clock.advance(FIVE_MINUTES)
  expect(toasts).toEqual(['Checks passed on #12'])

  ci.prs[0]!.rollup = FAILING
  await clock.advance(FIVE_MINUTES)
  await clock.advance(FIVE_MINUTES)
  expect(toasts).toEqual(['Checks passed on #12', 'Checks failed on #12'])

  ci.prs[1]!.rollup = FAILING
  await clock.advance(FIVE_MINUTES)
  ci.prs[1]!.rollup = PASSING
  await clock.advance(FIVE_MINUTES)
  expect(toasts).toEqual(['Checks passed on #12', 'Checks failed on #12'])

  // On another branch its own PR's checks start where they stand: #13 passing is no news.
  ci.branch = 'other'
  await clock.advance(FIVE_MINUTES)
  expect(toasts).toEqual(['Checks passed on #12', 'Checks failed on #12'])
  ci.prs[1]!.rollup = FAILING
  await clock.advance(FIVE_MINUTES)
  expect(toasts).toEqual(['Checks passed on #12', 'Checks failed on #12', 'Checks failed on #13'])
})

type Desk = { filled: string[]; sent: string[]; panes: string[] }

/** The prompt box and the panes beneath the mod: every fill, every send, and each pane closed or opened. */
function fakeDesk(on: On, desk: Desk): void {
  on('prompt.fill', (_$, e) => {
    desk.filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('prompt.submit', (_$, e) => {
    desk.sent.push(e.text)
    return { text: e.text }
  })
  on('ui.close', (_$, e) => {
    desk.panes.push(`close ${e.id}`)
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    desk.panes.push(`open ${e.id}${e.focus === true ? '+focus' : ''}`)
    return { value: { isPlaced: true } }
  })
}

test("a failing PR of the current branch has a fix button that fills the failed checks and the log's tail, and sends nothing", async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('ui.toast', () => ({ value: undefined }))
  const ci: Ci = {
    branch: 'feat/x',
    prs: [{ number: 12, branch: 'feat/x', rollup: FAILING }, { number: 13, branch: 'other', rollup: FAILING }],
    log: { exitCode: 0, stdout: 'test\tRun tests\tFAIL parse.test.ts\ntest\tRun tests\tError: expected 2, got 3\n' },
  }
  const runs: (readonly string[])[] = []
  fakeCi(on, ci, runs)
  const desk: Desk = { filled: [], sent: [], panes: [] }
  fakeDesk(on, desk)

  const pane = await $.ui.mount({ plugin: 'github-panel', surface: 'terminal', component: 'Pane', requestId: 'github', props: PANE })
  await pane.press({ key: 'refresh' })
  expect((await pane.find({ key: 'fix-12' }))?.props.label).toBe('fix')
  expect(await pane.find({ key: 'fix-13' })).toBeUndefined()
  expect(runs.some(argv => argv[1] === 'run')).toBe(false)

  await pane.press({ key: 'fix-12' })
  expect(runs[runs.length - 1]).toEqual(['gh', 'run', 'view', '4242', '--log-failed'])
  expect(desk.filled).toEqual([
    'CI failed on #12: test, lint.\n\n```\ntest Run tests FAIL parse.test.ts\ntest Run tests Error: expected 2, got 3\n```\n\nFix it.',
  ])
  expect(desk.sent).toEqual([])
  expect(desk.panes).toEqual(['close github', 'open github'])

  ci.prs[0]!.rollup = PASSING
  await pane.press({ key: 'refresh' })
  expect(await pane.find({ key: 'fix-12' })).toBeUndefined()
  await pane.unmount()
})

test('when the log cannot be fetched, the fix button fills the failed checks alone', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('ui.toast', () => ({ value: undefined }))
  const ci: Ci = { branch: 'feat/x', prs: [{ number: 12, branch: 'feat/x', rollup: FAILING }], log: { exitCode: 1, stdout: '' } }
  fakeCi(on, ci, [])
  const desk: Desk = { filled: [], sent: [], panes: [] }
  fakeDesk(on, desk)

  const pane = await $.ui.mount({ plugin: 'github-panel', surface: 'terminal', component: 'Pane', requestId: 'github', props: PANE })
  await pane.press({ key: 'refresh' })
  await pane.press({ key: 'fix-12' })
  expect(desk.filled).toEqual(['CI failed on #12: test, lint.\n\nFix it.'])
  expect(desk.sent).toEqual([])
  await pane.unmount()
})

/** The prompt box beneath the mod: records each fill, and each pane closed or opened. */
function fakePrompt(on: On, filled: string[], panes: string[]): void {
  on('prompt.fill', (_$, e) => {
    filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('ui.close', (_$, e) => {
    panes.push(`close ${e.id}`)
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    panes.push(e.focus === true ? `open ${e.id}+focus` : `open ${e.id}`)
    return { value: { isPlaced: true } }
  })
}

test('an issue row keeps its click and its buttons fill <command> <url>, sending nothing; PR rows have none', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const runs: (readonly string[])[] = []
  fakeGh(on, runs)
  const filled: string[] = []
  const panes: string[] = []
  fakePrompt(on, filled, panes)
  const sent: string[] = []
  on('prompt.submit', (_$, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    filled.length = 0
    panes.length = 0
    const pane = await $.ui.mount({ plugin: 'github-panel', surface, component: 'Pane', requestId: 'github', props: PANE })
    await pane.press({ key: 'refresh' })
    expect((await pane.find({ key: 'implement-7' }))?.text).toContain('implement')
    expect((await pane.find({ key: 'wayfinder-9' }))?.text).toContain('wayfinder')
    expect(await pane.find({ key: 'implement-12' })).toBeUndefined()
    expect(await pane.find({ key: 'wayfinder-13' })).toBeUndefined()

    await pane.press({ key: 'implement-7' })
    await pane.press({ key: 'wayfinder-9' })
    expect(filled).toEqual(['/implement https://github.com/octo/widgets/issues/7', '/wayfinder https://github.com/octo/widgets/issues/9'])
    // The pane hands the keyboard back to the prompt box: closed, then opened without focus.
    expect(panes).toEqual(['close github', 'open github', 'close github', 'open github'])

    await pane.press({ key: 'issue-7' })
    expect(runs[runs.length - 1]).toEqual(['gh', 'issue', 'view', '7', '--web'])
    await pane.unmount()
  }
  expect(sent).toEqual([])
})

test('the settings name the commands, and an empty one hides its button', { options: { implementCommand: '/build', wayfinderCommand: '' } }, async ($, on) => {
  mock.clock(on, { now: 1_000 })
  fakeGh(on, [])
  const filled: string[] = []
  fakePrompt(on, filled, [])

  const pane = await $.ui.mount({ plugin: 'github-panel', surface: 'terminal', component: 'Pane', requestId: 'github', props: PANE })
  await pane.press({ key: 'refresh' })
  expect((await pane.find({ key: 'implement-7' }))?.text).toContain('build')
  expect(await pane.find({ key: 'wayfinder-7' })).toBeUndefined()
  await pane.press({ key: 'implement-7' })
  expect(filled).toEqual(['/build https://github.com/octo/widgets/issues/7'])
  await pane.unmount()
})

test('an invalid command falls back to its default and says so at start', { options: { wayfinderCommand: 'wayfinder' } }, async ($, on) => {
  mock.clock(on, { now: 1_000 })
  fakeGh(on, [])
  fakeSession(on, [], [])
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const filled: string[] = []
  on('prompt.fill', (_$, e) => {
    filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('ui.close', () => ({ value: undefined }))

  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  expect(toasts).toEqual(['GitHub: wayfinderCommand "wayfinder" is not a slash command, such as /wayfinder; using /wayfinder.'])
  const pane = await $.ui.mount({ plugin: 'github-panel', surface: 'terminal', component: 'Pane', requestId: 'github', props: PANE })
  await pane.press({ key: 'refresh' })
  await pane.press({ key: 'wayfinder-7' })
  expect(filled).toEqual(['/wayfinder https://github.com/octo/widgets/issues/7'])
  await pane.unmount()
})

test('at the narrowest pane the fill buttons still show and fit', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  fakeGh(on, [])
  const filled: string[] = []
  fakePrompt(on, filled, [])

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'github-panel', surface, component: 'Pane', requestId: 'github', props: { ...PANE, bodyColumns: 16 } })
    await pane.press({ key: 'refresh' })
    expect(Array.from((await pane.find({ key: 'implement-7' }))?.text ?? '').length).toBeLessThanOrEqual(14)
    await pane.press({ key: 'wayfinder-7' })
    await pane.unmount()
  }
  expect(filled).toEqual(['/wayfinder https://github.com/octo/widgets/issues/7', '/wayfinder https://github.com/octo/widgets/issues/7'])
})
