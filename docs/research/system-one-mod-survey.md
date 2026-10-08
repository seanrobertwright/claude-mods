# Which judgments in the existing mods suit a System One model

Research for #83, a ticket on the System One map (#79).
It surveys every mod under `mods/` for the places its code makes a semantic judgment today, the judgments it could make, and the System One primitive that would fit each.
It feeds the per-mod verdicts; it does not decide them.
Answered from primary sources: this repository's code, the engine types of Claude Code 2.1.289, and TypeSafe's live documentation as read on 2026-10-05.

How sources are cited:

- **[code]** is this repository, cited by file and symbol.
- **[types]** is the engine types (`claude-code` module) that Claude Code 2.1.289 writes beside each loaded mod, cited by symbol.
- **[ts: page]** is a page of TypeSafe's documentation; the URLs are in the sources list.
- **[probe]** is a scratch run of quick-reply's `readAnswer` under Node's type stripping, on the inputs quoted with it. Nothing from it is committed.

## Short answer

- **Only whats-next asks a model anything today, and its judge is the closest fit.**
  Its `judge` asks Haiku whether the turn that just ended finished the step being worked on [code: `mods/whats-next/hooks/register.tsx` `judge`].
  That is a yes/no judgment over text the mod already assembles, so a Noul replaces it with the same state, in the same hook, and returns a probability the code can threshold instead of one word.
- **The other semantic judgments are keyword heuristics over Claude's answers.**
  quick-reply's `readAnswer` decides from a `?`, a list of asking words and the word "recommend" whether an answer asks something and what it offers [code: `mods/quick-reply/hooks/detect.ts` `readAnswer`].
  It is worth as much as whats-next's judge: it runs after every answered turn, its buttons sit in the person's eye line, and a probe shows it offering a list of changed files as choices.
- **whats-next's headless run is not a fit.**
  It reads the repo and writes titles, reasons and prompts; System One models do not generate text [ts: jaggedness "Generation"].
- **New judgments worth having:** recognising a step the person types in their own words (whats-next), marking the issue or pull request the session is working on (github-panel), dropping steps that commits have finished (whats-next), telling a shell command that reads an open Office file from one that writes it (open-file-guard), and wording turn-chime's toast by how the turn ended.
- **No candidate:** auto-resume, shelf, outputs, sources and hud.
  Each decides from typed engine data, numbers, file metadata or the person's own choices, and none reads natural language to decide what it shows or does.
- **Privacy.**
  Every candidate sends conversation text, a prompt, repo content or a shell command.
  With hosted Jev, quick-reply's would send the tail of every answer Claude gives.
  This feeds #87 (what may leave the machine).

## Ranked shortlist

Ranked by value to the author's workflow against effort.
Value weighs how often the judgment runs, whether the person sees its result, and what a wrong answer costs today.
Effort counts what the mod must add beyond the client itself, which #82 and #88 settle.

| Rank | Mod | Judgment | Primitive | Hook and latency | Today's fallback | Value | Effort |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | whats-next | W1: did the turn finish the active step? | Noul | `turn.complete`, between turns; nothing waits on it | Haiku through `$.model.complete` | High | Low |
| 2 | quick-reply | Q1: how the answer ends, whether its numbered items are choices, which one it recommends | Choice, Noul, Choice in one request | `turn.complete`, between turns; the band waits | The `readAnswer` regexes | High | Medium |
| 3 | whats-next | W2: which listed step a typed prompt pursues, when no step's prompt was pasted | Choice | `prompt.submit`; must not hold the prompt | Prefix match only (`matchStep`) | Medium | Low to medium |
| 4 | github-panel | G1: which open issue or pull request this session works on | Choice | After a reload of the lists, between turns or on the timer | No mark; gh's order | Medium to low | Medium |
| 5 | whats-next | W3: do the commits since the list was made finish a step? | Noul per step | Session start, or after a turn that moved `HEAD` | None: the step stays until a refresh or `d` | Medium to low | Medium |
| 6 | open-file-guard | O1: does a shell command that names an open Office file write it? | Noul | `tool.call`, which holds the tool, but only once the lock file shows the file open | Ask the person | Low | Low |
| 7 | turn-chime | T1: did a long turn end finished, asking, or stuck? | Choice | `turn.complete`, only when a chime is due | A "finished" toast | Low | Low |
| 8 | whats-next | W4: does a headless run's reply say it has no such skill? | Noul | After a headless run of minutes | The `NO_SUCH_SKILL` regex | Low | Low |

