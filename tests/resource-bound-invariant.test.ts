// v3.9.0-rc.36 — RESOURCE-BOUND COMPLETENESS INVARIANT (P0 structural defense).
//
// Closes the unbounded-graph DoS class (R-5 find_path rc.34, AS#5 communities
// rc.35, F-4 findSimilar + F-5 getNoteNeighbors rc.36). Each was an
// always-registered tool that let vault size drive unbounded per-note readNote
// I/O + in-memory graph growth — reachable from a bearer-auth serve-http client.
//
// WHY THE INTERNAL APPARATUS MISSED THESE (meta-audit, this session): the OIA +
// invariant suite is drift/claim-driven; it has no control-flow / resource-bound
// check. R-5 and AS#5 were found by an EXTERNAL auditor ONE RC APART — fixing
// find_path (rc.34) did NOT trigger a sweep of the sibling graph-builders, so
// communities (rc.35), then findSimilar/getNoteNeighbors (rc.36) each surfaced
// later. This invariant ends that recursion: it discovers EVERY always-on
// whole-vault scanner and fails CI unless each is explicitly classified —
//   • CAP   — builds a vault-sized GRAPH / PAIRWISE structure with heuristic
//             top-K output ⇒ must reference a bounding constant (capScanEntries
//             / MAX_VISITED / MAX_GRAPH_NODES). Partial scan only trims the tail.
//   • EXEMPT — inherent single-pass O(N) (search / aggregation / exhaustive
//             enumeration) whose memory is bounded by output or distinct-keys,
//             NOT by an N×N graph. Capping would silently corrupt results, so a
//             cap is WRONG; the exemption is documented per tool.
// A NEW scanner (graph or not) lands UNCLASSIFIED ⇒ this test fails ⇒ a human
// must make the cap-or-exempt call. Mirrors the rc.25 ReDoS-fuzz move: convert
// "did we remember to bound every scanner?" (undecidable, recursion-prone) into
// a self-checking CI gate.

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { capScanEntries, MAX_SCAN_NOTES } from "../src/tools/limits.js";

const repoRoot = path.resolve(__dirname, "..");

// The source files whose exported tool handlers can scan the whole vault.
// v3.10.0-rc.18 (audit M4) — added src/dql.ts: `runDql` (behind obsidian_dataview_query)
// does a whole-vault readNote scan but lived OUTSIDE this list, so the completeness
// invariant never saw it (scope-too-narrow). Closing the gap.
const SCANNER_SOURCES = ["src/tools/read.ts", "src/tools/search.ts", "src/tools/meta.ts", "src/dql.ts"];

// CAP — always-on tools that build a vault-sized graph/pairwise structure. Each
// MUST reference its bounding constant in its own body. (communities.ts's
// buildWikilinkGraph is capped via MAX_GRAPH_NODES but lives outside
// SCANNER_SOURCES + uses listFilesByExtension, so it's asserted separately.)
const CAPPED: Record<string, { capToken: string; why: string }> = {
  findPath: { capToken: "MAX_VISITED", why: "BFS graph traversal; rc.34 R-5." },
  findSimilar: {
    capToken: "capScanEntries",
    why: "builds vault-sized metas + inboundFor maps, scores pairwise; rc.36 F-4."
  },
  getNoteNeighbors: {
    capToken: "capScanEntries",
    why: "two whole-vault readNote passes building an inbound-count map; rc.36 F-5."
  },
  runDql: {
    capToken: "capScanEntries",
    why: "obsidian_dataview_query whole-vault readNote+parse scan, bearer-reachable; defense-in-depth cap (linear query, partial on >MAX_SCAN_NOTES, logged); rc.18 M4."
  },
  getOpenQuestions: {
    capToken: "capScanEntries",
    why: "exhaustive question scan; rc.16 (M5) added capScanEntries to bound the collect-all-then-sort. Was EXEMPT; reclassified CAPPED here (manifest lagged the rc.16 cap)."
  }
};

// EXEMPT — inherent single-pass O(N) scanners. Capping any of these would
// silently corrupt an exhaustive/aggregation result, so a cap is the WRONG fix.
// Memory is bounded by output size or distinct keys, never by an N×N structure.
const EXEMPT: Record<string, string> = {
  searchText: "linear content scan — must read every note to find all matches; capping drops hits.",
  listNotes: "directory listing — `limit` bounds OUTPUT; the scan is inherent, memory is the page.",
  getRecentEdits: "sorts by mtime (from listMarkdown metadata) and previews only the top-N notes.",
  getBacklinks: "exhaustive enumeration — must visit every note to list ALL backlinks; capping drops real backlinks.",
  getUnresolvedWikilinks: "exhaustive — must check every note's links; capping would miss broken links.",
  getOutboundLinks: "reads the file LIST + only the target note's own links; not an N-note readNote loop.",
  listTags: "aggregation — tag frequencies over the whole vault; Map keyed by DISTINCT tags, not note count.",
  frontmatterSearch: "must scan all frontmatter to find matches; capping drops results.",
  getVaultStats: "whole-vault aggregation by definition; capping yields wrong stats.",
  lintWiki: "exhaustive vault lint; must visit every note (output already supports a limit param).",
  paperAudit: "exhaustive audit over the whole vault.",
  buildTfidfIndex:
    "search-index infrastructure — builds the vault-wide TF-IDF index (single pass, WeakMap-cached per vault); capping would silently drop notes from search ranking. O(N) build is inherent to a correct index, like searchText."
};

