// v3.6.4 K-1 class invariant — methodological guard.
// (v3.7.2 audit response: file header originally said "v3.6.3" — that
//  was the 4th instance of the version-attribution drift class, since
//  v3.6.3 was the marketing-only patch and K-1 actually closed in v3.6.4.
//  Strengthened to v3.7.0 with the AST def-use trace sibling test.)
//
// META-INVARIANT-EXEMPT: K-1 class invariant is structurally enforced at
// 5 levels (grep / AST / caller-pattern / fixture-based / version-stamp).
// NEGATIVE control coverage lives in sibling files:
//   - tests/k1-ast-invariant.test.ts (2 NEGATIVE blocks)
//   - tests/k1-version-stamp-consistency.test.ts (1 NEGATIVE block via scanK1Stamps fixture)
//   - tests/peek-meta.test.ts (4+ caller-pattern NEGATIVE controls)
// Adding a NEGATIVE control inline here would duplicate sibling coverage
// without adding signal. This exempt marker is required by the rc.16
// META-invariant (tests/meta-invariant-coverage.test.ts).
//
// Background. v3.6.1 fixed ONE callsite of the destructive-bootstrap-schema
// class and claimed "CRIT-1 closed" — overclaim; 9 callsites remained.
// v3.6.2 fixed 3 more callsites and claimed "all 10 callsites" — still an
// overclaim; cli.ts had 5 residual sites. v3.6.3 shipped marketing-only;
// v3.6.4 closes the residual AND adds this test as a class-level guard so
// the overclaim pattern can't repeat: every `new EmbedDb(...)` /
// `new FtsIndex(...)` in src/ must be preceded by either a `peek*Meta`
// call OR an explicit `// SAFE BY DESIGN` comment within 40 lines of
// context (raised from 20 in v3.6.4 to accommodate biome-reformatted
// multi-line write calls).
//
// This is a grep-based invariant — not perfect (e.g. doesn't follow control
// flow), but catches the specific class of bug v3.6.1 → v3.6.2 → v3.6.3
// chased: constructing the SQLite wrapper without first peeking at the
// on-disk meta. Test files are exempt (they're explicitly setting up
// known-good state).

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// v3.7.0 M-3: scan ALL of src/ recursively (was hardcoded ["src", "src/tools"]
// in v3.6.4). When new sub-directories are added (e.g. src/managers/), they
// auto-fall under invariant coverage instead of silently slipping past.
const SRC_ROOT = "src";
const CONSTRUCTOR_PATTERNS = [/\bnew EmbedDb\s*\(/g, /\bnew FtsIndex\s*\(/g];
const PEEK_MARKERS = ["peekEmbedDbMeta", "peekFtsMetaSafe"];
const SAFE_MARKER = "SAFE BY DESIGN";
// Context window — must accommodate biome-reformatted multi-line write
// calls that push peek further from the constructor. 40 lines is enough for
// the longest current callsite (cli.ts:608 peek → cli.ts:644 EmbedDb, ~36
// lines) without being so wide that unrelated peeks earlier in the file
// false-positive a guard.
const CONTEXT_LINES = 40;

interface ConstructorSite {
  file: string;
  line: number;
  text: string;
}

/**
 * v3.7.0 M-3 — recursive .ts file walker for `src/`.
 *
 * Pre-v3.7.0 the invariant scanned only `["src", "src/tools"]` (hardcoded).
 * Any new sub-directory under `src/` would silently fall outside invariant
 * scope. Now: walks the entire `src/` tree, skipping nothing.
 *
 * Excludes `.d.ts` files (declaration only — no runtime constructor calls)
 * and directories named `node_modules` or starting with `.` (paranoia for
 * unexpected nested package layouts).
 */
async function collectTsFiles(dir: string): Promise<string[]> {
  const here = path.resolve(process.cwd(), dir);
  const out: string[] = [];
  const stack: string[] = [here];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) continue;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      continue; // Missing dir — skip gracefully.
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        stack.push(path.join(cur, e.name));
        continue;
      }
      if (!e.isFile()) continue;
      if (!e.name.endsWith(".ts") || e.name.endsWith(".d.ts")) continue;
      out.push(path.join(cur, e.name));
    }
  }
  return out;
}

/**
 * Returns the set of line indices (0-based) that are INSIDE a JSDoc/TSDoc
 * `/** ... *‍/` block. Matches inside doc-comment `@example` code blocks are
 * documentation, not real call sites, and must not trigger the invariant.
 *
 * The opener regex anchors `/**` to the start of the trimmed line (typical
 * JSDoc convention) so `/**` substrings inside string literals (e.g. glob
 * patterns like `Projects/**` in help text) don't get false-detected as
 * doc-block openings.
 */
