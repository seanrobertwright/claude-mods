# claude-mods

One developer's personal toolbox of Claude Code mods, shared as a marketplace so anyone can install them.
The mods are built for the author's own workflow first; another user is a welcome guest, not the design target.
An _Avoid_ word is wrong only where it names that entry's concept; Claude Code's own identifiers and the same word for an unrelated idea are fine.

## Language

### Mods and what they are not

**Mod**:
A plugin of function hooks that changes what Claude Code shows or does between turns.
The mod's own code decides when it acts, even when what it does is send the model a prompt.
The marketplace lists mods and nothing else.
_Avoid_: Extension, addon, plugin (when a mod is meant)

**Function hook**:
A TypeScript handler a mod registers on a Claude Code event; it runs inside Claude Code, unlike a shell-command hook.
_Avoid_: Callback, listener

**Skill**:
Instructions the model reads and follows. A mod may call a skill but never ships one.
_Avoid_: Command, prompt (when a skill is meant)

**Requirement**:
Something outside the mod that it needs to work, such as a skill, a CLI tool or a logged-in account.
A tool too old to do what the mod needs counts as missing.
Something the mod prefers but works without, such as a faster source of the same data, is not a requirement.
A mod detects a missing requirement and names it, with how to meet it, instead of failing obscurely.
It says so where the person looks for the mod, such as its pane, and never opens anything on its own just to report it.
_Avoid_: Dependency, prerequisite

**Marketplace**:
This repository as Claude Code sees it: a catalogue naming each mod, from which a person installs the mods they want one at a time.
_Avoid_: Registry, store, package

### System One models

**System One model**:
A model outside Claude that answers a typed question about text (one of several choices, yes or no, or a place on a scale) in a single quick step, without writing text: Jev, which TypeSafe hosts, or Laya, which runs on the person's own machine.
A mod may use one to make a judgment better, but never needs one to work, so it is not a **Requirement**.
The one exception is a **Model choice** that allows the hosted model with no key that model accepts, whether none is set, the one set is malformed, or the model rejects it: the mod names it as it would a missing requirement.
Which of the two a mod asks is the person's **Model choice**.
_Avoid_: Classifier, judge, small model (when a System One model is meant)

**Local model**:
Laya running on the person's own machine and reached at that machine's own address.
Text a mod sends to it stays on the machine.
A Laya anywhere else is not a local model, and a mod does not use it.
The person starts it; a mod never does.
A mod counts it available only when what answers at that address says it is Laya.
_Avoid_: Offline model, self-hosted model

**Hosted model**:
Jev as TypeSafe itself serves it.
Text a mod sends to it leaves the machine, and TypeSafe keeps it.
A mod sends it only what its judgments were declared to send, and never the contents of a file the mod read itself.
That text and the person's key go to TypeSafe and nowhere else.
_Avoid_: Cloud model, remote model

**Model choice**:
The person's setting, one per mod, for which System One models that mod may ask: _local only_, _local first_ or _hosted first_.
It starts at local only, so a key alone never sends anything to the hosted model.
Under local first the mod asks the local model, and the hosted model only while the local one is unavailable; hosted first is the reverse.
A mod asks one model for a judgment: when that model gives no answer it can act on, the mod uses its **Fallback** and does not ask the other.
A model is unavailable for a while after it fails, and the hosted model for the rest of the session once it rejects the key.
A model still busy with another ask is not unavailable: the new ask takes the **Fallback**.
_Avoid_: Backend, provider, mode

**Local-only folder**:
A folder the person has marked so that no mod sends anything to the hosted model from it or from any folder beneath it, whatever the mod's model choice.
The mark takes effect at once, for the next thing a mod would send.
_Avoid_: Private repo, offline folder

**Fallback**:
What a mod does for a judgment when no System One model answers, or its answer is too unsure to act on: what it did without one (its own code, a model call it already made, or asking the person), or nothing.
A fallback never costs more than the mod did without a System One model, and the mod uses it silently, whether no model was ever there or one stopped answering.
It follows the one model the mod asked, even while the other is running.
_Avoid_: Degraded mode, offline mode

### Sessions

**Surface**:
A place a session is shown: the terminal, the desktop app, a phone or the editor.
A session can be shown on several surfaces at once.
_Avoid_: Screen, client

