import { expect, test } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

import { bashComplaint, PARSE_TIMEOUT_MS, powershellComplaint } from '../hooks/parse'

const UNTERMINATED = 'echo "unterminated'
const OPEN_HEREDOC = 'cat <<EOF\nhello'
const PS_UNTERMINATED = 'Write-Output "x'

const BASH_EOF = "bash: line 1: unexpected EOF while looking for matching `\"'\n"
const BASH_HEREDOC = "bash: line 2: warning: here-document at line 1 delimited by end-of-file (wanted `EOF')\n"
const PS_MISSING_TERMINATOR = 'line 1: The string is missing the terminator: ".'

/** A parser's answer, or how it fails: it cannot start, or it is still running at the time limit. */
type Answer = { exitCode: number; stdout?: string; stderr?: string } | 'missing' | 'stuck'

/**
 * What bash -n and the mod's PowerShell script answered for these commands (bash 5.3, PowerShell 7.5);
 * any other command parses.
 */
const ANSWERS: Readonly<Record<string, Answer>> = {
  [UNTERMINATED]: { exitCode: 2, stderr: BASH_EOF },
  [OPEN_HEREDOC]: { exitCode: 0, stderr: BASH_HEREDOC },
  [PS_UNTERMINATED]: { exitCode: 0, stdout: JSON.stringify([PS_MISSING_TERMINATOR]) },
}

type Run = { argv: readonly string[]; stdin: string | undefined; timeoutMs: number | undefined }

/** The world beneath the mod: shells it cannot start or that hang, each parser run, and the commands that ran. */
type World = { shells: Record<string, Answer>; runs: Run[]; ran: string[] }

