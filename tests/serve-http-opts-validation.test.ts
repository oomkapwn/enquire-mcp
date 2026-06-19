// v3.10.0-rc.62 (CLI-SERVEHTTP-RECENCY-FAILLATE) — the serve-http boot path now validates the
// advanced-retrieval flags FAST (before startHttpServer), instead of letting prepareServerDeps
// throw lazily on the first search request. These unit tests pin the shared validator's contract.
import { describe, expect, it } from "vitest";
import { parseRecencyConfig, validateServeHttpRetrievalOpts } from "../src/retrieval-opts.js";

describe("parseRecencyConfig (rc.62)", () => {
  it("returns null when --recency-weight is unset (recency re-ranking OFF)", () => {
    expect(parseRecencyConfig({})).toBeNull();
  });

  it("returns null when --recency-weight is 0 (explicit OFF)", () => {
    expect(parseRecencyConfig({ recencyWeight: "0" })).toBeNull();
  });

  it("returns { weight, staleDays } when weight > 0, defaulting staleDays to 365", () => {
    expect(parseRecencyConfig({ recencyWeight: "0.3" })).toEqual({ weight: 0.3, staleDays: 365 });
  });

  it("honors a custom --stale-days half-life", () => {
    expect(parseRecencyConfig({ recencyWeight: "0.5", staleDays: "90" })).toEqual({ weight: 0.5, staleDays: 90 });
  });

  // NEGATIVE controls — each throws with the offending flag name.
  it("throws on an out-of-range --recency-weight (> 1)", () => {
    expect(() => parseRecencyConfig({ recencyWeight: "5" })).toThrow(/--recency-weight/);
  });

  it("throws on a non-numeric --recency-weight", () => {
    expect(() => parseRecencyConfig({ recencyWeight: "high" })).toThrow(/--recency-weight/);
  });

  it("throws on a non-positive --stale-days even when weight is 0 (a typo must fail regardless)", () => {
    expect(() => parseRecencyConfig({ recencyWeight: "0", staleDays: "0" })).toThrow(/--stale-days/);
  });
});

describe("validateServeHttpRetrievalOpts (rc.62 — fail-FAST at serve-http boot)", () => {
  it("accepts a fully-valid opts object (no throw)", () => {
    expect(() =>
      validateServeHttpRetrievalOpts({
        recencyWeight: "0.2",
        staleDays: "120",
        enableReranker: true,
        rerankerTopN: "50"
      })
    ).not.toThrow();
  });

  it("accepts an empty opts object (all flags default — no throw)", () => {
    expect(() => validateServeHttpRetrievalOpts({})).not.toThrow();
  });

  // NEGATIVE controls — boot must reject each bad flag with its name (was previously deferred to
  // the first search request inside prepareServerDeps).
  it("throws on a bad --recency-weight", () => {
    expect(() => validateServeHttpRetrievalOpts({ recencyWeight: "2" })).toThrow(/--recency-weight/);
  });

  it("throws on a bad --stale-days", () => {
    expect(() => validateServeHttpRetrievalOpts({ recencyWeight: "0.3", staleDays: "x" })).toThrow(/--stale-days/);
  });

  it("throws on a bad --reranker-top-n when --enable-reranker is set", () => {
    expect(() => validateServeHttpRetrievalOpts({ enableReranker: true, rerankerTopN: "0" })).toThrow(
      /--reranker-top-n/
    );
  });

  it("does NOT validate --reranker-top-n when --enable-reranker is off (mirrors prepareServerDeps gating)", () => {
    // rerankerTopN is only consumed when reranking is enabled; a stale value is ignored, not an error.
    expect(() => validateServeHttpRetrievalOpts({ enableReranker: false, rerankerTopN: "0" })).not.toThrow();
  });
});
