# What Claude Code's own background shells give a dev server

Research for [What do Claude Code's own background shells give a person running a dev server?](https://github.com/seanrobertwright/claude-mods/issues/153), on the [dev-server-manager map](https://github.com/seanrobertwright/claude-mods/issues/150). It feeds [What does dev-server-manager add over Claude Code's background shells?](https://github.com/seanrobertwright/claude-mods/issues/154).

How sources are cited:

- **[types]** is the function-hook declarations bundled with the `plugin-authoring` skill (Claude Code 2.1.294, `types/claude-code.d.ts`), cited by symbol.
- **[probe]** is one throwaway mod loaded with `claude -p --plugin-dir` on Claude Code 2.1.294, Windows 11, Node 24.19. It ran against a throwaway project in the scratchpad: `long.js` (an HTTP server on 5312 that prints its URL and ticks every 2 s, run as the `dev` script), `long3.js` (the same on 5313, run bare) and `crash.js` (a server on 5311 that exits 1 after 4 s). The mod logged `tool.call`, `prompt.submit`, `session.start`/`end`, `classic.Stop` and `classic.SessionEnd`. In some runs it also stopped the shells with `TaskStop`. Four runs; see [Probe notes](#probe-notes).
- **[docs]** is the Claude Code documentation at code.claude.com, read on 2026-10-08, cited by page.
- **[transcripts]** is this machine's `~/.claude/projects/*/*.jsonl`.

**Only Windows was probed, and only headless (`-p`).** The person's side (`/tasks`, Ctrl+B) comes from the docs alone.

## Short answer

- **Habit: no evidence on this machine.** This machine keeps 102 transcripts. None of them shows the model starting a real dev server in the background, and no hand-typed prompt asks to start, restart or check one. The only background server starts are this map's own probes [transcripts]. The idea's rank came from the brainstorm's survey, which gives no counts (`docs/proposed-mods.md`).
- **How the model starts one:** Bash with `run_in_background: true` returns at once. The result carries a `backgroundTaskId`, and its text names an output file (`…/Temp/claude/<cwd slug>/<session id>/tasks/<id>.output`). The model reads that file with `Read`. It holds stdout and stderr together, npm's banner included [probe].
- **What the person gets:** `/tasks` (alias `/bashes`) lists background work and stops it. The docs give no key for reading a shell's output in the terminal (the VS Code extension shows the latest output on a click) and no restart. Ctrl+B sends a running foreground command to the background [docs: commands, interactive-mode, vs-code].
- **On Windows, stopping an npm-script shell leaves the server running.** The mod's `TaskStop` answered "Successfully stopped task", but `npm-cli.js run dev` → `cmd.exe` → `node long.js` all survived and held port 5312 past session end. A bare `node long3.js` shell was stopped cleanly, and its port freed within 4 s. The stop ends the shell, not the tree beneath it [probe]. The person's `/tasks` stop and the model's `TaskStop` are presumably the same stop (not probed separately).
- **A death notifies the model, which then takes a turn.** A crashed shell becomes a `<task-notification>` with `status` `failed`, a summary `Background command "node crash.js" failed with exit code 1`, and the output file's path, but no error text. It came in during a running turn [probe]. A session that was idle starts a turn on its own [types: `PromptOrigin`, `task-notification`]. A shell that exits 0 reads `completed (exit code 0)`.
- **`/clear` leaves a shell running and tracked.** Port 5312 was still held 3 s after `session.end` (`reason: clear`), and the `-p` run then waited on the shell until it was killed [probe].
- **Headless, a running shell keeps the session open.** A `-p` run with a running shell didn't end after its final answer: it waited until killed (4 min in one run). The docs' "about 5 seconds after the final result" didn't hold on this build [probe; docs: headless]. Exiting an interactive session cleans background tasks up [docs: interactive-mode, not probed]. Given the stop above, an npm-script server may survive that too. A resumed session doesn't restore a shell [docs: sessions].
- **What a mod sees of them:**
  - **Start:** the `tool.call` result, with `backgroundTaskId` and the output path, the latter only in its text.
  - **List:** `classic.Stop`'s `background_tasks`, at each turn's end only. No `$` method lists them, and `$.agent.list()` returned `[]` with two shells running.
  - **Stop:** `$.tool.call({ tool: 'TaskStop', task_id })` works from a mod, with no permission prompt.
  - **Death:** a `prompt.submit` whose `origin.kind` is `task-notification`.

## 1. Today's habit

A scan of all 102 transcripts this machine keeps (`~/.claude/projects/*/*.jsonl`) for Bash or PowerShell calls running `npm|pnpm|yarn|bun (run) dev|start|serve|preview`, `vite`, `next dev`, `uvicorn`, `runserver`, `flask run`, `http.server` or `streamlit run`:

| What | Count |
| --- | --- |
| background starts (`run_in_background: true`) | 1, this map's own probe |
| foreground matches | 21, all mentions (a `cat vite.config.ts`, a `package.json` written for a probe, regexes, docs) and none a running server |
| `TaskStop` / `KillShell` calls | 2 |
| hand-typed prompts matching "start/restart/run/kill/check … dev server / localhost / backend", `localhost:NNNN`, `port NNNN`, `EADDRINUSE` | 0 |

The transcripts kept here come mostly from claude-mods, Archon and tooling repos, not web apps with a dev server. So this says the habit doesn't show *here*. It doesn't say how a person with a web app works.

## 2. What the person can do

From the docs; none of it was probed interactively.

| Want | How | Source |
| --- | --- | --- |
| see running shells | `/tasks` (alias `/bashes`): "view and manage background work in the current session, including subagents". It runs even mid-response | [docs: commands, interactive-mode] |
| read a shell's output | no documented key in the terminal; in VS Code, clicking a task opens a card with its latest output. The model reads the output file with `Read` (`TaskOutput` is deprecated) | [docs: vs-code, tools-reference] |
| stop one | from `/tasks`; the model uses `TaskStop` | [docs: interactive-mode, tools-reference] |
| restart one | no such action; the person asks the model | [docs] |
| background a running command | Ctrl+B (rebindable as `task:background`); the result then carries `backgroundedByUser: true` | [docs: interactive-mode; types: `Bash` result] |
| turn background shells off | `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` turns off `run_in_background`, auto-backgrounding and Ctrl+B | [docs: env-vars] |

Limits from the docs: output over 5 GB kills the command. Unattended runs (`-p`, CI, cloud) have a 30-minute background limit, at most 2 hours. Local terminal, desktop and VS Code sessions have none. The docs say that on macOS and Linux a shell idle for 30 minutes can be stopped under critical memory pressure [docs: tools-reference, headless]. It happens on Windows too: during this research, Claude Code stopped one of its own background shells (a transcript scan, about 25 minutes old) "because the system is running low on memory" while the session was idle. The model got a `killed` notification, and `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1` turns this off. A dev server left idle in a background shell can therefore be stopped under it [observed in this session].

## 3. Start, output and stop

- **Start.** `Bash({ command: "npm run dev", run_in_background: true })` returned at once with `{ stdout: "", stderr: "", backgroundTaskId: "b5n37vsj9" }` and the text `Command running in background with ID: b5n37vsj9. Output is being written to: C:\…\tasks\b5n37vsj9.output. You will be notified when it completes.` [probe].
- **Output.** The file grows as the server writes, stdout and stderr mixed. Fourteen seconds in, it held npm's `> dev` / `> node long.js` banner, the `Local: http://localhost:5312/` line and seven ticks [probe]. Nothing finds the URL for the person. The model finds it only if it reads the file.
- **Stop, bare command.** `TaskStop` on `node long3.js` answered `{ message: "Successfully stopped task: bwo92dcma (node long3.js)", task_type: "local_bash" }`, and port 5313 was free 4 s later [probe].
- **Stop, npm script.** `TaskStop` on `npm run dev` gave the same answer, but 4 s later, and again after the session ended, port 5312 was held. The live tree was `node npm-cli.js run dev` → `cmd.exe /d /s /c node long.js` → `node long.js`, and the `bash.exe` that had been their parent was gone. The same happened in two runs [probe]. Against [How does a mod start, stop and read a dev server without a shell?](https://github.com/seanrobertwright/claude-mods/issues/151): there, the mod's own `return()` on `$.process.spawn` killed the whole tree.

## 4. Death, reload, `/clear` and session end

| When | What happened | Source |
| --- | --- | --- |
| the server exits 1 | a `<task-notification>`: `task-id`, `tool-use-id`, `output-file`, `status` `failed`, `summary` `Background command "node crash.js" failed with exit code 1`. It came in during the running turn, 4 s after the crash. No error text, only the file's path | [probe] |
| the server exits 0 | the same envelope with `status` `completed` and `completed (exit code 0)` | [probe] |
| a death while the session is idle | the notification is "dequeued when the session went idle", so it starts a turn of its own | [types: `PromptOrigin`] |
| `/reload-plugins` | the shell belongs to the session, not to a module, so a reload has nothing to stop | [inference; not probed] |
| `/clear` | the server ran on (port held 3 s after `session.end` with `reason: clear`), and the session kept waiting on the shell | [probe] |
| `-p` after its final answer | waited on the running shell until killed (4 min), not the documented ~5 s | [probe; docs: headless] |
| interactive exit | "background tasks are cleaned up". The agent-view page also offers "Move to background and exit", which keeps them | [docs: interactive-mode, agent-view; not probed] |
| Claude Code killed (`timeout`) | the npm tree survived and held the port | [probe] |
| `--resume` / `--continue` | the shell isn't restored; the resumed session notes that it didn't finish | [docs: sessions] |

## 5. What a mod can see and do

| Want | How | Source |
| --- | --- | --- |
| know a shell started | a `tool.call` hook on `Bash`/`PowerShell` that awaits `next(e)`: `result.backgroundTaskId`, and `e.command`. The output path is only in the result's `text` | [probe] |
| list the running ones | `classic.Stop` (and `classic.SubagentStop`): `background_tasks: [{ id, type: "shell", status: "running", description, command }]`, at each turn's end. Nothing between turns | [probe; types: `StopHookInput`, `BackgroundTaskSummary`] |
| list them on demand | no way. `$.agent.list()` lists subagents and teammates; it returned `[]` with two shells running | [probe; types: `AgentInfo`] |
| stop one | `$.tool.call({ tool: "TaskStop", task_id })`. It ran with only Bash and Read on the allow list, so no prompt, and it answered under a `toolu_plugin_…` id. The npm-tree caveat applies | [probe] |
| hear a death | `prompt.submit` with `e.origin.kind === "task-notification"`; `e.text` is the XML envelope above. The transcript row is `ui.render` `UserMessage`, with `e.props.task` (`id`, `status`, `durationMs`). There is no dedicated event | [probe; types: `UserMessageTask`] |
| read the output | `$.fs.read(<path from the start result>)`: the file is a plain file | [types: `$.fs`; not probed] |
| start one itself | `$.tool.call({ tool: "Bash", command, run_in_background: true })`: the same call the model makes. The probe's own foreground Bash calls ran | [types: `$.tool.call`; background start not probed] |

## 6. What this means for the comparison

Facts for [What does dev-server-manager add over Claude Code's background shells?](https://github.com/seanrobertwright/claude-mods/issues/154), not its answer:

- **Background shells already give:** a start (by asking the model); an output file the model can read; a crash notice that gives the model a turn, unasked, even when the session was idle; a stop and a list in `/tasks`; and a server that runs on through `/clear`.
- **They don't give:**
  - a restart, other than asking the model;
  - a port check before a start;
  - the URL, unless the model reads the file;
  - anything in view while the person works (`/tasks` has to be opened);
  - the error text in the crash notice;
  - a stop that frees an npm script's port on Windows.

  Every action also goes through the model, so each costs a turn.
- **The mod's own `$.process.spawn` servers** (per [How does a mod start, stop and read a dev server without a shell?](https://github.com/seanrobertwright/claude-mods/issues/151)) stop as a whole tree, and the mod sees their exit code at once. But the model can't read their output unless the mod tells it, and the person can't see them in `/tasks`.
- **A hybrid is possible:** the mod could run its servers as background shells through `$.tool.call`. The person would then see them in `/tasks` and the model could read them, but each stop would carry the Windows npm-tree leak.
- **Demand evidence is nil on this machine** (section 1).

## Probe notes

- **Run 1** (start, read, crash): the `-p` run never ended after its answer because `npm run dev` was still running. `timeout` killed it at 300 s. The probe's server tree (`cmd.exe` → `node long.js`, port 5312) survived, and I killed it with `taskkill /T`, after checking its command line.
- **Run 2** (start, `/reload-plugins`, `/clear`, check, as `stream-json` input): the queued prompt came in during the first turn, and `/clear` ran after the last, so the run tested neither `/reload-plugins` nor `/clear`. The mod's `TaskStop` on `npm run dev` left the server running; the probe's tree was killed by hand.
- **Run 3** (npm and bare node, both stopped by the mod): this run gave the stop result in section 3. Its first attempt never ran, because `--allowedTools` took the prompt as another tool name; the prompt then went on stdin. The probe's npm tree was killed by hand.
- **Run 4** (start, then `/clear`): gave the `/clear` result; `timeout` ended the run at 150 s, and the probe's tree was killed by hand.
- Every process killed was one the probe started, checked by command line (`node long.js`, `npm-cli.js run dev`) and by its port before the kill. No other process was touched, and ports 5311–5313 were free at the end.
