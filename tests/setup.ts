// v3.5.6 — Vitest setup file. Warms the native / heavy optional deps
// ONCE before any test runs, so individual tests never pay the cold-
// import cost.
//
// Root cause (external review #2, v3.5.5): the first test in a Vitest
// process that does `await import("@huggingface/transformers")` could
// take 5-30s on slow disks / cold module caches, tripping the default
// 5s test timeout. We worked around it case-by-case in v3.5.5 by
// bumping `tests/doctor.test.ts`'s first-test timeout to 30s. The
// systemic fix is HERE: load every native / heavy optional dep upfront
// from the setup file, so the per-test cost in every other test file
// (`pdf.test.ts`, `ocr.test.ts`, `hnsw.test.ts`, anything probing
// optional deps) drops to a cached-module lookup.
//
// What we warm + why:
//   - `@huggingface/transformers` — ONNX runtime + JS layer, ~100 MB.
//     Cold load is the dominant flake risk. Used by embeddings,
//     reranker, doctor's probeOptionalDep.
//   - `pdfjs-dist` — PDF parser, ~5 MB. Used by pdf tests + OCR tests.
//   - `tesseract.js` — OCR WASM engine, ~25 MB. Used by ocr tests.
//   - `@napi-rs/canvas` — native binding for OCR rasterization, ~10 MB.
//   - `hnswlib-node` — native binding for HNSW vector index, ~3 MB.
//   - `better-sqlite3` — native SQLite binding, ~3 MB.
//
// Each import is wrapped in try/catch so a missing optional dep (e.g.
// when running `npm install --omit=optional`) doesn't fail the entire
// test run. The relevant test files handle missing deps themselves
// (gracefully skip / mark expected `missing` status).
//
// Cost: this setup file runs ONCE per test process. Adds ~2-30s to
// the very first test process startup (depending on disk speed), but
// in exchange every test's first import is free. Net win even on a
// single test file with > 1 native-loading test.

const optionalDeps = [
  "@huggingface/transformers",
  "pdfjs-dist",
  "tesseract.js",
  "@napi-rs/canvas",
  "hnswlib-node",
  "better-sqlite3"
];

await Promise.allSettled(optionalDeps.map((spec) => import(spec).catch(() => undefined)));
