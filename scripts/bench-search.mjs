#!/usr/bin/env node
// Cold-vs-warm latency bench for obsidian_search_text.
// Builds a synthetic vault of N notes, then measures:
//   1. cold:  fresh process → first listMarkdown + first searchText
//   2. warm:  same process → 4 follow-up searchText calls
// Run: node scripts/bench-search.mjs [N]
// Default N = [100, 500, 1000].

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { searchText } from "../dist/tools.js";
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
      "alpha frontmatter status placeholder body for note " + i + ".",
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

async function bench(n) {
  const root = await buildVault(n);
  try {
    const v = new Vault(root);

    // Cold: ensureExists + first searchText (this is what 'cold-process first-query' looks like
    // because in MCP the server is spawned per session and warmed by the first call).
    const t0 = performance.now();
    await v.ensureExists();
    const tEnsure = performance.now() - t0;

    const t1 = performance.now();
    const firstResult = await searchText(v, { query: QUERIES[0] });
    const tFirst = performance.now() - t1;

    // Warm: subsequent calls hit the mtime-keyed parse cache.
    const warmTimings = [];
    for (let i = 1; i < QUERIES.length; i++) {
      const t = performance.now();
      const r = await searchText(v, { query: QUERIES[i] });
      warmTimings.push({ q: QUERIES[i], ms: performance.now() - t, hits: r.matches.length, scanned: r.scanned_notes });
    }
    const warmAvg = warmTimings.reduce((s, x) => s + x.ms, 0) / warmTimings.length;

    return {
      n,
      ensureExistsMs: tEnsure,
      coldFirstQueryMs: tFirst,
      coldFirstHits: firstResult.matches.length,
      warmAvgMs: warmAvg,
      warmTimings
    };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

console.log("# enquire-mcp search latency bench (v0.9.0)");
console.log("Direct function calls — no MCP RPC overhead in measurement.\n");

for (const n of sizes) {
  const r = await bench(n);
  console.log(`## ${n} notes`);
  console.log(`  Vault.ensureExists():   ${ms(r.ensureExistsMs)}`);
  console.log(`  cold first searchText:  ${ms(r.coldFirstQueryMs)}  (${r.coldFirstHits} hits)`);
  console.log(`  warm avg (4 queries):   ${ms(r.warmAvgMs)}`);
  console.log("  warm per-query:");
  for (const t of r.warmTimings) {
    console.log(`    "${t.q.padEnd(28)}" ${ms(t.ms).padStart(8)}  ${t.hits} hits / ${t.scanned} scanned`);
  }
  console.log("");
}
