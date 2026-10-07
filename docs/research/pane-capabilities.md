# What a mod's pane can draw, and what a mod can hold open

Research for issue #110, a ticket of the archon-panel v2 map (#107).
It covers what a pane can draw, whether one mod can show several panes as tabs, how a mod keeps live data coming in, what reaches the person outside the pane, and how a mod runs Archon's CLI and opens a file or URL.
Answered from primary sources, as of Claude Code 2.1.293, and checked with throwaway probes on this machine (Windows 11) where the sources were silent.

How sources are cited:

- **[types]** is the engine types (`claude-code` module) that Claude Code 2.1.293 writes into the `plugin-authoring` skill and beside each loaded mod, cited by symbol.
- **[skill]** is the `plugin-authoring` skill bundled with Claude Code 2.1.293, its `reference.md`.
- **[probe: name]** is a throwaway experiment run for this ticket (see "How the probes ran" at the end).
- **[reach]** is `docs/research/hook-reach-to-system-one.md`, which already covers `$.http.fetch`'s limits.
- **[archon-api]** is `docs/research/archon-api.md`, for what Archon serves.
- **[code]** is this repository, cited by file and symbol.

## Short answer

- **Drawing.** A pane's tree uses `Box`, `Text`, `Button`, `Input`, `Select`, `Link`, `Code` and `Markdown` on every surface that draws them.
  The terminal adds `Raster`, `Image` and `Client`, and the desktop app adds `Svg` and `Client`; the terminal has no `Svg` [types: `Elements`].
  Colours are theme keys (`success`, `error`, `warning`, …), named colours or hex, and box-drawing and status glyphs are plain text: every one validated on all four surfaces [probe: render].
- **Width.** Size the tree to `e.props.bodyColumns`, not to the viewport [skill] [types: `Pane`].
  On the terminal a pane docks beside a fullscreen transcript from 110 columns and otherwise sits inline above the prompt.
  An unasked pane is seated only from 144 columns, or 110 for an id the person once opened [types: `$.ui.open`, `PaneOpenArgs`].
- **Scrolling.** The engine owns a scroll window over the pane's tree, moved by the person's wheel and keys while the pane has focus.
  `$.ui.scroll({ in, to: 'end' })` follows a growing tree [types: `SiteScroll`, `$.ui.scroll`, `UiScrollTarget`].
  A tree draws at most its first 100,000 characters of text, so a long run log should draw only the part in view [skill].
- **Keys and a selected row.** While the pane has focus, Tab walks its elements, a Button's `hotkey` (one digit or one lowercase letter) presses it, and the arrows scroll [types: `Pane.isFocused`, `ButtonProps.hotkey`] [probe: render].
  There is no list or row-selection element.
  A selected row is the mod's own `$.state`, drawn with `inverse`, a background or a marker.
  The focus ring inverts the focused Button by itself, and `$.ui.focus` moves it [types: `$.ui.focus`, `TextProps`].
- **Sub-tabs.** One mod can open several panes, one per id, and Claude Code shows them as tabs in a single tab row shared with every other mod's panes [types: `Pane`, `UiPane`] [probe: panes].
  A tab row drawn inside one pane keeps Archon's views together and in the mod's order, but they all share one scroll window.
  Section 2 weighs the two.
- **Live data.** `$.http.fetch` cannot read a stream.
  It resolves once the whole body is read, so an SSE request stays pending until the server ends the stream [types: `$.http.fetch`] [probe: stream].
  A hooks module has no `fetch`, `WebSocket` or `EventSource` of its own [probe: globals].
  What does stream is `$.process.spawn` of a client such as `curl -sN`: each SSE event arrived about as the server sent it, Archon's `__dashboard__` heartbeat included [probe: stream].
  The child lives until the mod ends the loop, the module reloads or the session ends, and a reload starts it again from `session.start` [types: `$.process.spawn`] [probe: reload].
  Attaching and detaching a surface does not unload the module, so the stream outlives them unless the mod stops it [types: `session.attach`, `session.detach`].