/** Body of a top-level `export (async )?function NAME(...)`: from the signature
 *  to the first column-0 `}` (a top-level function's own closing brace; nested
 *  closers are indented). Reliable because tool handlers are top-level. */
function functionBody(src: string, name: string): string {
  const sig = new RegExp(`export (?:async )?function ${name}\\s*\\(`).exec(src);
  if (!sig) return "";
  const rest = src.slice(sig.index);
  const end = rest.search(/\n\}\n/);
  return end === -1 ? rest : rest.slice(0, end);
}

/** All top-level exported functions in `src` that do a whole-vault readNote
 *  scan: body references `.listMarkdown(` AND `.readNote(` AND a `for (` loop.
 *  Requiring all three keeps pure helpers (ngrams, indexFor) out. */
function discoverScanners(src: string): string[] {
  const out: string[] = [];
  const re = /export (?:async )?function (\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
  while ((m = re.exec(src)) !== null) {
    const body = functionBody(src, m[1] as string);
    // v3.10.0-rc.40 (#12) — match parallel-fanout iteration too (Promise.all / .map(async /
    // for await), not only a literal `for (`: a whole-vault reader written as a pure
    // `Promise.all(entries.map(async e => readNote(...)))` would otherwise escape discovery.
    const iterates =
      /for\s*\(/.test(body) ||
      /for\s+await\b/.test(body) ||
      /\.map\(\s*async\b/.test(body) ||
      /Promise\.all\(/.test(body);
    if (/\.listMarkdown\(/.test(body) && /\.readNote\(/.test(body) && iterates) {
      out.push(m[1] as string);
    }
  }
  return out;
}

function allDiscoveredScanners(): string[] {
  const names = new Set<string>();
  for (const f of SCANNER_SOURCES) {
    for (const n of discoverScanners(readFileSync(path.join(repoRoot, f), "utf8"))) names.add(n);
  }
  return [...names].sort();
}

describe("resource-bound completeness invariant (rc.36, R-5/AS#5 class)", () => {
  it("every whole-vault scanner is classified CAP or EXEMPT (no unclassified scanner)", () => {
    const classified = new Set([...Object.keys(CAPPED), ...Object.keys(EXEMPT)]);
    const unclassified = allDiscoveredScanners().filter((n) => !classified.has(n));
    expect(
      unclassified,
      `Unclassified always-on whole-vault scanner(s): ${unclassified.join(", ")}. ` +
        "Add each to CAPPED (call capScanEntries — it builds a vault-sized graph/pairwise structure) " +
        "or EXEMPT (with a reason — it's inherent single-pass O(N) where capping breaks correctness)."
    ).toEqual([]);
  });

  it("every CAPPED tool references its bounding constant in its own body", () => {
    const offenders: string[] = [];
    for (const f of SCANNER_SOURCES) {
      const src = readFileSync(path.join(repoRoot, f), "utf8");
      for (const [fn, { capToken }] of Object.entries(CAPPED)) {
        const body = functionBody(src, fn);
        if (body && !body.includes(capToken)) offenders.push(`${fn} (${f}) lost its cap token "${capToken}"`);
      }
    }
    expect(offenders, offenders.join("; ")).toEqual([]);
  });

  it("communities.buildWikilinkGraph still references MAX_GRAPH_NODES (rc.35 AS#5)", () => {
    const src = readFileSync(path.join(repoRoot, "src/communities.ts"), "utf8");
    expect(src).toContain("MAX_GRAPH_NODES");
    expect(src).toMatch(/slice\(0,\s*MAX_GRAPH_NODES\)/);
  });

  // v3.10.0-rc.24 (audit L) — `obsidian_query_base` (bases.ts `queryBase`) is an
  // always-on, bearer-reachable whole-vault CONTENT scanner, but it uses
  // `listFilesByExtension(".md")` + `readFile` (not `listMarkdown` + `readNote`),
  // so `discoverScanners` can't see it and `bases.ts` is outside SCANNER_SOURCES.
  // Assert its cap separately (mirrors buildWikilinkGraph above), so a refactor
  // that drops the cap fails CI even though the heuristic doesn't reach it.
  it("bases.queryBase caps its whole-vault scan via capScanEntries (rc.24)", () => {
    const body = functionBody(readFileSync(path.join(repoRoot, "src/bases.ts"), "utf8"), "queryBase");
    expect(body, "queryBase not found in bases.ts").not.toBe("");
    expect(body).toContain("capScanEntries(");
  });

  // v3.10.0-rc.65 (round-3 audit) — `obsidian_read_canvas` (media.ts `readCanvas`) is an
  // always-on, bearer-reachable tool that loads the whole markdown index (`listMarkdown`) and
  // resolves each `file:` node against it. It uses `listMarkdown` WITHOUT `readNote`, so
  // `discoverScanners` can't see it and `media.ts` is outside SCANNER_SOURCES — it escaped the
  // class entirely. Pre-rc.65 it did a per-node O(N) `allMarkdown.find(...)` → O(K×N) on the
  // event loop. The fix indexes relPaths ONCE into a Map (`byRelPath`) for an O(1) per-node
  // lookup. Assert the bounded shape separately (mirrors queryBase/buildWikilinkGraph): the
  // O(1) index is present AND the per-node linear find is gone, so a refactor reintroducing it
  // fails CI even though the heuristic doesn't reach this function.
  it("media.readCanvas resolves file-nodes via the O(1) byRelPath index, not a per-node find (rc.65)", () => {
    const body = functionBody(readFileSync(path.join(repoRoot, "src/tools/media.ts"), "utf8"), "readCanvas");
    expect(body, "readCanvas not found in media.ts").not.toBe("");
    expect(body, "readCanvas must build the O(1) byRelPath index").toContain("byRelPath");
    // NEGATIVE: the O(N)-per-node linear scan must be gone (the rc.65 regression shape).
    expect(body, "readCanvas must NOT do a per-node allMarkdown.find()").not.toMatch(/allMarkdown\.find\(/);
  });

  it("every CAPPED tool is actually discovered as a scanner (didn't silently stop scanning)", () => {
    const discovered = new Set(allDiscoveredScanners());
    const missing = Object.keys(CAPPED).filter((n) => !discovered.has(n));
    expect(missing, `CAPPED tools no longer detected as whole-vault scanners: ${missing.join(", ")}`).toEqual([]);
  });

  // capScanEntries behavioral coverage (the cap mechanism itself).
  it("capScanEntries truncates above MAX_SCAN_NOTES and passes through below", () => {
    const under = Array.from({ length: 10 }, (_, i) => i);
    expect(capScanEntries(under, "t")).toBe(under); // identity below cap
    const over = Array.from({ length: MAX_SCAN_NOTES + 5 }, (_, i) => i);
    const capped = capScanEntries(over, "t-over");
    expect(capped.length).toBe(MAX_SCAN_NOTES);
    expect(capped[0]).toBe(0);
  });

  // NEGATIVE control: a brand-new uncapped scanner MUST be discovered (so the
  // first assertion would flag it as unclassified) — proving the guard isn't
  // vacuous and genuinely catches the next AS#5-shaped sibling.
  it("NEGATIVE control — discoverScanners detects a newly-added uncapped scanner", () => {
    const fakeSrc = [
      "export async function brandNewNeighborTool(vault) {",
      "  const entries = await vault.listMarkdown();",
      "  for (const e of entries) {",
      "    const { parsed } = await vault.readNote(e.absPath);",
      "    void parsed;",
      "  }",
      "}",
      ""
    ].join("\n");
    const found = discoverScanners(fakeSrc);
    expect(found).toContain("brandNewNeighborTool");
    // …and it is NOT in the classified set, so the completeness assertion above
    // would fail until a human classifies it.
    const classified = new Set([...Object.keys(CAPPED), ...Object.keys(EXEMPT)]);
    expect(classified.has("brandNewNeighborTool")).toBe(false);
  });

  // NEGATIVE control (rc.40 #12): a whole-vault reader written as a pure parallel
  // fanout (Promise.all(map), NO literal `for (`) MUST also be discovered — pre-rc.40
  // the for-only predicate missed this natural concurrent-reader shape.
  it("NEGATIVE control — discoverScanners detects a Promise.all(map) fanout scanner (rc.40 #12)", () => {
    const fakeSrc = [
      "export async function parallelFanoutTool(vault) {",
      "  const entries = await vault.listMarkdown();",
      "  const r = await Promise.all(",
      "    entries.map(async (e) => {",
      "      const { content } = await vault.readNote(e.absPath);",
      "      return content.length;",
      "    })",
      "  );",
      "  return r;",
      "}",
      ""
    ].join("\n");
    expect(discoverScanners(fakeSrc)).toContain("parallelFanoutTool");
  });

  // NEGATIVE control: the cap-token check must FLAG a capped function that drops
  // its bounding constant (e.g. a refactor removes capScanEntries).
  it("NEGATIVE control — cap-token check flags a CAPPED body that lost its constant", () => {
    const buggyBody = "export async function findSimilar(v) {\n  const entries = await v.listMarkdown();\n}";
    expect(buggyBody.includes("capScanEntries")).toBe(false); // would be reported as an offender
  });
});
