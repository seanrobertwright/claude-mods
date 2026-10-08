import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Git, HudView, Limit } from '../types'
import { limitsToWarn, limitWarning, parseConfig, parseGit, parseWorktree, rows } from './hud'
import type { Config } from './hud'

/** How often the colours move while a turn runs. */
const FRAME_MS = 150
/** How often the figures are read again while a turn runs, in frames, and while idle. */
const WORKING_REFRESH_FRAMES = 40
const IDLE_REFRESH_MS = 30_000
const GIT_TIMEOUT_MS = 5_000
/** The row's room where the surface does not say. */
const DEFAULT_COLUMNS = 100

const EMPTY: HudView = {
  model: '',
  effort: null,
  contextPercent: null,
  limits: [],
  costUsd: null,
  startedAt: 0,
  git: null,
  worktree: null,
  folder: '',
  agents: 0,
  toolsTurn: 0,
  toolsSession: 0,
  isWorking: false,
  turnStartedAt: 0,
}
const view = atom({ plugin: 'hud', key: 'view' } as const, EMPTY)
const frame = atom({ plugin: 'hud', key: 'frame' } as const, 0)
const warned = atom({ plugin: 'hud', key: 'warned' } as const, {} as Record<string, string | null>)

// Die with the module on a reload; session.start, the next attach or the next turn starts them again.
let moving: Timer | undefined
let idle: Timer | undefined

/**
 * Whether any surface shows the session right now. Asked before each action
 * the mod starts on its own and never kept. Each mod carries its own copy (ADR-0001).
 */
async function isShown($: EngineInterface): Promise<boolean> {
  return (await $.session.surfaces()).length > 0
}

