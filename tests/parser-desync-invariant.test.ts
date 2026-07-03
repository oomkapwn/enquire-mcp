// v3.11.5-rc.3 (post-rc.2 re-sweep) — the PARSER-DESYNC class: several always-on tools
// re-extracted wikilinks / tags / questions from the RAW note body instead of the parser's
// canonical fence-stripped output (parseNote → stripCodeAndInline), so a `[[link]]` / `#tag`
// / `Q:` whose ONLY occurrence is inside a ``` code fence was treated as real — disagreeing
// with the project's own parser AND Obsidian (which never index links/tags inside code).
//
// This pins (1) the behavior of all four fixed tools (fenced-only occurrence NOT surfaced,
// real occurrence STILL surfaced) and (2) a structural inventory invariant: any call to the
// raw extractors (extractWikilinks / extractInlineTags) OUTSIDE parser.ts must be on a
// stripCodeAndInline-sanitized argument, so a future consumer can't re-introduce the desync.
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queryBase } from "../src/bases.js";
import { buildWikilinkGraph } from "../src/communities.js";
import { getOpenQuestions, validateNoteProposal } from "../src/tools/meta.js";
import { Vault } from "../src/vault.js";

const repoRoot = path.resolve(__dirname, "..");

describe("PARSER-DESYNC behavior — fenced-only links/tags/questions are not surfaced (v3.11.5-rc.3)", () => {
  let dir: string;
  let v: Vault;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "parser-desync-"));
    v = new Vault(dir, {});
    await v.ensureExists();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("buildWikilinkGraph — a fenced [[B]] creates NO edge; a real [[B]] does (communities)", async () => {
    await fs.writeFile(path.join(dir, "A.md"), "# A\n```md\n[[B]]\n```\nno real links\n"); // fenced only
    await fs.writeFile(path.join(dir, "B.md"), "# B\n");
    const g = await buildWikilinkGraph(v);
    expect([...(g.adjacency.get("A.md")?.keys() ?? [])]).toEqual([]); // was ["B.md"] pre-rc.3
    // NEGATIVE control: a REAL (unfenced) [[B]] still produces the edge.
    await fs.writeFile(path.join(dir, "A.md"), "# A\n[[B]] real link\n");
    const g2 = await buildWikilinkGraph(v);
    expect([...(g2.adjacency.get("A.md")?.keys() ?? [])]).toEqual(["B.md"]);
  });

  it("queryBase — `tag == draft` does NOT match a note whose only #draft is fenced; matches a real one", async () => {
    await fs.writeFile(path.join(dir, "Fenced.md"), "# F\n```\n#draft example\n```\nno real tags\n");
    await fs.writeFile(path.join(dir, "Real.md"), "# R\n#draft real\n");
    await fs.writeFile(path.join(dir, "t.base"), 'filters:\n  and:\n    - tag == "draft"\n');
    const res = await queryBase(v, { path: "t.base" });
    const paths = res.matches.map((m) => m.path);
    expect(paths).toContain("Real.md"); // NEGATIVE control — the real #draft still matches
    expect(paths).not.toContain("Fenced.md"); // was matched pre-rc.3
  });

  it("getOpenQuestions — a fenced `Q:` is not surfaced; a real `Q:` is", async () => {
    await fs.writeFile(
      path.join(dir, "Q.md"),
      "# Doc\n```markdown\nQ: fenced example not a real question\n```\nQ: the real open question\n"
    );
    const out = await getOpenQuestions(v, {});
    const qs = out.map((q) => q.question);
    expect(qs).toContain("the real open question"); // NEGATIVE control — real one still found
    expect(qs).not.toContain("fenced example not a real question"); // was surfaced pre-rc.3
  });

  it("validateNoteProposal — a fenced [[X]] / #tag is not reported; a real one is", async () => {
    const vp = await validateNoteProposal(v, {
      path: "P.md",
      content: "# P\n[[RealTarget]] here\n```\n[[FencedTarget]]\n#fencedtag\n```\n#realtag\n"
    });
    const linkTargets = vp.wikilinks.map((w) => w.target);
    expect(linkTargets).toContain("RealTarget"); // NEGATIVE control
    expect(linkTargets).not.toContain("FencedTarget"); // was reported (as broken) pre-rc.3
    const tagNames = vp.tags.map((t) => t.name);
    expect(tagNames).toContain("realtag");
    expect(tagNames).not.toContain("fencedtag"); // was reported pre-rc.3
  });
});

/**
 * Every note-body extraction primitive used OUTSIDE `src/parser.ts` must receive a
 * `stripCodeAndInline`-sanitized argument. v3.11.5-rc.5 (meta-audit) — broadened from the
 * two wrappers (`extractWikilinks`/`extractInlineTags`) to ALSO cover the lower-level
 * primitives `scanWikilinkInners(x)` and `x.matchAll(INLINE_TAG_RE)` that `validateNoteProposal`
 * actually uses — the rc.3 invariant was scope-too-narrow (grepped only the wrappers), so a
 * future edit to a raw arg on either primitive would reintroduce the fenced-link/tag desync
 * while CI stayed green. `arg` is safe if it is (a) an inline `stripCodeAndInline(...)` call or
 * (b) an identifier assigned from `stripCodeAndInline` in the same file.
 */
