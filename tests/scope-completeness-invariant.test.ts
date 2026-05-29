// v3.8.8 — META structural-defense scope completeness invariant.
//
// Asserts:
//   (a) `scripts/scope-completeness-audit.mjs` finds zero gaps when run
//       against the current repo state. Any new numeric-claim pattern
//       added to a doc file MUST be either in the matching defense's
//       scope (already gated by docs-consistency.test.ts) or in its
//       exempts list (historical-narrative / per-RC context).
//   (b) The audit's DEFENSES manifest itself stays in sync: every entry
//       must have an `id`, `pattern`, `scope`, `exempts`, and
//       `rationale` field. Missing fields would silently disable a
//       defense.
//
// The recurring "recursion-pair shape" pattern across v3.6.x→v3.8.x
// had 6 documented instances of "narrow defense → next bug finds the
// narrowness". This invariant breaks the recursion: a new doc file
// containing a numeric claim that's NOT in scope will fail this test
// before it ships. The audit script then prints the exact `fix:`
// instructions so the author can either (a) extend docs-consistency to
// cover the new file or (b) add an exempt with reasoning.
//
// NEGATIVE control: see below. We construct a synthetic finding and
// verify the audit's classifier flags it — proves the audit isn't a
// no-op that always returns 0 findings.
//
// META-INVARIANT-EXEMPT: this test file IS the META-invariant for the
// scope-completeness audit. Its NEGATIVE control is in the same file
// (the synthetic-gap test below). The META-invariant-coverage check
// looks for the comment marker; we explicitly tag here so the META
// scanner doesn't double-count.

import { describe, expect, it } from "vitest";
import {
  classifyDefenseFile,
  DEFENSES,
  runAudit,
  runCliFlagCoverageAudit,
  runDeferredClaimAudit,
  runNumericAudit
} from "../scripts/scope-completeness-audit.mjs";

describe("scope-completeness audit — META structural-defense (v3.8.8)", () => {
  // (a) Live invariant: current repo state must have zero gaps.
  it("runs against current repo state with ZERO gaps", () => {
    const findings = runAudit();
    if (findings.length > 0) {
      // Include the first finding's evidence in the error so a CI
      // failure message is actionable without re-running the audit.
      const first = findings[0];
      throw new Error(
        `scope-completeness audit found ${findings.length} gap(s). First: ` +
          `${first?.defense} :: ${first?.file}:${first?.line} :: ${first?.evidence}. ` +
          `Run \`node scripts/scope-completeness-audit.mjs\` for the full report + fix instructions.`
      );
    }
    expect(findings.length).toBe(0);
  });

  // (b) Manifest integrity: every defense entry must have all fields.
  // Missing fields would silently disable a defense (e.g. empty
  // pattern matches nothing, missing scope matches no files).
  it("every DEFENSES entry has id + pattern + scope + exempts + rationale", () => {
    expect(DEFENSES.length).toBeGreaterThan(0);
    for (const d of DEFENSES) {
      expect(typeof d.id, `defense missing id: ${JSON.stringify(d)}`).toBe("string");
      expect(d.id.length, `defense id is empty`).toBeGreaterThan(0);
      expect(d.pattern instanceof RegExp, `defense ${d.id} pattern is not a RegExp`).toBe(true);
      expect(Array.isArray(d.scope), `defense ${d.id} scope is not an array`).toBe(true);
      expect(d.scope.length, `defense ${d.id} has empty scope`).toBeGreaterThan(0);
      expect(Array.isArray(d.exempts), `defense ${d.id} exempts is not an array`).toBe(true);
      expect(typeof d.rationale, `defense ${d.id} rationale is not a string`).toBe("string");
      expect(d.rationale.length, `defense ${d.id} rationale is empty`).toBeGreaterThan(50);
    }
  });

  // (c) Manifest integrity: defense ids are unique.
  it("DEFENSES entries have unique ids", () => {
    const ids = DEFENSES.map((d) => d.id);
    const unique = new Set(ids);
    expect(unique.size, `duplicate defense ids in DEFENSES: ${ids.join(", ")}`).toBe(ids.length);
  });

  // (d) NEGATIVE control: prove the audit actually works by driving the REAL
  // classifier (`classifyDefenseFile`, the function `runNumericAudit` itself
  // calls — v3.9.0-rc.26 rc.25-audit MED-3) with a synthetic defense whose
  // pattern matches a file NOT in its scope/exempts. Previously this control
  // re-implemented the classify logic inline, so it proved a COPY worked — a
  // real divergence in the script's classifier would have slipped through.
  it("(NEGATIVE control) — the REAL classifier flags a synthetic in-scope gap", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const readmeContent = fs.readFileSync(path.resolve(__dirname, "..", "README.md"), "utf8");
    // A defense scoped to AGENTS.md only — README.md contains `npm install` too
    // but is NOT in scope and NOT exempt, so the REAL classifier must flag it.
    const fakeDefense = {
      id: "negative-control-fake",
      pattern: /\bnpm\s+install\b/,
      scope: ["AGENTS.md"],
      exempts: [],
      rationale: "synthetic negative control"
    };
    const findings = classifyDefenseFile(fakeDefense, "README.md", readmeContent);
    expect(findings.length, "real classifier should flag the synthetic README gap").toBeGreaterThan(0);
    expect(findings[0]?.defense).toBe("negative-control-fake");
    // POSITIVE side: when README IS in scope, the same classifier reports NO gap
    // (proves it isn't trivially always-flagging).
    const scopedDefense = { ...fakeDefense, scope: ["README.md"] };
    expect(classifyDefenseFile(scopedDefense, "README.md", readmeContent), "in-scope file must NOT be flagged").toEqual(
      []
    );
  });

  // (e) NEGATIVE control: prove the exempt mechanism actually exempts.
  // If the exempt check was a no-op, every match would still be a gap.
  it("(NEGATIVE control) — exempt mechanism actually suppresses gaps", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const readmeContent = fs.readFileSync(path.resolve(__dirname, "..", "README.md"), "utf8");
    // v3.9.0-rc.26 (MED-3): drive the REAL classifier, not a re-implemented copy.
    // Same pattern that DID flag README in control (d) above, but now README is in
    // exempts → the real classifier must suppress the gap (returns []).
    const exemptDefense = {
      id: "negative-control-exempt",
      pattern: /\bnpm\s+install\b/,
      scope: ["AGENTS.md"],
      exempts: ["README.md"], // README explicitly exempted now
      rationale: "synthetic exempt negative control"
    };
    expect(
      classifyDefenseFile(exemptDefense, "README.md", readmeContent),
      "explicit exempt should suppress the gap"
    ).toEqual([]);
  });
});

