# claude-mods

One developer's personal toolbox of Claude Code mods, shared as a marketplace so anyone can install them.
The mods are built for the author's own workflow first; another user is a welcome guest, not the design target.
A sentence marked _Target_ is a rule every mod is meant to follow; not every mod follows it yet.
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
_Target_: a mod detects a missing requirement and names it, with how to meet it, instead of failing obscurely.
It says so where the person looks for the mod, such as its pane, and never opens anything on its own just to report it.
_Avoid_: Dependency, prerequisite

**Marketplace**:
This repository as Claude Code sees it: a catalogue naming each mod, from which a person installs the mods they want one at a time.
_Avoid_: Registry, store, package

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
_Target_: a mod stays quiet in a headless session: it draws nothing, polls nothing and starts nothing new, so no prompt and no headless run of its own.
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
_Target_: a mod opens its pane unasked only on a surface that shows panes beside the conversation; elsewhere, such as on a phone, it waits to be asked.
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
