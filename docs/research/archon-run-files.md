# How a person opens a run's files, and how a run links to Archon's web UI

Research for issue #166, a ticket of the archon-panel v2 map (#107): how Archon serves one file a run wrote, where a run's page is in Archon's web UI and what it shows, where the files sit on disk, and what a mod can do to open a file, a URL or the prompt box.
It builds on `docs/research/archon-api.md`, `archon-run-data.md`, `archon-run-actions.md` and `pane-capabilities.md` and does not repeat them.
Answered from Archon's source at tag `v0.11.1` (commit `aa09544`), from read-only probes on this machine, and from the engine types and `plugin-authoring` skill bundled with Claude Code 2.1.294.
This was read-only research: no run was started, approved, rejected, cancelled, abandoned or resumed, and no probe mod was written or run.

How sources are cited:

- **[src: path `fn`]** is Archon's source at `v0.11.1`, relative to `packages/`.
- **[probe]** is a read-only call made on this machine: `GET` requests to `archon serve` on `:3090` (v0.11.1, SQLite), `archon workflow get <id> --json`, and listings of `~/.archon`.
  The runs probed were two finished CLI runs in this repository, `archon-plan` `b992…` and `archon-deliver` `9e8f…`, and one web-started `archon-assist` run, `e6d2…`.
- **[types: symbol]** is the engine types (`claude-code` module) bundled with Claude Code 2.1.294, and **[skill]** is that version's `plugin-authoring` `reference.md`.
- **[code: path]** is this repository.

## Short answer

- **One file over HTTP.** `GET /api/artifacts/<runId>/<path>` serves a file's raw contents, `text/markdown; charset=utf-8` for a `.md` name and `text/plain; charset=utf-8` for every other name, with no `Content-Disposition` [src: `server/src/routes/api.ts`] [probe].
  The listing is `GET /api/runs/<runId>/artifacts`. There is **no** `/api/workflows/runs/<id>/artifacts`: that path falls through to the web UI's catch-all and answers **200 with the web UI's HTML** [probe].
- **The run page.** `http://localhost:3090/console/r/<runId>`, or `/console/p/<codebaseId>/r/<runId>` when the run has a project, served by `archon serve` on its own port [src: `web/src/experiments/console/ConsoleApp.tsx`, `primitives/run.ts` `runDetailPath`, `server/src/static-cache.ts` `serveWebUi`] [probe].
  It has three views, Log, Graph and Artifacts. The Artifacts view lists the files and renders the chosen one, with an "open raw ↗" link to the route above.
  It has no diff view, and no URL picks a view, a node or a file.
  It works for CLI-started runs as well as web ones.
- **On disk.** A run's files are `<output_root>/artifacts/runs/<runId>/`, which here is `C:\Users\<user>\.archon\workspaces\<owner>\<repo>\artifacts\runs\<runId>\` [probe].
  The files a run edited in its working path are not listed anywhere but Git. The only trace is the prose of reports such as `implementation.md` [probe].
- **From a mod.** No engine call opens a file in the person's editor or IDE [types].
  `$.prompt.fill` does put text into the prompt box, and the shelf mod uses it to drop a path at the cursor [types: `$.prompt.fill`] [code: `mods/shelf/hooks/register.tsx` `drop`].
  A `Link` to `vscode://file/<path>:<line>` is an OSC 8 link on the terminal, opened by whatever the terminal opens. The desktop app, VS Code and the phone draw it as plain text [types: `LinkProps`].
  The existing mods open a file with `explorer.exe`, `open` or `xdg-open` through `$.process.run` [code: `mods/outputs/hooks/files.ts` `openers`].

## 1. A run's files over HTTP

### The listing

