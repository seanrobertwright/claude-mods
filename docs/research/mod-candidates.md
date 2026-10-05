# Candidate mods

A fresh list of mods worth building next, drawn from the author's own Claude Code session data on one machine as of 2026-10-05.
It is a proposal, not a record: the earlier discussion of viable mods happened on another machine and could not be recovered.

## What was reviewed

- The prompt history: 345 prompts over 40 active days, 2026-06-23 to 2026-10-05, across about 40 project folders.
- The 27 session transcripts still on disk: tool calls, tool errors, turn lengths, permission modes and away summaries.
- The engine types and the `plugin-authoring` skill bundled with Claude Code 2.1.289, to confirm each candidate can be built.

Limits: the transcripts cover only recent sessions, so counts taken from them are a floor, and nothing from the other machine is included.
Counts of prompts were made by reading the history and are approximate.

## What the sessions look like

Most of the work is document work, not code.
A session starts in a folder for one job, reads source records from a network drive and a local knowledge base, and produces Word, PowerPoint, Excel and PDF files in the house branding.
Every recorded session ran with permission checks bypassed.
Sessions are short in prompts (a median of 3 per session) but long in waiting: 24 of the 93 measured turns ran over 5 minutes, 5 ran over 15, and the longest ran 66.

## Recommended order

| Order | Mod | Shows as | Why now |
| --- | --- | --- | --- |
| 1 | protected-paths | toast, status line | Guards the source records while permission checks are bypassed |
| 2 | shelf | band or pane | Removes the most repeated typing in the history |
| 3 | open-file-guard | toast | Stops a failure that needs a round trip with the person each time |
| 4 | outputs | pane | Answers "where is the file" without a prompt |
| 5 | turn-chime | sound, toast | Long turns end unnoticed |
| 6 | sources | pane | Shows which folders an answer drew on |
| 7 | copy-plain | band | Email drafts arrive as Markdown |
| 8 | missing-tool | status line | The same missing tools fail again in each session |
| 9 | actions-panel | pane | Brings overdue actions into view, as github-panel does for issues |

The first five each answer a pattern seen many times and need nothing outside the mod.
The last four are narrower or need a requirement.

## The candidates

### 1. protected-paths

Refuses a tool call that would change, move or delete anything under a folder the person has marked read-only.

- **Seen in the sessions**: every recorded session ran with permission checks bypassed, the source records sit on a shared network drive, and one prompt had to say "make sure not to delete or move any of the files".
  The engine blocked one removal on a protected path by itself; nothing guards the network drive.
- **How it works**: a `tool.call` hook on Write, Edit, Bash and PowerShell returns `{ deny }` with a reason naming the folder when the target path, or a path in the command, falls under a marked folder.
  The marked folders are kept in `$.store`, and a command adds or removes one.
- **Open question**: a shell command can reach a path in ways a pattern will miss, so the mod can promise only to catch the plain cases.
  The reason it gives must say so.

### 2. shelf

A set of named folders and files the person can drop into the prompt with one click.

- **Seen in the sessions**: the same branding folder path was typed or pasted in more than twenty prompts, and the network drive and knowledge base paths in about ten more.
  About eight prompts asked where a known document lives.
- **How it works**: a band of buttons, or a pane when the shelf is long, drawn from names and paths kept in `$.store`.
  Pressing one calls `$.prompt.fill` in `insert` mode, so the path lands at the cursor and nothing is sent.
  A command adds the current folder or a given path under a name.
- **Open question**: band or pane.
  quick-reply already owns a band, and two bands stack; a pane costs width.
  Typing a short name that expands on `prompt.edit` is a third way that needs no room at all.

### 3. open-file-guard

Stops a write to an Office file that is open in Word, Excel or PowerPoint, and says which file to close.

- **Seen in the sessions**: three prompts exist only to say a file has been closed ("I closed the deck", "I closed the inventory", "ok, they're closed"), each after a failed write and a request to close it.
- **How it works**: a `tool.call` hook checks, before a write to a `.docx`, `.xlsx` or `.pptx` file, whether Office's lock file (`~$` plus the name) sits beside it.
  If so it shows a toast naming the file and waits on a timer for the lock to go, then lets the call through; after a bound it denies with the reason.
