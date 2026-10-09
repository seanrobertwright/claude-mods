/** A name the band offers for the session, made by rules from its first prompt. */
export type SessionName = string

declare module 'claude-code' {
  interface PluginState {
    'session-auto-namer': {
      /** The name the band offers, or null when it offers none. */
      suggestion: SessionName | null
    }
  }
}
