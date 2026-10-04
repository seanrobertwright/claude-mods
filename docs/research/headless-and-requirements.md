# Detecting a headless session and missing requirements

Research for the glossary's **Headless session** and **Requirement** targets (`CONTEXT.md`) and the shared headless-session check that `docs/adr/0001-self-contained-mods.md` expects every mod to copy.
Answered from primary sources only, as of Claude Code 2.1.289.

How sources are cited:

- **[types]** is the engine types (`claude-code` module) that Claude Code 2.1.289 writes beside each loaded mod, cited by symbol.
- **[skill]** is the `plugin-authoring` skill bundled with Claude Code 2.1.289, its `reference.md`.
- **[code]** is this repository, cited by file and symbol.
- Web pages are cited by URL in the sources list.

The question was set against open PR #9 (`docs/mod-rules`).
That PR is now merged: main's `CONTEXT.md` already carries its definitions of **Surface**, **Interactive session** and **Headless session** [code: `CONTEXT.md`].

## Short answer

At `session.start` a mod can tell for certain only that a session **is** shown: `e.isInteractive` is true under the REPL [types: `SessionStartInput`].
A session that is not shown at start may still become shown, because the desktop app, the editor and a phone attach as remote surfaces after the session has started [types: `session.attach`, `$.session.surfaces`].
So a mod should treat "not shown" as a state that can change.
It starts its visible and polling work when a surface shows the session, at start or on `session.attach`, and stops polling when the last surface leaves, on `session.detach`.

## 1. Signals available at session.start

| Signal | Documented meaning | Set at start? |
| --- | --- | --- |
| `e.isInteractive` | "Whether a person is at the prompt: true under the REPL, false for a `-p` run or the SDK" [types: `SessionStartInput`] | Yes. Only `true` is final. |
| `e.surface` | "Where the session draws at start (`$.session.surfaces()[0]`): `terminal` under the REPL; null for a `-p` run or the SDK, which draw nowhere yet" [types: `SessionStartInput`] | Yes. A `null` means only "nowhere yet". |
| `$.session.surfaces()` | "every surface the session draws on, each once: `terminal` under the REPL first, then the remote ones in the order they attached … Empty in a plain -p run; never rejects" [types: `$.session.surfaces`] | Yes. It can be read again at any time. |
| `$.session.surface()` | Deprecated in favour of `surfaces()` [types: `$.session.surface`] | Do not use. |
| `$.env.get(name)` | Reads one environment variable; the name must be a string literal [types: `$.env.get`] | Yes, but no documented variable marks the session kind (see below). |

### Signals that do not answer the question at start

- **`prompt.submit` `e.origin.kind === 'sdk'`** means "The SDK host's own turn (`claude -p`, the Agent SDK), not typed at a terminal" [types: `PromptOrigin`].
  It arrives only with the first prompt, after `session.start`.
- **`$.ui.open` `isPlaced`** cannot detect a headless session.
  The types say "a `-p` run places all" [types: `$.ui.open`], and `isPlaced: false` comes back for a narrow terminal or an older desktop.
  For a bare `-p` run, "this arm never comes back" [types: `UiOpenResult`].
- **`PromptComposeTrait` `'print'`** means "a session with no terminal behind it (`-p`, the SDK)" [types: `PromptComposeTrait`].
  It is seen only when the system prompt is composed, not at start.
- **`UserPromptSubmit` `source: 'sdk'`** is the classic hook's equivalent of the prompt origin: "non-interactive entrypoint (`-p` / Agent SDK)" [types: `UserPromptSubmitHookInput`].
  It also arrives only with a prompt.
- **Calls that fail only after the fact** tell the mod nothing at start.
  `$.ui.ask` rejects "in a `-p` run (no one to ask)" [types: `$.ui.ask`].
  `$.prompt.read` answers an empty box "where the session draws no box (a -p run, an SDK host)" [types: `$.prompt.read`].
  `$.ui.copy` answers `no-surface` "(a `-p` run, the SDK)" [types: `UiCopyResult`].
