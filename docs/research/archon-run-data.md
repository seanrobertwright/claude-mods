# What an Archon run records: its graph, run log, files and project

Research for issue #109, a ticket of the archon-panel v2 map (#107).
It covers what a run keeps that the pane would draw: its node graph, its run log, the files it wrote and the project it belongs to, plus where Archon's own logs go.
It builds on `docs/research/archon-api.md` (routes, the SSE stream, the CLI and the transcript's row types) and does not repeat it.
Answered from Archon's source at tag `v0.11.1` (commit `aa09544`) and from read-only probes on this machine, with one `archon-plan` run live during the probes (it finished as they ended).
No run was approved, rejected, cancelled or resumed, and the database was read from a copy.

How sources are cited:

- **[src: path]** is Archon's source at `v0.11.1`, relative to `packages/`.
- **[repo: path]** is a file at the root of Archon's repository at `v0.11.1`, such as the bundled workflows under `.archon/workflows/`.
- **[probe]** is a read-only look at this machine: `~/.archon` (v0.11.1, SQLite), `archon serve` on `:3090` and the CLI. There were three runs: two `archon-assist` runs and one `archon-plan` run that was running for most of the probes.
- **[archon-api]** is `docs/research/archon-api.md`, and **[pane]** is `docs/research/pane-capabilities.md`.
- **[skill: path]** is the `archon-cli` project skill under `.claude/skills/archon-cli/`.

## Short answer

- **Graph.** No run stores its graph as data.
  Each run does freeze its **workflow source**, a copy of every workflow and command it could see, in its own folder, with a digest on the run row.
  The run's YAML in that copy is the graph that run executes, even after the workflow is edited [src: `workflows/src/executor.ts`, `workflows/src/schemas/workflow-run.ts`] [probe].
  Archon's web UI draws a run's graph from the **live** workflow instead, so it drifts after an edit [src: `web/src/experiments/console/skills/workflows.ts`].
  Two things make the YAML differ from what runs: `include:` nodes are expanded into the run as `<includeId>__<nodeId>`, and loops and fan-outs add iterations at run time [src: `workflows/src/include-expander.ts`].
- **Shape of the bundled workflows.** There are 31 `archon-*` workflows, with a median of 6 top-level nodes and a maximum of 22.
  At most 6 nodes run side by side.
  With includes expanded, `archon-ship` runs 61 graph entries, the largest.
  None uses a `workflow:` node (a sub-run) or `fan_out`, and only `archon-interactive-prd` has approval nodes [repo: `.archon/workflows/`] [probe].
- **Run log.** The model's text exists only in the transcript, `<output_root>/logs/<runId>.jsonl`.
  Tool calls are in both the transcript and the events table, with their inputs but **never their results**.
  Each node's output and error are in the events table [src: `workflows/src/logger.ts`, `workflows/src/node-record-serialization.ts`] [probe].
  The transcript is appended one whole line per event and can be read while the run is going.
  Nothing caps its size: the two longer one-node agent runs wrote 4 to 7 KB a minute, three-quarters or more of it tool inputs, and a single line can be as large as a file the model wrote [probe].
- **Files.** A run's files are `<output_root>/artifacts/runs/<runId>/`, listed live by `GET /api/runs/{id}/artifacts`, which hides only the engine's `.archon/` store [src: `server/src/routes/api.ts`] [probe].
  A PR link is not recorded as data: the bundled workflows write a PR's number to `$ARTIFACTS_DIR/.pr-number`.
  The `workflow_artifact` event that could carry a URL is never emitted in v0.11.1 [src: `workflows/src/event-emitter.ts`] [repo: `.archon/workflows/`].
  Changes a run made to the checkout are recorded only as the baseline commit it started from [probe].
- **Project.** A run names its project four ways: `codebase_id`, `working_path`, `output_root` and `metadata.workflow_source.origin`.
  These paths are written with either kind of slash, depending on what launched the run [probe].
  That spelling is why the CLI's project scoping failed here: Archon compares paths as exact strings, and `git` reports `D:/repos/claude-mods` while the project is registered as `D:\repos\claude-mods` [src: `core/src/services/codebase-checkout-resolver.ts`, `core/src/db/codebases.ts`] [probe].
  A session opened inside a run's worktree shares the project's Git directory, and its folder equals that run's `working_path` [probe].
- **Archon's own logs.** Archon writes no log file.
  It logs newline-delimited JSON (pino) to stdout [src: `paths/src/logger.ts`].
  `~/.archon/logs/serve.log` exists only because this machine's start-up script redirects `archon serve` into it [probe].
  A detached CLI run appends its own output to `~/.archon/logs/detached-run-<conversation id>.log` [src: `cli/src/commands/workflow.ts`].

## 1. The graph

### Where a run's graph comes from

| Source | What it gives | Notes |
| --- | --- | --- |
| The run's workflow source: `metadata.workflow_source.root` | The YAML the run executes: nodes, `depends_on`, `when`, `trigger_rule`, loops, approvals | `<output_root>/workflow-source/runs/<runId>/`. It holds `manifest.json` (`workflow_name`, `scopes`, `digest`, `file_count`, `byte_count`) and a `bundled/`, `global/` or project folder of workflows and commands [probe] |
| `metadata.terminal_graph` | `node_ids` (the end nodes) and `returns` | Only the end of the graph [archon-api] [probe] |
| Node events (`node_started`, `node_completed`, `node_failed`, `node_skipped`) | Each node's state, keyed by `step_name` | A `loop_group`'s body nodes are `<groupId>.<nodeId>` with `data.iteration`, and the group writes `loop_iteration_*` rows in the events table only. `<node>-iteration-<n>` is only the transcript id of `until_bash` probes and loop watchdog entries, never an event's `step_name` (_corrected for #120; this cell first said loop iterations are `<node>-iteration-<n>`_) [skill: `manage-run/troubleshooting.md`] [src: `workflows/src/dag-executor.ts`] |
| `archon workflow get <id> --json --verbose` | `nodes[]`, one per node that has started, with its state | No `depends_on`, and no node that has not started yet [probe] |
| `GET /api/workflows?cwd=` or `/api/workflows/{name}` | The **live** definition | What the web UI's run graph uses, matched by name [src: `web/src/experiments/console/skills/workflows.ts`] |

- **The source is frozen per run.** A fresh run copies its source before choosing the workflow, then moves the copy into its own folder.
  It records the folder, a digest, the number of files and bytes, and `origin`, the folder it was started from [src: `workflows/src/executor.ts`].
  The copy holds the whole discovery set, not just the one workflow: 129 files and 0.9 MB for the `archon-plan` run, and 374 files and 2.8 MB for a run in Archon's own repository [probe].
  The copied `archon-plan.yaml` matched the tag's file apart from line endings [probe].
- **A workflow edited after its run started.** The run keeps executing its copy.
  A resume checks the copy against the recorded digest and **fails the run** if the copy is missing or altered; it never picks up the edit.
  A run with no record (from before captures existed) is the one case that resumes against the live files, with a warning [src: `workflows/src/executor.ts`, `workflows/src/schemas/workflow-run.ts` `readWorkflowSourceState`].
  So the copy is the graph to draw for any run that has one.
  The web UI's graph comes from the live definition and keeps only the nodes it finds there: a node removed since the run started disappears, and an added one shows as pending [src: `web/src/experiments/console/primitives/workflow-graph.ts` `deriveNodeStatuses`].
- **Finding the run's YAML in the copy.** `manifest.json` names the workflow.
  The file is the one whose `name:` matches, taking a project workflow over a global one, and a global one over a bundled one [src: `workflows/src/include-expander.ts`] [probe].
- **What changes between the YAML and the run:**
  - **`include:`** nodes are replaced at load time by the target's nodes, as top-level `<includeId>__<nodeId>`.
    The include's own `depends_on` attaches to the block's entry nodes, and a node that depends on the include waits on all the block's end nodes [src: `workflows/src/include-expander.ts`].
  - **`loop_group`** nodes hold their own child nodes, which run once per iteration.
    Their events are named `<groupId>.<nodeId>`, with a dot, and carry `data.iteration`, so every round reuses the same names (_corrected for #120_) [src: `workflows/src/dag-executor.ts`, `workflows/src/schemas/dag-node.ts`].
  - **`include:` with `fan_out:`** is expanded only at run time, once per item, as `<nodeId>__<identity>`, all within the same run.
    Its width is unknown until it runs [src: `workflows/src/schemas/dag-node.ts` `composeFanOutNodeSchema`].
  - **`workflow:`** starts a **child run**: its own run row with `parent_run_id`, and its own artifacts, approvals and cost.
    It shares the parent's checkout or has its own worktree (`isolation`), and with `fan_out` it starts one child per item [src: `workflows/src/schemas/dag-node.ts` `workflowNodeSchema`, `workflows/src/child-isolation.ts`].

### Sub-runs

_Added for #120, from the `v0.11.1` source; there are no sub-runs on this machine to probe._

- **Listed as ordinary rows.** Neither `GET /api/dashboard/runs`, `GET /api/workflows/runs` nor `archon workflow runs --json` filters out a child, and children count toward `limit` [src: `core/src/db/workflows.ts` `listDashboardRuns`, `listWorkflowRuns`].
  A child is marked by `parent_run_id` and `metadata.parent_node_id`, plus `child_index` and `fan_out_item_hash` for a fan-out.
  It copies the parent's `codebase_id`, `conversation_id` and `parent_conversation_id`, and its `user_message` is the node's `input:` [src: `workflows/src/executor.ts` `runChildWorkflow`].
- **Run inside the parent's process.** The parent stays `running` while its child runs.
  When the child pauses, the parent pauses on `metadata.approval = {type: 'child_workflow', childRunId}` and writes a `node_suspended` event, but no `approval_requested` row, and `runAttention` reports it as `blocked_on_child` [src: `workflows/src/dag-executor.ts` `pauseParentOnChild`, `workflows/src/schemas/workflow-run.ts` `runAttention`].
- **Answered on the child.** Approving or rejecting the parent is refused with a 400, `Run is paused waiting on sub-run <id>. Approve or reject the child run instead.`, carrying `childRunId` [src: `server/src/routes/api.ts` `pausedGateBlocker`, `core/src/operations/workflow-operations.ts` `assertApprovable`].
  When a child ends by running to completion, failure or cancellation, it resumes its parent in the same process [src: `workflows/src/executor.ts` `maybeResumeParentRun`].
  A child that ends without running, by abandon or by a reject that cancels it, never reaches that hook, so its parent probably stays paused; Archon warns of this on abandon only (inferred, not traced end to end) [src: `server/src/routes/api.ts`].
- **Failure and cancel.** A failed child fails the parent's node (`failure_kind: child_failed`), and a parent resume re-drives a failed child once.
  Abandoning the parent cancels every descendant, but a cancel handled by the process that owns the parent flips only the parent's row [src: `core/src/operations/workflow-operations.ts` `cascadeCancelChildren`].
- **Fan-out.** One child per item, `max_parallel` at a time (default 5), with no cap on the total.
  The parent records one start and one finish for the whole node, and a fan-out child may not pause: a paused one is cancelled and the node fails [src: `workflows/src/dag-executor.ts` `executeFanOutWorkflowNode`].
- **Its own transcript, cost and source.** A child writes `<output_root>/logs/<childId>.jsonl` and freezes its own workflow source.
  The parent's cost already includes its children's [src: `workflows/src/logger.ts`, `workflows/src/dag-executor.ts`].
- **Archon's web UI** lists children flat with a `↳ child` badge and links neither way between parent and child.
  Its graph draws both a `workflow:` node and a `loop_group` as plain boxes [src: `web/src/experiments/console/`].

### Shape of the bundled `archon-*` workflows

Measured from the `archon-plan` run's copy (31 workflows, fixtures left out).
Depth is the longest `depends_on` chain and width the most nodes at one depth, both over top-level nodes before includes are expanded [probe].

| Workflow | Top-level nodes | With includes expanded | Depth | Width | Of note |
| --- | --- | --- | --- | --- | --- |
| `archon-assist`, `archon-plan`, `archon-investigate` | 1 | 1 | 1 | 1 | One command node |
| `archon-triage`, `archon-pr`, `archon-implement` | 2 | 2 | 2 | 1 | `archon-implement` is a script then a loop |
| `archon-validate` | 6 | 6 | 5 | 2 | 3 `when:` branches, 4 into one |
| `archon-review` | 11 | 11 | 6 | 6 | 6 reviewers in parallel, joined by one node |
| `archon-upkeep` | 3 | 55 | 3 | 1 | Includes a pack with 5 `loop_group`s |
| `archon-ship` | 8 | 61 | 5 | 3 | 4 includes, `archon-deliver` among them |
| `archon-deliver` | 21 | 53 | 18 | 2 | 4 includes, 5 `loop_group`s with 15 child nodes |
| The 20 `legacy/` workflows | 1 to 22 | up to 17 for the 3 that include | up to 17 | up to 5 | `archon-fix-github-issue` is the largest (22 nodes, 17 deep) |

- Across all 31, no workflow has a `workflow:` node or a `fan_out`, so no bundled workflow starts a sub-run [probe].
- Approval nodes appear only in `archon-interactive-prd` (3).
  `archon-piv-loop` pauses through interactive loops instead.
  Both are the only workflows marked `interactive: true` [probe].
- The typical graph is a short chain.
  The wide ones are review fan-outs that join into one node, and the large ones are large because of includes and loop groups, which a pane can fold under their prefix or group [probe].

## 2. The run log

### What is kept, and where

| Part | Transcript (`<output_root>/logs/<runId>.jsonl`) | Events table (`remote_agent_workflow_events`) |
| --- | --- | --- |
| The model's text as it runs | `assistant` rows, each message whole | Not kept |
| Tool calls | `tool` rows: `tool_name`, `tool_input` | `tool_called` (`tool_name`, `tool_input`, `tool_call_id`) and `tool_completed` (`tool_outcome`, `duration_ms`) |
| Tool results | Not kept | Not kept: only the outcome (`success`, …) |
| A node's output | Not kept: `node_complete` has the command name, duration, tokens and cost | `node_completed.data.node_output`, plus `structured_output` when declared |
| A bash or script node's printout | `exec_output`: `stdout_tail`, `stderr_tail`, `exit_code`, capped and redacted | In `node_output` as above |
| A node's error | `node_error` | `node_failed.data.error` |
| Hooks and sub-tasks | Not kept | `hook_activity`, `task_activity` |

[src: `workflows/src/logger.ts`, `workflows/src/node-record-serialization.ts`] [skill: `manage-run/troubleshooting.md`] [probe]

- **An agent node's output is stored whole.**
  A bash or script node's output is cut to 32 KB in the event (`node_output_truncated`, `node_output_original_bytes`), and the full text goes to `<artifacts>/.archon/node-output-spills/persisted/<step>.nodeoutput` (`node_output_spill_path`) [src: `workflows/src/dag-executor.ts` `formatPersistedNodeOutput`].
- A node with `output_type:` also gets `nodes/<id>.md` and `nodes/<id>.meta.json` in the run's artifacts [skill: `manage-run/troubleshooting.md`].
- A run that the server executes also keeps its messages in its conversation [archon-api].

### How big it gets

| Run | Duration | Transcript | Lines | Share that is `tool` rows | Largest line |
| --- | --- | --- | --- | --- | --- |
| `archon-assist` (Archon's repo) | 23 s | 5 KB | 9 | 7% | 1.6 KB (`node_complete`) |
| `archon-assist` (this repo) | 8 min | 54 KB | 61 | 76% | 10.7 KB (a `Write` tool's input) |
| `archon-plan` (this repo) | 20 min | 93 KB | 143 | 83% | 35.5 KB (a tool's input) |

[probe]

- Nothing caps the transcript: `assistant` content and `tool_input` are written whole, so a `Write` call puts the whole file it wrote on one line [src: `workflows/src/logger.ts`].
  Only the `exec_output` tails are capped [src: `workflows/src/logger.ts` `logExecOutput`].
- The events table grows faster than the transcript.
  The `archon-plan` run left 2,236 rows over 20 minutes, 2,068 of them `hook_activity` [probe] (see also [archon-api]).
- These runs had one node each, so a 50-node `archon-deliver` run would be many times larger; none was run to measure it.
- **Nothing deletes a transcript.**
  Archon's scheduled cleanup removes worktrees, containers and old sessions only, and deleting a run (`DELETE /api/workflows/runs/{id}`) removes its row but leaves its files [src: `core/src/services/cleanup-service.ts`, `server/src/routes/api.ts`].

### Reading it while the run is going

- Each event is one `appendFile` of a JSON object and a newline, by the process that executes the run [src: `workflows/src/logger.ts` `logWorkflowEvent`].
  Read twice during the live run, the file ended on a newline both times and its last row parsed [probe].
- `archon workflow logs <id> --follow` re-reads from its last byte offset every **500 ms** and stops when the run reaches a final status [src: `cli/src/commands/workflow.ts` `workflowLogsCommand`].
- `$.fs.read` reads a whole file up to 4 MiB, so following a long transcript needs a spawned follower [pane].

## 3. The files a run wrote

- **Artifacts.** `$ARTIFACTS_DIR` is `<output_root>/artifacts/runs/<runId>/` [skill: `manage-run/troubleshooting.md`] [probe].
  - `GET /api/runs/{id}/artifacts` walks it on each call, so it lists files **while the run is going**: the live run's scratch files were listed mid-run [src: `server/src/routes/api.ts`] [probe].
    It leaves out only the engine's own `.archon/` store, which holds typed-artifact records, checkout manifests and output spills; a workflow's own dotfiles stay listed [src: `server/src/routes/api.ts` `isRunArtifactsEngineEntry`].
  - `archon workflow get <id> --json` gives the same list as `leave_behind.artifactFiles`, capped for display, with the engine's files counted in `artifactFilesOmitted.internalFiles` [src: `cli/src/commands/workflow.ts` `buildLeaveBehind`] [probe].
  - When a run ends, its `workflow_completed` event records `terminal_record.artifacts`: the folder and every file with its size, and a typed file's `outputType`.
    `terminal_record.returns` carries the value of the workflow's `returns:` node: for `archon-plan`, `{ready, summary}` [probe].
  - The finished `archon-plan` run listed `plan.md`, `nodes/plan.md` (typed `implementation-plan`) and the scratch files it made [probe].
- **PR links.** No field holds them.
  - The `workflow_artifact` event (`pr`, `commit`, `file_created`, `file_modified`, `branch`, with a `url` or `path`) is defined and relayed by the web and Slack bridges, but nothing in v0.11.1 emits it [src: `workflows/src/event-emitter.ts`, `workflows/src/schemas/workflow-run.ts` `artifactTypeSchema`].
  - The bundled workflows keep a PR's number in `$ARTIFACTS_DIR/.pr-number` and their reports under `review/`, with names such as `plan.md` and `implementation.md`.
    `archon-pr` declares a `pull-request-intent` typed output [repo: `.archon/workflows/`] [probe].
  - Anything else, such as a PR URL printed by `gh pr create`, is only in the node's output or the transcript.
- **Changes to the checkout.** No list is kept.
  The run records `checkout_baseline` (the commit, its tree, `cutFromCommit` for a new worktree, and a manifest of uncommitted files) and each node's `checkoutStart`, but nothing at the end [probe].
  The branch is `leave_behind.branch`, from the isolation row [src: `cli/src/commands/workflow.ts` `buildLeaveBehind`].
  So what a run changed is a Git diff of its working path against the baseline.
  A run whose `working_path` is the person's own checkout, like the `archon-assist` run here, works in it, so its changes mix with theirs [probe].
- **How long they last.** Artifacts and workflow-source copies are never pruned, so each run leaves 1 to 3 MB of source copy behind [src: `core/src/services/cleanup-service.ts`] [probe].
  Worktrees are reclaimed after 14 days without activity or once merged, so a run's `working_path` can disappear while its row stays.
  `leave_behind.worktreeLive` reports it [src: `core/src/services/cleanup-service.ts` `STALE_THRESHOLD_DAYS`, `cleanupMergedWorktrees`] [probe].

## 4. The run's project

### What a run records

| Key | Example from the probes | What it is |
| --- | --- | --- |
| `codebase_id` | `9a4f…` → `/api/codebases[].default_cwd` = `D:\repos\claude-mods` | The registered project. Inherited by a child run [src: `workflows/src/child-isolation.ts`] |
| `working_path` | `D:\repos\claude-mods` (in place), `~\.archon\workspaces\<owner>\claude-mods\worktrees\plan\mod-settings-dialog` (worktree) | Where the run works. A worktree sits at `<output_root>/worktrees/<branch>` |
| `output_root` | `~\.archon\workspaces\<owner>\claude-mods` | Where its transcript, artifacts and source copy live |
| `metadata.workflow_source.origin` | `D:/repos/claude-mods` (CLI), `D:\repos\claude-mods` (web) | The folder the run was started from |
| The run's conversation `cwd` | as `working_path` | `remote_agent_conversations.cwd` |
| The isolation row | `codebase_id`, `working_path`, `branch_name`, `status: active` | `remote_agent_isolation_environments`, one per worktree |

[probe]

- Run ids come in two forms, UUIDs and 32 hex digits, so they are opaque strings [probe].
- **Path spelling varies.** The same folder appeared with backslashes on one run and forward slashes on another.
  Archon's registry stores whatever spelling the project was registered with: `D:\repos\claude-mods` here, and `C:/Users/<user>/Archon` for Archon's own checkout [probe].

### Why the CLI listed every run here

- The CLI resolves the cwd to `git rev-parse --show-toplevel`, which prints `D:/repos/claude-mods`, and keeps that spelling [src: `git/src/repo.ts` `findRepoRoot`, `git/src/types.ts` `toRepoPath`].
- It then looks for the project in three steps [src: `core/src/services/codebase-checkout-resolver.ts` `findCodebaseForCheckoutPath`]:
  1. the cwd equal to a `default_cwd`, by exact SQL equality [src: `core/src/db/codebases.ts` `findCodebaseByDefaultCwd`];
  2. the worktree's primary checkout, compared the same way;
  3. only when Git cannot name a primary checkout, the same Git directory as a registered project's.
- `D:/repos/claude-mods` is not equal to `D:\repos\claude-mods`, so each step misses, and `scopeFallback: true` lists every run.
  Running from the repo root, from `docs/` and from the run's worktree all fell back [probe].
- **Control:** from Archon's own checkout, whose project is stored with forward slashes, the same command scoped to its one run (`scopeFallback: false`) [probe].
- The server filters by id (`/api/workflows/runs?codebaseId=`, `/api/dashboard/runs?codebaseId=`), so spelling matters only in the step from a folder to a project [archon-api].

### Matching a session's folder to a run (facts for the data-source ticket, not a decision)

- After normalizing both sides (one kind of slash, no trailing slash, case-insensitive on Windows), a folder inside a project's `default_cwd` belongs to that project.
  The probes' `codebase_id`, `working_path` and `origin` all agree once normalized [probe].
- A linked worktree's `git rev-parse --git-common-dir` is the primary checkout's `.git`.
  For the run's worktree it printed `D:/repos/claude-mods/.git`, the same as the repo's [probe].
  This is the step Archon itself uses, and it catches worktrees outside the project folder [src: `core/src/services/codebase-checkout-resolver.ts`].
- A run whose `codebase_id` is empty can still be matched by `working_path` or `origin`.

### A session opened inside a run's worktree

- Its folder is the run's `working_path` (or inside it), and its Git directory is the project's.
  So it matches both the project and that one run [probe].
- The worktree holds nothing that names the run: it is a clean checkout of the branch `plan/mod-settings-dialog`.
  The links are the run's `working_path` and the isolation row's `working_path` and `branch_name` [probe].
- More than one run can use the same worktree: a later run can **adopt** an earlier one's (`adopted_from_run_id`, and `leave_behind.adopted_by` on the earlier run) [src: `cli/src/commands/workflow.ts` `buildLeaveBehind`].
- `archon workflow runs` from inside the worktree fell back to every run, for the spelling reason above [probe].

## 5. Archon's own logs

- **No file of its own.** Archon logs through pino to stdout as newline-delimited JSON, or pretty-printed when stdout is a terminal and `NODE_ENV` is not `production`.
  The level is `LOG_LEVEL` (default `info`), and the CLI goes silent under `--json` [src: `paths/src/logger.ts`].
  Adapter detail appears only with `LOG_LEVEL=debug` [skill: `manage-run/troubleshooting.md`].
- **`~/.archon/logs/serve.log` is this machine's.** `~/.archon/serve-task.cmd` runs `archon serve >> ~/.archon/logs/serve.log 2>&1`, so the file's path and lifetime belong to that script.
  Nothing rotates it [probe].
  - Each line is `{level, time, pid, hostname, module, msg, …}`, with `level` 30 for info and 40 for warn, and `time` in epoch milliseconds [probe].
  - It held 175 lines (33 KB) over 69 minutes, mostly workflow and script discovery.
    3 lines were plain text from the Slack socket client on stderr, and only 2 lines carried a run id [probe].
  - It covers the whole machine, every project's server work, not one project [probe].
- **Detached CLI runs.** `archon workflow run --detach` appends to `~/.archon/logs/detached-run-<conversation id>.log`.
  Each start adds a header line, then the CLI's own progress text, including the transcript's path, and then the run process's pino lines (warnings such as rate-limit events) [src: `cli/src/commands/workflow.ts`] [probe].
  - The `<conversation id>` is the run's `conversation_platform_id` from `GET /api/workflows/runs/{id}` (`cli-<ms>-<random>`) [probe].
  - The `archon-plan` run's file ended at 8.5 KB, a short summary next to its 93 KB transcript [probe].

## 6. What this means for the open tickets (not decisions)

- **Data source** ([#111](https://github.com/seanrobertwright/claude-mods/issues/111)):
  - The pane can't rely on `archon workflow runs` scoping on Windows.
    It can match the session's folder to a project by itself and then filter by `codebaseId`.
  - The graph comes from the run's own source copy, read once per run, since it never changes.
  - The run log needs a follower that reads by offset.
- **Layout** ([#112](https://github.com/seanrobertwright/claude-mods/issues/112)):
  - Most graphs are a short chain.
    The worst case is about 60 entries, at most 6 wide and 18 deep, with `__` include blocks and loop groups to fold.
  - A file list and a PR number are available while the run is going.
  - Tool results are never available.
- **Approvals** ([#113](https://github.com/seanrobertwright/claude-mods/issues/113)): of the bundled workflows, only `archon-interactive-prd` reaches approval nodes, and `archon-piv-loop` reaches interactive loop gates.
- **Fog this makes specific:** how sub-runs are shown, whether a session in a run's worktree counts as that run's project, and how much run log the pane keeps.

## Sources

- Archon source, tag `v0.11.1`: <https://github.com/coleam00/Archon/tree/v0.11.1>.
  The files cited are in that tree under `packages/`, and the bundled workflows are under `.archon/workflows/`.
- Probes on this machine:
  - `~/.archon` read in place, with the database read from a copy: `remote_agent_workflow_runs`, `…_workflow_events`, `…_conversations`, `…_codebases` and `…_isolation_environments`;
  - the three runs' transcripts (the live one read during the run and again after it ended), artifacts and workflow-source copies, and `logs/serve.log`, `logs/detached-run-*.log` and `serve-task.cmd`;
  - `GET /api/codebases`, `/api/workflows/runs/{id}` and `/api/runs/{id}/artifacts`;
  - `archon workflow runs --json` from the repo, `docs/`, the run's worktree and Archon's checkout, and `archon workflow get <id> --json [--verbose]`;
  - `git rev-parse --show-toplevel` and `--git-common-dir`;
  - a script that measured the 31 bundled workflows in the live run's copy, with includes expanded.
