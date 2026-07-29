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
  const windowsJob = yamlRecord(jobs?.["test-windows"]);
  const docsJob = yamlRecord(jobs?.docs);
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

  if (!windowsJob) {
    problems.push("missing blocking test-windows job");
  } else {
    if (windowsJob.name !== "test-windows" || windowsJob["runs-on"] !== "windows-2025") {
      problems.push("test-windows must preserve its exact name and pinned windows-2025 runner");
    }
    if ("continue-on-error" in windowsJob || "if" in windowsJob || "needs" in windowsJob || "strategy" in windowsJob) {
      problems.push("test-windows must be an unconditional fail-capable standalone job");
    }
    const windowsEnv = yamlRecord(windowsJob.env);
    if (windowsEnv?.NPM_CONFIG_ENGINE_STRICT !== "true") {
      problems.push("test-windows must enforce npm engine-strict");
    }
    if (windowsEnv?.NPM_CONFIG_SCRIPT_SHELL !== "C:\\Program Files\\Git\\bin\\bash.exe") {
      problems.push("test-windows must run npm lifecycle scripts through pinned Git Bash");
    }
    if (yamlRecord(yamlRecord(windowsJob.defaults)?.run)?.shell !== "bash") {
      problems.push("test-windows steps must run through Git Bash");
    }

    const windowsSteps = yamlSteps(windowsJob);
    if (windowsSteps.some((step) => "continue-on-error" in step || "if" in step)) {
      problems.push("test-windows steps must be unconditional and must not declare continue-on-error");
    }
    const windowsSetup = windowsSteps.find(
      (step) => typeof step.uses === "string" && step.uses.startsWith("actions/setup-node@")
    );
    if (yamlRecord(windowsSetup?.with)?.["node-version"] !== floor) {
      problems.push(`test-windows must run exact engines.node floor ${floor}`);
    }
    const windowsAssertion = namedStep(windowsSteps, "Assert real case-insensitive Windows filesystem");
    const windowsAssertionRun = runBody(windowsAssertion);
    if (
      !windowsAssertionRun.includes('process.platform !== "win32"') ||
      !windowsAssertionRun.includes('"CaseProbe.md"') ||
      !windowsAssertionRun.includes('"caseprobe.md"') ||
      !windowsAssertionRun.includes("writeFileSync") ||
      !windowsAssertionRun.includes("existsSync") ||
      !windowsAssertionRun.includes('if (!existsSync(join(dir, "caseprobe.md")))') ||
      !windowsAssertionRun.includes('throw new Error("Windows filesystem probe is not case-insensitive")') ||
      !windowsAssertionRun.includes("finally") ||
      !windowsAssertionRun.includes("rmSync")
    ) {
      problems.push("test-windows platform and case-insensitive filesystem assertion is missing");
    }
    const windowsInstall = namedStep(windowsSteps, "Install deps (npm ci with retry)");
    if (!hasRunLine(windowsInstall, "npm ci && break")) {
      problems.push("test-windows missing executable npm ci retry");
    }
    if (!windowsSteps.some((step) => step.run === "npm run build")) {
      problems.push("test-windows missing npm run build");
    }
    const windowsProbeRun = runBody(namedStep(windowsSteps, "Probe native SQLite and FTS5 on Windows"));
    if (
      !windowsProbeRun.includes('new Database(":memory:")') ||
      !windowsProbeRun.includes("CREATE VIRTUAL TABLE notes USING fts5") ||
      !windowsProbeRun.includes("INSERT INTO notes(body) VALUES (?)") ||
      !windowsProbeRun.includes("notes MATCH") ||
      !windowsProbeRun.includes('row?.body !== "windows probe"') ||
      !windowsProbeRun.includes('throw new Error("Windows SQLite FTS5 probe returned the wrong row")') ||
      !windowsProbeRun.includes("db.close()")
    ) {
      problems.push("test-windows native SQLite/FTS probe is missing");
    }
    if (!windowsSteps.some((step) => step.run === "npm test -- tests/windows-path-safety.test.ts")) {
      problems.push("test-windows missing the executable hostile-filesystem suite");
    }
  }

  if (!docsJob) {
    problems.push("missing docs job");
  } else {
    const docsSteps = yamlSteps(docsJob);
    const previewRenderIndex = docsSteps.findIndex((step) => step.run === "npm run render:preview");
    const previewDiffIndex = docsSteps.findIndex((step) => step.name === "Require committed social-preview bytes");
    const previewRender = docsSteps[previewRenderIndex];
    const previewDiff = docsSteps[previewDiffIndex];
    if (
      "if" in docsJob ||
      "continue-on-error" in docsJob ||
      !previewRender ||
      "if" in previewRender ||
      "continue-on-error" in previewRender ||
      previewRenderIndex >= previewDiffIndex ||
      previewDiff?.run !== "git diff --exit-code -- assets/social-preview.png" ||
      "if" in (previewDiff ?? {}) ||
      "continue-on-error" in (previewDiff ?? {})
    ) {
      problems.push("docs job must regenerate and fail closed on social-preview byte drift");
    }
  }

  if (!smokeJob) return [...problems, "missing smoke job"];
  const smokeNeeds = Array.isArray(smokeJob.needs) ? smokeJob.needs.filter((item) => typeof item === "string") : [];
  if (smokeNeeds.length !== 2 || !smokeNeeds.includes("test") || !smokeNeeds.includes("test-windows")) {
    problems.push("smoke must wait for exactly the Linux matrix and blocking Windows job");
  }
  if (smokeJob.if !== `\${{ always() }}`) {
    problems.push("smoke must run its prerequisite gate even after an upstream failure");
  }
  if ("continue-on-error" in smokeJob) {
    problems.push("smoke job must not declare continue-on-error");
  }
  if (yamlRecord(smokeJob.env)?.NPM_CONFIG_ENGINE_STRICT !== "true") {
    problems.push("smoke job must enforce npm engine-strict");
  }
  const smokeSteps = yamlSteps(smokeJob);
  if (smokeSteps.slice(1).some((step) => "continue-on-error" in step || "if" in step)) {
    problems.push("smoke functional steps must be unconditional and fail-capable");
  }
  const prerequisiteGate = smokeSteps[0];
  const prerequisiteEnv = yamlRecord(prerequisiteGate?.env);
  const prerequisiteRun = runBody(prerequisiteGate);
  if (
    prerequisiteGate?.name !== "Require Linux and Windows test prerequisites" ||
    "continue-on-error" in (prerequisiteGate ?? {}) ||
    "if" in (prerequisiteGate ?? {}) ||
    prerequisiteEnv?.LINUX_TEST_RESULT !== `\${{ needs.test.result }}` ||
    prerequisiteEnv?.WINDOWS_TEST_RESULT !== `\${{ needs['test-windows'].result }}` ||
    !prerequisiteRun.includes('"$LINUX_TEST_RESULT" != "success"') ||
    !prerequisiteRun.includes('"$WINDOWS_TEST_RESULT" != "success"') ||
    !prerequisiteRun.includes("] || [") ||
    !prerequisiteRun.includes("exit 1")
  ) {
    problems.push("smoke prerequisite gate must fail closed on either Linux or Windows failure");
  }
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
    expect(
      nodeFloorCiProblems(
        ci.replace(
          /(\n {2}test-windows:[\s\S]*?runs-on:) windows-2025/,
          (_match, prefix: string) => `${prefix} ubuntu-latest`
        ),
        pkg.engines?.node
      )
    ).toContain("test-windows must preserve its exact name and pinned windows-2025 runner");
    expect(
      nodeFloorCiProblems(
        ci.replace(
          /(\n {2}test-windows:[\s\S]*?node-version:) "22\.13\.0"/,
          (_match, prefix: string) => `${prefix} 22`
        ),
        pkg.engines?.node
      )
    ).toContain("test-windows must run exact engines.node floor 22.13.0");
    expect(
      nodeFloorCiProblems(
        ci.replace("      NPM_CONFIG_SCRIPT_SHELL: 'C:\\Program Files\\Git\\bin\\bash.exe'\n", ""),
        pkg.engines?.node
      )
    ).toContain("test-windows must run npm lifecycle scripts through pinned Git Bash");
    expect(nodeFloorCiProblems(ci.replace('"caseprobe.md"', '"CaseProbe.md"'), pkg.engines?.node)).toContain(
      "test-windows platform and case-insensitive filesystem assertion is missing"
    );
    expect(
      nodeFloorCiProblems(
        ci.replace(
          "      - name: Probe native SQLite and FTS5 on Windows\n",
          "      - name: Probe native SQLite and FTS5 on Windows\n        if: false\n"
        ),
        pkg.engines?.node
      )
    ).toContain("test-windows steps must be unconditional and must not declare continue-on-error");
    expect(
      nodeFloorCiProblems(
        ci.replace(
          '              throw new Error("Windows filesystem probe is not case-insensitive");',
          "              return;"
        ),
        pkg.engines?.node
      )
    ).toContain("test-windows platform and case-insensitive filesystem assertion is missing");
    expect(
      nodeFloorCiProblems(
        ci.replace('if (row?.body !== "windows probe")', 'if (row?.body === "windows probe")'),
        pkg.engines?.node
      )
    ).toContain("test-windows native SQLite/FTS probe is missing");
    expect(
      nodeFloorCiProblems(
        ci.replace(
          "      - run: npm test -- tests/windows-path-safety.test.ts",
          "      - run: echo npm test -- tests/windows-path-safety.test.ts"
        ),
        pkg.engines?.node
      )
    ).toContain("test-windows missing the executable hostile-filesystem suite");
    expect(
      nodeFloorCiProblems(
        ci.replace("        run: npm run render:preview", "        run: echo npm run render:preview"),
        pkg.engines?.node
      )
    ).toContain("docs job must regenerate and fail closed on social-preview byte drift");
    expect(
      nodeFloorCiProblems(
        ci.replace("  docs:\n    runs-on: ubuntu-latest", "  docs:\n    if: false\n    runs-on: ubuntu-latest"),
        pkg.engines?.node
      )
    ).toContain("docs job must regenerate and fail closed on social-preview byte drift");
    expect(
      nodeFloorCiProblems(
        ci.replace(
          "      - id: preview_render\n        run: npm run render:preview\n" +
            "      - name: Require committed social-preview bytes\n" +
            "        id: preview_diff\n" +
            "        run: git diff --exit-code -- assets/social-preview.png\n",
          "      - name: Require committed social-preview bytes\n" +
            "        id: preview_diff\n" +
            "        run: git diff --exit-code -- assets/social-preview.png\n" +
            "      - id: preview_render\n" +
            "        run: npm run render:preview\n"
        ),
        pkg.engines?.node
      )
    ).toContain("docs job must regenerate and fail closed on social-preview byte drift");
    expect(
      nodeFloorCiProblems(
        ci.replace(
          "      - name: Require committed social-preview bytes\n",
          "      - name: Require committed social-preview bytes\n        if: false\n"
        ),
        pkg.engines?.node
      )
    ).toContain("docs job must regenerate and fail closed on social-preview byte drift");
    expect(
      nodeFloorCiProblems(ci.replace("    needs: [test, test-windows]", "    needs: [test]"), pkg.engines?.node)
    ).toContain("smoke must wait for exactly the Linux matrix and blocking Windows job");
    expect(
      nodeFloorCiProblems(ci.replace(`    if: \${{ always() }}`, "    if: success()"), pkg.engines?.node)
    ).toContain("smoke must run its prerequisite gate even after an upstream failure");
    expect(nodeFloorCiProblems(ci.replace(' ] || [ "', ' ] && [ "'), pkg.engines?.node)).toContain(
      "smoke prerequisite gate must fail closed on either Linux or Windows failure"
    );
    expect(
      nodeFloorCiProblems(
        ci.replace(
          "      - name: Require Linux and Windows test prerequisites\n",
          "      - name: Require Linux and Windows test prerequisites\n        if: false\n"
        ),
        pkg.engines?.node
      )
    ).toContain("smoke prerequisite gate must fail closed on either Linux or Windows failure");
    expect(
      nodeFloorCiProblems(
        ci.replace(
          "      - name: JSON-RPC smoke test (scan path)\n",
          "      - name: JSON-RPC smoke test (scan path)\n        if: false\n"
        ),
        pkg.engines?.node
      )
    ).toContain("smoke functional steps must be unconditional and fail-capable");
    expect(
      nodeFloorCiProblems(
        ci.replace(
          "            exit 1\n          fi\n      - uses: actions/checkout@",
          "            exit 0\n          fi\n      - uses: actions/checkout@"
        ),
        pkg.engines?.node
      )
    ).toContain("smoke prerequisite gate must fail closed on either Linux or Windows failure");
    expect(REQUIRED_RELEASE_CHECKS).not.toContain("test-windows");
  });
});
