import { expect, mock, test } from 'claude-code/testing'
import type { On, ProcessRunResult, RenderSurface } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'

import { failureReport, isGitCommit, label, npmCliBeside, parseConfig, scriptNames, tail, TAIL_CHARS, TAIL_LINES } from '../hooks/gate'

const ROOT = '/work/repo'
const TEN_MINUTES = 600_000
const NODE = 'C:\\Program Files\\nodejs\\node.exe'
const NPM_CLI = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
} as const

/** How a check ends in the world beneath: an exit with output, a start that fails, or still running at its limit. */
type Outcome = { exitCode: number; stdout?: string; stderr?: string } | { throws: string } | 'hangs'

type World = {
  /** Every process started, with its folder and time limit. */
  runs: { argv: readonly string[]; cwd: string | undefined; timeoutMs: number | undefined }[]
  /** What each check does, by its argument vector joined with spaces; absent, it passes. */
  outcomes: Map<string, Outcome>
  /** What the shell tools ran: the commands that got past the gate. */
  ran: string[]
  /** The prompt box's draft, which the fill button appends to. */
  draft: string
  sent: string[]
  toasts: string[]
  clock: MockClock
}

function finished(exitCode: number, stdout = '', stderr = ''): ProcessRunResult {
  return { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false }
}