- **`CLAUDE_CODE_ENTRYPOINT`** does not appear in the engine types or in the official environment-variable reference [env-vars].
  It is undocumented, so a mod should not depend on it.
- **`CLAUDECODE`** is documented as set "in subprocesses Claude Code spawns" [env-vars].
  It describes the process's parent, not whether a surface shows the session.
- **`CLAUDE_CODE_REMOTE`** marks a cloud session [env-vars].
  It says nothing about whether a surface shows the session.

### Desktop app, editor and phone sessions start out looking headless

- The skill calls the desktop app's session one "a host runs headless (the desktop app)", and groups it with the SDK as "a long-lived headless session (SDK, desktop)" [skill].
- The official desktop docs say the app "runs the same underlying engine" with an "embedded CLI" [desktop].
- `desktop`, `vscode` and `mobile` are remote surfaces: `surfaces()` lists "`terminal` under the REPL first, then the remote ones in the order they attached" [types: `$.session.surfaces`, `RenderSurface`].
- `session.attach` fires when "a surface joined the session's roster of attached clients (a phone opened the session; the desktop app connected)" [types: `SessionAttachInput`].

So a desktop or editor session can reach `session.start` with `isInteractive: false` and `surface: null`, just like a `claude -p` run.
This matches the glossary: a session started without a surface becomes interactive when one is attached [code: `CONTEXT.md`].

## 2. Trust and timing

- **Under the REPL, start is decisive.** `isInteractive: true` and `surface: 'terminal'` are set by the engine [types: `SessionStartInput`].
  The terminal's attachment "is the REPL's binding and raises nothing" [types: `SessionAttachInput`], so it never detaches either.
- **Otherwise, start is provisional.** "Draw nowhere yet" [types: `SessionStartInput`] means "not shown now", not "never shown".
  The engine types offer no field at start that tells a one-shot `claude -p` apart from an SDK host that will soon attach a surface.
- **Waiting for the first prompt's origin does not settle it either.** `'sdk'` covers both `claude -p` and the Agent SDK [types: `PromptOrigin`], and the desktop app is itself an SDK host [skill].
  The sources do not say which origin a prompt typed in the desktop app carries (see open questions).
- **There are attach and detach events.** `session.attach` gives `{ surface, clientId, viewport? }` [types: `SessionAttachInput`].
  `session.detach` gives `{ surface, clientId, reason }`, where `reason` is `'detach'` (the client said so) or `'end'` (the session ended with it attached) [types: `SessionDetachInput`, `SessionDetachReason`].
  A detach with `reason: 'end'` runs inside `session.end`'s short time bound [types: `session.detach`].
- **Detaching the last surface makes the session headless again.** `$.session.surfaces()` becomes empty for a non-REPL session.
  Under the glossary, work set going while the session was shown may still finish, but nothing new should start [code: `CONTEXT.md`].
- **How far to trust the surface name.** A client declares its own `surface`: "a rendering fact and not a trust signal: do not key policy on it" [types: `RenderInputOf`, `SessionAttachInput`].
  That warning is about security policy.
  Whether some client is attached at all is the engine's own roster, and that is what the check reads.
- **A reload fires `session.start` again** [skill], and `SessionStartInput` is "read the way `$.session` reads it at that moment" [types: `SessionStartInput`].
  So a reloaded mod should read `$.session.surfaces()` at start instead of assuming it will hear `session.attach`.

## 3. What a mod has already done when it learns it is headless

