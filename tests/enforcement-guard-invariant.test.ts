// v3.10.0-rc.3 — ENFORCEMENT-GUARANTEE → CODE-GUARD INVARIANT.
//
// Generalizes OIA Check 4d (SLSA-level) + 4e (OCR-offline) into a curated
// inventory: every load-bearing SECURITY.md guarantee must (a) still be PRESENT
// in SECURITY.md AND (b) point to a named code-guard symbol that EXISTS in src.
// Closes the overclaim #15/#16 class — a doc that claims an ENFORCED guarantee
// ("blocked", "rejected", "fails closed", "0600", a named cap) that no code
// path actually backs. It's the most externally-verifiable overclaim class
// (an auditor reads the claim → checks the code), so it gets a permanent gate.
//
// DELIBERATELY CURATED, not a full-prose scan of SECURITY.md. A blanket grep
// for enforcement verbs over free prose is high-false-positive (most such
// sentences are descriptive context, not enforced guarantees) — the exact
// noise the rc.36 meta-audit warned against. So this pins the ~dozen
// load-bearing guarantees to their guards; a genuinely NEW guarantee is added
// by a human who must add a manifest entry (the same inventory discipline as
// erasure-invariant / resource-bound-invariant). Completeness over ALL prose
// is an accepted non-goal; the value is that the KEY guarantees can't silently
// lose their guard (a rename/refactor that drops the guard fails CI).

import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");

/** Concatenated text of every `src/**.ts` — the guard-symbol search space. */
function srcBlob(): string {
  const parts: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts")) parts.push(readFileSync(p, "utf8"));
    }
  };
  walk(path.join(repoRoot, "src"));
  return parts.join("\n");
}

// Each entry: a SECURITY.md `marker` (distinctive substring of the guarantee)
// + a `symbol` that MUST exist in src/ as the code guard enforcing it.
const GUARANTEES: Array<{ label: string; marker: string; symbol: string }> = [
  { label: "path/symlink escape rejected", marker: "resolve outside are rejected", symbol: "resolveSafePath" },
  { label: "OCR offline — CDN path blocked", marker: "blocks that path entirely", symbol: "assertOcrLangsInstalled" },
  { label: "OCR worker read-only cache", marker: "cacheMethod", symbol: "cacheMethod" },
  { label: "OCR canvas-dimension clamp (OOM)", marker: "MAX_OCR_CANVAS_DIM", symbol: "MAX_OCR_CANVAS_DIM" },
  { label: "OCR per-call page cap", marker: "DEFAULT_OCR_MAX_PAGES", symbol: "DEFAULT_OCR_MAX_PAGES" },
  { label: "restrictive file mode 0600", marker: "0600", symbol: "0o600" },
  { label: "restrictive dir mode 0700", marker: "0700", symbol: "0o700" },
  // v3.10.0-rc.54 — rc.53 dropped gray-matter + js-yaml@3's `SAFE_SCHEMA`; YAML now parses via
  // js-yaml@5's default `load` (YAML 1.2 core schema, safe-by-default — no `!!js/function` code-exec
  // tag). The guard symbol is the `js-yaml` import (the safe default API, not a custom schema re-enabling unsafe tags).
  {
    label: "YAML parsed via js-yaml@5 safe `load` (no !!js/function code-exec)",
    marker: "!!js/function",
    symbol: "js-yaml"
  },
  { label: "HTTP session idle eviction (memory bound)", marker: "Idle eviction", symbol: "sweepIdle" },
  { label: "CORS omits credentials on wildcard", marker: "Allow-Credentials", symbol: "Allow-Credentials" }
];

/** null = OK; else an explanation of the broken claim↔guard link. */
function checkGuarantee(
  g: { label: string; marker: string; symbol: string },
  security: string,
  src: string
): string | null {
  if (!security.includes(g.marker)) {
    return `SECURITY.md no longer contains "${g.marker}" — the "${g.label}" guarantee was reworded/removed; update this manifest.`;
  }
  if (!src.includes(g.symbol)) {
    return `code guard "${g.symbol}" for "${g.label}" is MISSING from src — SECURITY.md claims an enforcement nothing backs (overclaim #15/#16 class).`;
  }
  return null;
}

describe("enforcement-guarantee → code-guard invariant (rc.3, overclaim #15/#16 class)", () => {
  it("every curated SECURITY.md guarantee still maps to a present code guard", () => {
    const security = readFileSync(path.join(repoRoot, "SECURITY.md"), "utf8");
    const src = srcBlob();
    const offenders = GUARANTEES.map((g) => checkGuarantee(g, security, src)).filter(Boolean) as string[];
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  // NEGATIVE control: a guarantee whose guard symbol is absent from src MUST be
  // flagged — otherwise the invariant is vacuous and an unenforced claim slips.
  it("NEGATIVE control — flags a guarantee whose code guard is missing from src", () => {
    const err = checkGuarantee(
      { label: "fake", marker: "resolve outside are rejected", symbol: "__no_such_guard_symbol__" },
      readFileSync(path.join(repoRoot, "SECURITY.md"), "utf8"),
      srcBlob()
    );
    expect(err).toMatch(/MISSING from src/);
  });

  // NEGATIVE control: a guarantee whose SECURITY.md marker is gone MUST be
  // flagged (so a doc rewrite that drops the claim doesn't leave a dangling guard).
  it("NEGATIVE control — flags a guarantee whose SECURITY.md marker is gone", () => {
    const err = checkGuarantee(
      { label: "fake", marker: "__not in security md__", symbol: "resolveSafePath" },
      "irrelevant security text",
      "const resolveSafePath = 1;"
    );
    expect(err).toMatch(/no longer contains/);
  });
});
