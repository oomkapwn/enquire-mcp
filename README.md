# obsidian-mcp

MCP server for reading Obsidian vaults. Lets Claude Code / Cursor / Devin understand wikilinks, frontmatter, and tags — not just raw filesystem reads.

## Status

Phase 1 (2026-05-02): five tools shipped, dogfooded against a 117-note vault.

- `obsidian_list_notes` — filter by tag, folder, modified-since
- `obsidian_read_note` — content + frontmatter + wikilinks + tags
- `obsidian_resolve_wikilink` — handles aliases, sections, block refs, `..` relative paths
- `obsidian_search_text` — ranked substring search
- `obsidian_get_recent_edits` — newest-first, optional time window

## Why

No MCP existed for Obsidian as of 2026-05-02. Generic filesystem MCPs don't understand:
- `[[Wikilink]]` resolution
- YAML frontmatter typing
- Tag-based filtering
- Recent-edit streams

This server adds that layer. Drop it in for any vault.

## Quick start

```bash
git clone https://github.com/oomkapwn/obsidian-mcp
cd obsidian-mcp
npm install
npm run build
```

Then wire it into Claude Code (`~/.claude.json` or project-level `.mcp.json`):

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": [
        "/absolute/path/to/obsidian-mcp/dist/index.js",
        "serve",
        "--vault",
        "/Users/you/Documents/Obsidian Vault"
      ]
    }
  }
}
```

After publishing to npm:

```bash
npm install -g @oomkapwn/obsidian-mcp
obsidian-mcp serve --vault ~/Documents/Obsidian\ Vault
```

## Example workflows

### 1. Scan tagged ideas
> "Show me notes tagged `idea` from the last two weeks."

Claude calls `obsidian_list_notes({ tag: "idea", since_date: "2026-04-18" })`.

### 2. Follow wikilinks
> "Read [[Project Apollo]] and summarise the open questions."

Claude calls `obsidian_resolve_wikilink({ wikilink: "Project Apollo" })`, then walks any `[[…]]` inside the result.

### 3. Pick up where you left off
> "What was I editing today?"

Claude calls `obsidian_get_recent_edits({ since_minutes: 720 })`.

## Tech

TypeScript · `@modelcontextprotocol/sdk` · `gray-matter` · `commander` · `vitest`. Zero runtime deps beyond those four.

## Develop

```bash
npm test           # unit tests (33+)
npm run dev        # tsc --watch
node scripts/smoke.mjs [vault-path]   # JSON-RPC smoke test
```

## See

- [LAUNCH-PACK.md](./LAUNCH-PACK.md) — Phase 1 plan + daily log
- [docs/api.md](./docs/api.md) — full tool spec
- License: [MIT](./LICENSE)
