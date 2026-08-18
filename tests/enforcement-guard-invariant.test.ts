// v3.10.0-rc.3 — ENFORCEMENT-GUARANTEE → CODE-GUARD INVARIANT.
//
// Generalizes OIA Check 4d (SLSA-level) + 4e (OCR-offline) into a curated
// inventory: every load-bearing SECURITY.md guarantee must (a) still be PRESENT
// in SECURITY.md AND (b) point to a named code-guard symbol that EXISTS in src.
// Closes the overclaim #15/#16 class — a doc that claims an ENFORCED guarantee
// ("blocked", "rejected", "fails closed", "0600", a named cap) that no code
// path actually backs. It's the most externally-verifiable overclaim class
// (an auditor reads the claim → checks the code), so it gets a permanent gate.
//
// DELIBERATELY CURATED, not a full-prose scan of SECURITY.md. A blanket grep
// for enforcement verbs over free prose is high-false-positive (most such
// sentences are descriptive context, not enforced guarantees) — the exact
// noise the rc.36 meta-audit warned against. So this pins the ~dozen
// load-bearing guarantees to their guards; a genuinely NEW guarantee is added
// by a human who must add a manifest entry (the same inventory discipline as
// erasure-invariant / resource-bound-invariant). Completeness over ALL prose
// is an accepted non-goal; the value is that the KEY guarantees can't silently
// lose their guard (a rename/refactor that drops the guard fails CI).

import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { replaceExactly } from "./helpers/exact-source-mutation.js";

const repoRoot = path.resolve(__dirname, "..");

/** Concatenated text of every `src/**.ts` — the guard-symbol search space. */
function srcBlob(): string {
  const parts: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts")) parts.push(readFileSync(p, "utf8"));
    }
  };
  walk(path.join(repoRoot, "src"));
  return parts.join("\n");
}

// Each entry: a SECURITY.md `marker` (distinctive substring of the guarantee)
// + a `symbol` that MUST exist in src/ as the code guard enforcing it.
const GUARANTEES: Array<{ label: string; marker: string; symbol: string }> = [
  { label: "path/symlink escape rejected", marker: "resolve outside are rejected", symbol: "resolveSafePath" },
  {
    label: "hidden/reserved vault paths excluded centrally",
    marker: "Hidden and reserved path segments are never part",
    symbol: "restrictedVaultPathReason"
  },
  {
    label: "persisted search evidence receives live physical admission",
    marker: "Persisted search evidence is re-admitted live",
    symbol: "filterLiveVaultHits"
  },
  {
    label: "mutations repeat final physical admission",
    marker: "repeat physical admission before their content-bearing write or move step",
    symbol: "assertMutationPathPublic"
  },
  { label: "OCR offline — CDN path blocked", marker: "blocks that path entirely", symbol: "assertOcrLangsInstalled" },
  { label: "OCR worker read-only cache", marker: "cacheMethod", symbol: "cacheMethod" },
  { label: "OCR canvas-dimension clamp (OOM)", marker: "MAX_OCR_CANVAS_DIM", symbol: "MAX_OCR_CANVAS_DIM" },
  { label: "OCR per-call page cap", marker: "DEFAULT_OCR_MAX_PAGES", symbol: "DEFAULT_OCR_MAX_PAGES" },
  { label: "restrictive file mode 0600", marker: "0600", symbol: "0o600" },
  { label: "restrictive dir mode 0700", marker: "0700", symbol: "0o700" },
  // v3.10.0-rc.54 — rc.53 dropped gray-matter + js-yaml@3's `SAFE_SCHEMA`; YAML now parses via
  // js-yaml@5's default `load` (YAML 1.2 core schema, safe-by-default — no `!!js/function` code-exec
  // tag). The guard symbol is the `js-yaml` import (the safe default API, not a custom schema re-enabling unsafe tags).
  {
    label: "YAML parsed via js-yaml@5 safe `load` (no !!js/function code-exec)",
    marker: "!!js/function",
    symbol: "js-yaml"
  },
  { label: "HTTP session idle eviction (memory bound)", marker: "Idle eviction", symbol: "sweepIdle" },
  {
    label: "invalid HTTP Origin rejected before request handling",
    marker: "present invalid Origin",
    symbol: "isRequestOriginAllowed"
  }
];

/** null = OK; else an explanation of the broken claim↔guard link. */
function checkGuarantee(
  g: { label: string; marker: string; symbol: string },
  security: string,
  src: string
): string | null {
  if (!security.includes(g.marker)) {
    return `SECURITY.md no longer contains "${g.marker}" — the "${g.label}" guarantee was reworded/removed; update this manifest.`;
  }
  if (!src.includes(g.symbol)) {
    return `code guard "${g.symbol}" for "${g.label}" is MISSING from src — SECURITY.md claims an enforcement nothing backs (overclaim #15/#16 class).`;
  }
  return null;
}

