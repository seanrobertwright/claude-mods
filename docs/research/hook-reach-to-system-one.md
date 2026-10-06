# What a function hook can do to reach a System One model

Research for issue #82, a ticket of the System One map (#79): what a function hook can do to reach Jev (TypeSafe's hosted model, `https://api.typesafe.ai/v1/systemone`, bearer token) or Laya (a local `laya-serve` speaking the same protocol, default `0.0.0.0:8000`), and under what limits.
Answered from primary sources, as of Claude Code 2.1.289, and checked with a probe on this machine where the sources were silent or disagreed.

How sources are cited:

- **[types]** is the engine types (`claude-code` module) that Claude Code 2.1.289 writes beside each loaded mod and into the `plugin-authoring` skill, cited by symbol.
- **[skill]** is the `plugin-authoring` skill bundled with Claude Code 2.1.289, its `reference.md`.
- **[docs: page]** is an official Claude Code docs page, listed under Sources.
- **[probe]** is a throwaway experiment run for this ticket (see "How the probe ran" at the end).
- **[laya]** and **[typesafe]** are the Laya README and the TypeSafe SDK docs, for facts about the two backends.
- **[code]** is this repository, cited by file and symbol.

## Short answer

- **Reach.** `$.http.fetch` reaches a loopback server, as `http://127.0.0.1` or `http://localhost`, and `https://api.typesafe.ai`, with a bearer header [types: `$.http.fetch`] [probe].
  An organization can refuse it; the documented switches and what the probe saw of them are in section 1.
- **No timeout, no abort.** `HttpInit` has no timeout and no signal [types: `HttpInit`].
  A mod bounds its wait by racing a `$.clock.sleep` timer, but the request itself stays open until the server answers or the session ends [probe].
- **Redirects are always followed.** There is no switch to turn them off, and the response does not say a redirect happened [types: `HttpResponse`] [probe].
  The `Authorization` header was not sent on to another origin [probe].
- **Every installed mod sees the token.** Each `$` call is an event that every other mod's hook can read, headers included [types: `OpEventOf`] [probe].
- **Key storage.** A `sensitive` `userConfig` field is per plugin and kept in the macOS Keychain or, elsewhere, `~/.claude/.credentials.json` [docs: settings-reference].
  No engine call reads another plugin's sensitive field, but nothing stops a mod reading that file with `$.fs.read`.
  `$.env.get` does see a settings-file `env` value [probe], and `$.settings.read()` returns the `env` block unfiltered [types: `$.settings`].
- **Starting `laya-serve`.** `$.process.spawn` can start it, and the engine allows that in a headless session [probe].
  The child, and the processes it starts normally, die when the session ends; only a process that detaches itself outlives the session [types: `$.process.spawn`] [probe].
  This repo's own rule forbids starting anything new in a headless session [code: `CONTEXT.md` **Headless session**].
- **Work left running after a hook returns still finishes.** An un-awaited `$.http.fetch`, `$.process.run` or `$.clock.after` completed after the hook and its dispatch had settled [probe].
  The comment in outputs, turn-chime and hud that such work "is dropped with its dispatch" does not match the engine.
- **A Claude fallback exists.** `$.model.classify(text, labels)` picks a label with the engine's small fast model [types: `$.model.classify`].
- **Sharing across mods.** No engine call finds a backend once per machine for every mod.
  The engine's own way to share one client is a plugin that adds a noun to `$` at `engine.create`, which other mods list under `dependencies` [types: `EngineCreateInput`] [docs: plugin-dependencies].

## 1. `$.http.fetch`

### What it reaches

The types: "Fetches `url` through the host (never the plugin's own network) … http or https, to whatever the host reaches, unless the organization's web-fetch policy refuses it" [types: `$.http.fetch`].
`init` takes `method`, `headers`, `body` (a string), `auth` and `socketPath` [types: `HttpInit`]; the answer is `{ status, ok, headers, text }` once the whole body is read [types: `HttpResponse`].

The probe ran a server bound to `0.0.0.0`, as `laya-serve` binds:

| Request from a hook | Result |
| --- | --- |
| `GET http://127.0.0.1:<port>/ok` with `authorization: Bearer …` | 200; the header arrived |
| `GET http://localhost:<port>/ok` | 200 |
| `GET http://0.0.0.0:<port>/ok` | 200 |
| `POST` with a JSON body and `content-type: application/json` | 200; the body arrived |
| `GET https://api.typesafe.ai/v1/systemone`, no credential | 405 `{"detail":"Method Not Allowed"}`: the host answers (the wrong method was chosen so no model call ran) |

`auth` is not for Jev: it carries the session's Anthropic credential, "only for a first-party host" [types: `HttpInit`, `$.session.authorize`].

The debug log records every `$.http.fetch` with its method and full URL, and its status and time, but not its headers [probe].
So a key belongs in a header, never in the URL.

### Switches that refuse it

- **The types** name "the organization's web-fetch policy", and say `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` "refuses a built-in's request, and any plugin's that carries `auth`" [types: `$.http.fetch`, `HttpInit`].
- **The admin docs** say more broadly: "If your organization turns off web fetching, or nonessential network traffic is turned off for the session, Claude Code refuses a network request that a mod makes with `$.http.fetch`" [docs: mods-admin].
- **The probe** sided with the types: with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, and separately with `CLAUDE_CODE_DISABLE_WEB_FETCH=1`, a fetch without `auth` to the loopback server still answered 200.
  Which organization setting the docs mean by "turns off web fetching" is not named, and was not tested.
- **A policy mod** can refuse the call by hooking `http.fetch`, or keep a mod from loading when its `uses.calls` lists `http.fetch` [docs: mods-admin] [types: `PluginRegisterUses`].
- **Mods off altogether:** `allowManagedModsOnly`, `allowManagedHooksOnly` and `disableAllHooks` in managed settings, `--safe-mode`, and an untrusted folder until the trust prompt is answered [docs: mods-admin].
- **The built-in guard** (`sec-default`) adds no network restriction [docs: mods-admin].

A mod should therefore treat a refused or failed fetch as "this backend is not there", never as an error to show on every call.

### Bounding a call

- `HttpInit` has no timeout and no signal [types: `HttpInit`].
  No engine timeout showed in the probe: requests to an endpoint that never answers stayed open until Claude Code exited, the longest about 18 s after it was sent [probe].
- A `$` call's time is not charged to the calling hook's budget: "the clock stops while a `next(e)` call or any `$` call of the hook's is in flight (a `$.clock` wait excepted)" [types: `HookBudget`].
  So a hook that awaits a fetch to a hung server holds the event it is handling (a tool call, a prompt) until the server answers or the dispatch is abandoned, for example by the person interrupting [types: `Next`].
- **Racing a timer bounds the wait.** In the probe, `Promise.race([fetch, $.clock.sleep(1500)])` returned the timer at 1502 ms.
  Pass `{ signal: next.signal }` to the sleep so it ends with the dispatch [types: `$.clock.sleep`].
- **It does not end the request.** The raced request stayed open on the server until Claude Code exited [probe].
  An abandoned request holds a socket, and Laya compute, until the server answers.
  So a mod keeps at most one call in flight per backend and marks a backend that timed out as down for a while, rather than retrying into it.
- **A signal cannot be passed.** `signal` is not a member of `HttpInit`, so TypeScript refuses it; a JavaScript probe that passed one anyway saw the request go out and still pending a second after the abort [probe].
- For comparison, `$.model.complete` has both: `timeoutMs` ("how a hook bounds the completion itself, by the clock") and `options.signal` [types: `ModelCompleteRequest`, `ModelCompleteOptions`].
- Reference points for the bound: the TypeSafe Python SDK's `DEFAULT_TIMEOUT` is 10 s per HTTP operation [typesafe: constants].
  Laya says "a cold checkpoint build costs seconds", measured at "a 7.4 s median reload on CPU", and an idle checkpoint can be unloaded so that "the next request pay[s] a cold load" [laya].

### Redirects

