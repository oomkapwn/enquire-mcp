<div align="center">

<a href="https://github.com/oomkapwn/enquire-mcp"><img src="./assets/social-preview.png" alt="enquire — MCP server for Obsidian vaults. Wikilinks, frontmatter, backlinks, Dataview, MCP resources & prompts. Named after Tim Berners-Lee's 1980 prototype of the WWW." width="100%"></a>

# enquire

## Stop your AI guessing at vault paths.

**enquire** is the MCP server that gives **Claude Code, Cursor, OpenClaw 🦞, and Codex** native, structured access to your **Obsidian** vault — wikilinks resolved, backlinks ranked, frontmatter typed, Dataview queries first-class. Read-only by default. No plugin. One command to install.

[![CI](https://github.com/oomkapwn/enquire-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/oomkapwn/enquire-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@oomkapwn/enquire-mcp.svg)](https://www.npmjs.com/package/@oomkapwn/enquire-mcp)
[![Stable](https://img.shields.io/badge/release-stable-brightgreen.svg)](./CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](#develop)
[![MCP](https://img.shields.io/badge/MCP-1.29-8A2BE2.svg)](https://modelcontextprotocol.io/)

</div>

### Quick start (30 seconds)

```bash
# Claude Code:
claude mcp add --transport stdio obsidian \
  -- npx -y @oomkapwn/enquire-mcp serve --vault ~/path/to/your/vault

# Cursor / OpenClaw / Codex / others — drop this into your MCP config:
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["-y", "@oomkapwn/enquire-mcp", "serve", "--vault", "/path/to/vault"]
    }
  }
}
```

Restart your AI client. That's it — your assistant can now follow `[[wikilinks]]`, walk backlinks, run Dataview queries, and reason about your vault the way you do.

```text
You:    "What was I working on yesterday in the Apollo project?"
Claude: → obsidian_get_recent_edits({ since_minutes: 1440, folder: "01_Projects" })
        → obsidian_read_note({ title: "Apollo" })
        → obsidian_get_backlinks({ title: "Apollo" })
        "You shipped the v0.3 spec, opened 3 open questions in [[Apollo/Open Threads]],
        and 2 daily notes link back to it. Top blocker: the auth review."
```

> Named after [**ENQUIRE**](https://en.wikipedia.org/wiki/ENQUIRE) — the program Tim Berners-Lee wrote at CERN in 1980 to track «the complex web of relationships between people, programs, machines and ideas». ENQUIRE was the direct prototype of the World Wide Web. enquire-mcp brings the same idea to your AI: hyperlinked notes, structured access, zero plugins.

---

## Why enquire exists (vs other Obsidian-MCP options)

There are several Obsidian-MCP servers out there. enquire differentiates on three axes — **standalone**, **read-rich**, and **safe-by-default**:

| Capability (✅ = good for you) | Most Obsidian-MCPs | enquire |
|---|:---:|:---:|
| Works with `.md` files | ✅ | ✅ |
| **Standalone** — runs without Obsidian's Local REST API plugin | ❌ usually requires it | ✅ direct vault read |
| Resolves `[[Wikilink]]` with alias, section, block, `../` relative | partial | ✅ full |
| Surfaces `![[Embed]]` separately from links | ❌ | ✅ |
| Finds every note linking to X (**backlinks**) | rare | ✅ ranked + snippets |
| Finds every **broken `[[wikilink]]`** in the vault | ❌ | ✅ vault-hygiene tool |
| Lists **outbound links** for one note with resolution status | ❌ | ✅ |
| Built-in **Dataview-style queries** (`LIST` / `TABLE`, `AND`/`OR`, `LIKE`) | only via Obsidian plugin | ✅ first-class |
| **MCP resources** for browsing the vault as a tree | ❌ | ✅ |
| **MCP prompts** (`summarize_recent_edits`, `weekly_review`, `monthly_review`, `find_orphans`, `extract_todos`, `process_inbox`, `review_tag`, `consolidate_tags`, `find_duplicates`, `lint_wiki`) | ❌ | ✅ 10 prompts |
| **Read-only by default** (write tools require explicit flag) | ❌ usually write-default | ✅ `--enable-write` |
| Symlink-escape safety, realpath-checked reads & writes | rare | ✅ |
| Persistent on-disk cache for warm cold-starts | ❌ | ✅ `--persistent-cache` |
| **Per-folder privacy filter** (`--exclude-glob '02_Personal/**'`) | ❌ | ✅ |
| **Periodic-note aliases** (`title: "today"` resolves to today's daily-note) | rare | ✅ |
| **`Did you mean: ...`** suggestions on note-not-found errors | rare | ✅ |
| **Document-map projection** (`format: "map"`: headings + counts, no body) | ❌ | ✅ |
| **Anti-slop write validator** (`obsidian_validate_note_proposal` lints YAML + wikilinks + tags before write) | ❌ | ✅ |
| **Graph-aware retrieval** (`find_similar` + `get_note_neighbors` — multi-signal lexical hybrid, no embeddings) | ❌ | ✅ |
| **Vault dashboard** (`obsidian_stats`: orphans, broken links, top tags) | ❌ | ✅ |
| **Rename + auto-backlink rewrite** (`obsidian_rename_note` — atomic, code-fence-aware, dry-run preview) | ❌ usually breaks links | ✅ |
| **Live watcher mode** (`--watch` — incremental cache + FTS5 reindex on file changes) | ❌ usually requires restart | ✅ |
| **Karpathy LLM-Wiki `/lint` workflow** (`obsidian_lint_wiki` + `lint_wiki` prompt — orphans, broken links, stubs, stale, concept candidates) | ❌ | ✅ reference impl |
| **Multi-hop graph path-finding** (`obsidian_find_path` — BFS shortest path between two notes over the wikilink graph, with alternatives) | ❌ | ✅ |
| **Strict path allowlist** (`--read-paths '01_Projects/**'` — only paths matching one of these globs are visible; complement to `--exclude-glob` denylist) | ❌ | ✅ |
| TypeScript strict + Biome lint + 246 unit tests | varies | ✅ |

That's the gap. enquire closes it in ~3000 lines of TypeScript with five mandatory runtime dependencies (`@modelcontextprotocol/sdk`, `chokidar`, `commander`, `gray-matter`, `zod`) plus one optional (`better-sqlite3`, only loaded when `--persistent-index` is passed).

> **Not affiliated with Obsidian.md.** Obsidian and the Obsidian logo are trademarks of Dynalist Inc. enquire-mcp is an independent open-source project that reads Obsidian-format vaults. The name «enquire» is a tribute to Tim Berners-Lee's 1980 hypertext system, not a trademark claim against any party.

---

## Who is this for?

- **Obsidian users on Claude Code / Cursor / OpenClaw / Codex** (or Devin or any other MCP-compatible client) who want the assistant to draft notes that actually link properly, follow `[[…]]`, and respect frontmatter.
- **Agentic workflow builders** who need a structured layer over a markdown vault — `dataview_query`, `get_backlinks`, `list_tags` are the kind of primitives that compose into real automations.
- **Tinkerers** who want to wire their PKM into LLM pipelines without writing a parser. We did the parsing.

---

## Configure your AI client

**Recommended: zero-install via `npx` — no clone, no build.** Drop this into your MCP client's config:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["-y", "@oomkapwn/enquire-mcp", "serve", "--vault", "/Users/you/Documents/Obsidian Vault"]
    }
  }
}
```

**Where to drop that JSON, by client:**

| Client | Config file |
|---|---|
| **Claude Desktop** | macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`<br>Windows: `%APPDATA%\Claude\claude_desktop_config.json` |
| **Claude Code (CLI)** | `~/.claude.json` (global) or `.mcp.json` (per-project) |
| **Cursor** | `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per-project) |
| **OpenClaw** | per your OpenClaw shared-memory MCP config |
| **Codex / Codex CLI** | per-project `.mcp.json` or environment-specific config |
| **Devin / any other MCP client** | wherever your client expects MCP server JSON |

To enable write tools (`obsidian_create_note`, `obsidian_append_to_note`, `obsidian_rename_note`), add `"--enable-write"` to the `args` array.

<details>
<summary><b>Alternative: global npm install</b></summary>

```bash
npm install -g @oomkapwn/enquire-mcp
enquire-mcp serve --vault ~/Documents/Obsidian\ Vault
```

Then in your client config use `"command": "enquire-mcp"` instead of `"command": "npx"`.

</details>

<details>
<summary><b>Alternative: from source (development)</b></summary>

```bash
git clone https://github.com/oomkapwn/enquire-mcp
cd enquire-mcp && npm install && npm run build
```

Then `"command": "node"` with `"args": ["/absolute/path/to/dist/index.js", "serve", "--vault", "..."]`.

</details>

Restart your client. The server logs `enquire <version> ready (read-only, vault=…)` on stderr — that's your "it's connected" signal.

---

## What you get

### 19 read tools (always on) + 1 opt-in (`--persistent-index`)

| Tool | What it does |
|---|---|
| `obsidian_list_notes` | Filter by tag / folder / modified-since. Returns title, path, frontmatter, tags, mtime — newest first. |
| `obsidian_read_note` | Body + frontmatter + wikilinks + embeds + tags for a note (by path or title). `format: "map"` returns just headings + counts. |
| `obsidian_resolve_wikilink` | `[[Note]]`, `[[Note#Heading]]`, `[[Folder/Note\|alias]]`, `![[Embed]]`, `[[../relative/path]]` — all resolved to a real file. |
| `obsidian_search_text` | Ranked case-insensitive token search across all notes (AND-tokenizer by default; `any` and `phrase` modes available). Returns structured response: `query`, `mode`, `scanned_notes`, ranked `matches` with snippets. |
| `obsidian_get_recent_edits` | Newest-first stream, optional time window. |
| `obsidian_get_backlinks` | Every note linking the target, ranked by hit count, with snippets. Distinguishes wikilink vs embed vs mixed. |
| `obsidian_get_outbound_links` | Symmetric counterpart to backlinks — every link a note points to, with resolution status. |
| `obsidian_get_unresolved_wikilinks` | Vault-hygiene: every `[[broken]]` link in the vault. |
| `obsidian_list_tags` | Every unique tag with frontmatter / inline counts. |
| `obsidian_dataview_query` | `LIST` / `TABLE` with `FROM`, `WHERE`, `SORT`, `LIMIT`. Supports `AND` / `OR` / `=` / `!=` / `contains` / `like`. |
| `obsidian_validate_note_proposal` | **Anti-slop write linter.** Lint a draft note BEFORE writing — parses YAML, resolves every `[[wikilink]]` against the live vault, pre-classifies every tag (existing vs new), checks path/title collisions. Returns errors + warnings + per-link/tag diagnostics. Closes the #1 LLM-write pain ("AI generates structurally-broken notes"). |
| `obsidian_find_similar` | **Hybrid lexical similarity** — given a note, rank others by tag-Jaccard + title 3-gram + shared-outbound + co-backlink. Each signal returned individually so the caller can re-rank. No embeddings, no native deps. |
| `obsidian_get_note_neighbors` | **Graph context in one call** — outbound + backlinks + tag-cluster siblings for a note. Replaces 4 round-trips with 1. Designed for "give the LLM enough context to reason about THIS note" RAG. |
| `obsidian_stats` | **Vault dashboard** — total notes, total bytes, recently-modified count, orphans, broken wikilinks, top tags. One-shot orientation call. |
| `obsidian_lint_wiki` | **Karpathy LLM-Wiki lint workflow.** Five-bucket vault-hygiene report in one call: orphans, broken links, stub pages, stale notes, and concept candidates (capitalised phrases mentioned by ≥ K notes that lack their own page). Each finding ships with a fix suggestion. Pairs with the `lint_wiki` prompt. |
| `obsidian_open_questions` | Walks every note for `Open question:` / `Q:` / `TODO?` / `??` markers. Returns each hit with source path, context heading, line, and age — sorted oldest-first so deferred threads aging out surface first. |
| `obsidian_paper_audit` | For every `#paper` note, verifies frontmatter has at least one of arxiv/doi/url/isbn. Flags notes whose body mentions an arxiv ID or DOI but doesn't carry it in frontmatter — common after quick-capture from a chat. Returns a `proposed_frontmatter_patch` the agent can apply. |
| `obsidian_find_path` | **Multi-hop graph traversal** — BFS from `from` to `to` over the wikilink graph, returns the shortest path up to `max_depth` hops with the wikilink text used at each step. `include_alternatives=true` returns up to 10 same-length paths so the agent can compare. Embeds (`![[…]]`) followed by default. |
| `obsidian_open_in_ui` | Returns an `obsidian://open?vault=<v>&file=<f>` URI for hand-off to the running Obsidian desktop app. No filesystem or network side effect — just URI emission. `new_pane=true` opens the note in a split. |
| `obsidian_full_text_search` | _Opt-in via `--persistent-index`._ BM25-ranked full-text search backed by SQLite FTS5 inverted index. Sub-100ms on multi-thousand-note vaults. Hyphenated tokens (`claude-telegram`) auto-quoted. Returns chunk-level hits with `«…»`-bracketed snippets. |

### 3 write tools (opt-in via `--enable-write`)

| Tool | What it does |
|---|---|
| `obsidian_create_note` | Create a note with optional frontmatter. Refuses to overwrite by default. |
| `obsidian_append_to_note` | Append a markdown block to an existing note. Configurable separator. |
| `obsidian_rename_note` | **Atomic rename + automatic backlink rewrite.** Renames a note AND rewrites every `[[wikilink]]` / `![[embed]]` in the rest of the vault that resolved to it — preserving alias/section/block + the user's bare-vs-path target convention. Code-fence-aware: wikilinks inside ``` / ~~~ blocks stay verbatim. `dry_run: true` previews the plan without touching disk. |

### MCP resources

- `obsidian://vault/info` — root, note count, write flag, byte/cache limits, server version.
- `obsidian://note/{path}` — every note as a first-class browsable resource. Compatible clients show your vault as a tree.

### MCP prompts

| Prompt | Args | What it scaffolds |
|---|---|---|
| `summarize_recent_edits` | `since_minutes?` | "What was I working on?" workflow. |
| `review_tag` | `tag` | Pull every note for a tag, surface open threads. |
| `find_orphans` | `folder?` | Notes with zero inbound links — archive candidates. |
| `weekly_review` | `folder?` | Last 7 days of edits, grouped by tag — shipped / open / stuck. |
| `monthly_review` | `folder?` | 30-day version: themes, what stalled, focus vs intent. |
| `extract_todos` | `folder?`, `tag?` | Every TODO / FIXME / QUESTION, grouped by note. |
| `process_inbox` | `folder` | Move / Merge / Promote / Archive proposals for an inbox folder. |
| `consolidate_tags` | `min_count?` | Surface near-duplicate tags (`#productivity` vs `#productive`) and propose canonical merges. Read-only. |
| `find_duplicates` | `folder?`, `min_score?` | Walk the vault for clusters of structurally-similar notes via `obsidian_find_similar`. Read-only — outputs merge proposals only. |
| `lint_wiki` | `folder?` | **Karpathy LLM-Wiki `/lint`** — orchestrates `obsidian_lint_wiki` + `obsidian_open_questions` + `obsidian_paper_audit`, picks the 5 highest-leverage fixes across all three reports, proposes concrete `obsidian_*` calls. Read-only — proposes only. |

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

With `--enable-write`: `obsidian_append_to_note({ title: "2026-05-03", content: "- shipped a thing" })`

---

## Architecture

```
┌─────────────────┐     stdio JSON-RPC     ┌─────────────────────┐
│  Claude Code /  │ ◄────────────────────► │   enquire           │
│  Cursor /       │   tools/resources/     │  (this server)      │
│  OpenClaw /     │                        │                     │
│  Codex          │                        │                     │
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

### Benchmarks

Latency per tool against synthetic vaults at 1 000 / 10 000 notes (post-1.3 with the basename-indexed `findBestMatch` shipped in v1.3.0). p50 / p99 in milliseconds, 5 runs after warmup. Bench script: [`scripts/bench.mjs`](./scripts/bench.mjs). Full results in [`bench/results.md`](./bench/results.md).

| Tool | 1 000 notes | 10 000 notes |
|---|---|---|
| `list_notes` (no filter) | 21 / 22 | 104 / 105 |
| `search_text` (linear scan) | 30 / 33 | 536 / 542 |
| `get_recent_edits` | 11 / 12 | 100 / 102 |
| `list_tags` | 44 / 45 | 1 037 / 1 076 |
| `get_backlinks` | 54 / 55 | 1 145 / 1 154 |
| `find_similar` | 45 / 49 | 1 065 / 1 120 |
| `get_note_neighbors` | 76 / 81 | 2 002 / 2 279 |
| `vault_stats` | 45 / 45 | 1 058 / 1 319 |
| `validate_note_proposal` | 79 / 80 | 1 353 / 1 459 |

Read this as: most tools are sub-100ms below 1 000 notes. **For vaults above ~1 000 notes, `--persistent-index` is strongly recommended** — `obsidian_full_text_search` runs sub-100ms on 10k vaults via FTS5 BM25 (37–103× faster than the linear `search_text` on the same data, measured separately in [`scripts/bench-search.mjs`](./scripts/bench-search.mjs)).

The graph-aware tools (`find_similar`, `get_note_neighbors`, `vault_stats`) walk the link graph in pure-JS at O(N · avg_outbound), now backed by a basename-indexed lookup that brought 10k-note latencies from 2–4 s down to 1–2 s — about 30–45 % faster across the board. The remaining cost is parse-cache warmup; the second-and-later calls in a session ride the in-memory cache.

---

## Configuration

| Flag | Default | What it does |
|---|---|---|
| `--vault <path>` | (required) | Path to the Obsidian vault root. |
| `--enable-write` | off | Register the three write tools. Server is otherwise strictly read-only. |
| `--max-file-bytes <n>` | 5 MB | Refuse to read or write any file larger. |
| `--cache-size <n>` | 1024 | LRU cap for the parsed-note cache. |
| `--persistent-cache` | off | Persist parsed-note cache to disk; warm cold-starts on large vaults. **Privacy: full note bodies are written to the cache file. See "Cache & privacy" below.** |
| `--cache-file <path>` | auto | Override persistent-cache file location. |
| `--watch` | off | Watch the vault for `.md` file edits. On change: invalidate the parsed-note cache for that file; if `--persistent-index` is also set, incrementally re-sync that file's FTS5 chunks. Editor saves are debounced. Use this for long-running servers where you keep editing in Obsidian. |
| `--read-paths <pattern...>` | none | **Strict allowlist.** When set, ONLY paths matching one of these glob patterns are visible to any tool. Complement to `--exclude-glob` (denylist). If both are set: a path must match an allow-glob AND not match any exclude-glob. Same glob semantics (`*`, `**`, `?`). Repeatable. Example: `--read-paths '01_Projects/**' '99_Daily/**'`. |

### Cache & privacy

When `--persistent-cache` is on, parsed notes are serialized to disk so subsequent server restarts skip re-parsing. By default the file lives at `~/Library/Caches/enquire/<sha1>.json` on macOS, `~/.cache/enquire/<sha1>.json` on Linux. Important caveats:

- **Full note bodies are stored**, not just metadata. Anyone who can read your home cache directory can read your vault.
- **File mode is `0600`** (user-read/write only) and the parent directory is `0700`. We don't trust shared home directories.
- **Deleted notes are purged** on the next server start: when enquire sees a cached entry whose source file no longer exists, it drops the entry from memory and rewrites the cache file without it on shutdown.
- **Stale entries** (file mtime changed since cache write) are silently dropped on load; the source file is re-parsed.
- **Manual purge:** run `enquire-mcp clear-cache --vault <path>` to delete the cache file for a specific vault.
- The cache file is **never read or written for vaults other than the one whose realpath matches the cache file's `root` field** — protects against cross-vault content leaks if you share a cache dir.

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
Not unless you start it with `--enable-write`. By default the server is strictly read-only. With write enabled, the three write tools refuse to overwrite existing notes by default (`obsidian_create_note` and `obsidian_rename_note` both require `overwrite=true` to clobber) and refuse to write outside the vault even if a parent dir is symlinked away.

**Does it work over the network?**
No. It's a local stdio MCP server, designed for one client process per vault. There's no HTTP transport, no auth, no rate limiting — and that's intentional.

**My DQL query returned nothing.**
Verify the source. `LIST FROM "01_Projects"` matches notes whose path starts with `01_Projects/`. `LIST FROM #idea` matches notes carrying the `idea` tag. Mix them with `WHERE`. See [docs/api.md](./docs/api.md) for the supported subset and grammar.

**What about the full Dataview plugin?**
We implement a deliberately small subset (`LIST` / `TABLE`, `FROM "folder" | #tag`, `WHERE pred (AND|OR pred)*`, `SORT`, `LIMIT`; ops `=`, `!=`, `contains`, `like`). No arithmetic / functions / `FLATTEN` / `GROUP BY` / joins / parenthesized precedence. PRs that close those gaps are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md).

**How big a vault can it handle?**
Tested daily against a ~120-note vault; benched up to 1000 synthetic notes (see [`scripts/bench-search.mjs`](./scripts/bench-search.mjs)). The walker is O(notes) per call; the in-memory cache makes repeat reads O(1). For multi-thousand-note vaults pass `--persistent-index` — the SQLite FTS5 backend gives sub-millisecond BM25 search (37–103x faster than the linear-scan path on 100–1000 notes).

**Why scoped npm name (`@oomkapwn/enquire-mcp`)?**
A scoped name protects the brand and side-steps the very crowded `obsidian-mcp` / `mcp-obsidian` namespace on npm. The CLI binary is `enquire-mcp` to match the npm package name.

---

## Develop

```bash
npm test              # full suite (count in the badge)
npm run test:coverage # vitest --coverage (v8 provider)
npm run lint          # biome check
npm run lint:fix      # biome check --write (auto-fixes)
npm run dev           # tsc --watch
node scripts/smoke.mjs [vault-path]   # end-to-end JSON-RPC smoke
```

Coverage on the latest release: **82% lines · 78% statements · 73% branches**. CI uploads the full HTML report as a workflow artifact (`coverage-report`).

Build runs `tsc` and marks `dist/index.js` executable. CI tests Node 20 / 22 / 24, runs the smoke against a synthetic vault, generates a coverage report, and runs `npm audit --audit-level=high`.

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

- **1.6.x** — **Multi-hop graph traversal** (`obsidian_find_path` BFS) + **`obsidian_open_in_ui`** (obsidian:// URI hand-off) + **strict allowlist** (`--read-paths` complement to `--exclude-glob`).
- **1.5.x** — **Karpathy LLM-Wiki `/lint` workflow** — `obsidian_lint_wiki` (orphans/broken/stubs/stale/concept candidates) + `obsidian_open_questions` + `obsidian_paper_audit` + `lint_wiki` prompt.
- **1.4.x** — Three new MCP prompts (`consolidate_tags`, `find_duplicates`, `monthly_review`) bringing the total to 9.
- **1.3.x** — **Performance + benchmarks.** `findBestMatch` rebuilt around a basename + relPath index (O(N²) → O(1) avg) — 24–46% faster across graph-aware tools at 10k notes. New `scripts/bench.mjs` + reproducible numbers in `bench/results.md`.
- **1.2.0** — **Watcher mode** (`--watch`) — incremental cache + FTS5 reindex on file changes. Editor saves debounced. `--exclude-glob` honored.
- **1.1.x** — `obsidian_rename_note` (atomic rename + automatic backlink rewrite, code-fence-aware, dry-run preview).
- **1.0.0** — **Stable. API freeze.** Stability promise across tool names, argument shapes, resource URIs, prompt names, CLI flags. SLSA-3 release provenance.
- **0.13.x** — Graph-aware retrieval: `obsidian_find_similar` (multi-signal lexical hybrid), `obsidian_get_note_neighbors` (1-hop graph context in one call), `obsidian_stats` (vault dashboard).
- **0.12.x** — Anti-slop write validator (`obsidian_validate_note_proposal`) — lints YAML + wikilinks + tags before write.
- **0.11.x** — Privacy filter (`--exclude-glob`), periodic-note aliases (`title: "today"`), `Did you mean: …` suggestions, document-map projection (`format: "map"`). *(0.11.0 tag preserved for history; npm publish failed on a runner-availability incident — features rolled into 0.12.0.)*
- **0.10.x** — SQLite FTS5 inverted index (opt-in via `--persistent-index`), BM25 ranking, sub-millisecond search on multi-thousand-note vaults (37–103x faster than the linear scan path), chunk-level addressing via `obsidian://chunk/{n}/{path}` resource. Filter API on full-text search (`tag`, `since`, `folder`).
- **0.9.x** — `search_text` switched to AND-tokenizer default with structured response (BREAKING). Parallel file reads in scan path.
- **0.8.x** — DQL `contains` semantics for arrays (membership, not substring). Code of Conduct.
- **0.7.x** — Renamed `obsidian-mcp` → `enquire-mcp` (via brief `memex` detour) to escape the crowded `obsidian-mcp` npm namespace and to land on a name with a clear historical referent — Tim Berners-Lee's 1980 ENQUIRE prototype of the Web.
- **Roadmap (1.x)** — Embedding-based retrieval (sqlite-vec + a small JS-runnable model, layered on top of the existing lexical hybrid).

---

## Contributing

Bug fixes welcome. New tools should pass the bar of "useful against an Obsidian vault on day 1." See [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Support the project

If enquire-mcp saves you keystrokes or makes your AI assistant smarter about your vault, **consider [starring the repo](https://github.com/oomkapwn/enquire-mcp) to show your ❤️ and support.** Stars help other Obsidian users find the project, and they tell us where to invest the next cycle.

Other ways to help:
- 🐛 **File a bug** — the more concrete the repro (vault shape, exact tool call, server stderr), the faster the fix. Use [the bug template](https://github.com/oomkapwn/enquire-mcp/issues/new?template=bug_report.yml).
- 💡 **Propose a feature** — open a [feature request](https://github.com/oomkapwn/enquire-mcp/issues/new?template=feature_request.yml) and we'll align on scope before any code is written.
- 🔧 **Send a PR** — bug fixes always welcome. New tools should pass the «useful against an Obsidian vault on day 1» bar. See [CONTRIBUTING.md](./CONTRIBUTING.md).
- 💬 **Tell us how you use it** — open a thread in [Discussions](https://github.com/oomkapwn/enquire-mcp/discussions) and we'll figure out what to build next from real workflows.

---

## License & credits

[MIT](./LICENSE). Built by Alex — [GitHub `@oomkapwn`](https://github.com/oomkapwn) · [X `@OomkaBear`](https://x.com/OomkaBear). Powered by [Model Context Protocol](https://modelcontextprotocol.io/), [`gray-matter`](https://github.com/jonschlinkert/gray-matter), [`commander`](https://github.com/tj/commander.js), and the patience of one specific Obsidian vault that didn't deserve to be parsed by hand.

Named after [ENQUIRE](https://en.wikipedia.org/wiki/ENQUIRE) — the program Tim Berners-Lee wrote at CERN in 1980 to track «the complex web of relationships between people, programs, machines and ideas». ENQUIRE was the direct prototype of the World Wide Web. enquire-mcp brings the same idea to your AI: hyperlinked notes, structured access, no plugin required.
