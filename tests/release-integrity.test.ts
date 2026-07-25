import { readFileSync } from "node:fs";
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
  });
});
