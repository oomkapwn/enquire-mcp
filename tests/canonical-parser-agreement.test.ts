// v3.11.5-rc.6 (meta-audit highest-leverage hardening) — the GENERATIVE canonical-parser-
// agreement net. The entire rc.1→rc.5 fence/parser cascade (inline-span, read/fts5 siblings,
// the parser-desync class, the indented fence, the char-blind toggle) was ONE class: a
// note-structure element that appears ONLY inside a code fence must NEVER be surfaced by an
// always-on tool — matching the canonical parser (`stripCodeAndInline` / `parseNote`), which
// strips fenced + inline code before extraction, and Obsidian, which does not index links/
// tags/headings inside code.
//
// This is the "one net catches the whole class" defense the meta-audit designed: for EACH
// fence shape (backtick, tilde, indented, mismatched-inner-char, line-start inline span, and —
// v3.11.6-rc.1 — the UNCLOSED-fence variants) it plants a UNIQUE decoy element inside the fence
// + a real control outside, and asserts every always-on extractor surfaces the real one and NOT
// the decoy. A future extractor (or a regressed one) that hand-rolls fence handling and diverges
// from the parser fails here on whichever shape it mishandles — the generator's shape-coverage IS
// the class coverage.
//
// v3.11.6-rc.1 (pre-promotion-re-sweep follow-up) — the generator originally emitted only
// SELF-CLOSING fences, so the unclosed-fence-at-EOF shape (where the parser's paired-fence regex
// leaked the body while the char-aware walkers correctly treated it as code-to-EOF) was outside
// the corpus — the rc.25/rc.36 generator-blind-spot lesson. `src/parser.ts stripCodeAndInline` was
// reconciled with the walkers (drop an unclosed fence to EOF) and the `unclosed*` shapes added, so
// the net now proves parser↔walker agreement on that shape too.
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queryBase } from "../src/bases.js";
import { buildWikilinkGraph } from "../src/communities.js";
import { computeBreadcrumbsByLine } from "../src/fts5.js";
import { getOpenQuestions, validateNoteProposal } from "../src/tools/meta.js";
import { readNote } from "../src/tools/read.js";
import { Vault } from "../src/vault.js";

/**
 * Every fence SHAPE the cascade had to fix, as a wrapper that renders `inner` as CODE (so the
 * canonical parser strips it and no always-on tool may surface elements inside it):
 *  - backtick / tilde        : plain block fences
 *  - indented                : ≤3-space-indented block (CommonMark; rc.4)
 *  - mismatchedInner         : a ``` block whose body contains a `~~~` line before `inner`
 *                              (the char-blind toggle bug, rc.5 — a ~~~ must NOT close a ``` block)
 *  - inlineSpanLineStart     : `inner` wrapped in a line-leading triple-backtick inline span (rc.1)
 *  - unclosed*               : an UNCLOSED fence (open, no matching close) — per CommonMark it
 *                              runs to end-of-document, so `inner` is code (v3.11.6-rc.1: the
 *                              parser's `stripCodeAndInline` was reconciled with the walkers here,
 *                              closing the generator blind-spot the pre-promotion re-sweep named).
 *                              These wrappers deliberately emit NO closing fence, so any REAL
 *                              control the caller appends AFTER them is (correctly) also code.
 */
const BT = "```"; // fence chars kept as consts so the wrappers use template literals
const TT = "~~~"; // (biome useTemplate) without escaping backticks/tildes inline
const SHAPES: Record<string, (inner: string) => string> = {
  backtick: (i) => `${BT}\n${i}\n${BT}`,
  tilde: (i) => `${TT}\n${i}\n${TT}`,
  indented: (i) => `   ${BT}\n${i}\n   ${BT}`,
  mismatchedInner: (i) => `${BT}\n${TT}\n${i}\n${BT}`,
  inlineSpanLineStart: (i) => `${BT}${i}${BT}`,
  unclosed: (i) => `${BT}\n${i}`,
  unclosedTilde: (i) => `${TT}\n${i}`,
  unclosedMismatchedInner: (i) => `${BT}\n${TT}\n${i}`
};
const SHAPE_KEYS = Object.keys(SHAPES);