| Already done | How to undo | Source |
| --- | --- | --- |
| Slash command (`$.command.register`) | There is no unregister. `$.command` has `list`, `run` and `register` only; "Registering a name again replaces it". | [types: `$.command`] |
| Pane (`$.ui.open`) | `$.ui.close({ id })`, which raises `ui.close` with origin `plugin`. `$.ui.panes()` lists this mod's open panes. | [types: `$.ui.close`, `$.ui.panes`] |
| Timer (`$.clock.every`, `$.clock.after`) | `timer.cancel()`: "a stopped timer never fires again". A reload also drops the old timers. | [types: `Timer`] [skill] |
| Status line (`$.ui.status`) | `$.ui.status(undefined)` removes it. | [types: `$.ui.status`] |
| Band (`AbovePrompt` render) | Return `next(e)` with nothing to show. The band is "raised on the terminal and desktop surfaces only". | [skill] [types: `RenderPropsOf`] |
| Child process (`$.process.spawn`) | Leave the loop or call `return()` on the stream. | [types: `$.process.spawn`] |

Does `ui.render` fire with no surface?
Every `ui.render` input names a non-null `surface` [types: `RenderInputOf`], and a `-p` run has no surface [types: `$.session.surfaces`].
But the types also say a `-p` run places every pane, and that once a pane is placed "the first `ui.render` … follows" [types: `$.ui.open`, `UiOpenResult`].
The sources do not say on which surface that render would be raised (see open questions).

Toasts and log lines do not need undoing.
A `-p` or SDK host receives `$.ui.log` lines as `ui_log` messages [types: `$.ui.log`].

The simplest course is not to open, poll or start anything until the session is shown.
Then the only things to undo are the polling timers, cancelled when the last surface detaches.

## 4. Recommended check

This is a recommendation, not something the sources prescribe.
Each mod copies one file, `hooks/shown.ts`, per ADR 0001.
It type-checks against the 2.1.289 engine types.

```ts
import type { EngineInterface, SessionStartInput } from 'claude-code'

/**
 * True while a surface shows this session: the REPL's terminal, or a remote
 * client (desktop app, phone, editor) on the roster. Never rejects.
 */
export async function isShown($: EngineInterface, e?: SessionStartInput): Promise<boolean> {
  if (e?.isInteractive === true) return true
  return (await $.session.surfaces()).length > 0
}
```

The mod splits its start-up so that only shown sessions draw or poll:

```ts
on('session.start', async ($, e, next) => {
  await $.command.register({ name: 'demo', description: 'Open the demo pane' })
  if (await isShown($, e)) await startShown($) // open the pane, start polling
  return next(e)
})

on('session.attach', async ($, e, next) => {
  const attached = await next(e)
  await startShown($) // a no-op when already started
  return attached
})

on('session.detach', async ($, e, next) => {
  const left = await next(e)
  if (e.reason === 'detach' && !(await isShown($))) await stopShown($) // cancel timers
  return left
})
```

The evidence for each part:

- `isInteractive` and `surfaces()` are the only start-time signals the engine documents [types: `SessionStartInput`, `$.session.surfaces`].
  Under the REPL `surfaces()` already lists `terminal`, so `(await $.session.surfaces()).length > 0` alone gives the same answer; PR #19 (github-panel, for #10) uses that form.
  `surfaces()` "never rejects", so the check cannot throw.
- `session.attach` exists for exactly this case: "Observe (a phone joined: draw the lobby)" [types: `session.attach`].
- `stopShown` cancels timers and closes panes, using the calls in section 3.
- Work set going while the session was shown is kept separate.
  For auto-resume, re-arming a saved resume from `$.state` is that kind of work: it should still finish.
  Its status-line tick and any new resume are new work and should not start [code: `CONTEXT.md`, `mods/auto-resume/hooks/register.tsx` `arm`].

### Replacing WHATS_NEXT_CHILD

Today whats-next returns early from `session.start` only when `WHATS_NEXT_CHILD=1` [code: `mods/whats-next/hooks/register.tsx` `register`].
That variable is set both by its own headless run (`refresh`) and by `scripts/check-mods.mjs` `ensureTypes`.

Both of those runs are plain `claude -p` processes fed through stdin.
In each one, `isInteractive` is false and nothing attaches [types: `SessionStartInput`, `UiOpenResult`].
So `isShown` returns false, and whats-next opens no pane and starts no nested `/ask-sean` run.

