/** A resume waiting on the clock. */
export type Pending = {
  /** Milliseconds since the epoch at which the resume prompt is sent. */
  resumeAt: number
  /** Why it waits, as the band and status line say it. */
  reason: string
}

declare module 'claude-code' {
  interface PluginState {
    'auto-resume': {
      pending: Pending | null
      /** Resumes sent since the last successful answer. */
      attempts: number
      /** The clock as of the last tick, so the countdown redraws. */
      now: number
    }
  }
}
