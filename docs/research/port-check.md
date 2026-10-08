# Checking that a port is free from a mod

Research for [How does a mod check that a port is free, and name what holds it?](https://github.com/seanrobertwright/claude-mods/issues/152), on the [dev-server-manager map](https://github.com/seanrobertwright/claude-mods/issues/150).

How sources are cited:

- **[types]** is the function-hook declarations bundled with the `plugin-authoring` skill (Claude Code 2.1.294, `types/claude-code.d.ts`), cited by symbol.
- **[probe: shell]** is throwaway Node and Python scripts run straight from a shell on Windows 11 (Node 24.19, Python 3.14, not elevated), and in WSL's Ubuntu (kernel 6.18, Python 3.12, `net.ipv6.bindv6only = 0`). They started their own listeners on ports 47311–47390 and killed only those.
- **[probe: engine]** is a throwaway mod loaded with `claude -p --plugin-dir` on Claude Code 2.1.294, Windows. It ran every command through `$.process.run` and started and stopped its own servers through `$.process.spawn`.
- **[port-authhority]** is the skill's `scripts/port_scanner.py` and `SKILL.md`, as installed in `~/.claude/skills/port-authhority`.

**macOS was not probed.** There is no Mac here. The `lsof` rows below come from `lsof` on Linux, which is the same tool. Where this note says "macOS", it is unchecked.

## Short answer

- **Windows: `netstat -ano`, then `tasklist` for the name.** One `netstat -ano` lists IPv4 and IPv6 listeners with their PIDs, without elevation. It took 52–85 ms through `$.process.run` once warm, and 180–590 ms on the session's first call. `tasklist /FI "PID eq <pid>" /FO CSV /NH` names the PID in 0.6–0.9 s. PowerShell's `Get-NetTCPConnection` gives the same facts in 2–6 s and exits 1 when nothing matches, so it's too slow to run before every start.
- **Linux: `ss -ltnpH 'sport = :<port>'`.** It takes 4 ms and prints nothing when the port is free. It names the process (`users:(("python3",pid=810,fd=3))`) for the person's own processes. For another user's process (a root service) it still lists the row, without the name.
- **macOS: `lsof -nP -iTCP:<port> -sTCP:LISTEN`** (unchecked on a Mac). It exits 1 and prints nothing when the port is free, and gives `COMMAND` and `PID` when it isn't. Run as an ordinary user it **doesn't list another user's listener at all**: on Linux a root-owned listener was missing from its output, so the port read free.
- **A port is taken when any listener holds it, on any address.** On Windows a second server binds the same port on any *other* address with no error, even beside a `0.0.0.0` holder (the IPv4 wildcard). The narrower bind then takes that address's traffic: with one server on `0.0.0.0` and another on `127.0.0.1`, a client to `127.0.0.1` reached the second. So a server's own `EADDRINUSE` doesn't catch most collisions on Windows, and the check must count every listener on the port, IPv4 and IPv6 alike. Node resolves `localhost` to `::1` first, so an IPv6-only listener is the usual case for a Node dev server.
- **After the mod's own stop, the port lingers for under a second.** `return()` resolved in 5–16 ms, but the listener's row stayed another 0.67–0.83 s on Windows. A restart that checks right away would find its own dead server. After a crash the row was already gone when the stream reported its exit code. On Linux the row went within 15 ms of the kill either way.
- **port-authhority can't be used, but its commands can.** The scanner needs Python, the `docker` and `pyyaml` packages, and a whole `tasklist` dump. Its per-platform commands and its column positions for each command's output are worth copying. Its rule for which addresses conflict is not, because it models Linux and is wrong on Windows.

## 1. The commands, per platform

| Platform | Command | Time | Free port reads | Taken port reads |
| --- | --- | --- | --- | --- |
| Windows | `netstat -ano` | 30 ms from a shell; 52–85 ms through `$.process.run` warm, 180–590 ms cold | no `LISTENING` row with that local port | `TCP    [::1]:47313    [::]:0    LISTENING    52188` (columns: proto, local address, foreign address, state, PID) |
| Windows | `netstat -anp TCP` / `TCPv6` | 22–66 ms each | the same | IPv4 rows only / IPv6 rows only; two calls cost more than one `-ano` |
| Windows | `powershell -NoProfile -Command Get-NetTCPConnection -State Listen -LocalPort <port>` | 4.6–6.0 s (`powershell`), 1.3–2.1 s (`pwsh`) | **exit 1**: "No matching MSFT_NetTCPConnection objects found" | `{"LocalAddress":"::1","LocalPort":47317,"OwningProcess":58036}` with `ConvertTo-Json` |
| Linux | `ss -ltnpH 'sport = :<port>'` | 4 ms (15 ms for every listener) | empty, exit 0 | `LISTEN 0 128 [::1]:47313 [::]:* users:(("python3",pid=812,fd=3))` |
| Linux, macOS | `lsof -nP -iTCP:<port> -sTCP:LISTEN` | 11–74 ms (Linux) | empty, **exit 1** | `python3 812 <user> 3u IPv6 … TCP [::1]:47313 (LISTEN)`; `-Fpcn` gives `p810` / `cpython3` / `n127.0.0.1:47311`, one field per line |

[probe: shell; probe: engine]

- **The filter is the state, not the port alone.** `netstat -ano` also lists connections. Each stopped server left `TIME_WAIT` rows on its port with PID `0`, which aren't a holder. The rows that matter are the ones whose *local* address ends in `:<port>` and whose state is `LISTENING`.
- **The state word may be translated.** This machine is English. Windows translates `netstat`'s state column on other display languages (not probed here). A listening row's foreign address is always `0.0.0.0:0` or `[::]:0`, so matching on that instead of the word avoids the question.
- **PID 0 and PID 4.** PID `0` appears only on `TIME_WAIT` rows. PID `4` is `System` (`tasklist` names it). It holds ports that Windows' own HTTP service (http.sys) registered for other programs, so "System" names the kernel, not the real owner.
- **No elevation needed.** `netstat -ano` gave every PID from an unelevated shell. Only `-b` (the executable name) needs Administrator.
- **A missing tool rejects.** `$.process.run(["no-such-tool"])` rejects with `ENOENT: Command 'no-such-tool' not found or is in an unsafe location (current directory)` [probe: engine]. `netstat` and `tasklist` ran by bare name through the engine; `ss` and `lsof` ran by bare name from Python in WSL. `ss` comes with iproute2, which nearly every Linux installs; `lsof` is often missing from a minimal one.

## 2. From a PID to a name

| Platform | How | Time | Reads |
| --- | --- | --- | --- |
| Windows | `tasklist /FI "PID eq <pid>" /FO CSV /NH` | 0.57–0.9 s | `"node.exe","62892","Console","1","37,592 K"`; a PID that has gone: `INFO: No tasks are running which match the specified criteria.` (exit 0) |
| Windows | `tasklist /FO CSV /NH` (every process, as port-authhority does) | 1.5 s | 614 lines here |
| Windows | `powershell … Get-CimInstance Win32_Process -Filter "ProcessId=<pid>"` | 1.4 s | the name **and the full command line** and the parent PID |
| Linux | in `ss -p`'s `users:` field | free | the name, for the person's own processes |
| Linux | `ps -o comm=,args= -p <pid>` | 15 ms | name and command line |
| macOS | in `lsof`'s `COMMAND` column | free | the name (unchecked on a Mac) |

[probe: shell; probe: engine]

The holder is the process that bound the socket, the **leaf** of the tree. A server started with `npm run srv` showed in `netstat` as the inner `node.exe`, not npm or `cmd.exe` [probe: engine]. So the name says `node.exe` or `python.exe` far more often than anything telling. The command line says more (`…\vite.js --port 5173`), but costs a PowerShell start on Windows.

The PID doesn't tell the mod whether the holder is its own server. `$.process.spawn` gives no PID [types: `$.process.spawn`], and its server's PID is a `node.exe` grandchild anyway. A server the mod started in *another* session reads the same as a stranger's. That's the map's "two sessions in one project" question, and its answer has to come from somewhere other than the port check.

## 3. IPv4 and IPv6

One listener per address, as `netstat -ano` (Windows) and `ss -ltn` (Linux) printed it:

| The server listened on | Windows rows | Linux row |
| --- | --- | --- |
| `127.0.0.1` | `127.0.0.1:47311` | `127.0.0.1:47311` |
| `0.0.0.0` | `0.0.0.0:47312` | `0.0.0.0:47312` |
| `::1` | `[::1]:47313` | `[::1]:47313` |
| `::`, dual-stack (Node's default for `::`, and for no host at all) | **two rows**, `0.0.0.0:47314` and `[::]:47314`, the same PID | `*:47314` |
| `::`, IPv6 only | `[::]:47315` | `[::]:47315` |
| `localhost` (Node) | `[::1]:47317` | — |

[probe: shell]

Node's `dns.lookup('localhost')` answered `::1` first, then `127.0.0.1`. A Node server told to use `localhost` (Vite's default host) therefore listened on `::1` alone. A check that looked only at IPv4 rows would miss it.

### Who can bind beside whom

A second server bound the same port after the first (`EADDRINUSE` = refused, `binds` = both listening):

| First server on | then `127.0.0.1` | `0.0.0.0` | `::1` | `::` dual | `::` v6-only |
| --- | --- | --- | --- | --- | --- |
| **Windows** `127.0.0.1` | EADDRINUSE | binds | binds | binds | binds |
| **Windows** `0.0.0.0` | binds | EADDRINUSE | binds | binds | binds |
| **Windows** `::1` | binds | binds | EADDRINUSE | binds | binds |
| **Windows** `::` dual | binds | binds | binds | EADDRINUSE | binds |
| **Windows** `::` v6-only | binds | binds | binds | binds | EADDRINUSE |
| **Linux** `127.0.0.1` | EADDRINUSE | EADDRINUSE | binds | EADDRINUSE | binds |
| **Linux** `0.0.0.0` | EADDRINUSE | EADDRINUSE | binds | EADDRINUSE | binds |
| **Linux** `::1` | binds | binds | EADDRINUSE | EADDRINUSE | EADDRINUSE |
| **Linux** `::` dual | EADDRINUSE | EADDRINUSE | EADDRINUSE | EADDRINUSE | EADDRINUSE |
| **Linux** `::` v6-only | binds | binds | EADDRINUSE | EADDRINUSE | EADDRINUSE |

[probe: shell, Node listeners on Windows, Python on Linux]

On Windows only the exact same address is refused, for Node and Python alike. Then the narrower address wins the traffic:

| On Windows, first | then | A client to `127.0.0.1` reached | A client to `::1` reached |
| --- | --- | --- | --- |
| Node `0.0.0.0` | Node `127.0.0.1` | the second | refused |
| Python `0.0.0.0` | Node `127.0.0.1` | the second | refused |
| Node `127.0.0.1` | Python `0.0.0.0` | the first | refused |
| Node `127.0.0.1` | Node `::1` | the first | the second |

[probe: shell]

So on Windows two dev servers can sit on one port with no error from either. A browser on `localhost` then gets whichever its address choice picks. Vite moves to another port only when its own bind fails, so a Vite on `::1` beside another process on `127.0.0.1` would start on the same port and say nothing (inferred from the table, not run with Vite). The mod's check is the only thing that catches this, so it treats **any listener on the port, on any address, as taken**.

## 4. Timing: when the port reads free again

| What ended the server | Platform | `return()` resolved | The row was gone after |
| --- | --- | --- | --- |
| the mod's `return()`, a bare `node` server on `::1` | Windows | 7–16 ms | 680–831 ms (9 polls) |
| the mod's `return()`, `npm run srv` (npm → cmd → node) | Windows | 5–10 ms | 665–822 ms (13–15 polls) |
| the server crashed (`exit(3)`); the stream read `{ code: 3, signal: null }` | Windows | — | already gone at the first poll, 56–69 ms after the code arrived (3 runs) |
| `taskkill /F` from a shell | Windows | — | gone by the time `taskkill` returned (~0.6 s) |
| `kill` from a shell | Linux | — | 4–11 ms |

[probe: engine for the first three rows; probe: shell for the rest]

The stop is quick to return, but the tree takes most of a second to die. A restart has to wait for the row to clear before it runs the check, or it will find its own old server and call the port taken.

**`TIME_WAIT` and rebinding.** A stopped server with recent connections leaves `TIME_WAIT` rows on its port. The check ignores them, since it reads listeners only. Whether a new server can bind beside them depends on the platform:

- **Windows:** a new Node server bound at once, beside three `TIME_WAIT` rows [probe: shell].
- **Linux:** a socket without `SO_REUSEADDR` failed with `EADDRINUSE` for **61 s**, though `ss` already showed no listener. With `SO_REUSEADDR` it bound at once [probe: shell]. Node sets it on Unix, and so do Python's `HTTPServer` and `WSGIServer` (Django's `runserver`) and asyncio's `create_server` on POSIX (uvicorn) [probe: shell, the attributes read in WSL]. A dev server that doesn't would fail its restart with `EADDRINUSE`, which the mod sees as a crash, and the restart cap ends the loop.

