/** Archon's six run statuses. A run ends when it completes, fails or is cancelled. */
export type Status = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'

/** One decision an approval declares, in the workflow's order and words. */
export type Decision = {
  id: string
  label: string
}

/** Why a paused run waits, read from `metadata.approval`: an approval, or a sub-run's pause. */
export type Gate = {
  nodeId: string
  message: string
  /** Archon's gate type: `approval`, `interactive_loop`, `container_writeback`, `child_workflow`, ... */
  type: string
  decisions: Decision[]
  /** The sub-run a `child_workflow` gate waits on; '' for any other gate. */
  childRunId: string
  /** Whether a reject has a rework step to go to, so it does not cancel the run. */
  hasRework: boolean
  /** A loop gate whose round said it is done: a bare approve finishes the loop. */
  isRoundDone: boolean
  /** Whether Archon could read the gate: it names its node and its type. */
  isReadable: boolean
  /** Milliseconds since the epoch the run began to wait; 0 when unknown. */
  since: number
}

/** A wait node's pause, read from `metadata.wait`. */
export type Wait = {
  /** `attention` waits on the person (action needed); `time` and `event` do not. */
  kind: string
  nodeId: string
  message: string
  /** The ISO time a time wait waits until; '' otherwise. */
  until: string
  /** The event an event wait waits for; '' otherwise. */
  event: string
  since: number
}

/** One run as Archon lists it, read at the boundary. */
export type Run = {
  id: string
  workflow: string
  status: Status
  /** The run's `user_message`, on one line. */
  message: string
  startedAt: number
  /** 0 while the run has not ended. */
  completedAt: number
  lastActivityAt: number
  codebaseId: string
  workingPath: string
  outputRoot: string
  /** The run that started this one; '' unless this is a sub-run. */
  parentId: string
  /** The parent's `workflow:` node that started this sub-run; '' when unknown. */
  parentNodeId: string
  adoptedFromId: string
  /** Where the run was started: `metadata.workflow_source.origin`. */
  origin: string
  /** The run's frozen workflow source: `metadata.workflow_source.root`. */
  sourceRoot: string
  /** True for a run started from the web UI or a chat: its `parent_conversation_id` is set. */
  hasConversation: boolean
  /** The chat platform a run was started from (`slack`, `telegram`, `github`); '' for the CLI and the web UI. */
  platform: string
  isContainer: boolean
  approval: Gate | null
  wait: Wait | null
  costUsd: number
}

/** A run event the pane keeps: node markers, gates, and each tool call's node. */
export type RunEvent = {
  type: string
  step: string
  at: number
  output: string
  error: string
  /** A loop group's round; 0 outside a loop. */
  iteration: number
  decision: string
  text: string
  reason: string
  durationMs: number
  costUsd: number
}

/** A file a run kept, under `artifacts/runs/<id>/`. */
export type RunFile = {
  path: string
  size: number
  modifiedAt: number
}

/** What the pane knows of one run beyond its row. */
export type Detail = {
  events: RunEvent[]
  files: RunFile[]
  transcriptPath: string
  /** Whether the run's working path still exists; resume is withheld when it does not. */
  isWorkingPathThere: boolean
}

/** One node of a run's graph, read from its frozen workflow source. */
export type GraphNode = {
  id: string
  deps: string[]
  /** `command`, `prompt`, `bash`, `script`, `loop`, `loop_group`, `approval`, `wait`, `workflow`, `include`, ... */
  kind: string
  /** The include block this node came from (`deliver` for `deliver__fix`); '' when none. */
  block: string
  /** The sub-workflow a `workflow:` node starts; '' otherwise. */
  workflow: string
  /** A loop group's body, by the body's own ids. */
  body: GraphNode[]
}

export type Requirement = {
  state: 'unchecked' | 'ok' | 'missing' | 'old'
  /** The CLI as it is run: the setting, `archon`, or the path in `~/.archon/bin`. */
  path: string
  version: string
}

/** The session's place among Archon's projects. */
export type Project = {
  /** The primary checkout. */
  primary: string
  /** The top level of the session's folder: a linked worktree's own folder. */
  top: string
  branch: string
  /** The project's codebase ids; empty when this folder is in no project. */
  ids: string[]
  /** Which source matched `ids`; a server match is kept. */
  from: '' | 'server' | 'cli'
}

