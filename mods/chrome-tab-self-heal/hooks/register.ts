import type { Register } from 'claude-code'

const HINT = 'Call tabs_context_mcp for the current tab IDs, then retry with one of them.'

/**
 * The fixed words of an error for a tab that is gone: the tab (or tab 123) no
 * longer exists, no tab with id, invalid tab ID. A gone element or tab group is
 * not a gone tab, and the server's errors for those already say what to do.
 */
const STALE_TAB = /\btab(?: \d+)? no longer exists|\bno tab with id\b|\binvalid tab id\b/i

export const register: Register = on => {
  // An MCP tool reaches tool.call by its full name, mcp__<server>__<tool>.
  on('tool.call', { tool: /^mcp__claude-in-chrome__/ }, async (_$, e, next) => {
    const ran = await next(e)
    if (ran.isError !== true || !STALE_TAB.test(ran.text ?? '')) return ran
    // The hint goes after the error, which the model still reads word for word.
    const context = ran.context ?? []
    return context.includes(HINT) ? ran : { ...ran, context: [...context, HINT] }
  })
}
