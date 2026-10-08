# PROTOTYPE: archon-panel Graph width (#165), throwaway

Answers "How does the Graph sub-tab cope with a pane narrower than the graph?" (#165). It is not a mod to install and never merges to `main`. The decision lives in the issue's resolution comment.

A pane drew Archon's bundled workflow shapes the way archon-panel's Graph sub-tab would, at the pane's real `bodyColumns`. One key each switched:

- `f`: the run (archon-review, archon-ship folded, a chain, archon-ship expanded to 61 nodes);
- `w`: a too-wide layer (whole graph becomes the list, or that layer stacked in one box);
- `s`: a layer-skipping edge (lane, note, none);
- `p`: the sub-tab row (scrolls, or pinned through a `ui.scroll` hook);
- `c`: the `columns` asked for on open.

Loaded as a hot-reloaded dev mod (`/archon-graph [columns]`) on Claude Code 2.1.293.
