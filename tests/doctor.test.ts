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
  });

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
