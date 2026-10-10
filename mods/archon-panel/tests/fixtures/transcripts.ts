// Hand-built JSONL transcripts as `archon workflow logs <id>` prints them
// (docs/research/archon-api.md § The CLI: one object per line, each with a
// `type` and an ISO `ts`).

import { iso, T0 } from './runs'

const at = (s: number) => iso(T0 + s * 1000)
export const line = (type: string, fields: Record<string, unknown>, s = 0) => JSON.stringify({ type, ts: at(s), ...fields })

/** A README the model wrote: 35 KB on one line, as a Write tool's input. */
export const README = `# Widgets\n\n${'A widget is a small thing. '.repeat(1330)}`

/** A chain run: plan, then publish. */
export const CHAIN = [
  line('workflow_start', { workflow_name: 'archon-plan', content: 'Plan the widget' }),
  line('node_start', { step: 'plan', execution: { node: { id: 'plan', kind: 'command' } } }, 1),
  line('assistant', { content: 'I will look at the repo first.\nThen write the plan.' }, 2),
  line('tool', { tool_name: 'Bash', tool_input: { command: 'git status --short && ls -la', description: 'Look around' } }, 3),
  line('tool', { tool_name: 'Write', tool_input: { file_path: 'mods/widgets/README.md', content: README } }, 4),
  line('tool', { tool_name: 'Edit', tool_input: { file_path: 'mods/widgets/README.md', old_string: 'a widget', new_string: 'one widget' } }, 5),
  line('node_complete', { step: 'plan', execution: { node: { id: 'plan', kind: 'command' } }, duration_ms: 125_000, cost_usd: 0.42 }, 126),
  line('node_start', { step: 'publish', execution: { node: { id: 'publish', kind: 'command' } } }, 127),
  line('assistant', { content: 'Published.' }, 128),
  line('node_complete', { step: 'publish', execution: { node: { id: 'publish', kind: 'command' } }, duration_ms: 3_000, cost_usd: 0.01 }, 130),
  line('workflow_complete', { cost_usd: 4.12, tokens: 1000 }, 131),
].join('\n') + '\n'

/** A fan-out: two reviewers open at once, model text written while both are, and a tool row each. */
export const FAN = [
  line('node_start', { step: 'code', execution: { node: { id: 'code', kind: 'command' } } }, 1),
  line('node_start', { step: 'docs', execution: { node: { id: 'docs', kind: 'command' } } }, 1),
  line('assistant', { content: 'Reviewing both at once.' }, 2),
  line('tool', { tool_name: 'Read', tool_input: { file_path: 'src/code.ts' } }, 3),
  line('tool', { tool_name: 'Grep', tool_input: { pattern: 'TODO', path: 'docs' } }, 4),
  line('node_complete', { step: 'code', duration_ms: 60_000, cost_usd: 0.1 }, 61),
  line('node_complete', { step: 'docs', duration_ms: 61_000, cost_usd: 0.1 }, 62),
].join('\n') + '\n'

/** A bash node's printout, with heartbeats between. */
export const EXEC = [
  line('node_start', { step: 'test', execution: { node: { id: 'test', kind: 'bash' } } }, 1),
  line('watchdog_reset', {}, 2),
  line('exec_output', { stdout_tail: Array.from({ length: 30 }, (_, i) => `ok ${i + 1}`).join('\n'), stderr_tail: 'warn: slow test', exit_code: 0 }, 3),
  line('watchdog_reset', {}, 4),
  line('node_complete', { step: 'test', duration_ms: 4_000, cost_usd: 0 }, 5),
].join('\n') + '\n'

/** A run whose model text runs past 60,000 drawn characters: 80 rows of 1,000. */
export const BIG = [
  line('node_start', { step: 'write', execution: { node: { id: 'write', kind: 'prompt' } } }, 1),
  ...Array.from({ length: 80 }, (_, i) => line('assistant', { content: `row ${String(i).padStart(2, '0')} ${'x'.repeat(993)}` }, 2 + i)),
].join('\n') + '\n'
