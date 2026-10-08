# archon-panel polls Archon instead of holding its event stream

Archon's server streams every run's changes as server-sent events (`GET /api/stream/__dashboard__`), and Archon's own web UI listens to them.
archon-panel polls instead: one timer per session asks the server's REST API, or the Archon CLI in the same tick when the server does not answer, at a rate set by what the person can see.
A mod cannot hold the stream with the engine's own network call, because `$.http.fetch` resolves only once a body ends; it can only spawn `curl -sN`, and a module reload kills that child.
The stream replays nothing on connect and says only that a run changed, so every event would still end in the REST fetch a poll makes, and the CLI fallback has to poll whatever the server offers.
A stream would buy a toast up to one poll interval sooner, at the cost of a new Requirement (`curl`), a second child process to restart on reload and attach and to stop on the last detach (the guards ADR-0002 found drifting between mods), and a second path to keep in step with the poll.

The Archon CLI stays a Requirement even while the server answers.
A run's model text and tool calls exist only in its transcript, which the mod follows with `archon workflow logs <id> --follow` (Archon v0.11.0 and later), and the server's approve leaves a CLI-started run paused (`docs/research/archon-api.md`).
That last reason was wrong: the server's approve resumes a CLI-started run inside the server process, and ADR-0006 sends such answers through the CLI anyway.

## Considered Options

- Poll the server's REST API, and the CLI in the same tick when the server does not answer (chosen).
- Hold `__dashboard__` through a spawned `curl -sN`, refetch over REST on each event, and keep a slow poll as a safety net: rejected for the reasons above.
  If toasts ever need to come sooner, the stream can be added as one more trigger for the same fetch.
- Poll only the CLI, as the first cut does: rejected, because each call took about 0.8 s of CPU on the author's machine, paid by every open session, and the server was already the preferred source.
