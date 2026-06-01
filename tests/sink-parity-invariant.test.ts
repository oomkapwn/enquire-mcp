// v3.9.1 — SINK-PARITY INVARIANT (H-3 class structural defense).
//
// Closes the "paired sinks drift in error semantics" class. rc.33 H-3: an
// inverted `pageRange` (`{from:50,to:10}`) made `extractPdfText` clamp to an
// EMPTY window and silently return `pages:[]` — while the OCR sibling
// `resolveOcrPageRange` correctly THREW. Two code paths that handle the same
// concept (a page range) disagreed on whether bad input is an error or a
// silent no-op; the PDF path was a silent caller-error sink until rc.33 made it
// fail-closed to match OCR.
//
// WHY THE INTERNAL APPARATUS MISSED IT (meta-audit, this session): no gate
// modelled "paired code paths must agree." K-3 proves the project CAN express a
// pairing invariant (readOnlyHint ↔ write-handler), but it's hardcoded to that
// one pair. This generalizes it: a manifest of paired sinks + an assertion that
// each member fails-closed on the same adversarial input.
//
// Approach (hybrid, dep-free): (1) BEHAVIORAL on the pure member
// (`resolveOcrPageRange`) — it throws on an inverted range, passes on a valid
// one. (2) STRUCTURAL source-parity on BOTH members — each function body must
// contain an inverted-range `throw`. The structural half is deliberately used
// for `extractPdfText` instead of a behavioral test because it loads pdfjs
// (optional dep) + needs a real multi-page PDF *before* reaching the guard;
// the source check proves the guard is present without that fixture/gating
// burden, and fails if a refactor regresses it to the rc.32 silent-empty shape.
// The two guards differ syntactically (`to < from` vs `to - from + 1 < 1`), so
// the regex is an alternation over the known fail-closed forms.

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveOcrPageRange } from "../src/ocr.js";

const repoRoot = path.resolve(__dirname, "..");

// Manifest: paired sinks that handle the same concept and MUST agree on
// fail-closed error semantics. Extend this when a new paired-sink class appears.
const PAIRED_SINKS = [
  {
    pair: "page-range: inverted/empty range must fail-closed (throw), never silent-empty",
    members: [
      { file: "src/ocr.ts", fn: "resolveOcrPageRange" },
      { file: "src/pdf.ts", fn: "extractPdfText" }
    ],
    // The inverted-range condition, in either site's syntax (pdf: `to < from`;
    // ocr: `to - from + 1 < 1`). A member's body must contain BOTH this AND a throw.
    invertedGuard: /to\s*<\s*from|to\s*-\s*from\s*\+\s*1\s*<\s*1|from\s*>\s*to/
  }
] as const;

/** Body of a top-level `export (async )?function NAME(`: signature → first
 *  column-0 `}`. Pure; unit-checked by the NEGATIVE control below. */
function functionBody(src: string, name: string): string {
  const sig = new RegExp(`export (?:async )?function ${name}\\s*\\(`).exec(src);
  if (!sig) return "";
  const rest = src.slice(sig.index);
  const end = rest.search(/\n\}\n/);
  return end === -1 ? rest : rest.slice(0, end);
}

/** A sink "fails closed on inverted range" if its body has the inverted-range
 *  condition AND a `throw`. Returns null on OK, else an explanation. */
function sinkFailsClosed(body: string, guard: RegExp): string | null {
  if (body === "") return "function not found";
  if (!guard.test(body)) return "no inverted-range condition";
  if (!/\bthrow\b/.test(body)) return "inverted range detected but not thrown (silent sink?)";
  return null;
}

describe("sink-parity invariant (v3.9.1, H-3 class)", () => {
  // ── Behavioral: the pure member is fail-closed ──
  it("resolveOcrPageRange THROWS on an inverted range (fail-closed)", () => {
    expect(() => resolveOcrPageRange([50, 10], 100)).toThrow(/invalid page range/i);
  });

  // NEGATIVE control: a VALID range must NOT throw — proves the throw is
  // inverted-range-specific, not a blanket reject (else the parity is vacuous).
  it("NEGATIVE control — resolveOcrPageRange does NOT throw on a valid range", () => {
    expect(resolveOcrPageRange([1, 3], 100)).toEqual([1, 3]);
    expect(resolveOcrPageRange(undefined, 100)).toEqual([1, 100]);
  });

  // ── Structural: every member of each pair fails closed on the same input ──
  describe("paired sinks agree on fail-closed page-range semantics", () => {
    for (const sink of PAIRED_SINKS) {
      for (const m of sink.members) {
        it(`${m.fn} (${m.file}) fails closed on an inverted range — [${sink.pair}]`, () => {
          const body = functionBody(readFileSync(path.join(repoRoot, m.file), "utf8"), m.fn);
          expect(sinkFailsClosed(body, sink.invertedGuard), `${m.file}#${m.fn}`).toBeNull();
        });
      }
    }

    // NEGATIVE control: the checker MUST flag a silent sink (clamps an inverted
    // range to empty and returns it, no throw — the exact rc.32 PDF regression).
    it("NEGATIVE control — sinkFailsClosed flags a silent (no-throw) sink", () => {
      const silent = "export function f(){ const lo = Math.max(1, from); if (to < from) { return []; } return out; }";
      const body = functionBody(silent, "f");
      // matches the inverted condition but never throws → reported, not null
      expect(sinkFailsClosed(body, /to\s*<\s*from/)).toMatch(/not thrown/);
    });

    // NEGATIVE control: a body with NO inverted-range condition at all is flagged.
    it("NEGATIVE control — sinkFailsClosed flags a body missing the inverted-range condition", () => {
      const noGuard = "export function g(){ const x = clamp(a, b); throw new Error('x'); }";
      expect(sinkFailsClosed(functionBody(noGuard, "g"), /to\s*<\s*from/)).toMatch(/no inverted-range/);
    });
  });
});