`GET /api/runs/<runId>/artifacts` returns `{files: [{path, size, modifiedAt}]}`. Its behaviour (a live walk, the `.archon/` store left out, a 404 when the location can't be resolved) is in `archon-run-data.md`.
What this ticket adds [src: `server/src/routes/api.ts` `listRunArtifactsRoute`] [probe]:

- **Flat, not nested.** One entry per file, `path` relative to the run's folder with `/` between folders on Windows too (`review/report.md`, `nodes/plan.md`), sorted by `localeCompare`.
  No entry stands for a folder, so a tree is built from the slashes.
- **`size`** is in bytes and **`modifiedAt`** is an ISO time. No content type, line count or typed-output field is given.
  The typed-output facts are in the `nodes/<id>.meta.json` beside each `nodes/<id>.md`: `nodeId`, `outputType`, `path`, `producedAt`, `size` [probe].
- **The run id is checked** against `^[A-Za-z0-9_-]+$`, giving a 400 otherwise.
- **The two probed CLI runs:**
  - The `archon-deliver` run listed 39 files: `implementation.md` (8.6 KB), `pr-body.md`, `pr-intent.json`, `validation.md`, eight `review/*.md` reports with `review/findings.json`, four `validation/<n>.log` files (the largest 32 KB), and 18 `nodes/*` files.
  - The `archon-plan` run listed 16: `plan.md` (35 KB) and `nodes/plan.md`, plus 13 files the model left under `scratch/`, among them two 614 KB `.d.ts` copies.
  - So the listing carries the run's scratch files whole, at any size.

### One file's contents

The route is `GET /api/artifacts/<runId>/<path>`, with `<path>` as the listing spells it [src: `server/src/routes/api.ts`, the `app.get('/api/artifacts/:runId/*')` handler].
It is registered outside the OpenAPI document, so `/api/openapi.json` does not list it.

- **Content type by file name only:** `.md` gets `text/markdown; charset=utf-8`, and any other name gets `text/plain; charset=utf-8`.
  The headers are only `Content-Type`, `Content-Length` and `Access-Control-Allow-Origin: *`. There is no `Content-Disposition`, `Cache-Control` or `X-Content-Type-Options`.
  The file is read as UTF-8 text, so a binary file comes back mangled.
- **Nothing is rendered.** The response is the file as written. Whether a browser shows `text/markdown` inline as plain text or offers it as a download is the browser's choice, and no browser was tried.
  The web UI renders markdown itself (below).
- **Guards:** a path with a `..` segment or a null byte is a 400, and so is a path outside `ARCHON_HOME`. A symbolic link leading out of the run's folder is a 404.
  A percent-encoded slash works: `nodes%2Fplan.md` served `nodes/plan.md` [probe].

| Request (probe) | Status | `Content-Type` | Body |
| --- | --- | --- | --- |
| `/api/artifacts/b992…/plan.md` | 200 | `text/markdown; charset=utf-8` | 35,248 bytes |
| `/api/artifacts/9e8f…/review/report.md` | 200 | `text/markdown; charset=utf-8` | 5,503 bytes |
| `/api/artifacts/b992…/nodes/plan.meta.json` | 200 | `text/plain; charset=utf-8` | 251 bytes |
| `/api/artifacts/9e8f…/validation/1.log` | 200 | `text/plain; charset=utf-8` | 32,178 bytes |
| `HEAD /api/artifacts/b992…/plan.md` | 200 | `text/markdown; charset=utf-8` | none |
| `/api/artifacts/b992…/missing.md` | 404 | `application/json` | `{"error":"Artifact file not found"}` |
| `/api/artifacts/nosuchrun/plan.md` | 404 | `application/json` | `{"error":"Workflow run not found"}` |
| `/api/workflows/runs/b992…/artifacts` | **200** | `text/html; charset=utf-8` | the web UI's `index.html` |
| `/api/nope` | **200** | `text/html; charset=utf-8` | the web UI's `index.html` |

The last two rows matter to a client: an `/api/` path the server does not know answers 200 with HTML, because the web UI's `*` fallback is registered after every API route and covers `/api/` too [src: `server/src/static-cache.ts` `serveWebUi`].
A client has to check the content type before it parses a body as JSON.

## 2. Archon's web UI and a run's page

### Where it is served

`archon serve` serves the web UI from the same server and port as the API: `/assets/*` and `/favicon.png` as static files, then `index.html` for every other GET path [src: `server/src/index.ts`, `server/src/static-cache.ts` `serveWebUi`].
The binary downloads the web build for its version on first `serve` [src: `cli/src/commands/serve.ts`].
The port is `PORT` when set, otherwise **3090**, except that a server started inside a Git worktree takes a port hashed from its path, from 3190 up [src: `core/src/utils/port-allocation.ts` `getPort`].
With no auth configured (as on this machine, see `archon-api.md`), the pages open without a login.

### The routes

From `web/src/App.tsx`:

```tsx
<Route path="/login" element={<LoginPage />} />
<Route path="/" element={<Navigate to="/console" replace />} />
<Route path="/console/*" element={<SessionGate><ConsoleApp /></SessionGate>} />
<Route path="/legacy/*" element={<LegacyRedirect />} />
<Route path="/workflows/*" element={<LegacyRedirect />} />
<Route path="/settings" element={<Navigate to="/console/settings" replace />} />
<Route path="*" element={<Navigate to="/console" replace />} />
```

From `web/src/experiments/console/ConsoleApp.tsx` (React Router 7, under `/console`):

```tsx
<Route index element={<RunsPage />} />
<Route path="settings" element={<SettingsPage />} />
<Route path="builder" element={<BuilderConnected />} />
<Route path="builder/:name" element={<BuilderConnected />} />
<Route path="_preview" element={<PreviewPage />} />
<Route path="r/:runId" element={<RunDetailPage />} />
<Route path="*" element={<Navigate to="/console" replace />} />
<Route path="p/:projectId" element={<RunsPage />} />
<Route path="p/:projectId/chat" element={<ChatPage />} />
<Route path="p/:projectId/r/:runId" element={<RunDetailPage />} />
```

- **A run's page** is `/console/r/<runId>`, or `/console/p/<projectId>/r/<runId>`, where `<projectId>` is the run's `codebase_id` [src: `primitives/run.ts` `runDetailPath`, `toRun`].
  Both forms render the same `RunDetailPage`, which reads only `runId` from the URL and takes the project from the run itself, so the short form is enough.
  The old `/workflows/runs/<runId>` redirects to `/console/r/<runId>` [src: `web/src/routes/LegacyRedirect.tsx`].
- **Any id gives a 200.** The page is a single-page app, so the HTTP status says nothing about whether the run exists. A wrong id draws "Could not load run." in the page [src: `routes/RunDetailPage.tsx`] [probe].
- **Nothing in Archon prints this URL.** The CLI and the server never write a `/console/` link. The run row's "CLI" button goes the other way and copies `archon workflow get <id>` (see `archon-run-actions.md`) [src: every package but `web/`].

### What the run page shows

`RunDetailPage` has a header, a toolbar with three views, and `RunActionBar` along the bottom (whose buttons are in `archon-run-actions.md`) [src: `routes/RunDetailPage.tsx`]:

- **Log (key `1`).** One timeline that merges the run's events (`GET /api/workflows/runs/<id>`) with its conversation's messages, with node dividers.
  It has toggles for tool calls (`t`) and system rows (`s`), and a node filter that is a dropdown.
  A paused run's approval panel sits at the end of the timeline.
- **Graph (key `2`).** The live workflow's graph with node states.
  It needs the run's project and says "This run has no project." without one. Clicking a node switches to Log and scrolls to that node's divider.
- **Artifacts (key `3`).** A sidebar of files (base name, folder, size) and a viewer for the chosen one, which starts on the first file [src: `components/ArtifactPanel.tsx`].
  A `.md` or `.mdx` file is rendered with react-markdown, GFM and syntax highlighting. Any other file is shown as monospace plain text.
  The viewer's header has "open raw ↗", an `<a target="_blank">` to `/api/artifacts/<runId>/<path>`.
  The tab shows the file count even before it is opened.
- **No diff.** No component draws the changes a run made, and no server route serves a diff (see `archon-run-data.md` on changes to the checkout).

**No deep link inside the page.** The view, the node filter and the toggles are kept in `localStorage` (`archon.console.detailView`, `archon.console.runNodeFilter`, …), not in the URL.
The chosen file is component state. The page reads no query string or hash [src: `routes/RunDetailPage.tsx`, `components/ArtifactPanel.tsx`].
So a link can open a run's page, but not its Artifacts view, one file or one node. The browser opens whichever view it last showed.
The only stable URL for one file is the raw route.

### CLI-started runs

The page works for them. It loads the run by id over `GET /api/workflows/runs/<id>`, which returns any run, and takes messages from `conversation_platform_id` (CLI runs) or `worker_platform_id` (web runs) [src: `primitives/run.ts` `runMessageConversationId`].
Probe: the two CLI runs' conversations held 5 and 17 messages and the web run's 18, and all three pages returned the web UI.
What a CLI run's Log lacks is the model's live text, which goes only to its transcript (`archon-api.md`).
The artifacts list and viewer go by run id alone and work for every run whose output location resolves.

## 3. Where the files are on disk

- **The folder:** `<output_root>/artifacts/runs/<runId>/`, and `output_root` is `~/.archon/workspaces/<owner>/<repo>`.
  Here that is the same path under the user's home folder [probe].
  `output_root` is on the run row, and `archon workflow get <id> --json` adds `transcript_path` and `leave_behind.artifactFiles` (`archon-api.md`).
- **The engine's store in it:** `.archon/typed-artifacts/<uuid>.json` (43 files in the `archon-deliver` run, 2 in `archon-plan`) and `.archon/checkout/<sha256>.json` (in the `archon-assist` run).
  The listing route hides these, and `leave_behind.artifactFilesOmitted.internalFiles` counts them (43) [probe].
- **What runs write there** [probe]:

  | Run | Files (bytes) |
  | --- | --- |
  | `archon-plan` `b992…` | `plan.md` (35,248); `nodes/plan.md` (2,385) with `nodes/plan.meta.json` (251); `scratch/…`, 13 files the model left, up to 614,113 |
  | `archon-deliver` `9e8f…` | `implementation.md` (8,558); `pr-body.md` (3,170); `pr-action.md` (251); `pr-intent.json` (480); `validation.md` (1,156); `validation/1.log`–`4.log` (32,178, 408, 255, 74); `review/scope.md`, `code.md`, `docs.md`, `errors.md`, `seams.md`, `simplify.md`, `tests.md` (1.0–4.5 KB each); `review/report.md` and `report-round-1.md` (5,503 each); `review/findings.json` (697); `discoveries.md` and `.json` (47, 3); and a `.md` with a `.meta.json` under `nodes/` for each typed node: `classify`, `gate-green`, `gate-validated`, `impl__implement`, `pr__pr`, `pr__publish`, `review__publish`, `review__synthesize`, `validate__result` |
  | `archon-assist` `e6d2…` (web) | nothing outside `.archon/` |

  `pr-intent.json` names the repository, head branch and revision, base, title and `bodyPath`, but no PR number or URL.
- **Files the run edited in its working path:** no list exists outside Git.
  The `archon-deliver` run's `implementation.md` names them in prose under "What changed", and `review/scope.md` restates the contract, but neither is machine-readable [probe].
  That run's worktree is already gone (`leave_behind.worktreeLive: false`), so its changes now live only in Git and in its PR [probe].
  The facts for a Git diff (`checkout_baseline`, `leave_behind.branch`) are in `archon-run-data.md`.

## 4. Opening a file from a Claude Code mod

From the engine types and skill bundled with Claude Code 2.1.294, and the mods in this repository.

- **No engine call opens a file in the person's editor or IDE.**
  No noun names an editor, a VS Code extension or JetBrains. `Code`'s `path` is "drawn nowhere and never read", only used to guess the language [types: `CodeProps`].
  `$.mcp.call(server, tool, args)` calls any connected MCP server's tool "as /mcp lists it", but no type or doc names an IDE server or its tools, so whether an editor's tools are reachable that way is untested [types: `$.mcp.call`].
- **Text into the prompt box: yes.** `$.prompt.fill({ text, mode })` puts text in the box as the draft: `replace` (the default), `append`, or `insert` at the cursor [types: `$.prompt.fill`, `PromptFillArgs`].
  It resolves `{isFilled, refusal?, text, cursor}`. `refusal` is `no_composer` when the session binds no box ("headless, or a surface that draws its own composer") and `dialog` while a dialog holds the keys [types: `PromptFilled`].
  `$.prompt.read()` returns the draft and cursor, and `$.prompt.suggest` offers dim text for Tab to take [types].
  The existing mods do this:
  - shelf drops a path at the cursor, quoted when it holds whitespace [code: `mods/shelf/hooks/register.tsx` `drop`, `mods/shelf/hooks/shelf.ts` `promptText`];
  - whats-next fills a whole prompt and toasts when the box refuses it [code: `mods/whats-next/hooks/register.tsx` `pasteStep`].
- **`Link` with `href: "vscode://file/<path>:<line>"`:**
  - **Terminal:** an OSC 8 span, or the text and then the URL in dim where the terminal has no OSC 8. Any scheme is accepted, so a click opens whatever the terminal opens for `vscode:`, usually VS Code through the OS's URL handler [types: `LinkProps`].
  - **Desktop app, VS Code, phone:** "on a remote surface anything but the `https:` URL its wire promises: the text is drawn plain, and said so" [types: `LinkProps`].
    `pane-capabilities.md` saw `http://localhost` also linked there on 2.1.293. Either way `vscode:` and `file:` are plain text on those surfaces.
  - **`Markdown`:** "a link not `https:`, `http:` or `file:` draws as text", so `vscode:` is never a link in a `Markdown` on any surface [types: `MarkdownProps`] [skill].
    With `key` and `onLinkPress`, a plain click on a link it draws in the fullscreen terminal raises `ui.press` with the `href` instead, and the mod decides what to do [types: `MarkdownProps`].
- **Opening with the platform's opener** is what the existing mods do.
  outputs runs `<SystemRoot>\explorer.exe <path>` on Windows, trusting no exit code, and elsewhere `open`, then `xdg-open`. It falls back to copying the path with `$.ui.copy` [code: `mods/outputs/hooks/files.ts` `openers`, `mods/outputs/hooks/register.tsx` `openFile`, `copyPath`].
  `$.process` is "CLI only", and `$.ui.copy` says "a remote surface has no path yet" [types: `$.process`, `$.ui.copy`].
  So on the terminal a mod can open a run's file (or the run's page URL) on the session's host, and on a remote surface it has only an `https:` or localhost `Link`.
