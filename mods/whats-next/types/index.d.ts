/** A step as the skill's reply gives it, before the list it joins names it. */
export type StepDraft = { title: string; why: string; prompt: string }

/** A listed step; `id` is unique across lists, so two steps with one prompt stay apart. */
export type NextStep = StepDraft & { id: string }

export type NextList = {
  /** `unavailable`: a requirement is missing; `error` names it and the fix. */
  status: 'idle' | 'loading' | 'error' | 'unavailable'
  steps: NextStep[]
  /** Milliseconds since the epoch of the last successful refresh. */
  updatedAt: number
  error: string
  /** Bumped by each refresh; a run whose id is no longer current is dropped. */
  runId: number
  /**
   * The id of the step this session is working on (its prompt was submitted
   * here), or null. It lives in the list so one guarded write moves it with the
   * steps it names: a superseded refresh can change neither.
   */
  activeId: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'whats-next': {
      list: NextList
      selected: NextStep | null
      /** True once this session's start-up work has run: at start, or at the first attach. */
      hasStartedUp: boolean
      /** Counts the glow timer's beats; a write redraws the active step's shimmer. */
      tick: number
    }
  }
}
