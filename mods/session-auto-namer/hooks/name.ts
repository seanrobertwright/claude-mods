/**
 * A session's name, made by rules from its first prompt. No model reads the
 * prompt: each part is found by pattern.
 */

/** How many words of the arguments, or of the prompt, a name takes. */
const WORDS = 5

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

/** The name the rules give `prompt`: the slash command and the first words of its arguments, or the prompt's first words. */
export function nameFor(prompt: string): string | undefined {
  const command = slashCommand(prompt)
  const words = command === undefined ? firstWords(prompt) : [command.name, ...firstWords(command.args)]
  return words.length === 0 ? undefined : words.join(' ')
}
