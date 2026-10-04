import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { NextList, NextStep } from '../types'
import {
  buildAsk,
  buildJudge,
  DENIED_TOOLS,
  hasSkill,
  isDone,
  isMissingSkillReply,
  JUDGE_SYSTEM,
  matchStep,
  missingSkill,
  NEEDS_CLAUDE,
  parseCached,
  parseConfig,
  parseSteps,
  shimmer,
  skillNotForHeadless,
  toolFlags,
  withIds,
} from './parse'
import type { Config } from './parse'

const PANE = 'whats-next'
const POPUP = 'whats-next-prompt'
const TITLE = "What's next"
const TEN_MINUTES = 600_000
/** Room for a cold start of the `claude` CLI before the probe calls it missing. */
const PROBE_MS = 60_000
/** How often the active step's shimmer moves. */
const GLOW_MS = 120
const WORKING = 'working on it'

const EMPTY: NextList = { status: 'idle', steps: [], updatedAt: 0, error: '', runId: 0, activeId: null }
const list = atom({ plugin: 'whats-next', key: 'list' } as const, EMPTY)
const selected = atom({ plugin: 'whats-next', key: 'selected' } as const, null)
const hasStartedUp = atom({ plugin: 'whats-next', key: 'hasStartedUp' } as const, false)
const tick = atom({ plugin: 'whats-next', key: 'tick' } as const, 0)

// Dies with the module on a reload; session.start starts it again.
let glow: Timer | undefined

const storeKey = (cwd: string) => `list:${cwd}`

/** The step this session is working on: the listed step `activeId` names, if any. */
function activeStep(current: NextList): NextStep | null {
  return current.steps.find(step => step.id === current.activeId) ?? null
}

/**
 * Keeps `kept` as this folder's list unless the kept list is newer, so a run or
 * a finish that was overtaken never saves over what came after it. `$.store`
 * has no conditional write, so a write between this read and the set can
 * still be lost.
 */
async function keep($: EngineInterface, kept: Pick<NextList, 'steps' | 'updatedAt'>): Promise<void> {
  const key = storeKey(await $.session.cwd())
  const before = parseCached(await $.store.get(key))
  if (before !== undefined && before.updatedAt > kept.updatedAt) return
  await $.store.set(key, kept)
}

function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`
}

function lastLine(text: string): string {
  const lines = text.trim().split(/\r?\n/)
  return lines[lines.length - 1]?.slice(0, 200) ?? ''
}

/** The catch for work started and not awaited: say what failed instead of dropping it. */
const report = ($: EngineInterface) => (error: unknown) => {
  $.ui.toast(`What's next: ${error instanceof Error ? error.message : String(error)}`)
}

/**
 * Whether any surface shows the session right now. Asked before each action
 * the mod starts on its own and never kept: a reload or a missed attach would
 * leave a kept flag wrong. Each mod carries its own copy (ADR-0001).
 */
async function isShown($: EngineInterface): Promise<boolean> {
  return (await $.session.surfaces()).length > 0
}

function stopGlow(): void {
  glow?.cancel()
  glow = undefined
}

/** Moves the active step's shimmer while there is one and a surface shows the session. */
function startGlow($: EngineInterface): void {
  if (glow !== undefined) return
  glow = $.clock.every(GLOW_MS, () => {
    void (async () => {
      if (activeStep(await read($, list)) === null || !(await isShown($))) stopGlow()
      else await update($, tick, beat => beat + 1)
    })().catch(report($))
  })
}

/**
 * Drops a finished step from the list, the kept copy included, and stops its
 * glow. Only that step goes: another with the same prompt stays listed.
 */
async function finishStep($: EngineInterface, step: NextStep): Promise<void> {
  let kept: Pick<NextList, 'steps' | 'updatedAt'> | undefined
  await update($, list, (current): NextList => {
    kept = undefined
    if (!current.steps.some(listed => listed.id === step.id)) return current
    const steps = current.steps.filter(listed => listed.id !== step.id)
    kept = { steps, updatedAt: current.updatedAt }
    return { ...current, steps, activeId: current.activeId === step.id ? null : current.activeId }
  })
  if (activeStep(await read($, list)) === null) stopGlow()
  if (kept === undefined) return
  await keep($, kept)
  $.ui.toast(`What's next: done with "${step.title}".`)
}

