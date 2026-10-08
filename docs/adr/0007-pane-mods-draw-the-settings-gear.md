# Each pane mod draws the settings gear, and mod-settings takes its press

The settings dialog belongs to its own mod, mod-settings, because it serves every mod and so cannot live in any one of them. Its gear sits at the top right of each mod's pane, and Claude Code gives mods no way to draw in a pane's frame: no render component reaches the title bar, the tab row or the close mark, and a pane's body leaves out the close mark's row (checked on Claude Code 2.1.293).
So whats-next, github-panel, outputs and sources each draw a `⚙` Button keyed `mod-settings` at the right end of their own top row, and only while the session's command list has `/mod-settings`. Without mod-settings, their panes look as they did.
The label is U+2699 followed by U+FE0F, the emoji presentation form: the layout measures that as the two cells the terminal draws, whereas the bare glyph measured one cell and its second column was clipped under the frame.
mod-settings hooks `ui.press` for the element `mod-settings`, opens the dialog and takes the press, so the dialog opens as the person's own act: placed at any width, in front, with the keyboard. The gear's own `onPress` runs `/mod-settings`, and runs only when nothing took the press.

The key `mod-settings` is a convention the five mods keep at run time, not an import, so each mod stays self-contained under ADR-0001.

## Considered Options

- Each pane mod draws the gear in its own top row, gated on `/mod-settings`, and mod-settings takes its press (chosen).
- The gear in the pane's title bar, beside the close mark: not possible, since mods cannot draw there.
- mod-settings wraps every pane's drawing to add the gear, leaving the pane mods unchanged: rejected. The pane mods draw without calling `next(e)` and plugins nest in install order, so a mod-settings installed after them would never reach their panes.
- The gear's `onPress` running `/mod-settings` as the only path: rejected. A command a plugin runs waits for the turn to end, writes to the transcript and opens the pane as the plugin's act, which a narrow terminal may leave unplaced. It stays as the fallback.
- The gear always drawn, with a toast to install mod-settings when it is missing: rejected, because it changes the panes for people who never install the dialog.
- Gating on mod-settings' state: rejected, because reading another mod's state needs a `dependencies` entry, and every pane mod would then require mod-settings to install.
