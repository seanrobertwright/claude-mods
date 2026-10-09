// `/dev-servers add`: splits the person's line into a name, the mod's options and an argv.

/** How the add command is written, for the replies that refuse one. */
export const ADD_USAGE = '/dev-servers add <name> [--port N] [--cwd dir] <command…>'

/** A server the person added: kept per project in the store. */
export type AddedServer = {
  name: string
  argv: string[]
  /** The port it serves on, when the person declared one. */
  port?: number
  /** Where it runs, relative to the project's root; the root when absent. */
  cwd?: string
}

/** The names already rows, so an add cannot take one. */
export type TakenNames = {
  detected: readonly string[]
  added: readonly string[]
}

export type AddResult = { server: AddedServer } | { error: string }

/** Shell syntax, outside quotes, that only a shell would act on. */
const SHELL_OPERATORS = ['&&', '||', '|', ';', '>', '<', '`', '$(']
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

type Word = { text: string; isQuoted: boolean }

/** Splits on spaces with "…" and '…' quoting; undefined for an unclosed quote. */
function splitWords(line: string): Word[] | undefined {
  const words: Word[] = []
  let current: Word | undefined
  let quote = ''
  for (const char of line) {
    if (quote !== '') {
      if (char === quote) quote = ''
      else current!.text += char
    } else if (char === '"' || char === "'") {
      quote = char
      current ??= { text: '', isQuoted: true }
      current.isQuoted = true
    } else if (char === ' ' || char === '\t') {
      if (current !== undefined) words.push(current)
      current = undefined
    } else {
      current ??= { text: '', isQuoted: false }
      current.text += char
    }
  }
  if (quote !== '') return undefined
  if (current !== undefined) words.push(current)
  return words
}

/** The shell syntax a line holds outside its quotes, or undefined. */
function shellSyntax(line: string): string | undefined {
  let bare = ''
  let quote = ''
  for (const char of line) {
    if (quote !== '') {
      if (char === quote) quote = ''
      bare += ' '
    } else if (char === '"' || char === "'") {
      quote = char
      bare += ' '
    } else bare += char
  }
  return SHELL_OPERATORS.find(operator => bare.includes(operator))
}

function refuseShell(what: string): AddResult {
  return {
    error:
      `${what} needs a shell, and dev-servers runs commands without a shell. ` +
      'Put the command in a package.json script and add the row for that script, or run the script itself.',
  }
}

/** Parses the arguments of `/dev-servers add`; refuses shell syntax, a taken name, and a malformed line. */
export function parseAdd(args: string, taken: TakenNames): AddResult {
  const operator = shellSyntax(args)
  if (operator !== undefined) return refuseShell(`\`${operator}\``)
  const words = splitWords(args.trim())
  if (words === undefined) return { error: `The command has an unclosed quote. Use: ${ADD_USAGE}` }
  const [first, ...rest] = words
  if (first === undefined || !NAME.test(first.text)) return { error: `Name the server first. Use: ${ADD_USAGE}` }
  const name = first.text
  if (taken.detected.includes(name)) return { error: `${name} is already a server here (a package.json script). Pick another name.` }
  if (taken.added.includes(name)) return { error: `${name} is already a server here (added with /dev-servers add). Pick another name.` }

  const server: AddedServer = { name, argv: [] }
  let at = 0
  for (;;) {
    const option = rest[at]
    if (option?.isQuoted !== false || (option.text !== '--port' && option.text !== '--cwd')) break
    const value = rest[at + 1]
    if (value === undefined) return { error: `${option.text} needs a value. Use: ${ADD_USAGE}` }
    if (option.text === '--port') {
      const port = Number(value.text)
      if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: `--port takes a port number (1-65535), not ${value.text}.` }
      server.port = port
    } else server.cwd = value.text
    at += 2
  }
  const command = rest.slice(at)
  if (command.length === 0) return { error: `Give the command to run after the name. Use: ${ADD_USAGE}` }
  const lead = command[0]!
  if (!lead.isQuoted && ASSIGNMENT.test(lead.text)) return refuseShell(`Setting a variable (\`${lead.text}\`)`)
  server.argv = command.map(word => word.text)
  return { server }
}