/** The engine beneath the mod, with a project folder holding `packageJson` (none when undefined). */
function engineBeneath(
  on: On,
  {
    packageJson,
    surfaces = ['terminal'],
    os = '',
    nodePath = NODE,
  }: { packageJson?: string; surfaces?: readonly RenderSurface[]; os?: string; nodePath?: string } = {},
): World {
  const clock = mock.clock(on, { now: 1_000 })
  const world: World = { runs: [], outcomes: new Map(), ran: [], draft: '', sent: [], toasts: [], clock }
  mock.env(on, os === '' ? {} : { OS: os })
  on('session.surfaces', () => ({ value: surfaces }))
  on('session.root', () => ({ value: ROOT }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('fs.read', (_$, e) => {
    // The engine hands the path on in the platform's own form: C:\work\repo\package.json on Windows.
    if (packageJson === undefined || !e.path.replace(/\\/g, '/').endsWith(`${ROOT}/package.json`)) throw new Error(`ENOENT: ${e.path}`)
    return { value: packageJson }
  })
  on('fs.exists', (_$, e) => ({ value: e.path === NPM_CLI }))
  on('process.run', async (_$, e) => {
    world.runs.push({ argv: e.argv, cwd: e.init?.cwd, timeoutMs: e.init?.timeoutMs })
    if (e.argv.join(' ') === 'node -p process.execPath') return { value: finished(0, `${nodePath}\n`) }
    const outcome = world.outcomes.get(e.argv.join(' '))
    if (outcome === 'hangs') {
      await clock.sleep(e.init?.timeoutMs ?? 30_000)
      throw new Error('process.run: timed out')
    }
    if (outcome !== undefined && 'throws' in outcome) throw new Error(outcome.throws)
    return { value: finished(outcome?.exitCode ?? 0, outcome?.stdout, outcome?.stderr) }
  })
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    world.ran.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 0 }))
  on('ui.toast', (_$, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.read', () => ({ value: { text: world.draft, cursor: world.draft.length } }))
  on('prompt.fill', (_$, e) => {
    world.draft = e.mode === 'append' ? world.draft + e.text : e.text
    return { isFilled: true }
  })
  on('prompt.submit', (_$, e) => {
    world.sent.push(e.text)
    return { text: e.text }
  })
  return world
}

const LINT_AND_TEST = JSON.stringify({ scripts: { build: 'tsc', lint: 'eslint .', test: 'node --test' } })

/** The argument vectors of the checks run, leaving out the look-up of node's path. */
function checksRun(world: World): string[] {
  return world.runs.map(run => run.argv.join(' ')).filter(argv => argv !== 'node -p process.execPath')
}

async function mountBand($: Engine) {
  return $.ui.mount({ plugin: 'lint-test-gate', surface: 'terminal', component: 'AbovePrompt', props: BAND })
}

async function gateLabel($: Engine): Promise<string> {
  const band = await mountBand($)
  const text = (await band.find({ key: 'gate' }))?.text ?? ''
  await band.unmount()
  return text
}

async function pressGate($: Engine): Promise<void> {
  const band = await mountBand($)
  await $.ui.press({ plugin: 'lint-test-gate', key: 'gate' })
  await band.unmount()
}

test('parseConfig reads argument lists and the time limit, and refuses a malformed setting with a message', () => {
  expect(parseConfig({})).toEqual({ argvs: [], timeoutMs: TEN_MINUTES, problem: undefined })
  expect(parseConfig({ checks: '[["npx","eslint","."],["pytest","-q"]]', timeoutMinutes: 3 })).toEqual({
    argvs: [
      ['npx', 'eslint', '.'],
      ['pytest', '-q'],
    ],
    timeoutMs: 180_000,
    problem: undefined,
  })
  // Past $.process.run's ten minutes, or not a whole number of minutes, the limit is ten minutes.
  expect(parseConfig({ timeoutMinutes: 30 }).timeoutMs).toBe(TEN_MINUTES)
  expect(parseConfig({ timeoutMinutes: 0.5 }).timeoutMs).toBe(TEN_MINUTES)

  for (const checks of ['npm run lint', '"npm run lint"', '[["npm","run","lint"],"npm test"]', '[[]]', '[["npm",""]]', '[["npm",3]]']) {
    const config = parseConfig({ checks })
    expect(config.argvs).toEqual([])
    expect(config.problem).toContain('the checks setting')
  }
  expect(parseConfig({ checks: '[["npm","run","lint"],"npm test"]' }).problem).toContain('check 2')
})

test('scriptNames picks lint, typecheck, check and test, in that order, from package.json', () => {
  expect(scriptNames(JSON.stringify({ scripts: { test: 'x', build: 'y', lint: 'z', typecheck: 'w' } }))).toEqual(['lint', 'typecheck', 'test'])
  expect(scriptNames(JSON.stringify({ name: 'no-scripts' }))).toEqual([])
  expect(scriptNames(JSON.stringify({ scripts: { lint: 3 } }))).toEqual([])
  expect(scriptNames('{ not json')).toEqual([])
})

test('npmCliBeside finds npm-cli.js beside node, by the path\'s own separator', () => {
  expect(npmCliBeside(NODE)).toBe(NPM_CLI)
  expect(npmCliBeside('/opt/node/bin/node')).toBe('/opt/node/bin/node_modules/npm/bin/npm-cli.js')
})

test('isGitCommit finds git commit past global options and chained commands, and nothing else', () => {
  for (const command of [
    'git commit -m "fix: parse"',
    'git add a.ts && git commit -am wip',
    'git -C "D:\\repos\\x" commit -m x',
    'git -c user.name=me --no-pager commit',
    'cd sub; git commit',
    'git.exe commit -m x',
  ]) {
    expect(isGitCommit(command)).toBe(true)
  }
  for (const command of ['git status', 'git log --grep commit', 'git commit-tree abc', 'npm run commit', 'legit commit', 'git show HEAD:commit']) {
    expect(isGitCommit(command)).toBe(false)
  }
})

test(`tail keeps the last ${TAIL_LINES} lines, at most ${TAIL_CHARS} characters starting at a line, without colour codes`, () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`)
  const kept = tail(`${lines.join('\r\n')}\r\n\r\n`)
  expect(kept.split('\n').length).toBe(TAIL_LINES)
  expect(kept.startsWith('line 61\n')).toBe(true)
  expect(kept.endsWith('line 100')).toBe(true)

  const long = Array.from({ length: 30 }, (_, i) => `${i}`.padEnd(200, 'x')).join('\n')
  const cut = tail(long)
  expect(cut.length).toBeLessThanOrEqual(TAIL_CHARS)
  expect(cut.endsWith('29'.padEnd(200, 'x'))).toBe(true)
  expect(/^\d+x/.test(cut)).toBe(true)

  expect(tail('\u001b[31merror\u001b[0m: bad')).toBe('error: bad')
})

test('the label shows the state', () => {
  expect(label({ kind: 'idle' })).toBe('gate')
  expect(label({ kind: 'running' })).toBe('gate: running')
  expect(label({ kind: 'passed' })).toBe('gate: passed')
  expect(label({ kind: 'failed', failures: [{ name: 'lint', why: 'exit 1', tail: '' }] })).toBe('gate: 1 failing')
  expect(label({ kind: 'empty', why: '' })).toBe('gate: nothing to run')
})

test('with no setting, the gate runs the lint and test scripts in the project folder and shows passed', async ($, on) => {
  const world = engineBeneath(on, { packageJson: LINT_AND_TEST })
  expect(await gateLabel($)).toBe('gate')
  await pressGate($)
  expect(checksRun(world)).toEqual(['npm run lint', 'npm run test'])
  expect(world.runs.every(run => run.cwd === ROOT && run.timeoutMs === TEN_MINUTES)).toBe(true)
  expect(await gateLabel($)).toBe('gate: passed')
})

test('a failing script shows "1 failing", and the fill button puts its name and output tail in the prompt without sending', async ($, on) => {
  const world = engineBeneath(on, { packageJson: LINT_AND_TEST })
  world.outcomes.set('npm run lint', { exitCode: 1, stdout: 'src/a.ts\n  3:1  error  no-unused-vars\n', stderr: 'npm error Lifecycle script `lint` failed\n' })
  await pressGate($)
  expect(checksRun(world)).toEqual(['npm run lint', 'npm run test'])

  const band = await mountBand($)
  expect((await band.find({ key: 'gate' }))?.text).toBe('gate: 1 failing')
  await $.ui.press({ plugin: 'lint-test-gate', key: 'fill' })
  await band.unmount()

  expect(world.draft.startsWith('1 check failed:\n\nlint (exit 1):\n')).toBe(true)
  expect(world.draft).toContain('3:1  error  no-unused-vars')
  expect(world.draft).toContain('npm error Lifecycle script `lint` failed')
  expect(world.draft).not.toContain('test (')
  expect(world.sent).toEqual([])
})

test('the fill button keeps what the person typed, with the failures after it', async ($, on) => {
  const world = engineBeneath(on, { packageJson: LINT_AND_TEST })
  world.outcomes.set('npm run lint', { exitCode: 1, stdout: 'a.ts: error' })
  world.draft = 'Fix these:'
  await pressGate($)
  const band = await mountBand($)
  await $.ui.press({ plugin: 'lint-test-gate', key: 'fill' })
  await band.unmount()
  expect(world.draft.startsWith('Fix these:\n\n1 check failed:')).toBe(true)
  expect(world.sent).toEqual([])
})

test('the fill button shows only after a failed run', async ($, on) => {
  engineBeneath(on, { packageJson: LINT_AND_TEST })
  await pressGate($)
  const band = await mountBand($)
  expect(await band.find({ key: 'fill' })).toBeUndefined()
  await band.unmount()
})

test('a model\'s git commit with a failing check is refused, with the failures as the reason', async ($, on) => {
  const world = engineBeneath(on, { packageJson: LINT_AND_TEST })
  world.outcomes.set('npm run test', { exitCode: 2, stdout: 'not ok 1 - parses\n' })
  const call = await $.tool.call({ tool: 'Bash', command: 'git add -A && git commit -m "feat: x"' })
  expect(call.deny).toBeDefined()
  expect(call.deny).toContain('lint-test-gate refused the commit')
  expect(call.deny).toContain('test (exit 2)')
  expect(call.deny).toContain('not ok 1 - parses')
  expect(world.ran).toEqual([])
  expect(await gateLabel($)).toBe('gate: 1 failing')
})

test('a model\'s git commit with every check passing runs, and other commands run unchecked', async ($, on) => {
  const world = engineBeneath(on, { packageJson: LINT_AND_TEST })
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  expect(world.runs).toEqual([])
  const call = await $.tool.call({ tool: 'Bash', command: 'git commit -m "feat: x"' })
  expect(call.deny).toBeUndefined()
  expect(checksRun(world)).toEqual(['npm run lint', 'npm run test'])
  expect(world.ran).toEqual(['git status', 'git commit -m "feat: x"'])
})

test('a commit with nothing to run goes through', async ($, on) => {
  const world = engineBeneath(on)
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  expect(world.ran).toEqual(['git commit -m x'])
})

test('the setting\'s argument lists run instead of the scripts, each named by its arguments', { options: { checks: '[["ruff","check","."],["pytest","-q"]]' } }, async ($, on) => {
  const world = engineBeneath(on, { packageJson: LINT_AND_TEST })
  world.outcomes.set('pytest -q', { exitCode: 1, stdout: 'FAILED test_a.py::test_one\n' })
  const call = await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  expect(checksRun(world)).toEqual(['ruff check .', 'pytest -q'])
  expect(world.runs.map(run => run.argv)).toEqual([
    ['ruff', 'check', '.'],
    ['pytest', '-q'],
  ])
  expect(call.deny).toContain('pytest -q (exit 1)')
})

test('a malformed setting runs nothing, and says so at start and on a press', { options: { checks: 'npm run lint && npm test' } }, async ($, on) => {
  const world = engineBeneath(on, { packageJson: LINT_AND_TEST })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect(world.toasts.length).toBe(1)
  expect(world.toasts[0]).toContain('the checks setting is not JSON')
  await pressGate($)
  expect(world.runs).toEqual([])
  expect(await gateLabel($)).toBe('gate: nothing to run')
  expect(world.toasts[1]).toContain('the checks setting is not JSON')
})

test('with neither a setting nor a script, the band says there is nothing to run', async ($, on) => {
  const world = engineBeneath(on, { packageJson: JSON.stringify({ scripts: { build: 'tsc' } }) })
  await pressGate($)
  expect(world.runs).toEqual([])
  expect(await gateLabel($)).toBe('gate: nothing to run')
  expect(world.toasts[0]).toContain('nothing to run')
})

test('on Windows the npm scripts run under node with npm\'s own CLI script, and no shell in the argument vector', async ($, on) => {
  const world = engineBeneath(on, { packageJson: LINT_AND_TEST, os: 'Windows_NT' })
  await pressGate($)
  expect(world.runs.map(run => run.argv)).toEqual([
    ['node', '-p', 'process.execPath'],
    ['node', NPM_CLI, 'run', 'lint'],
    ['node', NPM_CLI, 'run', 'test'],
  ])
  const shells = /^(cmd|cmd\.exe|powershell|pwsh|sh|bash|npm|npm\.cmd)$/i
  expect(world.runs.flatMap(run => run.argv).some(arg => shells.test(arg) || /^\/[cs]$/i.test(arg))).toBe(false)
  expect(await gateLabel($)).toBe('gate: passed')
})

test('on Windows without npm\'s CLI script beside node, each script fails naming where it looked', async ($, on) => {
  engineBeneath(on, { packageJson: LINT_AND_TEST, os: 'Windows_NT', nodePath: 'D:\\tools\\node.exe' })
  const call = await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  expect(call.deny).toContain('lint (could not start: lint-test-gate cannot find npm\'s own CLI script at D:\\tools\\node_modules\\npm\\bin\\npm-cli.js')
  expect(await gateLabel($)).toBe('gate: 2 failing')
})

test('a check past its time limit counts as failing, named as timed out', { options: { timeoutMinutes: 2 } }, async ($, on) => {
  const world = engineBeneath(on, { packageJson: LINT_AND_TEST })
  world.outcomes.set('npm run test', 'hangs')
  const pending = $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  await world.clock.settle()
  await world.clock.advance(120_000)
  const call = await pending
  expect(world.runs.every(run => run.timeoutMs === 120_000)).toBe(true)
  expect(call.deny).toContain('test (timed out after 2 min)')
  expect(world.ran).toEqual([])
})

test('a check that cannot start counts as failing, with the reason', { options: { checks: '[["ruff","check"]]' } }, async ($, on) => {
  const world = engineBeneath(on)
  world.outcomes.set('ruff check', { throws: 'spawn ruff ENOENT' })
  const call = await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  expect(call.deny).toContain('ruff check (could not start: ')
})

test('in a headless session commits are not checked, and no check starts', async ($, on) => {
  const world = engineBeneath(on, { packageJson: LINT_AND_TEST, surfaces: [] })
  world.outcomes.set('npm run lint', { exitCode: 1 })
  await $.session.start({ cwd: ROOT, surface: null, isInteractive: false })
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  expect(world.runs).toEqual([])
  expect(world.ran).toEqual(['git commit -m x'])
})

test('in a headless session a malformed setting shows no toast', { options: { checks: 'not json' } }, async ($, on) => {
  const world = engineBeneath(on, { surfaces: [] })
  await $.session.start({ cwd: ROOT, surface: null, isInteractive: false })
  expect(world.toasts).toEqual([])
})

test('failureReport names each failure with its output tail, and one with no output by its reason alone', () => {
  const text = failureReport([
    { name: 'lint', why: 'exit 1', tail: 'a.ts: error' },
    { name: 'test', why: 'timed out after 10 min', tail: '' },
  ])
  expect(text).toBe('2 checks failed:\n\nlint (exit 1):\n```\na.ts: error\n```\n\ntest (timed out after 10 min)')
})
