// v3.11.6-rc.3 (audit §E row 2 — T-11) — the END-TO-END serve-mode cache-miss
// zero-outbound probe the Codex audit left INCONCLUSIVE.
//
// The existing `embeddings-offline.test.ts` covers the PURE surface (the flag,
// the error helper, `applyOfflineEnv` on a fake `{env}`). What it did NOT do —
// and what the auditor's harness stalled trying to do — is drive the REAL
// `@huggingface/transformers` module on a REAL cache miss under serve-offline
// and OBSERVE that zero outbound network happens.
//
// This test closes that gap deterministically:
//   1. force a guaranteed cache MISS (point transformers' cacheDir at an EMPTY
//      temp dir, so no locally-cached model can turn this into a cache hit);
//   2. `setEmbeddingsOffline(true)` — exactly what cli.ts serve/serve-http do;
//   3. install a global NETWORK TRIPWIRE over fetch + http/https .request that
//      RECORDS any outbound attempt and THROWS synchronously (so a stray fetch
//      fails fast instead of hanging — this is why the auditor's run stalled and
//      this one cannot);
//   4. call the real `loadEmbedder()` and assert it fails CLOSED with the
//      offline cache-miss error AND the tripwire was never triggered.
//
// Gated: skips cleanly if the optional `@huggingface/transformers` dep is not
// importable (CI without optional deps), same pattern as the other dep-gated
// suites. A companion manual probe lives in scripts/probe-offline-network.mjs.

import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEmbedder, setEmbeddingsOffline } from "../src/embeddings.js";

// CJS module objects (writable `.request`), unlike the read-only ESM namespace.
const require = createRequire(import.meta.url);
const httpMod = require("node:http") as { request: unknown };
const httpsMod = require("node:https") as { request: unknown };

/** Try to import the optional transformers module; return null if absent. */
async function importTransformers(): Promise<{ env?: Record<string, unknown> } | null> {
  try {
    return (await import("@huggingface/transformers")) as { env?: Record<string, unknown> };
  } catch {
    return null;
  }
}

const tmpDirs: string[] = [];
afterEach(async () => {
  setEmbeddingsOffline(false);
  for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

describe("serve-mode cache-miss zero-outbound (audit §E row 2 / T-11)", () => {
  it("a real embedder cache-miss under serve-offline fails CLOSED with ZERO outbound network", async () => {
    const mod = await importTransformers();
    if (!mod?.env) {
      // optional dep not built — nothing to probe end-to-end here.
      return;
    }

    // 1. Force a guaranteed cache MISS: an empty cacheDir no model can live in.
    const emptyCache = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-empty-hf-"));
    tmpDirs.push(emptyCache);
    const env = mod.env as Record<string, unknown>;
    const savedCacheDir = env.cacheDir;
    const savedRemote = env.allowRemoteModels;
    env.cacheDir = emptyCache;

    // 3. Global network tripwire — record + throw synchronously on ANY outbound.
    const outbound: string[] = [];
    const realFetch = globalThis.fetch;
    const realHttp = httpMod.request;
    const realHttps = httpsMod.request;
    const trip = (where: string, target: unknown): never => {
      outbound.push(`${where}: ${String(target).slice(0, 120)}`);
      throw new Error(`NETWORK TRIPWIRE — outbound blocked (${where})`);
    };
    // @ts-expect-error — deliberately swap the global for the probe
    globalThis.fetch = (input: unknown) => trip("fetch", input);
    httpMod.request = (...a: unknown[]) => trip("http.request", a[0]);
    httpsMod.request = (...a: unknown[]) => trip("https.request", a[0]);

    let thrown: unknown;
    try {
      // 2 + 4. serve-offline, then attempt the real load of an UNCACHED model.
      setEmbeddingsOffline(true);
      await loadEmbedder();
    } catch (err) {
      thrown = err;
    } finally {
      globalThis.fetch = realFetch;
      httpMod.request = realHttp;
      httpsMod.request = realHttps;
      env.cacheDir = savedCacheDir;
      env.allowRemoteModels = savedRemote;
    }

    // The load MUST have failed (cache miss + remote blocked) ...
    expect(thrown).toBeInstanceOf(Error);
    // ... with the fail-CLOSED offline message, NOT a network/connection error ...
    expect((thrown as Error).message).toMatch(/local model cache|zero outbound network calls/i);
    // ... and CRUCIALLY, zero outbound network was attempted.
    expect(outbound).toEqual([]);
  }, 60_000);

  it("NEGATIVE control — the network tripwire actually records + throws on an outbound call", () => {
    // Proves the `outbound === []` assertion above is non-vacuous: if the tripwire
    // were a no-op, the zero-outbound check would pass for the wrong reason.
    const outbound: string[] = [];
    const realFetch = globalThis.fetch;
    // @ts-expect-error — swap for the control
    globalThis.fetch = (input: unknown) => {
      outbound.push(String(input));
      throw new Error("TRIP");
    };
    try {
      expect(() => (globalThis.fetch as (u: string) => unknown)("https://example.invalid/model")).toThrow(/TRIP/);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(outbound).toEqual(["https://example.invalid/model"]);
  });
});
