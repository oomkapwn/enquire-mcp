// v3.11.5-rc.2 (post-rc.1 re-sweep) — the WRITE-FENCE-TOGGLE-INLINE-SPAN class.
//
// rc.1 fixed the MED in write.ts (a line-leading self-contained inline `` ```span``` ``
// was mistaken for a block-fence open, silently dropping rename_note/replace_in_notes
// edits) but left two read-path siblings live:
//   - read.ts extractHeadings → readNote(format:"map") dropped EVERY heading after such a line
//   - fts5.ts computeBreadcrumbsByLine → froze the heading breadcrumb for every following line
// All three now route through the shared `src/fence.ts` `opensBlockFence`. This file pins:
//   1. the read-path behavior (both siblings) with real-block-fence NEGATIVE controls, and
//   2. an INVENTORY INVARIANT — any `inFence` line-walker in src/ must use `opensBlockFence`,
//      so a future walker cannot drift back to a naive `/^\s*(```|~~~)/` toggle.
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeBreadcrumbsByLine } from "../src/fts5.js";
import { readNote } from "../src/tools/read.js";
import { Vault } from "../src/vault.js";

const repoRoot = path.resolve(__dirname, "..");

describe("read.ts extractHeadings — inline span at line start does not drop headings (v3.11.5-rc.2)", () => {
  let dir: string;
  let vault: Vault;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "fence-toggle-"));
    vault = new Vault(dir, {});
    await vault.ensureExists();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("POSITIVE — headings AFTER a line-leading closed inline span are still extracted", async () => {
    await fs.writeFile(path.join(dir, "n.md"), "```inline``` at line start\n\n## Real Heading\n\ntext\n\n### Sub\n");
    const r = await readNote(vault, { path: "n.md", format: "map" });
    expect((r.headings ?? []).map((h) => h.text)).toEqual(["Real Heading", "Sub"]); // was [] pre-rc.2
  });

  it("NEGATIVE control — a REAL multi-line block fence still shields the heading inside it", async () => {
    await fs.writeFile(path.join(dir, "m.md"), "## Before\n```\n## Inside Fence\n```\n## After\n");
    const r = await readNote(vault, { path: "m.md", format: "map" });
    expect((r.headings ?? []).map((h) => h.text)).toEqual(["Before", "After"]);
  });

  it("v3.11.5-rc.5 — a `~~~` inside a ``` block does not un-shield the code (char-aware toggle)", async () => {
    // Pre-rc.5 the char-blind toggle treated the `~~~` as closing the ``` block, so
    // "## FakeInside" (still inside) was extracted and "## RealAfter" was dropped.
    await fs.writeFile(path.join(dir, "x.md"), "```\ncode\n~~~\n## FakeInside\nmore\n```\n## RealAfter\n");
    const r = await readNote(vault, { path: "x.md", format: "map" });
    expect((r.headings ?? []).map((h) => h.text)).toEqual(["RealAfter"]);
  });
});

describe("fts5.ts computeBreadcrumbsByLine — inline span does not freeze the breadcrumb (v3.11.5-rc.2)", () => {
  it("POSITIVE — a heading after a line-leading inline span still updates the breadcrumb", () => {
    const crumbs = computeBreadcrumbsByLine("```inline``` at line start\n# Top\nbody line\n");
    // The body line lives under "Top" — pre-rc.2 the inline span opened a phantom fence so
    // "# Top" was treated as fenced content and the breadcrumb stayed empty.
    expect(crumbs[2]).toBe("Top");
  });

  it("NEGATIVE control — a heading inside a REAL fence does NOT update the breadcrumb", () => {
    const crumbs = computeBreadcrumbsByLine("# Top\n```\n# Fenced\n```\nafter\n");
    // "# Fenced" is inside the fence → the "after" line's breadcrumb stays "Top", not "Fenced".
    expect(crumbs[4]).toBe("Top");
  });

  it("v3.11.5-rc.4 — an INDENTED code fence (≤3 spaces, CommonMark) is detected too", () => {
    // Pre-rc.4 the fenceMatch was `/^(```|~~~)/` (anchored at column 0), so an indented
    // fence was NOT detected and "# Fenced" leaked into the breadcrumb (was "Fenced").
    const crumbs = computeBreadcrumbsByLine("# Top\n   ```\n# Fenced\n   ```\nafter\n");
    expect(crumbs[4]).toBe("Top"); // was "Fenced" pre-rc.4
  });

  it("v3.11.5-rc.5 — a `~~~` line inside a ``` block is literal code, not a fence close", () => {
    // Pre-rc.5 the char-BLIND `inFence = !inFence` flipped the state on the ~~~ line, so
    // "# FakeInside" (still inside the ``` block) leaked into the breadcrumb.
    const crumbs = computeBreadcrumbsByLine("# Top\n```\n~~~\n# FakeInside\n```\nafter\n");
    expect(crumbs[5]).toBe("Top"); // was "FakeInside" pre-rc.5
  });
});

