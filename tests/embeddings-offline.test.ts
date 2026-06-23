// v3.10.0-rc.42 (audit F1, HIGH) — the serve-mode offline ENFORCEMENT that turns the
// "zero cloud calls during serve" claim into a real code guard (mirrors OCR's
// `assertOcrLangsInstalled`, overclaim #16). Pre-rc.42 the claim was ASPIRATIONAL: a
// missing local model cache let transformers.js silently CDN-fetch (~120MB) on a
// serve-time query. Now serve/serve-http call setEmbeddingsOffline() →
// `env.allowRemoteModels=false` → a cache-miss fails CLOSED with an install hint.
//
// These tests exercise the PURE surface (flag + fail-closed error helper) so they run
// in CI WITHOUT the optional `@huggingface/transformers` dep or any model download. The
// WIRING (cli.ts serve/serve-http actually calling setEmbeddingsOffline) is
// regression-proofed structurally by OIA Check 4f. Positive + NEGATIVE controls per the
// CLAUDE.md rule since v3.6.4.

import { afterEach, describe, expect, it } from "vitest";
import {
  applyOfflineEnv,
  isEmbeddingsOffline,
  offlineModelLoadError,
  setEmbeddingsOffline
} from "../src/embeddings.js";

afterEach(() => {
  setEmbeddingsOffline(false); // module-global flag — reset so it can't leak across tests
});

describe("embeddings serve-offline enforcement (rc.42 F1)", () => {
  it("default is ONLINE so build-embeddings / install-model can download (NEGATIVE control)", () => {
    // If this defaulted to offline, the one-time model download (build-embeddings /
    // install-model) would fail closed — defeating setup. Serve must OPT IN.
    expect(isEmbeddingsOffline()).toBe(false);
  });

  it("setEmbeddingsOffline() toggles the flag serve uses to force local-cache-only (POSITIVE)", () => {
    setEmbeddingsOffline();
    expect(isEmbeddingsOffline()).toBe(true);
    setEmbeddingsOffline(false);
    expect(isEmbeddingsOffline()).toBe(false);
  });

  it("offlineModelLoadError is a fail-closed error naming the model + an actionable hint (POSITIVE)", () => {
    const err = offlineModelLoadError("multilingual", "Xenova/multilingual-e5-small", new Error("ENOENT cache miss"));
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/multilingual/);
    expect(err.message).toMatch(/Xenova\/multilingual-e5-small/);
    expect(err.message).toMatch(/zero outbound network calls/i); // restates the privacy guarantee
    expect(err.message).toMatch(/build-embeddings/); // actionable: how to populate the cache
    // rc.45 (abs-path-leak class) — the raw transformers.js cause is NOT surfaced: it can
    // embed the absolute model-cache path (host home dir). The message must NOT echo it
    // (the hfId itself legitimately contains a '/', so we assert on the cause text, not '/').
    expect(err.message).not.toMatch(/ENOENT cache miss/);
  });

  it("offlineModelLoadError does NOT leak the underlying cause / a path (rc.45 NEGATIVE control)", () => {
    const err = offlineModelLoadError("bge", "Xenova-bge", "/Users/secret/.cache/huggingface/blob fail");
    expect(err.message).not.toMatch(/raw string failure|secret|huggingface|\.cache/);
    expect(err.message).toMatch(/Xenova-bge/); // the model id (no slash) is still named
  });

  // rc.12 (rc.11-audit L-2) — the tests above cover the FLAG; this covers the WIRE-UP:
  // applyOfflineEnv must actually mutate a transformers.js-shaped `{ env }` so a
  // cache-miss fails closed (no CDN fetch). Closes the "flag set but not wired" gap the
  // auditor flagged in the project's own claimed-guarantee-vs-code-guard class.
  it("applyOfflineEnv sets allowRemoteModels=false on the transformers env when offline (POSITIVE)", () => {
    setEmbeddingsOffline(true);
    const mod = { env: { allowRemoteModels: true, allowLocalModels: false } };
    applyOfflineEnv(mod);
    expect(mod.env.allowRemoteModels).toBe(false); // CDN fetch blocked
    expect(mod.env.allowLocalModels).toBe(true); // local cache still allowed
  });

  it("applyOfflineEnv is a NO-OP when ONLINE so build-embeddings/install-model can fetch (NEGATIVE control)", () => {
    // default is online (afterEach resets); do NOT toggle offline here.
    const mod = { env: { allowRemoteModels: true, allowLocalModels: true } };
    applyOfflineEnv(mod);
    expect(mod.env.allowRemoteModels).toBe(true); // untouched — download path intact
  });
});
