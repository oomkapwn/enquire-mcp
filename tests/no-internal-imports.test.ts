import { promises as fs } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// Class A invariant (v3.6.0-rc.4) — closes the "hardcoded paths to
// internal-only modules" drift class observed during the rc.1+rc.2
// monolith split.
//
// Background. The sprint discovered 4 separate test-import drift
// incidents:
//   - rc.1 split: 15 test files imported from `../src/tools.js`
//     (no longer existed) → bulk path-rewrite
//   - rc.2 split: docs-consistency.test.ts regex-parsed
//     `../src/index.ts` for `registerTool(` patterns that had
//     moved to `tool-registry.ts`
//   - rc.2 split: coverage exclude list hardcoded `src/index.ts`
//     when reality moved to 6 files
//   - rc.2 split: STABILITY.md hardcoded src/index.ts for
//     symbols that now live in src/{cli,server,tool-registry}.ts
//
// Common root cause: code OUTSIDE `package.json#exports` ssylaetsja
// at internal source paths by exact filename. Any structural refactor
// breaks all of them simultaneously.
//
// This invariant catches the FIRST CLASS of those — test imports
// pulling values from "registration boilerplate" modules. Those
// modules are integration-tested through the MCP surface, never
// directly. If a future refactor moves their contents, no test should
// be broken by the move; this invariant blocks the regression at
// introduction time.
//
// Allowed:
//   - import paths under `src/tools/index.js` (the tools barrel)
//   - import paths under any `src/{vault,fts5,embed-db,hnsw,bases,
//     communities,dql,embeddings,eval,ocr,pdf,periodic,rrf,parser,
//     doctor,watcher,http-transport,cli-help,tool-manifest}.js`
//     (infrastructure + manifest + constants modules)
//   - `src/index.js` (the slim re-export barrel — its only purpose
//     is to be a stable import path)
//
// Restricted (no VALUE imports allowed):
//   - `src/cli.js`         — commander program internals
//   - `src/server.js`      — MCP server construction internals
//   - `src/tool-registry.js` — registerTool loops
//   - `src/prompts.js`     — prompt registration
//
// Exception: `docs-consistency.test.ts` reads these as text via
// `fs.readFile()` (not `import`). That's allowed — the invariant
// only checks `import ... from "..."` statements.

const repoRoot = path.resolve(__dirname, "..");
const RESTRICTED_MODULES = ["cli", "server", "tool-registry", "prompts"];

/** v3.9.0-rc.23 — extracted pure matcher so the invariant has a real inline
 *  NEGATIVE control (it previously had none; flagged by the rc.21 audit). Given
 *  a test file's `relFile` + source text, return the restricted-import
 *  violations it contains. */
function restrictedImportViolations(relFile: string, src: string): string[] {
  const out: string[] = [];
  for (const mod of RESTRICTED_MODULES) {
    // Match: import ... from "../src/MOD.js" or "../src/MOD/index.js"
    // (including type-only imports — those would still break under a refactor
    // that moves the type to a sibling module).
    const importRe = new RegExp(`^\\s*import\\b[^;]*\\bfrom\\s+["']\\.\\./src/${mod}(?:/index)?\\.js["']`, "m");
    if (importRe.test(src)) {
      out.push(`${relFile} imports from src/${mod}.js (restricted — registration boilerplate)`);
    }
  }
  return out;
}

describe("Class A invariant — no test imports value from registration boilerplate", () => {
  it("no test file value-imports from src/{cli,server,tool-registry,prompts}.ts", async () => {
    const testFiles = await collectTestFiles(path.join(repoRoot, "tests"));
    const violations: string[] = [];
    for (const file of testFiles) {
      const src = await fs.readFile(file, "utf8");
      violations.push(...restrictedImportViolations(path.relative(repoRoot, file), src));
    }
    expect(violations, "Test files must not import values from registration-boilerplate modules").toEqual([]);
  });

  it("NEGATIVE control: the matcher flags a restricted import + ignores an allowed one", () => {
    // Drift the input on purpose — a synthetic test importing from a restricted
    // module MUST be flagged; an allowed barrel/infra import MUST NOT be.
    const bad = `import { buildMcpServer } from "../src/server.js";\nimport { x } from "../src/tool-registry.js";`;
    const flagged = restrictedImportViolations("tests/synthetic.test.ts", bad);
    expect(flagged.length).toBe(2);
    expect(flagged.join(" ")).toMatch(/server\.js.*restricted|restricted.*server\.js/);
    const good = `import { searchHybrid } from "../src/tools/index.js";\nimport { Vault } from "../src/vault.js";`;
    expect(restrictedImportViolations("tests/synthetic.test.ts", good)).toEqual([]);
  });
});

async function collectTestFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await collectTestFiles(full)));
    } else if (e.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}
