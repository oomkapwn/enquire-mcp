// v3.10.0-rc.51 — CLI-FLAG-IN-DOCS + BODY-CAP-WORDING INVARIANT (class-D structural defense).
//
// Closes the "phantom CLI flag in docs" drift class (re-audit DOC-HNSW-PERSIST-PHANTOM-FLAG:
// docs/api.md described a `--hnsw-persist` flag that never existed — only `--no-hnsw-persist`
// does) + the "stale security number" class (DOC-SECURITY-HTTP-BODY-CAP-STALE: SECURITY.md
// claimed a fixed 4 MB HTTP body cap while the code DERIVES `max(4 MB, max-file-bytes × 1.5)`).
//
// OIA Check 3 validates SUBCOMMAND existence, not `--flag` tokens in prose; nothing pinned
// the body-cap wording to its formula. These two assertions do.

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

/** The real long flags: every commander `.option("--x ...")` in cli.ts + the two
 *  commander built-ins. */
function realFlags(): Set<string> {
  const cli = read("src/cli.ts");
  const flags = new Set<string>(["--help", "--version"]);
  for (const m of cli.matchAll(/"(--[a-z][a-z0-9-]*)/g)) flags.add(m[1] as string);
  return flags;
}

/** Pure detector — long-flag tokens in `docText` that are NOT real CLI flags.
 *  Exported shape lets the NEGATIVE control prove it isn't vacuous. */
function phantomFlags(docText: string, flags: Set<string>): string[] {
  const seen = new Set<string>();
  for (const m of docText.matchAll(/--[a-z][a-z0-9-]{2,}/g)) {
    const f = m[0];
    if (!flags.has(f)) seen.add(f);
  }
  return [...seen];
}

describe("cli-flag-in-docs invariant (rc.51)", () => {
  it("every `--flag` mentioned in docs/api.md is a real cli.ts .option() flag (POSITIVE — the class gate)", () => {
    const flags = realFlags();
    // sanity: the flag set actually loaded (guards against a regex/refactor that empties it)
    expect(flags.has("--no-hnsw-persist")).toBe(true);
    expect(flags.has("--use-hnsw")).toBe(true);
    const phantoms = phantomFlags(read("docs/api.md"), flags);
    expect(phantoms, `docs/api.md references non-existent CLI flags:\n${phantoms.join("\n")}`).toEqual([]);
  });

  it("detector flags a phantom flag + clears a real one (NEGATIVE control)", () => {
    const flags = realFlags();
    expect(phantomFlags("reload from sidecar if `--hnsw-persist`.", flags)).toEqual(["--hnsw-persist"]);
    expect(phantomFlags("opt out with `--no-hnsw-persist`.", flags)).toEqual([]);
  });

  it("SECURITY.md body-cap is documented as DERIVED, not a bare fixed cap (rc.51 DOC-SECURITY)", () => {
    // The code derives the cap (http-transport.ts deriveHttpBodyCap = max(4 MB, ×1.5)); the
    // docs must describe the derivation, not assert a stale fixed number.
    const sec = read("SECURITY.md");
    const line = sec.split("\n").find((l) => /Body bombs/.test(l)) ?? "";
    expect(line, "SECURITY.md body-bomb line must reference the --max-file-bytes derivation").toMatch(/max-file-bytes/);
    expect(line, "…and the 1.5× headroom factor").toMatch(/1\.5/);
  });
});
