import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
// @ts-expect-error — .mjs release script has no declaration file; tests exercise its pure core.
import {
  assertReleaseTagMatchesVersion,
  evaluateReleaseChecks,
  REQUIRED_RELEASE_CHECKS
} from "../scripts/check-release-integrity.mjs";

interface CheckRun {
  id: number;
  name: string;
  status: "completed" | "in_progress";
  conclusion: string | null;
  started_at: string;
}

function run(
  name: string,
  id: number,
  conclusion: string | null = "success",
  status: CheckRun["status"] = "completed"
): CheckRun {
  return {
    id,
    name,
    status,
    conclusion,
    started_at: new Date(Date.UTC(2026, 6, 25, 0, 0, id)).toISOString()
  };
}

function allSuccessful(): CheckRun[] {
  return REQUIRED_RELEASE_CHECKS.map((name: string, index: number) => run(name, index + 1));
}

type YamlRecord = Record<string, unknown>;

function yamlRecord(value: unknown): YamlRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as YamlRecord) : null;
}

function yamlSteps(job: YamlRecord): YamlRecord[] {
  const value = job.steps;
  if (!Array.isArray(value)) return [];
  return value.map(yamlRecord).filter((step): step is YamlRecord => step !== null);
}

function namedStep(steps: YamlRecord[], name: string): YamlRecord | undefined {
  return steps.find((step) => step.name === name);
}

function runBody(step: YamlRecord | undefined): string {
  return typeof step?.run === "string" ? step.run : "";
}

function hasRunLine(step: YamlRecord | undefined, command: string): boolean {
  return runBody(step)
    .split("\n")
    .some((line) => line.trim() === command);
}