W1 ranks first though Q1 is worth as much: it swaps an existing call for another in a hook that already waits on nothing, so it proves the client contract at the lowest cost.
Q1 needs a new path from `turn.complete` to the band, with a guard against a reading that arrives after the next prompt.

The verdicts on this shortlist are in #91: W1 and then Q1 are integrated, W2, W3, G1, O1 and T1 wait, and W4 is not worth a model.

## How fit was judged

- **One snap judgment per question.**
  A good question is one "a knowledgeable person makes in a second given the right context"; a judgment that needs slow reasoning is split into small questions and composed in code [ts: primitives].
- **Code keeps what code can compute.**
  The docs ask not to send "something code can compute exactly", including counting, arithmetic and date comparison [ts: jaggedness].
  Regexes over a CLI's fixed error messages and parsers of a known format stay in code for the same reason.
- **No generation.**
  "`jev-1.13` is not trained to generate text"; for extraction, code finds the candidates and the model picks one [ts: jaggedness "Generation"].
- **Ask together.**
  Every question over the same state goes in one request; they run in parallel, and a speculative one whose answer code may ignore is "close to free" [ts: primitives, fan-out].
- **Probabilities set policy.**
  A Noul is a probability of yes with no separate confidence; a Choice and a Score carry a confidence [ts: primitives].
  "Thresholds scale with risk": a destructive action is gated higher than a read-only one, and the values come from the person's own data [ts: confidence].
- **Speed and size.**
  The docs call System One "real-time speeds (150ms)" [ts: use-case map].
  A request holds 32k tokens of state plus its longest question; input is text only, and English is the primary training language [ts: models].
  Laya's speed on this machine is #80's question.
- **State is data that can steer.**
  "Content written to adversarially steer the model … can move the answer" [ts: jaggedness "Adversarial content"].
  Claude's answers quote files and web pages, so a wrong answer must cost little or be confirmed.
- **The latency that matters is the person's.**
  A hook's budget (`HookBudget.ms`) counts only its own code: "the clock stops while a `next(e)` call or any `$` call of the hook's is in flight" [types: `HookBudget`].
  So a call in `prompt.submit` or `tool.call` holds the prompt or the tool for its length, while one in `turn.complete` holds only what the mod draws next.
- **A headless session starts nothing new** [code: `CONTEXT.md` **Headless session**].
  Every candidate is gated on a shown session, as whats-next's judge already is.

## Per mod

### whats-next

Today:

| Where | What it judges | How | Fit |
| --- | --- | --- | --- |
| `register.tsx` `judge`, with `parse.ts` `JUDGE_SYSTEM`, `buildJudge`, `isDone` | Whether the turn that just ended finished the active step | Haiku through `$.model.complete`, at low effort with a cap of a few tokens, read by `isDone` as DONE or not | Strong: W1 |
| `register.tsx` `refresh`, with `parse.ts` `buildAsk`, `parseSteps` | The next steps themselves | A headless `claude -p` run of the configured skill, which reads the repo and writes each step | None: it generates text |
| `parse.ts` `isMissingSkillReply`, `NO_SUCH_SKILL` | Whether a run that listed no steps said it has no such skill | The skill's name in the reply plus one of a list of phrases | Weak: W4 |
| `parse.ts` `matchStep` | Which listed step a submitted prompt starts | Prefix match after squashing whitespace; the longest prompt wins | Exact match stays in code; W2 covers what it misses |

