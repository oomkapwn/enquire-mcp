import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // v3.6.1 H-2 — bump per-test timeout from vitest default 5000ms to
    // 15000ms. Root cause: under contended CPU (parallel tests + cold
    // native-dep loads via setupFiles + child-process spawns in
    // cli.test.ts via execFileSync), the default budget is too tight.
    // Three consecutive `npm test` runs at default produced 10/11/3
    // timeouts respectively; a fourth run with --testTimeout=30000
    // produced 0 failures. 15s gives a generous safety margin while
    // still catching genuine hangs. Discovered in v3.6.0 post-stable
    // 9-layer audit (L3-01) + cross-confirmed by external auditor.
    testTimeout: 15_000,
    // v3.5.6 — warm native + heavy optional deps once per process so
    // individual tests don't pay the cold-import cost. See
    // tests/setup.ts for the rationale + which deps + cost analysis.
    setupFiles: ["./tests/setup.ts"],
    // v2.0.0-beta.3: coverage thresholds set ~5pp BELOW current (lines
    // 91.35, statements 87.03, functions 80.6, branches 77.85) so a real
    // regression has to skip a meaningful chunk before CI fails. The
    // coverage job is in CI's required checks, so a regression that drops
    // below blocks merge. index.ts is excluded — it's registration
    // boilerplate where line coverage doesn't reflect quality.
    coverage: {
      provider: "v8",
      // json-summary added in v3.5.12 — feeds scripts/check-changelog-coverage.mjs
      // which gates that the latest CHANGELOG section's stated coverage percentages
      // match reality within 0.5pp. Closes the class of bug v3.5.10 audit caught
      // (inflated stats copy-pasted from sub-agent output into release notes).
      reporter: ["text", "html", "lcov", "json-summary"],
      include: ["src/**/*.ts"],
      // v3.6.0-rc.4 — registration-boilerplate exclude pivoted from exact
      // paths to a brace-glob pattern. Rationale (Class A invariant fix):
      // the rc.2 monolith split hardcoded 6 individual paths after running
      // into the OLD `["src/index.ts"]` becoming stale post-split. A glob
      // pattern is refactor-resistant — adding/renaming registration files
      // in this category won't break coverage thresholds again.
      //
      // What "registration boilerplate" means here: code whose purpose is
      // to wire up the MCP server (CLI parsing, server construction,
      // tool/prompt registration loops, machine-readable manifest). The
      // actual tool LOGIC is in `src/tools/*` which STAYS included + tested.
      // Without these exclusions coverage drops from ~89% lines to ~78%
      // (-11pp), which is an include-set artifact, not test quality.
      exclude: [
        "src/{index,cli,server,tool-registry,prompts,tool-manifest}.ts",
        "**/*.test.ts"
      ],
      // v3.6 — branches threshold raised 72→74 after the coverage uplift
      // pass. v3.5.9 had dropped it from 73→72 because local was at 72.94%
      // (knife-edge against CI). This release adds targeted tests for
      // bases predicates, embeddings reranker resolution, http-transport
      // parse-error + DELETE/PATCH method-not-allowed branches, watcher
      // FTS5 reindex paths, doctor FTS5/embed-db ok branches, pdf cache
      // branches, and periodic formatToken switch cases. Branches moved
      // 72.94% → 75.29% (+2.35pp). 74 leaves a ~1.3pp safety margin
      // against CI-vs-local environment drift.
      thresholds: {
        lines: 86,
        statements: 82,
        functions: 75,
        branches: 74
      }
    }
  }
});
