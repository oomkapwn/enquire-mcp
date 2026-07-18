// v3.11.6-rc.14 (root-cause audit) — the committed golden set must MATCH the vault
// it claims to target. Pre-rc.14, examples/queries.jsonl referenced 20 paths of
// which 17 existed in NO vault anywhere in the repo (written as a format
// illustration, never validated) — so the documented eval quick start returned
// all-miss zeros for anyone who ran it. Same root cause as the rc.12 harness
// HIGH: a deliverable whose documented command was never executed end-to-end.
// This contract pins every `relevant` path to the synthetic quick-start vault
// (scripts/synthetic-vault.mjs), so the set can never go phantom again.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error — .mjs script module, no type declarations.
import { createSyntheticVault } from "../scripts/synthetic-vault.mjs";

let vaultRoot: string;
let goldenLines: { id?: string; query: string; relevant: string[] }[];

beforeAll(async () => {
  vaultRoot = await createSyntheticVault();
  const raw = await fs.readFile(new URL("../examples/queries.jsonl", import.meta.url), "utf8");
  goldenLines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("//"))
    .map((l) => JSON.parse(l));
});

afterAll(async () => {
  await fs.rm(vaultRoot, { recursive: true, force: true });
});

describe("examples/queries.jsonl ↔ synthetic-vault contract (rc.14)", () => {
  it("parses to a non-empty golden set with query + relevant on every line", () => {
    expect(goldenLines.length).toBeGreaterThanOrEqual(3);
    for (const q of goldenLines) {
      expect(typeof q.query, JSON.stringify(q)).toBe("string");
      expect(Array.isArray(q.relevant) && q.relevant.length > 0, JSON.stringify(q)).toBe(true);
    }
  });

  it("every `relevant` path EXISTS in the synthetic quick-start vault (no phantom paths)", async () => {
    const missing: string[] = [];
    for (const q of goldenLines) {
      for (const rel of q.relevant) {
        try {
          await fs.access(path.join(vaultRoot, rel));
        } catch {
          missing.push(`${q.id ?? q.query}: ${rel}`);
        }
      }
    }
    expect(missing, `golden-set paths absent from the synthetic vault:\n${missing.join("\n")}`).toEqual([]);
  });

  it("NEGATIVE control — the existence check actually fires on a phantom path", async () => {
    let missing = false;
    try {
      await fs.access(path.join(vaultRoot, "Reference/Apollo Program.md")); // the pre-rc.14 phantom
    } catch {
      missing = true;
    }
    expect(missing).toBe(true);
  });
});