/** Asks a small model whether the turn that just ended finished the active step. */
async function judge($: EngineInterface, step: NextStep, answer: string): Promise<void> {
  const reply = await $.model.complete({
    model: 'haiku',
    system: JUDGE_SYSTEM,
    prompt: buildJudge(step, answer),
    maxTokens: 16,
    effort: 'low',
    timeoutMs: 60_000,
  })
  if (reply.isAnswered && isDone(reply.text)) await finishStep($, step)
}

async function isGitRepo($: EngineInterface): Promise<boolean> {
  try {
    const { exitCode } = await $.process.run(['git', 'rev-parse', '--is-inside-work-tree'])
    return exitCode === 0
  } catch {
    return false
  }
}

/**
 * Whether the `claude` CLI starts at all, to tell a missing CLI from a slow or
 * failed run. Its exit code does not matter: a process that ran was found.
 */
async function canStartClaude($: EngineInterface): Promise<boolean> {
  try {
    await $.process.run(['claude', '--version'], { timeoutMs: PROBE_MS })
    return true
  } catch {
    return false
  }
}

/** The missing skill's message when the session's command list lacks the configured skill, else undefined. */
async function skillMissing($: EngineInterface, config: Config): Promise<string | undefined> {
  return hasSkill(await $.command.list(), config.skill) ? undefined : missingSkill(config.skill)
}

/**
 * Runs the skill in a headless `claude -p` beside this session, so the
 * conversation here is untouched, and replaces the list with its steps.
 * One run at a time; a run superseded by a reset is dropped by its runId.
 * A missing requirement (the skill, the claude CLI) leaves the list
 * `unavailable` with a message naming it and the fix. A skill missing from
 * this session's command list is caught before any run starts; one missing
 * only for the headless run is recognised from its reply, after the run.
 */
async function refresh($: EngineInterface, config: Config): Promise<void> {
  let runId = 0
  await update($, list, (current): NextList => {
    if (current.status === 'loading') {
      runId = 0
      return current
    }
    runId = current.runId + 1
    return { ...current, status: 'loading', error: '', runId }
  })
  if (runId === 0) return

  /** Applies `change` while this run is still current; says whether it did. */
  const finish = async (change: (current: NextList) => NextList): Promise<boolean> => {
    let isCurrent = false
    await update($, list, current => {
      isCurrent = current.runId === runId
      return isCurrent ? change(current) : current
    })
    return isCurrent
  }
  const unavailable = (reason: string) => finish(current => ({ ...current, status: 'unavailable', error: reason }))

  try {
    const missing = await skillMissing($, config)
    if (missing !== undefined) return void (await unavailable(missing))
    // dontAsk denies every tool the rules do not allow, and --tools removes
    // every tool they do not name. Only the person's own settings load, since
    // the skill comes from them: a repo's .claude/settings.json could otherwise
    // widen the rules. Their own allow rules for the named tools (Bash ones
    // above all) still apply here. The prompt arrives on stdin, so each
    // variadic rule list ends at the next flag.
    const argv = [
      'claude', '-p',
      '--setting-sources', 'user',
      '--permission-mode', 'dontAsk',
      ...(config.model === '' ? [] : ['--model', config.model]),
      ...toolFlags(config.allowedTools),
      '--allowedTools', ...config.allowedTools,
      '--disallowedTools', ...DENIED_TOOLS,
    ]
    let run
    try {
      run = await $.process.run(argv, { stdin: buildAsk(config.skill, config.maxSteps), timeoutMs: TEN_MINUTES })
    } catch (error) {
      if (!(await canStartClaude($))) return void (await unavailable(NEEDS_CLAUDE))
      throw error
    }
    if (run.exitCode !== 0) {
      const reason = lastLine(run.stderr) || lastLine(run.stdout) || `exit code ${run.exitCode}`
      await finish(current => ({ ...current, status: 'error', error: `claude -p failed: ${reason}` }))
      return
    }
    const steps = parseSteps(run.stdout, config.maxSteps)
    // The headless run loads only the person's own settings, so it can lack a skill this session has.
    if (steps.length === 0 && isMissingSkillReply(run.stdout, config.skill)) {
      return void (await unavailable(skillNotForHeadless(config.skill)))
    }
    if (steps.length === 0) {
      await finish(current => ({ ...current, status: 'error', error: `${config.skill} answered with no prompt to list.` }))
      return
    }
    const updatedAt = await $.clock.now()
    const listed = withIds(steps, updatedAt)
    // One guarded write replaces the steps and carries the step being worked on
    // over to its namesake in the new list, if it has one. A run superseded
    // before this write changes neither and keeps nothing; one superseded after
    // it keeps its list only while no newer one is kept (see keep).
    const isCurrent = await finish(current => {
      const working = activeStep(current)
      const carried = working === null ? null : (listed.find(step => step.prompt === working.prompt)?.id ?? null)
      return { ...current, status: 'idle', steps: listed, updatedAt, error: '', activeId: carried }
    })
    if (isCurrent) await keep($, { steps: listed, updatedAt })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await finish(current => ({ ...current, status: 'error', error: reason }))
  }
}

