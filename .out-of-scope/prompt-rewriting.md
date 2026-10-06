# Rewriting the person's prompt

No mod here changes the text of a prompt the person sent, whether to fix typos or to expand shorthands.

## Why this is out of scope

A step's prompt reaches the model only when the person reads it and sends it themselves (CONTEXT.md, **Step**).
The same reasoning covers any prompt the person types: the model should get the text the person read.
A `prompt.submit` hook runs after the person has sent the prompt, so a rewrite there cannot be shown first or undone; a wrong fix silently changes the instruction.

Neither half needs a rewrite:

- The model reads habitual typos ("Fiz", "contine") correctly as they are.
- Shorthands the model cannot know ("c&p", "mwg") belong in a glossary in the person's CLAUDE.md, which the model reads in every session.

## Prior requests

- #73: "new mod: typo-fixer: fix habitual typos and expand shorthands before a prompt is sent"
