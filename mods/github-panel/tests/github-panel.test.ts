import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { blockerLines, fit, foldChecks, issueDetail, parseConfig, parseIssues, parsePrs, prDetail } from '../hooks/parse'

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
  { number: 7, title: 'Sidebar flickers', author: { login: 'octocat' }, labels: [{ name: 'bug' }, { name: 'needs-triage' }] },
  {
    number: 9,
    title: 'Ship the pane',
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

function ok(stdout: string) {
  return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
}

/** gh beneath the plugin: answers the repo, PR and issue lists, and records every argv. */
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
    { number: 7, title: 'Sidebar flickers', author: 'octocat', labels: ['bug', 'needs-triage'], blockedBy: [] },
    { number: 9, title: 'Ship the pane', author: 'hubot', labels: [], blockedBy: [{ number: 7, title: 'Sidebar flickers' }] },
  ])
  expect(issueDetail(issues[0]!)).toBe('bug, needs-triage · @octocat')
  expect(issueDetail(issues[1]!)).toBe('blocked by #7 · @hubot')
  expect(() => parsePrs('{}')).toThrow()
})

test('parseConfig and fit hold their bounds', () => {
  expect(parseConfig({ limit: 0, refreshMinutes: -1 })).toEqual({ limit: 30, refreshMs: 300_000 })
  expect(parseConfig({ limit: 100, refreshMinutes: 0 })).toEqual({ limit: 100, refreshMs: 0 })
  expect(fit('#1 a long title', 8)).toBe('#1 a lo…')
  expect(fit('short', 8)).toBe('short')
  expect(blockerLines([{ number: 7, title: 'Sidebar flickers' }], 12)).toEqual(['Blocked by  ', '#7 Sidebar …'])
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
  expect(await pane.find({ type: 'Text', text: 'no git remotes found' })).toBeDefined()
  expect(await pane.find({ key: 'pr-12' })).toBeUndefined()
  expect(runs.some(argv => argv.includes('list'))).toBe(false)
  await pane.unmount()
})

const DESKTOP = { surface: 'desktop', clientId: 'desktop:default', viewport: { columns: 200, rows: 50, isFullscreen: true } } as const
const PHONE = { surface: 'mobile', clientId: 'mobile:default', viewport: { columns: 40, rows: 60, isFullscreen: false } } as const
const FIVE_MINUTES = 300_000

/** The engine beneath the plugin: the surfaces showing the session (the test edits the list) and every pane opened. */
function fakeSession(on: On, surfaces: string[], opened: string[]): void {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  on('session.detach', (_$, e) => ({ clientId: e.clientId }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.surfaces', () => ({ value: [...surfaces] as never }))
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
}

const isLoad = (argv: readonly string[]) => argv[1] === 'repo' && argv[2] === 'view'

test('a headless session runs no gh, starts no polling and opens no pane', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const runs: (readonly string[])[] = []
  const opened: string[] = []
  fakeGh(on, runs)
  fakeSession(on, [], opened)

  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await clock.advance(3 * FIVE_MINUTES)
  expect(runs).toEqual([])
  expect(opened).toEqual([])
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
  expect(opened).toEqual(['github'])
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
