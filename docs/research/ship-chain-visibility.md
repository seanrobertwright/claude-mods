# What a mod can see of a running ship chain

Research for [What can a mod see of a running ship chain?](https://github.com/seanrobertwright/claude-mods/issues/136), on the [ship-pipeline map](https://github.com/seanrobertwright/claude-mods/issues/135).
Sources: the function-hook API this build declares (Claude Code 2.1.294, `plugin-authoring/types/claude-code.d.ts` and `reference.md`), the `ship` plugin v0.2.0's `skills/post-execute/SKILL.md`, the `lril` skill's `commands/execute.md`, and the hooks this repo's mods already use.
Nothing was pushed, opened or merged, and no probe mod was loaded: the declarations answer every question below except the one marked **check at build**.

## Short answer

Yes, events alone are enough to show the phase from start to merge, with no change to the `ship` plugin.
Every skill the chain runs raises `skill.prompt` with its name. Every git and gh command is a Bash `tool.call` whose command line and result the mod can read. The triage gate is an `AskUserQuestion` call. A chain that stops for the person ends its turn before the merge.
The one thing events can't give is *why* a turn ended mid-chain: a STOP condition, a question asked in plain text, or the model simply ending its turn. That takes either a judgment on the turn's final text or a fixed line the skill prints, and a mod can add that line itself through `skill.prompt` without editing the plugin.

## The events a mod gets during the chain

| Event | What it carries | What it tells ship-pipeline |
| --- | --- | --- |
| `turn.start` | the prompt text, `turnId` | the person typed `/lril:execute …` or `/ship:post-execute …` (the text), or a continuation (`""`) |
| `skill.prompt` | `skill` (the name a matcher narrows on), `text` (the skill's prompt as expanded) | a skill began: fired when it's typed as `/name`, called through the Skill tool, or preloaded into a subagent. The hook may also **rewrite** `text`, which is what the model reads |
| `tool.call` (Bash) | `e.input.command`; `await next(e)` resolves `{ result, text, isError }` | the git and gh steps and whether each one worked |
| `tool.call` (AskUserQuestion) | the questions | the chain is waiting on the person inside the turn (turn-chime already matches this) |
| `tool.call` / `turn.step` with `agentId` | the subagent's loop id | subagent work, such as `prp-review --agents all` fanning out; filter `agentId === undefined` for the main chain |
| `turn.step` (streaming) | text, thinking, tool-call chunks as they stream | the model's own words live, such as a "PHASE 3" heading |
| `turn.complete` | `answer` (final visible text), `reason` (`answer`, `aborted`, `refusal`, `error`), `isAborted`, `durationMs` | the turn ended: finished, interrupted, refused or died on an API error |
| `session.append` / `$.session.messages()` | each row as it's stored / `{ role, text, toolUses }` rows | the transcript, readable at any time without opening the file |
| `prompt.submit` | the person's text | the person typed something else mid-chain |

`classic.Stop` and the other settings-hook events are hookable too, and carry `transcript_path`, but nothing above needs them.

## Each `post-execute` phase and what marks it

`post-execute` delegates to bundled commands (`/ship:commit`, `/ship:code-review`, `/ship:code-review-fix`, `/ship:execution-report`, `/ship:prp-review`), each called as a skill, so `skill.prompt` names most phases outright.
A profile may point them at other commands (`/lril:*`), so the mod matches the profile's names, not only `ship:*`.

| Phase | Starts on | Ends on |
| --- | --- | --- |
| execute (before `post-execute`) | `skill.prompt` for `lril:execute` (or the variant's execute) | its turn's `turn.complete`, or `skill.prompt` for `post-execute` in the same turn |
| 0a preflight, 0b profile | `skill.prompt` for `post-execute`; Bash `git rev-parse`, `git status --porcelain`, `gh auth status` | the next phase's mark |
| 1 commit | Bash running the gate command (from the profile; unmarked by name), then `skill.prompt` for the commit command | a Bash `git commit` whose result isn't an error |
| 2 review and report | `skill.prompt` for the code-review command, then for the execution-report command | the next mark |
| 3 triage and fix | `tool.call` AskUserQuestion (only if there were findings), then `skill.prompt` for code-review-fix | a repeat of the code-review command (re-review) or the push |
| 4 push and open PR | Bash `git push` | Bash `gh pr create`, whose result holds the PR URL |
| 5 CI first pass | Bash `gh pr checks` (`--watch`, or polled every ~60 s) | the next mark; red means a fix commit and push, then `gh pr checks` again |
| 6 deep PR review | `skill.prompt` for the PR-review command; subagent `tool.call`s carry an `agentId` | the next mark |
| 7 triage, fix, comment | AskUserQuestion again; Bash `gh pr comment` | the next `gh pr checks` |
| 8 CI second pass, merge | Bash `gh pr checks` after a PR review; Bash `gh pr merge` | a `gh pr merge` that isn't an error, then `git checkout <base> && git pull` |

**Unmarked or ambiguous:** the gate commands have no fixed name (they come from the profile or `package.json`); phases 5 and 8 both run `gh pr checks` and are told apart only by whether the PR review has run; the triage gate is skipped when there are no findings, so its absence isn't a missed event.

## Waiting on the person

- **Inside the turn:** an `AskUserQuestion` call is the triage gate (or any other question). The turn is still running, and the tool call's result arrives when the person answers.
- **The turn ended before the merge:** `post-execute` says it runs "without further prompting", so a main-loop `turn.complete` with `reason: 'answer'` before a successful `gh pr merge` means the chain stopped, either on one of its nine STOP conditions or because the model ended the turn early. `reason: 'aborted'` is the person interrupting, and `'error'` is an API error or a rate limit (the auto-resume mod's case).
- **Telling those apart** needs the turn's `answer` text. Code can't tell "CI red after two fix attempts" from "On the base branch" without reading it: that's a judgment from text, so it needs a System One verdict, unless a phase marker settles it (below).

## Reading the model's text instead

`turn.step` streams every text chunk to a mod (the hud mod already hooks it), `turn.complete` hands over the final answer, and `$.session.messages()` reads the transcript on demand.
Cost is the mod's own string matching; none of it starts a model call.
Matching the skill's own headings (`## PHASE 4 — Push and open the PR`) in streamed text is brittle, because the model doesn't echo the skill's headings reliably. Events are the sturdier source; text is for the stop reason.

## A phase marker, if one is wanted

No edit to the `ship` plugin is needed: a `skill.prompt` hook on `post-execute` (and the execute skill) can append one instruction to the skill's text, for example *"At the start of each phase, print a line `⟦ship phase: <n> <name>⟧`; when you stop for the person, print `⟦ship stop: <condition number>⟧` first."*
The mod then reads those lines from `turn.step` or `turn.complete`, which turns the stop reason into a typed answer (no System One judgment).
The same line could be added to `SKILL.md` in the claude-ship repo, which keeps it visible to anyone reading the skill but ties the mod to a plugin version.
Rewriting another plugin's skill text is a visible behaviour change the mod's README must name; the engine allows it to any loaded plugin.

## The execute step

`/lril:execute` works through the plan's "Step by Step Tasks", then validation gates, then a pre-commit hygiene gate, and ends with an output report ("Ready for Commit").
It has no phase markers and doesn't require a task tool, so what a mod sees is `skill.prompt` at the start, file edits and Bash validation commands in between, and `turn.complete` at the end. Progress within the plan (task n of m) isn't visible without a marker or reading the plan file.
`core_piv_loop/execute.md` was not read here; the command-set inventory belongs to [Which ship command sets exist, and how can a mod find them?](https://github.com/seanrobertwright/claude-mods/issues/137).

## Check at build

- **The `skill` name for a plugin command:** whether `skill.prompt`'s `skill` reads `ship:post-execute` or `post-execute`, and `lril:execute` or `execute`. The declaration's only example is `commit`. Match on the part after the last `:` until a probe settles it.
- **`gh pr checks --watch`** can run past the Bash tool's timeout or go to the background; the skill falls back to polling. Either way each call is a `tool.call`, but a backgrounded watch's result arrives later as a task notification, not as that call's result.
