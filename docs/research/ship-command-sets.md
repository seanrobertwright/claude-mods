# Which ship command sets exist, and how a mod finds them

Research for [Which ship command sets exist, and how can a mod find them?](https://github.com/seanrobertwright/claude-mods/issues/137), on the [ship-pipeline map](https://github.com/seanrobertwright/claude-mods/issues/135).
Sources: the command files on this machine (`~/.claude/skills/lril/commands/`, the `ship` plugin v0.2.0, the `prp-core` plugin, each repo's `.claude/commands/`), this build's function-hook declarations (Claude Code 2.1.294), and the person's typed prompts in `~/.claude/history.jsonl` (3,019 prompts, 2026-03-13 to 2026-10-08).
Session transcripts under `~/.claude/projects` only reach back to 2026-09-03 and hold almost no chain prompts, so the history file is the evidence for what was typed.

## Short answer

- **Three of the sets are one lineage.** `core_piv_loop` + `validation` (project-local, the Dynamous workshop original), `lril` (the person's evolved global copy) and `ship` (`post-execute` plus vendored copies of five `lril` commands) are the same commands at three ages.
  Only `ship` chains them itself; the other two were always chained by hand.
- **What the person typed moved over time:**
  - April to June: one command per prompt (`/core_piv_loop:execute`, `/validation:code-review`, `/commit`, then "push it, create a PR"), merging on GitHub by hand.
  - June to August: prose chains in one prompt ("use the execute skill on … then the code review and execution report skills … commit, push, PR, once CI is green merge and delete the branch").
  - From 2026-07-31: `/ship:post-execute` (5 times).
  - October: issue-driven prompts (`/implement`, `/wayfinder`) that end in a "Finish:" block (commit, push, PR, sometimes merge and close the issue), with cleanup as a later prompt of its own.
- **The tail was typed more often than the whole chain.** Execute was usually its own prompt; the chain prompt then started at review.
- **A mod can list every slash command the person can run** with `$.command.list()`: name, description, `source` (`builtin`, `plugin`, `user`, `mcp`) and the plugin that added it. It can run one as if typed with `$.command.run({ command, args })`. So a mod finds sets by name in that list, not by reading folders.

## The sets

| Set | Where it lives | Commands in the chain | Chains itself? | Typed (from history) |
| --- | --- | --- | --- | --- |
| `core_piv_loop:` + `validation:` + bare `/commit` | each repo's `.claude/commands/` (Max, GitGraph, memory-system, second-brain; `validation/` also in Archon) | `core_piv_loop:execute`, `validation:code-review`, `validation:code-review-fix`, `validation:execution-report`, `validation:system-review`, `/commit` | no | execute 28, code-review 28, system-review 7, execution-report 5, `/commit` 8; 2026-04-24 to 06-05 |
| `lril:` | the global `lril` skill's `commands/` (`~/.claude/skills/lril/commands/`) | `lril:execute`, `lril:code-review`, `lril:code-review-fix`, `lril:execution-report`, `lril:system-review`, `lril:commit` | no | execute 3, code-review 1, commit 1 as slash commands; most chains name them in prose ("the lril execute skill"); 07 to 08 |
| `ship:` | the `ship` plugin (`ship@claude-ship`) | `ship:post-execute`, which calls `ship:commit`, `ship:code-review`, `ship:code-review-fix`, `ship:execution-report`, `ship:prp-review` | yes, commit through merge | `post-execute` 5; 2026-07-31 to 08-06 |
| `prp-core:` | the `prp-core` plugin | `prp-implement`, `prp-commit`, `prp-pr`, `prp-review`, `prp-review-agents` | no | `prp-review-agents` 2, `prp-review` 2 (PR-review loop only, then fixes typed in prose); 06 to 08 |
| `piv-*` | aegis and ECP's `.claude/commands/` | `piv-plan-implementation`, `piv-implement`, `piv-commit` | no | a handful; 07 to 08 |

`gsd:` / `gsd-*` (including `gsd-ship`) and `lril-superpowers:` were typed often, but never chained with ship steps. GSD executes by phase number, not plan path. They're not ship chains.
The file contents differ between the three ages (`core_piv_loop/execute.md` and `lril/commands/execute.md` differ by about 230 lines), so the sets are the same steps, not the same text.
420AI also has a project-local `.claude/commands/lril/post-execute.md`, the precursor of `ship:post-execute`, never typed.

## The chains the person typed

| Chain | Steps | Count, where, when |
| --- | --- | --- |
| Full to merge | execute plan (a slice), code-review, execution report, fix all, commit, push, PR, wait for CI green, merge, delete branch | 6, all in 420AI, 2026-07-07 to 07-08; 3 include execute, 3 are the tail after a separate execute prompt |
| To a draft PR, with system review | execute, code-review, fix all, execution report, system review and apply it, commit, push, **draft** PR | 3, Workflow Studio Archon, 07-03 to 07-09 |
| Commit tail | commit, push, (draft) PR, sometimes into `dev` or an upstream fork | about 6, Archon, GitGraph, claude-mods, 05 to 10 |
| Commit and push | commit, push, sometimes "merge it to main" | about 10, five projects, 03 to 09 |
| PR-review loop | `prp-review(-agents) <PR> all`, then "fix the issues", "respond to the PR", "commit and push" as separate prompts | 3, Workflow Studio Archon, 06 to 08 |
| `/ship:post-execute [arg]` | the skill's own chain | 5, 3d-skills and Workflow Studio Archon, 07-31 to 08-06 |
| "Finish:" block | commit as a named message, push, PR, confirm checks, sometimes `gh pr merge --squash`, comment on or close the issue | October, fpv and claude-mods, after `/implement` or `/wayfinder` |

**The dimensions the chains vary on:** whether execute is included; whether the execution report and the system review run; draft or ready PR, and its base (`main`, `dev`, a fork); where it stops (PR opened, or CI green, merge and delete branch); an extra PR-review pass; a closing comment on the issue; worktree and branch cleanup (a later prompt, and post-merge-cleanup's job on this map).

## Plans the execute step takes

- `.agents/plans/<name>.md` is by far the commonest (GitGraph, Archon, Archon Marketplace, memory-system, 3d-skills, 420AI, Workflow Studio Archon); `plan-feature` in both `core_piv_loop` and `lril` writes there.
- Others seen: `.agent/plans/` (second-brain), `.claude/archon/plans/` (Workflow Studio Archon), `.claude/plans/` (aegis, with `piv-implement`), `docs/superpowers/plans/` (RepoVault).
- `post-execute`'s profile names `paths.plans` and auto-detects `.agents/plans`, `docs/plans` or `plans`.
- The argument is a path, often followed by a qualifier ("implement slice 13.7", "Phase B"). Paths came typed as absolute `d:\…`, PowerShell `& '…'`, quoted, `@`-mentioned and `file:///`.

## How a mod finds them

- **`$.command.list()`** returns every slash command the person can run now, built-in, plugin and MCP alike: `{ name, description, source, plugin? }`. A project's `.claude/commands/` are in it when the session is in that project, so the set offered follows the folder.
- A mod spots a set by its names: `ship:post-execute` present means the `ship` set; `lril:execute` with `lril:code-review` means `lril`; `core_piv_loop:execute` with `validation:code-review` means the project's own set.
- **`$.command.run({ command, args })`** runs a slash command as if the person typed it: queued, run once the session is idle, with the plugin as its origin, rejected for an unknown name. It's one way to start a chain step; the send-or-fill choice belongs to [Does ship-pipeline send or fill each next prompt, and what stops the chain?](https://github.com/seanrobertwright/claude-mods/issues/139).
- `command.describe` lets a mod see (and reword) how each command shows in the typeahead, with its `provider`.
- **Check at build:** which `source` the `lril` skill's commands report (`user` is likely, since it's a skill folder, not a plugin), and whether a skill with no `commands/` folder (like `gsd-ship`) is listed as a command.