function nodeFloorCiProblems(workflow: string, enginesNode: unknown): string[] {
  const floorMatch = typeof enginesNode === "string" ? /^>=(\d+\.\d+\.\d+)$/.exec(enginesNode) : null;
  if (!floorMatch) return ["engines.node must be one exact >=X.Y.Z floor"];
  const floor = floorMatch[1] ?? "";
  const major = floor.split(".")[0] ?? "";
  const problems: string[] = [];

  let document: YamlRecord | null = null;
  try {
    document = yamlRecord(load(workflow));
  } catch {
    return ["ci.yml must be valid YAML"];
  }
  const jobs = yamlRecord(document?.jobs);
  const testJob = yamlRecord(jobs?.test);
  const smokeJob = yamlRecord(jobs?.smoke);
  if (!testJob) return ["missing test job"];
  if (major !== "22") {
    problems.push("engines.node major changed; update the stable release-check inventory");
  }
  if (testJob.name !== `test (\${{ matrix.label }})`) {
    problems.push("test job must preserve stable matrix labels");
  }
  if ("continue-on-error" in testJob) {
    problems.push("test job must not declare continue-on-error");
  }
  if (yamlRecord(testJob.env)?.NPM_CONFIG_ENGINE_STRICT !== "true") {
    problems.push("test job must enforce npm engine-strict");
  }

  const strategy = yamlRecord(testJob.strategy);
  const matrix = yamlRecord(strategy?.matrix);
  const includeValue = matrix?.include;
  const rows = Array.isArray(includeValue)
    ? includeValue.map(yamlRecord).filter((row): row is YamlRecord => row !== null)
    : [];
  if (rows.length !== 2) {
    problems.push("test matrix must contain exactly the floor and Node 24 control legs");
  }
  const floorRow = rows.find((row) => row.label === "22");
  if (floorRow?.["node-version"] !== floor || floorRow.floor !== true) {
    problems.push(`test (${major}) must run exact engines.node floor ${floor}`);
  }
  const controlRow = rows.find((row) => row.label === "24");
  if (controlRow?.["node-version"] !== "24" || controlRow.floor !== false) {
    problems.push("test (24) control leg is missing");
  }

  const testSteps = yamlSteps(testJob);
  const testSetup = testSteps.find(
    (step) => typeof step.uses === "string" && step.uses.startsWith("actions/setup-node@")
  );
  if (yamlRecord(testSetup?.with)?.["node-version"] !== `\${{ matrix.node-version }}`) {
    problems.push("test setup-node must consume matrix.node-version");
  }
  const assertion = namedStep(testSteps, "Assert exact declared Node floor");
  const assertionRun = runBody(assertion);
  if (
    assertion?.if !== "matrix.floor" ||
    !assertionRun.includes('require("./package.json").engines?.node') ||
    !assertionRun.includes("process.versions.node") ||
    !assertionRun.includes("if (declared !== expected)") ||
    !assertionRun.includes("throw new Error")
  ) {
    problems.push("test floor runtime assertion is missing");
  }

  const install = namedStep(testSteps, "Install deps (npm ci with retry)");
  if (!hasRunLine(install, "npm ci && break")) {
    problems.push("test floor job missing executable npm ci retry");
  }
  if (!testSteps.some((step) => step.run === "npm run build")) {
    problems.push("test floor job missing npm run build");
  }
  const probe = namedStep(testSteps, "Probe native SQLite and FTS5 at declared floor");
  const probeRun = runBody(probe);
  if (
    probe?.if !== "matrix.floor" ||
    "continue-on-error" in (probe ?? {}) ||
    !probeRun.includes('new Database(":memory:")') ||
    !probeRun.includes("CREATE VIRTUAL TABLE notes USING fts5") ||
    !probeRun.includes("INSERT INTO notes") ||
    !probeRun.includes("notes MATCH") ||
    !probeRun.includes("db.close()")
  ) {
    problems.push("test floor native SQLite/FTS probe is missing");
  }
  if (!testSteps.some((step) => step.run === "npm test")) {
    problems.push("test floor job missing npm test");
  }

  if (!smokeJob) return [...problems, "missing smoke job"];
  if (smokeJob.needs !== "test") {
    problems.push("smoke must wait for the test matrix");
  }
  if ("continue-on-error" in smokeJob) {
    problems.push("smoke job must not declare continue-on-error");
  }
  if (yamlRecord(smokeJob.env)?.NPM_CONFIG_ENGINE_STRICT !== "true") {
    problems.push("smoke job must enforce npm engine-strict");
  }
  const smokeSteps = yamlSteps(smokeJob);
  const smokeSetup = smokeSteps.find(
    (step) => typeof step.uses === "string" && step.uses.startsWith("actions/setup-node@")
  );
  if (yamlRecord(smokeSetup?.with)?.["node-version"] !== floor) {
    problems.push(`smoke must run exact engines.node floor ${floor}`);
  }
  const smokeInstall = namedStep(smokeSteps, "Install deps (npm ci with retry)");
  if (!hasRunLine(smokeInstall, "npm ci && break")) {
    problems.push("smoke job missing executable npm ci retry");
  }
  if (!smokeSteps.some((step) => step.run === "npm run build")) {
    problems.push("smoke job missing npm run build");
  }
  const scanRun = runBody(namedStep(smokeSteps, "JSON-RPC smoke test (scan path)"));
  if (!scanRun.includes("node scripts/smoke.mjs") || scanRun.includes("--with-fts")) {
    problems.push("smoke job missing the scan-path command");
  }
  const ftsRun = runBody(namedStep(smokeSteps, "JSON-RPC smoke test (FTS5 --persistent-index path)"));
  if (!ftsRun.includes("node scripts/smoke.mjs") || !ftsRun.includes("--with-fts")) {
    problems.push("smoke job missing the persistent-FTS command");
  }

  return problems;
}