/** Inventory every persisted-content egress boundary that must carry a live receipt. */
function persistedEgressGuardViolations(search: string): string[] {
  const region = (start: string, end: string): string => {
    const from = search.indexOf(start);
    const to = search.indexOf(end, from + start.length);
    return from >= 0 && to > from ? search.slice(from, to) : "";
  };
  const checks: Array<{ label: string; body: string; needles: string[] }> = [
    {
      label: "standalone embeddings plus current DB hydration",
      body: region("export async function embeddingsSearch(", "// ─── obsidian_search"),
      needles: [
        "let rawHits: EmbedReceiptSearchHit[];",
        'let hnswResultsToReceiptHits: typeof import("../hnsw.js").hnswResultsToReceiptHits | null = null;',
        "const hydratedRows = db.getSearchRowsByIds(labels);",
        "let h = hnswResultsToReceiptHits({ labels, distances }, hydratedRows);",
        "rawHits = db.searchWithReceipts(qVec, overFetch, { folder: args.folder, minScore });",
        "const hits = await filterLiveVaultHits(",
        "(hit) => hit,",
        "(receipts) => db.currentSourceReceiptMask(receipts)",
        "embedHitReceipts.set(match, {",
        "rel_path: h.rel_path,",
        "kind: h.kind,",
        "indexed_mtime_ms: h.indexed_mtime_ms,",
        "indexed_revision: h.indexed_revision"
      ]
    },
    {
      label: "diagnostic FTS",
      body: region("export async function searchLiveFts(", "export async function readLiveFtsChunk("),
      needles: [
        "const rawMatches = idx.searchWithReceipts(args.query, {",
        "const admittedMatches = await filterLiveVaultHits(",
        "(match) => match,",
        "(receipts) => idx.currentSourceReceiptMask(receipts)",
        "return admittedMatches.map((match) => ({"
      ]
    },
    {
      label: "chunk resource",
      body: region("export async function readLiveFtsChunk(", "/** v3.10 (rc.10)"),
      needles: [
        "const chunk = idx.getChunkWithReceipt(relPath, chunkIndex);",
        "const stat = await vault.stat(relPath);",
        "stat.mtimeMs !== chunk.indexed_mtime_ms",
        "!idx.isCurrentSourceReceipt(",
        "chunk.kind,",
        "chunk.indexed_mtime_ms,",
        "chunk.indexed_revision"
      ]
    },
    {
      label: "hybrid BM25 arm",
      body: region("// ─── BM25 (FTS5)", "// ─── TF-IDF"),
      needles: [
        "const rawFtsHits = ctx.ftsIndex.searchWithReceipts(args.query, { limit: fanOutK, folder: args.folder });",
        "const ftsHits = await filterLiveVaultHits(",
        "(hit) => hit,",
        "currentSourceReceiptMask(receipts)",
        "indexed_mtime_ms: h.indexed_mtime_ms,",
        "indexed_revision: h.indexed_revision"
      ]
    },
    {
      label: "hybrid embeddings receipt propagation",
      body: region("// ─── ML embeddings (if .embed.db exists)", "// ─── RRF fusion"),
      needles: [
        "const receipt = embedHitReceipts.get(m);",
        'throw new Error("Embedding hit lost its internal source-generation receipt");',
        "indexed_mtime_ms: receipt.indexed_mtime_ms,",
        "indexed_revision: receipt.indexed_revision"
      ]
    },
    {
      label: "hybrid final receipt association and atomic masks",
      body: region("async function filterCurrentHybridHits(", "/**\n * Hybrid retrieval"),
      needles: [
        "ftsIndex: FtsIndex | null,",
        "embedReceiptReader: EmbedReceiptReader | null",
        "receipts?.bm25 === undefined ||",
        "receipts.bm25.rel_path !== hit.path ||",
        "receipts.bm25.kind !== hit.kind ||",
        "!Number.isFinite(receipts.bm25.indexed_mtime_ms) ||",
        "!Number.isSafeInteger(receipts.bm25.indexed_revision)",
        "hit.per_signal.embeddings &&",
        "receipts?.embeddings === undefined ||",
        "receipts.embeddings.rel_path !== hit.path ||",
        "receipts.embeddings.kind !== hit.kind ||",
        "!Number.isFinite(receipts.embeddings.indexed_mtime_ms) ||",
        "!Number.isSafeInteger(receipts.embeddings.indexed_revision)",
        "live.mtimeMs !== receipt.indexed_mtime_ms",
        "ftsIndex.currentSourceReceiptMask(ftsEntries.map((e) => e.receipt))",
        "embedReceiptReader.currentSourceReceiptMask(embedEntries.map((e) => e.receipt))",
        "if (ftsMask[index] !== true) stale.add(hit);",
        "if (embedMask[index] !== true) stale.add(hit);",
        "return liveHits.filter((hit) => !stale.has(hit));"
      ]
    },
    {
      label: "hybrid read-only embed receipt reader",
      body: region("async function openHybridEmbedReceiptReader(", "/**\n * Envelope returned by"),
      needles: [
        "hybridHitGenerationReceipts.get(hit)?.embeddings !== undefined",
        'await import("../embed-db.js")',
        "return await openEmbedReceiptReader(embedFile, vault.root);"
      ]
    },
    {
      label: "single hybrid terminal generation admission",
      body: region("export async function searchHybrid(", "export async function searchHybridMulti("),
      needles: [
        "indexed_mtime_ms: bm.indexed_mtime_ms,",
        "indexed_revision: bm.indexed_revision",
        "indexed_mtime_ms: emb.indexed_mtime_ms,",
        "indexed_revision: emb.indexed_revision",
        "hybridHitGenerationReceipts.set(hit, generationReceipts);",
        "const embedReceiptReader = await openHybridEmbedReceiptReader(vault, ctx.embedFile, matches);",
        "currentMatches = await filterCurrentHybridHits(vault, matches, ctx.ftsIndex, embedReceiptReader);",
        "embedReceiptReader?.close();",
        "if (match.explain) match.explain.final_rank = finalRank;",
        "matches: currentMatches"
      ]
    },
    {
      label: "multi hybrid terminal generation admission",
      body: region("export async function searchHybridMulti(", "/**\n * Build a fixed-width snippet"),
      needles: [
        "hybridHitGenerationReceipts.set(cloned, receipts);",
        "const embedReceiptReader = await openHybridEmbedReceiptReader(vault, ctx.embedFile, matches);",
        "currentMatches = await filterCurrentHybridHits(vault, matches, ctx.ftsIndex, embedReceiptReader);",
        "embedReceiptReader?.close();",
        "matches: currentMatches"
      ]
    }
  ];
  const violations = checks.flatMap(({ label, body, needles }) => {
    if (!body) return [`${label}: route region missing`];
    return needles.filter((needle) => !body.includes(needle)).map((needle) => `${label}: missing ${needle}`);
  });

  for (const { label, body, needles } of [
    {
      label: "standalone embeddings plus current DB hydration",
      body: region("export async function embeddingsSearch(", "// ─── obsidian_search"),
      needles: ["hnswResultsToHits({ labels, distances }", "rawHits = db.search("]
    },
    {
      label: "diagnostic FTS",
      body: region("export async function searchLiveFts(", "export async function readLiveFtsChunk("),
      needles: ["const rawMatches = idx.search("]
    },
    {
      label: "chunk resource",
      body: region("export async function readLiveFtsChunk(", "/** v3.10 (rc.10)"),
      needles: ["const chunk = idx.getChunk("]
    },
    {
      label: "hybrid BM25 arm",
      body: region("// ─── BM25 (FTS5)", "// ─── TF-IDF"),
      needles: ["const rawFtsHits = ctx.ftsIndex.search("]
    }
  ]) {
    for (const needle of needles) {
      if (body.includes(needle)) violations.push(`${label}: forbidden legacy receipt egress via ${needle}`);
    }
  }

  const sharedFilter = region("export async function filterLiveVaultHits", "/**\n * Query the persistent FTS index");
  const sharedStats = sharedFilter.indexOf("const batchVerdicts = await Promise.all(");
  const sharedMask = sharedFilter.indexOf("const mask = currentReceiptMask(", sharedStats);
  const sharedMaskUse = sharedFilter.indexOf("mask[index] === true", sharedMask);
  const sharedReturn = sharedFilter.indexOf("return admitted.filter(", sharedMask);
  if (!(sharedStats >= 0 && sharedMask > sharedStats && sharedMaskUse > sharedMask && sharedReturn > sharedMask)) {
    violations.push("shared persisted-hit admission: terminal order broken");
  } else if (sharedFilter.slice(sharedMask, sharedReturn).includes("await ")) {
    violations.push("shared persisted-hit admission: await after receipt mask");
  }

  const finalFilter = region("async function filterCurrentHybridHits(", "/**\n * Hybrid retrieval");
  const liveStats = finalFilter.indexOf("const admitted = await Promise.all(");
  const ftsMask = finalFilter.indexOf("ftsIndex.currentSourceReceiptMask(", liveStats);
  const embedMask = finalFilter.indexOf("embedReceiptReader.currentSourceReceiptMask(", liveStats);
  const finalReturn = finalFilter.indexOf("return liveHits.filter((hit) => !stale.has(hit));", liveStats);
  if (
    !(
      liveStats >= 0 &&
      ftsMask > liveStats &&
      embedMask > liveStats &&
      finalReturn > ftsMask &&
      finalReturn > embedMask
    )
  ) {
    violations.push("hybrid final receipt association and atomic masks: terminal order broken");
  } else if (finalFilter.slice(Math.min(ftsMask, embedMask), finalReturn).includes("await ")) {
    violations.push("hybrid final receipt association and atomic masks: await after receipt mask");
  }

  for (const [label, body, publicReturn] of [
    [
      "single hybrid terminal generation admission",
      region("export async function searchHybrid(", "export async function searchHybridMulti("),
      "return response;"
    ],
    [
      "multi hybrid terminal generation admission",
      region("export async function searchHybridMulti(", "/**\n * Build a fixed-width snippet"),
      "return {"
    ]
  ] as const) {
    const readerOpen = body.indexOf("const embedReceiptReader = await openHybridEmbedReceiptReader(");
    const terminal = body.indexOf(
      "currentMatches = await filterCurrentHybridHits(vault, matches, ctx.ftsIndex, embedReceiptReader);",
      readerOpen
    );
    const close = body.indexOf("embedReceiptReader?.close();", terminal);
    const returned = body.indexOf(publicReturn, close);
    if (!(readerOpen >= 0 && terminal > readerOpen && close > terminal && returned > close)) {
      violations.push(`${label}: reader/filter/close/return order broken`);
    } else if (body.slice(close, returned).includes("await ")) {
      violations.push(`${label}: await after terminal receipt validation`);
    }
  }
  return violations;
}