**Interactive session**:
A Claude Code session shown on at least one surface: the terminal from the start, or the desktop app, a phone or the editor from the moment someone opens it there.
A session started without a surface becomes interactive when one is attached.

**Headless session**:
A session shown on no surface: a `claude -p` process, or an SDK session nobody has opened.
A mod stays quiet in a headless session: it draws nothing, polls nothing, asks no System One model and starts nothing new, so no prompt and no headless run of its own.
Work set going while the session was shown, such as a resume after a rate limit, still finishes.
_Avoid_: Background session, child session

**Headless run**:
A headless session a mod starts beside the interactive session to do work for it, and whose output the mod reads.
Each headless run is itself a headless session, so the person's mods load into it.
_Avoid_: Helper, child, subprocess, background run

### What's next

**Next-steps list**:
The ordered steps whats-next shows for one project folder, kept between sessions.
_Avoid_: Plan, todo list, roadmap

**Step**:
One entry of a next-steps list: a short title, a one-line reason it comes at this point, and a prompt ready to paste.
A step's prompt reaches the model only when the person reads it and sends it themselves.
_Avoid_: Task, item, action

**Stale**:
Said of a next-steps list when the repo has moved since it was made: a new commit or a different branch.
A stale list is still shown until a fresh one replaces it.

### Archon

**Run**:
One execution of an Archon workflow, started from the CLI, the web UI or a chat platform, kept in Archon's one store for the whole machine.
A run belongs to the project it was started in; archon-panel lists the session's project's runs and only counts the others' live runs.
_Avoid_: Job, execution, task

**Node**:
One step of a workflow, which may wait on other nodes; a run's nodes and the waits between them form its graph.
_Avoid_: Step (a Step is a whats-next entry), stage, task

**Live run**:
A run that has not ended: waiting to start, running, or paused, whether on an approval or on a wait node.
A run ends when it completes, fails or is cancelled.

**Approval**:
A point where a run pauses until a person answers it: approve, reject, or another decision its workflow declared, with an optional comment.
It is an approval node, or a loop that stops between rounds for the person's say.
A run paused on a wait node is waiting on an outside event or a time, not on the person, so it is not on an approval.
Answering an approval is the only action archon-panel takes on a run.
_Avoid_: Gate (Archon's gates include checks a script or another agent decides)

**Run log**:
What a run has said and done so far: the running node's model output and tool calls, each node's output or error, and the files it wrote.
Archon's own process log is not a run log.
_Avoid_: Transcript, output (when the whole log is meant)

### What a mod shows

**Pane**:
A titled panel a mod opens in Claude Code's side panel; when several are open, Claude Code shows them as tabs.
A mod opens its pane unasked only where Claude Code can seat it without taking over: when a surface that shows panes beside the conversation attaches, or at session start, where Claude Code seats an unasked pane only on a surface that places panes and only on a terminal wide enough for it.
Elsewhere, such as on a phone, it waits to be asked.
Asked, through the mod's own command, the pane comes in front of the others and takes the keyboard, which Esc hands back; an unasked open never takes the keyboard.
_Avoid_: Sidebar, tab, panel

**Sub-tab**:
One part of a single pane, picked from a row of buttons the mod draws at the top of that pane; archon-panel's are Runs, Graph, Log and Archon's log.
A pane's sub-tabs open and close with it and share its one scroll window; the tabs Claude Code shows are panes, each opened and closed on its own.
_Avoid_: Tab (Claude Code's tabs are panes), page, section

**Band**:
The single row of buttons a mod draws directly above the prompt.
_Avoid_: Bar, toolbar, AbovePrompt

**Status line**:
The one line of text a mod shows in Claude Code's status area until it clears it.
Each session keeps its own, and it is not the status line the person configures in their settings.
_Avoid_: Statusbar, indicator

**Toast**:
A short message that appears and dismisses itself.
It shows only in the session that raised it, so with several sessions open, each raises its own unless the mod checks what another already raised.
_Avoid_: Notification, alert

**Settings dialog**:
The pane mod-settings opens, from the gear at the top right of a mod's pane or from its command, where the person changes and saves the settings of the installed mods that have any.
A saved value is kept where Claude Code keeps that mod's settings, and the mod reloads with it.
_Avoid_: Settings pane, config menu
