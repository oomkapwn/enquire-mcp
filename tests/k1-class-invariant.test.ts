// v3.6.3 K-1 class invariant — methodological guard.
//
// Background. v3.6.1 fixed ONE callsite of the destructive-bootstrap-schema
// class and claimed "CRIT-1 closed" — overclaim; 9 callsites remained.
// v3.6.2 fixed 3 more callsites and claimed "all 10 callsites" — still an
// overclaim; cli.ts had 5 residual sites. v3.6.3 closes the residual AND
// adds this test as a class-level guard so the overclaim pattern can't
// repeat: every `new EmbedDb(...)` / `new FtsIndex(...)` in src/ must be
// preceded by either a `peek*Meta` call OR an explicit `// SAFE BY DESIGN`
// comment within 20 lines of context.
//
// This is a grep-based invariant — not perfect (e.g. doesn't follow control
// flow), but catches the specific class of bug v3.6.1 → v3.6.2 → v3.6.3
// chased: constructing the SQLite wrapper without first peeking at the
// on-disk meta. Test files are exempt (they're explicitly setting up
// known-good state).

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_DIRS = ["src", "src/tools"];
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

async function collectTsFiles(dir: string): Promise<string[]> {
  const here = path.resolve(process.cwd(), dir);
  const entries = await fs.readdir(here, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".d.ts"))
    .map((e) => path.join(here, e.name));
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

describe("K-1 class invariant (v3.6.3 methodological guard)", () => {
  it("every `new EmbedDb` / `new FtsIndex` in src/ is preceded by peek* or // SAFE BY DESIGN", async () => {
    const files: string[] = [];
    for (const dir of SRC_DIRS) {
      files.push(...(await collectTsFiles(dir)));
    }
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
    const files: string[] = [];
    for (const dir of SRC_DIRS) {
      files.push(...(await collectTsFiles(dir)));
    }
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
});
