// v3.11.5-rc.1 (CRL-1) — prepareServerDeps must validate the advanced-retrieval flags
// (--feedback-weight / --recency-weight / --stale-days) BEFORE it acquires any resource
// (the vault cache via `new Vault(...)`, the FTS5 handle, the watcher, the embed-db, the
// HNSW index). Pre-fix the --feedback-weight parse sat near the END of prepareServerDeps —
// AFTER ftsIndex.open()/watcher.start()/embed-db.open() — so a typo'd weight threw only
// after those handles were open, leaking a SQLite handle / running watcher for the process
// lifetime.
//
// `src/server.ts` is on the `no-internal-imports` RESTRICTED list (tests may not value-import
// it), so — mirroring cli-parity.test.ts + the retrieval-opts leaf-module split from rc.62 —
// this is a STRUCTURAL source-order guard: the parseFeedbackConfig / parseRecencyConfig calls
// must appear before the first `new Vault(` inside prepareServerDeps. The pure helper is
// exercised by a NEGATIVE control so the invariant can't go vacuous.
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");

/**
 * Given the full source of a `prepareServerDeps`-shaped function, return a list of
 * ordering violations: each validator (`parseFeedbackConfig` / `parseRecencyConfig`) that
 * is called at/after the first resource acquisition (`new Vault(`) — or not called at all.
 * A pure, testable predicate (empty array = fail-fast ordering holds).
 */
function acquisitionOrderViolations(fnSrc: string): string[] {
  const out: string[] = [];
  const acquireAt = fnSrc.indexOf("new Vault(");
  if (acquireAt < 0) return ["no `new Vault(` acquisition found — cannot verify ordering"];
  for (const validator of ["parseFeedbackConfig", "parseRecencyConfig"]) {
    const at = fnSrc.indexOf(`${validator}(opts)`);
    if (at < 0) out.push(`${validator}(opts) is never called before acquisition`);
    else if (at > acquireAt) out.push(`${validator}(opts) runs AFTER \`new Vault(\` (leaks handles on throw)`);
  }
  return out;
}

/** Slice out the prepareServerDeps function body (best-effort: from its declaration to the
 *  next top-level `export ` that follows). */
function extractPrepareServerDeps(src: string): string {
  const start = src.indexOf("export async function prepareServerDeps");
  if (start < 0) return "";
  const after = src.indexOf("\nexport ", start + 1);
  return src.slice(start, after < 0 ? undefined : after);
}

describe("prepareServerDeps validates retrieval flags before acquiring resources (v3.11.5-rc.1 CRL-1)", () => {
  it("parseFeedbackConfig + parseRecencyConfig run BEFORE the first `new Vault(` acquisition", async () => {
    const src = await fs.readFile(path.join(repoRoot, "src", "server.ts"), "utf8");
    const fnSrc = extractPrepareServerDeps(src);
    expect(fnSrc, "prepareServerDeps must exist in src/server.ts").not.toBe("");
    expect(acquisitionOrderViolations(fnSrc)).toEqual([]);
  });

  it("NEGATIVE control — the helper flags the pre-fix ordering (validators AFTER new Vault)", () => {
    const preFix = [
      "export async function prepareServerDeps(opts) {",
      "  const vault = new Vault(opts.vault, {});",
      "  await ftsIndex.open();",
      "  const feedbackStore = parseFeedbackConfig(opts) !== null ? await open() : null;",
      "  const recencyConfig = parseRecencyConfig(opts);",
      "}"
    ].join("\n");
    const violations = acquisitionOrderViolations(preFix);
    expect(violations.length).toBe(2);
    expect(violations.join(" ")).toMatch(/parseFeedbackConfig.*AFTER|AFTER.*parseFeedbackConfig/);
  });

  it("NEGATIVE control — the helper flags a validator that is never called", () => {
    const missing =
      "export async function prepareServerDeps(opts) {\n  const vault = new Vault(opts.vault, {});\n  parseRecencyConfig(opts);\n}";
    expect(acquisitionOrderViolations(missing)).toContain(
      "parseFeedbackConfig(opts) is never called before acquisition"
    );
  });

  // v3.11.5-rc.4 (post-rc.3 re-sweep) — CRL-1 sibling: --reranker-top-n was validated only in
  // buildMcpServer (one call-frame later), which stdio `serve` invokes AFTER prepareServerDeps
  // acquired the FTS5 handle / watcher / embed-db / HNSW, so a bad value leaked them. It is now
  // hoisted into prepareServerDeps' fail-fast block — this pins that ordering structurally.
  it("--reranker-top-n is validated BEFORE the first `new Vault(` acquisition (CRL-1 sibling)", async () => {
    const src = await fs.readFile(path.join(repoRoot, "src", "server.ts"), "utf8");
    const fnSrc = extractPrepareServerDeps(src);
    const acquireAt = fnSrc.indexOf("new Vault(");
    const validateAt = fnSrc.indexOf("parsePositiveInt(opts.rerankerTopN");
    expect(validateAt, "prepareServerDeps must validate --reranker-top-n at boot").toBeGreaterThan(-1);
    expect(validateAt).toBeLessThan(acquireAt); // before any resource is acquired
  });
});
