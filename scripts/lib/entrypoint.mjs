// Canonical "is this module the CLI entrypoint?" guard for scripts/*.mjs.
//
// v3.11.6-rc.21 (rc.20 audit re-sweep F2) — realpath BOTH sides so the guard
// survives:
//   • a checkout path with a SPACE — `%20` in import.meta.url vs literal in
//     process.argv[1] (the rc.20 L-1 bug), and
//   • a SYMLINKED invocation path — e.g. macOS `/tmp` → `/private/tmp`, or a
//     symlinked repo checkout — where `path.resolve` leaves the two spellings
//     different and the guard silently skips (the F2 latent recursion of L-1).
//
// This mirrors src/index.ts's `isEntrypoint`. A silent skip in an AUDIT-GATE
// script (check-audit, scope-completeness-audit) is a false-green security gate,
// so every script routes through this ONE realpath-correct implementation
// instead of hand-rolling a `path.resolve` compare.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * @param {string} importMetaUrl the caller's `import.meta.url`
 * @returns {boolean} true iff this module was invoked directly as the CLI entry
 */
export function isEntrypoint(importMetaUrl) {
  try {
    if (!process.argv[1]) return false;
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}
