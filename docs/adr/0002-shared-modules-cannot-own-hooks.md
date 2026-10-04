# A shared module cannot own a mod's timer or hooks

Three mods each run a repeating timer that must stop in a headless session, and the copies drifted: whats-next's glow lacked the attach guards that auto-resume's countdown and github-panel's polling carry. So we tried ADR-0001's next step, one module copied into each mod that would run the timer and register its own session hooks. Claude Code's load-time checks rule that shape out (checked on Claude Code 2.1.289):

- A function given `on` may only be called as a bare statement, so it cannot hand back a handle.
- `$` may only be passed to a function the checks can trace, never to a callback taken from an options object, so the shared module cannot call the mod's own work.
- A plugin may hook an event only once without a matcher, so the shared module's attach and detach hooks collide with the mod's own.

What could still be shared is a few guard functions that the mod calls from its own hooks. That is too little to pay for a sync script, a match check and a fixture plugin. So shared code stays duplicated under ADR-0001, and whats-next's glow got the guards in place. ADR-0001's copy step waits until there is enough code to share that needs no hooks of its own and no callbacks taking `$`.

## Considered Options

- Keep the duplication and fix the drifted copy in place (chosen).
- A shared module that runs the timer and owns its session hooks: ruled out by the three checks above.
- Shared guard functions, copied into each mod with a match check: deferred, because it leaves each mod wiring the guards from its own hooks and shares too little to pay for the copy step.
