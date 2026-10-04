import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fit, foldChecks, issueDetail, parseConfig, parseIssues, parsePrs, prDetail } from '../hooks/parse'

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
  expect(issues).toEqual([{ number: 7, title: 'Sidebar flickers', author: 'octocat', labels: ['bug', 'needs-triage'] }])
  expect(issueDetail(issues[0]!)).toBe('bug, needs-triage · @octocat')
  expect(() => parsePrs('{}')).toThrow()
})

test('parseConfig and fit hold their bounds', () => {
  expect(parseConfig({ limit: 0, refreshMinutes: -1 })).toEqual({ limit: 30, refreshMs: 300_000 })
  expect(parseConfig({ limit: 100, refreshMinutes: 0 })).toEqual({ limit: 100, refreshMs: 0 })
  expect(fit('#1 a long title', 8)).toBe('#1 a lo…')
  expect(fit('short', 8)).toBe('short')
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
