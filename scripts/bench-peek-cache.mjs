#!/usr/bin/env node
// v3.7.0 L-1 — microbenchmark for peekEmbedDbMetaCached vs uncached.
//
// Background. `embeddingsSearch` calls peek on every invocation (since
// v3.6.4's K-1a fix). SQLite open+close is ~5-10ms on SSD; for a search
// totalling 50-200ms that's 2-20% overhead. The cached variant
// (`peekEmbedDbMetaCached`) keeps a module-level cache invalidated on
// file mtime. This bench measures the speedup.
//
// Run: `npm run build && node scripts/bench-peek-cache.mjs`
// Or:  `node --import tsx scripts/bench-peek-cache.mjs` (from src/)
//
// Output: timings for N=1000 iterations of each variant, plus the ratio.
// We assert the cached path is ≥5× faster as a sanity gate — if it isn't,
// either the cache logic regressed or the SQLite cost dropped enough to
// make the optimisation pointless.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const N = 1000;
const SPEEDUP_MIN = 5; // gate: cached must be at least 5× faster than uncached

async function main() {
  // Import after build so dist/embed-db.js exists; falling back to src/ for
  // dev runs (where tsx or node --import handle TS imports).
  let EmbedDb;
  let peekEmbedDbMeta;
  let peekEmbedDbMetaCached;
  let clearPeekCache;
  try {
    const mod = await import("../dist/embed-db.js");
    ({ EmbedDb, peekEmbedDbMeta, peekEmbedDbMetaCached, clearPeekCache } = mod);
  } catch {
    process.stderr.write("bench-peek-cache: dist/ not built; run `npm run build` first.\n");
    process.exit(2);
  }

  const tmp = await mkdtemp(join(tmpdir(), "enquire-peek-bench-"));
  const file = join(tmp, "bench.embed.db");
  // Seed an embed-db with bge meta (no vectors — meta-only is enough for peek).
  const db = new EmbedDb({ file, vaultRoot: tmp, modelAlias: "bge", dim: 384 });
  await db.open();
  db.close();

  // Warm-up — first call costs include better-sqlite3 dynamic import.
  await peekEmbedDbMeta(file);
  await peekEmbedDbMetaCached(file);
  clearPeekCache();

  // Uncached: N iterations of peekEmbedDbMeta.
  const tUnStart = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    await peekEmbedDbMeta(file);
  }
  const tUnEnd = process.hrtime.bigint();
  const uncachedMs = Number(tUnEnd - tUnStart) / 1_000_000;

  // Cached: prime cache once, then N iterations.
  clearPeekCache();
  await peekEmbedDbMetaCached(file); // prime
  const tCStart = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    await peekEmbedDbMetaCached(file);
  }
  const tCEnd = process.hrtime.bigint();
  const cachedMs = Number(tCEnd - tCStart) / 1_000_000;

  const speedup = uncachedMs / Math.max(cachedMs, 0.001);
  process.stdout.write(
    `bench-peek-cache: N=${N}\n` +
      `  uncached (peekEmbedDbMeta):       ${uncachedMs.toFixed(2)} ms total · ${(uncachedMs / N).toFixed(3)} ms/call\n` +
      `  cached   (peekEmbedDbMetaCached): ${cachedMs.toFixed(2)} ms total · ${(cachedMs / N).toFixed(4)} ms/call\n` +
      `  speedup: ${speedup.toFixed(1)}×\n`
  );

  await rm(tmp, { recursive: true, force: true });

  if (speedup < SPEEDUP_MIN) {
    process.stderr.write(
      `bench-peek-cache: ERROR — cached path only ${speedup.toFixed(1)}× faster (gate: ≥${SPEEDUP_MIN}×). ` +
        `Either the cache regressed or SQLite peek got fast enough to make the optimisation pointless.\n`
    );
    process.exit(1);
  }
  process.stdout.write(
    `bench-peek-cache: OK — cached path ${speedup.toFixed(1)}× faster than uncached (gate ≥${SPEEDUP_MIN}×).\n`
  );
}

main().catch((err) => {
  process.stderr.write(`bench-peek-cache: fatal — ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
