# enquire — API

**enquire is an MCP server for Obsidian vaults.** 13 MCP tools (10 always-on read + 1 opt-in read via `--persistent-index` + 2 opt-in write via `--enable-write`), 2 + 1 opt-in MCP resources, 6 MCP prompts. The server speaks stdio JSON-RPC and is launched per-vault.

> Versioned dynamically — see [`CHANGELOG.md`](../CHANGELOG.md) for the current release.

## CLI flags

| Flag                   | Default | Notes                                      |
|------------------------|---------|--------------------------------------------|
| `--vault <path>`       | (required) | Path to the Obsidian vault root.        |
| `--enable-write`       | off     | Register the two write tools.              |
| `--max-file-bytes <n>` | 5 MB    | Max size for any single file read/write.   |
| `--cache-size <n>`     | 1024    | LRU cap for parsed-note cache.             |
| `--persistent-cache`   | off     | Persist parsed-note cache to disk so cold starts skip re-parsing. **Stores full note bodies — see [Cache & privacy](../README.md#cache--privacy).** |
| `--cache-file <path>`  | auto    | Override the persistent-cache file location. Default: `~/Library/Caches/enquire/<vault-hash>.json` (macOS) or `~/.cache/enquire/<vault-hash>.json` (Linux). |
| `--persistent-index`   | off     | Maintain a SQLite FTS5 inverted index for sub-100ms BM25-ranked search. Registers `obsidian_full_text_search` + the `obsidian://chunk/{n}/{path}` resource. **Stores chunked note content + tag list + wikilink targets — see [SECURITY.md "Persistent FTS5 index"](../SECURITY.md#persistent-fts5-index-privacy-posture).** |
| `--tokenize <mode>`    | `unicode61` | FTS5 tokenize mode. `unicode61` (default; Latin/Cyrillic, removes diacritics) or `trigram` (CJK / mixed-script, ~2x index size). Changing this triggers an automatic index rebuild. |
| `--index-file <path>`  | auto    | Override the FTS5 index file location. Default: `~/Library/Caches/enquire/<vault-hash>.fts5.db` (macOS) or `~/.cache/enquire/<vault-hash>.fts5.db` (Linux). |
| `--exclude-glob <pattern...>` | none | Repeatable glob pattern(s) — paths matching any pattern are invisible to every tool and refuse direct reads. Privacy filter. Supports `*` (within-segment), `**` (cross-segment), `?` (single char). Example: `--exclude-glob '02_Personal/**' '*.private.md'`. |

## Subcommands

| Subcommand | Args | What it does |
|---|---|---|
| `serve` (default) | see flags above | Start the MCP server over stdio. |
| `clear-cache` | `--vault <path>` `[--cache-file <path>]` | Delete the persistent-cache file for the given vault. Useful for purging stale or sensitive content. Returns 0 even if no cache file exists. |
| `clear-index` | `--vault <path>` `[--index-file <path>]` | Delete the FTS5 search-index files (`.fts5.db` + WAL/SHM sidecar) for the given vault. Privacy purge for `--persistent-index` users. Returns 0 even if no files exist. |
| `index` | `--vault <path>` `[--tokenize <mode>]` `[--index-file <path>]` | Cold-build (or refresh) the FTS5 search index for a vault. Useful before first `--persistent-index serve`. Reports `added`/`updated`/`deleted`/`unchanged` chunk counts. |

## Read tools (always registered)

## `obsidian_list_notes`

List markdown notes in the vault. Filter by tag, folder, or modification date.

| Argument     | Type                  | Notes                                              |
|--------------|-----------------------|----------------------------------------------------|
| `tag`        | `string?`             | With or without leading `#`. Case-insensitive.     |
| `folder`     | `string?`             | Subfolder relative to vault root.                  |
| `since_date` | `string?`             | ISO 8601 (`YYYY-MM-DD`). mtime ≥ this date.        |
| `limit`      | `number?` (≤ 500)     | Default 50.                                        |

**Returns:** `Array<{ title, path, frontmatter, tags, mtime }>`, newest-first.

## `obsidian_read_note`

Read a single note. Provide either `path` or `title`.

| Argument | Type      | Notes                                                  |
|----------|-----------|--------------------------------------------------------|
| `path`   | `string?` | Vault-relative path, with or without `.md`.            |
| `title`  | `string?` | Filename without extension. Case-insensitive lookup.   |

**Returns:** `{ path, title, content, frontmatter, wikilinks, embeds, tags, mtime }`. `content` is the body with frontmatter stripped. `wikilinks` and `embeds` share the same shape (`{ raw, target, section?, block?, alias? }`) and are surfaced separately.

## `obsidian_resolve_wikilink`

Resolve an Obsidian `[[wikilink]]` to a vault file. Handles aliases (`Note|alias`), section refs (`Note#Heading`), block refs (`Note^abc`), and relative paths (`../Folder/Note`) when `from_note` is supplied.

| Argument          | Type       | Notes                                                    |
|-------------------|------------|----------------------------------------------------------|
| `wikilink`        | `string`   | The target inside `[[ ]]` (brackets optional).           |
| `from_note`       | `string?`  | Calling note path. Used to disambiguate same-name files and to anchor relative paths. |
| `include_content` | `boolean?` | Default `true`. Set `false` to skip reading the target.  |

**Returns:** `{ found, path, title, content, section, block, alias }`. `found=false` when no match.

## `obsidian_search_text`

Case-insensitive token search across the vault. Default mode tokenizes the query on whitespace and requires every token to appear (AND); other modes available.

| Argument | Type                              | Notes                                                     |
|----------|-----------------------------------|-----------------------------------------------------------|
| `query`  | `string`                          | Required. At least one non-space char.                    |
| `folder` | `string?`                         | Restrict to a subfolder.                                  |
| `limit`  | `number?` (≤ 200)                 | Default 25.                                               |
| `mode`   | `"all" \| "any" \| "phrase"`     | Default `"all"`. `"any"` = OR. `"phrase"` = pre-v0.9 contiguous-substring match. |

**Returns:**

```ts
{
  query: string;        // echoed back
  mode: "all" | "any" | "phrase";
  scanned_notes: number; // how many notes were searched
  matches: Array<{
    path: string;
    snippet: string;     // ~120 chars around first hit
    score: number;       // total token-hit count
    line: number;        // 1-based line of first hit
    matched_terms: string[]; // which tokens actually hit
  }>;
}
```

`scanned_notes` lets the caller distinguish "0 matches in 245 notes" (real null result) from "search did nothing" (broken setup).

## `obsidian_get_recent_edits`

List notes by modification time, newest-first. Useful for "what was I working on?" queries.

| Argument        | Type              | Notes                                         |
|-----------------|-------------------|-----------------------------------------------|
| `since_minutes` | `number?`         | Only include notes edited within this window. |
| `folder`        | `string?`         | Restrict to a subfolder.                      |
| `limit`         | `number?` (≤ 200) | Default 20.                                   |

**Returns:** `Array<{ title, path, frontmatter, tags, mtime }>`.

## `obsidian_get_backlinks`

List every note that links (or embeds) the target note. Ranked by hit count.

| Argument         | Type       | Notes                                                       |
|------------------|------------|-------------------------------------------------------------|
| `path`           | `string?`  | Target note path, vault-relative.                           |
| `title`          | `string?`  | Target note title (filename without `.md`).                 |
| `include_embeds` | `boolean?` | Default `true`. Set `false` to ignore `![[…]]` references.  |
| `limit`          | `number?`  | Max results (default 50, ≤ 500).                            |

**Returns:** `Array<{ path, title, count, snippets, link_kind }>`. `link_kind` is `"wikilink"`, `"embed"`, or `"mixed"`. `snippets` are up to two ~120-char excerpts around the literal `[[…]]` / `![[…]]`.

## `obsidian_list_tags`

Enumerate every unique tag used in the vault with usage counts.

| Argument    | Type      | Notes                                      |
|-------------|-----------|--------------------------------------------|
| `folder`    | `string?` | Restrict to a subfolder.                   |
| `min_count` | `number?` | Drop tags used fewer than this (default 1).|
| `limit`     | `number?` | Max results (default 200, ≤ 2000).         |

**Returns:** `Array<{ tag, count, frontmatter_count, inline_count }>`, sorted by `count` desc.

> **Counting rules.** Each note contributes at most `+1` to a tag's `count` even if the tag appears in both the note's frontmatter and inline body. The note is credited to `frontmatter_count` if the tag was found in frontmatter, otherwise to `inline_count`. So `frontmatter_count + inline_count == count` for every tag.

## `obsidian_get_unresolved_wikilinks`

Find every `[[wikilink]]` (and `![[embed]]`) in the vault whose target does not resolve to a real file. Vault-hygiene utility — broken links, typos, intended-but-not-yet-created notes.

| Argument         | Type       | Notes                                                       |
|------------------|------------|-------------------------------------------------------------|
| `folder`         | `string?`  | Restrict the scan to a subfolder.                           |
| `include_embeds` | `boolean?` | Include `![[…]]` embeds (default `true`).                   |
| `limit`          | `number?`  | Max results (default 200, ≤ 2000).                          |

**Returns:** `Array<{ from_path, target, raw, kind, alias, section, block, line, snippet }>`. `kind` is `"wikilink"` or `"embed"`. `snippet` is a ~120-char window around the literal `[[…]]` / `![[…]]`.

## `obsidian_get_outbound_links`

Symmetric counterpart to `obsidian_get_backlinks`. For one note, list every outbound link (wikilink or embed) and its resolution status.

| Argument             | Type       | Notes                                                        |
|----------------------|------------|--------------------------------------------------------------|
| `path`               | `string?`  | Source note path; provide either this or `title`.            |
| `title`              | `string?`  | Source note title (filename without `.md`).                  |
| `include_embeds`     | `boolean?` | Include `![[…]]` embeds (default `true`).                    |
| `include_unresolved` | `boolean?` | Include links that don't resolve (default `true`).           |

**Returns:** `{ from_path, from_title, links: Array<{ raw, target, kind, alias, section, block, resolved_path, resolved_title }> }`. `resolved_path` and `resolved_title` are `null` when the link doesn't resolve.

## `obsidian_dataview_query`

Run a minimal Dataview-style query. Phase-2 minimal — designed to cover the common shape, not to replicate the Obsidian Dataview plugin.

| Argument | Type     | Notes                              |
|----------|----------|------------------------------------|
| `query`  | `string` | The DQL string. See grammar below. |

### Grammar (subset)

```
QUERY    ::= ("LIST" | "TABLE" COLUMNS) ("FROM" SOURCE)? WHERE? SORT? LIMIT?
COLUMNS  ::= IDENT ("," IDENT)*
SOURCE   ::= "\"" PATH "\""    -- folder
           | "#" TAG           -- tag
WHERE    ::= "WHERE" CONJ ("OR" CONJ)*
CONJ     ::= PRED ("AND" PRED)*
PRED     ::= IDENT OP VALUE
OP       ::= "=" | "!=" | "contains" | "like"
VALUE    ::= "\"" STRING "\"" | NUMBER | "true" | "false" | "null" | BARE
SORT     ::= "SORT" IDENT ("ASC" | "DESC")?
LIMIT    ::= "LIMIT" INTEGER
```

`OR` has lower precedence than `AND` — `WHERE a = 1 AND b = 2 OR c = 3` parses as `(a = 1 AND b = 2) OR (c = 3)`. Use parentheses-style alternatives in the future once we add them; for now you can express any DNF directly.

`like` is a SQL-LIKE-style wildcard match (case-insensitive). `*` matches any run of characters; `\*` is a literal asterisk. Examples: `file.name like "draft*"`, `status like "in*progress"`.

### Special fields

| Field         | Meaning                                       |
|---------------|-----------------------------------------------|
| `file.name`   | Filename without `.md`.                       |
| `file.path`   | Vault-relative path.                          |
| `file.mtime`  | ISO 8601 modification timestamp.              |
| `file.tags`   | Combined frontmatter + inline tags (array).   |
| any other     | Reads the matching frontmatter field.         |

`contains` on an array field tests membership; on a string field, substring match (case-insensitive).

**Returns:** `{ query, rows: Array<Record<string, unknown>> }`. Every row always carries `file.path`, `file.name`, `file.mtime`. `TABLE` rows additionally carry the requested columns.

### Examples

```
LIST FROM "01_Projects"
LIST FROM #idea WHERE status = "active"
TABLE status, priority FROM "01_Projects" WHERE done = false SORT priority ASC LIMIT 10
LIST FROM #people WHERE file.tags contains "core-team"
```

### Not supported (yet)

- Expressions / arithmetic / function calls (`length(...)`, `regexmatch(...)`, etc.)
- `FLATTEN`, `GROUP BY`, joins, embedded queries
- `SOURCE` combinations beyond a single folder or single tag (no `FROM "a" OR #b`)
- Parentheses for explicit precedence in `WHERE`

### Row caps

If the query has no explicit `LIMIT`, results are capped at **1000 rows** by default to prevent runaway responses on large vaults. Use `LIMIT n` (any positive integer) to override.

## Write tools (opt-in)

Both write tools are **only registered when the server is started with `--enable-write`**. Without that flag the tools are not advertised to the client at all.

### `obsidian_create_note`

Create a new note at the given vault-relative path.

| Argument      | Type       | Notes                                                         |
|---------------|------------|---------------------------------------------------------------|
| `path`        | `string`   | Vault-relative path; `.md` is appended if missing.            |
| `content`     | `string`   | Markdown body (frontmatter is supplied separately).           |
| `frontmatter` | `object?`  | Flat key/value YAML to render. Arrays render as block lists.  |
| `overwrite`   | `boolean?` | Default `false`. Existing notes are not clobbered without it. |

**Returns:** `{ path, mtime, bytes }`. Throws if the path escapes the vault, the file would exceed `--max-file-bytes`, or the file exists and `overwrite=false`.

### `obsidian_append_to_note`

Append a markdown block to an existing note.

| Argument    | Type       | Notes                                                       |
|-------------|------------|-------------------------------------------------------------|
| `path`      | `string?`  | Path of the target note. Provide either this or `title`.    |
| `title`     | `string?`  | Title (filename without `.md`).                             |
| `content`   | `string`   | Markdown to append.                                         |
| `separator` | `string?`  | Inserted between existing body and new content (default `"\n\n"`). |

**Returns:** `{ path, mtime, appended_bytes }`. Refuses to grow the file past `--max-file-bytes`.

## MCP resources

| URI                          | Type           | Description                                |
|------------------------------|----------------|--------------------------------------------|
| `obsidian://vault/info`      | static JSON    | Root, note count, write flag, byte/cache limits, server version. |
| `obsidian://note/{notePath}` | template (md)  | Each markdown note. `notePath` is the URI-encoded vault-relative path. |

The note template implements `list`, so MCP clients with a resource browser will see the full vault enumerated on connect.

## MCP prompts

| Prompt                  | Args                       | What it sets up                                |
|-------------------------|----------------------------|-----------------------------------------------|
| `summarize_recent_edits`| `since_minutes?`           | Walks recent edits, reads top-3, produces a writeup. |
| `review_tag`            | `tag`                      | Pulls every note for a tag, surfaces open threads. |
| `find_orphans`          | `folder?`                  | Finds notes with zero inbound links — archive candidates. |
| `weekly_review`         | `folder?`                  | Aggregates the last 7 days of edits; groups by tag; surfaces shipped / open / stuck. |
| `extract_todos`         | `folder?`, `tag?`          | Greps TODO / FIXME / QUESTION across the vault, groups by note, picks a top-leverage next action. |
| `process_inbox`         | `folder` (required)        | Walks an inbox folder, proposes Move / Merge / Promote / Archive for each note. |

## Path safety

Every path argument is resolved relative to the vault root and rejected if it escapes the root via `..`. The server never reads outside the vault.

## `obsidian_full_text_search` _(opt-in, requires `--persistent-index`)_

BM25-ranked full-text search over a SQLite FTS5 inverted index. Sub-100ms on multi-thousand-note vaults. Only registered when the server is started with `--persistent-index`; otherwise use `obsidian_search_text`.

| Argument | Type                              | Notes                                                     |
|----------|-----------------------------------|-----------------------------------------------------------|
| `query`  | `string`                          | Required. Whitespace-tokenized; hyphenated tokens (e.g. `claude-telegram`) auto-quoted so FTS5 doesn't interpret `-` as `NOT`. |
| `folder` | `string?`                         | Restrict to a subfolder (vault-relative).                  |
| `tag`    | `string?`                         | Exact tag membership (e.g. `"project"`). Frontmatter + inline tags. No leading `#`. |
| `since`  | `string?`                         | ISO 8601 date or timestamp — restrict to chunks from notes modified on/after this. |
| `limit`  | `number?` (≤ 200)                 | Default 25.                                                |

**Returns:**

```ts
{
  query: string;
  total_chunks: number;
  total_files: number;
  applied_filters: { folder: string|null; tag: string|null; since: string|null };
  matches: Array<{
    rel_path: string;
    chunk_index: number;     // 0-based; address via obsidian://chunk/<index>/<path>
    line_start: number;      // 1-based
    line_end: number;
    snippet: string;         // «…term…» format from FTS5 snippet()
    score: number;           // BM25 relevance, higher = better
  }>;
}
```

**Implementation note:** see [issue #10](https://github.com/oomkapwn/enquire-mcp/issues/10) for the full architecture (production-verified by an external contributor at 1771 chunks / 368 files, 9.8 MB index, 50–100ms BM25 top-10). Local bench against synthetic vault sees 37–103x speedup over the linear-scan path on 100–1000 notes — see [`scripts/bench-search.mjs`](../scripts/bench-search.mjs).

## `obsidian://chunk/{chunkIndex}/{+notePath}` resource _(opt-in, requires `--persistent-index`)_

Chunk-level deep-linking. Construct the URI from `rel_path` + `chunk_index` returned by `obsidian_full_text_search`:

```
obsidian://chunk/0/01_Projects/Apollo.md   → chunk 0 of 01_Projects/Apollo.md
obsidian://chunk/3/notes/long-note.md      → chunk 3 of notes/long-note.md
```

Returns `{rel_path, chunk_index, line_start, line_end, content}` JSON. **`content` is the verbatim original chunk text** — the synthetic FTS5 wikilink-target enrichment used for recall does NOT appear in the response.

## CLI subcommands for the FTS5 index

```bash
# Cold-build or refresh the index (useful before first --persistent-index serve).
enquire-mcp index --vault /path/to/vault [--tokenize unicode61|trigram] [--index-file <path>]

# Then serve with the index loaded.
enquire-mcp serve --vault /path/to/vault --persistent-index

# Remove the index files (.fts5.db + WAL/SHM sidecar) — privacy purge.
enquire-mcp clear-index --vault /path/to/vault [--index-file <path>]
```

The index file lives at `~/Library/Caches/enquire/<vault-hash>.fts5.db` (macOS) or `~/.cache/enquire/<vault-hash>.fts5.db` (Linux) by default. Override with `--index-file <path>`. DB + WAL + SHM files are chmod'd to `0600`; parent directory to `0700`. See [SECURITY.md "Persistent FTS5 index: privacy posture"](../SECURITY.md#persistent-fts5-index-privacy-posture) for full privacy details.

## Roadmap

### Shipped in 0.10
- ✅ SQLite FTS5 inverted index (`--persistent-index`).
- ✅ BM25 ranking, sub-millisecond warm queries on multi-thousand-note vaults.
- ✅ Filter API on `obsidian_full_text_search`: `tag`, `since`, `folder`.
- ✅ Chunk-level resource URI (`obsidian://chunk/{n}/{path}`).
- ✅ `--tokenize=unicode61|trigram` for CJK / mixed-script vaults.
- ✅ `clear-index` subcommand for privacy purge.

### Open
- Full DQL: expressions, `FLATTEN`, `GROUP BY`, parenthesized precedence.
- Higher-level write tools: rename/move with wikilink rewrites, tag refactor.
- Graph queries (multi-hop link traversal).
- Examples directory with the contributor's reference Python implementation (per [issue #10](https://github.com/oomkapwn/enquire-mcp/issues/10)).

## Skipped directories

The walker ignores `.git`, `.obsidian`, `.trash`, `node_modules`, and any other dot-directory.
