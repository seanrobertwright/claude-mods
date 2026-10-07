/** How a run or a node stands. `other` is a status Archon reports that the pane has no word for. */
export type State = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'pending' | 'other'

/** One step of a run, folded from the node events of its transcript. */
export type RunNode = {
  id: string
  state: State
}

export type Run = {
  id: string
  workflow: string
  state: State
  /** What the run was started with, on one line. */
  message: string
  startedAt: number
  /** 0 while the run is going. */
  endedAt: number
}

export type ArchonView = {
  status: 'idle' | 'loading' | 'error' | 'unavailable'
  runs: Run[]
  /** The run whose nodes are shown; '' for none. */
  selected: string
  /** Nodes by run id, for the runs that were live or selected at the last load. */
  nodes: Record<string, RunNode[]>
  error: string
  /** Milliseconds since the epoch of the last successful load; 0 before it. */
  updatedAt: number
  /** Bumped by each load; a load whose id is no longer current is dropped. */
  runId: number
}

declare module 'claude-code' {
  interface PluginState {
    'archon-panel': {
      view: ArchonView
      /** True once this session's start-up load has run: at start, or at the first attach. */
      hasStartedUp: boolean
    }
  }
}