function engineBeneath(on: On, surfaces: readonly RenderSurface[] = ['terminal']): World {
  const world: World = { shells: {}, runs: [], ran: [] }
  on('session.surfaces', () => ({ value: surfaces }))
  on('process.run', (_$, e) => {
    const stdin = e.init?.stdin
    world.runs.push({ argv: e.argv, stdin, timeoutMs: e.init?.timeoutMs })
    const answer = world.shells[e.argv[0] ?? ''] ?? ANSWERS[stdin ?? ''] ?? { exitCode: 0, stdout: e.argv[0] === 'bash' ? '' : '[]' }
    if (answer === 'missing') return { deny: `spawn ${e.argv[0]} ENOENT` }
    if (answer === 'stuck') return { deny: `timed out after ${e.init?.timeoutMs} ms` }
    return { value: { exitCode: answer.exitCode, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    world.ran.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  on('tool.call', { tool: 'PowerShell' }, (_$, e) => {
    world.ran.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  return world
}

test("bashComplaint gives bash's words for a syntax error and a swallowed heredoc, and nothing else", () => {
  expect(bashComplaint(2, BASH_EOF)).toBe(BASH_EOF.trim())
  expect(bashComplaint(0, BASH_HEREDOC)).toBe(BASH_HEREDOC.trim())
  expect(bashComplaint(0, '')).toBeUndefined()
  // A bash that is not there to answer, such as WSL's launcher with no distribution.
  expect(bashComplaint(1, 'Windows Subsystem for Linux has no installed distributions.')).toBeUndefined()
  expect(bashComplaint(2, 'bash: -O: invalid option')).toBeUndefined()
})

test("powershellComplaint gives the parse errors, and nothing for an answer that is not the script's", () => {
  expect(powershellComplaint(0, JSON.stringify([PS_MISSING_TERMINATOR, 'line 2: Missing closing }.']))).toBe(
    `${PS_MISSING_TERMINATOR}\nline 2: Missing closing }.`,
  )
  expect(powershellComplaint(0, '[]')).toBeUndefined()
  expect(powershellComplaint(1, JSON.stringify([PS_MISSING_TERMINATOR]))).toBeUndefined()
  expect(powershellComplaint(0, 'The term ConvertTo-Json is not recognized')).toBeUndefined()
  expect(powershellComplaint(0, '{"line":1}')).toBeUndefined()
  expect(powershellComplaint(0, '[1]')).toBeUndefined()
})

test("an unterminated quote is refused with bash's message and the hint, and nothing runs", async ($, on) => {
  const world = engineBeneath(on)
  const ran = await $.tool.call({ tool: 'Bash', command: UNTERMINATED })
  expect(ran.deny).toContain('bash cannot parse this command, so none of it ran.')
  expect(ran.deny).toContain(BASH_EOF.trim())
  expect(ran.deny).toContain("quote the heredoc delimiter (<<'EOF')")
  expect(ran.deny).toContain('write the text to a file first')
  expect(world.ran).toEqual([])
})

test('an unterminated heredoc is refused, though bash only warns about it', async ($, on) => {
  const world = engineBeneath(on)
  const ran = await $.tool.call({ tool: 'Bash', command: OPEN_HEREDOC })
  expect(ran.deny).toContain(BASH_HEREDOC.trim())
  expect(world.ran).toEqual([])
})

test('a command that parses goes through unchanged', async ($, on) => {
  const world = engineBeneath(on)
  const commands = ["cat <<'EOF'\n$HOME \"unbalanced' text\nEOF", 'echo "today is $(date +%A)"', 'ls !(node_modules)']
  for (const command of commands) expect((await $.tool.call({ tool: 'Bash', command })).deny).toBeUndefined()
  expect(world.ran).toEqual(commands)
})

test('PowerShell that does not parse is refused with its parse errors; PowerShell that does goes through', async ($, on) => {
  const world = engineBeneath(on)
  const refused = await $.tool.call({ tool: 'PowerShell', command: PS_UNTERMINATED })
  expect(refused.deny).toContain('PowerShell cannot parse this command, so none of it ran.')
  expect(refused.deny).toContain(PS_MISSING_TERMINATOR)
  expect(refused.deny).toContain('single-quoted here-string')
  expect((await $.tool.call({ tool: 'PowerShell', command: 'Write-Output "x" && Get-Date' })).deny).toBeUndefined()
  expect(world.ran).toEqual(['Write-Output "x" && Get-Date'])
  expect(world.runs.map(run => run.argv[0])).toEqual(['pwsh', 'pwsh'])
})

test('the command text reaches each parser on standard input and never in its argv', async ($, on) => {
  const world = engineBeneath(on)
  const command = 'echo "MARKER-quoted" && Write-Output MARKER-bare'
  await $.tool.call({ tool: 'Bash', command })
  await $.tool.call({ tool: 'PowerShell', command })
  expect(world.runs.length).toBe(2)
  for (const run of world.runs) {
    expect(run.stdin).toBe(command)
    expect(run.argv.filter(arg => arg.includes('MARKER') || arg.includes('Write-Output'))).toEqual([])
  }
  expect(world.runs.map(run => run.argv[0])).toEqual(['bash', 'pwsh'])
})

test('a parser that cannot start, runs past its time limit or answers strangely lets the call through', async ($, on) => {
  const world = engineBeneath(on)
  world.shells.bash = 'missing'
  await $.tool.call({ tool: 'Bash', command: UNTERMINATED })
  world.shells.bash = 'stuck'
  await $.tool.call({ tool: 'Bash', command: UNTERMINATED })
  world.shells.bash = { exitCode: 1, stderr: 'Windows Subsystem for Linux has no installed distributions.' }
  await $.tool.call({ tool: 'Bash', command: UNTERMINATED })
  expect(world.ran).toEqual([UNTERMINATED, UNTERMINATED, UNTERMINATED])
  expect(world.runs.map(run => run.timeoutMs)).toEqual([PARSE_TIMEOUT_MS, PARSE_TIMEOUT_MS, PARSE_TIMEOUT_MS])
})

test('Windows PowerShell parses when PowerShell 7 is missing, and the call goes through when neither answers', async ($, on) => {
  const world = engineBeneath(on)
  world.shells.pwsh = 'missing'
  expect((await $.tool.call({ tool: 'PowerShell', command: PS_UNTERMINATED })).deny).toContain(PS_MISSING_TERMINATOR)
  expect(world.runs.map(run => run.argv[0])).toEqual(['pwsh', 'powershell'])

  world.shells.powershell = 'stuck'
  expect((await $.tool.call({ tool: 'PowerShell', command: PS_UNTERMINATED })).deny).toBeUndefined()
  expect(world.ran).toEqual([PS_UNTERMINATED])
})

test('in a headless session nothing is parsed and the call goes through', async ($, on) => {
  const world = engineBeneath(on, [])
  await $.tool.call({ tool: 'Bash', command: UNTERMINATED })
  await $.tool.call({ tool: 'PowerShell', command: PS_UNTERMINATED })
  expect(world.runs).toEqual([])
  expect(world.ran).toEqual([UNTERMINATED, PS_UNTERMINATED])
})
