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
- New runtime dependencies unless the case is overwhelming. We currently ship four (`@modelcontextprotocol/sdk`, `commander`, `gray-matter`, `zod`).
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
# (edit package.json + CHANGELOG.md)

# Tag and publish
git tag v0.X.Y && git push --tags
npm publish
```

The `prepublishOnly` hook runs `build` + `test` again as a backstop.