- **Tailing a file.** `$.fs.read` reads a whole file (4 MiB at most) and takes no offset [types: `$.fs.read`].
  A follower started with `$.process.spawn` streams a growing file line by line.
  The probe tried PowerShell's `Get-Content -Wait` and GNU `tail -F`; Archon's own `archon workflow logs <id> --follow` was not tried, because no run was live [probe: tail].
- **Outside the pane.** `$.ui.status(text)` pins one line per mod under the prompt, and `$.ui.toast(text)` shows a box for 4 s by default [types: `$.ui.status`, `$.ui.toast`].
  Both belong to the session that raised them.
  With several sessions open, each loads its own copy of the mod, so each polls, keeps its own status line and raises its own toast for the same run event.
  `$.store` is shared live between the sessions on a machine and is the place to keep one session from repeating another's toast [probe: store].
- **Requirements.** `$.process.run` finds a bare command only on the PATH of the Claude Code process: `archon` was not found, even with a `PATH` passed in `init.env` [probe: archon].
  An absolute path built from `$.env.get('USERPROFILE')` (or `HOME`) runs `~/.archon/bin/archon.exe`, with or without `.exe` and with either slash; a literal `~` is not expanded [probe: archon].
- **Opening a file or URL.** No engine call opens one on the host [types].
  A `Link` or a `Markdown` link opens when clicked.
  The terminal opens any scheme, but the desktop app, VS Code and the phone make a link only of `https:` and `http://localhost`, and draw a `file:` link as plain text [types: `LinkProps`] [probe: render].
  Anything else is the platform's opener run through `$.process.run` (`explorer.exe`, `open`, `xdg-open`), which was not probed.

## 1. What a pane draws

### Elements

`$.ui.resolve(e)` returns the element table of the surface the render is for [types: `$.ui.resolve`, `Elements`]:

| Element | terminal | desktop | vscode | mobile |
| --- | --- | --- | --- | --- |
| `Box`, `Text`, `Button`, `Link`, `Code`, `Markdown` | yes | yes | yes | yes |
| `Input`, `Select` | yes | yes | yes | no |
| `Svg` | no | yes | yes | yes |
| `Client` (a module of the mod's own drawing a region) | yes | yes | no | no |
| `Raster` (a grid of coloured cells), `Image` (kitty graphics, else its `alt`) | yes | no | no | no |

- A tree that names an element the surface lacks, or a prop an element does not take, is not drawn.
  The engine draws its own instead and logs why; a pane whose drawing fails is closed [skill].
  So a mod draws `Svg` only after narrowing `e.surface`.
- `Box` takes Ink's flex layout, margin, padding, `width`/`height`, `overflow: hidden`, `display: none`, `position: absolute` with cell offsets, a border and a background [types: `BoxProps`].
  The border styles are `single`, `double`, `round`, `bold`, `singleDouble`, `doubleSingle`, `classic`, `arrow`, `dashed` and `quote`.
  Any other style is drawn with no border and a log line, and the tree still draws [skill] [probe: render].
- `Text` takes `color`, `backgroundColor`, `dimColor`, `bold`, `italic`, `underline`, `strikethrough`, `inverse` and `wrap` (`wrap`, `truncate-end`, `truncate-middle`, …) [types: `TextProps`].
- `Button` draws `[ label ]`, or `1: label` with `plain` and a `hotkey`.
  `variant: 'primary'` draws it in the accent colour, and `autoFocus` puts the focus ring on it when the pane takes the keys [types: `ButtonProps`].
- `Select` is a picker: a label and the current value, with the arrows moving through its options while it has focus [types: `SelectProps`].
  It is not a list of rows.
- `Markdown` draws model-style text: headings, lists, tables, code and links [skill].
- A `Box` with a `key` scopes `hover` styles, and a `display: 'none'` Box with `hover: { display: 'flex' }` is a card that appears over the rows when the pointer is on its parent [skill] [types: `BoxHoverProps`].

### Colours and glyphs

- `Color` is a theme key or any string [types: `Color`, `ThemeKey`].
  The theme keys are `text`, `inverseText`, `inactive`, `subtle`, `suggestion`, `remember`, `success`, `error`, `warning`, `merged`, `claude`, `permission`, `planMode`, `autoAccept`, `promptBorder`, `bashBorder`, `ide` and the diff colours, and a tree that uses them follows the person's theme.
- `red`, `#ff8800`, `success` and a `blue` background each validated on all four surfaces [probe: render].
  The test kit checks the tree, not the paint [types: `MountedMembers`], so how a hex colour looks on a 16-colour terminal was not seen.
  Theme keys are the safe choice for run states: `success`, `error`, `warning`, `inactive`.
- Box-drawing characters (`┌─┐│├┤└┘`) and status glyphs (`● ◐ ○ ✓ ✗ ⏸ ▸ ⋯`) are plain `Text` and validated everywhere [probe: render].
  A node graph can be drawn from them, one `Text` per row.

### Width

- `e.props.bodyColumns` is the room the tree draws into: cells across the body, none of them under an engine mark [types: `Pane.bodyColumns`] [skill].
  A change of width re-runs the render; a change of height alone does not [skill].
- `e.props.placement` says where the pane sits [types: `Pane.placement`, `RenderViewport.isFullscreen`]:
  - `dock` is beside the transcript, in the terminal's fullscreen layout from 110 columns;
  - `inline` is above the prompt, on the terminal's main screen or a narrower one.
- An inline pane opens a third of the screen tall unless `rows` asks for another height, and a docked pane opens at its share of the width unless `columns` asks for another.
  A size the person dragged wins either way [types: `PaneOpenArgs.rows`, `PaneOpenArgs.columns`].
- An open the person asked for (a command, a prompt, a press) is placed at any width.
  An unasked one waits undrawn below 144 terminal columns, or below 110 for an id the person has opened before.
  It resolves `{ isPlaced: false, reason }` and is seated when the terminal widens or the person opens it [types: `$.ui.open`, `UiOpenResult`].
- On the desktop app and VS Code, `columns` and `rows` count cells of the surface's code font.
  The client reports `isFullscreen` when it attaches, and an older desktop app places no panes at all [types: `RenderViewport`, `UiOpenResult`].
  No desktop width was measured for this ticket.

### Scrolling a long body

- The engine owns a window over the pane's tree.
  `e.props.scroll.offset` is its first row and `bodyRows` the rows it shows.
  The person moves it with the wheel, or with the arrows and page keys while the pane has focus [types: `Pane.scroll`, `SiteScroll`, `UiScrollInput`].
- `$.ui.scroll({ in: id, to: 'end' })` keeps up with a tree that grows "until anything next moves it", which is the follow-the-tail behaviour a run log wants.
  `to: { key }` brings one keyed element into view, and `block` says where it lands [types: `$.ui.scroll`, `UiScrollTarget`, `UiScrollBlock`].
- A `ui.scroll` hook may rewrite `offset`.
  A mod that pins a header (a tab row) and scrolls a list itself keeps the engine's window at 0 and moves its own index.
  `e.pointer.row` tells it which row the wheel was over [types: `UiScrollInput`, `UiScrollPointer`].
  This was not probed.
- **Size limits.** A tree draws the first 100,000 characters of its texts and then says how much was left out.
  A pane's run log should hold a window of lines in `$.state` and draw only those [skill] [probe: render, a 150,000-character `Text` cut to 100,000].
  `$.state` values are JSON, and the redraw rate is ten a second at most, thirty for the shown pane in the terminal [types: `$.ui.invalidate`, `$.state.set`].

### Keyboard focus and hotkeys

- A pane takes the keys when the person presses ctrl+x tab or clicks it, or when it was opened with `focus: true` over an empty prompt [skill] [types: `PaneOpenArgs.focus`].
  An unasked open never takes them (`CONTEXT.md` **Pane**).
  Esc hands the keys back, and `closeOnEscape` makes Esc close the pane too [types: `PaneOpenArgs.closeOnEscape`].
- While the pane has the keys, Tab walks its elements, a Button's `hotkey` presses it, and the arrows scroll [types: `Pane.isFocused`].
  A `hotkey` is one digit or one lowercase letter.
  `F1` failed the whole render hook ("hotkey must be one digit 0-9 or one lowercase letter a-z") [probe: render].
  Two Buttons with one hotkey clash, and the later one wins [types: `ButtonProps.hotkey`].
- A Button can also take an engine keybinding action, pressed by the person's chord from the prompt while the Button is mounted [types: `ButtonProps.action`].
- Each move of the focus ring raises `ui.focus`, which a hook may refuse, and `$.ui.focus({ requestId, key })` moves the ring to a keyed element while the pane has the keys [types: `$.ui.focus`, `UiFocusInput`].

### Showing a selected row

No element keeps a selection [types: `Elements`].
The pattern that fits:

- Keep the selected run id in `$.state`, which survives a reload and redraws its readers [types: `$.state`] [skill].
- Draw each row as a `plain` Button, as the first cut does, so a click or Enter selects it [code: `mods/archon-panel/hooks/register.tsx` on the `feat/archon-panel-first-cut` branch].
- Mark the selected row with `inverse`, a `backgroundColor` or a leading `▸`.
  The focus ring separately inverts whichever Button the keys are on [types: `TextProps`, `$.ui.focus`].
- After a change, `$.ui.focus` puts the ring on the selected row, and `$.ui.scroll({ to: { key } })` keeps it in view [types: `$.ui.focus`, `$.ui.scroll`].

## 2. Sub-tabs: several panes, or a tab row of the mod's own

### What the engine does with several panes

- `$.ui.open({ id, title })` opens one pane per id; opening an open id only retitles it [types: `$.ui.open`, `PaneOpenArgs.id`].
  An id is 1 to 64 letters, digits, `_` and `-`, so `runlog-<uuid>` fits.
- The open panes of every mod share one tab row.
  One pane is shown and the rest are tabs behind it, labelled by `title`; with a single pane open, no title is drawn at all [types: `Pane`, `PaneOpenArgs.title`].
  The person switches tabs by clicking or with Tab and Enter, and closes one with its mark or ctrl+x x [types: `Pane`].
- `$.ui.panes()` lists the mod's own open panes with `isShown`, `isFocused` and `isPlaced`, and still lists them after a reload [types: `$.ui.panes`, `UiPane`].
- In the probe, three opens (`runs`, `runlog`, `archonlog`) were all placed and the **last opened was the one shown**.
  Opening `runs` again retitled it but did **not** bring it to the front [probe: panes].
  The only documented way to raise a pane is `focus: true`, which works only while the prompt has the keys over an empty composer [types: `PaneOpenArgs.focus`].
- Each pane is its own render instance, with its own scroll window and its own focus [types: `Pane.scroll`, `Pane.isFocused`].

### Weighing the two

| | Several panes (Runs, Run log, Archon log) | One pane with its own tab row |
| --- | --- | --- |
| Tab row | The engine's, shared with other mods' panes, in open order | The mod's: its order, labels, counts ("Runs 2") |
| Switching | Click or Tab and Enter on the engine's tabs; the mod cannot bring a tab forward without `focus` | A Button per sub-tab, with hotkeys `1`–`3` while the pane has the keys; the shown tab in `$.state` |
| Scrolling | One window per pane: the run log can follow its tail while the run list stays put | One window for all: a switch keeps the old offset unless the mod scrolls to `start` or `end`, and the tab row scrolls away with the body unless the mod draws its own window (section 1) |
| Opening and closing | Each opened and closed on its own. The person can close the Archon log alone, and `/archon` must decide which to reopen. Three unasked opens crowd a terminal that also shows other mods' panes | One open, one close, one `/archon` |
| Unasked opens | Each pane is judged against the width floor | One pane, judged once |
| State | Per pane, plus the engine's record of which panes are open | One sub-tab value in `$.state` |
| Cost to build | Three render hooks (or one hook matched on several ids); the mod tracks which panes are up with `$.ui.panes()` | One render hook, a tab row of Buttons, and scroll handling on a switch |

A middle way also fits the engine: one pane for the runs list and graph, and a second pane opened only on request, such as a run log for one run under `runlog-<id>`.

## 3. Holding live data open

### `$.http.fetch` does not stream

- It "resolves `{ status, ok, headers, text }` once the body is read" [types: `$.http.fetch`, `HttpResponse`].
- Probe: a local SSE endpoint sent eight events, one each 0.5 s, then ended.
  The fetch was still pending at 1.5 s and resolved at 4.1 s with all eight events in one `text` [probe: stream].
- Archon's `GET /api/stream/__dashboard__` never ends on its own (a heartbeat every 30 s) [archon-api].
  A fetch of it would never resolve, and since `$.http.fetch` has no abort or timeout, the request would hold its socket until the session ended [reach].
- The module has no network API of its own: `fetch`, `WebSocket`, `EventSource`, `XMLHttpRequest` and `ReadableStream` were all `undefined` [probe: globals].
  So SSE and WebSocket are out of reach through the engine's own network calls.
- `$.http.fetch` stays the right call for Archon's REST routes: one request at a time, raced against a `$.clock.sleep` timer [reach].

### `$.process.spawn` of an SSE client does stream

- `$.process.spawn({ argv })` "streams what it writes, piece by piece" [types: `$.process.spawn`].
- Probe: `curl -sN http://127.0.0.1:<port>/sse` delivered each event as its own piece, the first at 0.64 s and then one every 0.5 s, as the server sent them [probe: stream].
- Against Archon's own `curl -sN http://localhost:3090/api/stream/__dashboard__`, the opening heartbeat arrived at 0.58 s.
  Leaving the loop after 3 s killed `curl`, and no `curl` process was left [probe: stream].
- `curl` was found by its bare name on this machine [probe: archon]; Windows has shipped `curl.exe` since Windows 10 version 1803.
  It is a **Requirement** of the mod in the `CONTEXT.md` sense.
- Every other mod sees the chunks: a `process.spawn` hook of another plugin reads, and may rewrite, each piece [types: `$.process.spawn` example].
  The organization's web-fetch policy does not cover a program a mod starts [reach].
- Pieces are text "as it came, not lines" [types: `$.process.spawn`].
  The mod buffers them and splits on the blank line that ends each SSE event.

### How a held stream lives

| Event | What happens to a `$.process.spawn` child | Source |
| --- | --- | --- |
| The hook that started it returns | Lives on; only ending the loop, `return()`, `next.signal` or an unload kills it | [types: `$.process.spawn`] |
| Started un-awaited after `next(e)` in `session.start` | Lived on for the whole session | [probe: reload] |
| The mod's module reloads (a save, a config change) | Killed ("curl stopped: the op was aborted"). `register` runs again and `session.start` fires for the reloaded module alone, which opened a new stream. The old socket closed about half a second after the new one opened | [probe: reload] [skill] |
| A surface attaches or detaches | Nothing happens to the child: the events only observe, and the module stays loaded | [types: `session.attach`, `session.detach`] |
| The session ends | Killed | [probe: reload] |

So:

- **A reload loses the stream and any events in flight.** Archon replays nothing on `__dashboard__`, so after every (re)connect the mod refetches the runs over REST and treats the stream only as "something changed" signals, as Archon's web UI does [archon-api].
- **Attach and detach are the mod's to handle.** `CONTEXT.md` **Headless session** says a mod polls nothing while no surface shows the session.
  So the last detach should end the loop, which kills `curl`, and the next attach should start it again, the same way the first cut stops and restarts its polling [code: `mods/archon-panel/hooks/register.tsx` `stopPolling`, `startPolling`].
- **Keep one stream per session.** A module-level variable holding the loop is lost on a reload, but so is the child, so a fresh `session.start` can always start one.
  A flag in `$.state` would outlive the child and lie.

### Tailing a growing file instead

A run's model text and tool calls are only in its JSONL transcript, `<output_root>/logs/<runId>.jsonl` [archon-api], so the run log needs a file follower whatever the lifecycle source is.

- **`$.fs.read`** reads the whole file as text, up to 4 MiB, with no offset or range [types: `$.fs.read`, `FsReadOptions`].
  Polling `$.fs.stat` for a new `size` or `mtimeMs` and then reading the file again works, but each read copies the whole transcript into the mod.
  A run past 4 MiB cannot be read this way at all.
- **`$.process.run`** is one shot: it reads the whole output and returns when the command exits [types: `$.process.run`].
  It cannot follow a file.
- **`$.process.spawn` of a follower** streams new lines as they are written [probe: tail]:
  - PowerShell `Get-Content -LiteralPath <file> -Wait -Tail 0` delivered each line about as it was written, after about 1 s of start-up.
  - GNU `tail -n 0 -F <file>` delivered lines in pairs, about once a second.
    It ran here only because Git for Windows' tools are on this PATH, which a mod cannot count on.
  - `archon workflow logs <id> --follow`, Archon's own follower, "tails until the run ends" [archon-api].
    It needs no second tool and works the same on every platform, but it was not probed, because no run was live.
- A follower lives and dies as the SSE child does (the table above).
  After a reload it starts again from the end of the file, so the mod reads what it missed once with `archon workflow logs <id>` or `$.fs.read`, or starts the follower from the top.

## 4. Outside the pane: status line and toasts

### Status line

- `$.ui.status(text)` pins `text` as the mod's own status line, under the prompt beside the engine's pinned notices, until the next call replaces it.
  There is one line per mod, `undefined` clears it, and the first 2,000 characters draw on the terminal (10,000 on a remote surface) [types: `$.ui.status`] [skill].
- It is not the settings `statusLine` command the person may have configured; it is a separate line the mod owns.

### Toasts

- `$.ui.toast(text, { timeoutMs })` shows a small box under the mod's name, on the stack of mod toasts over the transcript's top right corner.
  It stays 4 s by default; a click removes it and the pointer holds it.
  Where the transcript prints into scrollback it is one line on the notification bar instead [types: `$.ui.toast`, `ToastOptions`].
- A mod's newer toast takes its own older one's place, never another mod's.
  The stack draws each mod's newest toast first and holds 50 in all [skill].
- While any pane opened with `holdToasts` is shown, every toast waits undrawn with its timer stopped.
  `holdToasts` is for a dialog the person answers and leaves, not for a pane that stays open [types: `PaneOpenArgs.holdToasts`].
- A toast does not reach the model or the transcript [types: `$.ui.toast`].

### With several sessions open

- Each session is its own Claude Code process, with its own copy of every mod.
  `$.state` is "the session's", and timers, spawned children and the status line belong to the session that made them [types: `$.state`, `$.ui.status`, `$.process.spawn`].
  A toast or status line reaches the surfaces of the session that raised it, and no other.
- So with three sessions open in one project, archon-panel would hold three streams or three polls against Archon.
  It would show the same count in three status lines and raise three toasts for one run finishing, one in each window.
  No engine call lists or messages the other sessions' mods [types].
- `$.store` is shared live: one file per mod for the whole machine [types: `$.store`].
  In the probe, two concurrent sessions each saw the other's key as soon as it was written.
  A key written later by one session did not erase the other's key [probe: store].
  So one session can record "toasted run X finished" and the others can skip it.
- `$.store.set` has no `ifVersion` [types: `$.store`].
  Two sessions that read and write the same key within the same moment can both decide to toast, so de-duplication through `$.store` is best effort.
- A headless session draws nothing and raises no toast (`CONTEXT.md` **Headless session**).
  The first cut already checks `$.session.surfaces()` before acting [code: `isShown`].

## 5. Requirements: running Archon, and opening a file or URL

### `archon.exe` off the PATH

| `argv[0]` passed to `$.process.run` | Result |
| --- | --- |
| `archon` | Rejected: `ENOENT: Command 'archon' not found or is in an unsafe location (current directory)` |
| `archon`, with `env: { PATH: '<home>\.archon\bin;' + PATH }` | Rejected the same way: the lookup uses the Claude Code process's own PATH, not `init.env` |
| `<home>\.archon\bin\archon.exe` | Ran (`Archon CLI v0.11.1`) |
| `<home>/.archon/bin/archon.exe` | Ran |
| `<home>\.archon\bin\archon` (no `.exe`) | Ran |
| `~/.archon/bin/archon.exe` | Did not run (exit 1, "The system cannot find the path specified") |

All from [probe: archon].

- The home folder comes from `$.env.get('USERPROFILE')` on Windows or `$.env.get('HOME')` elsewhere; `$.env.get` takes the name as a string literal [types: `$.env`] [reach].
- A sound order: a configured path first, then `archon` on the PATH, then `<home>/.archon/bin/archon(.exe)`.
  The first cut takes the path from its `archonPath` option and falls back to plain `archon`, which this probe shows is not found here [code: `mods/archon-panel/hooks/parse.ts` `parseConfig`].
- `$.process.run` waits 30 s by default and ten minutes at most, and keeps the first 4 MiB of each stream [types: `ProcessRunInit`, `ProcessRunResult`].
  `archon workflow approve` without `--detach` blocks for the rest of the run, so the mod always passes `--detach` [archon-api].
- `$.process` is documented as "CLI only" [types: `$.process`].
  Whether it runs in a session the desktop app hosts was not tested.

### Opening a file or URL from a pane

- **No engine call opens a file or a URL on the host.**
  The `ui`, `session` and `fs` nouns have none [types].
- **`Link`** draws a link that opens when clicked; it "opens what the terminal, or the surface, opens" [types: `LinkProps`].
  On the terminal any scheme is kept, `file:` included.
  The desktop app, VS Code and the phone make a link only of an `https:` URL or `http://localhost`, and draw any other as plain text with a log line [probe: render].
  Archon's web UI at `http://localhost:3090` is therefore linkable on every surface; a run's files as `file:` links work only on the terminal.
- **`Markdown`** links behave the same.
  With `key` and `onLinkPress`, a plain click on a link in the fullscreen terminal raises `ui.press` with the `href` instead of opening it, so the mod can decide what to do [skill] [types: `MarkdownProps`].
- **`$.process.run` of the platform's opener** (`explorer.exe <url or path>` on Windows, `open` on macOS, `xdg-open` on Linux) opens anything the person could open.
  It was not probed, because it opens windows on the person's desktop.
  It runs on the session's host, not on a phone or a remote desktop.
- **`$.ui.copy({ text, surface })`** puts a path or URL on the clipboard of the surface the press came from, which is the fallback where nothing can open it [types: `$.ui.copy`].

## 6. What this changes for the open tickets

These are consequences for the map, not decisions.

- **#111, where archon-panel gets its data and how it stays fresh.**
  An SSE stream is held through `$.process.spawn` of `curl -sN`, not through `$.http.fetch`.
  It is lost on every reload and has no replay, so it can only trigger REST refetches; REST over `$.http.fetch` stays the source of truth.
  The run log needs a follower process whatever the lifecycle source is (`archon workflow logs <id> --follow`, to be probed on a live run), because `$.fs.read` has no offset and stops at 4 MiB.
  The last detach must end both children, and attach and `session.start` must start them again.
  `curl` becomes a Requirement.
- **#112, the layout.**
  Several panes give the run log its own scroll window and follow-the-tail, but they share the engine's tab row with every other mod, and the mod cannot bring a tab to the front by itself.
  A tab row of the mod's own keeps the views together and in order, but the tabs share one scroll window, which the mod must reset on a switch.
  Section 2 has the table.
  A graph is drawn from box-drawing `Text`, which works on every surface; an `Svg` graph is the desktop app's, VS Code's and the phone's only.
  A run log holds a window of lines in `$.state`, since a tree draws 100,000 characters at most.
- **#113, approvals.**
  Hotkeys are one digit or one lowercase letter and work only while the pane has the keys.
  `variant: 'primary'` marks approve, and `autoFocus` can start the ring on it.
  A comment box is an `Input`, which the phone does not draw.
  A pane opened with `focus`, `closeOnEscape` and `holdToasts` behaves as a dialog, if answering an approval becomes one.
  Approving a CLI-started run goes through `archon workflow approve <id> --detach` run by absolute path.
- **#114, toasts and the status line.**
  Each open session raises its own toast and keeps its own status line.
  Without a guard, one run finishing toasts once per open session.
  `$.store` is shared live across sessions and can record which run events were already toasted, but it has no compare-and-set.
  Toasts wait behind any `holdToasts` pane.
- **The first cut.** Its comment "Dies with the module on a reload" over its timer matches the engine.
  A spawned stream would need the same restart in `session.start` and `session.attach` [code: `mods/archon-panel/hooks/register.tsx`].

## 7. Open questions

1. How `archon workflow logs <id> --follow` streams through `$.process.spawn` on a live run, and whether it ends when the run ends.
2. How a hex colour is painted on a terminal with 16 or 256 colours (the test kit validates trees, not paint).
3. Pane widths on the desktop app and in VS Code, and whether `$.process` runs in a session the desktop app hosts.
4. Whether a `ui.scroll` hook that keeps the engine's window at 0 makes a sticky tab row in practice.
5. Whether two sessions writing the same `$.store` key at the same moment can lose a write, as the missing `ifVersion` suggests.
6. Opening a URL or a file with `explorer.exe`, `open` or `xdg-open` through `$.process.run`.

## How the probes ran

Throwaway mods were loaded with `--plugin-dir` into `claude -p --setting-sources "" --no-session-persistence` on Windows 11 with Claude Code 2.1.293.
Each was driven by a slash command of its own, so no model turn ran.
Results came from files the mods wrote with `$.fs.write`, from the session's `--debug-file` log, and from a local Node HTTP server on `127.0.0.1`.
That server sent a finite SSE stream, held an endless one open, appended to a JSONL file every 0.5 s, and logged when each connection opened and closed.

- **stream:** `$.http.fetch` of the finite SSE endpoint raced against a 1.5 s timer; `$.process.spawn` of `curl -sN` on the same endpoint and, for 3 s, on Archon's `__dashboard__` stream (a read-only GET).
- **globals:** `typeof` of the network globals inside a hooks module.
- **tail:** `$.process.spawn` of PowerShell `Get-Content -Wait` and of GNU `tail -F` on the growing file.
- **archon:** `$.process.run` of `archon version` under each `argv[0]` in section 5, plus `curl --version` and `tail --version`.
- **panes:** three `$.ui.open` calls, a reopen with a new title, then `$.ui.panes()`.
- **store:** two concurrent sessions of one mod writing and reading `$.store` keys 5 s apart.
- **reload:** a long-lived headless session (`--input-format stream-json` with standard input held open, `CLAUDE_CODE_PLUGIN_DIR_WATCH=1`) whose `session.start` spawned `curl -sN` on the endless endpoint.
  The module file was then edited to make it reload.
- **render:** `claude plugin test` mounting a `Pane` on the terminal, desktop, vscode and mobile surfaces with each tree in section 1, reading back the validated tree and what the engine reported.

The probe code was not kept.
No Archon run was started, approved, rejected, cancelled or resumed.

## Sources

- Engine types (`claude-code` module), written by Claude Code 2.1.293.
  Symbols used: `Elements`, `$.ui.resolve`, `$.ui.open`, `$.ui.close`, `$.ui.panes`, `$.ui.scroll`, `$.ui.focus`, `$.ui.status`, `$.ui.toast`, `$.ui.invalidate`, `$.ui.copy`, `PaneOpenArgs`, `UiOpenResult`, `UiPane`, `Pane` (render props), `SiteScroll`, `UiScrollInput`, `UiScrollTarget`, `UiScrollBlock`, `UiScrollPointer`, `UiFocusInput`, `RenderViewport`, `BoxProps`, `BoxHoverProps`, `TextProps`, `ButtonProps`, `SelectProps`, `LinkProps`, `MarkdownProps`, `Color`, `ThemeKey`, `ToastOptions`, `MountedMembers`, `$.http.fetch`, `HttpInit`, `HttpResponse`, `$.process`, `$.process.run`, `$.process.spawn`, `ProcessRunInit`, `ProcessRunResult`, `$.fs.read`, `FsReadOptions`, `$.fs.stat`, `$.state`, `$.state.set`, `$.store`, `$.env`, `$.session.surfaces`, `session.attach`, `session.detach`.
- The `plugin-authoring` skill bundled with Claude Code 2.1.293, `reference.md` ("Drawing: ui.render", "Work that outlives a dispatch", "Developing one").
- [reach] `docs/research/hook-reach-to-system-one.md` (#82).
- [archon-api] `docs/research/archon-api.md` (#108).
- [code] This repository: `CONTEXT.md` (**Pane**, **Headless session**, **Run log**), and `mods/archon-panel/hooks/register.tsx` and `mods/archon-panel/hooks/parse.ts` on the `feat/archon-panel-first-cut` branch (draft PR #117).
