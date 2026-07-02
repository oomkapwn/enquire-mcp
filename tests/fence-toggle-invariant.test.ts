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
});

/**
 * Every `inFence` line-walker in src/ must route its fence detection through the shared
 * `opensBlockFence` (src/fence.ts). Returns the list of offending relative paths (files that
 * reference `inFence` but not `opensBlockFence`). `fence.ts` itself is exempt (it DEFINES the
 * helper and has no `inFence` state machine).
 */
function fenceToggleViolations(files: Array<{ rel: string; src: string }>): string[] {
  const out: string[] = [];
  for (const { rel, src } of files) {
    if (rel.endsWith("src/fence.ts")) continue;
    if (/\binFence\b/.test(src) && !/\bopensBlockFence\b/.test(src)) out.push(rel);
  }
  return out;
}

describe("fence-toggle inventory invariant (v3.11.5-rc.2)", () => {
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

  it("every src/ inFence walker uses the shared opensBlockFence (no naive fence regex)", async () => {
    const files = await walkSrc();
    // Sanity: the invariant is non-vacuous — there ARE inFence walkers to guard.
    expect(files.some((f) => /\binFence\b/.test(f.src))).toBe(true);
    expect(fenceToggleViolations(files)).toEqual([]);
  });

  it("NEGATIVE control — a synthetic inFence walker WITHOUT opensBlockFence is flagged", () => {
    const bad = [
      { rel: "src/tools/newthing.ts", src: "let inFence = false;\nif (/^\\s*(`{3,})/.test(line)) inFence = !inFence;" },
      { rel: "src/fence.ts", src: "export function opensBlockFence(){}" }, // exempt (definer)
      {
        rel: "src/tools/ok.ts",
        src: 'import { opensBlockFence } from "../fence.js";\nlet inFence=false; if(opensBlockFence(l)) inFence=!inFence;'
      }
    ];
    expect(fenceToggleViolations(bad)).toEqual(["src/tools/newthing.ts"]);
  });
});
