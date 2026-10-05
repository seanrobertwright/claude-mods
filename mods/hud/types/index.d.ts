/** One rate-limit window as the engine reports it. */
export type Limit = { kind: string; percent: number; resetsAt: string | null }

/** The working tree's state, from one `git status`. */
export type Git = { branch: string; changed: number; ahead: number; behind: number }

/** The figures the row shows, as last read. */
export type HudView = {
  model: string
  /** How hard the last request asked the model to think; null until a request has gone out, or for a model that takes none. */
  effort: string | null
  /** The context window's fill, 0-100; null until the engine has a reading. */
  contextPercent: number | null
  limits: Limit[]
  costUsd: number | null
  /** When the session began; 0 until first read. */
  startedAt: number
  /** Null outside a git repository. */
  git: Git | null
  folder: string
  /** Subagents running now. */
  agents: number
  toolsTurn: number
  toolsSession: number
  isWorking: boolean
  turnStartedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    hud: { view: HudView; frame: number }
  }
}
