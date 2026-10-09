/**
 * Where a server stands: `starting` until its first local URL, `port taken`
 * when the check found a listener, `crashed` after a death the mod did not
 * restart from, `exited` after a clean exit (0).
 */
export type ServerStatus = 'stopped' | 'starting' | 'running' | 'port taken' | 'crashed' | 'exited'

/** Where a row comes from: a package.json script, or `/dev-servers add`. */
export type RowSource = 'detected' | 'added'

/** A row of the pane as the project defines it, before anything runs. */
export type RowDef = {
  name: string
  source: RowSource
  /** The command and its arguments; a detected row's manager is '' while lockfiles conflict. */
  argv: string[]
  /** Relative to the project's root; '' for the root. */
  cwd: string
  /** The port declared with --port, else learned from an earlier run; 0 when unknown. */
  port: number
  /** Why it cannot start, shown in yellow (conflicting lockfiles); '' when it can. */
  blocked: string
}

/** The rows of the session's project, and the detected rows the person hid. */
export type Rows = {
  defs: RowDef[]
  hidden: string[]
}

/** One death of a server: when, how it ended, and the lines picked as its error. */
export type Death = {
  at: number
  code: number | null
  signal: string | null
  /** The command as the row shows it. */
  command: string
  /** The last lines of the run that died, ANSI stripped, cut to the error's cap. */
  lines: string[]
}

/** A server this session runs or ran: what its row shows beside its definition. */
export type ServerRun = {
  status: ServerStatus
  /** The first local URL the current run printed; '' before it. */
  url: string
  /** When the current run started; 0 before the first. */
  startedAt: number
  /** When it last ended (exited or crashed); 0 while it runs. */
  endedAt: number
  /** The port it was expected on when it moved to another by itself; 0 when it did not. */
  movedFrom: number
  /** Brought back by a fresh module after a reload killed it. */
  isAfterReload: boolean
  /** Yellow words: a command that could not start, `port not checked`; '' for none. */
  problem: string
  /** The listener holding its port, as the row names it (`node.exe 18244`); '' when unknown. */
  holder: string
  /** The deaths since the person last handled it, oldest first. */
  crashes: number[]
  /** The automatic restarts in the last two minutes, oldest first. */
  restarts: number[]
  /** The restart cap is spent: it stays crashed. */
  isGaveUp: boolean
  /** The latest death, which the error → prompt button fills; null before one. */
  death: Death | null
  /** The dim note and button a running server keeps after an automatic restart. */
  hasNote: boolean
  /** The last exit code the mod read through to; null before one. */
  lastExit: number | null
}

/** One kept line of a server's output, or a divider between its runs. */
export type OutputLine = {
  /** Counts up across the session, so a pinned view keeps its place as old lines drop. */
  seq: number
  stream: 'stdout' | 'stderr' | 'divider' | 'note'
  text: string
  at: number
  /** One of the lines a death picked as its error. */
  isError?: boolean
}

/** The pane's own place: the picked row and where its output stands. */
export type PaneView = {
  picked: string | null
  /** The seq of the first output line drawn while pinned; null while following the tail. */
  anchor: number | null
  isShowingHidden: boolean
  /** The prompt box could not be reached from this surface. */
  isFillRefused: boolean
}

/** A server another session of this project runs, as its store entry says. */
export type PeerEntry = {
  sessionId: string
  name: string
  command: string
  port: number
  url: string
  /** When that session last refreshed it; ignored once 90 s old. */
  refreshedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'dev-server-manager': {
      rows: Rows
      /** By server name: the servers this session started. */
      runs: Record<string, ServerRun>
      /** By server name: the last 500 lines across the session, written in batches. */
      output: Record<string, OutputLine[]>
      view: PaneView
      /** Other sessions' running servers, as the last refresh read them. */
      peers: PeerEntry[]
    }
  }
}
