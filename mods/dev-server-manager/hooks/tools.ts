// The two tools the mod offers the model: read a server's output, restart a server.
// The mod's own hooks answer them; the model cannot start or stop a server.

import type { OutputLine, ServerStatus } from '../types'
import { currentRun } from './output'

export const OUTPUT_TOOL = 'mcp__dev-server-manager__output'
export const RESTART_TOOL = 'mcp__dev-server-manager__restart'

/** The lines `output` gives by default, and the most it gives. */
export const DEFAULT_LINES = 100
export const MOST_LINES = 500
/** How long `restart` waits for the new run's URL or exit. */
export const RESTART_WAIT_MS = 30_000

export const OUTPUT_SPEC = {
  name: 'output',
  description:
    "Read a dev server's recent output, for the servers the dev-servers pane runs (see the Dev servers section of the system prompt). " +
    'Answers with the server, its command, state, URL and last exit code, then the last lines of its current run (100 by default, 500 at most). ' +
    'With server left out, it reads the one running server.',
  inputSchema: {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'The server, by its name in the pane.' },
      lines: { type: 'integer', minimum: 1, maximum: MOST_LINES, description: 'How many of the last lines to read (default 100, at most 500).' },
    },
  },
  isDeferred: true,
} as const

export const RESTART_SPEC = {
  name: 'restart',
  description:
    'Restart a dev server the dev-servers pane runs, or one that crashed, then wait up to 30 s for its URL and answer with its new output. ' +
    'It cannot start a stopped server or stop one: the person does that from the pane.',
  inputSchema: {
    type: 'object',
    properties: { server: { type: 'string', description: 'The server, by its name in the pane.' } },
    required: ['server'],
  },
  isDeferred: true,
} as const

/** A server as the tools describe it. */
export type ToolServer = {
  name: string
  command: string
  status: ServerStatus
  url: string
  lastExit: number | null
  lines: readonly OutputLine[]
}

/** The `lines` argument read at the boundary: 100 when absent or not a number, between 1 and 500. */
export function lineCount(value: unknown): number {
  const count = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : DEFAULT_LINES
  return Math.min(MOST_LINES, Math.max(1, count))
}

/** `output`'s answer: the header, then the current run's last `count` lines. */
export function outputText(server: ToolServer, count: number): string {
  const run = currentRun(server.lines).slice(-count)
  const header = [
    `Server: ${server.name}`,
    `Command: ${server.command}`,
    `State: ${server.status}`,
    `URL: ${server.url === '' ? 'none yet' : server.url}`,
    `Last exit code: ${server.lastExit ?? 'none'}`,
  ]
  const body = run.length === 0 ? ['It has printed nothing in its current run.'] : [`Output, the last ${run.length} lines of the current run:`, ...run.map(line => line.text)]
  return [...header, ...body].join('\n')
}
