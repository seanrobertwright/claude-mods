/**
 * Reading a wayfinder loop from typed facts: the arguments the skill ran with,
 * the Bash commands a turn ran and their output. No text the model wrote is read.
 */

/** A `/issues/N` link, as gh prints one and as a person passes one. */
const ISSUE_URL = /\/issues\/(\d+)\b/

/** The flags of `gh issue close` that take a value, so the value is not read as the issue. */
const CLOSE_VALUE_FLAGS = new Set(['-c', '--comment', '-r', '--reason', '-R', '--repo'])

/** What one turn's Bash commands did to the tracker. */
export type BashReading = {
  /** Each issue a `gh issue close` named, in order. */
  closed: number[]
  /** The map a `gh issue create --label wayfinder:map` made, read from the URL gh printed for it. */
  created?: number
}

/** The arguments a skill ran with: the engine appends them as an `ARGUMENTS:` line when the skill names none itself. */
export function skillArgs(text: string): string | undefined {
  return [...text.matchAll(/^ARGUMENTS:[ \t]*(.*)$/gm)].at(-1)?.[1]?.trim()
}

/** The map an argument names: an issue link, `#135` or `135`, the first one given. */
export function mapFromArgs(args: string): number | undefined {
  const url = ISSUE_URL.exec(args)
  const plain = /(?:^|\s)#?(\d+)(?=\s|$)/.exec(args)
  const found = url !== null && (plain === null || url.index < plain.index) ? url[1] : plain?.[1]
  return found === undefined ? undefined : Number(found)
}

/** An issue as `gh` takes one: a number, `#135` or a link. */
function issueNumber(token: string): number | undefined {
  const url = ISSUE_URL.exec(token)
  if (url !== null) return Number(url[1])
  const plain = /^#?(\d+)$/.exec(token)
  return plain === null ? undefined : Number(plain[1])
}

/**
 * A command line split into its simple commands, each a list of words with
 * quotes taken off. A quoted `&&` or `;` is part of its word, not a break.
 */
function simpleCommands(command: string): string[][] {
  let words: string[] = []
  const commands = [words]
  for (const match of command.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(&&|\|\||[;|\n])|([^\s"';|&]+|&)/g)) {
    if (match[3] !== undefined) commands.push((words = []))
    else words.push(match[1] ?? match[2] ?? match[4] ?? '')
  }
  return commands.filter(simple => simple.length > 0)
}

/** Whether `words` run `gh issue <verb>`. */
function isGhIssue(words: string[], verb: string): boolean {
  return words[0] === 'gh' && words[1] === 'issue' && words[2] === verb
}

/** The issue a `gh issue close` names: its one positional argument, past the flags that take a value. */
function closedBy(words: string[]): number | undefined {
  const rest = words.slice(3)
  const issue = rest.find((word, at) => !word.startsWith('-') && !CLOSE_VALUE_FLAGS.has(rest[at - 1] ?? ''))
  return issue === undefined ? undefined : issueNumber(issue)
}

/** Whether a `gh issue create` labels the issue `wayfinder:map`, by `--label`, `-l` or `--label=`, alone or in a list. */
function makesMap(words: string[]): boolean {
  return words.some((word, at) => {
    const value = word.startsWith('--label=') ? word.slice('--label='.length) : word === '--label' || word === '-l' ? words[at + 1] : undefined
    return value !== undefined && value.split(',').some(label => label.trim() === 'wayfinder:map')
  })
}

/**
 * What a Bash command did to the tracker, given its output. gh prints one link
 * per issue it creates, in order, so a map's link is the one at its place
 * among the creates.
 */
export function readBash(command: string, output: string): BashReading {
  const commands = simpleCommands(command)
  const closed = commands.filter(words => isGhIssue(words, 'close')).flatMap(words => closedBy(words) ?? [])
  const creates = commands.filter(words => isGhIssue(words, 'create'))
  const mapAt = creates.findIndex(makesMap)
  if (mapAt === -1) return { closed }
  const link = [...output.matchAll(new RegExp(ISSUE_URL.source, 'g'))][mapAt]
  return link === undefined ? { closed } : { closed, created: Number(link[1]) }
}

/**
 * The map to offer after a turn, or undefined: the map the turn made, or the
 * one the skill ran with when the turn closed another issue. A turn that
 * closed the map itself ends the loop.
 */
export function nextMap(turn: { map?: number; closed: readonly number[]; created?: number }): number | undefined {
  const map = turn.created ?? turn.map
  if (map === undefined || turn.closed.includes(map)) return undefined
  return turn.created !== undefined || turn.closed.some(issue => issue !== map) ? map : undefined
}