- **Open question**: most of these writes come from a Python script run through the shell, where the target file is not an argument the hook can read.
  The first version may cover only the case where the file name appears in the command.

### 4. outputs

A pane listing the files this session has made or changed, newest first.

- **Seen in the sessions**: prompts such as "where is the slide-2 preview?" and "where can I find the original files?", and sessions that leave several deliverables and many scratch files in one folder.
- **How it works**: after each `tool.call` that writes, and at `turn.complete`, the mod lists files in the project folder changed since the session began, using `$.fs`.
  Clicking a file opens it with its own application through `$.process`; a second action copies its path with the clipboard.
  Scratch files (scripts, images made for checking) fold under one line.
- **Requirement**: none.

### 5. turn-chime

Plays a sound and shows a toast when a long turn ends or the model is waiting on an answer.

- **Seen in the sessions**: a quarter of measured turns ran over 5 minutes, and the transcripts hold 48 away summaries, each written because the person had left.
- **How it works**: a `turn.start` hook notes the time; `turn.complete` calls `$.audio.play` and `$.ui.toast` when the turn ran longer than a set number of minutes.
  It stays quiet in a headless session.
- **Open question**: whether a sound reaches the person on a surface other than the terminal.

### 6. sources

A pane listing the files read this session, grouped by the folder they came from, with a switch that keeps reads inside the project folder.

- **Seen in the sessions**: "why are you looking at the knowledgebase - I want you to look at the docs in THIS directory as your source of truth" and "you cited [records] - where did you find those records".
- **How it works**: a `tool.call` hook on Read, Grep and Glob records each path.
  The pane groups them under the project folder, the network drive, the knowledge base and elsewhere.
  With the switch on, the hook denies a read outside the project folder and the shelf's folders.
- **Overlap**: shares its path matching with protected-paths.
  Under ADR-0001 each mod carries its own copy.

### 7. copy-plain

A button that copies the last reply as plain text, ready to paste into an email.

- **Seen in the sessions**: about eight prompts asked for an email draft, and one followed up with "I don't want the email to be in markdown, copy it into a format I can use inside an email body".
- **How it works**: after `turn.complete`, a band button strips the Markdown from the last reply, or from the fenced draft inside it, and puts it on the clipboard.
- **Open question**: this could be one more button on quick-reply's band instead of a mod of its own.

### 8. missing-tool

Notices when a tool call fails because a program is not installed, and keeps the list in view.

- **Seen in the sessions**: PDF page rendering failed four times for want of `pdftoppm`, and `pandoc` was missing once; each failure came back in a later session.
- **How it works**: a `tool.call` hook reads the result for "is not installed" and "command not found", records the program in `$.store`, and shows a count in the status line.
  Its command lists each one with the line that installs it.
  It installs nothing itself.

### 9. actions-panel

A pane listing overdue and coming-due corrective actions from the site's safety system.

- **Seen in the sessions**: recurring prompts built summaries of overdue and coming-due actions by hand from exported files.
- **How it works**: the same shape as github-panel, with the safety system's command-line tool in place of `gh`: a poll while a surface is attached, a list, and a click to open the record.
- **Requirement**: the command-line tool, installed and logged in.
  A missing one is named in the pane.
- **Note**: useful to the author only, which the glossary allows.

## Considered and left out

- **Standing instructions** (default to Word output, apply the branding, follow the controlled-document format): the corrections recur, about five times for the output format alone, but fixed instructions belong in the user's `CLAUDE.md` or a skill.
  No code needs to decide anything.
- **Phase progress** ("start phase 2", "proceed with phase 5"): whats-next already covers it.
- **Unpushed-work status line**: a few sessions back their work up to a repository, too few to earn a mod yet.
- **A session picker**: `/resume` was used seven times, and the engine's own picker serves.

## Chosen

The author chose five on 2026-10-05.
Each has an issue that settles its open question and lists its acceptance criteria.

| Mod | Issue |
| --- | --- |
| shelf | #41 |
| open-file-guard | #42 |
| outputs | #43 |
| turn-chime | #44 |
| sources | #45 |

protected-paths, copy-plain, missing-tool and actions-panel were not chosen and have no issue.