// v3.9.0-rc.4 — extended defenses for non-numeric dimensions.
// Closes recursion-pair shape #7: v3.8.8 META audit only covered
// numeric drift; non-numeric drift (stale-deferral and missing-flag-doc)
// required separate defenses.
describe("scope-completeness audit — extended defenses (v3.9.0-rc.4)", () => {
  // POSITIVE invariant: current repo state has ZERO deferred-claim findings.
  // CLAUDE.md was updated in rc.4 to remove the stale "deferred to v3.9.0+"
  // line that listed shipped items (overclaim instance #13).
  it("runDeferredClaimAudit returns zero findings on current state", () => {
    const findings = runDeferredClaimAudit();
    if (findings.length > 0) {
      const first = findings[0];
      throw new Error(
        `deferred-claim audit found ${findings.length} gap(s). First: ${first?.file}:${first?.line} :: ${first?.evidence}`
      );
    }
    expect(findings.length).toBe(0);
  });

  // POSITIVE invariant: current repo state has ZERO cli-flag-coverage findings.
  // rc.4 added the missing --ocr-pdfs / --ocr-langs / --ocr-max-pages rows
  // to docs/api.md.
  it("runCliFlagCoverageAudit returns zero findings on current state", () => {
    const findings = runCliFlagCoverageAudit();
    if (findings.length > 0) {
      const first = findings[0];
      throw new Error(`cli-flag-coverage audit found ${findings.length} gap(s). First: ${first?.evidence}`);
    }
    expect(findings.length).toBe(0);
  });

  // runAudit composes all three sub-audits.
  it("runAudit returns union of runNumericAudit + runDeferredClaimAudit + runCliFlagCoverageAudit", () => {
    const numeric = runNumericAudit();
    const deferred = runDeferredClaimAudit();
    const cliFlag = runCliFlagCoverageAudit();
    const combined = runAudit();
    expect(combined.length).toBe(numeric.length + deferred.length + cliFlag.length);
  });

  // NEGATIVE control: the deferred-claim regex matches the historical
  // CLAUDE.md drift shape. We can't easily monkey-patch the audit's
  // file-read, so we exercise just the regex on a synthetic string to
  // prove the pattern is correct. (The full audit's logic is exercised
  // by the live POSITIVE invariant above.)
  it("(NEGATIVE control) — deferred-to regex matches the drift pattern", () => {
    const samples = [
      "**Still deferred to v3.9.0+:** HNSW filter-during-search, embed-db migrations.",
      "Still deferred to v4.0.0+: feature-x.",
      "deferred to v3.9.0+: foo"
    ];
    const deferralRe = /(?:Still\s+)?deferred\s+to\s+v\d+\.\d+\.\d+\+?:\s*([^.\n]+)/i;
    for (const s of samples) {
      expect(deferralRe.test(s), `regex should match: ${s}`).toBe(true);
    }
    // The current CLAUDE.md should NOT contain a stale deferred line
    // mentioning a shipped item — that's the POSITIVE invariant above.
    // The NEGATIVE control here proves the regex would match if the
    // drift returned.
  });

  // NEGATIVE control: synthetic missing-flag reliably detected.
  it("(NEGATIVE control) — missing-flag-in-docs is structurally detectable", () => {
    const fakeCliSrc = `.option("--existing-flag", "help");\n.option("--missing-flag", "also help");`;
    const fakeApiDoc = `| --existing-flag | off | does a thing |`;
    // Apply the same heuristic the audit uses.
    const flags = new Set<string>();
    const re = /\.option\(\s*"(--[a-z][a-z0-9-]*)/g;
    for (const m of fakeCliSrc.matchAll(re)) {
      const flag = m[1];
      if (flag) flags.add(flag);
    }
    const missing: string[] = [];
    for (const f of flags) {
      if (!fakeApiDoc.includes(f)) missing.push(f);
    }
    expect(missing).toEqual(["--missing-flag"]);
  });
});
