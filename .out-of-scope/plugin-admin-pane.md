# A pane for plugin, skill and MCP server health

No mod here shows the health of plugins, skills and MCP servers with buttons to reload them.

## Why this is out of scope

Claude Code already does this itself: `/mcp` shows each MCP server's status and reconnects it, `/plugin` manages plugins, and `/reload-plugins` reloads them.

The plugin API gives a mod little to build a better view on.
`$.mcp` offers `call` and `connect`, but no list of servers or their status, and there is no list of plugins with their health.
A pane would show less than the built-in commands and could only send the person back to them.

A mod that needs a skill, a CLI or an account still says so where the person looks for it (CONTEXT.md, **Requirement**), as whats-next does; that stays each mod's own job.

## Prior requests

- #75: "new mod: plugin-admin-pane: health of plugins, skills and MCP servers"