/**
 * The start-up work. Checks the skill, and the claude CLI too when the pane
 * would open with no steps to show. A missing requirement starts no run and
 * opens the pane only for steps kept from before, never just to report it;
 * /whats-next shows it. Otherwise it clears a requirement message left from
 * before, opens the pane unasked when `isPaneWanted`, and refreshes when the
 * settings ask for it at start and the folder is a git repo.
 */
async function startUp($: EngineInterface, config: Config, isPaneWanted: boolean): Promise<void> {
  const before = await read($, list)
  const hasSteps = before.steps.length > 0
  let missing = await skillMissing($, config)
  if (missing === undefined && isPaneWanted && !hasSteps && !(await canStartClaude($))) missing = NEEDS_CLAUDE
  // A refresh begun meanwhile bumped runId: its result stands.
  await update($, list, (current): NextList => {
    if (current.runId !== before.runId || current.status === 'loading') return current
    if (missing !== undefined) return { ...current, status: 'unavailable', error: missing }
    return current.status === 'unavailable' ? { ...current, status: 'idle', error: '' } : current
  })
  if (isPaneWanted && (missing === undefined || hasSteps)) void $.ui.open({ id: PANE, title: TITLE }).catch(report($))
  if (missing === undefined && config.refreshOnStart && (await isGitRepo($))) void refresh($, config).catch(report($))
}

async function openPopup($: EngineInterface, step: NextStep): Promise<void> {
  await update($, selected, () => step)
  await $.ui.open({ id: POPUP, title: step.title, focus: true, closeOnEscape: true, holdToasts: true })
}