/** The working tree's state, and the linked worktree the session is in, if it is in one. */
async function readGit($: EngineInterface): Promise<{ git: Git | null; worktree: string | null }> {
  const [status, where] = await Promise.all(
    [
      ['git', 'status', '--porcelain=v2', '--branch'],
      ['git', 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'],
    ].map(argv => $.process.run(argv, { timeoutMs: GIT_TIMEOUT_MS }).catch(() => undefined)),
  )
  return {
    git: status === undefined || status.exitCode !== 0 ? null : parseGit(status.stdout),
    worktree: where === undefined || where.exitCode !== 0 ? null : parseWorktree(where.stdout),
  }
}

/**
 * Toasts each rate limit that has reached the red level, once in its window. The limits due are worked out
 * inside the update, so two refreshes at once cannot both toast the same one.
 */
async function warnLimits($: EngineInterface, limits: readonly Limit[]): Promise<void> {
  const now = await $.clock.now()
  let due: Limit[] = []
  await update($, warned, held => {
    due = limitsToWarn(limits, held, now)
    return due.length === 0 ? held : { ...held, ...Object.fromEntries(due.map(limit => [limit.kind, limit.resetsAt])) }
  })
  for (const limit of due) $.ui.toast(limitWarning(limit, now))
}

/** Reads the figures again, and warns of a rate limit in the red. Git costs a process, so it is read only when asked for. */
async function refresh($: EngineInterface, withGit: boolean): Promise<void> {
  const [usage, model, folder, agents] = await Promise.all([
    $.session.usage(),
    $.session.model().catch(() => ''),
    $.session.cwd().catch(() => ''),
    $.agent.list().catch(() => []),
  ])
  const repo = withGit ? await readGit($) : undefined
  const limits = usage.rateLimits.map((limit): Limit => ({ kind: limit.kind, percent: limit.percentUsed, resetsAt: limit.resetsAt ?? null }))
  await update($, view, (current): HudView => ({
    ...current,
    model,
    folder,
    contextPercent: usage.context.percent ?? null,
    limits,
    costUsd: usage.cost?.usd ?? null,
    startedAt: usage.startedAt,
    agents: agents.filter(agent => agent.status === 'running').length,
    git: repo === undefined ? current.git : repo.git,
    worktree: repo === undefined ? current.worktree : repo.worktree,
  }))
  await warnLimits($, limits)
}

function stopMoving(): void {
  moving?.cancel()
  moving = undefined
}

function stopIdle(): void {
  idle?.cancel()
  idle = undefined
}

/** Moves the row's colours and its turn timer while a turn runs and a surface shows it; a beat that finds neither stops. */
function startMoving($: EngineInterface): void {
  if (moving !== undefined) return
  const own = $.clock.every(FRAME_MS, () => {
    void (async () => {
      if (!(await read($, view)).isWorking || !(await isShown($))) {
        if (moving === own) stopMoving()
        return
      }
      const beat = (await read($, frame)) + 1
      await update($, frame, () => beat)
      if (beat % WORKING_REFRESH_FRAMES === 0) await refresh($, false)
    })().catch(() => undefined)
  })
  moving = own
}

/** Reads the figures again now and then while nothing else does; a beat that finds no surface stops until the next attach. */
function startIdle($: EngineInterface): void {
  if (idle !== undefined) return
  const own = $.clock.every(IDLE_REFRESH_MS, () => {
    void (async () => {
      if (!(await isShown($))) {
        if (idle === own) stopIdle()
        return
      }
      await refresh($, !(await read($, view)).isWorking)
      // The session length and the time to a reset move on even when no figure changed.
      await update($, frame, beat => beat + 1)
    })().catch(() => undefined)
  })
  idle = own
}

async function wake($: EngineInterface): Promise<void> {
  if (!(await isShown($))) return
  startIdle($)
  await refresh($, true)
}

export const register: Register = (on, options) => {
  const config: Config = parseConfig(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    stopMoving()
    stopIdle()
    // A headless session does nothing until a surface attaches.
    await wake($).catch(() => undefined)
    return started
  })

  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    await wake($).catch(() => undefined)
    return attached
  })

  on('turn.start', async ($, e, next) => {
    if (await isShown($).catch(() => false)) {
      const now = await $.clock.now()
      // The event does not say whose turn begins: a subagent starting mid-turn does not restart the count.
      await update($, view, (current): HudView => (current.isWorking ? current : { ...current, isWorking: true, turnStartedAt: now, toolsTurn: 0 })).catch(() => undefined)
      if (config.animate || !config.hidden.has('turn')) startMoving($)
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // The request says how hard it asks the model to think; a subagent's own setting is not the session's.
    if (e.agentId === undefined) {
      const effort = e.effort === undefined ? null : String(e.effort)
      await update($, view, (current): HudView => (current.effort === effort ? current : { ...current, effort })).catch(() => undefined)
    }
    // The response streams through untouched.
    return yield* next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (await isShown($).catch(() => false)) {
      await update($, view, (current): HudView => ({ ...current, toolsTurn: current.toolsTurn + 1, toolsSession: current.toolsSession + 1 })).catch(() => undefined)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    stopMoving()
    if (await isShown($).catch(() => false)) {
      await update($, view, (current): HudView => ({ ...current, isWorking: false })).catch(() => undefined)
      // Awaited: work left running when a hook returns is dropped with its dispatch.
      await refresh($, true).catch(() => undefined)
    }
    return done
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const beneath = await next(e)
    if (config.placement !== 'below') return beneath
    const current = await read($, view)
    const lines = rows(current, config, await $.clock.now(), await read($, frame), e.viewport?.columns ?? DEFAULT_COLUMNS)
    if (lines.length === 0) return beneath
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {lines.map((line, at) => (
          <Box key={`line-${at}`} flexDirection="row" columnGap={2}>
            {line.map(segment => (
              <Box key={segment.id} flexDirection="row" columnGap={1}>
                <Text dimColor>{segment.label}</Text>
                <Text color={segment.color} bold={segment.isBold} inverse={segment.isInverse}>
                  {segment.text}
                </Text>
              </Box>
            ))}
          </Box>
        ))}
        {beneath}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const beneath = await next(e)
    if (config.placement !== 'above' || e.props.hasSurvey || e.props.view.agentId !== undefined) return beneath
    const current = await read($, view)
    const lines = rows(current, config, await $.clock.now(), await read($, frame), e.props.bodyColumns)
    if (lines.length === 0) return beneath
    const { Box, Text } = $.ui.resolve(e)

    // No width here: the engine refuses its own band under a Box that sets one, and each line is cut to bodyColumns.
    return (
      <Box flexDirection="column">
        {lines.map((line, at) => (
          <Box key={`line-${at}`} flexDirection="row" columnGap={2}>
            {line.map(segment => (
              <Box key={segment.id} flexDirection="row" columnGap={1}>
                <Text dimColor>{segment.label}</Text>
                <Text color={segment.color} bold={segment.isBold} inverse={segment.isInverse}>
                  {segment.text}
                </Text>
              </Box>
            ))}
          </Box>
        ))}
        {beneath}
      </Box>
    )
  })
}
