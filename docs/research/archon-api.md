# What Archon exposes for watching runs and answering approvals

Research for issue #108, a ticket of the archon-panel v2 map (#107): what Archon v0.11.1 offers a mod for watching runs and answering approvals, through its server (`archon serve`) and through its CLI.
Answered from Archon's source at tag `v0.11.1` (commit `aa09544`, 2026-09-25), with read-only probes on this machine.
No run was approved, rejected, cancelled or resumed.

How sources are cited:

- **[src: path]** is Archon's source at `v0.11.1`, relative to `packages/`.
- **[probe]** is a read-only call made on this machine (`archon serve` on `:3090` and the CLI at `~/.archon/bin/archon.exe`, both v0.11.1, SQLite store).

## Short answer

- **Server REST covers everything the pane reads.** It lists runs, returns one run with its events, lists a run's files, and approves or rejects a run, all as JSON on `http://localhost:3090/api/...` [src: `server/src/routes/api.ts`].
  On a SQLite install like this one, there is no auth: web auth turns on only when both `DATABASE_URL` (Postgres) and `BETTER_AUTH_SECRET` are set [src: `server/src/auth/config.ts`] [probe].
- **Live updates are SSE, and they are signals.** `GET /api/stream/__dashboard__` streams the lifecycle of every run on the machine (run status, node status, approval reached) [src: `server/src/adapters/web/workflow-bridge.ts`].
  The web UI never applies an event's payload: it takes each one as "this changed" and refetches over REST, which is the source of truth [src: `web/src/experiments/console/lib/sse.ts`].
- **Runs started from the CLI reach the stream, a little late and with less detail.** The server tails the events table every **1.5 s** on SQLite (Postgres has LISTEN/NOTIFY with a 10 s backstop) and replays only lifecycle and approval rows. Tool calls and model text from a CLI run never reach any stream [src: `server/src/adapters/web/dashboard-event-poller.ts`, `server/src/index.ts`].
- **A run's model text and tool calls are not in its events.** They live in the run's **JSONL transcript**, `<output_root>/logs/<runId>.jsonl`, written by whichever process runs it. It is readable as a file or with `archon workflow logs <id> [--follow]`, and **no server route serves it** [src: `cli/src/commands/workflow.ts` `resolveRunTranscriptPath`] [probe].
  Runs the server executes also keep their messages in their conversation (`GET /api/conversations/{platformId}/messages`) [probe].
- **Approving a run started from the CLI resumes it inside the server.** _Corrected for #113; this bullet first said the server leaves a CLI-started run paused._ `POST .../approve` records the approval, then resumes a run with no parent conversation (every CLI-started run) inside the server process, and a web-started run through its web chat. It records without resuming a container-isolated run, a run with no working path, and one started from Slack, Telegram or GitHub, and says which happened only in its message text [src: `server/src/routes/api.ts` `tryAutoResumeAfterGate`, `server/src/services/workflow-resume-service.ts`].
  `archon workflow approve <id> --detach` records it **and** resumes it in a detached process. Without a flag, approve resumes the run **inline and blocks for the rest of it**, and with `--json` it records only [src: `cli/src/commands/workflow.ts` `workflowApproveCommand`].
- **A paused run is not always waiting on the person.** `paused` covers three things:
  - an `approval` node;
  - an interactive loop gate, where the person answers between iterations;
  - a `wait` node, which waits for an outside event or a time.
  `metadata.approval` (`nodeId`, `message`, `type`) marks the first two, and `metadata.wait` the third. An approval node may also declare its own **decisions** beyond approve and reject, answered through `respond` [src: `workflows/src/dag-executor.ts`, `workflows/src/schemas/dag-node.ts`].
- **The CLI is a full fallback, at about 2× the cost.** `workflow runs --json` returns the same enriched rows as the dashboard route. `workflow get <id> --json` adds `transcript_path` and `leave_behind` (worktree, files). One CLI call took about **0.6 s** here against about **0.3 s** over HTTP [probe].

## 1. Server routes the pane would use

All take and return JSON. Ids are strings (UUIDs).

