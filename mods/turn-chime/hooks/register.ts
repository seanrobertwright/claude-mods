import type { EngineInterface, Register } from 'claude-code'

import { length, parseConfig, SOUND, windowsPlayer } from './chime'

// Each mod carries its own copy (ADR-0001): a session shown on no surface is headless.
async function isShown($: EngineInterface): Promise<boolean> {
  return (await $.session.surfaces()).length > 0
}

const PLAYER_TIMEOUT_MS = 10_000

/** In a shown session, plays the sound and says why. A sound that cannot play leaves the toast. */
async function chimeIfShown($: EngineInterface, text: string): Promise<void> {
  if (!(await isShown($))) return
  $.ui.toast(text)
  // The engine's player plays nothing in a Windows terminal, so PowerShell plays the file there.
  if ((await $.env.get('OS')) === 'Windows_NT') await $.process.run(windowsPlayer($.plugin.root), { timeoutMs: PLAYER_TIMEOUT_MS })
  else await $.audio.play({ asset: SOUND })
}

export const register: Register = (on, options) => {
  const config = parseConfig(options)
  // When the main conversation's turn began, and whether a question in it has chimed yet.
  let startedAt: number | undefined
  let hasQuestionChimed = false
  // When the person last sent a prompt or last heard the chime: what they have waited since.
  // Work that goes on in the background ends its turn at once and reports in a later, short one.
  let lastHeardAt: number | undefined

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') lastHeardAt = await $.clock.now().catch(() => undefined)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    // The event does not say whose turn begins, so only the first start since the main
    // conversation's last end counts: a subagent starting mid-turn does not move the mark.
    if (startedAt === undefined) {
      startedAt = await $.clock.now().catch(() => undefined)
      hasQuestionChimed = false
    }
    return next(e)
  })

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const since = Math.min(startedAt ?? Infinity, lastHeardAt ?? Infinity)
    const ran = since === Infinity ? 0 : Math.max(0, (await $.clock.now().catch(() => 0)) - since)
    if (hasQuestionChimed || e.agentId !== undefined || ran < config.thresholdMs) return next(e)
    hasQuestionChimed = true
    lastHeardAt = since + ran
    // The sound plays while the question is up, never ahead of it; a failure of the mod's
    // own never costs the call.
    const late = chimeIfShown($, `Claude needs an answer, ${length(ran)} into the work.`).catch(() => undefined)
    const [asked] = await Promise.all([next(e), late])
    return asked
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    // A subagent's turn is not one the person waits on, and one they stopped they are already watching.
    if (e.agentId !== undefined) return done
    startedAt = undefined
    if (e.isAborted) return done
    const now = await $.clock.now().catch(() => 0)
    const waited = lastHeardAt === undefined ? 0 : Math.max(0, now - lastHeardAt)
    if (e.durationMs < config.thresholdMs && waited < config.thresholdMs) return done
    lastHeardAt = now
    const text = e.durationMs >= config.thresholdMs ? `Turn finished after ${length(e.durationMs)}.` : `Claude finished, ${length(waited)} after your last prompt.`
    // Awaited: work left running when a hook returns is dropped with its dispatch.
    await chimeIfShown($, text).catch(() => undefined)
    return done
  })
}
