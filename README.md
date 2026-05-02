# obsidian-mcp

MCP server for reading Obsidian vaults. Lets Claude Code / Cursor / Devin understand wikilinks, frontmatter, and tags.

## Status

🚧 Phase 1 in progress (started 2026-05-02). 2-week minimal MVP target.

## Why

No MCP exists для Obsidian as of 2026-05-02. Generic filesystem MCPs don't understand:
- `[[Wikilink]]` resolution
- YAML frontmatter typing
- Tag-based filtering
- Dataview queries

This server adds that layer. Drop-in for any vault.

## Quick start (planned API — not shipped yet)

```bash
npm install -g @oomkapwn/obsidian-mcp
obsidian-mcp serve --vault ~/Documents/Obsidian\ Vault
```

Then configure в Claude Code / Cursor:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "obsidian-mcp",
      "args": ["serve", "--vault", "/path/to/your/vault"]
    }
  }
}
```

## See

- [LAUNCH-PACK.md](./LAUNCH-PACK.md) — full Phase 1 plan
- [docs/api.md](./docs/api.md) — tool spec (Phase 1 minimal)
- License: MIT
