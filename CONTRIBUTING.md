# Contributing to enquire-mcp

Thanks for your interest. enquire-mcp is a small, opinionated MCP server for Obsidian vaults — the bar for new features is "does it pull weight against an Obsidian vault on day 1." The bar for fixes is much lower.

## Getting started

```bash
git clone https://github.com/oomkapwn/enquire-mcp
cd enquire-mcp
npm install
npm run build
npm test
```

Smoke-test the built server against a real vault:

```bash
node scripts/smoke.mjs ~/Documents/MyVault
```

## What we accept

- **Bug fixes** — always welcome. Include a regression test under `tests/`.
- **New tools** — open an issue first to align on scope. We optimize for *fewer* tools that compose well over many tools that overlap.
- **Performance** — patches that reduce vault-walk time, file reads, or memory use are great. Show before/after numbers on a real-shaped vault (≥ 500 notes).
- **DQL improvements** — see `docs/api.md` for the documented "Not supported" list. PRs that close those gaps are welcome but should land with thorough test coverage.

## What we don't accept

- Lockstep cross-cutting refactors (e.g. swapping the tool registration pattern). Open an issue first.
- New runtime dependencies unless the case is overwhelming. We currently ship **5 mandatory** and **6 optional** (each opt-in via a CLI flag and lazy-loaded — markdown-only path stays zero-cost):

  **Mandatory:** `@modelcontextprotocol/sdk`, `chokidar`, `commander`, `js-yaml`, `zod`.

  **Optional (feature-gated):**
  - `better-sqlite3` — required by `--persistent-index` (FTS5) and `build-embeddings` (embed-db).
  - `@huggingface/transformers` — required by ML embeddings + cross-encoder reranker (`build-embeddings`, `--enable-reranker`).
  - `pdfjs-dist` — required by PDF tools (`obsidian_read_pdf`, `--include-pdfs`).
  - `tesseract.js` — required by `obsidian_ocr_pdf` for scanned/image-only PDFs.
  - `hnswlib-node` — required by `--use-hnsw` (sub-10ms top-K vector search).
  - `@napi-rs/canvas` — used by Tesseract OCR + social-preview render script.

  Adding a new **mandatory** dep is a high-bar PR (tickets the markdown-only happy path with size + audit-surface costs). Adding a new **optional** dep is OK if it's gated behind a flag and the failure mode on missing-dep is a clean error message pointing at the flag.
- Code that lowers the security floor (skipping path safety, removing size limits, etc.).
- Markdown / YAML rendering that aims to round-trip every Obsidian quirk. If a write tool can't faithfully preserve some user input, the right move is to refuse the write, not best-effort it.

## Style

- TypeScript strict mode, ESM only.
- No comments unless the *why* is non-obvious.
- Conventional commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`.
- Tests live in `tests/<module>.test.ts`. Use `vitest` patterns; avoid network or external fixtures.

## Reporting bugs

Include:

1. The vault structure (anonymized is fine — `01_Notes/`, `99_Daily/`, etc.).
2. The MCP client and version (Claude Code, Cursor, custom).
3. The tool call you made and the actual vs expected output.
4. Anything from the server's stderr.

If a path-handling or symlink edge case is involved, please be precise about how the symlink was created (Finder, `ln -s`, syncthing, iCloud Drive, etc.) — those shape the realpath chain.

## Releases

Maintainer-only:

```bash
# Verify
npm run build && npm test && node scripts/smoke.mjs ~/Documents/MyVault

# Bump
# (edit package.json + src/index.ts VERSION constant + CHANGELOG.md
#  + regenerate package-lock.json via `npm install --package-lock-only`)
node scripts/check-version-consistency.mjs

# Tag and push (CI publishes to npm with provenance)
git commit -am "release: vX.Y.Z" && git push origin main
git tag vX.Y.Z && git push origin vX.Y.Z
```

The push of a `v*` tag triggers `.github/workflows/release.yml`, which runs
lint + build + test then `npm publish --provenance`. Manual `npm publish`
is no longer needed; `prepublishOnly` is still a local backstop.

Since v3.7.14, the GitHub Release is auto-created by the same workflow —
notes are extracted from the matching `## [X.Y.Z]` section in CHANGELOG.md,
prereleases (rc / alpha / beta) get the `--prerelease` flag, stable
versions land as Latest. No manual `gh release create` needed.
