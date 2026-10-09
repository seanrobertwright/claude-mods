/**
 * A session's name, made by rules from its first prompt. No model reads the
 * prompt: each part is found by pattern.
 */

/** How many words of the arguments, or of the prompt, a name takes. */
const WORDS = 5

/** An issue or pull request a prompt names, and where gh reads its title. */
export type IssueRef = {
  number: number
  /** The `gh api` endpoint of its issue, which serves a pull request too; `{owner}/{repo}` is the session's repo. */
  endpoint: string
}

/** An issue's or pull request's link on GitHub. */
const ISSUE_URL = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)\b/
/** `#53` standing alone, an issue of the session's repo. */
const ISSUE_NUMBER = /(?:^|\s)#(\d+)\b/

/** The first issue or pull request `prompt` names, as a link or as `#N`. */
export function issueIn(prompt: string): IssueRef | undefined {
  const url = ISSUE_URL.exec(prompt)
  const plain = ISSUE_NUMBER.exec(prompt)
  if (url !== null && (plain === null || url.index < plain.index)) {
    return { number: Number(url[3]), endpoint: `repos/${url[1]}/${url[2]}/issues/${url[3]}` }
  }
  return plain === null ? undefined : { number: Number(plain[1]), endpoint: `repos/{owner}/{repo}/issues/${plain[1]}` }
}

/** A slash command at the start of a prompt: its name, past any `<plugin>:` prefix, and what follows. */
type SlashCommand = { name: string; args: string }

function slashCommand(prompt: string): SlashCommand | undefined {
  const match = /^\/([\w.:-]+)(?:\s+([\s\S]*))?$/.exec(prompt.trim())
  if (match === null) return undefined
  return { name: match[1]?.split(':').at(-1) ?? '', args: match[2] ?? '' }
}

function firstWords(text: string): string[] {
  return text.split(/\s+/).filter(word => word !== '').slice(0, WORDS)
}

/**
 * The name the rules give `prompt`: the issue it names, `#N <title>`, when gh
 * read that issue's title; otherwise the slash command and the first words of its arguments, or the prompt's first words. */
export function nameFor(prompt: string, issue?: { number: number; title: string }): string | undefined {
  if (issue !== undefined) return `#${issue.number} ${issue.title}`
  const command = slashCommand(prompt)
  const words = command === undefined ? firstWords(prompt) : [command.name, ...firstWords(command.args)]
  return words.length === 0 ? undefined : words.join(' ')
}