/** Strip `//` line + `/* *​/` block comments so a comment MENTIONING the old idiom is not flagged. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * v3.11.5-rc.5 (meta-audit) — the char-BLIND fence toggle `inFence = !inFence` cannot tell a
 * ``` delimiter from a `~~~`, so a mismatched inner fence flips the state (the bug the meta-audit
 * found live in write.ts/read.ts/meta.ts). Every per-line fence state machine must use the
 * char-aware `advanceFence` (src/fence.ts). Returns files whose LIVE code toggles a fence-named
 * state variable via either forbidden idiom:
 *   (a) negation      — `inFence = !inFence`
 *   (b) ternary self-toggle — `fenceMarker = fenceMarker ? … : …`  (v3.11.6-rc.1)
 * The pre-promotion re-sweep noted the rc.5 detector matched only (a), so a ternary blind toggle
 * on a fence-named var (caught then only by the rc.6 generative net) slipped this static check.
 */
function charBlindToggleViolations(files: Array<{ rel: string; src: string }>): string[] {
  const out: string[] = [];
  for (const { rel, src } of files) {
    const code = stripComments(src);
    if (
      /\b[A-Za-z_]*[Ff]ence[A-Za-z_]*\s*=\s*!/.test(code) ||
      /\b([A-Za-z_]*[Ff]ence[A-Za-z_]*)\s*=\s*\1\s*\?/.test(code)
    )
      out.push(rel);
  }
  return out;
}

/**
 * v3.11.6-rc.1 — a DYNAMIC walker inventory replacing reliance on a fixed file list. Any src file
 * (except fence.ts, which OWNS the primitive) that declares a per-line fence-state variable — a
 * `let`/`var` whose name contains `fence`/`Fence`, or a `: FenceChar` annotation — MUST route
 * through `advanceFence`. This catches a FUTURE walker in a NEW file regardless of its toggle
 * shape or var name, closing the "fixed 4-file list" blind spot the pre-promotion re-sweep named.
 */
function fenceStateFilesMissingAdvanceFence(files: Array<{ rel: string; src: string }>): string[] {
  const out: string[] = [];
  for (const { rel, src } of files) {
    if (rel.endsWith("src/fence.ts")) continue;
    const code = stripComments(src);
    const declaresFenceState =
      /\b(?:let|var)\s+[A-Za-z_]*[Ff]ence[A-Za-z_]*\b/.test(code) || /:\s*FenceChar\b/.test(code);
    if (declaresFenceState && !/\badvanceFence\b/.test(code)) out.push(rel);
  }
  return out;
}

