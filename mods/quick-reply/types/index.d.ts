/** One choice Claude offered: its marker in lower case (`1`, `b`, also for a `B.` line) and a short label. */
export type ReplyOption = { marker: string; label: string }

/** What the last answer asked for, as far as the band can tell. */
export type Reading = {
  isQuestion: boolean
  /** Whether it asks for a pass/fail verdict on a test or a check, as a UAT step does. */
  asksForVerdict: boolean
  hasRecommendation: boolean
  options: ReplyOption[]
}

declare module 'claude-code' {
  interface PluginState {
    'quick-reply': {
      reading: Reading | null
      /** The wayfinder map the band offers to take the next ticket of, or null. */
      offer: number | null
      /** The Jev key's problem the band names under the replies until the next prompt (the client's KeyProblem), or null. */
      keyNote: 'absent' | 'malformed' | 'rejected' | null
    }
  }
}
