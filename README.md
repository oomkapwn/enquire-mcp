<div align="center">

# obsidian-mcp

**Give Claude, Cursor, and Devin first-class access to your Obsidian vault — wikilinks resolved, frontmatter typed, backlinks indexed, basic Dataview queries.**

[![CI](https://github.com/oomkapwn/obsidian-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/oomkapwn/obsidian-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@oomkapwn/obsidian-mcp.svg)](https://www.npmjs.com/package/@oomkapwn/obsidian-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](#requirements)
[![MCP](https://img.shields.io/badge/MCP-1.29-8A2BE2.svg)](https://modelcontextprotocol.io/)
[![tests](https://img.shields.io/badge/tests-86%20passing-brightgreen.svg)](#develop)

</div>

> An [MCP](https://modelcontextprotocol.io/) server purpose-built for Obsidian. Drop it in front of any vault and your AI assistant stops guessing at filesystem paths and starts reasoning about your notes the way you do.

```text
You:    "What was I working on yesterday in the Apollo project?"
Claude: → obsidian_get_recent_edits({ since_minutes: 1440, folder: "01_Projects" })
        → obsidian_read_note({ title: "Apollo" })
        → obsidian_get_backlinks({ title: "Apollo" })
        "You shipped the v0.3 spec, opened 3 open questions in [[Apollo/Open Threads]],
        and 2 daily notes link back to it. Top blocker: the auth review."
```

---

## Why this exists

Generic filesystem MCPs treat your vault as a tree of opaque text files. **They don't know what an Obsidian vault is.** They can't:

| Capability | Filesystem MCP | obsidian-mcp |
|---|:---:|:---:|
| Read a `.md` file | ✅ | ✅ |
| Resolve `[[Wikilink]]` to the actual file | ❌ | ✅ |
| Resolve `[[Folder/Note#Heading\|alias]]` | ❌ | ✅ |
| Surface `![[Embed]]` separately from links | ❌ | ✅ |
| Parse YAML frontmatter as typed data | ❌ | ✅ |
| Filter notes by tag (frontmatter + inline) | ❌ | ✅ |
| Find every note that links to X (backlinks) | ❌ | ✅ |
| Run `LIST FROM #idea WHERE status="active"` | ❌ | ✅ |
| Stream "newest-first" recent edits | ❌ | ✅ |
| Skip `.obsidian` / `.trash` / symlinks safely | ❌ | ✅ |
| MCP **resources** for vault browsing | ❌ | ✅ |
| MCP **prompts** for "summarize / review / find orphans" | ❌ | ✅ |

That's the gap. obsidian-mcp closes it in ~1500 lines of TypeScript and four runtime dependencies.

---

## Who is this for?

- **Obsidian users on Claude Code / Cursor / Devin** who want the assistant to draft notes that actually link properly, follow `[[…]]`, and respect frontmatter.
- **Agentic workflow builders** who need a structured layer over a markdown vault — `dataview_query`, `get_backlinks`, `list_tags` are the kind of primitives that compose into real automations.
- **Tinkerers** who want to wire their PKM into LLM pipelines without writing a parser. We did the parsing.

---

## Quick start

```bash
# 1. Get the code
git clone https://github.com/oomkapwn/obsidian-mcp
cd obsidian-mcp && npm install && npm run build

# 2. Wire into Claude Code (~/.claude.json or .mcp.json)
```

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": [
        "/absolute/path/to/obsidian-mcp/dist/index.js",
        "serve",
        "--vault", "/Users/you/Documents/Obsidian Vault"
      ]
    }
  }
}
```

<details>
<summary><b>Or use <code>npx</code> (no global install)</b></summary>

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

</details>

<details>
<summary><b>Or install globally</b></summary>

```bash
npm install -g @oomkapwn/obsidian-mcp
obsidian-mcp serve --vault ~/Documents/Obsidian\ Vault
```

</details>

Restart your client. The server logs `obsidian-mcp 0.3.0 ready (read-only, vault=…)` on stderr — that's your "it's connected" signal.

---

## What you get

### 8 read tools (always on)

| Tool | What it does |
|---|---|
| `obsidian_list_notes` | Filter by tag / folder / modified-since. Returns title, path, frontmatter, tags, mtime — newest first. |
| `obsidian_read_note` | Body + frontmatter + wikilinks + embeds + tags for a note (by path or title). |
| `obsidian_resolve_wikilink` | `[[Note]]`, `[[Note#Heading]]`, `[[Folder/Note\|alias]]`, `![[Embed]]`, `[[../relative/path]]` — all resolved to a real file. |
| `obsidian_search_text` | Ranked case-insensitive substring search with snippets and line numbers. |
| `obsidian_get_recent_edits` | Newest-first stream, optional time window. |
| `obsidian_get_backlinks` | Every note linking the target, ranked by hit count, with snippets. Distinguishes wikilink vs embed vs mixed. |
| `obsidian_list_tags` | Every unique tag with frontmatter / inline counts. |
| `obsidian_dataview_query` | `LIST` / `TABLE` with `FROM`, `WHERE`, `SORT`, `LIMIT`. |

### 2 write tools (opt-in via `--enable-write`)

| Tool | What it does |
|---|---|
| `obsidian_create_note` | Create a note with optional frontmatter. Refuses to overwrite by default. |
| `obsidian_append_to_note` | Append a markdown block to an existing note. Configurable separator. |

### MCP resources

- `obsidian://vault/info` — root, note count, write flag, byte/cache limits, server version.
- `obsidian://note/{path}` — every note as a first-class browsable resource. Compatible clients show your vault as a tree.

### MCP prompts

| Prompt | Args | What it scaffolds |
|---|---|---|
| `summarize_recent_edits` | `since_minutes?` | "What was I working on?" workflow. |
| `review_tag` | `tag` | Pull every note for a tag, surface open threads. |
| `find_orphans` | `folder?` | Notes with zero inbound links — archive candidates. |

---

## Example workflows

### 1. Scan tagged ideas
> "Show me notes tagged `#idea` from the last two weeks."

`obsidian_list_notes({ tag: "idea", since_date: "2026-04-18" })`

### 2. Follow wikilinks
> "Read [[Project Apollo]] and summarise the open questions."

`obsidian_resolve_wikilink({ wikilink: "Project Apollo" })` → walk any `[[…]]` inside the result.

### 3. Pick up where you left off
> "What was I editing today?"

`obsidian_get_recent_edits({ since_minutes: 720 })`

### 4. Audit a hub note
> "Which notes link to [[Project Apollo]]?"

`obsidian_get_backlinks({ title: "Project Apollo" })` → ranked list with snippets.

### 5. Run a Dataview-style query
> "List active ideas, sorted by mtime."

```text
TABLE status FROM #idea WHERE status = "active" SORT file.mtime DESC
```

### 6. Daily journaling (write mode)
> "Append a 'shipped today' bullet to today's daily note."

With `--enable-write`: `obsidian_append_to_note({ title: "2026-05-02", content: "- Shipped obsidian-mcp v0.3" })`

---

## Architecture

```
┌─────────────────┐     stdio JSON-RPC     ┌─────────────────────┐
│  Claude Code /  │ ◄────────────────────► │   obsidian-mcp      │
│  Cursor / Devin │   tools/resources/     │  (this server)      │
└─────────────────┘   prompts                └─────────┬───────────┘
                                                      │
                                          ┌───────────┼────────────┐
                                          │           │            │
                                          ▼           ▼            ▼
                                    ┌─────────┐ ┌──────────┐ ┌──────────┐
                                    │ Vault   │ │  Parser  │ │   DQL    │
                                    │ walker  │ │  (gray-  │ │  engine  │
                                    │ + cache │ │  matter) │ │          │
                                    └────┬────┘ └──────────┘ └──────────┘
                                         │
                                         ▼
                                ┌─────────────────────┐
                                │  ~/Documents/       │
                                │  Obsidian Vault/    │
                                │  *.md *.md *.md ... │
                                └─────────────────────┘
```

- **Vault walker** — recursive, skips `.git` / `.obsidian` / `.trash` / dot-dirs / symlinks. Realpath-checks every read and write to prevent symlink-escape attacks.
- **Cache** — mtime-keyed, LRU-evicted. Default cap 1024 entries.
- **Parser** — `gray-matter` for YAML, hand-rolled regex for wikilinks / embeds / tags. Fenced code blocks are stripped before tag extraction.
- **DQL engine** — quote-aware tokenizer for keywords (`FROM`, `WHERE`, `SORT`, `LIMIT`, `AND`); won't mis-split on `WHERE x = "foo SORT bar"`.

---

## Configuration

| Flag | Default | What it does |
|---|---|---|
| `--vault <path>` | (required) | Path to the Obsidian vault root. |
| `--enable-write` | off | Register the two write tools. Server is otherwise strictly read-only. |
| `--max-file-bytes <n>` | 5 MB | Refuse to read or write any file larger. |
| `--cache-size <n>` | 1024 | LRU cap for the parsed-note cache. |

The server logs `WRITE-ENABLED` to stderr on boot when the flag is on, so you can verify the mode at a glance.

---

## Security

- **Read-only by default.** Write tools are not even registered unless `--enable-write` is passed.
- **Path traversal blocked.** Every resolved path is checked against the vault root via `realpath`.
- **Symlink-escape blocked.** Symlinks inside the vault that resolve outside (file or directory) are skipped on listing and rejected on read/write.
- **DoS guard.** Default 5 MB cap on any single file read or write; bounded LRU cache.
- **YAML.** Parsed via `gray-matter` (`js-yaml` `safeLoad` under the hood) — no code execution.

Found a security issue? See [SECURITY.md](./SECURITY.md).

---

## FAQ

**Does it support Roam / Logseq / TiddlyWiki?**
No. Obsidian's wikilink semantics, frontmatter conventions, and folder structure are baked in. Other tools are out of scope.

**Will it modify my vault?**
Not unless you start it with `--enable-write`. By default the server is strictly read-only. With write enabled, the two write tools refuse to overwrite existing notes (`obsidian_create_note` requires `overwrite=true`) and refuse to write outside the vault even if a parent dir is symlinked away.

**Does it work over the network?**
No. It's a local stdio MCP server, designed for one client process per vault. There's no HTTP transport, no auth, no rate limiting — and that's intentional.

**My DQL query returned nothing.**
Verify the source. `LIST FROM "01_Projects"` matches notes whose path starts with `01_Projects/`. `LIST FROM #idea` matches notes carrying the `idea` tag. Mix them with `WHERE`. See [docs/api.md](./docs/api.md) for the supported subset and grammar.

**What about the full Dataview plugin?**
We implement a deliberately small subset (`LIST` / `TABLE`, `FROM "folder" | #tag`, `WHERE field op value AND …`, `SORT`, `LIMIT`). No expressions, no `OR`, no `FLATTEN`/`GROUP BY`, no joins. PRs that close those gaps are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md).

**How big a vault can it handle?**
Tested daily against a 117-note vault. The walker is O(notes) per call; the cache makes repeat reads O(1). For 10k+ vaults a persistent index would help — that's on the Phase 3 roadmap.

**Why scoped npm name (`@oomkapwn/obsidian-mcp`)?**
Avoids name squatting on the `obsidian-mcp` namespace. The CLI binary is still just `obsidian-mcp`.

---

## Develop

```bash
npm test              # 86 unit tests
npm run dev           # tsc --watch
node scripts/smoke.mjs [vault-path]   # end-to-end JSON-RPC smoke
```

Build runs `tsc` and marks `dist/index.js` executable. CI tests Node 18 / 20 / 22, runs the smoke against a synthetic vault, and runs `npm audit --audit-level=high`.

---

## Troubleshooting

- **"Vault not found" on boot** — pass an absolute path or `~`-prefixed shell-expanded path to `--vault`. Relative paths resolve against the process cwd.
- **"Path escapes vault root"** — the path you passed (or a wikilink resolved to) leaves the vault, often via a symlink. The server intentionally refuses these reads.
- **"File too large" on a `.md` you didn't expect** — usually a sync conflict or binary accidentally renamed `.md`. Bump `--max-file-bytes` if you really want it ingested.
- **Write tool not visible to the client** — start the server with `--enable-write`, *after* the `serve` subcommand.
- **Russian / non-ASCII titles** — supported. Both inline `#тег` and YAML `tags: [идея]` are picked up.

---

## Versioning & releases

Semantic versioning. See [CHANGELOG.md](./CHANGELOG.md) for the full history.

- **0.3.x** — current. 8 read tools, 2 opt-in write tools, MCP resources + prompts, hardened.
- **Phase 3 (planned)** — persistent on-disk index for 10k+ vaults; full DQL (`OR`, `FLATTEN`, `GROUP BY`, expressions); multi-hop graph queries.

---

## Contributing

Bug fixes welcome. New tools should pass the bar of "useful against an Obsidian vault on day 1." See [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## License & credits

[MIT](./LICENSE). Built by [@OomkaBear](https://github.com/oomkapwn). Powered by [Model Context Protocol](https://modelcontextprotocol.io/), [`gray-matter`](https://github.com/jonschlinkert/gray-matter), [`commander`](https://github.com/tj/commander.js), and the patience of one specific Obsidian vault that didn't deserve to be parsed by hand.
