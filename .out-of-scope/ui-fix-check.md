# Making the model check a UI fix in the browser

No mod here holds a turn open to make the model check a UI fix in the browser and attach a screenshot before it says it is done.

## Why this is out of scope

The plugin API can do it: a function hook on `classic.Stop` can return `block` with `additionalContext`, and the model goes on working.
What it cannot do cheaply is decide when to.
Telling a UI fix from other work needs a judgement at the end of every turn, which means a model call per turn, as whats-next's judge makes one.
Each wrong call forces an extra turn of browser checks the person did not ask for.

"After a UI fix, check it in the browser and attach a screenshot" is a rule about how the model should work.
A line in the person's instructions (CLAUDE.md, or the project's own) says it at no cost per turn, and the model reads it in the turn where it matters.

## Prior requests

- #69: "new mod: ui-fix-check: make the model check a UI fix in the browser"
