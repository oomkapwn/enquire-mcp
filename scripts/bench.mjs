#!/usr/bin/env node
// Comprehensive latency benchmark for enquire's read-tool surface.
// Builds synthetic vaults at multiple scales (default: 100, 1_000, 10_000
// notes) and times each tool 5x. Reports min / p50 / max in milliseconds
// (with 5 samples "p99" would just be the max — see the honest labeling at the
// reporting site below; external-audit L-4 residual, v3.9.0-rc.28).
//
// Run:  node scripts/bench.mjs                           (default scales)
//       node scripts/bench.mjs 100 1000 5000              (custom scales)
//       node scripts/bench.mjs --quick                    (100 + 1000 only)
//
// Writes a markdown table to stdout and to `bench/results.md` so the README
// can reference concrete numbers. NOT part of CI — runs slow on 10k vaults.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import {
  findSimilar,
  getBacklinks,
  getNoteNeighbors,
  getRecentEdits,
  getVaultStats,
  listNotes,
  listTags,
  searchText,
  validateNoteProposal
} from "../dist/tools/index.js";
import { Vault } from "../dist/vault.js";

const args = process.argv.slice(2);
const sizes = args.includes("--quick")
  ? [100, 1000]
  : args.length > 0 && args[0] !== "--quick"
    ? args.map((a) => Number.parseInt(a, 10)).filter((n) => Number.isFinite(n))
    : [100, 1000, 10_000];

const RUNS = 5; // warm runs per measurement

async function buildVault(n) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `enquire-bench-${n}-`));
  // 8 folders, ~125 notes each at n=1000.
  const folders = 8;
  for (let i = 0; i < n; i++) {
    const folder = path.join(root, `Folder${i % folders}`);
    await fs.mkdir(folder, { recursive: true });
    // Every 10th note links to the "Hub" — so Hub.md gets n/10 backlinks.
    const linksToHub = i % 10 === 0 && i > 0 ? `\n\nLinks to [[Hub]] for context.\n` : "";
    // Every 5th note shares "#project" tag with the Hub for find_similar coverage.
    const tags = i % 5 === 0 ? "[project, idea]" : i % 5 === 1 ? "[archive]" : "[note]";
    const body = [
      "Lorem ipsum dolor sit amet consectetur adipiscing elit.",
      `Note ${i} mentions topic-${i % 50} and connects to topic-${(i + 7) % 50}.`,
      "The quick brown fox jumps over the lazy dog.",
      i === Math.floor(n / 2) ? "obscure-marker-XYZZY appears once." : "Filler line."
    ].join("\n");
    await fs.writeFile(
      path.join(folder, `note-${i}.md`),
      `---\ntitle: Note ${i}\nstatus: ${i % 2 ? "active" : "done"}\ntags: ${tags}\n---\n\n${body}${linksToHub}\n`
    );
  }
  // Add the Hub note.
  await fs.writeFile(
    path.join(root, "Hub.md"),
    `---\ntitle: Hub\ntags: [project, hub]\n---\n\nIndex of important notes.\n\nLinks: [[Folder0/note-0]] [[Folder1/note-1]]\n`
  );
  return root;
}

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[idx];
}

