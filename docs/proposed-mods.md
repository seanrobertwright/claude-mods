# Proposed mods

Mod ideas raised in past Claude Code sessions on this computer and not yet built, gathered on 2026-10-05.
Mods built from a proposal, or that cover part of one, are listed at the end.

## Where the ideas come from

Nearly all of them come from one brainstorm, in session `e2d3b04d` on 2026-10-04.
A background agent mined the prompts you had typed across your sessions for work you repeat by hand, and the assistant condensed what it found into a ranked table.
The ranking (shown as rank n below) is the assistant's, not yours.
The agent's fuller report is in that session's subagent log, `agent-a60205fa304c876a3.jsonl`.

What you decided around it:

- You picked two from the table: "ok build #3 and #5 next". These became quick-reply and auto-resume.
- Later the assistant offered three next steps: build the ship pipeline and the CI watcher, file the remaining ideas as issues, or build the small ones (the env guard, the branch guard, the post-merge cleanup). You dismissed the question without choosing, and asked for the GitHub tab instead: "I really LOVE the side panel mod. I want to put other things inside it."
- In session `5f436923` (also 2026-10-04), the grilling on what to build next found no named candidate for another mod. It recommended hardening the existing mods first, with the next mod getting its own grilling once you could name it. You answered "Go with your recommendation".
- In the same session you chose "Accept it and make it a rule": a step's prompt reaches the model only when you send it yourself (CONTEXT.md, **Step**). Ideas below that would send prompts on their own run into this rule, and each such idea says so.

None of these ideas was rejected when they were raised; they were left unchosen.
Each is filed as an issue.
The triage of 2026-10-06 is recorded on each issue, and the ideas it closed are written up in `.out-of-scope/`.

Sessions on your other computer are not covered, and that includes the ones that produced shelf, turn-chime, open-file-guard, outputs, sources and hud.

## Workflow and shipping

### ship-pipeline (`/ship`) (rank 1, issue #55)

One command or button runs the chain you type by hand: execute the plan, code-review, execution report, fix, commit, push, open the PR, wait for green CI, merge, delete the branch, clean up.
A band shows the step it is on, and a setting picks the lril, piv or core_piv variant of the chain.
Evidence: dozens of long pipeline prompts typed by hand.
The assistant recommended it, together with ci-watcher, as the next build after quick-reply and auto-resume; you didn't pick it.
It runs into the "you send it yourself" rule: as proposed, it sends each step's prompt on its own.

### ci-watcher (rank 2, issue #56)

A timer polls `gh pr checks`.
The status line shows the state, and a toast and sound go off on green or red.
On red it could queue "CI failed: \<log\>, fix it", with optional auto-merge and branch deletion after green.
The session noted that GitHub Actions wasn't usable on the account at the time.
Queuing the fix prompt would need to respect the "you send it yourself" rule.

### workflow-auto-advance (rank 4, issue #57)

Knows your command chains (prime → plan-feature, execute → post-execute, the gsd phases, superpowers write-plan → execute-plan, the piv chain).
When a turn ends, a band offers the next command in the chain; `/autochain on` would queue it, including the `/clear` between steps.
The brainstorm suggested a "workflow engine" shared with whats-next and wayfinder-autopilot. ADR-0001 (mods are self-contained) and ADR-0002 now argue against sharing one.
Offering the next command fits the "you send it yourself" rule, but queuing it does not.

### wayfinder-autopilot (rank 7, issue #58)

On `/wayfinder <url>` (a prompt-submit hook), it names the session after the issue, pins the issue in a pane, and offers the next ticket from the parent issue's sub-issues.

### post-merge-cleanup (rank 12, issue #59)

When a PR merges, or on `/cleanup`: switch to main, pull, delete the branch and its worktree, prune.
One of the three "small ones" offered and not chosen.

### reset-and-reprime (rank 16, issue #60)

One button that runs `/clear`, then the project's prime command, then the queued next step, carrying a handoff note across.
Sending the queued step runs into the "you send it yourself" rule; it could fill the prompt instead.

### morning-standup-band (rank 25, issue #61)

On the first session of the day, a band with yesterday's merged PRs, the open PRs and their CI state, and the top next steps across your repos.

## Guards

### env-guard (rank 11, issue #63)

A tool-call hook that blocks Read, Grep and `cat` on `.env*` and key files, and points the model to keypick instead.
One of the three "small ones" offered and not chosen.

### pre-pr-claims-check (rank 22, issue #65)

Blocks `gh pr create` while the diff holds `file:line` citations, "(PR #NN)" placeholders, "TODO fill in" or counts typed by hand: the bans in your global rules.

### lint-test-gate (rank 21, issue #66)

A "Gate" button and status-line entry.
It runs the project's checks in the background (ruff, mypy and pytest, or the npm scripts) and sends back only the failures, possibly also as a hook before `git commit`.

## Feedback and testing

### uat-pass-fail-pad (rank 6, issue #67)

During `/gsd:verify-work` or a UAT, a band with Pass, Fail and Skip buttons and a note field.
Fail opens a comment box and can attach a pasted image.
Evidence: over a hundred one-word "pass" prompts.

### error-capture (rank 8, issue #68)

A command or button that grabs the clipboard or the tail of the dev server's log, trims it, and turns it into a fix request.
It recognises the Next.js error overlay's format and could watch a log for new errors.

### ui-fix-check (rank 17, issue #69)

When the model says it fixed something in the UI, a hook makes it check in the browser and attach a screenshot before it says it's done.

### chrome-tab-self-heal (rank 20, issue #70)

When a browser tool answers "tab no longer exists", it tells the model to call `tabs_context_mcp` before trying again.

## Session and environment

### session-auto-namer (rank 13, issue #71)

Suggests a session name from the first prompt, such as "M12 - S4 - Execute" or an issue's number and title, applied with one click.

### model-effort-presets (rank 14, issue #72)

Band buttons or a command for "plan" and "execute" pairs of model and effort, optionally switched by workflow step.

### typo-fixer (rank 15, issue #73)

Rewrites the prompt before it is sent: fixes typos you often make ("Fiz", "contine", "delete the brand") and expands your shorthands ("c&p", "mwg").

### dev-server-manager (rank 9, issue #74)

A pane listing each project's dev servers with start, stop and status buttons, a check that the port is free, restart when one dies, and a toast when it does.

### plugin-admin-pane (rank 23, issue #75)

A pane showing the health of plugins, skills and MCP servers, with buttons to reload them.

## Partly covered by a built mod

- **Issue and PR board, rank 18 (issue #76).** Open issues and PRs with their CI state; a click fills `/wayfinder <url>` or `/implement <url>`.
  github-panel lists the issues and PRs, with each PR's checks; a click opens them in the browser.
- **Usage meter, rank 24 (issue #77).** A warning before you hit the rate limit.
  hud shows the rate limits; only the warning is missing.

## Built from a proposal

- **whats-next**: your own request in `e2d3b04d`, and an idea in the brainstorm too. The proposal's "or run it" part was ruled out by the "you send it yourself" rule.
- **quick-reply**: rank 3, picked by you.
- **auto-resume**: rank 5, picked by you.
- **github-panel**: your own request in `e2d3b04d`, close to rank 18 above.
- **branch-guard**: rank 10 (issue #62), one of the three "small ones" offered and not chosen. hud already showed the git state, so it adds only the question before a commit or push on the default branch.
- **bash-quoting-rescue**: rank 19 (issue #64). It asks the shell's own parser, bash or PowerShell, whether a command parses, instead of counting quotes.
