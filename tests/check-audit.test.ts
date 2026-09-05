// v3.10.0-rc.50 — unit test for the scoped npm-audit gate (scripts/check-audit.mjs).
// Proves the allowlist logic isn't vacuous: an un-allowlisted advisory at/above the
// threshold fails; the documented one passes; below-threshold is ignored.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error — .mjs script, no types; we exercise the pure exported core.
import {
  ALLOWLIST,
  auditAttemptTimeoutPayload,
  CONSUMER_ALLOWLIST,
  consumerAllowlistForVersion,
  invalidAllowlistEntries,
  npmProcessSpec,
  offendingAdvisories,
  packedConsumerManifest,
  releaseChannelForVersion,
  retryableAuditError,
  staleAllowlistEntries,
  validateAuditReport,
  validateAuditReportWithRetry
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
    // separately and may neither grow nor silently outlive the current audit evidence.
    expect(Object.keys(ALLOWLIST)).toEqual([]);
    expect(Object.keys(CONSUMER_ALLOWLIST).sort()).toEqual(["GHSA-f88m-g3jw-g9cj", "GHSA-xcpc-8h2w-3j85"].sort());
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

    const cleanAuditReport = {
      auditReportVersion: 2,
      vulnerabilities: {},
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } }
    };
    expect(
      retryableAuditError({
        message: "503 Service Unavailable",
        method: "POST",
        uri: "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
        headers: {},
        statusCode: 503,
        body: "upstream unavailable"
      })
    ).toMatchObject({ statusCode: 503 });
    expect(retryableAuditError({ error: { code: "EAI_AGAIN" } })).toMatchObject({ code: "EAI_AGAIN" });
    expect(retryableAuditError({ auditReportVersion: 2, statusCode: 503 })).toBeUndefined();

    let transientAttempts = 0;
    const retrySleeps: number[] = [];
    const retryWarnings: Array<{ number: number; attempts: number; delayMs: number; diagnostic: string }> = [];
    const recoveredAudit = validateAuditReportWithRetry(
      () => {
        transientAttempts++;
        return transientAttempts < 3
          ? {
              message: "registry response contains SECRET-MESSAGE",
              method: "POST",
              uri: "https://token@registry.npmjs.org/-/npm/v1/security/advisories/bulk",
              headers: { authorization: "SECRET-HEADER" },
              statusCode: 503,
              body: "SECRET-BODY"
            }
          : cleanAuditReport;
      },
      {
        backoffMs: 5,
        sleep: (ms: number) => retrySleeps.push(ms),
        onRetry: (event: { number: number; attempts: number; delayMs: number; diagnostic: string }) =>
          retryWarnings.push(event),
        label: "published-consumer"
      }
    );
    expect(recoveredAudit).toEqual(cleanAuditReport);
    expect(transientAttempts).toBe(3);
    expect(retrySleeps).toEqual([5, 10]);
    expect(retryWarnings.map((event) => event.diagnostic)).toEqual(["status=503", "status=503"]);

    // A silent hang: execFileSync kills the attempt, there is no stdout. That is a
    // transient with a NAME, not "no JSON" and not a bare exit 124 from the job.
    const hang = auditAttemptTimeoutPayload({ killed: true, signal: "SIGKILL", stdout: "" }, 40_000);
    expect(retryableAuditError(hang)).toMatchObject({ code: "ETIMEDOUT" });
    expect(() =>
      validateAuditReportWithRetry(() => hang, { attempts: 2, backoffMs: 1, sleep: () => {}, label: "source" })
    ).toThrow(/after 2 attempts \(code=ETIMEDOUT \(npm audit produced no output within 40 s/);
    // NEGATIVE: output present (vulnerabilities make npm exit non-zero) is a report,
    // and an unrelated failure is not a timeout — both keep the fail-closed path.
    expect(auditAttemptTimeoutPayload({ status: 1, stdout: '{"auditReportVersion":2}' }, 40_000)).toBeUndefined();
    expect(auditAttemptTimeoutPayload({ code: "ENOENT", stdout: "" }, 40_000)).toBeUndefined();
    expect(JSON.stringify(retryWarnings)).not.toMatch(/SECRET|registry\.npmjs\.org/);

    let exhaustedAttempts = 0;
    expect(() =>
      validateAuditReportWithRetry(
        () => {
          exhaustedAttempts++;
          return { statusCode: 503, message: "SECRET-FINAL" };
        },
        { attempts: 3, backoffMs: 0, sleep: () => {}, label: "published-consumer" }
      )
    ).toThrow(/after 3 attempts \(status=503\); refusing to treat it as clean/);
    expect(exhaustedAttempts).toBe(3);

    const advisoryReport = {
      auditReportVersion: 2,
      vulnerabilities: {
        "evil-pkg": {
          severity: "high",
          via: [
            {
              url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
              severity: "high",
              title: "RCE",
              name: "evil-pkg"
            }
          ]
        }
      },
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } }
    };
    let advisoryAttempts = 0;
    let advisorySleeps = 0;
    const validatedAdvisory = validateAuditReportWithRetry(
      () => {
        advisoryAttempts++;
        return advisoryReport;
      },
      { sleep: () => advisorySleeps++ }
    );
    expect(advisoryAttempts).toBe(1);
    expect(advisorySleeps).toBe(0);
    expect(
      offendingAdvisories(validatedAdvisory, { minSeverity: "moderate", allowlist: {} }).map(
        (advisory: { id: string }) => advisory.id
      )
    ).toContain("GHSA-aaaa-bbbb-cccc");

    const immediateFailures = [
      { name: "permanent status", value: { statusCode: 401, message: "not authorized" } },
      { name: "unknown code", value: { error: { code: "EUNKNOWN", summary: "SECRET-UNKNOWN" } } },
      { name: "contradictory signals", value: { error: { code: "E503", statusCode: 401 } } },
      {
        name: "report-shaped error",
        value: {
          ...cleanAuditReport,
          error: { code: "E503", statusCode: 503 }
        }
      },
      { name: "malformed payload", value: {} }
    ];
    for (const { name, value } of immediateFailures) {
      let calls = 0;
      const failure = (() => {
        try {
          validateAuditReportWithRetry(
            () => {
              calls++;
              return value;
            },
            { sleep: () => expect.fail(`${name} must not sleep`) }
          );
          return null;
        } catch (error) {
          return error;
        }
      })();
      expect(calls, name).toBe(1);
      expect(failure, name).toBeInstanceOf(Error);
      expect((failure as Error).message, name).toMatch(/refusing to treat it as clean/);
      expect((failure as Error).message, name).not.toMatch(/SECRET|registry\.npmjs\.org/);
    }

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
    expect(consumerAllowlistForVersion("4.0.0-rc.1", CONSUMER_ALLOWLIST)).toBe(CONSUMER_ALLOWLIST);
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
