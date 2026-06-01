#!/usr/bin/env node
// Latency bench: linear scan (obsidian_search_text) vs FTS5 BM25
// (obsidian_full_text_search). Builds a synthetic vault of N notes,
// measures cold + warm for both paths.
// Run: node scripts/bench-search.mjs [N]
// Default N = [100, 500, 1000].

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { FtsIndex } from "../dist/fts5.js";
import { searchText } from "../dist/tools/index.js";
import { Vault } from "../dist/vault.js";

const sizes = process.argv[2] ? [Number.parseInt(process.argv[2], 10)] : [100, 500, 1000];

const QUERIES = [
  "lorem ipsum", // multi-word AND
  "alpha", // single-token, common
  "obscure-marker-XYZZY", // single-token, rare
  "frontmatter status", // multi-word AND
  "the" // very common single token
];

function ms(n) {
  return `${n.toFixed(1)}ms`;
}

async function buildVault(n) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `enquire-bench-${n}-`));
  for (let i = 0; i < n; i++) {
    const folder = path.join(root, `folder${Math.floor(i / 50)}`);
    await fs.mkdir(folder, { recursive: true });
    const tags = i % 3 === 0 ? "[project, alpha]" : i % 3 === 1 ? "[idea]" : "[archive]";
    const body = [
      "lorem ipsum dolor sit amet consectetur adipiscing elit.",
      `alpha frontmatter status placeholder body for note ${i}.`,
      "the quick brown fox jumps over the lazy dog.",
      i === Math.floor(n / 2) ? "obscure-marker-XYZZY appears here exactly once." : "filler line."
    ].join("\n");
    await fs.writeFile(
      path.join(folder, `note-${i}.md`),
      `---\ntitle: Note ${i}\nstatus: ${i % 2 ? "active" : "done"}\ntags: ${tags}\n---\n\n${body}\n`
    );
  }
  return root;
}

async function benchScan(v) {
  // Cold: first searchText (vault.listMarkdown + parallel reads).
  const t0 = performance.now();
  await searchText(v, { query: QUERIES[0] });
  const cold = performance.now() - t0;

  // Warm: subsequent calls hit the mtime-keyed parse cache.
  const warm = [];
  for (let i = 1; i < QUERIES.length; i++) {
    const t = performance.now();
    const r = await searchText(v, { query: QUERIES[i] });
    warm.push({ q: QUERIES[i], ms: performance.now() - t, hits: r.matches.length });
  }
  const warmAvg = warm.reduce((s, x) => s + x.ms, 0) / warm.length;
  return { cold, warm, warmAvg };
}

async function benchFts(v, dbDir) {
  const dbFile = path.join(dbDir, "bench.fts5.db");
  const idx = new FtsIndex({ file: dbFile, vaultRoot: v.root });
  await idx.open();

  // Cold: build the index from the vault.
  const t0 = performance.now();
  const entries = await v.listMarkdown();
  const live = entries.map((e) => ({ relPath: e.relPath, mtimeMs: e.mtimeMs }));
  const diff = idx.diff(live);
  for (const relPath of [...diff.added, ...diff.updated]) {
    const entry = entries.find((e) => e.relPath === relPath);
    if (!entry) continue;
    const note = await v.readNote(entry.absPath, entry.mtimeMs);
    const wikilinkTargets = note.parsed.wikilinks.map((w) => w.target).filter(Boolean);
    idx.reindexFile(relPath, entry.mtimeMs, note.content, wikilinkTargets, note.parsed.tags);
  }
  const cold = performance.now() - t0;

  // Warm: BM25 queries against the now-built index.
  const t1 = performance.now();
  idx.search(QUERIES[0]);
  const firstQuery = performance.now() - t1;

  const warm = [];
  for (let i = 1; i < QUERIES.length; i++) {
    const t = performance.now();
    const r = idx.search(QUERIES[i]);
    warm.push({ q: QUERIES[i], ms: performance.now() - t, hits: r.length });
  }
  const warmAvg = warm.reduce((s, x) => s + x.ms, 0) / warm.length;
  const stats = { totalChunks: idx.totalChunks(), totalFiles: idx.totalFiles() };
  idx.close();
  return { cold, firstQuery, warm, warmAvg, ...stats };
}

async function bench(n) {
  const root = await buildVault(n);
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-bench-fts-"));
  try {
    const v = new Vault(root);
    const t0 = performance.now();
    await v.ensureExists();
    const tEnsure = performance.now() - t0;

    const scan = await benchScan(v);
    const fts = await benchFts(v, dbDir);

    return { n, ensureMs: tEnsure, scan, fts };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(dbDir, { recursive: true, force: true });
  }
}

console.log("# enquire-mcp search bench: linear scan vs FTS5 BM25\n");
console.log("Direct function calls (no MCP RPC overhead). Synthetic vault, ~200-byte notes per file.\n");
console.log("| Vault | scan cold | scan warm avg | fts5 build | fts5 first query | fts5 warm avg | chunks |");
console.log("|-------|-----------|---------------|------------|------------------|---------------|--------|");

for (const n of sizes) {
  const r = await bench(n);
  console.log(
    `| ${String(n).padStart(5)} | ${ms(r.scan.cold).padStart(9)} | ${ms(r.scan.warmAvg).padStart(13)} | ${ms(r.fts.cold).padStart(10)} | ${ms(r.fts.firstQuery).padStart(16)} | ${ms(r.fts.warmAvg).padStart(13)} | ${String(r.fts.totalChunks).padStart(6)} |`
  );
}

console.log("\nLegend:");
console.log("- scan cold:        first searchText() call — full vault walk + parallel reads");
console.log("- scan warm avg:    avg over 4 follow-ups (mtime cache hits but still O(N) scan)");
console.log("- fts5 build:       cold-build the FTS5 index from scratch (one-time cost per vault)");
console.log("- fts5 first query: first BM25 search after index is built");
console.log("- fts5 warm avg:    avg over 4 follow-up BM25 queries");
console.log("- chunks:           total chunks indexed (paragraph-level, ~4KB max)");
