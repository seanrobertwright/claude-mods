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
The one exception is a key the person set that the model rejects: the mod names it as it would a missing requirement.
_Avoid_: Classifier, judge, small model (when a System One model is meant)

**Fallback**:
What a mod does for a judgment when no System One model answers, or its answer is too unsure to act on: what it did without one (its own code, a model call it already made, or asking the person), or nothing.
A fallback never costs more than the mod did without a System One model, and the mod uses it silently, whether no model was ever there or one stopped answering.
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
A mod stays quiet in a headless session: it draws nothing, polls nothing and starts nothing new, so no prompt and no headless run of its own.
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

### What a mod shows

**Pane**:
A titled panel a mod opens in Claude Code's side panel; when several are open, Claude Code shows them as tabs.
A mod opens its pane unasked only where Claude Code can seat it without taking over: when a surface that shows panes beside the conversation attaches, or at session start, where Claude Code seats an unasked pane only on a surface that places panes and only on a terminal wide enough for it.
Elsewhere, such as on a phone, it waits to be asked.
Asked, through the mod's own command, the pane comes in front of the others and takes the keyboard, which Esc hands back; an unasked open never takes the keyboard.
_Avoid_: Sidebar, tab, panel

**Band**:
The single row of buttons a mod draws directly above the prompt.
_Avoid_: Bar, toolbar, AbovePrompt

**Status line**:
The one line of text a mod shows in Claude Code's status area until it clears it.
_Avoid_: Statusbar, indicator

**Toast**:
A short message that appears and dismisses itself.
_Avoid_: Notification, alert
