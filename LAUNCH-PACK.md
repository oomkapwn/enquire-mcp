# LAUNCH-PACK — Obsidian MCP Connector

**Started:** 2026-05-02
**Owner:** Alex (@OomkaBear / oomkapwn)
**Card:** [[../../Obsidian Vault/99_Ilon/pipeline/cards/obsidian-mcp-2026-05-02|карточка]]
**Phase 1 deadline:** 2 weeks ship — minimal MCP server reading any Obsidian vault

## What this is

MCP server that lets Claude Code / Cursor / Devin read any Obsidian vault. Markdown traversal + frontmatter parsing + wikilink resolution + dataview-query support.

**Self-eat dogfood:** Alex uses this in his vault `~/Documents/Obsidian Vault/` first.
**OSS launch:** MIT licensed, GitHub trending target. Pairs с #79 Anthropic 3-vector launch wave.

## Why this exists (gap analysis)

**Existing tools:**
- ❌ No MCP for Obsidian publicly (verified 2026-05-02)
- ✅ Plugins like Obsidian-MCP exist but are private/half-shipped
- ✅ Generic file-system MCP exists, но не understands wikilinks/frontmatter/dataview

**Differentiation:**
1. **Wikilink resolution** — Claude follows `[[Note Name]]` to actual file
2. **Frontmatter parsing** — typed YAML metadata access
3. **Dataview query support** — execute basic dataview queries via API
4. **Tag-based filtering** — list notes by `#tag/sub`
5. **Recent-edits stream** — newest changes first для work-in-progress queries

## Phase 1 — minimal MVP (2 weeks)

### Week 1 — Core
- Day 1-2: MCP scaffold (TypeScript SDK), basic file-list + read-note tools
- Day 3-4: Frontmatter YAML parser + tag indexing
- Day 5-7: Wikilink resolver + tests on Alex's vault

### Week 2 — Distribution
- Day 8-9: README + 3 example workflows ("scan tagged ideas", "follow wikilinks", "find recent edits")
- Day 10: GitHub repo + npm publish + README badges
- Day 11: HN Show + Twitter launch (paired с tweet drafts in vault)
- Day 12-14: Iterate per feedback

## Tech stack

- **Language:** TypeScript (MCP SDK is TS-first)
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **Markdown parser:** `unified` + `remark-frontmatter` + `remark-wiki-link`
- **YAML:** `js-yaml`
- **CLI:** `commander`
- **Tests:** `vitest`

## API spec (planned MCP tools)

```typescript
// Tools exposed by server:
1. obsidian_list_notes({tag?, folder?, since_date?, limit?}) → [{title, path, frontmatter}]
2. obsidian_read_note({path | title}) → {content, frontmatter, wikilinks, tags}
3. obsidian_resolve_wikilink({wikilink, from_note?}) → {found, path, content?}
4. obsidian_search_text({query, folder?, limit?}) → [{path, snippet, score}]
5. obsidian_get_recent_edits({since_minutes?, limit?}) → [{path, mtime, frontmatter}]
6. obsidian_dataview_query({query}) → [...rows] (basic LIST/TABLE only — Phase 2 full DQL)
```

## Distribution channels

1. **GitHub Trending** — TypeScript / MCP categories
2. **HN Show** — "MCP server для Obsidian — let Claude Code read your vault"
3. **Twitter** — paired thread, dogfood proof ("how Claude Code drives my vault @OomkaBear")
4. **r/ObsidianMD** — community announcement + setup guide
5. **Anthropic MCP catalog** — submit к их official directory

## Success metrics

- **Week 2 ship:** 1.0.0 published, basic API working
- **Week 4:** 100+ GitHub stars
- **Week 8:** First customer signal — either OSS contributor PR OR explicit "I'm using this" tweet
- **Week 12:** Sustained dev community (5+ contributors OR 500+ stars OR named user reference)

## Capital

- $0-50 — domain optional, npm free, GitHub free
- Time: ~30-50 hours over 2 weeks (Alex или separate Claude Code session)

## Communication

- **Daily progress:** append to bottom of LAUNCH-PACK.md
- **Block:** open `## BLOCKED:` section
- **Question:** open `## QUESTION:` section
- **Commits:** conventional (`feat:`, `fix:`, `docs:`, `chore:`)

## Daily progress log

### Day 0 (2026-05-02) — pre-handoff scaffold

- ✅ Project dir created at `~/Documents/Projects/obsidian-mcp/`
- ✅ Git initialized (branch `main`)
- ✅ Folder structure: src/ tests/ docs/
- ✅ LAUNCH-PACK.md (this file)
- ⏳ **Awaiting:** Alex starts отдельная Claude Code session OR self-execute via this session

### Day 1 (2026-05-02) — Phase 1 MVP shipped

- ✅ TypeScript + `@modelcontextprotocol/sdk` 1.29 scaffold (`type: module`, ES2022, Node16 resolution)
- ✅ Vault walker with path-traversal guards, skips `.git`/`.obsidian`/dot-dirs
- ✅ Frontmatter parser via `gray-matter`; wikilink + tag extractors with code-fence stripping
- ✅ 5 tools implemented: `list_notes`, `read_note`, `resolve_wikilink`, `search_text`, `get_recent_edits`
- ✅ Wikilink resolver handles aliases / section refs / block refs / `..` relative paths
- ✅ 34 unit tests (parser + tools, all passing)
- ✅ `scripts/smoke.mjs` — JSON-RPC handshake against real vault, 9 checks all green
- ✅ Dogfooded on `~/Documents/Obsidian Vault/` (117 notes, 0 errors)
- ✅ README + `docs/api.md` updated with Phase 1 tool spec

**Next (Week 2):**
- [ ] npm publish prep (`prepublishOnly`, package.json polish, README badges)
- [ ] HN Show + Twitter launch (paired with vault tweet drafts)
- [ ] Phase 2 scoping — dataview, backlinks, embed resolution