## 5. What to take from port-authhority

The skill's scanner can't be the mod's check. It needs Python with `docker` and `pyyaml`, and the mod runs everything through `$.process.run` with no runtime of its own beyond the commands the machine has [port-authhority: `SKILL.md`, Prerequisites].

**Worth borrowing:**

- **The command per platform:** `netstat -ano` on Windows, `ss -tlnp` on Linux, `lsof -iTCP -sTCP:LISTEN -P -n` on macOS [port-authhority: `get_host_ports`]. The probe found nothing faster on any of them.
- **The column positions:** netstat's local address is field 2 and its PID the last field, split on the *last* `:` so `[::1]:5173` parses; `ss`'s process is `\("([^"]+)",pid=(\d+)`; `lsof`'s address is field 9 (`*:3000`), where `*` means every address [port-authhority: `_parse_netstat_output`, `_parse_ss_output`, `_parse_lsof_output`].
- **Listeners only:** it drops every TCP row that isn't `LISTENING` / `LISTEN`.
- **Its port names**, for the toast's wording: `references/common-ports.md` says 5432 is usually PostgreSQL and that 3000 is shared by React, Rails and Express, so "a forgotten dev server" is the likely holder.

**Not worth borrowing:**

- **Its conflict rule.** `_addresses_conflict` says `0.0.0.0` and `::` conflict with everything and any two other addresses conflict only when equal. That's close to Linux, but on Windows a wildcard holder blocks nothing (section 3), and `127.0.0.1` beside `::1` is a split, not "no conflict". For the mod, any listener on the port is the answer.
- **The whole `tasklist` dump** (1.5 s) when one PID needs a name: `tasklist /FI "PID eq <pid>"` costs less than half that.
- **Docker and compose.** The map is about the mod's own servers. A port a container publishes still shows up as a host listener, and that's enough for the check (not probed here).
- **Its `lsof` blind spot,** which it shares: run as an ordinary user, `lsof` leaves out other users' sockets, so a port a root service holds reads free on macOS.

