/** One choice Claude offered: its marker in lower case (`1`, `b`, also for a `B.` line) and a short label. */
export type ReplyOption = { marker: string; label: string }

/** What the last answer asked for, as far as the band can tell. */
export type Reading = {
  isQuestion: boolean
  hasRecommendation: boolean
  options: ReplyOption[]
}

declare module 'claude-code' {
  interface PluginState {
    'quick-reply': {
      reading: Reading | null
      /** The wayfinder map the band offers to take the next ticket of, or null. */
      offer: number | null
    }
  }
}
