/** One choice Claude offered: its marker as written (`1`, `b`) and a short label. */
export type ReplyOption = { marker: string; label: string }

/** What the last answer asked for, as far as the band can tell. */
export type Reading = {
  isQuestion: boolean
  hasRecommendation: boolean
  options: ReplyOption[]
}

declare module 'claude-code' {
  interface PluginState {
    'quick-reply': { reading: Reading | null }
  }
}
