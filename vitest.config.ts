import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
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
      thresholds: {
        lines: 86,
        statements: 82,
        functions: 75,
        branches: 73
      }
    }
  }
});