## 6. What this means for the spec

- **The check, before every start:**
  - **Windows:** run `netstat -ano`. Keep TCP rows whose local address's last `:`-separated part is the port and whose foreign address is `0.0.0.0:0` or `[::]:0` (`LISTENING`, in any language). Collect their PIDs; a dual-stack server gives two rows with one PID.
  - **Linux:** run `ss -ltnpH 'sport = :<port>'`. Any line is a holder, and its `users:` field names it when it can.
  - **macOS:** run `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpcn`; exit 1 means no listener the person can see. Check at build, on a Mac, whether a root-owned listener is invisible there as on Linux. If it is, `netstat -anv -p tcp` is the candidate that lists every listener; it wasn't probed.
- **Taken means any listener, any address.** Don't reason about which addresses could share; on Windows the answer is "almost all", and sharing is the bug.
- **Name the holder only when the port is taken:** `tasklist /FI "PID eq <pid>" /FO CSV /NH` on Windows, the `users:` field on Linux, `lsof`'s `c` field on macOS. Say "port 5173 is taken by node.exe (PID 41236)". Say "by PID 41236" when the name can't be found, and "by another user's process" when `ss` gives no `users:`.
- **After the mod's own stop, wait before checking.** Poll every ~100 ms until no listener remains, up to ~3 s (Windows took up to 0.83 s here). After a crash no wait is needed: the row was gone when the exit code arrived. If the deadline passes, report the port as taken, as for any other holder.
- **Cost:** about 50–90 ms per check on Windows, 600–900 ms more to name a holder. Run it before a start, not on a timer.
- **It's a snapshot.** A server may take the port between the check and the bind. Where the bind fails, the server's own error and the crash path cover it; on Windows a narrower bind may not fail at all, and nothing covers that.
- **Check at build:** `lsof` on a Mac (a root-owned listener; how long `COMMAND` names run before `lsof` cuts them), and `netstat`'s output on a Windows display language other than English.

## Probe notes

- **The shell probes** spawned every listener themselves and killed only those children, by the handle that spawned them. Ports 47311–47390 were checked to be free first. (A first choice, 51731–51740, sits inside Windows' ephemeral range, where outgoing connections take ports, and was dropped.)
- **The engine probe** ran a `session.start` hook in the background under `claude -p --plugin-dir`, writing its results to a file while the model ran a Bash wait loop until a done file appeared. Its first run matched rows with a regex that found nothing, so its free-after-stop numbers were void. They were re-run with a plain filter and are the ones above.
- **The root-owned listener** on Linux was started with `wsl -u root` and checked as the ordinary user, with `su`.
- Nothing outside the probes' own processes was stopped. No listener the probes started was left running.