- **Showing a file in the pane** needs no opener. `$.fs.read` reads it from `<output_root>/artifacts/runs/<runId>/`, and `Markdown` or `Code` draws it. `Code` with `format: 'diff'` draws unified-diff hunks [types: `CodeProps`].

## 5. What this means for the open tickets (not decisions)

- A run's page link is `http://localhost:<port>/console/r/<runId>`.
  It is a `Link` the terminal can open, and, per the 2.1.293 probe, the other surfaces too, but it lands on whichever view the browser last showed, never straight on Artifacts.
- One file has a stable URL, `/api/artifacts/<runId>/<path>`. It serves raw text, and markdown is not rendered.
  The pane can draw the same file itself from disk or from that route, without leaving Claude Code.
- A file the person wants in their editor can be opened with the platform's opener (terminal only), dropped into the prompt with `$.prompt.fill`, or copied.
  No call reaches the IDE.
- What a run changed in its checkout has no list. Showing it means a Git diff against the run's baseline, drawn with `Code` `format: 'diff'`.
- A client that probes an `/api/` route must check the content type, since an unknown route answers 200 with HTML.

## Sources

- Archon source, tag `v0.11.1`: <https://github.com/coleam00/Archon/tree/v0.11.1>.
  The files cited are in that tree under `packages/`: `server/src/routes/api.ts`, `server/src/static-cache.ts`, `server/src/index.ts`, `cli/src/commands/serve.ts`, `core/src/utils/port-allocation.ts`, `web/src/App.tsx`, `web/src/routes/LegacyRedirect.tsx`, and under `web/src/experiments/console/`: `ConsoleApp.tsx`, `routes/RunDetailPage.tsx`, `components/ArtifactPanel.tsx`, `primitives/run.ts`.