| Need | Route | Notes |
|---|---|---|
| Is the server up, which version | `GET /api/health` | `{status:"ok", version, runningWorkflows, activePlatforms, ...}` [probe] |
| List runs, enriched | `GET /api/dashboard/runs?status&codebaseId&search&after&before&limit&offset` | `{runs, total, counts:{all,running,completed,failed,cancelled,pending,paused}}`. Each run adds `codebase_name`, `active_nodes[]`, `current_step_name`, `current_step_status`, `total_steps`, `agents_*` to the base row |
| List runs, plain | `GET /api/workflows/runs?status&codebaseId&limit&conversationId&mine&open` | `{runs}` |
| One run with its events | `GET /api/workflows/runs/{runId}` | `{run, events[]}`. The run adds `worker_platform_id`, `conversation_platform_id`, `terminal_record`. **Every event, no paging**: the probe's eight-minute single-node run had 794 rows, 728 of them `hook_activity` |
| A run's files | `GET /api/runs/{runId}/artifacts` → `GET /api/artifacts/{runId}/{path}` | `{files:[{path,size,modifiedAt}]}`. 404 when the location can't be resolved |
| Model text of a server-run | `GET /api/conversations/{platformId}/messages` | `[{role, content, metadata(JSON string with toolCalls)}]` [probe] |
| Projects | `GET /api/codebases` | `[{id, name, repository_url, default_cwd, ...}]`. Matching a session's folder to these is a question for the run-data ticket |
| Approve | `POST /api/workflows/runs/{runId}/approve` body `{comment?}` | 400 unless `status == 'paused'`, or when the gate belongs to a child run. A malformed body is a 400, never coerced. **Resumes web-started runs through their chat and CLI-started runs inside the server**, but not container-isolated or chat-platform runs (corrected for #113) |
| Reject | `POST /api/workflows/runs/{runId}/reject` body `{reason?}` | same checks |
| Any declared decision | `POST /api/workflows/runs/{runId}/respond` body `{decision, text?}` | `approve` and `reject` are sugar for the routes above |
| (fog) Cancel / resume / abandon | `POST .../cancel`, `.../resume`, `.../abandon` | `resume` dispatches only on the parent web conversation |

The full OpenAPI document is served at `GET /api/openapi.json` [probe].

A run row's fields that matter: `id`, `workflow_name`, `status` (`pending | running | paused | completed | failed | cancelled`), `outcome`, `user_message`, `started_at`, `completed_at`, `last_activity_at`, `codebase_id`, `working_path`, `output_root`, `parent_run_id` (a `workflow:` node's sub-run), and `metadata`.
`metadata` carries:

- `approval` / `wait`: why the run is paused;
- `node_counts` (`completed`, `failed`, `skipped`, `total`);
- `terminal_graph.node_ids`;
- `total_cost_usd` and token totals;
- `workflow_source` (`origin`, which is the folder the run started from, and a snapshot of the workflow files);
- `execution_owner` (`host`, `pid`).

[src: `workflows/src/schemas/workflow-run.ts`] [probe]

Event rows are `{id, workflow_run_id, event_type, step_name, step_index, data, created_at, event_order}` [src: `core/src/schemas/workflow-event.ts`].
The types seen include:

- run lifecycle: `workflow_started`, `workflow_completed`;
- nodes: `node_started`, `node_completed` (with `data.node.{id,kind,source}`);
- tools and hooks: `tool_called`, `tool_completed`, `task_activity`, `hook_activity`;
- approvals: `approval_requested`, `approval_received`.

## 2. Live updates

- **`GET /api/stream/__dashboard__`**: every run on the machine. It opens with a heartbeat and sends another every 30 s [probe]. The frames are SSE `data:` JSON:
  - `{type:"workflow_status", runId, workflowName, status, error?, approval?:{nodeId,message}}`. `status: "paused"` with `approval` is an approval reached.
  - `{type:"dag_node", runId, nodeId, name, status:"running|completed|failed|skipped", duration?, error?, reason?}`.
  - From runs the server executes, also `workflow_step` (loop iterations), `workflow_tool_activity`, `workflow_task_activity`, `workflow_hook_activity` and `workflow_artifact`.