/** Everything polled, kept across a reload. */
export type ArchonData = {
  status: 'idle' | 'loading'
  /** Bumped by each load and by session.start; a load whose id is no longer current is dropped. */
  loadId: number
  requirement: Requirement
  project: Project | null
  source: '' | 'server' | 'cli'
  /** When the last load came back; 0 before it. */
  loadedAt: number
  error: string
  /** This project's runs, their sub-runs and any parent brought in by id. */
  runs: Run[]
  /** Other projects: live runs, and the runs that need you. */
  others: { live: number; needsYou: number }
  /** Every listed run id on the machine, for pruning toast claims. */
  listed: string[]
  /** What each run looked like at the last poll, to fetch details only for rows that changed. */
  seen: Record<string, string>
  details: Record<string, Detail>
  /** Each run's graph, read once from its frozen source; null when it could not be read. */
  graphs: Record<string, GraphNode[] | null>
}

export type Tab = 'runs' | 'graph' | 'log' | 'archon-log'

/** What the person is looking at, kept across a reload. */
export type ArchonView = {
  tab: Tab
  /** Each sub-tab's own scroll position. */
  at: Record<Tab, number>
  /** The picked run; '' for none. */
  run: string
  /** The node Log is cut to; '' for all nodes. */
  node: string
  /** The one open fold in Log, by row key. */
  fold: string
  /** The file read in Log; '' for the log itself. */
  file: string
  isFilesOpen: boolean
  /** Fan-outs listed child by child: a parent run id (Runs) or `<run>:<node>` (Graph). */
  fanouts: string[]
  /** Include blocks expanded in the Graph, `<run>:<block>`. */
  includes: string[]
  /** The loop group picked in the Graph, `<run>:<group>`, and the round shown (0 = the current one). */
  loop: string
  round: number
}

/** One row of a run log. */
export type LogRow = {
  key: string
  kind: 'tool' | 'text' | 'start' | 'end' | 'skip' | 'exec' | 'output' | 'error' | 'note'
  /** The nodes open when the row was written; a tool row's node comes from the events. */
  nodes: string[]
  /** The nth tool row of the run, from 0; -1 for any other row. */
  tool: number
  text: string
  /** What a fold behind `▸` holds; '' for none. */
  full: string
}

/** The run log in front: the newest 60,000 drawn characters of one run. */
export type LogWindow = {
  runId: string
  rows: LogRow[]
  /** Rows dropped off the top. */
  dropped: number
  /** Whole transcript lines taken, so a replay after a reload skips them. */
  taken: number
  /** Nodes open at the last line taken, and how many tool rows came before it. */
  open: string[]
  tools: number
  /** The run's end line once its follower exits; '' while it goes. */
  end: string
  isMissing: boolean
  /** The node a replay filled the window with; '' for the run's newest rows. */
  node: string
}

/** Archon's log, as followed while its sub-tab is in front. */
export type ServeLog = {
  lines: string[]
  size: number
  isMissing: boolean
}

/** An action pressed and waiting on its confirming button. */
export type Pending = {
  runId: string
  kind: 'answer' | 'resume' | 'abandon'
  /** The decision an answer sends: `approve`, `reject`, or another declared one. */
  decision: string
  label: string
}

/** A line the action area shows under a run's buttons. */
export type Notice = {
  text: string
  tone: 'dim' | 'error' | 'done'
}

export type ArchonActions = {
  pending: Pending | null
  /** Typed comments, by run. */
  text: Record<string, string>
  /** The run an action is being sent for; '' for none. */
  sending: string
  notices: Record<string, Notice[]>
  /** `▶ resumed by you 14:05` and the like, by run, kept while the run is in front. */
  records: Record<string, string[]>
  /** A `--detach` answer or resume to check on after 30 s, by run. */
  checks: Record<string, { kind: 'answer' | 'resume'; at: number; polls: number; log: string; text: string; isChat: boolean }>
}

declare module 'claude-code' {
  interface PluginState {
    'archon-panel': {
      data: ArchonData
      view: ArchonView
      log: LogWindow
      serveLog: ServeLog
      actions: ArchonActions
      /** True once this session's start-up load has run: at start, or at the first attach. */
      hasStartedUp: boolean
      /** When this session started; finishes and failures before it never toast. */
      startedAt: number
    }
  }
}
