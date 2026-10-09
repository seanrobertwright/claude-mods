// Servers other sessions of the project run, through their entries in the shared store,
// and the system prompt's section on what runs.

import type { PeerEntry } from '../types'
import { OUTPUT_TOOL, RESTART_TOOL } from './tools'

/** How often a session refreshes its own entries, and how old another's may be before it is ignored. */
export const REFRESH_MS = 30_000
export const STALE_MS = 90_000

export const COMPOSE_ID = 'dev-server-manager:servers'

/** The store key of a running server's entry: per project and name. */
export function peerKey(root: string, name: string): string {
  return `${peerPrefix(root)}${name}`
}

export function peerPrefix(root: string): string {
  return `running:${root}:`
}

function isEntry(value: unknown): value is PeerEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.sessionId === 'string' && typeof entry.name === 'string' && typeof entry.command === 'string' &&
    typeof entry.port === 'number' && typeof entry.url === 'string' && typeof entry.refreshedAt === 'number'
}

/** Other sessions' entries, malformed and stale ones (not refreshed for 90 s) left out. */
export function otherSessions(values: readonly unknown[], sessionId: string, now: number): PeerEntry[] {
  return values.filter(isEntry).filter(entry => entry.sessionId !== sessionId && now - entry.refreshedAt < STALE_MS)
}

/** A server the section names. */
export type Running = { name: string; command: string; url: string; state: string }

/** The `prompt.compose` section while anything runs: each server's command, URL and state, and the two tools. */
export function composeText(running: readonly Running[]): string | undefined {
  if (running.length === 0) return undefined
  return [
    'Dev servers: the dev-servers pane started these, so do not start another copy of one.',
    ...running.map(server => `- ${server.name}: ${server.command}, ${server.url === '' ? 'no URL yet' : server.url}, ${server.state}`),
    `Read a server output with ${OUTPUT_TOOL}; restart one with ${RESTART_TOOL}.`,
  ].join('\n')
}