/** Public result construction must strip both halves of the internal receipt. */
function publicReceiptLeakViolations(search: string, registry: string): string[] {
  const slice = (text: string, start: string, end: string): string => {
    const from = text.indexOf(start);
    const to = text.indexOf(end, from + start.length);
    return from >= 0 && to > from ? text.slice(from, to) : "";
  };
  const sections = [
    {
      label: "diagnostic FTS helper",
      body: slice(search, "return admittedMatches.map((match) => ({", "  }));\n}\n\n/**\n * Read one stored FTS chunk")
    },
    {
      label: "diagnostic FTS map",
      body: slice(registry, "const matches = admittedMatches.map((match) => ({", "      }));")
    },
    {
      label: "standalone embedding match",
      body: slice(search, "const match: EmbedHit = {", "      };")
    },
    {
      label: "hybrid public hit",
      body: slice(search, "const hit: SearchHybridHit = {", "    };")
    },
    {
      label: "chunk public payload",
      body: slice(search, "return {\n    rel_path: relPath,", "  };\n}\n\n/** v3.10 (rc.10)")
    }
  ];
  return sections.flatMap(({ label, body }) => {
    if (!body) return [`${label}: result-construction region missing`];
    const leaked = ["indexed_mtime_ms", "indexed_revision"].filter((field) => body.includes(field));
    return leaked.map((field) => `${label}: leaked ${field}`);
  });
}

/** Pin embedding-namespace admission ahead of every direct exported-route I/O boundary. */
function embedNamespaceAdmissionViolations(sources: {
  search: string;
  meta: string;
  doctor: string;
  evalSource: string;
}): string[] {
  const after = (source: string, marker: string): string => {
    const start = source.indexOf(marker);
    return start < 0 ? "" : source.slice(start);
  };
  const routes = [
    {
      label: "embeddingsSearch",
      body: after(sources.search, "export async function embeddingsSearch("),
      admission: "if (embedFile !== null) assertEmbedDbFilePath(embedFile);",
      io: ["await vault.ensureExists()"]
    },
    {
      label: "searchHybrid",
      body: after(sources.search, "export async function searchHybrid("),
      admission: "if (ctx.embedFile !== null) assertEmbedDbFilePath(ctx.embedFile);",
      io: ["await vault.ensureExists()", 'import("node:fs")']
    },
    {
      label: "searchHybridMulti",
      body: after(sources.search, "export async function searchHybridMulti("),
      admission: "if (ctx.embedFile !== null) assertEmbedDbFilePath(ctx.embedFile);",
      io: ['import("../rrf.js")']
    },
    {
      label: "contextPack",
      body: after(sources.meta, "export async function contextPack("),
      admission: "if (ctx.embedFile !== null) assertEmbedDbFilePath(ctx.embedFile);",
      io: ["await vault.ensureExists()"]
    },
    {
      label: "runDoctor",
      body: after(sources.doctor, "export async function runDoctor("),
      admission: "if (opts.embedFile !== undefined) assertEmbedDbFilePath(opts.embedFile);",
      io: ["new Vault(opts.vault"]
    },
    {
      label: "runEval",
      body: after(sources.evalSource, "export async function runEval("),
      admission: "assertEmbedDbFilePath(opts.embedFile);",
      io: ["validateEvalQueryCohort(opts.queries)", "await searchHybrid("]
    }
  ];
  return routes.flatMap(({ label, body, admission, io }) => {
    if (!body) return [`${label}: source region missing`];
    const admittedAt = body.indexOf(admission);
    if (admittedAt < 0) return [`${label}: embedding namespace admission missing`];
    return io.flatMap((boundary) => {
      const ioAt = body.indexOf(boundary);
      if (ioAt < 0) return [`${label}: I/O boundary ${boundary} missing`];
      return admittedAt < ioAt ? [] : [`${label}: namespace admission occurs after ${boundary}`];
    });
  });
}

