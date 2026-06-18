// v3.10.0-rc.50 — unit test for the scoped npm-audit gate (scripts/check-audit.mjs).
// Proves the allowlist logic isn't vacuous: an un-allowlisted advisory at/above the
// threshold fails; the documented one passes; below-threshold is ignored.

import { describe, expect, it } from "vitest";
// @ts-expect-error — .mjs script, no types; we exercise the pure exported core.
import { ALLOWLIST, offendingAdvisories } from "../scripts/check-audit.mjs";

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
    "noisy-pkg": {
      severity: "low",
      via: [
        { url: "https://github.com/advisories/GHSA-dddd-eeee-ffff", severity: "low", title: "minor", name: "noisy-pkg" }
      ]
    }
  }
};

// The gate LOGIC is exercised with an explicit local allowlist (decoupled from the live
// ALLOWLIST, which is now empty after rc.53 resolved the js-yaml advisory).
const TEST_ALLOW = { "GHSA-h67p-54hq-rp68": "test-only documented entry" };

describe("check-audit scoped gate (rc.50)", () => {
  it("flags an un-allowlisted advisory at/above threshold (NEGATIVE control — not vacuous)", () => {
    const offenders = offendingAdvisories(sample, { minSeverity: "moderate", allowlist: TEST_ALLOW });
    const ids = offenders.map((o: { id: string }) => o.id);
    expect(ids).toContain("GHSA-aaaa-bbbb-cccc"); // the un-allowlisted high MUST fail the gate
    expect(ids).not.toContain("GHSA-h67p-54hq-rp68"); // an allowlisted advisory is allowed
    expect(ids).not.toContain("GHSA-dddd-eeee-ffff"); // below threshold (low < moderate) ignored
  });

  it("passes clean once only the (locally-)allowlisted advisory remains (POSITIVE)", () => {
    const onlyAllowlisted = { vulnerabilities: { "js-yaml": sample.vulnerabilities["js-yaml"] } };
    expect(offendingAdvisories(onlyAllowlisted, { minSeverity: "moderate", allowlist: TEST_ALLOW })).toEqual([]);
  });

  it("the live ALLOWLIST is EMPTY — strictest posture (drift guard)", () => {
    // v3.10.0-rc.53 — the js-yaml advisory was RESOLVED (gray-matter dropped), so the
    // allowlist is empty again. Any future addition forces a conscious update here +
    // keeps the allowlist from silently growing.
    expect(Object.keys(ALLOWLIST)).toEqual([]);
  });
});
