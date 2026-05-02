# obsidian-mcp — API (v0.3)

12 MCP tools (10 read + 2 opt-in write), 2 MCP resources, 6 MCP prompts. The server speaks stdio JSON-RPC and is launched per-vault.

## CLI flags

| Flag                   | Default | Notes                                      |
|------------------------|---------|--------------------------------------------|
| `--vault <path>`       | (required) | Path to the Obsidian vault root.        |
| `--enable-write`       | off     | Register the two write tools.              |
| `--max-file-bytes <n>` | 5 MB    | Max size for any single file read/write.   |
| `--cache-size <n>`     | 1024    | LRU cap for parsed-note cache.             |
| `--persistent-cache`   | off     | Persist parsed-note cache to disk so cold starts skip re-parsing. |
| `--cache-file <path>`  | auto    | Override the persistent-cache file location. Default: `~/Library/Caches/obsidian-mcp/<vault-hash>.json` (macOS) or `~/.cache/obsidian-mcp/<vault-hash>.json` (Linux). |

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

Case-insensitive substring search across the vault. Ranked by hit count.

| Argument | Type              | Notes                                  |
|----------|-------------------|----------------------------------------|
| `query`  | `string`          | Required. At least one non-space char. |
| `folder` | `string?`         | Restrict to a subfolder.               |
| `limit`  | `number?` (≤ 200) | Default 25.                            |

**Returns:** `Array<{ path, snippet, score, line }>`. `snippet` is ~120 chars around the first hit.

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

## Skipped directories

The walker ignores `.git`, `.obsidian`, `.trash`, `node_modules`, and any other dot-directory.

## Phase 3 (planned)

- Persistent cross-vault index (Phase 2 cache is in-memory only)
- Full DQL: expressions, OR, FLATTEN, GROUP BY
- Vault write tools (create/update note, with confirmation)
- Graph queries (multi-hop link traversal)
