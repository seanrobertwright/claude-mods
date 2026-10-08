# What Archon's cancel, abandon and resume do

Research on the run actions besides approve and reject: what cancel, abandon and resume accept, what each one does to a run held by another process, how a `wait: {attention}` run is resumed, and what Archon's web UI offers for each status.
It builds on `docs/research/archon-api.md` and `docs/research/archon-run-data.md` and does not repeat them.
Answered from Archon's source at tag `v0.11.1` (commit `aa09544`) and from `archon workflow <cmd> --help` on this machine.
This was read-only research: no run was approved, rejected, cancelled, abandoned or resumed.

How sources are cited:

- **[src: path `fn`]** is Archon's source at `v0.11.1`, relative to `packages/`.
- **[help]** is the `--help` output of `~/.archon/bin/archon.exe` v0.11.1.

## 1. Cancel and abandon

| | Cancel | Abandon |
|---|---|---|
| Meaning | Stop live work, and record `cancelled` only once it has stopped [help: "Stop a running workflow (stops an owning process first)"] | Record `cancelled` as the operator's call that the run is dead, stopping a live owner first [help] |
| Accepts | `running` only | `pending`, `running`, `paused`, `failed` (it refuses only `completed` and `cancelled`) |
| No owner answers | Refuses and leaves the run unchanged | Records `cancelled` and reports the recorded owner (host, pid, last activity) |
| Sub-runs | Cascades only on the "stopped" path | Always cascades |

[src: `core/src/operations/workflow-operations.ts` `cancelWorkflow`, `abandonWorkflow`, `assertAbandonable`]

- **CLI:**
  - `archon workflow cancel <id> [--json]`
  - `archon workflow abandon <id> [--json]`
  - `archon workflow resume <id> [--json] [--detach]`

  `--detach` exists only on run, approve, reject, respond and resume. `cli.ts` does not pass it to cancel or abandon, so it is ignored there [src: `cli/src/cli.ts`] [help].
  A refusal under `--json` prints `{ok:false, runId, action, error}` [src: `cli/src/commands/workflow.ts` `printJsonWriteError`].
- **REST** (no body on any of the three):
  - `POST .../cancel`: 200 `{success, message}`; 400 when the run is not `running`; 404; 409 when no owner answered or the owner couldn't be stopped.
  - `POST .../abandon`: 200; 400 for `completed` or `cancelled`; 404; 409 when an owner answered but couldn't be stopped.
  - `POST .../resume`: 200; 400; 404.

  [src: `server/src/routes/api.ts` `cancelWorkflowRunRoute`, `abandonWorkflowRunRoute`, `resumeWorkflowRunRoute`]

## 2. Cancelling a running run held by another process

Every surface calls `cancelWorkflow`. It reaches the run's owner through a per-run named pipe (`\\.\pipe\archon-workflow-<sha256(runId)[:32]>`) [src: `core/src/services/run-live-owner.ts` `runLiveOwnerPath`].
**Only a `--detach` CLI process grants a stop.** Every other owner publishes the pipe without `detachedProcessPid` and answers `{kind:"unsupported"}`. Those owners are a foreground CLI run, the server's orchestrator, the server's resume service and the web chat [src: `run-live-owner.ts` `startRunLiveOwner`, `requestRunLiveOwnerStop`; callers in `cli/src/commands/workflow.ts`, `core/src/orchestrator/*.ts`, `server/src/services/workflow-resume-service.ts`].

| Who executes the run | Cancel from the CLI | `POST .../cancel` on `archon serve` |
|---|---|---|
| `--detach` CLI child | Process tree killed, then recorded `cancelled` | Same |
| Foreground CLI | Refused, run unchanged | 409, run unchanged |
| The server itself | Refused, run unchanged | Cooperative: flips the row only |
| No one (crashed) | Refused: "…abandon the run to release it." / "Abandon it: `archon workflow abandon <id>`" | 409 |
| Sub-run with no owner of its own, root's owner answers | Cooperative | Cooperative |

