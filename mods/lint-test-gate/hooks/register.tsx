import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Failure, GateState } from '../types'
import {
  duration,
  failureReport,
  isGitCommit,
  label,
  NEEDS_NODE,
  NOTHING_TO_RUN,
  npmCliBeside,
  parseConfig,
  refusal,
  scriptNames,
  tail,
} from './gate'
import type { Check, Config } from './gate'

const gate = atom({ plugin: 'lint-test-gate', key: 'gate' } as const, { kind: 'idle' } as GateState)

/**
 * Whether any surface shows the session right now. Asked before each run the
 * mod starts and never kept. Each mod carries its own copy (ADR-0001).
 */
async function isShown($: EngineInterface): Promise<boolean> {
  return (await $.session.surfaces()).length > 0
}

function report($: EngineInterface): (error: unknown) => void {
  return error => $.ui.toast(`lint-test-gate: ${message(error)}`)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * How to start npm, by bare name as every program is started. On Windows npm
 * is a .cmd shim, which a start without a shell cannot run, so npm's own CLI
 * script runs under node instead, with no cmd.exe in the argument vector.
 */
async function npmArgv($: EngineInterface): Promise<{ argv: string[] } | { problem: string }> {
  if ((await $.env.get('OS')) !== 'Windows_NT') return { argv: ['npm'] }
  const node = await $.process.run(['node', '-p', 'process.execPath']).catch(() => undefined)
  if (node === undefined || node.exitCode !== 0) return { problem: NEEDS_NODE }
  const cli = npmCliBeside(node.stdout.trim())
  if (!(await $.fs.exists(cli).catch(() => false))) {
    return { problem: `lint-test-gate cannot find npm's own CLI script at ${cli}, beside node. List the checks in the setting instead.` }
  }
  return { argv: ['node', cli] }
}

/** The setting's checks, else the package.json scripts; or why there is nothing to run. */
async function findChecks($: EngineInterface, config: Config, root: string): Promise<Check[] | string> {
  if (config.problem !== undefined) return config.problem
  if (config.argvs.length > 0) return config.argvs.map(argv => ({ name: argv.join(' '), argv }))
  const packageJson = await $.fs.read(`${root}/package.json`).catch(() => '')
  const scripts = scriptNames(packageJson)
  if (scripts.length === 0) return NOTHING_TO_RUN
  const npm = await npmArgv($)
  return scripts.map(name => ('problem' in npm ? { name, problem: npm.problem } : { name, argv: [...npm.argv, 'run', name] }))
}

/** Runs one check in the project folder; undefined when it passed. */
async function runCheck($: EngineInterface, check: Check, root: string, timeoutMs: number): Promise<Failure | undefined> {
  if ('problem' in check) return { name: check.name, why: `could not start: ${check.problem}`, tail: '' }
  const startedAt = await $.clock.now()
  try {
    const result = await $.process.run(check.argv, { cwd: root, timeoutMs })
    if (result.exitCode === 0) return undefined
    return { name: check.name, why: `exit ${result.exitCode}`, tail: tail([result.stdout, result.stderr].join('\n')) }
  } catch (error) {
    // A start that fails rejects at once; a run past its limit rejects at the limit, with what it wrote lost.
    if ((await $.clock.now()) - startedAt >= timeoutMs) return { name: check.name, why: `timed out after ${duration(timeoutMs)}`, tail: '' }
    return { name: check.name, why: `could not start: ${message(error)}`, tail: '' }
  }
}

async function outcome($: EngineInterface, config: Config): Promise<GateState> {
  const root = await $.session.root()
  const checks = await findChecks($, config, root)
  if (typeof checks === 'string') return { kind: 'empty', why: checks }
  const failures: Failure[] = []
  for (const check of checks) {
    const failure = await runCheck($, check, root, config.timeoutMs)
    if (failure !== undefined) failures.push(failure)
  }
  return failures.length === 0 ? { kind: 'passed' } : { kind: 'failed', failures }
}

// One run at a time: two runs of the same scripts in one folder would trip over each other.
let queue: Promise<unknown> = Promise.resolve()

/** Runs the checks after any run under way, showing the state on the band. */
function runGate($: EngineInterface, config: Config): Promise<GateState> {
  const run = queue.then(async () => {
    await update($, gate, () => ({ kind: 'running' }))
    const state = await outcome($, config).catch(async (error: unknown) => {
      await update($, gate, () => ({ kind: 'idle' }))
      throw error
    })
    await update($, gate, () => state)
    return state
  })
  queue = run.catch(() => undefined)
  return run
}

async function press($: EngineInterface, config: Config): Promise<void> {
  if ((await read($, gate)).kind === 'running') return
  const state = await runGate($, config)
  if (state.kind === 'empty') $.ui.toast(state.why)
}

async function fill($: EngineInterface, failures: readonly Failure[]): Promise<void> {
  // Nothing is sent: the failures join the draft, after what the person typed, and the person sends it.
  const draft = (await $.prompt.read()).text
  const text = draft === '' ? failureReport(failures) : `\n\n${failureReport(failures)}`
  const filled = await $.prompt.fill({ text, mode: 'append' })
  if (!filled.isFilled) $.ui.toast('lint-test-gate: the prompt box could not take the failures.')
}

export const register: Register = (on, options) => {
  const config = parseConfig(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (config.problem !== undefined && (await isShown($))) $.ui.toast(config.problem)
    return started
  })

  // Matched by pattern: which shell tools a session has depends on the machine.
  on('tool.call', { tool: /^(Bash|PowerShell)$/ }, async ($, e, next) => {
    const command = 'command' in e && typeof e.command === 'string' ? e.command : ''
    if (!isGitCommit(command) || !(await isShown($))) return next(e)
    const state = await runGate($, config)
    return state.kind === 'failed' ? { deny: refusal(state.failures) } : next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Whatever is beneath (another mod's band, the engine's own) keeps its row under the gate.
    const beneath = await next(e)
    if (e.props.hasSurvey || e.props.view.agentId !== undefined) return beneath
    const state = await read($, gate)
    const { Box, Button } = $.ui.resolve(e)

    // The outer Box takes no width: the engine refuses its own band under a Box that sets one.
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1} width={e.props.bodyColumns}>
          <Button
            key="gate"
            label={label(state)}
            variant={state.kind === 'failed' ? 'primary' : 'secondary'}
            onPress={() => void press($, config).catch(report($))}
          />
          {state.kind === 'failed' && (
            <Button key="fill" label="fill failures" onPress={() => void fill($, state.failures).catch(report($))} />
          )}
        </Box>
        {beneath}
      </Box>
    )
  })
}
