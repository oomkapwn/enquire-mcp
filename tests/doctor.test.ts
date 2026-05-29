// v2.11.0 — diagnostic + zero-touch onboarding tests.
//
// Coverage:
//   • runDoctor returns the expected DoctorResult shape
//   • Vault check ok-vs-error: real vault vs nonexistent path
//   • Optional-dep checks return ok (CI installs all optionalDependencies
//     by default), with `warn`/`missing` for any that fail to load
//   • Model-cache check probes multiple candidate paths
//   • FTS5 / embed-db checks: not-built status when files don't exist
//   • Summary tally is correct (ok + warn + missing + error = checks.length)
//   • formatCheck + formatDoctorResult produce non-empty strings
//
// We don't test the `setup` subcommand here — it's pure orchestration over
// existing CLI codepaths (install-model + index + build-embeddings) and
// real validation requires loading the ML model. Out of scope for unit
// tests; covered by manual smoke.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DoctorCheck, type DoctorResult, formatCheck, formatDoctorResult, runDoctor } from "../src/doctor.js";

let root: string;
let cacheRoot: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-doctor-vault-"));
  cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-doctor-cache-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(cacheRoot, { recursive: true, force: true });
});

describe("runDoctor (v2.11.0)", () => {
  // v3.5.5 — external audit flagged this test as flaky under cold I/O:
  // runDoctor probes optional deps via `await import(...)` including
  // `@huggingface/transformers` (~100MB + ONNX runtime). First import in
  // a fresh Vitest process can take 5-30s on slow disks / cold caches,
  // tripping the default 5s timeout. We bump to 30s on the FIRST test
  // in the describe block (the only one that pays the cold-import cost
  // — subsequent tests in this file reuse Node's module cache and run
  // in <100ms each).
  it("returns the expected DoctorResult shape", async () => {
    const result = await runDoctor({ vault: root, modelCacheRoot: cacheRoot });
    expect(result.vault).toBe(root);
    expect(typeof result.ready).toBe("boolean");
    expect(Array.isArray(result.checks)).toBe(true);
    expect(result.checks.length).toBeGreaterThan(0);
    expect(result.summary).toMatchObject({
      ok: expect.any(Number),
      warn: expect.any(Number),
      missing: expect.any(Number),
      error: expect.any(Number)
    });
    // Summary tally adds up to check count.
    const total = result.summary.ok + result.summary.warn + result.summary.missing + result.summary.error;
    expect(total).toBe(result.checks.length);
  }, 30_000); // see comment above the it() — cold transformers.js import can dominate.

  it("vault check is ok for a real directory", async () => {
    await fs.writeFile(path.join(root, "note.md"), "# Hello\n");
    const result = await runDoctor({ vault: root, modelCacheRoot: cacheRoot });
    const vaultCheck = result.checks.find((c) => c.id === "vault");
    expect(vaultCheck?.status).toBe("ok");
    expect(vaultCheck?.detail).toContain("markdown");
  });

  it("vault check reports error for a nonexistent path", async () => {
    const result = await runDoctor({ vault: "/nonexistent/path/xyz", modelCacheRoot: cacheRoot });
    const vaultCheck = result.checks.find((c) => c.id === "vault");
    expect(vaultCheck?.status).toBe("error");
    expect(result.ready).toBe(false);
  });

  // v3.9.0-rc.16 (P2-12) — privacy filters are honored + reported, not faked.
  it("reports a privacy-filter-active check + filtered count when --exclude-glob is set", async () => {
    await fs.writeFile(path.join(root, "public.md"), "# Public\n");
    await fs.writeFile(path.join(root, "secret.md"), "# Secret\n");
    const result = await runDoctor({
      vault: root,
      modelCacheRoot: cacheRoot,
      excludeGlobs: ["secret.md"]
    });
    const privacy = result.checks.find((c) => c.id === "privacy");
    expect(privacy?.status).toBe("ok");
    expect(privacy?.detail).toContain("exclude-glob");
    const vaultCheck = result.checks.find((c) => c.id === "vault");
    expect(vaultCheck?.detail).toContain("after privacy filter");
    // 1 markdown visible (secret.md filtered out).
    expect(vaultCheck?.detail).toContain("1 markdown");
  });

  it("does NOT claim a privacy filter when none is set (v3.9.0-rc.16 NEGATIVE control)", async () => {
    await fs.writeFile(path.join(root, "note.md"), "# Hi\n");
    const result = await runDoctor({ vault: root, modelCacheRoot: cacheRoot });
    expect(result.checks.find((c) => c.id === "privacy")).toBeUndefined();
    const vaultCheck = result.checks.find((c) => c.id === "vault");
    expect(vaultCheck?.detail).not.toContain("privacy filter");
  });

  it("surfaces a privacy-config error (not a crash) for an empty-after-trim glob", async () => {
    const result = await runDoctor({
      vault: root,
      modelCacheRoot: cacheRoot,
      excludeGlobs: ["   "]
    });
    const privacy = result.checks.find((c) => c.id === "privacy");
    expect(privacy?.status).toBe("error");
    expect(result.ready).toBe(false);
  });

  it("optional-dep checks return ok in CI (all optionalDependencies installed)", async () => {
    const result = await runDoctor({ vault: root, modelCacheRoot: cacheRoot });
    const sqlite = result.checks.find((c) => c.id === "dep:better-sqlite3");
    const transformers = result.checks.find((c) => c.id === "dep:transformers");
    const pdfjs = result.checks.find((c) => c.id === "dep:pdfjs");
    const ocr = result.checks.find((c) => c.id === "dep:ocr");
    // We don't hard-assert these since `--omit=optional` would invalidate.
    // But in CI's default install all 4 should be present.
    for (const check of [sqlite, transformers, pdfjs, ocr]) {
      expect(check).toBeDefined();
      expect(["ok", "missing", "warn"]).toContain(check?.status);
    }
  });

  it("model-cache check is missing when cacheRoot is empty", async () => {
    const result = await runDoctor({ vault: root, modelCacheRoot: cacheRoot });
    const modelCheck = result.checks.find((c) => c.id === "model:cache");
    expect(modelCheck?.status).toBe("missing");
    expect(modelCheck?.hint).toContain("install-model");
  });

  it("model-cache check is ok when Xenova model dirs are present", async () => {
    // Synthesize a fake model cache.
    const xenovaDir = path.join(cacheRoot, "Xenova", "paraphrase-multilingual-MiniLM-L12-v2");
    await fs.mkdir(xenovaDir, { recursive: true });
    await fs.writeFile(path.join(xenovaDir, "config.json"), '{"model_type":"bert"}');
    await fs.writeFile(path.join(xenovaDir, "model.onnx"), Buffer.alloc(1024 * 1024)); // 1 MB

    const result = await runDoctor({ vault: root, modelCacheRoot: cacheRoot });
    const modelCheck = result.checks.find((c) => c.id === "model:cache");
    expect(modelCheck?.status).toBe("ok");
    expect(modelCheck?.detail).toContain("1 model(s)");
  });

  it("FTS5 + embed-db checks report 'not built' when files don't exist", async () => {
    // Use temp paths that don't exist.
    const result = await runDoctor({
      vault: root,
      modelCacheRoot: cacheRoot,
      indexFile: path.join(cacheRoot, "fake.fts5.db"),
      embedFile: path.join(cacheRoot, "fake.embed.db")
    });
    const ftsCheck = result.checks.find((c) => c.id === "index:fts5");
    const embedCheck = result.checks.find((c) => c.id === "index:embed");
    // Both should be `warn` (not built) — not `missing`, since they're
    // optional for non-search use cases.
    expect(ftsCheck?.status).toBe("warn");
    expect(embedCheck?.status).toBe("warn");
    expect(ftsCheck?.hint).toContain("enquire-mcp index");
    expect(embedCheck?.hint).toContain("build-embeddings");
  });

  it("ready=true requires zero missing/error checks", async () => {
    // We can't easily make every check pass in test (would need real model
    // cache + indexes built), so we just verify the boolean logic by
    // inspecting summary.
    const result = await runDoctor({ vault: root, modelCacheRoot: cacheRoot });
    const expectedReady = result.summary.missing === 0 && result.summary.error === 0;
    expect(result.ready).toBe(expectedReady);
  });

  // v3.6 — branches coverage. The FTS5 "ok" branch (existing index file
  // loads successfully) was previously uncovered — existing tests only
  // hit the not-built (warn) and excluded paths.
  it("FTS5 + embed-db checks report 'ok' when files exist", async () => {
    // Build a minimal FTS5 index file by opening + closing FtsIndex. The
    // doctor will reopen the same file via existsSync + new FtsIndex(...).
    const { FtsIndex } = await import("../src/fts5.js");
    const indexFile = path.join(cacheRoot, "real.fts5.db");
    const idx = new FtsIndex({ file: indexFile, vaultRoot: root });
    await idx.open();
    idx.close();
    // Build a fake embed.db too — doctor just stats the file, doesn't open it.
    const embedFile = path.join(cacheRoot, "real.embed.db");
    await fs.writeFile(embedFile, Buffer.alloc(2048));

    const result = await runDoctor({
      vault: root,
      modelCacheRoot: cacheRoot,
      indexFile,
      embedFile
    });
    const ftsCheck = result.checks.find((c) => c.id === "index:fts5");
    expect(ftsCheck?.status).toBe("ok");
    expect(ftsCheck?.detail).toContain("files");
    expect(ftsCheck?.detail).toContain("chunks");

    const embedCheck = result.checks.find((c) => c.id === "index:embed");
    // 'ok' iff embed file exists AND both optional deps are present.
    // In CI both are installed; if not, the check stays 'warn' but the
    // FTS5 branch is what we needed for coverage.
    expect(["ok", "warn"]).toContain(embedCheck?.status);
  });

  // v3.6 — branches coverage. candidateModelCacheRoots() is called when
  // modelCacheRoot is not specified; existing tests always specify it.
  // This pass exercises the default candidate-path probing branches.
  it("model-cache check probes default candidate paths when modelCacheRoot is omitted", async () => {
    const prevHfHome = process.env.HF_HOME;
    const prevTransformersCache = process.env.TRANSFORMERS_CACHE;
    // Set both env vars to a known-empty path so the env-var branches fire.
    process.env.HF_HOME = path.join(cacheRoot, "no-hf-home");
    process.env.TRANSFORMERS_CACHE = path.join(cacheRoot, "no-transformers-cache");
    try {
      const result = await runDoctor({ vault: root });
      const modelCheck = result.checks.find((c) => c.id === "model:cache");
      expect(modelCheck).toBeDefined();
      // We don't assert ok/missing — depends on the user's actual cache —
      // but the candidate-paths branch must have been exercised.
      expect(["ok", "missing"]).toContain(modelCheck?.status);
    } finally {
      if (prevHfHome === undefined) delete process.env.HF_HOME;
      else process.env.HF_HOME = prevHfHome;
      if (prevTransformersCache === undefined) delete process.env.TRANSFORMERS_CACHE;
      else process.env.TRANSFORMERS_CACHE = prevTransformersCache;
    }
  }, 30_000);
});