`parseSteps` and `cleanTitle` read a format the mod asked for (`buildAsk`), so they stay in code.

**W1. Did the turn finish the active step?** Noul.

- Question: "Does `message` show that the work `step.prompt` asks for is complete?", with criteria that carry `JUDGE_SYSTEM`'s rules: no when work remains, the message asks a question, reports a failure, or does not say.
- State: `{ step: { title, why, prompt }, message }`, which `buildJudge` already assembles, the message cut to its tail by `ANSWER_TAIL`.
- Hook: `turn.complete` of the main loop, in a shown session, with a step active [code: `register.tsx` `register`, the `turn.complete` hook].
  The judge is started unawaited, so nothing waits on it.
- Gain: a probability where `isDone` reads one word.
  Code can drop the step only above a high threshold and offer the existing `d` (done) button as a question between thresholds, instead of dropping a step on one word.
  The call also leaves the session's own account: `$.model` runs completions "through the session's own client and credentials" [types: `$.model`], so today the judge draws on the account the conversation uses, and a judge asked while that account is rate-limited presumably meets the same limit (an inference, not tested).
- Fallback today: the Haiku call itself, which is the natural fallback when no System One model is reachable (#84).

**W2. Which listed step does a typed prompt pursue?** Choice over the listed step ids plus `none`.

- Today a step becomes active only when the submitted prompt begins with the step's prompt [code: `parse.ts` `matchStep`].
  A step the person asks for in their own words never glows and is never judged.
- State: `{ submitted, steps: [{ id, title, why }] }`.
- Hook: `prompt.submit`, only when `matchStep` finds nothing and the list has steps.
  It must not hold the prompt, so the answer is applied after the turn has started; whether work left unawaited in a hook survives is #82's ground (see "Found beside the question").
- Choice options lean to the first listed [ts: jaggedness "Choice option order"], and the first step is the one recommended first, so code takes a step only at a firm probability.
- The skill-suggestion cookbook picks at most one entry of a roster for a turn in the same shape, with a check that anything fits at all [ts: skill suggestion].

**W3. Do the commits since the list was made finish a step?** One Noul per step.

- `CONTEXT.md` defines a **Stale** list as one made before a new commit or a branch change, but whats-next does not compute it: its only `isStale` means an empty or unavailable list [code: `register.tsx`, the `/whats-next` command hook].
  The stale check itself is a code check of `HEAD` and the branch, not a model judgment, and comes first.
- State: `{ steps: [{ title, why }], commits: [subject lines since updatedAt] }`.
- Hook: session start, or after a turn that moved `HEAD`; nothing waits on it.
- Gain: a step finished in another session or by hand leaves the list without a minute-long refresh.

**W4. Does a headless run's reply say it has no such skill?** Noul.

- State: `{ skill, reply }`, the reply's tail.
- Hook: after a headless run that listed no steps, which already took minutes.
- Gain is small: the regex covers the usual phrasings, and a miss only shows "answered with no prompt to list" instead of naming the missing skill [code: `register.tsx` `refresh`, `parse.ts` `skillNotForHeadless`].

### quick-reply

Today, all in `readAnswer` on each answered main-loop turn [code: `mods/quick-reply/hooks/detect.ts` `readAnswer`; `register.tsx`, the `turn.complete` hook]:

| Field | What it judges | How |
| --- | --- | --- |
| `isQuestion` | Whether the answer ends by asking the person something | A `?`, or a word of `ASKING`, in the answer's closing non-empty lines outside code fences |
| `hasRecommendation` | Whether the answer recommends something | `/\brecommend/i` anywhere in the answer, code included |
| `options` | The choices offered | `findOptions`: the last run of `1.`, `a)`-style markers in sequence (`OPTION_LINE`), read only when `isQuestion` |

`isQuestion` also picks which configured replies the band shows: `questionReplies` after a question, `idleReplies` otherwise [code: `register.tsx`, the `AbovePrompt` render hook].

What the heuristics get wrong [probe]:

- "Done. I changed three files: 1. parse.ts 2. register.tsx 3. the tests … All tests pass. Shall I commit?" offers the changed files as choices, beside Yes and No.
- "See `https://example.com/search?q=mods` for the page." reads as a question, so the band shows the question replies instead of the idle ones.
- "I would not recommend option B here" sets `hasRecommendation`.

The regex reading no longer gets these three wrong (#92), so the table above describes it as surveyed, not as it is now.

**Q1. How does the answer end, and what does it offer?** One request carrying these questions:

- `ending`, a Choice: offers alternatives to pick from; asks a yes/no permission or confirmation; asks for information only the person has; reports finished work and asks nothing; reports a failure or a block it needs help with; other.
- `options_are_choices`, a Noul read only when `findOptions` found a run: "Are the items in `options` alternatives the answer asks the person to choose between, rather than steps, files or findings?"
- `recommended`, a Choice over the found markers plus `none`: which option the answer recommends, so that option's button can be the primary one.

Code keeps the policy: which reply list each `ending` shows, and the thresholds.
State: `{ answer, options: [{ marker, label }] }`, the answer being its tail without code fences.
Hook: `turn.complete`. The band draws today's reading at once and takes the model's when it comes, unless a prompt was submitted meanwhile; the guard is a counter bumped where the `prompt.submit` hook already clears the reading.
quick-reply does not check for a shown session today, since storing a reading costs nothing headless; a call per turn needs the `isShown` gate the other mods carry.
Fallback today: the regex reading, which stays as the first draw and the no-model fallback.

### auto-resume: no candidate

Every input is typed: the `classic.StopFailure` hook's `e.error` code, the rate-limit windows from `$.session.usage()`, and `prompt.submit`'s `e.origin.kind` for a take-over [code: `mods/auto-resume/hooks/plan.ts` `planResume`; `register.tsx` `register`].
`parseMinutes` parses a number from the command.
What it sends is the person's configured text, and a turn cut off by an API error always wants the same resume.

### github-panel

Today:

- `missingRequirement` matches gh's stderr with `NOT_LOGGED_IN_WORDS` and `NO_GITHUB_REMOTE`, beside gh's exit code for a missing login [code: `mods/github-panel/hooks/parse.ts` `missingRequirement`].
  These are a CLI's fixed messages, not natural language, so they stay in code.
- `foldChecks` folds GitHub's status enums to one word; `prDetail` and `issueDetail` map review decisions and labels to text. No judgment.

**G1. Which open issue or pull request is this session working on?** Choice over the listed numbers plus `none`.

- State: `{ branch, prompt, items: [{ number, kind, title, labels }] }`, the prompt being the latest one the person typed.
  A branch name that carries a number is matched in code first.
- The list holds at most the configured `limit` of each kind [code: `parse.ts` `parseConfig`], within a Choice's limit of 255 options [ts: api].
- Hook: after each reload of the lists, which runs on the timer, after turns once the lists have aged, and on demand [code: `register.tsx` `startPolling`, `load`, the `turn.complete` hook]; nothing waits on it.
- Gain: the pane marks or lifts the row being worked on.
  The wayfinder maps alone file one issue per decision, so the list is long when it matters.
- Fallback today: no mark, in gh's order.

### shelf: no candidate

Every entry is named, placed and removed by the person; `parseRequest` reads a command grammar [code: `mods/shelf/hooks/shelf.ts` `parseRequest`, `withEntry`].
Reordering the band by the draft would need a call on `prompt.edit`, which fires on each edit of the prompt box [types: `prompt.edit`].
It would move buttons while the person types and send each draft off the machine, for a list the person keeps short.

### turn-chime

Today it decides from durations, the `AskUserQuestion` tool call and `e.isAborted` [code: `mods/turn-chime/hooks/register.ts` `register`]. No judgment.

**T1. Did a long turn end finished, asking, or stuck?** Choice.

- A long turn that ends by asking in prose, rather than through `AskUserQuestion`, is announced as finished: "Turn finished after …" or "Claude finished, … after your last prompt" [code: `register.ts`, the `turn.complete` hook].
- State: `{ answer }`, its tail.
- Hook: `turn.complete`, only when a chime is due; the chime is awaited in the hook, so it would wait for the answer.
- Gain is small: the chime already sounds; only the toast's words change.
  It is the same question as Q1's `ending`, but ADR-0001 keeps the two mods from sharing it [code: `docs/adr/0001-self-contained-mods.md`].

### open-file-guard

Today:

- `officeFilesIn` finds Office paths in a shell command with `IN_COMMAND`, and `officeFile` maps the extension to an application [code: `mods/open-file-guard/hooks/office.ts`].
  This is shell syntax, not natural language, and stays in code.
- `isOpen` looks for Office's lock file beside the file [code: `register.ts` `isOpen`]. A filesystem fact.

**O1. Does a shell command that names an open Office file write it?** Noul.

- Today any shell command that names an open Office file stops for the question, even one that only reads it.
- Question: "Does `command` change, overwrite, move, rename or delete `file`?"
- State: `{ command, file }`.
- Hook: `tool.call` for Bash or PowerShell, which holds the tool, but only after `isOpen` found the lock; the alternative is a dialog the person must answer.
- A wrong "reads only" lets the write fail, which is the failure the mod exists to prevent, so only a very low probability of writing lets the call through.
- Fallback today: ask the person, which stays the safe default.
- Worth checking first: whether a read succeeds while Office holds the file (see open questions).

### outputs: no candidate

It decides from file metadata: changed since the session began (`isOutput`), the extension (`isDocument`), and the folders it skips (`isScanned`) [code: `mods/outputs/hooks/files.ts`].
Telling a deliverable from a byproduct by its path is a code question: `git check-ignore` would set build output and caches aside without a model (a suggestion, not something the sources prescribe).

### sources: no candidate

It decides from path containment (`isUnder`, `isAllowed`), groups by `rootOf`, and refuses by a lock the person sets [code: `mods/sources/hooks/paths.ts`].
A "sensitive read" warning over paths is a pattern list; over file content it would send the very secrets off the machine.

### hud: no candidate

Every figure is measured: `$.session.usage()`, `$.session.model()`, `$.agent.list()` and `git status` read by `parseGit` [code: `mods/hud/hooks/register.tsx` `refresh`; `hud.ts` `parseGit`, `shortModel`].
An inferred figure would sit among measured ones, and an early rate-limit warning (#77) is a threshold on a number, which code does better [ts: jaggedness "Math and Numbers"].

## What leaves the machine

With Laya nothing leaves the machine.
With hosted Jev each call sends its state to TypeSafe.
TypeSafe says Jev is not trained on customer requests, and offers zero data retention to enterprise customers [ts: models "Data handling", legal]; the terms are #81's question.

| Candidate | What each call sends | How often |
| --- | --- | --- |
| Q1 | The tail of Claude's answer, and the labels of the options it found | Every answered main-loop turn |
| W1 | The step's title, reason and prompt; the tail of Claude's answer | Every answered turn while a step is active |
| W2 | The prompt the person typed; the steps' titles and reasons | Every prompt that pastes no step while the list has steps |
| G1 | Open issue and pull request titles and labels; the branch name; the latest prompt | Each reload of the lists |
| W3 | The steps' titles and reasons; commit subjects | When `HEAD` has moved |
| O1 | The shell command and the file's path, which often carries the user's folder name | When a command names an open Office file |
| T1 | The tail of Claude's answer | When a long turn ends |
| W4 | The tail of a headless run's reply | After a run that listed no steps |

W1's state leaves the machine today too, to Anthropic through the session's own client [types: `$.model`], where the conversation already goes.
Hosted Jev adds a second recipient; Claude's answers quote code, file contents and repo state, and the steps' prompts are written from repo state.

## Found beside the question

- **The engine has its own classifier.**
  `$.model.classify(text, labels)` picks one label with "one completion over `$.model.complete` and a fixed classifier prompt", on the small fast model by default, and resolves `undefined` when the answer names none [types: `$.model.classify`, `ClassifyOptions`].
  It returns no distribution, but it is a Choice-shaped fallback for #84 when no System One model is reachable.
- **Unawaited work in hooks.**
  whats-next starts its judge and its refresh unawaited (`void judge(…)`), while outputs and turn-chime await theirs, with the comment that "work left running when a hook returns is dropped with its dispatch" [code: `mods/whats-next/hooks/register.tsx`, `mods/outputs/hooks/register.tsx`, `mods/turn-chime/hooks/register.ts`].
  The engine types, as far as this survey searched them, do not say which holds for an unawaited `$.http.fetch`, and the answer decides whether a between-turns call must be awaited.
- **Stale is defined but not built.**
  `CONTEXT.md` defines **Stale** for a next-steps list; whats-next has no check for it (see W3).

## Open questions

These are things the sources here do not settle.

1. **Laya's latency and accuracy on this machine** (#80).
   The latency notes above assume the docs' 150 ms for Jev.
2. **Thresholds.**
   No labelled turns exist; W1 and Q1 each need a small set of the author's own turns before their thresholds mean anything [ts: confidence].
3. **Answers heavy with code and Markdown.**
   Jev's primary training language is English prose [ts: models]; whether it reads Claude's answers as well as prose needs a test on real turns.
4. **Reading an open Office file.**
   Whether a command that only reads a file Office holds open succeeds decides O1's worth.
5. **Unawaited work in hooks** (above), which is #82's ground.

## Sources

- [code] This repository: `CONTEXT.md`, `docs/adr/0001-self-contained-mods.md`, and each mod's `hooks/` folder under `mods/`: whats-next (`register.tsx`, `parse.ts`), quick-reply (`detect.ts`, `register.tsx`), auto-resume (`plan.ts`, `register.tsx`), github-panel (`parse.ts`, `register.tsx`), shelf (`shelf.ts`, `register.tsx`), turn-chime (`chime.ts`, `register.ts`), open-file-guard (`office.ts`, `register.ts`), outputs (`files.ts`, `register.tsx`), sources (`paths.ts`, `register.tsx`) and hud (`hud.ts`, `register.tsx`).
- [types] Engine types (`claude-code` module), written by Claude Code 2.1.289 beside each loaded mod as `.claude-plugin/types/claude-code/index.d.ts`.
  Symbols used: `HookBudget`, `$.model`, `$.model.complete`, `$.model.classify`, `ClassifyOptions`, `$.http.fetch`, `prompt.edit`, `prompt.submit`, `tool.call`, `turn.complete`.
- [probe] `readAnswer` from `mods/quick-reply/hooks/detect.ts`, run with `node --experimental-strip-types` on the inputs quoted in the quick-reply section.
- [ts: use-case map] Example use cases: <https://docs.typesafe.ai/concepts/use-case-map.md>
- [ts: primitives] Primitives (Questions): <https://docs.typesafe.ai/primitives.md>, with the Choice, Noul and Score pages: <https://docs.typesafe.ai/primitives/choice.md>, <https://docs.typesafe.ai/primitives/noul.md>, <https://docs.typesafe.ai/primitives/score.md>
- [ts: confidence] Confidence: <https://docs.typesafe.ai/confidence.md>
- [ts: fan-out] Speculative fan-out: <https://docs.typesafe.ai/patterns/fan-out.md>
- [ts: jaggedness] Jev 1.13 jaggedness: <https://docs.typesafe.ai/model-jaggedness/jev-1.13.md>
- [ts: models] Models: <https://docs.typesafe.ai/models.md>
- [ts: api] API reference: <https://docs.typesafe.ai/api.md>
- [ts: legal] Legal: <https://docs.typesafe.ai/legal.md>
- [ts: skill suggestion] Skill suggestion cookbook: <https://docs.typesafe.ai/cookbooks/skill_suggestion.md>
