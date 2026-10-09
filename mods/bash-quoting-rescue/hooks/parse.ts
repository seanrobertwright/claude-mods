/**
 * How each shell's parser is started and what its answer means. The command text is never part of
 * an argv here: it goes to the parser's standard input, so no part of it can run.
 */

/** Past this the check gives up and the call goes through. */
export const PARSE_TIMEOUT_MS = 5_000

// The session's shell may have extglob on, so `!(x)` is parsed with it on: what is refused fails either way.
export const BASH_ARGV: readonly string[] = ['bash', '-O', 'extglob', '-n']
// bash's messages in English, the only ones the mod reads.
export const BASH_ENV: Readonly<Record<string, string>> = { LC_ALL: 'C' }

/**
 * PowerShell 7 first, as the PowerShell tool prefers it: Windows PowerShell's parser refuses `&&`.
 * Windows PowerShell is tried only when PowerShell 7 does not answer.
 */
export const POWERSHELL_SHELLS = ['pwsh', 'powershell'] as const

// Reads standard input and writes standard output as UTF-8 whatever the console's code page, and
// answers with a JSON array of the parse errors. Single quotes only, to pass through any argv quoting.
const POWERSHELL_SCRIPT = [
  '$text = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false)).ReadToEnd()',
  '$errors = $null',
  '[void][Management.Automation.Language.Parser]::ParseInput($text, [ref]$null, [ref]$errors)',
  "$json = ConvertTo-Json -Compress -InputObject @($errors | ForEach-Object { 'line ' + $_.Extent.StartLineNumber + ': ' + $_.Message })",
  '$bytes = [Text.Encoding]::UTF8.GetBytes($json)',
  '[Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)',
].join('; ')

export function powershellArgv(shell: (typeof POWERSHELL_SHELLS)[number]): readonly string[] {
  return [shell, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', POWERSHELL_SCRIPT]
}

const BASH_MESSAGE = /^bash: line \d+: /m
// The text after an unclosed here-document is swallowed into it, yet bash exits 0.
const SWALLOWED_HEREDOC = /^bash: line \d+: warning: here-document at line \d+ delimited by end-of-file/m

/** bash's own words when the command does not parse; undefined when it parses or the answer is not bash's. */
export function bashComplaint(exitCode: number, stderr: string): string | undefined {
  const isSyntaxError = exitCode === 2 && BASH_MESSAGE.test(stderr)
  return isSyntaxError || (exitCode === 0 && SWALLOWED_HEREDOC.test(stderr)) ? stderr.trim() : undefined
}

/** PowerShell's parse errors, one a line; undefined when it parses or the answer is not the script's. */
export function powershellComplaint(exitCode: number, stdout: string): string | undefined {
  if (exitCode !== 0) return undefined
  let errors: unknown
  try {
    errors = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (!Array.isArray(errors) || errors.length === 0 || !errors.every(error => typeof error === 'string')) return undefined
  return errors.join('\n')
}

const HINTS = {
  bash: "Close the quote or bracket left open. For long multi-line text, quote the heredoc delimiter (<<'EOF') so nothing inside it is expanded, or write the text to a file first.",
  PowerShell: "Close the quote or bracket left open. For long multi-line text, use a single-quoted here-string (@' at the end of a line, '@ at the start of one) or write the text to a file first.",
}

/** Why the call is refused: the parser's words and how to fix the command. */
export function refusal(shell: keyof typeof HINTS, complaint: string): string {
  return `bash-quoting-rescue: ${shell} cannot parse this command, so none of it ran.\n${complaint}\n${HINTS[shell]}`
}