function jsdocLineSet(text: string): Set<number> {
  const lines = text.split(/\r?\n/);
  const inDoc = new Set<number>();
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Open: `/**` at line start (after optional whitespace), and NOT
    // immediately closed on same line.
    if (/^\s*\/\*\*(?!.*\*\/)/.test(line)) depth++;
    if (depth > 0) inDoc.add(i);
    // Close: ` */` at line start or after `* ` (JSDoc continuation).
    // Anchored to defend against `*/` appearing inside string literals.
    if (depth > 0 && /^\s*\*?\/?\s*\*\//.test(line)) depth = Math.max(0, depth - 1);
  }
  return inDoc;
}

async function findConstructorSites(file: string): Promise<ConstructorSite[]> {
  const text = await fs.readFile(file, "utf8");
  const lines = text.split(/\r?\n/);
  const docLines = jsdocLineSet(text);
  const hits: ConstructorSite[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (docLines.has(i)) continue; // skip JSDoc @example bodies
    const line = lines[i] ?? "";
    for (const pattern of CONSTRUCTOR_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        hits.push({ file, line: i + 1, text: line });
      }
    }
  }
  return hits;
}

function hasGuard(text: string, site: ConstructorSite): "peek" | "safe" | null {
  const lines = text.split(/\r?\n/);
  const start = Math.max(0, site.line - 1 - CONTEXT_LINES);
  const end = Math.min(lines.length, site.line - 1 + 2); // include the construct line itself + 1 next
  const window = lines.slice(start, end).join("\n");
  if (PEEK_MARKERS.some((m) => window.includes(m))) return "peek";
  if (window.includes(SAFE_MARKER)) return "safe";
  return null;
}

describe("K-1 class invariant (v3.6.3 methodological guard; recursive scan since v3.7.0 M-3)", () => {
  it("every `new EmbedDb` / `new FtsIndex` in src/ is preceded by peek* or // SAFE BY DESIGN", async () => {
    const files = await collectTsFiles(SRC_ROOT);
    const unguarded: string[] = [];
    for (const file of files) {
      const sites = await findConstructorSites(file);
      if (sites.length === 0) continue;
      const text = await fs.readFile(file, "utf8");
      for (const site of sites) {
        const guard = hasGuard(text, site);
        if (!guard) {
          unguarded.push(
            `${path.relative(process.cwd(), site.file)}:${site.line}\n    ${site.text.trim()}\n    (no peek*Meta or SAFE BY DESIGN comment within ${CONTEXT_LINES} lines above)`
          );
        }
      }
    }
    if (unguarded.length > 0) {
      const detail = unguarded.join("\n\n");
      expect.fail(
        `K-1 class invariant violated. The following EmbedDb/FtsIndex constructions have no peek-guard:\n\n${detail}\n\nFix: add a \`peekEmbedDbMeta(file)\` or \`peekFtsMetaSafe(file)\` call before the constructor, OR add a \`// SAFE BY DESIGN: <reason>\` comment if the constructor demonstrably does not trigger bootstrapSchema (e.g. .clearOnDisk-only path).`
      );
    }
  });

  it("at least 6 EmbedDb/FtsIndex sites are tracked (sanity — invariant has scope)", async () => {
    const files = await collectTsFiles(SRC_ROOT);
    let total = 0;
    for (const file of files) {
      total += (await findConstructorSites(file)).length;
    }
    // As of v3.6.3 we have ≥ 11 sites across src/ + src/tools/. Lower bound
    // catches accidental file deletion that would silently shrink invariant
    // coverage. Adjust upward when adding new sites; never downward without
    // documenting the architectural removal in CHANGELOG.
    expect(total).toBeGreaterThanOrEqual(6);
  });

  // v3.7.0 M-3 — guards the recursive walker itself. If someone replaces
  // `collectTsFiles` with a non-recursive version, this catches the
  // regression by asserting that files in a known sub-directory (src/tools/)
  // appear in the collected set.
  it("recursive walker actually reaches src/tools/ (regression guard for M-3 fix)", async () => {
    const files = await collectTsFiles(SRC_ROOT);
    const hasToolsFile = files.some((f) => f.includes(`${path.sep}src${path.sep}tools${path.sep}`));
    expect(hasToolsFile, "recursive walker should pick up src/tools/*.ts").toBe(true);
  });
});
