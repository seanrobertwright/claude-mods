# claude-mods

claude-mods is a collection of Claude Code mods. The description is still to be written.

## Mods

Each mod is a Claude Code plugin of function hooks under `mods/`.

- **whats-next**: a sidebar listing the next steps of your workflow, filled by the `/ask-sean` skill. Click a step to see its prompt, then paste or copy it.
- **quick-reply**: one-click replies above the prompt, including the options Claude just offered.
- **auto-resume**: after a rate limit or an overloaded API, counts down to the reset and sends "continue".
- **github-panel**: a GitHub tab beside What's Next listing the repo's open pull requests and issues. Click one to open it in the browser.

The side panel's tabs come from Claude Code itself: when more than one mod has a pane open, it shows them as tabs.

## Using them

This repo is a plugin marketplace (`.claude-plugin/marketplace.json`). Add it once, then install the mods you want:

```sh
claude plugin marketplace add <path to this repo>
claude plugin install whats-next@claude-mods
```

Claude Code reads an installed mod from this folder, so after an edit `/reload-plugins` picks it up. To try a mod for one session only, run `claude --plugin-dir mods/<name>`.

## Checks

- `claude plugin validate mods/<name>` and `claude plugin test mods/<name>` check a mod.
- `npm install` wires the pre-commit hook, which runs markdownlint and a check for personal data in tracked files.
