# claude-mods

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (the `origin` remote), managed with the gh CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles use their default names: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root, created when first needed. See `docs/agents/domain.md`.

## New mods

Every new mod, and every new judgment added to an existing mod, gets a System One verdict before it is built: in its issue, or in its PR description when the work has no issue. See `docs/agents/system-one.md`.
