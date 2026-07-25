// v3.12.0-rc.5 — compiled benchmark model-state scenario matrix.
//
// `bench-strict.test.ts` pins the pure resolveBenchWrite policy, but before
// this suite no test executed the advertised scripts/run-benchmarks.mjs entry
// through compiled dist + both model-loader boundaries. These child processes
// keep the real benchmark orchestration, indexes, artifact writer and exit
// contract. An ESM loader replaces only @huggingface/transformers with a
// deterministic present/missing/corrupt fixture, while a fetch/http/https
// tripwire proves every scenario is network-free.

import { spawnSync } from "node:child_process";
import { existsSync, promises as fs, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const BENCH_ENTRY = path.join(PROJECT_ROOT, "scripts", "run-benchmarks.mjs");
const DIST_ENTRY = path.join(PROJECT_ROOT, "dist", "index.js");
const CANONICAL_ARTIFACT = path.join(PROJECT_ROOT, "bench", "benchmarks.json");
const REGISTER_FIXTURE = path.join(PROJECT_ROOT, "tests", "fixtures", "transformers-test-loader", "register.mjs");

type ModelState = "present" | "missing" | "corrupt";
type BenchMode = "strict" | "diagnostic";

let tempRoot = "";

beforeAll(async () => {
  expect(existsSync(DIST_ENTRY), "compiled scenario requires `npm run build` before tests").toBe(true);
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-bench-model-state-"));
});

afterAll(async () => {
  if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
});

function runScenario(state: ModelState, mode: BenchMode) {
  const output = path.join(tempRoot, `${state}-${mode}.json`);
  const networkMarker = path.join(tempRoot, `${state}-${mode}.network`);
  const args = [BENCH_ENTRY];
  if (mode === "diagnostic") args.push("--allow-partial");
  args.push("--output", output);
  const result = spawnSync(process.execPath, args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      NODE_OPTIONS: `--import=${pathToFileURL(REGISTER_FIXTURE).href}`,
      ENQUIRE_TEST_MODEL_STATE: state,
      ENQUIRE_TEST_NETWORK_MARKER: networkMarker
    }
  });
  return { ...result, output, networkMarker };
}

describe("compiled benchmark model-state matrix (rc.5)", () => {
  it("drives present/missing/corrupt through strict and diagnostic process contracts", () => {
    const canonicalBefore = readFileSync(CANONICAL_ARTIFACT);
    for (const state of ["present", "missing", "corrupt"] as const) {
      for (const mode of ["strict", "diagnostic"] as const) {
        const result = runScenario(state, mode);
        expect(result.error, `${state}/${mode}: ${result.stderr}`).toBeUndefined();
        expect(existsSync(result.networkMarker), `${state}/${mode} attempted outbound network`).toBe(false);

        const shouldWrite = state === "present" || mode === "diagnostic";
        expect(result.status, `${state}/${mode}: ${result.stderr}`).toBe(shouldWrite ? 0 : 1);
        expect(existsSync(result.output), `${state}/${mode}: output presence`).toBe(shouldWrite);

        if (!shouldWrite) {
          expect(result.stderr).toMatch(/STRICT FAILURE/);
          expect(result.stderr).toMatch(new RegExp(`fixture model ${state}`));
          continue;
        }

        const artifact = JSON.parse(readFileSync(result.output, "utf8")) as {
          meta: {
            embed_ready: boolean;
            reranker_ready: boolean;
            partial: boolean;
            embed_skip_reason: string | null;
            reranker_skip_reason: string | null;
          };
          rows: Array<{ skipped?: boolean }>;
        };
        const ready = state === "present";
        expect(artifact.meta.embed_ready, `${state}/${mode}: embed readiness`).toBe(ready);
        expect(artifact.meta.reranker_ready, `${state}/${mode}: reranker readiness`).toBe(ready);
        expect(artifact.meta.partial, `${state}/${mode}: partial marker`).toBe(!ready);
        expect(artifact.rows.length).toBeGreaterThan(0);

        if (ready) {
          expect(artifact.meta.embed_skip_reason).toBeNull();
          expect(artifact.meta.reranker_skip_reason).toBeNull();
          expect(artifact.rows.some((row) => row.skipped)).toBe(false);
        } else {
          expect(artifact.meta.embed_skip_reason).toMatch(new RegExp(`fixture model ${state}`));
          expect(artifact.meta.reranker_skip_reason).toMatch(new RegExp(`fixture model ${state}`));
          expect(artifact.rows.some((row) => row.skipped)).toBe(true);
          expect(result.stderr).toMatch(/PARTIAL — degraded arms/);
        }
      }
    }

    expect(readFileSync(CANONICAL_ARTIFACT)).toEqual(canonicalBefore);
  }, 180_000);

  it("NEGATIVE control — the child-process network tripwire records a real fetch", () => {
    const marker = path.join(tempRoot, "tripwire-control.network");
    const result = spawnSync(process.execPath, ["-e", "fetch('https://example.invalid/model')"], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: `--import=${pathToFileURL(REGISTER_FIXTURE).href}`,
        ENQUIRE_TEST_NETWORK_MARKER: marker
      }
    });
    expect(result.status).not.toBe(0);
    expect(readFileSync(marker, "utf8")).toMatch(/fetch: https:\/\/example\.invalid\/model/);
    expect(result.stderr).toMatch(/TEST NETWORK TRIPWIRE/);
  });
});