The types say nothing about redirects except that over a `socketPath` "redirects stay on it" [types: `HttpInit`].
The probe:

| Server answer | What `$.http.fetch` did |
| --- | --- |
| 302 to a path on the same origin | Followed; `Authorization` sent again; 200 returned |
| 302 to another origin (same host, another port) | Followed; `Authorization` not sent; 200 returned |
| 307 on a `POST` | Followed with the same method and body |

`HttpResponse` carries no final URL and no "redirected" flag, so the mod cannot tell [types: `HttpResponse`].
The map's security note, that an outbound client carrying a token needs a timeout and redirects disabled (#79), cannot be met as written with `$.http.fetch`.
What does hold: the header was dropped on a change of origin; a scheme downgrade and a change of host were not tested.
A mod that needs redirects off has to run a client of its own through `$.process.run` (for example `curl --max-redirs 0` reading its header from standard input), which the network policy does not cover [docs: mods-admin] and whose `stdin` other mods' `process.run` hooks can read [types: `OpEventOf`].

### Who else sees the request

"The calls on `$` the host serves, as events: `e` is the call's argument as it crosses to the host, and every one is hookable by name and by `on("*")`. A hook above the caller passes it on, rewrites it, refuses it with `{ deny }` or answers with `{ value }` … The calling hook alone is skipped, and `next.origin` names the caller" [types: `OpEventOf`].

In the probe, two mods in the `user` tier each hooked `http.fetch`.
Each saw the other's calls with the `Authorization` value, whichever of them ran first, and both saw the built-in telemetry plugin's calls (`origin` `cc-plugin-telemetry`, tier `builtin`).
So a bearer token is readable by every mod the person has installed, even when the key itself is kept somewhere a mod cannot read, such as the macOS Keychain.
A key kept in a file or in the environment was readable by every mod already: "Mods aren't sandboxed" [docs: mods-admin].

## 2. Where a key can live

### A `sensitive` `userConfig` field

- **Storage.** `sensitive: true` "masks input and stores the value in secure storage instead of `settings.json`" [docs: plugins-reference].
  "Claude Code stores sensitive options in the macOS Keychain instead, falling back to `~/.claude/.credentials.json` when the Keychain rejects the write; on platforms without a supported keychain, it stores them in `~/.claude/.credentials.json`" [docs: settings-reference `pluginConfigs`].
  On this Windows machine that file exists and is plain JSON holding the session's OAuth tokens [probe: key names only].
- **Reaching the mod.** The value arrives in `register(on, options)`, "the values of the fields its manifest's `userConfig` declares, defaults filled in … sensitive ones in secure storage" [types: `PluginOptions`, `Register`].
  It is also exported as `CLAUDE_PLUGIN_OPTION_<KEY>` to the plugin's own command hooks [docs: plugins-reference].
- **Per plugin.** Values are keyed by plugin id [docs: settings-reference `pluginConfigs`], so each mod that declares a key field asks for the key on its own.
- **Other plugins.** Sensitive options are not `/config` rows [docs: plugins-reference], so `$.config.list()` does not return them [types: `$.config.list`].
  Non-sensitive options of every enabled plugin are readable by any mod: as `/config` rows, a `multiple` list excepted [docs: plugins-reference] [types: `$.config`], and in `$.settings.read()`, where "nothing is filtered" [types: `$.settings`].
- **The file itself.** `$.fs` reads "files anywhere the user can", and deny rules such as `Read(.env)` do not apply to a mod's own `$.fs` calls [docs: mods-admin].
  So on Windows and Linux any installed mod can read `~/.claude/.credentials.json` directly.
  This follows from the docs; the probe deliberately did not read the values.

### `$.env.get` and the settings `env` block

- `$.env` is "the environment of this process, the one every Bash child, MCP server and `$.process.run` command started after inherits"; `get` takes the name as a string literal, and `claude plugin validate` lists it [types: `$.env`].
- A settings `env` block sets "environment variables for every session and for the subprocesses Claude Code starts from it"; from user settings, `--settings` and managed settings it applies at startup [docs: settings-reference `env`].
- **It is visible.** A variable set only in a `--settings` `env` block came back from `$.env.get`, and `$.settings.read({ source: 'flag' }).env` held it too [probe].
  User settings were not changed for the probe; the docs give them the same startup path.