async function timeMs(label, fn) {
  // Warmup.
  await fn();
  const samples = [];
  for (let r = 0; r < RUNS; r++) {
    const t = performance.now();
    await fn();
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  // v3.9.0-rc.8 (audit S1) — with RUNS=5, quantile(s,0.99) = samples[floor(4.95)] =
  // samples[4] = the worst sample, i.e. the MAX, not a real 99th percentile (that
  // needs ~100 samples). p50 (= samples[2]) IS a true median of 5. We report
  // min / p50 / max honestly rather than mislabeling the max as "p99".
  return {
    label,
    min: samples[0],
    p50: quantile(samples, 0.5),
    max: samples[samples.length - 1]
  };
}

async function benchVault(n) {
  process.stderr.write(`\n=== building synthetic vault: ${n} notes ===\n`);
  const buildStart = performance.now();
  const root = await buildVault(n);
  process.stderr.write(`  built in ${(performance.now() - buildStart).toFixed(0)}ms\n`);

  const v = new Vault(root);
  await v.ensureExists();

  // Pick a "typical note" target for tools that need one. Every-10th note has
  // Hub backlinks; we'll bench getBacklinks against Hub itself.
  const targetPath = "Folder0/note-0.md";

  const draft = `---
title: Draft
tags: [project]
---

This draft links to [[Folder0/note-0]] and [[Folder1/note-1]] and [[NonExistent]].
Tags: #project #new-tag-stable.
`;

  const results = [];
  results.push(await timeMs("list_notes (no filter)", () => listNotes(v, { limit: 50 })));
  results.push(await timeMs("list_notes (tag=project)", () => listNotes(v, { tag: "project", limit: 50 })));
  results.push(await timeMs("search_text (linear)", () => searchText(v, { query: "obscure-marker-XYZZY" })));
  results.push(await timeMs("search_text (common)", () => searchText(v, { query: "lorem dog" })));
  results.push(await timeMs("get_recent_edits", () => getRecentEdits(v, { limit: 25 })));
  results.push(await timeMs("get_backlinks (Hub)", () => getBacklinks(v, { title: "Hub", limit: 50 })));
  results.push(await timeMs("list_tags", () => listTags(v, {})));
  results.push(await timeMs("find_similar", () => findSimilar(v, { path: targetPath, limit: 10 })));
  results.push(await timeMs("get_note_neighbors", () => getNoteNeighbors(v, { path: targetPath })));
  results.push(await timeMs("vault_stats", () => getVaultStats(v, {})));
  results.push(
    await timeMs("validate_note_proposal", () => validateNoteProposal(v, { path: "Inbox/draft.md", content: draft }))
  );

  await fs.rm(root, { recursive: true, force: true });
  return { n, results };
}

function fmt(n) {
  return n < 1 ? n.toFixed(2) : n < 10 ? n.toFixed(1) : Math.round(n).toString();
}

function renderTable(allResults) {
  const labels = allResults[0].results.map((r) => r.label);
  let md = `# enquire benchmarks\n\nLatency per tool, measured on a synthetic vault. ${RUNS} runs after a warmup; each cell is \`p50 / max\` in milliseconds (with only ${RUNS} samples a true p99 is not meaningful, so the second number is the worst observed run). Run: \`node scripts/bench.mjs\`.\n\n`;
  md +=
    "Smaller is better. Times include the read-cache warmup hit; cold first-call latency is captured on the warmup run and excluded from the samples (so these numbers reflect what an interactive agent will see on the second-and-later calls).\n\n";
  md += `Hardware: \`${os.cpus()[0]?.model ?? "unknown"}\`, Node ${process.version}.\n\n`;
  md += `| Tool | ${allResults.map((r) => `${r.n} notes (p50 / max ms)`).join(" | ")} |\n`;
  md += `|---|${allResults.map(() => "---").join("|")}|\n`;
  for (let i = 0; i < labels.length; i++) {
    md += `| \`${labels[i]}\` | ${allResults
      .map((r) => `${fmt(r.results[i].p50)} / ${fmt(r.results[i].max)}`)
      .join(" | ")} |\n`;
  }
  return md;
}

async function main() {
  // Ensure dist/ is built.
  const distExists = await fs
    .stat(path.join(process.cwd(), "dist", "tools.js"))
    .then(() => true)
    .catch(() => false);
  if (!distExists) {
    process.stderr.write("dist/ not found — run `npm run build` first.\n");
    process.exit(1);
  }

  const results = [];
  for (const n of sizes) {
    results.push(await benchVault(n));
  }

  const md = renderTable(results);
  process.stdout.write(`\n${md}\n`);

  const outDir = path.join(process.cwd(), "bench");
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, "results.md"), md);
  process.stderr.write(`\nWrote bench/results.md (${md.length} chars).\n`);
}

main().catch((err) => {
  process.stderr.write(`bench failed: ${err}\n`);
  process.exit(1);
});
