# archon-panel shows what a live run is doing: its Graph follows the run log, and Runs names its node

The Graph drew a live run's nodes from its events, read by the poll (ADR-0005): every 2 s with the server, 10 s with the CLI, and only when the run's row had changed. Each read fetched the run's whole event list, over 12,000 events for one 90-minute run, nearly all `hook_activity`. A row rarely changed while a run went: Archon moves `last_activity_at` on a heartbeat at most once a minute, and only while an AI node streams. A probe run of two 12-second bash nodes kept the same `last_activity_at` from start to finish. So a node could start and end without its box changing, and a running box differed from a waiting one only by a small `●`.

The Graph now follows the run's run log the way Log does: one `archon workflow logs <id> --follow` while a live run's Graph or Log is in front. The log writes each node's start, end, error or skip as it happens. Its markers name a node by `execution.path` (`fix-cycle.fix` for a loop's body node), the name the events use. While the follower is on the run, a node the log names takes its look from the log, and the events fill in the rest. An approval's look wins over both. Once the follower stops, the events alone draw the graph again, so a log left behind cannot keep a finished node running.

A running node's box flashes in `success`: heavy and bold on one beat, light and dim on the next. A 500 ms timer bumps a counter in state, and each bump redraws the Graph. The timer runs only while the followed run's Graph is in front, and stops at the first tick that finds it is not. A line under the header names the running nodes, how long the longest has run, and the newest tool call or model text written since the newest of them started.

Runs names the node each running run is on, from the `active_nodes` that Archon's runs list already carries, on the server and the CLI alike. It costs no extra read and is as fresh as the poll. A loop's body node is named instead of its loop, and the nodes running beside it are counted. The nodes a row is on are part of its signature, so a node starting or ending also has the run's events read again, heartbeat or not.

## Considered Options

- Follow the run log for the Graph too, and flash on a timer while it is in front (chosen). It needs no new Requirement and keeps the follower's existing lifecycle (attach, detach, reload). It reads the run log once from its first line, then each line as it is written, never the run's events again.
- Hold Archon's `__dashboard__` stream through `curl -sN` for its `dag_node` events: rejected for ADR-0005's reasons. It needs the server, and its events still say nothing of what a node is doing.
- Poll faster while the Graph is in front: rejected. Each poll refetches every event of the run, and the CLI's every call costs most of a second of CPU.
- For Runs, follow every live run's run log: rejected. It costs a child process per live run, while the runs list already says which nodes are active.
- Mark a running node with colour alone, without a flash: rejected. A terminal shows bold and dim close together, so a running box read much like the others. Heavy and light lines differ in shape on every terminal.
