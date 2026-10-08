# archon-panel answers an approval where the run already lives

archon-panel reads runs from Archon's server first and falls back to the CLI (ADR-0005), but it sends an answer the other way round for most runs.
A run started from the CLI, which has no parent conversation (`parent_conversation_id` is null), is always answered with `archon workflow approve|reject|respond <id> [text] --detach --json`, whether the server answers or not.
A run started from Archon's web UI or a chat is answered through the server's `POST /api/workflows/runs/{id}/approve|reject|respond` while the server answers, and through the same CLI call when it does not.

In Archon v0.11.1 the server's answer does resume a CLI-started run, but inside the server process, so restarting `archon serve` ends the rest of that run.
It also records the answer without resuming a container-isolated run or one started from Slack, Telegram or GitHub, and says which happened only in its message text.
The CLI's `--detach` checks the run read-only, refuses at once with Archon's own message, and runs the rest in a process of its own, as the run would have run without the pane.
The server's answer is kept for runs started from the web UI or a chat because it routes the rest of the run back to that conversation, which a CLI resume would not.
Answering is rare and off the poll, so the CLI's 0.6 s a call does not matter, and the CLI is already the mod's one Requirement.
The pane never calls `resume` unasked: an answer Archon records without resuming is shown with Archon's message, and the pane stops there.

## Resume and abandon

A run that needs the person but has no decision to answer is resumed or abandoned the same way (#161): an action-needed run, or a run its sub-run left paused.
A CLI-started run is resumed with `archon workflow resume <id> --detach --json` and abandoned with `archon workflow abandon <id> --json`.
A run from the web UI is resumed and abandoned through the server's `POST /api/workflows/runs/{id}/resume|abandon` while the server answers, and through the same CLI calls when it does not.
A run from Slack, Telegram or GitHub is abandoned through the CLI but never resumed from the pane: the server refuses it, and a CLI resume would cut the rest of the run off from its chat, which is why the web case uses the server.
Abandon has nothing to route back, so it is allowed for every run.
`resume --detach` does not check that the run's working path still exists, so the pane checks it first and offers only abandon when it is gone ([research](../research/archon-run-actions.md)).

## Considered Options

- Answer where the run already lives: the CLI for CLI-started runs, the server for runs from the web UI or a chat (chosen).
- Server first for every run, as reads are, with the CLI as the fallback: rejected, because it moves a CLI-started run into the server process and leaves some runs answered but still paused, which only a `resume` would finish.
- The CLI for every run: rejected, because the rest of a web-started run would no longer reach its chat.
