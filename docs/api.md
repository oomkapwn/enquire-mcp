# obsidian-mcp — API (v0.2)

Seven MCP tools, all read-only. The server speaks stdio JSON-RPC and is launched per-vault.

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

## `obsidian_dataview_query`

Run a minimal Dataview-style query. Phase-2 minimal — designed to cover the common shape, not to replicate the Obsidian Dataview plugin.

| Argument | Type     | Notes                              |
|----------|----------|------------------------------------|
| `query`  | `string` | The DQL string. See grammar below. |

### Grammar (subset)

```
QUERY  ::= ("LIST" | "TABLE" COLUMNS) ("FROM" SOURCE)? WHERE? SORT? LIMIT?
COLUMNS ::= IDENT ("," IDENT)*
SOURCE  ::= "\"" PATH "\""    -- folder
          | "#" TAG           -- tag
WHERE   ::= "WHERE" PRED ("AND" PRED)*
PRED    ::= IDENT OP VALUE
OP      ::= "=" | "!=" | "contains"
VALUE   ::= "\"" STRING "\"" | NUMBER | "true" | "false" | "null" | BARE
SORT    ::= "SORT" IDENT ("ASC" | "DESC")?
LIMIT   ::= "LIMIT" INTEGER
```

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

### Not supported (Phase 2 minimal)

- Expressions / arithmetic / function calls (`length(...)`, `regexmatch(...)`, etc.)
- `OR` between predicates (only `AND` is supported)
- `FLATTEN`, `GROUP BY`, joins, embedded queries
- `SOURCE` combinations beyond a single folder or single tag

## Path safety

Every path argument is resolved relative to the vault root and rejected if it escapes the root via `..`. The server never reads outside the vault.

## Skipped directories

The walker ignores `.git`, `.obsidian`, `.trash`, `node_modules`, and any other dot-directory.

## Phase 3 (planned)

- Persistent cross-vault index (Phase 2 cache is in-memory only)
- Full DQL: expressions, OR, FLATTEN, GROUP BY
- Vault write tools (create/update note, with confirmation)
- Graph queries (multi-hop link traversal)
