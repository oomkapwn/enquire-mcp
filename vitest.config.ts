import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
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
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "**/*.test.ts"],
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