describe("fence-toggle correctness invariant — char-aware, no blind toggle (v3.11.5-rc.5)", () => {
  async function walkSrc(): Promise<Array<{ rel: string; src: string }>> {
    const files: Array<{ rel: string; src: string }> = [];
    async function walk(dir: string) {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.name.endsWith(".ts"))
          files.push({ rel: path.relative(repoRoot, full), src: await fs.readFile(full, "utf8") });
      }
    }
    await walk(path.join(repoRoot, "src"));
    return files;
  }

  it("no src/ file uses a char-blind fence toggle (negation OR ternary)", async () => {
    expect(charBlindToggleViolations(await walkSrc())).toEqual([]);
  });

  it("every KNOWN per-line fence walker is fence-aware (advanceFence directly OR delegates to structure.ts)", async () => {
    // v3.11.6-rc.2 — read/meta/fts5 migrated their hand-rolled fence walk onto the canonical
    // src/structure.ts iterators (iterateBodyLines/iterateContentLines/noteHeadings), which own the
    // one advanceFence loop; write.ts still uses advanceFence directly (its terminator-preserving
    // rewriters migrate in a later RC). Either form is fence-aware — a naive `/^\s*(```|~~~)/` toggle
    // in any of them is what this + charBlindToggleViolations forbid.
    const files = await walkSrc();
    const delegatesToStructure = (src: string) => /\b(iterateBodyLines|iterateContentLines|noteHeadings)\b/.test(src);
    for (const rel of ["src/tools/write.ts", "src/tools/read.ts", "src/tools/meta.ts", "src/fts5.ts"]) {
      const f = files.find((x) => x.rel.endsWith(rel));
      const fenceAware = !!f && (/\badvanceFence\b/.test(f.src) || delegatesToStructure(f.src));
      expect(fenceAware, `${rel} must be fence-aware (advanceFence directly OR structure.ts delegation)`).toBe(true);
    }
  });

  it("v3.11.6-rc.1 — EVERY fence-state-declaring src file uses advanceFence (dynamic inventory)", async () => {
    // Catches a FUTURE walker in a new file, or one whose state var isn't named *fence*.
    expect(fenceStateFilesMissingAdvanceFence(await walkSrc())).toEqual([]);
  });

  it("NEGATIVE control — a live char-blind toggle (negation OR ternary) is flagged; a comment is not", () => {
    const bad = [
      { rel: "src/tools/newthing.ts", src: "let inFence = false;\nif (opensBlockFence(l)) inFence = !inFence;" },
      // ternary self-toggle on a fence-named var — the shape the rc.5 detector MISSED (v3.11.6-rc.1)
      { rel: "src/tools/newternary.ts", src: "let fenceMarker = null;\nfenceMarker = fenceMarker ? null : m;" },
      // comment-only mention (the real read.ts/meta.ts shape) + the correct advanceFence use → NOT flagged
      {
        rel: "src/tools/ok.ts",
        src: "// pre-rc.5 the char-blind `inFence = !inFence` was wrong\nconst st = advanceFence(l, m);"
      }
    ];
    expect(charBlindToggleViolations(bad)).toEqual(["src/tools/newthing.ts", "src/tools/newternary.ts"]);
  });

  it("v3.11.6-rc.1 NEGATIVE control — a fence-state-declaring file without advanceFence is flagged; with it is not", () => {
    const bad = [
      // a NEW-file walker (a 5th file) that hand-rolls fence state and never uses advanceFence
      {
        rel: "src/tools/newwalker.ts",
        src: "let fenceMarker: FenceChar | null = null;\nfor (const l of lines) { /* naive */ }"
      },
      // a state var NOT named *fence* but typed FenceChar — still caught via the annotation
      { rel: "src/tools/aliaswalker.ts", src: "let mode: FenceChar | null = null;\nmode = null;" },
      // correct: declares the state AND routes through advanceFence → NOT flagged
      {
        rel: "src/tools/okwalker.ts",
        src: "let fenceMarker: FenceChar | null = null;\nconst st = advanceFence(l, fenceMarker);"
      },
      // fence.ts itself DEFINES FenceChar/advanceFence → exempt
      { rel: "src/fence.ts", src: "export type FenceChar = 'x';\nlet fenceRun = 0;" }
    ];
    expect(fenceStateFilesMissingAdvanceFence(bad)).toEqual(["src/tools/newwalker.ts", "src/tools/aliaswalker.ts"]);
  });
});
