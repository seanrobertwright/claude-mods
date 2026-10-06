# Text goes to the hosted model only by the person's choice, and the local model is asked first

Every judgment a mod could hand a System One model reads conversation text, a prompt the person typed, a path or repo content (`docs/research/system-one-mod-survey.md`). Sent to the hosted model, that text goes to TypeSafe in the United States, which does not train on it but keeps it for as long as it finds reasonably necessary, with no opt-out short of an enterprise contract (`docs/research/jev-access-terms.md`). Sent to the local model, it stays on the machine. So a mod treats the two differently, and the person, not the mod, decides whether anything leaves:

- Each mod has a **Model choice** with three positions: local only, local first and hosted first. It starts at local only. A key alone is not consent, because the key's usual name is one TypeSafe's own SDKs read, and it may be set for other work.
- A **Local-only folder** beats every mod's model choice: from it, a mod uses the local model or its **Fallback**.
- Where the model choice allows the hosted model, a mod sends only what its judgments were declared to send, and never the contents of a file it read itself. Text Claude already quoted in the conversation may go.
- Hosted text and the person's key go to TypeSafe's own endpoint and nowhere else. A base URL set for TypeSafe's SDKs is ignored, and the key is never sent to the local model's address.
- Only a Laya at the machine's own address is a local model. A Laya address anywhere else is not used.
- The local model is asked first for every mod, unless that mod's model choice is hosted first.
- A mod asks one model for a judgment. When that model fails or its answer is too unsure to act on, the mod uses its fallback and does not ask the other. The other model is used only while the first is unavailable. This holds in both orders.
- A mod fits its text to the model it asks. An answer the local model reports as made from cut text counts as no answer.

A reader will therefore find a mod that has a working key and never calls Jev, and a mod that falls back although the other model was reachable. Both are this decision, not bugs.

What it costs: the hosted model reads far more text than the local one and is faster, so a judgment asked of the local model sees less and falls back more often, and an unsure answer gets no second opinion. We accept that for a rule a person can say in one sentence: while the local model is up and the model choice is not hosted first, nothing leaves the machine.

It is hard to reverse because every mod's settings are built on the three positions, and because loosening the default later would send text from people who never agreed to it.

## Considered Options

What may go to the hosted model:

- Only by the person's choice, per mod, off at first (chosen).
- Never: rejected, because it gives up the hosted model even for repos where the person accepts TypeSafe's terms.
- Whenever a key is present: rejected, because a key set for other work would then send the tail of every answer to a second recipient.
- By kind of text, such as answer tails but not prompts or paths: rejected, because Claude's answers quote files and paths, so the kinds do not separate.

How wide one choice is:

- Per mod, with a local-only folder that beats it (chosen).
- One choice for all mods: rejected, because it would cover a mod installed later that sends something quite different.
- Per judgment: rejected, because the judgments of one mod send largely the same text.
- Per mod and per folder: rejected, because a decision per mod per repo is more friction than one developer's toolbox bears.

What may be sent once the choice allows it:

- Only what was declared, and never a file the mod read itself (chosen).
- Anything the mod's judgments use: rejected, because the person's choice would widen with every update.
- Only what was declared, with no floor: rejected, because it leaves "we now also send the file" open to a later mod.

Which model is asked first:

- The local model, for every mod, with hosted first as a per-mod position (chosen).
- The hosted model first: rejected, because allowing it would then mean sending everything to TypeSafe while a local model runs.
- An order fixed per mod: rejected, because no measurement of either model on these judgments exists, and the privacy behaviour would differ from mod to mod.
- No override, or one override for all mods: rejected, because stopping the local model changes every mod at once, and one setting would undo the per-mod choice.

When the model asked gives no usable answer:

- Use the fallback (chosen).
- Ask the other model next: rejected, because the hardest cases would go to TypeSafe after all, unseen, and the wait doubles in the hooks that hold a prompt or a tool.
- Ask the other model only after a failure: rejected, because a failed model is already treated as unavailable for a while, which covers the calls that follow.

When the text is longer than the local model reads:

- Fit the text to the model, and count a cut answer as none (chosen).
- Act on the cut answer: rejected, because the mod cannot know which part the model did not read.
- Send long text to the hosted model: rejected, because the longest texts are the likeliest to quote files.

What counts as local, and where hosted text may go:

- Only the machine's own address is local; only TypeSafe's own endpoint is hosted (chosen).
- Any Laya, wherever it runs, as local: rejected, because the default position would then send text over the network.
- A Laya elsewhere as a second hosted model, or a gateway through the SDKs' base URL: rejected, because each is a recipient whose terms nobody has read, for a setup nobody has asked for.