/** Pin FTS namespace admission ahead of constructor state and readonly filesystem/native boundaries. */
function ftsNamespaceAdmissionViolations(sources: { fts: string; doctor: string }): string[] {
  const after = (source: string, startMarker: string, endMarker?: string): string => {
    const start = source.indexOf(startMarker);
    if (start < 0) return "";
    if (endMarker === undefined) return source.slice(start);
    const end = source.indexOf(endMarker, start + startMarker.length);
    return end > start ? source.slice(start, end) : "";
  };
  const routes = [
    {
      label: "FtsIndex constructor",
      body: after(
        sources.fts,
        "  constructor(opts: { file: string; vaultRoot: string; tokenize?: TokenizeMode })"
      ),
      admission: "assertFtsIndexFilePath(opts.file);",
      boundaries: ["this.file = opts.file;"]
    },
    {
      label: "discoverFtsIndexConfig",
      body: after(
        sources.fts,
        "export async function discoverFtsIndexConfig(",
        "export async function peekFtsMetaSafe(\n"
      ),
      admission: "assertFtsIndexFilePath(file);",
      boundaries: ["await preflightSqliteArtifactFamily(file)", 'await import("better-sqlite3")']
    },
    {
      label: "peekFtsMetaSafe",
      body: after(sources.fts, "export async function peekFtsMetaSafe(\n"),
      admission: "assertFtsIndexFilePath(file);",
      boundaries: ["await preflightSqliteArtifactFamily(file)", 'await import("better-sqlite3")']
    },
    {
      label: "runDoctor",
      body: after(sources.doctor, "export async function runDoctor("),
      admission: "if (opts.indexFile !== undefined) assertFtsIndexFilePath(opts.indexFile);",
      boundaries: ["new Vault(opts.vault"]
    }
  ];
  return routes.flatMap(({ label, body, admission, boundaries }) => {
    if (!body) return [`${label}: source region missing`];
    const admittedAt = body.indexOf(admission);
    if (admittedAt < 0) return [`${label}: FTS namespace admission missing`];
    return boundaries.flatMap((boundary) => {
      const boundaryAt = body.indexOf(boundary);
      if (boundaryAt < 0) return [`${label}: boundary ${boundary} missing`];
      return admittedAt < boundaryAt ? [] : [`${label}: namespace admission occurs after ${boundary}`];
    });
  });
}

/** Keep six sensitive writers from inferring directory ownership then path-chmodding a race winner. */
function writerParentModeProblems(sources: {
  vault: string;
  feedback: string;
  hnsw: string;
  fts: string;
  embed: string;
  watcherGuard: string;
}): string[] {
  const between = (source: string, startMarker: string, endMarker: string): string => {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    return start >= 0 && end > start ? source.slice(start, end) : "";
  };
  const routes = [
    {
      label: "Vault parse cache",
      body: between(
        sources.vault,
        "  private async saveDiskCacheOnce(file: string)",
        "  /**\n   * Resolve a vault-relative"
      ),
      mkdir: "await this.mkdirSafe(cacheDir, { recursive: true, mode: 0o700 });",
      forbidden: ["parentExisted", "statSafe(cacheDir", "fs.stat(cacheDir", "chmod(cacheDir"]
    },
    {
      label: "Feedback",
      body: between(sources.feedback, "  private async writeOnce()", "\n  }\n}"),
      mkdir: "await fs.mkdir(dir, { recursive: true, mode: 0o700 });",
      forbidden: ["dirExisted", "fs.stat(dir", "fs.chmod(dir"]
    },
    {
      label: "HNSW",
      body: between(sources.hnsw, "    async saveTo(file", "interface HnswMetaPointer"),
      mkdir: "await fs.mkdir(parentDir, { recursive: true, mode: 0o700 });",
      forbidden: ["parentExisted", "fs.stat(parentDir", "fs.chmod(parentDir"]
    },
    {
      label: "FTS",
      body: between(
        sources.fts,
        "  async open(expectedDiscovery?: FtsIndexDiscovery)",
        "  /**\n   * Remove the index file"
      ),
      mkdir: "await fs.mkdir(parentDir, { recursive: true, mode: 0o700 });",
      forbidden: ["parentExisted", "fs.stat(parentDir", "fs.chmod(parentDir"]
    },
    {
      label: "EmbedDb",
      body: between(
        sources.embed,
        "  async open(expectedDiscovery?: EmbedDbConfigDiscovery)",
        "  /**\n   * Remove the embed db"
      ),
      mkdir: "await fs.mkdir(parentDir, { recursive: true, mode: 0o700 });",
      forbidden: ["parentExisted", "fs.stat(parentDir", "fs.chmod(parentDir"]
    },
    {
      label: "watcher guard",
      body: between(
        sources.watcherGuard,
        "export async function armWatcherActivationGuard(",
        "export async function releaseWatcherActivationGuard("
      ),
      mkdir: "await fs.mkdir(guardPath, { mode: 0o700 });",
      forbidden: ["fs.stat(guardPath", "fs.chmod(guardPath"]
    }
  ];
  return routes.flatMap(({ label, body, mkdir, forbidden }) => {
    if (!body) return [`${label}: writer region missing`];
    const problems = body.includes(mkdir) ? [] : [`${label}: mode-0700 mkdir missing`];
    return problems.concat(
      forbidden.filter((needle) => body.includes(needle)).map((needle) => `${label}: forbidden ${needle}`)
    );
  });
}