function rawExtractionViolations(files: Array<{ rel: string; src: string }>): string[] {
  const out: string[] = [];
  const isSanitized = (arg: string, src: string): boolean =>
    arg === "stripCodeAndInline" || new RegExp(`\\b${arg}\\s*=\\s*stripCodeAndInline\\b`).test(src);
  for (const { rel, src } of files) {
    if (rel.endsWith("src/parser.ts")) continue; // the extractors' home; sanitizes internally
    // (1) wrappers + scanWikilinkInners + extractEmbeds: the arg is the first call argument.
    //     extractEmbeds (v3.11.6-rc.1, post-rc.1 re-sweep) shares matchLinks→scanWikilinkInners, so
    //     a raw extractEmbeds(rawBody) would surface a fenced `![[embed]]` — same desync class. No
    //     live external caller today (embeds are read via `parsed.embeds`), so this is a latent guard.
    for (const m of src.matchAll(
      /\b(extractWikilinks|extractInlineTags|scanWikilinkInners|extractEmbeds)\s*\(\s*([A-Za-z0-9_.]+)/g
    )) {
      const arg = m[2] ?? "";
      if (!isSanitized(arg, src)) out.push(`${rel}: ${m[1]}(${arg})`);
    }
    // (2) INLINE_TAG_RE matcher: the arg is the RECEIVER of `.matchAll(INLINE_TAG_RE)`
    //     (optionally with a `.normalize(...)` in between).
    for (const m of src.matchAll(/\b([A-Za-z0-9_]+)(?:\.normalize\([^)]*\))?\.matchAll\(\s*INLINE_TAG_RE\b/g)) {
      const arg = m[1] ?? "";
      if (!isSanitized(arg, src)) out.push(`${rel}: ${arg}.matchAll(INLINE_TAG_RE)`);
    }
    // (3) collectTags(fm, body) — v3.11.6-rc.1: the note-body arg (2nd positional) must be
    //     fence-stripped. bases.ts's collectTags uses its OWN inline-tag regex (not the shared
    //     INLINE_TAG_RE), so it escapes checks (1)+(2). The `fm: Type, body: Type` DEFINITION
    //     never matches (the `:` after the 1st param breaks the `ident, ` shape); only CALL sites do.
    for (const m of src.matchAll(/\bcollectTags\s*\(\s*[A-Za-z0-9_.]+\s*,\s*([A-Za-z0-9_.]+)/g)) {
      const arg = m[1] ?? "";
      if (!isSanitized(arg, src)) out.push(`${rel}: collectTags(_, ${arg})`);
    }
  }
  return out;
}

describe("PARSER-DESYNC inventory invariant (v3.11.5-rc.3)", () => {
  async function walkSrc(): Promise<Array<{ rel: string; src: string }>> {
    const files: Array<{ rel: string; src: string }> = [];
    async function walk(d: string) {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.name.endsWith(".ts"))
          files.push({ rel: path.relative(repoRoot, full), src: await fs.readFile(full, "utf8") });
      }
    }
    await walk(path.join(repoRoot, "src"));
    return files;
  }

  it("every extractWikilinks/extractInlineTags call outside parser.ts is on sanitized input", async () => {
    const files = await walkSrc();
    // Non-vacuous: there IS at least one such external call to guard (bases.ts).
    expect(files.some((f) => !f.rel.endsWith("src/parser.ts") && /\bextractWikilinks\s*\(/.test(f.src))).toBe(true);
    expect(rawExtractionViolations(files)).toEqual([]);
  });

  it("NEGATIVE control — raw calls on every covered surface (no sanitize) are flagged", () => {
    const bad = [
      { rel: "src/tools/newthing.ts", src: "const body = await read();\nconst links = extractWikilinks(body);" },
      { rel: "src/tools/newq.ts", src: "for (const i of scanWikilinkInners(bodyAfterFm, false)) {}" }, // raw primitive
      { rel: "src/tools/newtag.ts", src: 'for (const m of bodyAfterFm.normalize("NFC").matchAll(INLINE_TAG_RE)) {}' }, // raw matcher
      { rel: "src/basething.ts", src: "const tags = collectTags(fm, bodyAfterFm);" }, // raw collectTags body (v3.11.6-rc.1)
      { rel: "src/tools/newembeds.ts", src: "const body = await read();\nconst e = extractEmbeds(body);" }, // raw extractEmbeds body (v3.11.6-rc.1 re-sweep)
      { rel: "src/parser.ts", src: "return extractWikilinks(sanitized);" }, // exempt (the home)
      { rel: "src/tools/ok.ts", src: "const sanitized = stripCodeAndInline(body);\nextractWikilinks(sanitized);" },
      { rel: "src/tools/ok2.ts", src: "extractWikilinks(stripCodeAndInline(body));" },
      // collectTags DEFINITION (typed params) must NOT match, and a sanitized call must NOT flag.
      {
        rel: "src/basegood.ts",
        src: "function collectTags(fm: Rec, body: string) {}\nconst sb = stripCodeAndInline(b);\ncollectTags(fm, sb);"
      }
    ];
    expect(rawExtractionViolations(bad)).toEqual([
      "src/tools/newthing.ts: extractWikilinks(body)",
      "src/tools/newq.ts: scanWikilinkInners(bodyAfterFm)",
      "src/tools/newtag.ts: bodyAfterFm.matchAll(INLINE_TAG_RE)",
      "src/basething.ts: collectTags(_, bodyAfterFm)",
      "src/tools/newembeds.ts: extractEmbeds(body)"
    ]);
  });
});