describe("canonical parser-agreement net — a fenced-only element is never surfaced (v3.11.5-rc.6)", () => {
  let dir: string;
  let v: Vault;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "parser-agree-"));
    v = new Vault(dir, {});
    await v.ensureExists();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("readNote(map) headings: fenced ## heading excluded, real included — every shape", async () => {
    for (const shape of SHAPE_KEYS) {
      const real = `Real_${shape}`;
      const decoy = `Decoy_${shape}`;
      const body = `## ${real}\n\n${SHAPES[shape](`## ${decoy}`)}\n\n## ${real}2\n`;
      await fs.writeFile(path.join(dir, `${shape}.md`), body);
      const r = await readNote(v, { path: `${shape}.md`, format: "map" });
      const heads = (r.headings ?? []).map((h) => h.text);
      expect(heads, `[${shape}] real heading surfaced`).toContain(real);
      expect(heads, `[${shape}] fenced heading NOT surfaced`).not.toContain(decoy);
    }
  });

  it("buildWikilinkGraph: fenced [[link]] makes no edge, real does — every shape", async () => {
    for (const shape of SHAPE_KEYS) {
      const real = `RealT_${shape}`;
      const decoy = `DecoyT_${shape}`;
      await fs.mkdir(path.join(dir, shape), { recursive: true });
      const src = path.join(shape, "src.md");
      await fs.writeFile(path.join(dir, src), `[[${real}]] real\n${SHAPES[shape](`[[${decoy}]]`)}\n`);
      await fs.writeFile(path.join(dir, shape, `${real}.md`), "# real target\n");
      await fs.writeFile(path.join(dir, shape, `${decoy}.md`), "# decoy target\n");
      const g = await buildWikilinkGraph(v);
      const out = [...(g.adjacency.get(src.replace(/\\/g, "/"))?.keys() ?? [])].map((p) => path.basename(p));
      expect(out, `[${shape}] real edge present`).toContain(`${real}.md`);
      expect(out, `[${shape}] fenced edge absent`).not.toContain(`${decoy}.md`);
    }
  });

  it("queryBase tag==: fenced #tag never matches, real does — every shape", async () => {
    for (const shape of SHAPE_KEYS) {
      const real = `realtag${shape.toLowerCase()}`;
      const decoy = `decoytag${shape.toLowerCase()}`;
      await fs.writeFile(path.join(dir, `${shape}.md`), `#${real} real\n${SHAPES[shape](`#${decoy}`)}\n`);
      await fs.writeFile(path.join(dir, `real-${shape}.base`), `filters:\n  and:\n    - tag == "${real}"\n`);
      await fs.writeFile(path.join(dir, `decoy-${shape}.base`), `filters:\n  and:\n    - tag == "${decoy}"\n`);
      const realHit = (await queryBase(v, { path: `real-${shape}.base` })).matches.map((m) => m.path);
      const decoyHit = (await queryBase(v, { path: `decoy-${shape}.base` })).matches.map((m) => m.path);
      expect(realHit, `[${shape}] real tag matches`).toContain(`${shape}.md`);
      expect(decoyHit, `[${shape}] fenced tag does not match`).not.toContain(`${shape}.md`);
    }
  });

  it("getOpenQuestions: fenced Q: excluded, real included — every shape", async () => {
    for (const shape of SHAPE_KEYS) {
      const real = `real question ${shape}`;
      const decoy = `decoy question ${shape}`;
      await fs.writeFile(path.join(dir, `${shape}.md`), `Q: ${real}\n${SHAPES[shape](`Q: ${decoy}`)}\n`);
    }
    const qs = (await getOpenQuestions(v, {})).map((q) => q.question);
    for (const shape of SHAPE_KEYS) {
      expect(qs, `[${shape}] real question surfaced`).toContain(`real question ${shape}`);
      expect(qs, `[${shape}] fenced question NOT surfaced`).not.toContain(`decoy question ${shape}`);
    }
  });

  it("validateNoteProposal: fenced [[link]]/#tag not reported, real reported — every shape", async () => {
    for (const shape of SHAPE_KEYS) {
      const rl = `RealL_${shape}`;
      const dl = `DecoyL_${shape}`;
      const rt = `realt${shape.toLowerCase()}`;
      const dt = `decoyt${shape.toLowerCase()}`;
      const content = `[[${rl}]] #${rt} real\n${SHAPES[shape](`[[${dl}]] #${dt}`)}\n`;
      const vp = await validateNoteProposal(v, { path: `${shape}.md`, content });
      const links = vp.wikilinks.map((w) => w.target);
      const tags = vp.tags.map((t) => t.name);
      expect(links, `[${shape}] real link`).toContain(rl);
      expect(links, `[${shape}] fenced link absent`).not.toContain(dl);
      expect(tags, `[${shape}] real tag`).toContain(rt);
      expect(tags, `[${shape}] fenced tag absent`).not.toContain(dt);
    }
  });

  it("computeBreadcrumbsByLine: a fenced # heading never enters any breadcrumb — every shape", () => {
    for (const shape of SHAPE_KEYS) {
      const decoy = `Decoy_${shape}`;
      const crumbs = computeBreadcrumbsByLine(`# Top_${shape}\n${SHAPES[shape](`# ${decoy}`)}\nafter\n`);
      expect(crumbs, `[${shape}] fenced heading not in any breadcrumb`).not.toContain(decoy);
    }
  });
});