describe("enforcement-guarantee → code-guard invariant (rc.3, overclaim #15/#16 class)", () => {
  it("every curated SECURITY.md guarantee still maps to a present code guard", () => {
    const security = readFileSync(path.join(repoRoot, "SECURITY.md"), "utf8");
    const src = srcBlob();
    const offenders = GUARANTEES.map((g) => checkGuarantee(g, security, src)).filter(Boolean) as string[];
    expect(offenders, offenders.join("\n")).toEqual([]);
    const registry = readFileSync(path.join(repoRoot, "src/tool-registry.ts"), "utf8");
    const hnsw = readFileSync(path.join(repoRoot, "src/hnsw.ts"), "utf8");
    const search = readFileSync(path.join(repoRoot, "src/tools/search.ts"), "utf8");
    const meta = readFileSync(path.join(repoRoot, "src/tools/meta.ts"), "utf8");
    const doctor = readFileSync(path.join(repoRoot, "src/doctor.ts"), "utf8");
    const evalSource = readFileSync(path.join(repoRoot, "src/eval.ts"), "utf8");
    const vault = readFileSync(path.join(repoRoot, "src/vault.ts"), "utf8");
    const feedback = readFileSync(path.join(repoRoot, "src/feedback.ts"), "utf8");
    const fts = readFileSync(path.join(repoRoot, "src/fts5.ts"), "utf8");
    const embed = readFileSync(path.join(repoRoot, "src/embed-db.ts"), "utf8");
    const watcherGuard = readFileSync(path.join(repoRoot, "src/watcher-activation-guard.ts"), "utf8");
    expect(registry).toContain("const admittedMatches = await searchLiveFts(vault, idx, {");
    expect(registry).toContain("const matches = admittedMatches.map((match) => ({");
    expect(registry).not.toContain("matches: admittedMatches");
    const diagnosticMapStart = registry.indexOf("const matches = admittedMatches.map((match) => ({");
    const diagnosticMapEnd = registry.indexOf("      }));", diagnosticMapStart);
    expect(diagnosticMapStart).toBeGreaterThanOrEqual(0);
    expect(diagnosticMapEnd).toBeGreaterThan(diagnosticMapStart);
    const diagnosticMap = registry.slice(diagnosticMapStart, diagnosticMapEnd);
    expect(diagnosticMap).not.toContain("...match");
    expect(diagnosticMap).not.toContain("indexed_mtime_ms");
    expect(diagnosticMap).not.toContain("indexed_revision");
    expect(registry).toContain("const payload = await readLiveFtsChunk(vault, idx, decoded, chunkIndex);");
    expect(search).toContain("const hits = await filterLiveVaultHits(");
    expect(search).toContain("const ftsHits = await filterLiveVaultHits(");
    expect(search).toContain("const hydratedRows = db.getSearchRowsByIds(labels);");
    expect(persistedEgressGuardViolations(search)).toEqual([]);
    expect(publicReceiptLeakViolations(search, registry)).toEqual([]);
    expect(embedNamespaceAdmissionViolations({ search, meta, doctor, evalSource })).toEqual([]);
    expect(ftsNamespaceAdmissionViolations({ fts, doctor })).toEqual([]);
    expect(writerParentModeProblems({ vault, feedback, hnsw, fts, embed, watcherGuard })).toEqual([]);
    expect(hnsw).toContain('rowByLabel: ReadonlyMap<number, Omit<EmbedReceiptSearchHit, "score">>');
    expect(hnsw).toContain("indexed_mtime_ms: row.indexed_mtime_ms,");
    expect(hnsw).toContain("indexed_revision: row.indexed_revision");
    const embeddingsCore = search.indexOf("export async function embeddingsSearch(");
    const hnswHydration = search.indexOf("const hydratedRows = db.getSearchRowsByIds(labels);", embeddingsCore);
    const hnswConversion = search.indexOf(
      "let h = hnswResultsToReceiptHits({ labels, distances }, hydratedRows);",
      hnswHydration
    );
    const embedTerminalMask = search.indexOf("(receipts) => db.currentSourceReceiptMask(receipts)", hnswConversion);
    expect(embeddingsCore).toBeGreaterThanOrEqual(0);
    expect(hnswHydration).toBeGreaterThan(embeddingsCore);
    expect(hnswConversion).toBeGreaterThan(hnswHydration);
    expect(embedTerminalMask).toBeGreaterThan(hnswConversion);
    const ftsCore = search.indexOf("export async function searchLiveFts(");
    const ftsQuery = search.indexOf("const rawMatches = idx.searchWithReceipts(", ftsCore);
    const ftsAdmission = search.indexOf("const admittedMatches = await filterLiveVaultHits(", ftsQuery);
    const ftsReceipt = search.indexOf("(match) => match,", ftsAdmission);
    const ftsTerminalMask = search.indexOf("(receipts) => idx.currentSourceReceiptMask(receipts)", ftsReceipt);
    const ftsPublicMap = search.indexOf("return admittedMatches.map((match) => ({", ftsTerminalMask);
    expect(ftsCore).toBeGreaterThanOrEqual(0);
    expect(ftsQuery).toBeGreaterThan(ftsCore);
    expect(ftsAdmission).toBeGreaterThan(ftsQuery);
    expect(ftsReceipt).toBeGreaterThan(ftsAdmission);
    expect(ftsTerminalMask).toBeGreaterThan(ftsReceipt);
    expect(ftsPublicMap).toBeGreaterThan(ftsTerminalMask);
    const chunkCore = search.indexOf("export async function readLiveFtsChunk(");
    const chunkRead = search.indexOf("const chunk = idx.getChunkWithReceipt(relPath, chunkIndex);", chunkCore);
    const chunkAdmission = search.indexOf("const stat = await vault.stat(relPath);", chunkRead);
    const chunkReceipt = search.indexOf("stat.mtimeMs !== chunk.indexed_mtime_ms", chunkAdmission);
    const chunkRevision = search.indexOf("!idx.isCurrentSourceReceipt(", chunkReceipt);
    const chunkReturn = search.indexOf("return {", chunkRevision);
    expect(chunkCore).toBeGreaterThanOrEqual(0);
    expect(chunkRead).toBeGreaterThan(chunkCore);
    expect(chunkAdmission).toBeGreaterThan(chunkRead);
    expect(chunkReceipt).toBeGreaterThan(chunkAdmission);
    expect(chunkRevision).toBeGreaterThan(chunkReceipt);
    expect(chunkReturn).toBeGreaterThan(chunkRevision);
    expect(vault).toContain('assertMutationPathPublic(abs, "write", "destination")');
    expect(vault).toContain('assertMutationPathPublic(fromAbs, "rename", "source")');
    expect(vault).toContain('assertMutationPathPublic(toAbs, "rename", "destination")');
    expect(vault).toContain('assertMutationPathPublic(realAfterOpen, "append", "physical target")');
    const createOpen = vault.indexOf('fh = await this.openSafe(abs, "wx");');
    const createAdmission = vault.indexOf(
      'await this.assertMutationPathPublic(abs, "write", "destination");',
      createOpen
    );
    const createWrite = vault.indexOf('await fh.writeFile(content, "utf8");', createOpen);
    expect(createOpen).toBeGreaterThanOrEqual(0);
    expect(createAdmission).toBeGreaterThan(createOpen);
    expect(createWrite).toBeGreaterThan(createAdmission);
    const temporaryOpen = vault.indexOf('fh = await this.openSafe(tmp, "wx", tmpMode);');
    const temporaryAdmission = vault.indexOf(
      'await this.assertMutationPathPublic(tmp, "write", "temporary destination");',
      temporaryOpen
    );
    const temporaryWrite = vault.indexOf('await fh.writeFile(content, "utf8");', temporaryOpen);
    const overwriteDestinationAdmission = vault.indexOf(
      'await this.assertMutationPathPublic(abs, "write", "destination");',
      temporaryWrite
    );
    const overwriteMove = vault.indexOf("await this.renameSafe(tmp, abs);", overwriteDestinationAdmission);
    expect(temporaryOpen).toBeGreaterThanOrEqual(0);
    expect(temporaryAdmission).toBeGreaterThan(temporaryOpen);
    expect(temporaryWrite).toBeGreaterThan(temporaryAdmission);
    expect(overwriteDestinationAdmission).toBeGreaterThan(temporaryWrite);
    expect(overwriteMove).toBeGreaterThan(overwriteDestinationAdmission);
    const appendAdmission = vault.indexOf(
      'await this.assertMutationPathPublic(realAfterOpen, "append", "physical target");'
    );
    const appendWrite = vault.indexOf('await handle.writeFile(addition, "utf8");', appendAdmission);
    expect(appendAdmission).toBeGreaterThanOrEqual(0);
    expect(appendWrite).toBeGreaterThan(appendAdmission);
    const renameAdmission = vault.indexOf('await this.assertMutationPathPublic(toAbs, "rename", "destination");');
    const renameMutation = vault.indexOf("if (opts.overwrite) {", renameAdmission);
    expect(renameAdmission).toBeGreaterThanOrEqual(0);
    expect(renameMutation).toBeGreaterThan(renameAdmission);
  });

  // NEGATIVE control: a guarantee whose guard symbol is absent from src MUST be
  // flagged — otherwise the invariant is vacuous and an unenforced claim slips.
  it("NEGATIVE controls — flag missing guarantee and persisted-route guards", () => {
    const err = checkGuarantee(
      { label: "fake", marker: "resolve outside are rejected", symbol: "__no_such_guard_symbol__" },
      readFileSync(path.join(repoRoot, "SECURITY.md"), "utf8"),
      srcBlob()
    );
    expect(err).toMatch(/MISSING from src/);

    const search = readFileSync(path.join(repoRoot, "src/tools/search.ts"), "utf8");
    const meta = readFileSync(path.join(repoRoot, "src/tools/meta.ts"), "utf8");
    const doctor = readFileSync(path.join(repoRoot, "src/doctor.ts"), "utf8");
    const evalSource = readFileSync(path.join(repoRoot, "src/eval.ts"), "utf8");
    const registry = readFileSync(path.join(repoRoot, "src/tool-registry.ts"), "utf8");
    const vault = readFileSync(path.join(repoRoot, "src/vault.ts"), "utf8");
    const feedback = readFileSync(path.join(repoRoot, "src/feedback.ts"), "utf8");
    const hnsw = readFileSync(path.join(repoRoot, "src/hnsw.ts"), "utf8");
    const fts = readFileSync(path.join(repoRoot, "src/fts5.ts"), "utf8");
    const embed = readFileSync(path.join(repoRoot, "src/embed-db.ts"), "utf8");
    const watcherGuard = readFileSync(path.join(repoRoot, "src/watcher-activation-guard.ts"), "utf8");
    const ftsReceipt = "(match) => match,";
    const ftsMask = "(receipts) => idx.currentSourceReceiptMask(receipts)";
    expect(search).toContain(ftsReceipt);
    expect(search).toContain(ftsMask);
    expect(persistedEgressGuardViolations(search.replace(ftsReceipt, "(match) => undefined,"))).toContain(
      `diagnostic FTS: missing ${ftsReceipt}`
    );
    expect(persistedEgressGuardViolations(search.replace(ftsMask, "() => []"))).toContain(
      `diagnostic FTS: missing ${ftsMask}`
    );

    const authoritativeHydration = "let h = hnswResultsToReceiptHits({ labels, distances }, hydratedRows);";
    expect(search).toContain(authoritativeHydration);
    const legacyHnswEgress = search.replace(
      authoritativeHydration,
      "let h = hnswResultsToHits({ labels, distances }, usableHnsw.rowByLabel);"
    );
    expect(persistedEgressGuardViolations(legacyHnswEgress)).toContain(
      `standalone embeddings plus current DB hydration: missing ${authoritativeHydration}`
    );
    expect(persistedEgressGuardViolations(legacyHnswEgress)).toContain(
      "standalone embeddings plus current DB hydration: forbidden legacy receipt egress via hnswResultsToHits({ labels, distances }"
    );

    const removeSearchAdmissionAfter = (marker: string, replacement: string): string => {
      const start = search.indexOf(marker);
      expect(start).toBeGreaterThanOrEqual(0);
      return `${search.slice(0, start)}${search
        .slice(start)
        .replace("if (ctx.embedFile !== null) assertEmbedDbFilePath(ctx.embedFile);", replacement)}`;
    };
    const directAdmissionMutants = [
      {
        ...{ search, meta, doctor, evalSource },
        search: search.replace("if (embedFile !== null) assertEmbedDbFilePath(embedFile);", "// admission removed")
      },
      {
        ...{ search, meta, doctor, evalSource },
        search: removeSearchAdmissionAfter("export async function searchHybrid(", "// searchHybrid admission removed")
      },
      {
        ...{ search, meta, doctor, evalSource },
        search: removeSearchAdmissionAfter(
          "export async function searchHybridMulti(",
          "// searchHybridMulti admission removed"
        )
      },
      {
        ...{ search, meta, doctor, evalSource },
        meta: meta.replace("if (ctx.embedFile !== null) assertEmbedDbFilePath(ctx.embedFile);", "// admission removed")
      },
      {
        ...{ search, meta, doctor, evalSource },
        doctor: doctor.replace(
          "if (opts.embedFile !== undefined) assertEmbedDbFilePath(opts.embedFile);",
          "// admission removed"
        )
      },
      {
        ...{ search, meta, doctor, evalSource },
        evalSource: evalSource.replace("assertEmbedDbFilePath(opts.embedFile);", "// admission removed")
      }
    ];
    for (const mutant of directAdmissionMutants) {
      expect(embedNamespaceAdmissionViolations(mutant)).not.toEqual([]);
    }

    const peekStart = fts.indexOf("export async function peekFtsMetaSafe(");
    expect(peekStart).toBeGreaterThanOrEqual(0);
    const peekMutant = `${fts.slice(0, peekStart)}${fts
      .slice(peekStart)
      .replace("assertFtsIndexFilePath(file);", "// peek admission removed")}`;
    const discoveryAfterFamilyPreflight = replaceExactly(
      fts,
      "  assertFtsIndexFilePath(file);\n" +
        "  let fileExisted: boolean;\n" +
        "  try {\n" +
        "    fileExisted = await preflightSqliteArtifactFamily(file);",
      "  let fileExisted: boolean;\n" +
        "  try {\n" +
        "    fileExisted = await preflightSqliteArtifactFamily(file);\n" +
        "    assertFtsIndexFilePath(file);"
    );
    const peekAfterFamilyPreflight = replaceExactly(
      fts,
      "  assertFtsIndexFilePath(file);\n" +
        "  try {\n" +
        "    if (!(await preflightSqliteArtifactFamily(file))) return null;",
      "  try {\n" +
        "    if (!(await preflightSqliteArtifactFamily(file))) return null;\n" +
        "    assertFtsIndexFilePath(file);"
    );
    expect(ftsNamespaceAdmissionViolations({ fts: discoveryAfterFamilyPreflight, doctor })).toContain(
      "discoverFtsIndexConfig: namespace admission occurs after await preflightSqliteArtifactFamily(file)"
    );
    expect(ftsNamespaceAdmissionViolations({ fts: peekAfterFamilyPreflight, doctor })).toContain(
      "peekFtsMetaSafe: namespace admission occurs after await preflightSqliteArtifactFamily(file)"
    );
    for (const mutant of [
      {
        fts: fts.replace("assertFtsIndexFilePath(opts.file);", "// constructor admission removed"),
        doctor
      },
      {
        fts: fts.replace("assertFtsIndexFilePath(file);", "// discovery admission removed"),
        doctor
      },
      { fts: peekMutant, doctor },
      {
        fts,
        doctor: doctor.replace(
          "if (opts.indexFile !== undefined) assertFtsIndexFilePath(opts.indexFile);",
          "// doctor FTS admission removed"
        )
      }
    ]) {
      expect(ftsNamespaceAdmissionViolations(mutant)).not.toEqual([]);
    }

    const writerSources = { vault, feedback, hnsw, fts, embed, watcherGuard };
    const parentModeMutants = [
      {
        ...writerSources,
        vault: vault.replace(
          "await this.mkdirSafe(cacheDir",
          "const parentExisted = true;\n    await this.mkdirSafe(cacheDir"
        )
      },
      {
        ...writerSources,
        feedback: feedback.replace("await fs.mkdir(dir", "await fs.stat(dir);\n      await fs.mkdir(dir")
      },
      {
        ...writerSources,
        hnsw: hnsw.replace(
          "await fs.mkdir(parentDir",
          "await fs.chmod(parentDir, 0o700);\n          await fs.mkdir(parentDir"
        )
      },
      {
        ...writerSources,
        fts: fts.replace(
          "await fs.mkdir(parentDir",
          "const parentExisted = true;\n      await fs.mkdir(parentDir"
        )
      },
      {
        ...writerSources,
        embed: embed.replace("await fs.mkdir(parentDir", "await fs.stat(parentDir);\n      await fs.mkdir(parentDir")
      },
      {
        ...writerSources,
        watcherGuard: watcherGuard.replace(
          "await fs.mkdir(guardPath",
          "await fs.chmod(guardPath, 0o700);\n    await fs.mkdir(guardPath"
        )
      }
    ];
    for (const mutant of parentModeMutants) {
      expect(writerParentModeProblems(mutant)).not.toEqual([]);
    }

    for (const [label, receiptCall, legacyCall, forbiddenCall] of [
      [
        "standalone embeddings plus current DB hydration",
        "rawHits = db.searchWithReceipts(qVec, overFetch, { folder: args.folder, minScore });",
        "rawHits = db.search(qVec, overFetch, { folder: args.folder, minScore });",
        "rawHits = db.search("
      ],
      [
        "diagnostic FTS",
        "const rawMatches = idx.searchWithReceipts(args.query, {",
        "const rawMatches = idx.search(args.query, {",
        "const rawMatches = idx.search("
      ],
      [
        "chunk resource",
        "const chunk = idx.getChunkWithReceipt(relPath, chunkIndex);",
        "const chunk = idx.getChunk(relPath, chunkIndex);",
        "const chunk = idx.getChunk("
      ],
      [
        "hybrid BM25 arm",
        "const rawFtsHits = ctx.ftsIndex.searchWithReceipts(args.query, { limit: fanOutK, folder: args.folder });",
        "const rawFtsHits = ctx.ftsIndex.search(args.query, { limit: fanOutK, folder: args.folder });",
        "const rawFtsHits = ctx.ftsIndex.search("
      ]
    ] as const) {
      expect(search).toContain(receiptCall);
      const legacyRoute = search.replace(receiptCall, legacyCall);
      expect(persistedEgressGuardViolations(legacyRoute)).toContain(`${label}: missing ${receiptCall}`);
      expect(persistedEgressGuardViolations(legacyRoute)).toContain(
        `${label}: forbidden legacy receipt egress via ${forbiddenCall}`
      );
    }

    const setRevision = "indexed_revision: h.indexed_revision";
    expect(search).toContain(setRevision);
    expect(persistedEgressGuardViolations(search.replace(setRevision, ""))).toContain(
      `standalone embeddings plus current DB hydration: missing ${setRevision}`
    );
    const setReceipt = "embedHitReceipts.set(match, {";
    expect(search).toContain(setReceipt);
    expect(persistedEgressGuardViolations(search.replace(setReceipt, "void ({"))).toContain(
      `standalone embeddings plus current DB hydration: missing ${setReceipt}`
    );
    const getReceipt = "const receipt = embedHitReceipts.get(m);";
    expect(search).toContain(getReceipt);
    expect(persistedEgressGuardViolations(search.replaceAll(getReceipt, "const receipt = undefined;"))).toContain(
      `hybrid embeddings receipt propagation: missing ${getReceipt}`
    );

    const finalEmbedMask = "embedReceiptReader.currentSourceReceiptMask(embedEntries.map((e) => e.receipt))";
    expect(search).toContain(finalEmbedMask);
    expect(persistedEgressGuardViolations(search.replace(finalEmbedMask, "[]"))).toContain(
      `hybrid final receipt association and atomic masks: missing ${finalEmbedMask}`
    );

    const sharedMaskUse = "mask[index] === true";
    expect(search).toContain(sharedMaskUse);
    expect(persistedEgressGuardViolations(search.replace(sharedMaskUse, "true"))).toContain(
      "shared persisted-hit admission: terminal order broken"
    );

    const ftsMaskUse = "if (ftsMask[index] !== true) stale.add(hit);";
    expect(search).toContain(ftsMaskUse);
    expect(persistedEgressGuardViolations(search.replace(ftsMaskUse, "void ftsMask[index];"))).toContain(
      `hybrid final receipt association and atomic masks: missing ${ftsMaskUse}`
    );
    const embedMaskUse = "if (embedMask[index] !== true) stale.add(hit);";
    expect(search).toContain(embedMaskUse);
    expect(persistedEgressGuardViolations(search.replace(embedMaskUse, "void embedMask[index];"))).toContain(
      `hybrid final receipt association and atomic masks: missing ${embedMaskUse}`
    );

    const readerOpen = "return await openEmbedReceiptReader(embedFile, vault.root);";
    expect(search).toContain(readerOpen);
    expect(persistedEgressGuardViolations(search.replace(readerOpen, "return null;"))).toContain(
      `hybrid read-only embed receipt reader: missing ${readerOpen}`
    );

    const chunkValidator = "!idx.isCurrentSourceReceipt(";
    expect(search).toContain(chunkValidator);
    expect(persistedEgressGuardViolations(search.replace(chunkValidator, "!true || ("))).toContain(
      `chunk resource: missing ${chunkValidator}`
    );

    const copyReceipts = "if (receipts) hybridHitGenerationReceipts.set(cloned, receipts);";
    expect(search).toContain(copyReceipts);
    expect(persistedEgressGuardViolations(search.replace(copyReceipts, "if (receipts) void receipts;"))).toContain(
      `multi hybrid terminal generation admission: missing hybridHitGenerationReceipts.set(cloned, receipts);`
    );

    const multiStart = search.indexOf("export async function searchHybridMulti(");
    const terminalGuard =
      "currentMatches = await filterCurrentHybridHits(vault, matches, ctx.ftsIndex, embedReceiptReader);";
    const terminal = search.indexOf(terminalGuard, multiStart);
    expect(multiStart).toBeGreaterThanOrEqual(0);
    expect(terminal).toBeGreaterThan(multiStart);
    const withoutMultiTerminal = `${search.slice(0, terminal)}currentMatches = matches;${search.slice(
      terminal + terminalGuard.length
    )}`;
    expect(persistedEgressGuardViolations(withoutMultiTerminal)).toContain(
      `multi hybrid terminal generation admission: missing ${terminalGuard}`
    );

    const diagnosticMapStart = registry.indexOf("const matches = admittedMatches.map((match) => ({");
    const diagnosticMapEnd = registry.indexOf("      }));", diagnosticMapStart);
    expect(diagnosticMapStart).toBeGreaterThanOrEqual(0);
    expect(diagnosticMapEnd).toBeGreaterThan(diagnosticMapStart);
    const diagnosticMap = registry.slice(diagnosticMapStart, diagnosticMapEnd);
    expect(diagnosticMap).not.toContain("indexed_mtime_ms");
    expect(diagnosticMap).not.toContain("indexed_revision");
    const leakedRegistry = registry.replace(
      "score: match.score,",
      "score: match.score,\n        indexed_mtime_ms: match.indexed_mtime_ms,\n        indexed_revision: match.indexed_revision,"
    );
    expect(publicReceiptLeakViolations(search, leakedRegistry)).toEqual(
      expect.arrayContaining([
        "diagnostic FTS map: leaked indexed_mtime_ms",
        "diagnostic FTS map: leaked indexed_revision"
      ])
    );
    const leakedDiagnosticHelper = search.replace(
      "    score: match.score,\n    kind: match.kind",
      "    score: match.score,\n    indexed_mtime_ms: match.indexed_mtime_ms,\n    indexed_revision: match.indexed_revision,\n    kind: match.kind"
    );
    expect(publicReceiptLeakViolations(leakedDiagnosticHelper, registry)).toEqual(
      expect.arrayContaining([
        "diagnostic FTS helper: leaked indexed_mtime_ms",
        "diagnostic FTS helper: leaked indexed_revision"
      ])
    );
  });

  // NEGATIVE control: a guarantee whose SECURITY.md marker is gone MUST be
  // flagged (so a doc rewrite that drops the claim doesn't leave a dangling guard).
  it("NEGATIVE control — flags a guarantee whose SECURITY.md marker is gone", () => {
    const err = checkGuarantee(
      { label: "fake", marker: "__not in security md__", symbol: "resolveSafePath" },
      "irrelevant security text",
      "const resolveSafePath = 1;"
    );
    expect(err).toMatch(/no longer contains/);
  });
});
