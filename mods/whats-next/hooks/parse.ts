import type { NextList, NextStep } from '../types'

const FENCE = /```[^\n]*\n([\s\S]*?)\n[ \t]*```/
const FENCES = /```[^\n]*\n([\s\S]*?)\n[ \t]*```/g

/**
 * The prompt the headless run is given: the skill's own "what's next" pass,
 * asked for a list instead of one recommendation, each step in the skill's
 * own "Prompt =" format under a heading so the reply can be split.
 */
export function buildAsk(skill: string, maxSteps: number): string {
  return [
    `${skill} What's next? Read the project's state as you normally would.`,
    `Then, instead of a single recommendation, list the next steps in my workflow in the order I should take them:`,
    `the step you recommend first, then any parallel options, then the steps that follow it. At most ${maxSteps} steps.`,
    `For each step write exactly this, and nothing before the first heading or after the last fence:`,
    ``,
    `### <short title, under 60 characters>`,
    `<one sentence on why it comes at this point>`,
    `Prompt =`,
    '```',
    `<the ready-to-paste prompt for that step, written by your prompt rules>`,
    '```',
  ].join('\n')
}

function cleanTitle(line: string): string {
  const plain = line
    .replace(/^\s*\d+[.)]\s*/, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
  // Cut by code point so an emoji is never split into a lone surrogate.
  return Array.from(plain).slice(0, 80).join('')
}

/**
 * Splits the skill's reply into steps: one per `##`-`####` heading that has a
 * fenced prompt under it. A reply with no such heading (the skill's usual
 * single recommendation) yields one step per fenced block. At most `max`.
 */
export function parseSteps(output: string, max: number): NextStep[] {
  const text = output.replace(/\r\n?/g, '\n')
  const steps: NextStep[] = []
  for (const section of text.split(/^#{2,4}[ \t]+/m).slice(1)) {
    const newline = section.indexOf('\n')
    const title = cleanTitle(newline === -1 ? section : section.slice(0, newline))
    const body = newline === -1 ? '' : section.slice(newline + 1)
    const fence = FENCE.exec(body)
    const prompt = fence?.[1]?.trim() ?? ''
    if (fence === null || title === '' || prompt === '') continue
    const why = body
      .slice(0, fence.index)
      .replace(/^\s*Prompt\s*=\s*$/gim, '')
      .replace(/\s+/g, ' ')
      .trim()
    steps.push({ title, why, prompt })
  }
  if (steps.length === 0) {
    for (const match of text.matchAll(FENCES)) {
      const prompt = match[1]?.trim() ?? ''
      if (prompt !== '') steps.push({ title: cleanTitle(prompt.split('\n')[0] ?? ''), why: '', prompt })
    }
  }
  return steps.slice(0, max)
}

function isStep(value: unknown): value is NextStep {
  if (typeof value !== 'object' || value === null) return false
  const step = value as Record<string, unknown>
  return typeof step.title === 'string' && typeof step.why === 'string' && typeof step.prompt === 'string'
}

/** Reads a list kept in `$.store` by an earlier session; anything malformed is dropped. */
export function parseCached(value: unknown): Pick<NextList, 'steps' | 'updatedAt'> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const cached = value as Record<string, unknown>
  if (!Array.isArray(cached.steps) || !cached.steps.every(isStep)) return undefined
  if (typeof cached.updatedAt !== 'number' || !Number.isFinite(cached.updatedAt)) return undefined
  return { steps: cached.steps, updatedAt: cached.updatedAt }
}

export type Config = {
  skill: string
  maxSteps: number
  refreshOnStart: boolean
  allowedTools: string
  model: string
}

const DEFAULTS: Config = {
  skill: '/ask-sean',
  maxSteps: 5,
  refreshOnStart: true,
  allowedTools: 'Bash(git:*),Bash(gh:*),Read,Glob,Grep',
  model: '',
}

/** Parses the manifest's userConfig values; a value out of range falls back to its default. */
export function parseConfig(options: Readonly<Record<string, unknown>>): Config {
  const skill = typeof options.skill === 'string' && /^\/[\w:.-]+$/.test(options.skill.trim())
    ? options.skill.trim()
    : DEFAULTS.skill
  const rawMax = options.maxSteps
  const maxSteps = typeof rawMax === 'number' && Number.isInteger(rawMax) && rawMax >= 1 && rawMax <= 9
    ? rawMax
    : DEFAULTS.maxSteps
  const refreshOnStart = typeof options.refreshOnStart === 'boolean' ? options.refreshOnStart : DEFAULTS.refreshOnStart
  const tools = typeof options.allowedTools === 'string'
    ? options.allowedTools.split(',').map(tool => tool.trim()).filter(tool => tool !== '')
    : []
  const allowedTools = tools.length > 0 ? tools.join(',') : DEFAULTS.allowedTools
  const model = typeof options.model === 'string' && /^[\w.:\-[\]]*$/.test(options.model.trim())
    ? options.model.trim()
    : DEFAULTS.model
  return { skill, maxSteps, refreshOnStart, allowedTools, model }
}
