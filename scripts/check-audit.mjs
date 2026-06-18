#!/usr/bin/env node
// v3.10.0-rc.50 — scoped `npm audit` gate (replaces the bare `npm audit --audit-level`
// calls in package.json#prepublishOnly + ci.yml + release.yml).
//
// WHY: a bare `npm audit --audit-level=moderate` cannot allow a single, documented,
// can't-fix-yet advisory without lowering the bar for EVERYTHING. This wrapper keeps the
// exact same thresholds (prod ≥ moderate, dev ≥ high) but fails on every advisory EXCEPT
// the ones in ALLOWLIST below — each of which carries a written rationale + a tracking
// note. A NEW advisory (not in the allowlist) still fails CI, unchanged.
//
// This is the project's documented-rejection pattern (CHANGELOG, since v3.5.14) applied
// to supply-chain: accept with reasoning, in a visible, reviewable place, not by
// weakening the gate.

import { execSync } from "node:child_process";

/**
 * Advisories accepted with reasoning. Keyed by GHSA id. Removing an entry re-arms the
 * gate for that advisory; adding one REQUIRES a rationale + a path to resolution.
 */
export const ALLOWLIST = {
  // v3.10.0-rc.53 — GHSA-h67p-54hq-rp68 (js-yaml merge-key DoS, accepted rc.50) is now
  // RESOLVED, not allowlisted: gray-matter was dropped (it pinned the vulnerable js-yaml@3)
  // and frontmatter parsing migrated to js-yaml@4.2.0 (see src/frontmatter.ts). The tree
  // no longer contains a vulnerable js-yaml, so the entry was removed and the gate re-armed.
  // Empty = the strictest posture; add a GHSA here ONLY with a rationale + resolution path.
};

const SEV_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

/**
 * Pure core — given an `npm audit --json` payload, return the distinct advisories at or
 * above `minSeverity` that are NOT allowlisted. Exported so the test can prove the gate
 * isn't vacuous (a real advisory id fails; the allowlisted id passes).
 * @param {object} auditJson - parsed `npm audit --json`
 * @param {{minSeverity: keyof typeof SEV_RANK, allowlist: Record<string,string>}} opts
 * @returns {Array<{id:string, severity:string, title:string, module:string}>}
 */
export function offendingAdvisories(auditJson, { minSeverity, allowlist }) {
  const floor = SEV_RANK[minSeverity] ?? 2;
  const found = new Map();
  for (const [pkg, v] of Object.entries(auditJson?.vulnerabilities ?? {})) {
    for (const via of v?.via ?? []) {
      if (via && typeof via === "object" && typeof via.url === "string") {
        const m = /GHSA-[\w-]+/.exec(via.url);
        if (!m) continue;
        const sev = via.severity ?? v.severity ?? "low";
        if ((SEV_RANK[sev] ?? 0) < floor) continue;
        found.set(m[0], { id: m[0], severity: sev, title: via.title ?? "", module: via.name ?? pkg });
      }
    }
  }
  return [...found.values()].filter((a) => !allowlist[a.id]);
}

function runAudit(scopeFlag) {
  try {
    return JSON.parse(
      execSync(`npm audit ${scopeFlag} --json`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    );
  } catch (err) {
    // npm audit exits non-zero when vulns exist; the JSON is still on stdout.
    const out = err?.stdout?.toString() ?? "";
    if (!out.trim()) throw new Error(`npm audit produced no JSON: ${err?.message ?? err}`);
    return JSON.parse(out);
  }
}

function isEntrypoint() {
  return import.meta.url === `file://${process.argv[1]}`;
}

if (isEntrypoint()) {
  // Same thresholds as the bare gate this replaces: prod ≥ moderate, dev ≥ high.
  const prod = offendingAdvisories(runAudit("--omit=dev"), { minSeverity: "moderate", allowlist: ALLOWLIST });
  const dev = offendingAdvisories(runAudit("--include=dev"), { minSeverity: "high", allowlist: ALLOWLIST });
  const offenders = [...new Map([...prod, ...dev].map((a) => [a.id, a])).values()];
  const allowed = Object.keys(ALLOWLIST);
  if (offenders.length > 0) {
    console.error("[check-audit] FAIL — advisories not in the documented allowlist:");
    for (const a of offenders) console.error(`  ${a.id} (${a.severity}) ${a.module} — ${a.title}`);
    console.error("\nFix the dependency, or add the GHSA to scripts/check-audit.mjs ALLOWLIST with a rationale.");
    process.exit(1);
  }
  console.log(
    `[check-audit] OK — no un-allowlisted advisories (prod ≥ moderate, dev ≥ high).` +
      (allowed.length ? ` Allowlisted (documented): ${allowed.join(", ")}.` : "")
  );
}
