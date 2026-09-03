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
//   • CAP   — builds a vault-sized GRAPH / PAIRWISE structure ⇒ discovery must
//             be bounded inside the walker and reject an incomplete prefix
//             (listExactScanEntries / MAX_VISITED / MAX_GRAPH_NODES).
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
import { replaceExactly } from "./helpers/exact-source-mutation.js";

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
    capToken: "listExactScanEntries",
    why: "builds vault-sized metas + inboundFor maps, scores pairwise; rc.36 F-4."
  },
  getNoteNeighbors: {
    capToken: "listExactScanEntries",
    why: "two whole-vault readNote passes building an inbound-count map; rc.36 F-5."
  }
};

// BOUNDED — scanners whose discovery is bounded AND which refuse an incomplete
// prefix rather than silently returning a truncated answer. Stronger than EXEMPT:
// EXEMPT asserts nothing about the body, this asserts both halves of the contract.
// A bounded walk WITHOUT the refusal is the dangerous shape — it looks capped and
// answers "these are all your frontmatter keys" from whatever prefix it reached.
const BOUNDED: Record<string, string> = {
  vaultShape: "frontmatter-key census; a truncated walk would under-report keys as absent.",
  listTags: "tag frequencies; a truncated walk would under-report counts as real.",
  frontmatterSearch: "must scan all frontmatter; a truncated walk would report false absence.",
  runDql: "whole-vault query; a truncated walk would silently drop matching rows.",
  getOpenQuestions: "whole-vault question scan, additionally bounded by MAX_QUESTION_SCAN_MS."
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
 *  scan: body references a vault inventory, `.readNote(`, and an iteration.
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
    // The inventory + read calls this matches must track what production actually
    // calls. Scanners have since migrated to `listFilesByExtensionsBounded(` (bounded
    // discovery that reports completeness) and `readNoteUncached(`; matching only the
    // legacy `listMarkdown` / `readNote` names hid FIVE live scanners from the
    // completeness gate below — including `runDql`, whose whole FILE was added to
    // SCANNER_SOURCES in rc.18 to close exactly this gap. Adding the file made the
    // suite green without ever discovering the function: the fix moved the list while
    // the detector's own vocabulary was what had drifted.
    const discoversVault =
      /\.listMarkdown\(/.test(body) ||
      /listExactScanEntries\(/.test(body) ||
      /listFilesByExtensionsBounded\(/.test(body);
    const readsNotes = /\.readNote\(/.test(body) || /readNoteUncached\(/.test(body);
    if (discoversVault && readsNotes && iterates) {
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
  it("every whole-vault scanner is classified CAP, BOUNDED or EXEMPT (no unclassified scanner)", () => {
    const classified = new Set([...Object.keys(CAPPED), ...Object.keys(BOUNDED), ...Object.keys(EXEMPT)]);
    const unclassified = allDiscoveredScanners().filter((n) => !classified.has(n));
    expect(
      unclassified,
      `Unclassified always-on whole-vault scanner(s): ${unclassified.join(", ")}. ` +
        "Add each to CAPPED (bounded, complete discovery for a vault-sized graph/pairwise structure), " +
        "BOUNDED (bounded discovery that refuses an incomplete prefix) " +
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
      // BOUNDED needs BOTH halves. A bounded walk that drops the refusal still looks
      // capped while answering from whatever prefix it reached — the failure mode is a
      // confident wrong answer, not an error, so the refusal is the load-bearing half.
      for (const fn of Object.keys(BOUNDED)) {
        const body = functionBody(src, fn);
        if (!body) continue;
        if (!body.includes("listFilesByExtensionsBounded("))
          offenders.push(`${fn} (${f}) no longer bounds its inventory`);
        if (!/listing\.complete/.test(body)) offenders.push(`${fn} (${f}) no longer refuses an incomplete inventory`);
      }
    }
    expect(offenders, offenders.join("; ")).toEqual([]);
  });

  it("searchText discovers an exact bounded corpus and matches all tokens in one body pass", () => {
    const source = readFileSync(path.join(repoRoot, "src/tools/search.ts"), "utf8");
    const body = functionBody(source, "searchText");
    expect(body, "searchText not found").not.toBe("");
    expect(body).toContain("listExactScanEntries(");
    expect(body).toContain("matchFoldedPatterns(lower, lowerTokens)");
    expect(body).not.toContain("listMarkdown(");
    expect(body).not.toContain("lower.indexOf(lowerT");

    const mutant = replaceExactly(body, "matchFoldedPatterns(lower, lowerTokens)", "{ counts: [], firstStarts: [] }");
    expect(mutant).not.toContain("matchFoldedPatterns(lower, lowerTokens)");
  });

  it("communities.buildWikilinkGraph uses a bounded inventory and refuses incomplete graphs", () => {
    const body = functionBody(readFileSync(path.join(repoRoot, "src/communities.ts"), "utf8"), "buildWikilinkGraph");
    expect(body, "buildWikilinkGraph not found in communities.ts").not.toBe("");
    expect(body).toContain("listFilesByExtensionsBounded(");
    expect(body).toContain("if (!listing.complete");
    expect(body).not.toContain("listFilesByExtension(");
    expect(body).not.toMatch(/slice\(0,\s*MAX_GRAPH_NODES\)/);
  });

  it("every destructive bulk index sync rejects an incomplete bounded source inventory", () => {
    const ftsSource = readFileSync(path.join(repoRoot, "src/fts5.ts"), "utf8");
    const embedSource = readFileSync(path.join(repoRoot, "src/embed-sync.ts"), "utf8");
    for (const [label, body] of [
      ["syncFtsIndex", functionBody(ftsSource, "syncFtsIndex")],
      ["syncPdfFtsIndex", functionBody(ftsSource, "syncPdfFtsIndex")]
    ] as const) {
      expect(body, `${label} not found`).not.toBe("");
      expect(body).toContain("listFilesByExtensionsBounded(");
      expect(body).toContain("if (!listing.complete)");
      expect(body).not.toContain("listMarkdown(");
      expect(body).not.toContain("listFilesByExtension(");
    }

    const helperStart = embedSource.indexOf("async function completeIndexInventory(");
    const helperEnd = embedSource.indexOf("/** Raw per-file counters", helperStart);
    const helper = helperStart >= 0 && helperEnd > helperStart ? embedSource.slice(helperStart, helperEnd) : "";
    expect(helper, "completeIndexInventory not found").not.toBe("");
    expect(helper).toContain("listFilesByExtensionsBounded(");
    expect(helper).toContain("if (!listing.complete)");
    for (const name of ["syncEmbedDb", "syncPdfEmbedDb"] as const) {
      const body = functionBody(embedSource, name);
      expect(body, `${name} not found`).not.toBe("");
      expect(body).toContain("completeIndexInventory(");
      expect(body).not.toContain("listMarkdown(");
      expect(body).not.toContain("listFilesByExtension(");
    }
  });

  // v3.10.0-rc.24 (audit L) — `obsidian_query_base` (bases.ts `queryBase`) is an
  // always-on, bearer-reachable whole-vault CONTENT scanner, but it uses
  // `listFilesByExtension(".md")` + `readFile` (not `listMarkdown` + `readNote`),
  // so `discoverScanners` can't see it and `bases.ts` is outside SCANNER_SOURCES.
  // Assert its incremental bounded inventory + completeness refusal separately,
  // so a refactor cannot reintroduce materialize-then-cap or partial totals even
  // though the scanner heuristic does not reach this implementation shape.
  it("bases.queryBase uses a bounded inventory and rejects incomplete exact totals", () => {
    const body = functionBody(readFileSync(path.join(repoRoot, "src/bases.ts"), "utf8"), "queryBase");
    expect(body, "queryBase not found in bases.ts").not.toBe("");
    expect(body).toContain("listFilesByExtensionsBounded(");
    expect(body).toContain("MAX_SCAN_NOTES");
    expect(body).toContain("if (!listing.complete)");
    expect(body).not.toContain("listFilesByExtension(");
  });

  // DQL used to materialize the complete legacy listing and then trim it. That
  // bounded retained rows but not traversal/allocation and
  // silently made exact query results partial.  Keep the stronger class fix:
  // admission happens in the walker and an incomplete inventory is an error.
  it("dql.runDql uses a bounded inventory and rejects incomplete query results", () => {
    const body = functionBody(readFileSync(path.join(repoRoot, "src/dql.ts"), "utf8"), "runDql");
    expect(body, "runDql not found in dql.ts").not.toBe("");
    expect(body).toContain("listFilesByExtensionsBounded(");
    expect(body).toContain("MAX_DQL_SCAN_FILES");
    expect(body).toContain("MAX_DQL_VISITED_ENTRIES");
    expect(body).toContain("if (!listing.complete)");
    expect(body).not.toContain("listMarkdown(");
    expect(body).not.toContain("capScanEntries(");
  });

  it("meta.getOpenQuestions bounds discovery, collection, regex batches, and retained top-K", () => {
    const body = functionBody(readFileSync(path.join(repoRoot, "src/tools/meta.ts"), "utf8"), "getOpenQuestions");
    expect(body, "getOpenQuestions not found in meta.ts").not.toBe("");
    for (const token of [
      "listFilesByExtensionsBounded(",
      "if (!listing.complete)",
      "maxNotes",
      "maxVisitedEntries",
      "maxTextUtf8Bytes",
      "maxLines",
      "maxLineUtf8Bytes",
      "maxCandidates",
      "maxCandidateUtf8Bytes",
      "flushCandidateBatch",
      "retainOldestOpenQuestion"
    ]) {
      expect(body, `getOpenQuestions lost resource admission token ${token}`).toContain(token);
    }
    expect(body).not.toContain("capScanEntries(");
    expect(body).not.toMatch(/const\s+candidates\s*=/u);
    expect(body).not.toMatch(/const\s+lineTexts\s*=/u);
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
    const missing = [...Object.keys(CAPPED), ...Object.keys(BOUNDED)].filter((n) => !discovered.has(n));
    expect(missing, `classified tools no longer detected as whole-vault scanners: ${missing.join(", ")}`).toEqual([]);
  });

  it("legacy materialize-then-cap helper is absent from production", () => {
    const limits = readFileSync(path.join(repoRoot, "src/tools/limits.ts"), "utf8");
    expect(limits).not.toContain("function capScanEntries");
    for (const file of SCANNER_SOURCES) {
      expect(readFileSync(path.join(repoRoot, file), "utf8")).not.toContain("capScanEntries(");
    }
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
    const classified = new Set([...Object.keys(CAPPED), ...Object.keys(BOUNDED), ...Object.keys(EXEMPT)]);
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

    // Same requirement, current vocabulary: a scanner written the way production
    // writes them today (listFilesByExtensionsBounded + readNoteUncached) must also be
    // discovered. Until this assertion existed the detector matched only the legacy
    // names, so FIVE live scanners were invisible while every assertion in this file
    // stayed green — the gate kept reporting on a set it had quietly stopped seeing.
    const modernSrc = [
      "export async function modernShapedTool(vault) {",
      '  const listing = await vault.listFilesByExtensionsBounded([".md"], 10, 40);',
      "  for (const e of listing.entries) {",
      "    const { parsed } = await vault.readNoteUncached(e.absPath, e.mtimeMs);",
      "    void parsed;",
      "  }",
      "}",
      ""
    ].join("\n");
    expect(discoverScanners(modernSrc)).toContain("modernShapedTool");
    // …and the legacy-only predicate this file shipped with would NOT have found it.
    // Pin that, so the finding survives as a fact rather than as a comment.
    expect(/\.listMarkdown\(|listExactScanEntries\(/.test(modernSrc)).toBe(false);
    expect(/\.readNote\(/.test(modernSrc)).toBe(false);
  });

  // NEGATIVE control: the cap-token check must FLAG a capped function that drops
  // bounded, complete discovery.
  it("NEGATIVE control — cap-token check flags a CAPPED body that lost its constant", () => {
    const buggyBody = "export async function findSimilar(v) {\n  const entries = await v.listMarkdown();\n}";
    expect(buggyBody.includes("listExactScanEntries")).toBe(false); // would be reported as an offender
  });
});