describe("release identity and exact required-check gate", () => {
  it("accepts only the tag derived from package.json version", () => {
    expect(assertReleaseTagMatchesVersion("v3.12.0-rc.10", "3.12.0-rc.10")).toBe("v3.12.0-rc.10");
  });

  it("rejects a different or missing trigger tag (NEGATIVE control)", () => {
    expect(() => assertReleaseTagMatchesVersion("v3.12.0-rc.9", "3.12.0-rc.10")).toThrow(
      /does not match package version/
    );
    expect(() => assertReleaseTagMatchesVersion("", "3.12.0-rc.10")).toThrow(/tag is missing/);
  });

  it("requires one successful run for every exact context", () => {
    expect(evaluateReleaseChecks(allSuccessful())).toEqual({
      state: "ready",
      succeeded: REQUIRED_RELEASE_CHECKS,
      missing: [],
      pending: [],
      failed: []
    });
  });

  it("does not let a duplicate run hide a missing context (NEGATIVE control)", () => {
    const checks = allSuccessful().filter((item) => item.name !== "oia");
    checks.push(run("lint", 20), run("lint", 21), run("lint-extra", 22));
    const result = evaluateReleaseChecks(checks);
    expect(result.state).toBe("pending");
    expect(result.succeeded).toHaveLength(REQUIRED_RELEASE_CHECKS.length - 1);
    expect(result.missing).toEqual(["oia"]);
  });

  it("uses the latest rerun for each context", () => {
    const recovered = [...allSuccessful(), run("audit", 30, "failure"), run("audit", 31, "success")];
    expect(evaluateReleaseChecks(recovered).state).toBe("ready");

    const regressed = [...allSuccessful(), run("coverage", 40, "success"), run("coverage", 41, "failure")];
    expect(evaluateReleaseChecks(regressed)).toMatchObject({
      state: "failed",
      failed: [{ name: "coverage", conclusion: "failure" }]
    });
  });

  it("distinguishes in-progress from completed non-success checks", () => {
    const pending = [...allSuccessful(), run("docs", 50, null, "in_progress")];
    expect(evaluateReleaseChecks(pending)).toMatchObject({ state: "pending", pending: ["docs"] });

    const skipped = [...allSuccessful(), run("smoke", 51, "skipped")];
    expect(evaluateReleaseChecks(skipped)).toMatchObject({
      state: "failed",
      failed: [{ name: "smoke", conclusion: "skipped" }]
    });
  });

  it("keeps release.yml wired to the shared evaluator and an exact mirrored inventory", () => {
    const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
    expect(workflow).toContain('node scripts/check-release-integrity.mjs assert-tag "$TAG" "$VERSION"');
    expect(workflow).toContain("node scripts/check-release-integrity.mjs checks");
    expect(workflow).toMatch(/RELEASE_TAG:\s*\$\{\{\s*github\.event\.inputs\.tag \|\| github\.ref_name\s*\}\}/);
    expect(workflow).not.toMatch(/TAG="\$\{\{/);
    const mirror = /REQUIRED="([^"]+)"/.exec(workflow)?.[1];
    expect(mirror, "release.yml must retain the public gate-count mirror").toBeTruthy();
    expect((mirror ?? "").split("|").map((name) => name.replaceAll("\\(", "(").replaceAll("\\)", ")"))).toEqual(
      REQUIRED_RELEASE_CHECKS
    );

    const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      engines?: { node?: unknown };
    };
    expect(nodeFloorCiProblems(ci, pkg.engines?.node)).toEqual([]);

    // NEGATIVE controls: the invariant rejects both the old floating-22 leg
    // and a floor that no longer matches package.json.
    expect(nodeFloorCiProblems(ci.replace('node-version: "22.13.0"', "node-version: 22"), pkg.engines?.node)).toContain(
      "test (22) must run exact engines.node floor 22.13.0"
    );
    expect(nodeFloorCiProblems(ci, ">=22.14.0")).toContain("test (22) must run exact engines.node floor 22.14.0");
    expect(nodeFloorCiProblems(ci, "22.13.0")).toEqual(["engines.node must be one exact >=X.Y.Z floor"]);
    expect(
      nodeFloorCiProblems(
        ci.replace('      NPM_CONFIG_ENGINE_STRICT: "true"', '      NPM_CONFIG_ENGINE_STRICT: "false"'),
        pkg.engines?.node
      )
    ).toContain("test job must enforce npm engine-strict");
    expect(nodeFloorCiProblems(ci.replace("if (declared !== expected)", "if (false)"), pkg.engines?.node)).toContain(
      "test floor runtime assertion is missing"
    );
    expect(
      nodeFloorCiProblems(
        ci.replace(
          "- name: Probe native SQLite and FTS5 at declared floor\n        if: matrix.floor",
          "- name: Probe native SQLite and FTS5 at declared floor\n        if: false"
        ),
        pkg.engines?.node
      )
    ).toContain("test floor native SQLite/FTS probe is missing");
    expect(
      nodeFloorCiProblems(
        ci.replace("      - run: npm test\n        env:", "      - run: echo npm test\n        env:"),
        pkg.engines?.node
      )
    ).toContain("test floor job missing npm test");
    expect(
      nodeFloorCiProblems(
        ci.replace(
          "    timeout-minutes: 10\n    env:",
          "    timeout-minutes: 10\n    continue-on-error: true\n    env:"
        ),
        pkg.engines?.node
      )
    ).toContain("test job must not declare continue-on-error");
    expect(
      nodeFloorCiProblems(
        ci.replace(/(\n {2}smoke:[\s\S]*?node-version:) "22\.13\.0"/, (_match, prefix: string) => `${prefix} 22`),
        pkg.engines?.node
      )
    ).toContain("smoke must run exact engines.node floor 22.13.0");
  });
});