- Exceptions: when the desktop app starts the session, its launch environment wins over a settings `env` value for any variable it sets; project and local `env` values apply only after the folder is trusted [docs: settings-reference `env`].
- **The cost.** The value is plain text in the settings file, every Bash child and MCP server inherits it, and any mod reads it by name or through `$.settings.read()` [docs: settings-reference `env`] [types: `$.env`, `$.settings`].
- TypeSafe's own SDKs read `TYPESAFE_API_KEY` and `TYPESAFE_BASE_URL` (default `https://api.typesafe.ai`) [typesafe: env].

### A key file

- `$.fs.read(path)` takes a path relative to the working directory or absolute, up to 4 MiB [types: `$.fs.read`].
- `~` is not expanded: `$.fs.exists('~/.claude/settings.json')` answered false while the absolute home path answered true [probe].
  The home directory comes from `$.env.get('USERPROFILE')` or `$.env.get('HOME')`.
- `$.fs.write(path, text)` takes no mode [types: `$.fs.write`], so a mod cannot create a key file with 0600 permissions; the person would make it.
- Such a file is shared by every mod and every process running as the person, which is what makes it a once-per-machine place, and also its risk.

### Side by side

| Place | Entered | Who can read it | Plain text on disk |
| --- | --- | --- | --- |
| `sensitive` `userConfig` | Once per mod that declares it | That mod through `options`; any mod through `$.fs.read` where it is a file | Windows, Linux: yes (`~/.claude/.credentials.json`); macOS: no (Keychain) |
| Settings `env` | Once per machine | Every mod, Bash child and MCP server | Yes (`settings.json`) |
| A key file under the home directory | Once per machine | Every mod and process as the person | Yes |

## 3. Starting `laya-serve`: `$.process`

- `$.process` runs commands "as the user the session runs as. CLI only" [types: `$.process`].
  The types do not say more about "CLI only".
- `$.process.spawn({ argv, cwd, env, input })` starts a command with no shell and streams its output [types: `$.process.spawn`, `ProcessSpawnRequest`].
  "The loop is the child's life: leaving it, `return()` on the stream, `next.signal` aborting or the module unloading kills the child, and nothing else does, a hook's return included" [types: `$.process.spawn`].
  Its example starts "a child for the session's life" from `session.start` in an un-awaited loop [types: `$.process.spawn`].
- `ProcessSpawnRequest` has no `detached` option [types: `ProcessSpawnRequest`].
- `$.process.run` waits for the command to exit, 30 s by default and ten minutes at most, and rejects when it cannot start [types: `$.process.run`, `ProcessRunInit`].
- **What the probe saw** (headless `claude -p`, Windows): the spawn ran; the engine does not refuse it in a headless session.
  The child had stopped by the time Claude Code exited, and so had a grandchild it started normally.
  A grandchild started detached went on running for as long as the probe watched after Claude Code had exited.
- **So** a mod could start `laya-serve` for the session's life, but it dies when the session ends.
  It would also die on every reload of the mod, since a reload replaces the module's environment; that follows from the types and was not tested.
  A server meant to outlive the session needs a launcher that detaches it, which the engine does not offer as an option.
- Two sessions that each start one would compete for the same port; this was not tested.
- `laya-serve` binds `0.0.0.0:8000` unless `LAYA_HOST` and `LAYA_PORT` say otherwise, and takes an optional `LAYA_API_KEY` bearer token [laya].
  A mod that starts it would pass `LAYA_HOST=127.0.0.1` in the spawn's `env`.
- The network policy that covers `$.http.fetch` does not cover a program a mod starts [docs: mods-admin].

## 4. Work left running after a hook returns

