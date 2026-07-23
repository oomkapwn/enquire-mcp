// v3.10.0-rc.50 — unit test for the scoped npm-audit gate (scripts/check-audit.mjs).
// Proves the allowlist logic isn't vacuous: an un-allowlisted advisory at/above the
// threshold fails; the documented one passes; below-threshold is ignored.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error — .mjs script, no types; we exercise the pure exported core.
import {
  ALLOWLIST,
  CONSUMER_ALLOWLIST,
  consumerAllowlistForVersion,
  invalidAllowlistEntries,
  npmProcessSpec,
  offendingAdvisories,
  packedConsumerManifest,
  releaseChannelForVersion,
  staleAllowlistEntries,
  validateAuditReport
} from "../scripts/check-audit.mjs";

const sample = {
  vulnerabilities: {
    "js-yaml": {
      severity: "moderate",
      via: [
        {
          url: "https://github.com/advisories/GHSA-h67p-54hq-rp68",
          severity: "moderate",
          title: "merge-key DoS",
          name: "js-yaml"
        }
      ]
    },
    "gray-matter": { severity: "moderate", via: ["js-yaml"] }, // inherited (string via — no own GHSA)
    "evil-pkg": {
      severity: "high",
      via: [
        { url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", severity: "high", title: "RCE", name: "evil-pkg" }
      ]
    },
    "non-ghsa-pkg": {
      severity: "high",
      via: [{ source: 4242, severity: "high", title: "Future npm advisory", name: "non-ghsa-pkg" }]
    },
    "unknown-severity-pkg": {
      severity: "severe",
      via: [{ source: 4243, severity: "severe", title: "Future severity", name: "unknown-severity-pkg" }]
    },
    "noisy-pkg": {
      severity: "low",
      via: [
        { url: "https://github.com/advisories/GHSA-dddd-eeee-ffff", severity: "low", title: "minor", name: "noisy-pkg" }
      ]
    }
  }
};

// The gate LOGIC is exercised with an explicit local allowlist (decoupled from
// both live source/consumer policies).
const TEST_ALLOW = { "GHSA-h67p-54hq-rp68": "test-only documented entry" };

function releaseWorkflowUsesSharedChannelResolver(source: string): boolean {
  const step = /- name: Resolve npm dist-tag from version[\s\S]*?(?=\n {6}- name:)/.exec(source)?.[0] ?? "";
  return (
    step.includes("import { releaseChannelForVersion } from './scripts/check-audit.mjs';") &&
    step.includes("console.log(releaseChannelForVersion(v));") &&
    !step.includes(".match(")
  );
}

describe("check-audit scoped gate (rc.50)", () => {
  it("flags an un-allowlisted advisory at/above threshold (NEGATIVE control — not vacuous)", () => {
    const offenders = offendingAdvisories(sample, { minSeverity: "moderate", allowlist: TEST_ALLOW });
    const ids = offenders.map((o: { id: string }) => o.id);
    expect(ids).toContain("GHSA-aaaa-bbbb-cccc"); // the un-allowlisted high MUST fail the gate
    expect(ids).toContain("npm:4242"); // a non-GHSA advisory MUST NOT disappear from the gate
    expect(ids).toContain("npm:4243"); // a future severity MUST fail closed, not rank below the floor
    expect(ids).not.toContain("GHSA-h67p-54hq-rp68"); // an allowlisted advisory is allowed
    expect(ids).not.toContain("GHSA-dddd-eeee-ffff"); // below threshold (low < moderate) ignored
  });

  it("passes clean once only the (locally-)allowlisted advisory remains (POSITIVE)", () => {
    const onlyAllowlisted = { vulnerabilities: { "js-yaml": sample.vulnerabilities["js-yaml"] } };
    expect(offendingAdvisories(onlyAllowlisted, { minSeverity: "moderate", allowlist: TEST_ALLOW })).toEqual([]);
  });

  it("keeps the source allowlist empty and pins the consumer-only exceptions (drift guard)", () => {
    // v3.10.0-rc.53 — the js-yaml advisory was RESOLVED (gray-matter dropped), so the
    // source-tree allowlist is empty. Published consumers cannot inherit this
    // package's root overrides, so their exact temporary exceptions are tracked
    // separately and may neither grow nor silently outlive their upstream issue.
    expect(Object.keys(ALLOWLIST)).toEqual([]);
    expect(Object.keys(CONSUMER_ALLOWLIST).sort()).toEqual(
      ["GHSA-f88m-g3jw-g9cj", "GHSA-frvp-7c67-39w9", "GHSA-xcpc-8h2w-3j85"].sort()
    );
    expect(invalidAllowlistEntries(CONSUMER_ALLOWLIST)).toEqual([]);
    expect(
      staleAllowlistEntries(
        Object.keys(CONSUMER_ALLOWLIST).map((id) => ({ id })),
        CONSUMER_ALLOWLIST
      )
    ).toEqual([]);
    expect(
      staleAllowlistEntries([{ id: "GHSA-still-observed" }], {
        "GHSA-still-observed": "Remove at upstream URL",
        "GHSA-now-fixed": "Remove at upstream URL"
      })
    ).toEqual(["GHSA-now-fixed"]);
    expect(
      invalidAllowlistEntries({
        "GHSA-no-removal": "https://github.com/upstream/issues/1",
        "GHSA-no-url": "Remove when upstream fixes it",
        "GHSA-spoofed-host": "Remove when https://evil.example/?next=https://github.com/org/repo/issues/1"
      })
    ).toEqual(["GHSA-no-removal", "GHSA-no-url", "GHSA-spoofed-host"]);

    const published = packedConsumerManifest("@oomkapwn/enquire-mcp", "file:///tmp/enquire-mcp.tgz");
    expect(published).toEqual({
      name: "enquire-mcp-published-consumer-audit",
      version: "0.0.0",
      private: true,
      dependencies: { "@oomkapwn/enquire-mcp": "file:///tmp/enquire-mcp.tgz" }
    });
    expect(published).not.toHaveProperty("devDependencies");
    expect(published).not.toHaveProperty("overrides");

    expect(() =>
      validateAuditReport({
        message: "request failed",
        error: { code: "E503" }
      })
    ).toThrow(/refusing to treat it as clean/);
    expect(() =>
      validateAuditReport({
        auditReportVersion: 2,
        vulnerabilities: [],
        metadata: { vulnerabilities: [] }
      })
    ).toThrow(/malformed report/);
    expect(
      validateAuditReport({
        auditReportVersion: 2,
        vulnerabilities: {},
        metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } }
      })
    ).toHaveProperty("auditReportVersion", 2);
    expect(() =>
      validateAuditReport({
        auditReportVersion: 2,
        vulnerabilities: {
          broken: { severity: "critical", via: [] }
        },
        metadata: { vulnerabilities: { critical: 1, total: 1 } }
      })
    ).toThrow(/incomplete advisory trace/);
    expect(() =>
      validateAuditReport({
        auditReportVersion: 2,
        vulnerabilities: {
          broken: {
            severity: "critical",
            via: [{ source: 1, severity: "low", title: "severity mismatch" }]
          }
        },
        metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 1, total: 1 } }
      })
    ).toThrow(/incomplete advisory trace/);

    expect(npmProcessSpec("linux", {}, "/usr/bin/node")).toEqual({ command: "npm", argsPrefix: [] });
    expect(
      npmProcessSpec(
        "win32",
        { npm_execpath: "C:\\Users\\A&B\\node_modules\\npm\\bin\\npm-cli.js" },
        "C:\\Program Files\\nodejs\\node.exe"
      )
    ).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      argsPrefix: ["C:\\Users\\A&B\\node_modules\\npm\\bin\\npm-cli.js"]
    });
    expect(() => npmProcessSpec("win32", {}, "C:\\node.exe")).toThrow(/npm CLI path unavailable/);

    expect(consumerAllowlistForVersion("3.11.7-rc.8", CONSUMER_ALLOWLIST)).toBe(CONSUMER_ALLOWLIST);
    expect(consumerAllowlistForVersion("3.11.7", CONSUMER_ALLOWLIST)).toEqual({});
    expect(consumerAllowlistForVersion("3.11.7+build.1", CONSUMER_ALLOWLIST)).toEqual({});
    expect(consumerAllowlistForVersion("3.11.7-beta.1", CONSUMER_ALLOWLIST)).toEqual({});
    expect(() => consumerAllowlistForVersion("3.11.7-latest.1", CONSUMER_ALLOWLIST)).toThrow(
      /cannot target the stable npm channel/
    );
    expect(() => consumerAllowlistForVersion("not-semver", CONSUMER_ALLOWLIST)).toThrow(/invalid package version/);

    expect(releaseChannelForVersion("3.11.7")).toBe("latest");
    expect(releaseChannelForVersion("3.11.7+build.1")).toBe("latest");
    expect(releaseChannelForVersion("3.11.7-rc")).toBe("rc");
    expect(releaseChannelForVersion("3.11.7-rc.8+build.1")).toBe("rc");
    expect(releaseChannelForVersion("3.11.7-alpha-3")).toBe("alpha-3");
    expect(() => releaseChannelForVersion("03.11.7-rc.8")).toThrow(/invalid package version/);

    const releaseWorkflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
    expect(releaseWorkflowUsesSharedChannelResolver(releaseWorkflow)).toBe(true);
    const preFixInlineResolver = releaseWorkflow.replace(
      "console.log(releaseChannelForVersion(v));",
      "console.log(v.match(/-([a-z]+)/)?.[1] ?? 'latest');"
    );
    expect(releaseWorkflowUsesSharedChannelResolver(preFixInlineResolver)).toBe(false);
  });
});
