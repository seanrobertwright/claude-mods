import type { EngineInterface, Register } from 'claude-code'

import { guardedIn, guardedName, namedBy, parsePatterns, question, refusal, rejectedNotice } from './guarded'

const ALLOW = 'Allow once'
const REFUSE = 'Refuse'
const KEYPICK = 'keypick'

// Each mod carries its own copy (ADR-0001): a session shown on no surface is headless.
async function isShown($: EngineInterface): Promise<boolean> {
  return (await $.session.surfaces()).length > 0
}

/** Whether the keypick skill is installed: an exact name in the session's command list. A list that cannot be read has none. */
async function hasKeypick($: EngineInterface): Promise<boolean> {
  return (await $.command.list().catch(() => [])).some(command => command.name === KEYPICK)
}

/** The guarded file a path names, as spelled or where it lands, symlinks and junctions followed, when it exists and can be looked at. */
async function guardedPath($: EngineInterface, path: string, extra: readonly RegExp[]): Promise<string | undefined> {
  const named = guardedName(path, extra)
  if (named !== undefined) return named
  const realPath = (await $.fs.stat(path, { resolve: true }).catch(() => undefined))?.realPath
  return realPath === undefined ? undefined : guardedName(realPath, extra)
}

/** Undefined to let the call through, or why it is refused. A guarded file is asked about each call; there is nothing to remember. */
async function guard($: EngineInterface, names: readonly string[]): Promise<string | undefined> {
  if (names.length === 0) return undefined
  // A secret read cannot be taken back, so with no one to ask the call is refused rather than let through.
  if (!(await isShown($).catch(() => false))) return refusal(names, false, await hasKeypick($))
  const answer = await $.ui.ask(question(names), { header: 'Secrets', options: [ALLOW, REFUSE] }).catch(() => undefined)
  // Refused, dismissed, or answered in other words: the call does not go on.
  return answer === ALLOW ? undefined : refusal(names, true, await hasKeypick($))
}

export const register: Register = (on, options) => {
  const patterns = parsePatterns(options.extraPatterns)
  let isToldOfRejected = patterns.rejected.length === 0

  // At a turn rather than at session start: a changed setting reloads the mod in a session already going.
  on('turn.start', async ($, e, next) => {
    if (!isToldOfRejected && (await isShown($).catch(() => false))) {
      isToldOfRejected = true
      $.ui.toast(rejectedNotice(patterns.rejected), { timeoutMs: 10_000 })
    }
    return next(e)
  })

  // Matched by pattern: which read tools a session has depends on the machine.
  on('tool.call', { tool: /^(Read|Grep|Glob)$/ }, async ($, e, next) => {
    const { path, filter } = namedBy(e.tool, e)
    const searched = path === undefined ? undefined : await guardedPath($, path, patterns.guarded)
    const filtered = filter === undefined ? undefined : guardedName(filter, patterns.guarded)
    const names = [...new Set([searched, filtered])].filter(name => name !== undefined)
    const deny = await guard($, names)
    return deny === undefined ? next(e) : { deny }
  })

  on('tool.call', { tool: /^(Bash|PowerShell)$/ }, async ($, e, next) => {
    const command = 'command' in e && typeof e.command === 'string' ? e.command : ''
    const deny = await guard($, guardedIn(command, patterns.guarded))
    return deny === undefined ? next(e) : { deny }
  })
}
