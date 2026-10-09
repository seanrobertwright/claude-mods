import type { EngineInterface, ProcessRunResult, Register } from 'claude-code'

import { BASH_ARGV, BASH_ENV, bashComplaint, PARSE_TIMEOUT_MS, POWERSHELL_SHELLS, powershellArgv, powershellComplaint, refusal } from './parse'

async function isShown($: EngineInterface): Promise<boolean> {
  return (await $.session.surfaces()).length > 0
}

/** The parser's answer, or undefined when it cannot start or runs past the time limit. */
async function parse(
  $: EngineInterface,
  argv: readonly string[],
  command: string,
  env: Readonly<Record<string, string>> = {},
): Promise<ProcessRunResult | undefined> {
  return $.process.run(argv, { stdin: command, timeoutMs: PARSE_TIMEOUT_MS, env: { ...env } }).catch(() => undefined)
}

/** Undefined to let the call through, or why it is refused. */
async function checkBash($: EngineInterface, command: string): Promise<string | undefined> {
  const run = await parse($, BASH_ARGV, command, BASH_ENV)
  const complaint = run === undefined ? undefined : bashComplaint(run.exitCode, run.stderr)
  return complaint === undefined ? undefined : refusal('bash', complaint)
}

/** Undefined to let the call through, or why it is refused. */
async function checkPowerShell($: EngineInterface, command: string): Promise<string | undefined> {
  for (const shell of POWERSHELL_SHELLS) {
    const run = await parse($, powershellArgv(shell), command)
    if (run === undefined) continue
    const complaint = powershellComplaint(run.exitCode, run.stdout)
    return complaint === undefined ? undefined : refusal('PowerShell', complaint)
  }
  return undefined
}

export const register: Register = on => {
  // Matched by pattern: which shell tools a session has depends on the machine.
  on('tool.call', { tool: /^(Bash|PowerShell)$/ }, async ($, e, next) => {
    const command = 'command' in e && typeof e.command === 'string' ? e.command : undefined
    if (command === undefined || !(await isShown($))) return next(e)
    const deny = e.tool === 'Bash' ? await checkBash($, command) : await checkPowerShell($, command)
    return deny === undefined ? next(e) : { deny }
  })
}