- Probes on this machine:
  - `GET /api/health`, `/api/workflows/runs`, `/api/workflows/runs/<id>`, `/api/runs/<id>/artifacts` and `/api/conversations/<id>/messages`;
  - `GET` and `HEAD` on `/api/artifacts/<id>/<path>` as in the table;
  - `GET /console/r/<id>`, `/console/p/<codebaseId>/r/<id>` and `/workflows/runs/<id>`;
  - `archon workflow get <id> --json`;
  - listings of `~/.archon/workspaces/*/*/artifacts/runs/` and reads of `pr-intent.json`, `nodes/pr__pr.meta.json`, `implementation.md` and `review/scope.md`.
- Engine types and `plugin-authoring` `reference.md` bundled with Claude Code 2.1.294.
  Symbols used: `LinkProps`, `MarkdownProps`, `CodeProps`, `$.prompt.fill`, `$.prompt.read`, `$.prompt.suggest`, `PromptFillArgs`, `PromptFilled`, `$.mcp.call`, `$.process`, `$.ui.copy`, `Elements`.
- This repository: `mods/outputs/hooks/files.ts`, `mods/outputs/hooks/register.tsx`, `mods/shelf/hooks/register.tsx`, `mods/shelf/hooks/shelf.ts`, `mods/whats-next/hooks/register.tsx`, and `docs/research/archon-api.md`, `archon-run-data.md`, `archon-run-actions.md`, `pane-capabilities.md`.
