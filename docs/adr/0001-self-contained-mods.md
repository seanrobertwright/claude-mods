# Mods are self-contained; shared code is duplicated

Each mod is its own marketplace entry, installed and type-checked as its own folder, so a mod imports only from that folder and from `claude-code`.
Importing from a shared folder works while the marketplace is added from a local path, but a mod installed on its own would lose that folder, so we accept a few dozen duplicated lines (the toast `report`, `lastLine`, `ago`, the guarded load state, and, once it is written, the headless-session check every mod needs) instead.
If the shared code grows enough to drift in ways that cause bugs, the next step is a shared folder copied into each mod with a pre-commit check that the copies match, never a cross-mod import.

## Considered Options

- Self-contained mods with duplication (chosen).
- A shared folder synced into each mod by a script, with a drift check: deferred until the duplication is large enough to pay for a build step.
- Direct imports from a shared folder: rejected, because it breaks any install that copies a single mod's folder.
