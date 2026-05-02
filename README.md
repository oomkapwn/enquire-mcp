# obsidian-mcp

[![CI](https://github.com/oomkapwn/obsidian-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/oomkapwn/obsidian-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](#requirements)
[![MCP](https://img.shields.io/badge/MCP-1.29-8A2BE2.svg)](https://modelcontextprotocol.io/)

MCP server for reading Obsidian vaults. Lets Claude Code / Cursor / Devin understand wikilinks, embeds, frontmatter, tags, backlinks, and basic Dataview queries — not just raw filesystem reads.

## Status

`v0.2.0` (2026-05-02) — seven tools, dogfooded against a 117-note vault.

- `obsidian_list_notes` — filter by tag, folder, modified-since
- `obsidian_read_note` — content + frontmatter + wikilinks + embeds + tags
- `obsidian_resolve_wikilink` — handles aliases, sections, block refs, `..` relative paths
- `obsidian_search_text` — ranked substring search
- `obsidian_get_recent_edits` — newest-first, optional time window
- `obsidian_get_backlinks` — every note linking the target, ranked, with snippets
- `obsidian_dataview_query` — basic LIST/TABLE with WHERE, SORT, LIMIT

See [CHANGELOG.md](./CHANGELOG.md) for release notes and [docs/api.md](./docs/api.md) for the full tool spec.

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

### 4. Audit a hub note
> "Which notes link to [[Project Apollo]]?"

Claude calls `obsidian_get_backlinks({ title: "Project Apollo" })` and gets ranked snippets.

### 5. Run a Dataview-style query
> "List all notes tagged #idea where status = active, sorted by mtime."

Claude calls `obsidian_dataview_query({ query: 'TABLE status FROM #idea WHERE status = "active" SORT file.mtime DESC' })`.

## Requirements

Node 18+. No native dependencies.

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