The refusal for an owner that can't be stopped reads: `Run <id> is executing in another live Archon process that cannot be stopped from here, because it is not a detached run (a foreground CLI run, or an Archon server). The run was not changed. …` [src: `workflow-operations.ts` `ownerNotStoppedMessage`].
Abandon goes through the same `stopLiveOwner` and has no own-process check, so abandoning a `running` run held by a foreground CLI or by the server is refused the same way (a 409 on the server) [src: `abandonWorkflow`].

**How long until it stops:**

- **Stopped:** on POSIX it sends SIGTERM to the process group, waits up to 5 s, then sends SIGKILL and confirms within 1 s. On Windows it runs `taskkill /T /F` and re-lists the processes (30 s cap per command). The row is written only after the process has gone [src: `core/src/services/run-owner-stop.ts`, `windows-process-tree.ts`].
- **Cooperative:** the executor reads the status between DAG layers, and during a streaming node at most every 10 s (`CANCEL_CHECK_INTERVAL_MS`), checked as messages arrive [src: `workflows/src/dag-executor.ts`].

**`cascadeCancelChildren`** walks every descendant breadth-first (capped at 500) and cancels each one that is not `completed` or `cancelled`. It is best-effort and returns the count of failures, which becomes `cascadeFailures`.
It runs from `recordAbandoned`, which is to say abandon and the "stopped" cancel. A cooperative cancel flips one row.
`findParentBlockedOn` then reports a parent left paused on the run as `blockedParentRunId` [src: `workflow-operations.ts`].

## 3. Resume

- **Accepts `failed` and `paused`** (`RESUMABLE_WORKFLOW_STATUSES`). Anything else gets `Cannot resume run with status '<s>'. Only failed or paused runs can be resumed.` [src: `workflows/src/schemas/workflow-run.ts`, `workflow-operations.ts` `resumeWorkflow`].
- **Bare `resume <id>`** re-runs the workflow inline from the run's frozen source, skipping completed nodes, and **blocks** like a bare approve [src: `cli/src/commands/workflow.ts` `workflowResumeCommand`].
- **`--detach`** prechecks (the status and a recorded `working_path`), spawns a child that runs the blocking resume, and returns `{ok, runId, action:"resume", detached:true, continues:true, workflowName, logPath}` [src: `runDetachedControlCommand`].
- **`--json` alone** only validates. It returns `{…, executed:false, status, workflowName, workingPath}` and does not run anything.
- **`POST .../resume`:**
  - **No `parent_conversation_id`** (every CLI-started run): the server executes the run itself (`resumeWorkflowRunFromServer`).
    It returns 400 ``This run was created outside the web UI. Use `archon workflow resume <id>`…`` for any of these cases:
    - no `working_path`;
    - `metadata.isolation === 'container'`;
    - a frozen source that can't be resolved;
    - nothing to resume;
    - a lost race.
  - **A parent conversation that is not a web conversation** (Slack, Telegram, GitHub): 400 `Cannot resume from web UI: the run's parent conversation is not a web conversation.…`
  - **A web conversation:** the server posts `/workflow resume <id>` into that conversation. The 200 does not report what the chat handler does with it, and that handler refuses container runs (`createResumeRequest`) [src: `server/src/routes/api.ts`, `core/src/handlers/command-handler.ts`].
- **A paused run with an unresolved gate** is allowed. The gate node has no `node_completed` row, so it runs again and pauses again [src: `dag-executor.ts` `executeApprovalNode`].

## 4. `wait: {attention: "<text>"}`

- **Pausing.** On pause the node writes `metadata.wait = {owner, nodeId, kind:"attention", waitingSince, message}`, with `$INPUTS` and node outputs substituted into the message.
  It also sends ``⏸️ **Action required for workflow run `<id>`**\n\n<message>\n\nResume this run after the action is complete, or abandon it if it should not continue.``
  If that message can't be delivered, the run **fails** (`failPausedAttentionWait`) [src: `dag-executor.ts`, `workflows/src/schemas/dag-node.ts` `waitConfigSchema`].
