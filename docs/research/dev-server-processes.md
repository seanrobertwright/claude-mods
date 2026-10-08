# Starting, stopping and reading a dev server from a mod

Research for [How does a mod start, stop and read a dev server without a shell?](https://github.com/seanrobertwright/claude-mods/issues/151), on the [dev-server-manager map](https://github.com/seanrobertwright/claude-mods/issues/150).

How sources are cited:

- **[types]** is the function-hook declarations bundled with the `plugin-authoring` skill (Claude Code 2.1.289, `types/claude-code.d.ts`), cited by symbol.
- **[probe]** is two throwaway mods loaded with `claude -p --plugin-dir` on Claude Code 2.1.294. They ran on Windows 11 with Node 24.19, against a throwaway project in the scratchpad: Vite 8.3.4, Next.js 16.4.0 (Turbopack), and uvicorn and Django 6.1.2 run through `uv`. Every process they started was killed by the probe or by the engine; nothing outside the throwaway sessions was touched (one slip, under [Probe notes](#probe-notes)).
- Tool source is cited by URL.

**macOS and Linux were not probed.** There is no Claude Code install on either here (WSL has neither Node nor Claude Code). Where this note says "Windows", read it as the only platform checked.

## Short answer

- **Bare names work, `.cmd` shims included.** `$.process.spawn({ argv: ["npm", "run", "dev"] })` runs on Windows. The engine finds `npm.cmd` on `PATH` and runs it as `cmd.exe /q /d /s /c "…\npm.cmd ^"run^" ^"dev^""`, quoting each argument itself. The same holds for `npm.cmd`, `pnpm`, and a relative or absolute path to `node_modules/.bin/vite.cmd`. The premise in #66 that a shim can't run without a shell doesn't hold on this build. The mod never writes a shell into the argv; the engine adds `cmd.exe` for a `.cmd` file.
- **A script is shell text anyway.** `npm run dev` runs the script line through `cmd.exe /d /s /c vite --port 5199`, whatever the mod does. `node <npm-cli.js> run dev` only removes the outer `cmd.exe`.
- **Leaving the loop kills the whole tree.** Calling `return()` on the stream killed every descendant, not only the child. That covered npm → cmd → node (Vite); npm → cmd → next → its worker; uv → python → python (Django's reloader) → python; and uv → uvicorn.exe → python → python. Every port was free two seconds later, with no orphans. `return()` resolved in 6–16 ms, even while a `next()` was waiting on a server that had gone quiet. The mod needs neither `taskkill` nor a PID, and `$.process.spawn` doesn't give it one anyway.
- **The mod's own stop has no exit code.** After `return()`, `stream.result` rejects with "the stream was closed before its result". Any stream the mod reads through to its `{ code, signal }` is therefore an end the mod didn't cause.
- **A death reads as an exit code only.** On Windows `signal` is always null [types: `ProcessSpawnResult`]. A crash showed its own code (`3`) and its stack on stderr. A process killed from outside read `{ code: 1, signal: null }`, the same as an ordinary `exit(1)`.
- **Session end kills the tree, and so does a reload that changes the module.** A `/reload-plugins` with the module unchanged doesn't reload it: the servers run on, and `register` doesn't run again. A `/clear` doesn't unload the module either [types: `SessionEndInput`; not probed].
- **Output comes in pieces, not lines, and needs cleaning.** Buffer to whole lines and strip ANSI before matching a URL. Vite puts colour codes *inside* the URL (`http://localhost:\e[1m5199\e[22m/`) and colours on Windows even through a pipe. Set `PYTHONUNBUFFERED=1`: Django prints its URL on stdout, which Python block-buffers through a pipe, and the line didn't arrive in 30 s without it.

## 1. Launching without a shell

What each argv did under `$.process.spawn`, with `cwd` the project:

| argv | Outcome | Tree under the engine |
| --- | --- | --- |
| `npm run fake` | runs | `cmd.exe /q /d /s /c "…\npm.cmd ^"run^" ^"fake^""` → node npm-cli.js → `cmd /d /s /c node fake.js` → node |
| `npm.cmd run fake` | runs | the same |
| `pnpm run fake` | runs, then **stalls** | `cmd.exe … pnpm.cmd` → node pnpm.mjs → node. In an npm-installed project pnpm printed "Moving next that was installed by a different package manager to node_modules/.ignored" and a boxed notice, then waited on input it never got |
| `yarn run fake` | refused at the first pull | `ENOENT: Command 'yarn' not found or is in an unsafe location (current directory)` (not installed here) |
| `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run fake` | runs | node npm-cli.js → `cmd /d /s /c node fake.js` → node (one `cmd.exe` fewer) |
| `node_modules/.bin/vite.cmd --port 5199` (relative) | runs | `cmd.exe /q /d /s /c "node_modules\.bin\vite.cmd ^^^"--port^^^" …"` → node vite.js |
| `<abs>\node_modules\.bin\vite.cmd`, and `<abs>\node_modules\.bin\vite` (the sh shim's name) | run | the same; the extensionless name resolved to `vite.cmd` |
| `node node_modules/vite/bin/vite.js --port 5199` | runs | node alone |
| `no-such-binary-xyz` | refused at the first pull | the same `ENOENT … not found or is in an unsafe location` message |

- **Where the error shows.** A command that can't start rejects the stream's first `next()`, not the `spawn` call [types: `$.process.spawn`; probe]. The message names the plugin and the command.
- **The child's environment.** The child saw `isTTY: false`, `TERM=xterm-256color` and `CLAUDECODE=1`, with no `FORCE_COLOR`, `NO_COLOR` or `CI` set [probe].
- **The wrong package manager can hang.** Running pnpm in an npm-installed project stalled on a notice and tried to rewrite `node_modules`. The package manager has to come from the lockfile (a **Detection details** question on the map).
- **The per-project command needs splitting.** `/dev-servers add <name> <command>` takes a string, and with no shell the mod must split it into an argv itself. Shell syntax (`&&`, pipes, `VAR=x cmd`) won't work in it, but a `package.json` script still can use it, since npm runs scripts through `cmd.exe` or `sh`.

## 2. Stopping

| What ended it | Tree killed? | Port free after 2 s? | What the stream said |
| --- | --- | --- | --- |
| `return()` on the stream: Vite through npm, Next through npm, Django and uvicorn through uv, a bare node server | **yes, every descendant**, including `cmd.exe` layers and Django's reloader child | yes | `return()` resolves `{ done: true }` in 6–16 ms; `result` rejects "the stream was closed before its result" |
| `return()` while a `next()` was still waiting (pnpm stalled, Django with buffered stdout) | yes | yes | resolved at once; the waiting `next()` never blocked it |
| `taskkill /T /F /PID <root>` from `$.process.run` | yes | yes | the loop ends with `{ code: 1, signal: null }`, plus any pieces still in the pipe |
| `taskkill /F` on a bare node child | yes (its `conhost.exe` too) | yes | `{ code: 1, signal: null }` |

The engine kills the whole tree itself, so the "grandchildren left holding the port" case the ticket feared didn't happen. The mod doesn't know the root's PID (`$.process.spawn` doesn't report one). Finding it for `taskkill` would take walking the process table from the engine's PID, which the probe did with `Get-CimInstance Win32_Process`. Nothing in the mod needs that.

**Check at build, on macOS and Linux:** whether `return()` kills the tree there too (a process group) or only the direct child. The types promise only that leaving the loop "kills the child" [types: `$.process.spawn`].

## 3. Reload, session end and `/clear`

| Event | What happened to a running server tree | Source |
| --- | --- | --- |
| The session ends (`claude -p` finished) | a bare node child and an npm → cmd → node tree were both gone once the process exited; no port held | probe |
| `/reload-plugins`, module **unchanged** | not reloaded: debug log "hooks modules unchanged, kept as loaded: devsrv-probe2, …". The server ran on until session end; `register` didn't run again; the module's own variables were kept | probe |
| `/reload-plugins` after an edit to the module (hot reload is the same unload) | the module unloads; the loop's pending promise rejects "the plugin's environment was unloaded"; the **whole tree** was gone within 2 s; `register` and `session.start` ran again | probe; [types: `$.process.spawn`: "the module unloading kills the child"] |
| `/clear` | the session ends with `reason: 'clear'` but "the process goes on under a new session id, and no `session.start` fires" | [types: `SessionEndInput`]; not probed |

So a fresh `register` holds no live servers at all: any server `$.state` lists as running died with the old module, and the map's "restarted after reload" applies to every such entry. An unchanged `/reload-plugins` leaves the module, and its servers, alone. After a `/clear` the servers keep running, because the module never unloaded. The mod has to choose whether `session.end` with `reason: 'clear'` stops them; that belongs to the map's lifetime decision, not here.

## 4. Output: the local URL, colour and buffering

Each `{ stream, text }` piece is decoded as it came. A line may span two pieces, and one piece may hold several lines [types: `ProcessSpawnChunk`]. The probe saw Next send "Local" and "Network" in a single piece. Python servers end lines with `\r\n`.

| Server | Stream | The line, ANSI stripped | Notes |
| --- | --- | --- | --- |
| Vite 8.3.4 | stdout | `➜  Local:   http://localhost:5199/` (two spaces before) | coloured even through a pipe, with codes inside the URL: `http://localhost:\e[1m5199\e[22m/`. `FORCE_COLOR=1` changed nothing. With the port taken it printed `Port 5199 is in use, trying another one...` and served on 5200 (unless `--strictPort`) |
| Next.js 16.4.0 | stdout | `- Local:         http://localhost:5198` | no colour; the next line is `- Network: http://100.x.x.x:5198`, so prefer a loopback host; then `✓ Ready in 7.0s` |
| Create React App | stdout | `Local:            http://localhost:3000` (two spaces before) | from source, not run: the label is `chalk.bold`. `isInteractive = process.stdout.isTTY`, so under a pipe a taken port prints the message in red and exits instead of asking [CRA `react-dev-utils/WebpackDevServerUtils.js`] |
| uvicorn | **stderr** | `INFO:     Uvicorn running on http://127.0.0.1:5196 (Press CTRL+C to quit)` | no colour; logging goes to stderr, which arrived at once |
| Django 6.1.2 `runserver` | **stdout** | `Starting WSGI development server at http://127.0.0.1:5195/` | **block-buffered**: without `PYTHONUNBUFFERED=1` only stderr's `Watching for file changes with StatReloader` arrived in 30 s. With it, the banner arrived in about 1.3 s |

A pattern that found the port in every case above (the probe matched the same regex before stripping, which Vite's mid-URL codes would have broken for the port):

```ts
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
const LOCAL_URL = /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d+)/
// per complete line, either stream: line.replace(ANSI, "").match(LOCAL_URL)
```

Take the first match. Show `0.0.0.0` as `localhost`. Keep watching after the first match, because Vite can move to another port when a restart finds the old one taken.

The stream must keep being read. Once 1,048,576 characters wait unread, the child blocks on its next write [types: `ProcessSpawnChunk`]. A server that blocks on a write stops answering requests. So the mod reads every server's loop for its whole life and keeps what it needs; what it keeps is the output ticket's question.

## 5. Crashes and exits

| Case | Result | What it printed |
| --- | --- | --- |
| `node crash.js` (writes a stack to stderr, `exit(3)`) | `{ code: 3, signal: null }` | `starting up` on stdout, then `Error: something broke\n    at …` on stderr |
| the same through `npm run crash` | `{ code: 3, signal: null }`: npm passes the script's code through | npm's `> crash` header, then the same |
| `npm run nope` (no such script) | `{ code: 1, signal: null }` | `npm error Missing script: "nope"` and a path to npm's debug log, on stderr |
| killed from outside (`taskkill /F`) | `{ code: 1, signal: null }` | nothing more |

The error to fill into the prompt is the tail of stderr before the end. For a Node crash that's the stack, and npm adds nothing after a script's own failure. On Windows the code can't tell an outside kill from a crash that exits with 1. Both count as a death under the map's rule, so this matters only to the wording of the row.

## 6. What this means for the spec

- **Launch:** spawn `[<package manager>, "run", <script>]` by bare name, and leave `cmd.exe` out of the argv. Set `PYTHONUNBUFFERED=1` in `env` for every server; it's harmless for Node.
- **Stop:** call `return()` on the stream and mark the server as stopped by the mod *before* calling it. Any loop that reaches its result is a death, and its `code` (0 or not) picks between **exited** and **crashed**.
- **Port:** match per line on stripped text, on both streams. A declared `--port` still wins.
- **Reload:** on `register`, every `$.state` entry marked running is dead, so start each again. Nothing needs killing first, because the old module's unload already did it.
- **Check at build:** the tree kill on macOS and Linux, and `/clear` (servers run on through it).

## Probe notes

- **The probe:** two throwaway mods kept outside the hot-reload folder in the session's scratchpad. Each ran under `claude -p --plugin-dir`. A `session.start` hook started the probe in the background, and the model ran a Bash wait loop until the probe wrote a done file. Process trees were read with `Get-CimInstance Win32_Process` from the engine's PID down, and ports with `netstat -ano`. The reload runs used `--input-format stream-json` to send `/reload-plugins` mid-session.
- **One slip:** the first probe's cleanup listed processes under the engine by a loose pattern. It killed that throwaway session's own Bash tool process, the wait loop, along with the probe's servers. Nothing outside the throwaway session was touched, and the second probe left `bash.exe` out of the pattern.
- **Git Bash:** Git Bash rewrites a `/reload-plugins` argument into `C:/Program Files/Git/reload-plugins` unless `MSYS_NO_PATHCONV=1` is set. Setting it there breaks `/c/...` paths, so pass Windows paths (`cygpath -m`).