The question: does a pending `$.http.fetch`, or any un-awaited `$` call, complete after the hook that started it returns?
whats-next leaves its Haiku judge un-awaited in a `turn.complete` hook [code: `mods/whats-next/hooks/register.tsx` `judge`], while outputs, turn-chime and hud carry the comment "Awaited: work left running when a hook returns is dropped with its dispatch" [code: `mods/outputs/hooks/register.tsx`, `mods/turn-chime/hooks/register.ts`, `mods/hud/hooks/register.tsx`].

What the sources say:

- `next.signal` "aborts when the call this dispatch belongs to is abandoned: the user interrupted, a hook above settled first, or this hook ran out of budget" [types: `Next`].
  A normal return is not on that list.
- "A hook that returns while its `next` is pending aborts what runs beneath" [types: `EngineEventOf` `tool.call`].
  That is about `next`, not about `$` calls.
- `$.model.complete` resolves `aborted` when "the dispatch that made the call was aborted while it ran (escape on the turn whose hook called; the plugin's environment unloaded)" [types: `ModelCompleteResult`].
- At `session.end`'s short bound "`next.signal` aborts, a `$` call in flight with it" [types: `SessionEndInput`].
- A spawned child is killed by "`next.signal` aborting or the module unloading … and nothing else does, a hook's return included" [types: `$.process.spawn`].
- A timer's callback is "kept in its environment and run there when the wait resolves; a hot reload of the plugin cancels its pending waits" [types: `$.clock`].
- The reference: "anything started for the dispatch should stop on it. Work meant to outlive a dispatch belongs elsewhere: start it from a `session.start` hook … and keep it going with `$.clock.every` and `$.clock.after`" [skill].

What the probe saw: from a `session.start` hook (after its `next` had resolved) and from a `command.run` hook, an un-awaited `$.http.fetch` to a server that answered after 1.5 s and 0.7 s, an un-awaited `$.process.run` of a 1.2 s command, and a `$.clock.after(1000)` all completed after the debug log had recorded the dispatch as settled.
The `$.fs.write` each continuation then made landed too.

So:

