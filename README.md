# obsidian-mcp

[![CI](https://github.com/oomkapwn/obsidian-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/oomkapwn/obsidian-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@oomkapwn/obsidian-mcp.svg)](https://www.npmjs.com/package/@oomkapwn/obsidian-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](#requirements)
[![MCP](https://img.shields.io/badge/MCP-1.29-8A2BE2.svg)](https://modelcontextprotocol.io/)

MCP server for reading Obsidian vaults. Lets Claude Code / Cursor / Devin understand wikilinks, embeds, frontmatter, tags, backlinks, and basic Dataview queries — not just raw filesystem reads.

## Status

`v0.3.0` (2026-05-02) — 8 read tools, 2 opt-in write tools, MCP resources + prompts, hardened against symlinks/oversize/cache-blow.

### Read tools (always on)

- `obsidian_list_notes` — filter by tag, folder, modified-since
- `obsidian_read_note` — content + frontmatter + wikilinks + embeds + tags
- `obsidian_resolve_wikilink` — handles aliases, sections, block refs, `..` relative paths
- `obsidian_search_text` — ranked substring search
- `obsidian_get_recent_edits` — newest-first, optional time window
- `obsidian_get_backlinks` — every note linking the target, ranked, with snippets
- `obsidian_list_tags` — every unique tag with frontmatter / inline counts
- `obsidian_dataview_query` — basic LIST/TABLE with WHERE, SORT, LIMIT

### Write tools (opt-in via `--enable-write`)

- `obsidian_create_note` — create a note with optional frontmatter; refuses to overwrite by default
- `obsidian_append_to_note` — append a markdown block to an existing note

### MCP resources

- `obsidian://vault/info` — vault metadata (root, note count, write-enabled, limits)
- `obsidian://note/<relative-path>` — every note as a first-class MCP resource (browseable in compatible clients)

### MCP prompts

- `summarize_recent_edits` — quick "what was I working on?"
- `review_tag` — pull every note for a tag, surface open threads
- `find_orphans` — notes with no inbound links

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

Or with `npx` (no global install):

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["-y", "@oomkapwn/obsidian-mcp", "serve", "--vault", "/Users/you/Documents/Obsidian Vault"]
    }
  }
}
```

After publishing to npm:

```bash
npm install -g @oomkapwn/obsidian-mcp
obsidian-mcp serve --vault ~/Documents/Obsidian\ Vault
```

### Enabling write tools (opt-in)

By default the server is **strictly read-only**. To allow `obsidian_create_note` and `obsidian_append_to_note`, start it with `--enable-write`:

```json
{
  "command": "node",
  "args": [
    "/path/to/obsidian-mcp/dist/index.js",
    "serve",
    "--vault", "/Users/you/Documents/Obsidian Vault",
    "--enable-write"
  ]
}
```

The server logs `WRITE-ENABLED` to stderr on boot when the flag is on, so you can verify the mode at a glance.

### Other flags

| Flag                  | Default | What it does                             |
|-----------------------|---------|------------------------------------------|
| `--max-file-bytes <n>` | 5 MB    | Refuse to read or write any file larger. |
| `--cache-size <n>`    | 1024    | Max parsed-note cache entries (LRU).     |
| `--enable-write`      | off     | Register the two write tools.            |

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
npm test           # unit tests (79+)
npm run dev        # tsc --watch
node scripts/smoke.mjs [vault-path]   # JSON-RPC smoke test
```

## Troubleshooting

- **"Vault not found" on boot** — pass an absolute path or `~`-prefixed shell-expanded path to `--vault`. Relative paths are resolved against the process's cwd, which is rarely what you want.
- **"Path escapes vault root"** — the path you passed (or a wikilink resolved to) leaves the vault, often via a symlink. The server intentionally refuses these reads. If the file genuinely lives outside, move it inside the vault first.
- **"File too large" on a `.md` you didn't expect** — usually a binary or sync conflict file accidentally renamed `.md`. Bump `--max-file-bytes` if you really want to ingest large notes.
- **Write tool not visible to the client** — start the server with `--enable-write`. The flag must come *after* the `serve` subcommand.
- **Russian / non-ASCII titles** — supported. Both inline `#тег` and YAML `tags: [идея]` are picked up. Filenames with non-ASCII characters round-trip correctly through `obsidian_read_note` by title.
- **"My DQL query returned nothing but the data is there"** — verify the source. `LIST FROM "01_Projects"` matches notes whose path starts with `01_Projects/`; `LIST FROM #idea` matches notes carrying the `idea` tag. Mix them with `WHERE`. See `docs/api.md` for the supported subset.

## See

- [LAUNCH-PACK.md](./LAUNCH-PACK.md) — Phase 1 plan + daily log
- [docs/api.md](./docs/api.md) — full tool spec
- License: [MIT](./LICENSE)
