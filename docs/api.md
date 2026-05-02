# obsidian-mcp — API (Phase 1)

Five MCP tools, all read-only. The server speaks stdio JSON-RPC and is launched per-vault.

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

**Returns:** `{ path, title, content, frontmatter, wikilinks, tags, mtime }`. `content` is the body with frontmatter stripped.

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

## Path safety

Every path argument is resolved relative to the vault root and rejected if it escapes the root via `..`. The server never reads outside the vault.

## Skipped directories

The walker ignores `.git`, `.obsidian`, `.trash`, `node_modules`, and any other dot-directory.

## Phase 2 (planned)

- `obsidian_dataview_query` — basic LIST / TABLE DQL
- Backlink graph
- Embed (`![[…]]`) resolution
- Mtime-indexed cache for vaults with > 10k notes
