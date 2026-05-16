// v3.7.3 — NEGATIVE-CONTROL fixture for the v3.7.2
// `tests/k1-version-stamp-consistency.test.ts` invariant.
//
// This file intentionally contains MIXED v3.6.3 and v3.6.4 K-1 stamps.
// The invariant SHOULD detect both versions and fail. If the analyzer
// silently passes this file, the v3.7.2 invariant is broken — same
// methodological gap that the v3.6.4 anti-pattern "Invariant test
// without negative-control" warned about (now self-applied).
//
// THIS FILE IS A TEST FIXTURE — do NOT "fix" the mixed stamps. The
// negative-control test asserts that the v3.7.2 invariant detects
// the drift. Aligning the stamps would mask a regression of the
// invariant analyzer itself.

// v3.6.3 K-1 closure: this is intentionally the OLD wrong stamp.
function fakeOldStampSite() {
  return "wrong stamp from a sprint that was deferred";
}

// v3.6.4 K-1 closure: this is the canonical (correct) stamp.
function fakeCanonicalStampSite() {
  return "right stamp matching where K-1 actually closed";
}

// v3.6.5 K-1 invariant: this is a third unique stamp to prove the
// invariant detects ALL drift, not just the v3.6.3 vs v3.6.4 split.
function fakeFutureStampSite() {
  return "hypothetical future drift";
}

// Touch each function so noUnusedVariables doesn't trip biome (we
// exclude tests/fixtures from biome anyway, but defense-in-depth).
void fakeOldStampSite;
void fakeCanonicalStampSite;
void fakeFutureStampSite;
