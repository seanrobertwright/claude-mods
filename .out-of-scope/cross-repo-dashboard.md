# Cross-repo dashboard

No mod here gathers work from several repositories into one view, such as a morning summary of yesterday's merges, today's open pull requests and the next steps across every project.

## Why this is out of scope

Every mod in this marketplace works on the session's own project folder.
github-panel lists that repository's open pull requests and issues, with each pull request's checks.
whats-next keeps the next-steps list for that project folder.
A dashboard across repositories would be the first mod to reach outside the folder it runs in: it would make `gh` calls for other repositories and read the next-steps lists that whats-next keeps, which would tie one mod to another's stored data against ADR-0001 (mods are self-contained).

It also has no good place to show.
A band is a single row of buttons, not a summary.
A pane may open unasked only where Claude Code can seat it without taking over (CONTEXT.md, **Pane**), so a once-a-day pane could not be counted on to appear.

The parts that matter inside one project are already there: github-panel for open pull requests and their checks, whats-next for what to do next.

## Prior requests

- #61: "new mod: morning-standup-band: yesterday's merges and today's open work at the first session"
