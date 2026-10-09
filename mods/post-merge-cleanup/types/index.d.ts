/** Whether this session's start-up check for a merged PR has run: at start, or at the first attach. */
export type HasChecked = boolean

declare module 'claude-code' {
  interface PluginState {
    'post-merge-cleanup': {
      hasChecked: HasChecked
    }
  }
}
