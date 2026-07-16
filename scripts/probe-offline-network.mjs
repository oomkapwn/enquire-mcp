#!/usr/bin/env node
// v3.11.6-rc.3 (audit §E row 2 / T-11) — manual serve-mode cache-miss zero-outbound probe.
//
// Reproduces, outside the test runner, the claim that in serve mode a model
// cache MISS makes ZERO outbound network calls (fails closed). Run against a
// BUILT dist (`npm run build` first) with the optional transformers dep present:
//
//   node scripts/probe-offline-network.mjs
//
// Exit 0 + "PASS" ⇒ the real embedder load on a forced cache miss threw the
// fail-closed offline error and NO outbound fetch/http(s) request was attempted.
// Exit 1 ⇒ either an outbound call was attempted, or the load did not fail closed.
//
// This is the human-runnable companion to tests/serve-offline-network.test.ts.
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const httpMod = require("node:http");
const httpsMod = require("node:https");

const { loadEmbedder, setEmbeddingsOffline } = await import(path.join(root, "dist", "embeddings.js"));

let mod;
try {
  mod = await import("@huggingface/transformers");
} catch {
  console.log("SKIP — optional @huggingface/transformers not installed; nothing to probe.");
  process.exit(0);
}
if (!mod?.env) {
  console.log("SKIP — transformers module has no env; cannot force a cache miss.");
  process.exit(0);
}

const emptyCache = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-empty-hf-"));
mod.env.cacheDir = emptyCache; // force a guaranteed cache MISS

const outbound = [];
const realFetch = globalThis.fetch;
const realHttp = httpMod.request;
const realHttps = httpsMod.request;
const trip = (where, target) => {
  outbound.push(`${where}: ${String(target).slice(0, 120)}`);
  throw new Error(`NETWORK TRIPWIRE — outbound blocked (${where})`);
};
globalThis.fetch = (input) => trip("fetch", input);
httpMod.request = (...a) => trip("http.request", a[0]);
httpsMod.request = (...a) => trip("https.request", a[0]);

let thrown;
try {
  setEmbeddingsOffline(true); // exactly what serve/serve-http do
  await loadEmbedder();
} catch (err) {
  thrown = err;
} finally {
  globalThis.fetch = realFetch;
  httpMod.request = realHttp;
  httpsMod.request = realHttps;
  await fs.rm(emptyCache, { recursive: true, force: true }).catch(() => {});
}

const failedClosed = thrown instanceof Error && /local model cache|zero outbound network calls/i.test(thrown.message);

if (outbound.length === 0 && failedClosed) {
  console.log("PASS — cache-miss under serve-offline failed CLOSED with ZERO outbound network.");
  console.log(`  error: ${thrown.message.slice(0, 100)}…`);
  process.exit(0);
}
console.error("FAIL — offline zero-outbound not satisfied.");
console.error(`  outbound attempts: ${JSON.stringify(outbound)}`);
console.error(`  failed closed: ${failedClosed} (thrown: ${thrown?.message ?? "none — load did NOT fail"})`);
process.exit(1);
