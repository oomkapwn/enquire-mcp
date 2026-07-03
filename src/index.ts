#!/usr/bin/env node
// Slim entry point for enquire-mcp. The current `VERSION` constant below
// is the authoritative version (see `scripts/check-version-consistency.mjs`).
//
// History: v3.6.0-rc.2 split the previous 3665-line monolith into the
// domain modules listed below. v3.7.x continued the consolidation. The
// file-header comment used to read as if rc.2 was current — round-19
// audit (v3.7.17) caught this as the "tombstone vs current-claim"
// stale-comment class. Now reads as historical context (clearer.)
//
// Domain modules:
//   - cli.ts            : `main()` + commander program definition (CLI parsing).
//   - server.ts         : ServeOptions / ServerDeps / prepareServerDeps / buildMcpServer /
//                         startServer / formatReadyBanner / buildEmbedText / sync* fns.
//   - tool-registry.ts  : registerReadTools / registerWriteTools / registerFtsTools /
//                         registerResources / registerChunkResource + utility helpers
//                         (textResult, encodeNotePath, decodeNotePath, parsePositiveInt,
//                          parseQuantizationMode, embedDbPath).
//   - prompts.ts        : registerPrompts — the 19 MCP prompt definitions.
//   - tool-manifest.ts  : machine-readable manifest of every MCP tool
//                         (name + kind + gating + summary). Single source of truth for
//                         docs-consistency invariants and future doc auto-generation.
//
// This file keeps the `VERSION` constant + the CLI-entry guard + a small
// re-export surface so:
//   - `scripts/check-version-consistency.mjs` + `scripts/sync-version.mjs`
//     can grep this file for the canonical version-constant declaration.
//   - `src/http-transport.ts` and external consumers can keep importing from
//     `./index.js` (no API break — same symbols, same shapes).
//   - `tests/cli.test.ts` keeps importing `parsePositiveInt`, `parseQuantizationMode`
//     and `tests/late-chunking.test.ts` keeps importing `buildEmbedText`.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { main } from "./cli.js";

/**
 * The current package version. Kept here as the single source of truth so
 * `scripts/check-version-consistency.mjs` + `scripts/sync-version.mjs` can
 * grep this exact file (their regex matches the literal declaration line
 * below). Also re-exported for `src/server.ts` (used in `formatReadyBanner`
 * + `McpServer({version})`) and `src/tool-registry.ts` (used in the
 * `vault-info` resource payload).
 */
export const VERSION = "3.11.6-rc.2";

// Re-exports — preserve the v3.5.x public surface so http-transport.ts and
// tests don't need to know about the new module layout. The set below
// exactly matches the v3.5.x `export` declarations: `main`,
// `parsePositiveInt`, `parseQuantizationMode`, `startServer` (named-exported
// at bottom-of-file), plus the named-on-declaration `buildMcpServer`,
// `buildEmbedText`, `formatReadyBanner`, `prepareServerDeps`, and the
// interface types `ServeOptions` / `ServerDeps`. The sync* helpers live in
// `./server.js` for `cli.ts`'s use only — they were file-private in v3.5.x.
export { main } from "./cli.js";
export {
  buildEmbedText,
  buildMcpServer,
  formatReadyBanner,
  prepareServerDeps,
  type ServeOptions,
  type ServerDeps,
  startServer
} from "./server.js";
export { parsePositiveInt, parseQuantizationMode } from "./tool-registry.js";

// CLI-entry guard — exactly the same shape as v3.5.x so the
// realpath-comparison test (tests/cli.test.ts → "CLI entry-point guard")
// keeps passing. Resolves the import.meta.url and process.argv[1] paths
// through realpathSync so the symlink shim (`node_modules/.bin/enquire-mcp`)
// and the /tmp → /private/tmp macOS quirk both match.
const isCliEntry = (() => {
  if (!process.argv[1]) return false;
  try {
    // Both sides via realpath — npm installs the binary as a symlink in
    // `node_modules/.bin/`, and on macOS `/tmp` is itself a symlink to
    // `/private/tmp`. Without realpath on argv[1], the comparison fails and
    // main() never runs (silent exit 0). Regression test in tests/cli.test.ts.
    const meta = realpathSync(fileURLToPath(import.meta.url));
    const argv = realpathSync(process.argv[1]);
    return meta === argv;
  } catch {
    return false;
  }
})();

if (isCliEntry) {
  main().catch((err: unknown) => {
    process.stderr.write(`enquire fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}