describe("formatCheck + formatDoctorResult (v2.11.0)", () => {
  function makeCheck(over: Partial<DoctorCheck> = {}): DoctorCheck {
    return {
      id: "test",
      label: "Test check",
      status: "ok",
      ...over
    };
  }

  it("formatCheck returns a non-empty string for each status", () => {
    for (const status of ["ok", "warn", "missing", "error"] as const) {
      const out = formatCheck(makeCheck({ status, label: `${status} test` }));
      expect(out.length).toBeGreaterThan(0);
      expect(out).toContain(`${status} test`);
    }
  });

  it("formatCheck includes detail + hint when present", () => {
    const out = formatCheck(makeCheck({ status: "missing", detail: "DETAIL_X", hint: "HINT_Y" }));
    expect(out).toContain("DETAIL_X");
    expect(out).toContain("HINT_Y");
  });

  it("formatCheck omits hint when status is ok (no need to fix)", () => {
    const out = formatCheck(makeCheck({ status: "ok", hint: "should not appear" }));
    expect(out).not.toContain("should not appear");
  });

  it("formatDoctorResult emits a banner with vault + verdict", () => {
    const result: DoctorResult = {
      vault: "/test/vault",
      ready: true,
      checks: [makeCheck()],
      summary: { ok: 1, warn: 0, missing: 0, error: 0 }
    };
    const out = formatDoctorResult(result);
    expect(out).toContain("/test/vault");
    expect(out).toContain("READY");
  });

  it("formatDoctorResult shows NOT READY verdict when ready=false", () => {
    const result: DoctorResult = {
      vault: "/test/vault",
      ready: false,
      checks: [makeCheck({ status: "missing", label: "fail" })],
      summary: { ok: 0, warn: 0, missing: 1, error: 0 }
    };
    const out = formatDoctorResult(result);
    expect(out).toContain("NOT READY");
    expect(out).toContain("fail");
  });
});
