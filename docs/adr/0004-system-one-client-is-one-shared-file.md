# The System One client is one shared file copied into each mod

Every mod that uses a System One model needs the same client: it finds a backend, races each call against a timer, keeps one call in flight, treats a failed backend as unavailable for a while, checks the key and the answer, looks for a **Local-only folder** mark and checks that the local model is Laya.
Several mods are candidates, from whats-next and quick-reply to github-panel, open-file-guard and turn-chime (`docs/research/system-one-mod-survey.md`), and a copy of this code that drifts sends a key or text where it should not go.
So the client is the shared code ADR-0001 deferred to: one source file, `shared/system-one.ts`, copied byte for byte into `hooks/system-one.ts` of each mod that uses it, with `npm run check` failing when a copy differs from the source.
Each mod still carries its own copy, so a mod installed on its own keeps working, and nothing imports across mods.

ADR-0002 deferred shared code until there was enough of it that needs no hooks of its own and no callbacks taking `$`, and the client is such code.
Claude Code's load checks follow `$` only into a function declared in the same file, never across an import (checked with `claude plugin validate` on Claude Code 2.1.289).
So the shared file never touches `$`.
The mod's own hooks file hands it closures that call `$.http.fetch`, `$.clock.sleep` and `$.fs.exists` and say whether the session is shown, and the checks trace those calls to the hooks file.

The client meets the rule that an outbound client carrying a token has a timeout and redirects disabled (the map's security note, #79) as follows:

- **Timeout.** Each judgment names its own bound, which the client requires and caps at 10 s, the default of TypeSafe's Python SDK. It races the call against a timer, because `$.http.fetch` has neither a timeout nor an abort.
- **One call in flight.** A request that lost the race stays open on the server, so a mod keeps one call in flight per backend until the server answers. An ask that finds the backend busy takes the **Fallback**, and the backend does not count as unavailable.
- **Unavailable for a while.** Any failure (a timeout, a refused connection, a status other than 2xx, an answer it cannot read, a local model that does not say it is Laya) makes that backend unavailable for 30 s, doubling with each failure in a row up to 5 min. Any answer the client can read resets the window. A key the hosted model rejects (`401` or `403`) is the exception: the hosted model stays unavailable until the mod reloads, which is also how a changed key reaches it.
- **Redirects.** `$.http.fetch` always follows them and cannot be told not to, so a one-host rule stands in their place.
  - Both addresses are constants in the shared file: `https://api.typesafe.ai/v1/systemone`, and `http://127.0.0.1:` with the parsed port.
  - The key goes only in the `Authorization` header of a request to the hosted model. A request to the local model carries no `Authorization` header.
  - An answer of the wrong shape counts as unreadable.
  - What stays open is a redirect that TypeSafe's own endpoint issues: it is followed, and a `307` carries the request's body with it. The person already chose that recipient.

It also fixes when the client looks:

- It reads the local-only mark before every hosted call, so a mark made mid-session stops the next send.
- It checks that the local model is Laya before its first ask, and again after each window in which the local model was unavailable, since another program may hold the port by then.
- In a headless session it asks neither model.

A reader will therefore find a file under `shared/` in a repo whose mods are self-contained, and a client carrying a token that follows redirects. Both are this decision, not oversights.

It is hard to reverse because every System One integration is built on this client and on the closures its hooks file hands it.

## Considered Options

How the client is carried:

- One shared file copied into each mod, with a check that the copies match (chosen).
- Copies kept by hand: rejected, because the timeout, the one-host rule and the rejected key would live in several copies kept in step by eye.
- A plugin that adds a `$` noun for the client, listed under each mod's `dependencies`: rejected.
  A dependency is looked up by its entry in the marketplace, so the marketplace would list a plugin that is not a **Mod**.
  Its methods are events that every installed mod can hook, so it hides neither the text nor the key.
  How its methods reach `$`, which is empty while a noun is built, was not verified.
  It would have let mods share the unavailable windows and enter the key and port once, but the **Model choice** is per mod in any case.
- A shared file that takes `$` from the mod: ruled out by the load checks.

How long a call may take, and a second ask:

- A bound per judgment, capped at 10 s (chosen).
- One bound for every call, or one per backend: rejected, because a judgment that holds a prompt or a tool call and one that runs after a turn need different bounds.
- A second ask that waits for the busy backend: rejected, because it stacks requests on a slow server.
- A second ask sent to the other model: rejected, because the other model is for while the first is unavailable, and a busy model is not.

How long a failed backend stays unavailable:

- 30 s, doubling to 5 min, reset by a readable answer (chosen).
- A fixed window: rejected, because TypeSafe asks for backoff on `429` and `529`.
- The rest of the session: rejected, because one bad moment would lose the model for good.
- A window for each kind of failure: rejected, as several rules to get right for little gain.

What stands in for disabled redirects:

- The one-host rule (chosen).
- `curl --max-redirs 0` through `$.process.run`: rejected, because it costs a process per call, puts the key on standard input where every mod's `process.run` hook can read it, and sits outside the organization's network policy.
- No calls to the hosted model until Claude Code can turn redirects off: rejected, because the one-host rule already narrows the risk to a recipient the person chose.

How a rejected key is remembered:

- In the client's memory until the mod reloads (chosen).
- A fingerprint of the key, across sessions in `$.store` or for the session in `$.state`: rejected, because it writes something derived from the key where other code can read it, to save one rejected call per session.

When the client looks:

- The local-only mark before every hosted call (chosen); once per session, or cached for a minute: rejected, because a mark made mid-session would not stop the next send.
- The Laya check before the first ask and after each unavailable window (chosen); once per session: rejected, because a program that takes the port after Laya stops would go unnoticed; before every ask: rejected, as a second round trip per judgment.
- No model in a headless session (chosen); skipping only the local model there: rejected, because *local first* would then mean the hosted model in every headless run.
