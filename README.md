# claude-mods

claude-mods is one developer's personal toolbox of Claude Code mods, shared as a plugin marketplace so anyone can install them. A mod is a plugin of function hooks: TypeScript that runs inside Claude Code and changes what it shows (a pane in the side panel, a band of buttons above the prompt, the status line) or what it does between turns. The mod's own code decides when to act, even when what it does is send the model a prompt. That is what sets a mod apart from a skill, which is instructions the model reads, and from a plain plugin of commands, agents or shell hooks.

## Mods

Each mod is a Claude Code plugin of function hooks under `mods/`.

- **whats-next**: a pane in the side panel listing the next steps of your workflow, filled by the `/ask-sean` skill. Click a step to see its prompt, then paste or copy it. Once you submit a step's prompt, the step shows a glowing "working on it" line. After each answered turn, Haiku is asked whether the step is finished, and a finished step leaves the list. Press `d` to drop it yourself.
- **quick-reply**: one-click replies above the prompt, including the options Claude just offered.
- **auto-resume**: after a rate limit or an overloaded API, counts down to the reset and sends "continue".
- **github-panel**: a GitHub pane beside What's Next listing the repo's open pull requests and issues. Click one to open it in the browser. An issue blocked by an open issue has a red line under it; hover it to see what blocks it.
- **shelf**: a band of named folders and files above the prompt. Click one to drop its path at the cursor; nothing is sent. `/shelf add <name> [path]` puts a path on the shelf (the project folder when no path is given), `/shelf remove <name>` takes one off and `/shelf` lists them. The shelf is the same in every project folder.
- **turn-chime**: plays a short sound and shows a toast when a turn that ran three minutes or more ends, when Claude finishes three minutes or more after your last prompt (work it left running in the background reports in a short turn of its own), and once when Claude stops to ask you something that far in. The length is the mod's one option. A turn you stopped yourself stays silent. The sound plays on macOS and Windows; a Linux terminal has no player, so only the toast shows there.

The side panel's tabs come from Claude Code itself: when more than one mod has a pane open, it shows them as tabs.

## Using them

This repo is a plugin marketplace (`.claude-plugin/marketplace.json`). Add it once, then install the mods you want:

```sh
claude plugin marketplace add <path to this repo>
claude plugin install whats-next@claude-mods
```

In the terminal, Claude Code reads an installed mod from this folder, so an edit takes effect at the next session start or after `/reload-plugins`. Claude Desktop runs a copy kept in Claude Code's plugin cache instead: `claude plugin update` leaves that copy alone while the mod's version is unchanged, so only a reinstall or a version bump brings an edit there. To try a mod for one session only, run `claude --plugin-dir mods/<name>`.

## Checks

`npm run check` checks every directory under `mods/`, one mod at a time, in this order:

1. `tsc --noEmit --strict` against the mod's `tsconfig.json`
2. ESLint with `eslint.config.mjs`, where unused imports, unused variables and unreachable code are errors and any warning also fails
3. `claude plugin validate`
4. `claude plugin test`

It stops at the first failure and names the mod and the step.

A mod's `tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which Claude Code writes when it loads the mod and which git ignores. When that file is missing, as on a fresh clone, the script loads the mod once with a headless `claude -p` run of a local command, which makes no model call. The script needs the `claude` CLI on the PATH.

`npm install` wires the pre-commit hook. On each commit it runs:

- the personal-data check over tracked files (`npm run check:secrets` runs it by hand)
- markdownlint on staged Markdown (`npm run lint:md` lints every Markdown file)
- the same four mod checks, only for the mods with staged changes (`node scripts/check-mods.mjs --staged`). They read the files on disk, so unstaged edits in a staged mod are checked too.

`npm run test:scripts` runs the tests for the check script itself.
