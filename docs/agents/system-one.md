# System One verdicts

Every new mod, and every new judgment added to an existing mod, gets a System One verdict before it is built.
The verdict goes in the mod's issue, or in its PR description when the work has no issue.
A judgment is a place where a mod decides something from text, such as how an answer ends or whether a step is finished.
A bold word inside a sentence is defined in `CONTEXT.md`; a bold word that starts a list item is that item's label.

## The verdict

Give each judgment one of three verdicts:

- **No candidate.** Its answer is typed or measured (an error code, a number, a path, a setting the person chose), so code decides it.
  A mod with no judgment at all says so in one line, with why.
- **Not now.** It suits a **System One model**, but not yet. Say why.
- **Integrate.** Name each of these:
  - the judgment and its primitive: Choice, Noul or Score;
  - its **Fallback**: the mod's own code, a model call it already makes, asking the person, or nothing, and never a new model call;
  - that its confidence thresholds are set per model;
  - what it sends to the **Hosted model** and how often, in words its **Model choice** description can repeat, and that it sends no contents of a file the mod read itself;
  - what it keeps when the **Local model**'s window is too small for its text;
  - why it is worth having at local only: with the local model alone, or with neither model;
  - its timeout, at most 10 s;
  - its settings and the wording of its model choice description;
  - where the mod names an absent, malformed or rejected key.

The verdicts on the existing mods are the worked example: [Which existing mods get System One, and in what order?](https://github.com/seanrobertwright/claude-mods/issues/91).

## A mod that integrates

It uses the same pieces as every other mod that does, and restates none of them:

- **Settings:** the sensitive `jevApiKey`, the pick-one `modelChoice` (local only by default) and `layaPort` (8000 by default), under those names, as decided in [Where does the Jev key live?](https://github.com/seanrobertwright/claude-mods/issues/85) and [What counts as "Laya is installed", and who starts the server?](https://github.com/seanrobertwright/claude-mods/issues/86).
  whats-next's `.claude-plugin/plugin.json` holds the copy of the three fields a later mod takes: copy them from there and change only the `modelChoice` description, to say what that mod sends.
  `npm run check` fails when the mods carrying the client declare them apart in anything but their descriptions.
- **Local-only folder:** it honours the `.claude/system-one-local-only` mark, as the first decision says.
- **Client:** it copies `shared/system-one.ts` into its own `hooks/system-one.ts` and never writes a client of its own ([ADR-0004](../adr/0004-system-one-client-is-one-shared-file.md)).
- **Laya:** it never starts, stops or installs Laya, and never sends it a key.
- **What may leave the machine:** [ADR-0003](../adr/0003-hosted-model-by-choice-local-model-first.md).
- **Its README entry** lists the three settings and what the mod sends, as it lists any other setting.