- **Runs from other processes.** The server's poller tails the events table every 1.5 s (SQLite) and replays only lifecycle, node and approval rows to `__dashboard__`. Its cursor starts at server boot, so **there is no replay**: a client that connects late has to fetch the current state over REST [src: `dashboard-event-poller.ts`, `workflow-bridge.ts` `DASHBOARD_SOURCE_EVENT_TYPES`].
- **`GET /api/stream/{conversationPlatformId}`**: one conversation, with streamed `text`, `tool_call` and `tool_result` as well as the workflow events above. Only a run the server executes feeds it.
- **How the web UI uses them.** It debounces 100 ms, then refetches the run (`/api/workflows/runs/{id}`) and the messages [src: `web/.../lib/sse.ts`]. Payload fields are documented as best-effort.

## 3. The CLI, for when the server is down

| Need | Command | Notes |
|---|---|---|
| List runs | `archon workflow runs --json [--limit N] [--status S] [--all]` | `{runs, total, counts, scopeFallback}`, with the same enriched rows as `/api/dashboard/runs`. Scoped to the cwd's project. **`scopeFallback: true` means the cwd matched no project and every run was listed.** That happened here in `D:\repos\claude-mods`, even though a `<owner>/claude-mods` codebase is registered [probe] |
| Live and paused runs only | `archon workflow status --json` | `{runs, scopeFallback}` [probe] |
| One run | `archon workflow get <id> --json [--events]` | the run plus `transcript_path` and `leave_behind` (worktree, whether it still exists, files) [probe] |
| Run log | `archon workflow logs <id> [--follow]` | prints the JSONL transcript raw; `--json` is refused. `--follow` tails until the run ends |
| Wait for a change | `archon workflow wait <id> --json [--timeout s]` | blocks until the run ends or needs a person; exit 3 on timeout |
| Approve | `archon workflow approve <id> [comment] --detach [--json]` | **must** be `--detach` for a mod: bare approve resumes inline and blocks; `--json` alone records but leaves the run paused |
| Reject | `archon workflow reject <id> [reason] --detach [--json]` | same flags |
| Any declared decision | `archon workflow respond <id> <decision> [text]` | |

The JSONL transcript has one object per line, each with a `type` and an ISO `ts`:

- `workflow_start` (`workflow_name`, `content`);
- `node_start` and `node_complete` (`step`, `execution.node.{id,kind}`);
- `assistant` (`content`);
- `tool` (`tool_name`, `tool_input`);
- `watchdog_reset`;
- `workflow_complete` (`cost_usd`, `tokens`).

The probe's run made 61 lines and 54 KB in eight minutes [probe].

## 4. What this means for the open tickets (not decisions)

- **Data source** ([#111](https://github.com/seanrobertwright/claude-mods/issues/111)):
  - The server alone can't show a CLI run's live model output, but the transcript file can, and any process can read it.
  - The likely split is REST + `__dashboard__` for lifecycle, and the transcript for the run log, from the server or the CLI alike.
  - A late connection gets nothing replayed, so a REST fetch has to come first.
  - A run's events have no paging, so polling `/api/workflows/runs/{id}` on a long run is heavy.
- **Approvals** ([#113](https://github.com/seanrobertwright/claude-mods/issues/113)):
  - The pane has to tell an approval from a `wait` node and show any declared decisions.
  - The answer has to go through `archon workflow approve|reject|respond --detach` for CLI-started runs. The server route alone would leave those paused.
    _Corrected for #113:_ the server route resumes them, but inside the server process; #113 sends CLI-started runs through the CLI for that reason (ADR-0006).
  - Both surfaces take a comment or reason.
- **Run data** ([#109](https://github.com/seanrobertwright/claude-mods/issues/109)):
  - The CLI failed to match this repo's folder to its registered codebase.
  - `metadata.workflow_source.origin` and `working_path` look like better keys for matching a run to a project.

## Sources

- Archon source, tag `v0.11.1`: <https://github.com/coleam00/Archon/tree/v0.11.1>. The files cited above are all in that tree.
- Probes: `GET /api/health`, `/api/workflows/runs`, `/api/dashboard/runs`, `/api/workflows/runs/{id}`, `/api/conversations/{id}/messages`, `/api/codebases`, `/api/openapi.json`, `/api/stream/__dashboard__`; `archon workflow runs|get|status --json`; one transcript file under `~/.archon/workspaces/<owner>/claude-mods/logs/`.
