/** A step as the skill's reply gives it, before the list it joins names it. */
export type StepDraft = { title: string; why: string; prompt: string }

/** A listed step; `id` is unique across lists, so two steps with one prompt stay apart. */
export type NextStep = StepDraft & { id: string }

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
      /** The step this session is working on: its prompt was submitted here. */
      active: NextStep | null
      /** Counts the glow timer's beats; a write redraws the active step's shimmer. */
      tick: number
    }
  }
}