export const register: Register = (on, options) => {
  const config = parseConfig(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'whats-next',
      description: "Open the What's next pane; '/whats-next refresh' asks the skill again",
    })

    // A reload killed any run in flight: drop its loading state and its result.
    const cached = parseCached(await $.store.get(storeKey(await $.session.cwd())))
    await update($, list, (current): NextList => ({
      ...current,
      ...(cached ?? {}),
      status: current.status === 'loading' ? 'idle' : current.status,
      runId: current.runId + 1,
    }))

    // A headless session, this mod's own headless runs included, does nothing
    // until a surface attaches (session.attach).
    stopGlow()
    if (await isShown($)) {
      await update($, hasStartedUp, () => true)
      if (activeStep(await read($, list)) !== null) startGlow($)
      void startUp($, config, true).catch(report($))
    }

    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    const done = await next(e)
    let isFirst = false
    await update($, hasStartedUp, was => {
      isFirst = !was
      return true
    })
    // A session that started headless catches up once. The pane opens unasked
    // only on a surface that docks it beside the conversation; elsewhere, such as
    // on a phone, it waits for /whats-next.
    if (isFirst) void startUp($, config, e.viewport?.isFullscreen === true).catch(report($))
    if (activeStep(await read($, list)) !== null) startGlow($)
    return done
  })

  // Submitting a listed step's prompt makes it the one being worked on; a
  // headless session, this mod's own runs included, never starts one.
  on('prompt.submit', async ($, e, next) => {
    const step = matchStep((await read($, list)).steps, e.text)
    if (step !== undefined && (await isShown($))) {
      let isListed = false
      await update($, list, current => {
        isListed = current.steps.some(listed => listed.id === step.id)
        return isListed ? { ...current, activeId: step.id } : current
      })
      if (isListed) startGlow($)
    }
    return next(e)
  })

  // After each answered turn of the main loop, ask whether it finished the active step.
  // A headless session asks nothing: the step stays active until a surface shows it again.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer' || !(await isShown($))) return done
    const step = activeStep(await read($, list))
    if (step !== null) void judge($, step, e.answer).catch(report($))
    return done
  })

  on('command.run', { command: 'whats-next' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: TITLE })
    const current = await read($, list)
    const isAsked = e.args.trim() === 'refresh'
    // An empty list, or a missing requirement the person may have met since, asks again.
    const isStale = current.status !== 'loading' && (current.steps.length === 0 || current.status === 'unavailable')
    if (isAsked || isStale) void refresh($, config).catch(report($))

    return { text: isAsked ? `Asking ${config.skill} what's next.` : "What's next pane opened." }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const current = await read($, list)
    const working = activeStep(current)
    const beat = await read($, tick)
    const now = await $.clock.now()
    const width = Math.max(16, e.props.bodyColumns)
    const activeIndex = current.steps.findIndex(step => step.id === working?.id)
    const [before, lit, after] = shimmer(WORKING, beat)

    return (
      <Box flexDirection="column" width={width}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>{TITLE}</Text>
          <Button
            key="refresh"
            plain
            dimColor
            hotkey="r"
            label="refresh"
            onPress={() => void refresh($, config).catch(report($))}
          />
        </Box>
        {current.status === 'loading' && (
          <Text dimColor wrap="wrap">Asking {config.skill}… this takes a minute or two.</Text>
        )}
        {(current.status === 'error' || current.status === 'unavailable') && (
          <Text color="red" wrap="wrap">{current.error}</Text>
        )}
        {current.status !== 'loading' && current.updatedAt > 0 && (
          <Text dimColor>updated {ago(now - current.updatedAt)}</Text>
        )}
        {current.steps.length === 0 && current.status === 'idle' && (
          <Text dimColor wrap="wrap">No steps yet. Press r to ask {config.skill}.</Text>
        )}
        {current.steps.map((step, index) => (
          <Box key={`step-${step.id}`} flexDirection="column" marginTop={1}>
            <Button
              key={`open-${step.id}`}
              plain
              hotkey={String(index + 1)}
              variant={index === (activeIndex === -1 ? 0 : activeIndex) ? 'primary' : 'secondary'}
              label={step.title}
              onPress={() => void openPopup($, step).catch(report($))}
            />
            {index === activeIndex && (
              <Box flexDirection="row" columnGap={2}>
                <Text color="cyan">
                  <Text dimColor>{before}</Text>
                  <Text bold>{lit}</Text>
                  <Text dimColor>{after}</Text>
                </Text>
                <Button
                  key="done"
                  plain
                  dimColor
                  hotkey="d"
                  label="done"
                  onPress={() => void finishStep($, step).catch(report($))}
                />
              </Box>
            )}
            {step.why !== '' && <Text dimColor wrap="wrap">{step.why}</Text>}
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: POPUP }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const step = await read($, selected)
    const width = Math.max(16, e.props.bodyColumns)
    if (step === null) return <Text dimColor>No step selected.</Text>

    const close = () => $.ui.close({ id: POPUP })
    const paste = async () => {
      await close()
      await $.prompt.fill({ text: step.prompt })
    }
    const clearAndPaste = async () => {
      await close()
      await $.command.run({ command: 'clear' })
      await $.prompt.fill({ text: step.prompt })
    }
    const copy = async (surface: typeof e.surface) => {
      const copied = await $.ui.copy({ text: step.prompt, surface })
      await close()
      $.ui.toast(copied.isCopied ? 'Prompt copied.' : `Could not copy: ${copied.reason}`)
    }

    return (
      <Box flexDirection="column" width={width}>
        <Text bold wrap="wrap">{step.title}</Text>
        {step.why !== '' && <Text dimColor wrap="wrap">{step.why}</Text>}
        <Box borderStyle="round" borderDimColor paddingX={1} marginY={1} flexDirection="column">
          <Text wrap="wrap">{step.prompt}</Text>
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Button
            key="paste"
            variant="primary"
            hotkey="p"
            autoFocus
            label="Paste into prompt"
            onPress={() => void paste().catch(report($))}
          />
          <Button
            key="fresh"
            hotkey="n"
            label="/clear + paste"
            onPress={() => void clearAndPaste().catch(report($))}
          />
          <Button
            key="copy"
            hotkey="c"
            label="Copy"
            onPress={press => void copy(press.surface).catch(report($))}
          />
          <Button key="close" role="dismiss" label="Close" onPress={() => void close().catch(report($))} />
        </Box>
        <Text dimColor wrap="wrap">Written for a fresh session: /clear + paste starts one. Esc closes.</Text>
      </Box>
    )
  })
}
