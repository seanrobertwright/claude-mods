export type Shell = 'bash' | 'powershell'

/** Where a PR's body comes from: its text as the command gives it, or a file to read. */
export type Body = { text: string } | { file: string }

/** One `gh pr create` or `gh pr edit` in a shell command, with what it sets. */
export type PrCall = { title?: string; body?: Body; base?: string }

/**
 * Stands in for a heredoc or a here-string taken out of the command, so a word
 * that held one can still be traced to its text.
 */
const MARK = '\u0001'
const MARKED = new RegExp(`${MARK}(\\d+)${MARK}`, 'g')
const HEREDOC = /<<(?!<)(-?)\s*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([\w.-]+))/g
const HERE_STRING = /@(['"])\r?\n([\s\S]*?)\r?\n\1@/g
const BREAKS = new Set([';', '&', '|', '<', '>', '(', ')', '{', '}', '\n'])
const FLAGS: Readonly<Record<string, keyof Flags>> = {
  '--title': 'title',
  '-t': 'title',
  '--body': 'body',
  '-b': 'body',
  '--body-file': 'bodyFile',
  '-F': 'bodyFile',
  '--base': 'base',
  '-B': 'base',
}

type Flags = { title?: string; body?: string; bodyFile?: string; base?: string }
type Inline = { command: string; texts: string[] }

function mark(index: number): string {
  return `${MARK}${index}${MARK}`
}

/** Takes each heredoc's lines out of a Bash command, leaving a mark where its `<<` was. */
function takeHeredocs(command: string): Inline {
  const lines = command.split('\n')
  const kept: string[] = []
  const texts: string[] = []
  for (let at = 0; at < lines.length; at += 1) {
    const opened: { delimiter: string; isTabbed: boolean }[] = []
    kept.push(
      lines[at]!.replace(HEREDOC, (_all, dash: string, single?: string, double?: string, bare?: string) => {
        opened.push({ delimiter: single ?? double ?? bare ?? '', isTabbed: dash === '-' })
        return mark(texts.length + opened.length - 1)
      }),
    )
    for (const { delimiter, isTabbed } of opened) {
      const body: string[] = []
      for (at += 1; at < lines.length; at += 1) {
        const line = lines[at]!.replace(/\r$/, '')
        if ((isTabbed ? line.replace(/^\t+/, '') : line) === delimiter) break
        body.push(line)
      }
      texts.push(body.join('\n'))
    }
  }
  return { command: kept.join('\n'), texts }
}

/** Takes each here-string out of a PowerShell command, leaving a mark in its place. */
function takeHereStrings(command: string): Inline {
  const texts: string[] = []
  const rest = command.replace(HERE_STRING, (_all, _quote, text: string) => {
    texts.push(text)
    return mark(texts.length - 1)
  })
  return { command: rest, texts }
}

/**
 * The command's words with quotes taken off, cut into simple commands at an
 * unquoted break (`;`, `&&`, a pipe, a redirect, a bracket or a line end).
 */
function simpleCommands(command: string, shell: Shell): string[][] {
  const escape = shell === 'bash' ? '\\' : '`'
  const all: string[][] = [[]]
  let word: string | undefined
  const endWord = () => {
    if (word !== undefined) all[all.length - 1]!.push(word)
    word = undefined
  }
  for (let at = 0; at < command.length; at += 1) {
    const char = command[at]!
    if (char === escape) {
      // An escaped line end continues the command.
      if (command[at + 1] !== '\n') word = (word ?? '') + (command[at + 1] ?? '')
      at += 1
    } else if (char === "'") {
      const end = closing(command, at, "'", shell)
      const text = command.slice(at + 1, end)
      word = (word ?? '') + (shell === 'powershell' ? text.replaceAll("''", "'") : text)
      at = end
    } else if (char === '"') {
      const end = closing(command, at, '"', shell)
      word = (word ?? '') + unescapeDouble(command.slice(at + 1, end), shell)
      at = end
    } else if (/\s/.test(char) && char !== '\n') {
      endWord()
    } else if (BREAKS.has(char)) {
      endWord()
      all.push([])
    } else {
      word = (word ?? '') + char
    }
  }
  endWord()
  return all.filter(words => words.length > 0)
}

/** Where the quote opened at `start` closes, or the command's end when it never does. */
function closing(command: string, start: number, quote: string, shell: Shell): number {
  for (let at = start + 1; at < command.length; at += 1) {
    const char = command[at]
    if (quote === '"' && char === (shell === 'bash' ? '\\' : '`')) at += 1
    else if (char === quote) {
      // PowerShell doubles a quote to put one inside its own kind.
      if (shell === 'powershell' && command[at + 1] === quote) at += 1
      else return at
    }
  }
  return command.length
}

function unescapeDouble(text: string, shell: Shell): string {
  if (shell === 'bash') return text.replace(/\\([\\"$`\n])/g, (_all, char: string) => (char === '\n' ? '' : char))
  return text.replaceAll('""', '"').replace(/`(.)/g, (_all, char: string) => (char === 'n' ? '\n' : char === 't' ? '\t' : char))
}

/** The flags a gh call sets, from the words after `gh pr create` or `gh pr edit`. */
function readFlags(words: readonly string[]): Flags {
  const flags: Flags = {}
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at]!
    const equals = word.indexOf('=')
    const name = equals > 0 ? word.slice(0, equals) : word
    const key = FLAGS[name]
    if (key === undefined) continue
    const value = equals > 0 ? word.slice(equals + 1) : words[(at += 1)]
    if (value !== undefined) flags[key] = value
  }
  return flags
}

/** The text a word holds once each heredoc or here-string it names is put back. */
function inlineIn(word: string, texts: readonly string[]): string | undefined {
  const named = [...word.matchAll(MARKED)].map(match => texts[Number(match[1])] ?? '')
  return named.length === 0 ? undefined : named.join('\n')
}

function bodyOf(flags: Flags, texts: readonly string[]): Body | undefined {
  if (flags.body !== undefined) return { text: inlineIn(flags.body, texts) ?? flags.body }
  if (flags.bodyFile === undefined) return undefined
  // Standard input: the body is the heredoc or here-string the command carries.
  if (flags.bodyFile === '-') return texts.length === 0 ? undefined : { text: texts.join('\n') }
  return { file: flags.bodyFile }
}

/** Each `gh pr create` and `gh pr edit` the command runs, in order; none for any other command. */
export function prCalls(command: string, shell: Shell): PrCall[] {
  if (!/\bgh(?:\.exe)?\s+pr\s+(?:create|edit)\b/.test(command)) return []
  const inline = shell === 'bash' ? takeHeredocs(command) : takeHereStrings(command)
  const calls: PrCall[] = []
  for (const words of simpleCommands(inline.command, shell)) {
    const at = words.findIndex(
      (word, index) => /^(?:.*[\\/])?gh(?:\.exe)?$/i.test(word) && words[index + 1] === 'pr' && /^(?:create|edit)$/.test(words[index + 2] ?? ''),
    )
    if (at < 0) continue
    const flags = readFlags(words.slice(at + 3))
    const call: PrCall = {}
    if (flags.title !== undefined) call.title = inlineIn(flags.title, inline.texts) ?? flags.title
    const body = bodyOf(flags, inline.texts)
    if (body !== undefined) call.body = body
    if (flags.base !== undefined) call.base = flags.base
    calls.push(call)
  }
  return calls
}
