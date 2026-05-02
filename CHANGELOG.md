# Changelog

All notable changes to this project will be documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-05-02

### Added
- `obsidian_get_backlinks` — list every note that wikilinks (or embeds) the target. Returns ranked hits with snippets and link kind (`wikilink` / `embed` / `mixed`). `include_embeds` flag, default `true`.
- `obsidian_dataview_query` — basic Dataview-style queries: `LIST` / `TABLE col1, col2 FROM ("folder" | #tag) [WHERE field op value [AND …]] [SORT field [ASC|DESC]] [LIMIT n]`. Operators: `=`, `!=`, `contains`. Special fields: `file.name`, `file.path`, `file.mtime`, `file.tags`. Other identifiers read frontmatter.
- Parser now extracts `![[…]]` embeds separately from `[[…]]` wikilinks; both surface in `obsidian_read_note` output.
- Vault gets an mtime-keyed parse cache — repeat reads of an unchanged note are now O(1).
- GitHub Actions CI on Node 18 / 20 / 22.

### Changed
- `obsidian_resolve_wikilink` now also accepts the `![[Embed]]` syntax in its input.
- Read paths route through the new cache, removing redundant `readFile` + `parseNote` work in tools that scan the whole vault.

### Notes
- Dataview implementation is intentionally minimal — no expressions, function calls, joins, or `FLATTEN`. It covers the common LIST/TABLE-with-WHERE shape and explicitly degrades for anything fancier.

## [0.1.0] — 2026-05-02

### Added
- Initial Phase 1 release.
- Five MCP tools: `obsidian_list_notes`, `obsidian_read_note`, `obsidian_resolve_wikilink`, `obsidian_search_text`, `obsidian_get_recent_edits`.
- Stdio transport via `@modelcontextprotocol/sdk` 1.29.
- Wikilink resolver covers aliases (`Note|alias`), section refs (`Note#Heading`), block refs (`Note^id`), and `..` relative paths.
- Path-traversal guards on every read; walker skips `.git`, `.obsidian`, `.trash`, `node_modules`, and dot-dirs.
- 33 unit tests + JSON-RPC smoke test against a real 117-note vault.