The type-generation load still works.
The types are written whenever the engine loads the mod, whatever its hooks do [skill], and `/cost` is a local command, so no model turn runs.

The variable can therefore go from the mod.
`ensureTypes` and `refresh` can stop setting it in the same change: once no mod reads it, setting it does nothing.
Dropping it also removes one name from what `claude plugin validate` lists [types: `$.env`].

## 5. Requirements

The target: a mod detects a missing requirement, names it and says how to meet it.
It reports this where the person looks, such as the mod's pane, and never opens anything just to report it [code: `CONTEXT.md`].
Run these checks only in a shown session, and show the result in the pane's empty or error state.

### (a) A missing skill such as /ask-sean

- `$.command.list()` "Returns the slash commands the person can run now, built-in, plugin and MCP alike" as `{ name, description, source, plugin? }`, with `name` given "without the slash" [types: `$.command.list`, `CommandInfo`].
- `source: 'plugin'` covers "a plugin's markdown command, skill or `$.command.register`", and `'user'` covers "the user's or project's own file" [types: `CommandSource`].
- An alternative is `$.session.usage({ breakdown: 'summary' })`, whose `context.breakdown.skills.skillFrontmatter` has one `{ name, source, pluginName? }` entry "per listed skill", named "as `/skills` lists it" [types: `$.session.usage`, `ContextSkills`, `ContextSkill`].
  That list holds only the skills that fit the listing's token budget (`includedSkills` against `totalSkills`), so a skill missing from it may still exist.
- The #11 probe settled how skills are named there (recorded in a comment on #8, Claude Code 2.1.289, run as `claude -p`).
  A skill in `~/.claude/skills` is listed as `ask-sean` with source `user`.
  A plugin's copy is listed separately with its prefix: `lril:ask-sean`, source `plugin`, plugin `lril`.
  So a check matches the configured name exactly, without the leading `/`.
- A check in the parent session only shows what the parent sees.
  whats-next runs its skill in a child `claude -p --setting-sources user` [code: `mods/whats-next/hooks/register.tsx` `refresh`], so a project-scoped skill could be present in one and absent in the other.
- The run's own failure stays the final word.
  `claude -p` exits non-zero when the run fails [headless], and whats-next already reports an empty answer from the skill.

### (b) A missing CLI tool (gh, claude, git)

- `$.process.run` "Rejects when the command cannot start or is still running then", and otherwise "resolves `{ exitCode, stdout, stderr }` once it exits, any exit code" [types: `$.process.run`].
  So a missing binary is a rejection, never an exit code.
  The rejection message's wording is not documented.
- `$.process.spawn` "rejects its first pull if it cannot start" [types: `$.process.spawn`].
- A timeout also rejects (30 seconds by default) [types: `ProcessRunInit`].
  To tell "not installed" from "too slow", probe with a fast command such as `gh --version` before the real call.
- github-panel already turns the rejection into "could not run gh (…)" [code: `mods/github-panel/hooks/register.tsx` `gh`].
  whats-next's `isGitRepo` turns it into `false`, which makes a missing `git` look the same as "not a repository" [code: `mods/whats-next/hooks/register.tsx` `isGitRepo`].

### (c) A logged-out account

- **gh, with no extra call.** Any `gh` command exits with code 4 when it "requires authentication" [gh-exit-codes].
  github-panel can treat exit 4 from `gh repo view` or `gh pr list` as "run `gh auth login`".
- **gh, explicitly.** `gh auth status` exits 1 and writes to stderr "If an account on any host (or only the one given via `--hostname`) has authentication issues" [gh-auth-status].
  With `--json` it "will always exit with zero regardless of any authentication issues", so read the exit code without `--json`, or read the JSON fields with it.
- **claude CLI.** `claude auth status` "Exits with code 0 if logged in, 1 if not", and its JSON `authMethod` is one of `none`, `claude.ai`, `oauth_token`, `api_key`, `api_key_helper` or `third_party` [cli-reference].
  The fix is `claude auth login` [cli-reference].