- **Getting it going again takes a plain resume.**
  - Approve, reject and respond refuse it: `Run <id> is paused for an outside action. Complete it, then resume the run; abandon it if it should not continue.` [src: `assertApprovable`, `assertRejectable`, `api.ts` `pausedGateBlocker`].
  - The server's continuation scheduler (every 5 s) auto-resumes time and event waits, and failed runs with a quota `scheduled_resume`, but **never** attention waits [src: `workflow-resume-service.ts` `continuationCursor`].
- **On resume** the node completes with output `{"status":"satisfied","waited_ms":N}` and clears the wait. No actor, comment or text is recorded [src: `dag-executor.ts`].
- **`runAttention`** reports `{kind:"action_required", runId, nodeId, message}`. For a loop-owned wait, `nodeId` is `<group>.<bodyWaitId>`.
  `archon workflow wait` prints `Run <id> needs an outside action: <message> When it is complete, run: archon workflow resume <id>` [src: `schemas/workflow-run.ts` `runAttention`, `cli/src/commands/workflow.ts`].

## 5. Failed runs and the web UI

- **A failed run resumes by re-running its failed and unrun nodes.** A failed sub-run is re-driven once (see archon-run-data.md).
- **Run detail page** (`RunActionBar`):
  - `running`: **Cancel**. **Abandon** appears only after a cancel got a 409.
  - `paused`: nothing. Only the approval panel shows, and it shows nothing for an attention wait.
  - `failed`: **Resume** · **Abandon**.
  - `completed`, or `cancelled` with a project: **Re-run** (a fresh run).
  - Otherwise: "This run is {status}. Choose a project to start a new run."
  - Busy labels are "Cancelling…", "Resuming…" and "Abandoning…".
  - [src: `web/src/experiments/console/components/RunActionBar.tsx`]
- **Run list:**
  - An active card on an attention wait shows "action" with its message, then **Resume** · **Abandon** [src: `ActiveRunCard.tsx`].
  - Recent rows (`completed`, `failed`, `cancelled`) show a hover **↻** ("Rerun {workflow} with the same message", a fresh run) and a "CLI" button that copies `archon workflow get <id>` [src: `RecentRunRow.tsx`].
- **There is no "Retry" button and no confirm dialog** on any run action. The console's `window.confirm` calls are for workflows, environment variables and projects only.

## 6. Guards and refusals

- **No working path recorded:** `Workflow run '<id>' has no working path recorded.\nCannot determine where to resume. The run may be too old.` This applies inline and to the `--detach` precheck.
- **The working path no longer exists**, checked inline only: `Cannot resume: the working path from the run no longer exists: <path>\nThe worktree may have been cleaned up. Start a fresh run with --branch instead.` [src: `workflowRunCommand`].
  The `--detach` precheck does not check this, so the child fails in its log after the parent has acknowledged success.
  The server's headless path has no such check.
- **The run's codebase row is gone:** `Workflow run '<id>' references codebase '<cb>', but that codebase no longer exists.…` [src: `resolveDiscoveryCwdForCodebase`].
- **The frozen source is missing or altered:** the run is **failed** with `This run's captured workflow source at <root> is missing or altered (<err>). The run cannot be resumed against different source; start a fresh run to execute the current workflow.` [src: `workflows/src/executor.ts`].
  On the server's headless path the same failure is the generic 400 above.
- **Cancel:**
  - `Cannot cancel run with status '<s>'. Only a running run has live work to stop; abandon a paused or failed run instead.`
  - On a race: `Workflow run <id> already finished; nothing to cancel.`
- **Abandon:** `Cannot abandon run with status '<s>'. Only running, paused, or failed runs can be abandoned.`

## Sources

- Archon source, tag `v0.11.1`: <https://github.com/coleam00/Archon/tree/v0.11.1>.
- `archon workflow cancel|abandon|resume --help` (v0.11.1).
