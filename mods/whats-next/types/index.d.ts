export type NextStep = { title: string; why: string; prompt: string }

export type NextList = {
  status: 'idle' | 'loading' | 'error'
  steps: NextStep[]
  /** Milliseconds since the epoch of the last successful refresh. */
  updatedAt: number
  error: string
  /** Bumped by each refresh; a run whose id is no longer current is dropped. */
  runId: number
}

declare module 'claude-code' {
  interface PluginState {
    'whats-next': {
      list: NextList
      selected: NextStep | null
      /** True once this session's start-up work has run: at start, or at the first attach. */
      hasStartedUp: boolean
    }
  }
}