- **claude, in a child run.** "When a failure happens inside the run, such as missing authentication, Claude Code prints the failure as the result on stdout" and exits non-zero [headless].
- **The session's own credential.** `$.session.authorize()` is null "with no first-party credential (a 3P provider, a gateway, no login)" [types: `$.session.authorize`].
  Null therefore does not mean logged out, and this call should not be used as a login check.

## 6. Open questions

These are things the primary sources do not settle.

1. **Which `prompt.submit` origin a prompt typed in the desktop app or the VS Code extension carries.**
   If it is `'sdk'`, auto-resume's current `isHeadless` flag also turns auto-resume off in desktop sessions where a person is typing.
2. **Whether a surface can attach to a `claude -p` process.**
   The types say "a bare `-p` run" [types: `UiOpenResult`], which suggests a non-bare one could have one attached.
   They do not say what a non-bare `-p` run is (for example, an SDK host over `--input-format stream-json`).
3. **What `isInteractive` is for sessions served by `claude remote-control` server mode.**
   Its docs call it "no local interactive session" [remote-control].
4. **Whether `$.session.surfaces()` already excludes the leaving client** when a `session.detach` hook reads it after `next(e)`.
5. **Whether a reloaded module hears `session.attach` again** for clients that were already attached.
   The recommended check does not depend on it, because it reads `surfaces()` at start.
6. **On which surface the engine raises `ui.render` for a pane placed in a `-p` run**, or whether it raises it at all.
7. **Whether a skill hidden from the slash menu is listed by `$.command.list()`.**
   The #11 probe settled how listed skills are named (see section 5a), but not this.
8. **Whether `CLAUDE_CODE_ENTRYPOINT` is set, and to what.**
   It is undocumented, and nothing here should depend on it.

## Sources

- Engine types (`claude-code` module), written by Claude Code 2.1.289 beside each loaded mod as `.claude-plugin/types/claude-code/index.d.ts`.
  Symbols used: `SessionStartInput`, `SessionAttachInput`, `SessionDetachInput`, `SessionDetachReason`, `session.attach`, `session.detach`, `$.session.surfaces`, `$.session.surface`, `$.session.usage`, `$.session.authorize`, `RenderSurface`, `RenderInputOf`, `RenderPropsOf`, `PromptOrigin`, `PromptComposeTrait`, `UserPromptSubmitHookInput`, `$.ui.open`, `UiOpenResult`, `$.ui.close`, `$.ui.panes`, `$.ui.status`, `$.ui.log`, `$.ui.ask`, `UiCopyResult`, `$.prompt.read`, `Timer`, `$.command`, `$.command.list`, `CommandInfo`, `CommandSource`, `ContextSkills`, `ContextSkill`, `$.process.run`, `$.process.spawn`, `ProcessRunInit`, `$.env`, `$.env.get`.
- The `plugin-authoring` skill bundled with Claude Code 2.1.289, `reference.md` and `SKILL.md`.
- [env-vars] Environment variables: <https://code.claude.com/docs/en/env-vars>
- [headless] Run Claude Code programmatically: <https://code.claude.com/docs/en/headless>
- [cli-reference] CLI reference: <https://code.claude.com/docs/en/cli-reference>
- [desktop] Desktop application: <https://code.claude.com/docs/en/desktop>
- [remote-control] Remote Control: <https://code.claude.com/docs/en/remote-control>
- [gh-auth-status] `gh auth status`: <https://cli.github.com/manual/gh_auth_status>
- [gh-exit-codes] `gh` exit codes: <https://cli.github.com/manual/gh_help_exit-codes>
- [code] This repository: `CONTEXT.md`, `docs/adr/0001-self-contained-mods.md`, `mods/auto-resume/hooks/register.tsx`, `mods/whats-next/hooks/register.tsx`, `mods/github-panel/hooks/register.tsx`, `scripts/check-mods.mjs`.