- A pending `$` call is not dropped when its hook returns.
  It is cut when its dispatch is aborted (documented for `$.model.complete` and at `session.end`) or when the module unloads (a reload, the session's end).
- The outputs, turn-chime and hud comment is wrong as a statement about the engine; awaiting there is a choice, not a requirement.
- whats-next's un-awaited judge is the same shape as the types' own spawn example.
  An escape in the turn whose hook made the call could still cut a `$.model.complete`.
- The sanctioned ways to finish async work, from the sources:
  - await it in the hook when the answer must shape the event, bounded by a timer race (the `$` time is not charged to the hook's budget);
  - start it after `next(e)` has resolved, un-awaited and bounded by a timer, and land the answer in `$.state`, which redraws its readers and survives a reload [types: `$.state`], guarding against a stale answer with a request id;
  - run recurring work from `session.start` on `$.clock.every` or `$.clock.after` [skill].

## 5. A Claude fallback: `$.model.classify`

- `$.model.classify(text, labels, { model })` "picks one of `labels` for `text` with one completion over `$.model.complete` and a fixed classifier prompt" [types: `$.model.classify`].
  The default model is "the engine's small fast model" [types: `ClassifyOptions`].
  It resolves the label, or `undefined` when the answer named none, and rejects on a failed request, an abort or an empty reply.
- Its options have no `timeoutMs` and no `signal` [types: `ClassifyOptions`], so it is bounded the way `$.http.fetch` is, by racing a timer.
  `$.model.complete` has both, for a fallback that needs its own prompt [types: `ModelCompleteRequest`, `ModelCompleteOptions`].
- Both use the person's plan or API key [docs: mods-api], and both are events other mods can see and refuse [types: `OpValueOf`].
- It is a Claude model, not a System One model: it returns a label, with no per-option probabilities and no confidence.

## 6. Sharing state or a backend across mods

No engine call discovers a backend once per machine on behalf of every mod.
What there is:

| Mechanism | Lasts | Writes | Reads | Source |
| --- | --- | --- | --- | --- |
| A plugin noun added at `engine.create` | The session (built at each load) | The providing plugin | Every plugin; typed for those listing it under `dependencies` | [types: `EngineCreateInput`, `NounEventOf`] [skill] |
| `$.state` | The session; survives a reload | The owning plugin only | Any plugin | [types: `$.state`] |
| `$.env.set` | The process, and every child started after | Any plugin, by literal name | Any plugin, and every later child | [types: `$.env`] [probe] |
| `$.store` | Across sessions on the machine | The plugin itself | The plugin itself | [types: `$.store`] [docs: mods-reference] |
| A file through `$.fs` | The machine | Anyone | Anyone; `$.fs.write` is not atomic | [types: `$.fs`] [docs: mods-reference] |

- **A plugin noun** is the engine's way to share one client: "`return { ...built, voice: { say } }` adds this plugin's noun"; a step may add or withhold nouns but not replace another's [types: `EngineCreateInput`, `EngineEventOf` `engine.create`].
  Each method of the noun is itself an event [types: `NounEventOf`].
  The noun's types ship as the provider's contract, which the engine lays beside each dependent it loads from a folder the person owns [skill].
- **Dependencies** are installed with the plugin that declares them: "installing it installs every dependency", and "a plugin that an enabled plugin depends on starts enabled regardless" [docs: plugin-dependencies, plugins-reference].
- **`$.env.set` shares within the process.** In the probe one mod set a variable at `session.start`; a second mod read it afterwards, and a command the second mod ran saw it too.
  It also reaches every Bash child, so it is no place for a key.

## 7. What this changes for the open tickets

These are consequences for the map, not decisions.

- **#85, where the Jev key lives.**
  A per-mod `sensitive` field means entering the key once per mod, and it is plain text on Windows and Linux anyway.
  A settings `env` value (`TYPESAFE_API_KEY`, the SDK's own name) is entered once and is visible to `$.env.get`, at the price of reaching every subprocess.
  A key file under the home directory is once per machine and readable with `$.fs.read`; a mod cannot make it 0600.
  One plugin owning a single `sensitive` field and serving every mod through a `$` noun asks once and keeps the key out of the environment and out of every other mod's `options`, though on Windows and Linux it still lands in `~/.claude/.credentials.json`.
  Whatever is chosen, the key is readable by every installed mod (section 1, "Who else sees the request"), and it travels in a header, never in a URL.
- **#86, detecting Laya and who starts it.**
  Detection is a bounded `$.http.fetch` to `http://127.0.0.1:8000`; in the probe `localhost` and `127.0.0.1` both reached a server bound to `0.0.0.0`.
  Laya serves `GET /health` and `GET /models`; with `LAYA_API_KEY` set, `/health` still answers liveness without the key and keeps its details behind it [laya].
  Port 8000 is a common development port, so a port that answers is not proof of Laya: the check should read the answer.
  A mod can start `laya-serve`, but the server then lives only as long as the session, and the repo's headless rule forbids starting it in a headless session.
  For a server that outlives sessions, either the person starts it, or a mod starts it through a launcher that detaches it; the engine has no option for that itself.
- **#88, carrying the client across self-contained mods.**
  The engine's own answer is a provider plugin that adds a `$` noun, listed under `dependencies` by each mod that uses it.
  ADR 0001 rejected cross-mod imports because a single mod's install would lose a shared folder; a dependency is installed with the mod, so that reason does not apply to it.
  ADR 0002 is about a shared module inside a mod owning hooks; a provider plugin owns its own.
  It does sit against the glossary's **Mod** ("changes what Claude Code shows or does between turns") and "the marketplace lists mods and nothing else" [code: `CONTEXT.md`], which #88 has to weigh.
  Without a provider, each mod carries its own copy of a client that races every call against a timer, keeps one call in flight per backend, and handles a refused fetch.
- **Shared code already in the repo.** The comment "work left running when a hook returns is dropped with its dispatch" in outputs, turn-chime and hud should be corrected or removed; this ticket does not change the code.

## 8. Open questions

1. Which organization setting the admin docs mean by "turns off web fetching", and whether "nonessential network traffic is turned off" refuses a mod's fetch that carries no `auth`, as the docs say, or only one with `auth`, as the types say and the probe saw.
2. Whether an interrupted dispatch cuts an in-flight `$.http.fetch`, as the types say it cuts a `$.model.complete`.
3. Whether a redirect to another host, or from `https` to `http`, also drops the `Authorization` header (only a change of port was tested).
4. What the caller of `$.http.fetch` sees when a policy mod answers `{ deny }`: a rejection, or something else.
5. Why a `session.start` hook that awaited an 11 s `$.clock.sleep` was not cut at its 10 s budget in the probe, when the types say a `$.clock` wait counts against it.
6. Under which key `~/.claude/.credentials.json` keeps a plugin's sensitive options (none was stored on this machine).
7. Whether two sessions that each start `laya-serve` collide on its port, and what the second spawn reports.

## How the probe ran

Throwaway mods were loaded with `--plugin-dir` into `claude -p --setting-sources "" --no-session-persistence`, fed `/cost` so no model turn ran, on Windows 11 with Claude Code 2.1.289.
They called the `$` methods above against a local Node HTTP server bound to `0.0.0.0`, which logged each request's path, method, `Authorization` header and body, and when each connection closed.
Results came from that log, from files the mods wrote with `$.fs.write`, and from the session's `--debug-file` log.
The probe code was not kept.

## Sources

- Engine types (`claude-code` module), written by Claude Code 2.1.289.
  Symbols used: `$.http.fetch`, `HttpInit`, `HttpResponse`, `OpEventOf`, `OpValueOf`, `Origin`, `HookBudget`, `Next`, `$.clock`, `$.clock.sleep`, `$.process`, `$.process.spawn`, `$.process.run`, `ProcessSpawnRequest`, `ProcessRunInit`, `$.env`, `$.settings`, `$.fs`, `$.fs.read`, `$.fs.write`, `$.store`, `$.state`, `$.config.list`, `$.session.authorize`, `PluginOptions`, `Register`, `PluginRegisterUses`, `EngineCreateInput`, `EngineEventOf`, `NounEventOf`, `SessionEndInput`, `$.model.complete`, `$.model.classify`, `ClassifyOptions`, `ModelCompleteRequest`, `ModelCompleteOptions`, `ModelCompleteResult`.
  A copy laid beside an installed mod is rewritten at each load, so an older copy on disk can name an earlier version on its first line.
- The `plugin-authoring` skill bundled with Claude Code 2.1.289, `reference.md` ("Work that outlives a dispatch", "The types are the reference").
- [docs: mods-admin] Manage mods for your organization: <https://code.claude.com/docs/en/plugins/mods/admin>
- [docs: mods-api] Use the mods API: <https://code.claude.com/docs/en/plugins/mods/api>
- [docs: mods-reference] Mods reference: <https://code.claude.com/docs/en/plugins/mods/reference>
- [docs: plugins-reference] Plugin manifest reference: <https://code.claude.com/docs/en/plugins-reference>
- [docs: plugin-dependencies] Plugin dependencies: <https://code.claude.com/docs/en/plugins/dependencies>
- [docs: settings-reference] Settings reference, `env` and `pluginConfigs`: <https://code.claude.com/docs/en/settings-reference>
- [laya] Laya README: <https://github.com/NandhaKishorM/laya>
- [typesafe: env] TypeSafe JavaScript SDK, `ENV`: <https://docs.typesafe.ai/sdk/javascript/api/variables/ENV.md>
- [typesafe: constants] TypeSafe Python SDK, constants: <https://docs.typesafe.ai/sdk/python/api/constants.md>
- [code] This repository: `CONTEXT.md`, `docs/adr/0001-self-contained-mods.md`, `docs/adr/0002-shared-modules-cannot-own-hooks.md`, `mods/whats-next/hooks/register.tsx`, `mods/outputs/hooks/register.tsx`, `mods/turn-chime/hooks/register.ts`, `mods/hud/hooks/register.tsx`.
