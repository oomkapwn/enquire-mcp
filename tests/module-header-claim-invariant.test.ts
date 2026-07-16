// v3.11.6-rc.3 (audit G-2, G-3) — module-header claim-vs-reality guard.
//
// The Codex external audit found two module-header block comments that had
// drifted from the enforced implementation (the project's "claimed-guarantee
// vs code-guard" class):
//   • G-2 src/ocr.ts header claimed a first-call trained-data DOWNLOAD / a
//     "one-time outbound" HTTP call — but serve/OCR is offline-enforced
//     (`assertOcrLangsInstalled` fail-closed + `cacheMethod: "readOnly"`),
//     regression-proofed by OIA Check 4e.
//   • G-3 src/http-transport.ts header said stateful sessions were "deferred
//     to v2.7+" — but they shipped in v2.14.0.
//
// These are inventory guards: they fail CI if a header re-introduces the stale
// claim. NEGATIVE controls prove the detectors are non-vacuous (they DO fire
// on the exact stale strings the audit found).

import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const src = path.resolve(__dirname, "..", "src");

/** The header block comment = the leading run of `//` lines at the top of the file. */
async function moduleHeader(rel: string): Promise<string> {
  const text = await readFile(path.join(src, rel), "utf8");
  const lines = text.split(/\r?\n/);
  const header: string[] = [];
  for (const line of lines) {
    if (line.startsWith("//") || line.trim() === "") header.push(line);
    else break;
  }
  return header.join("\n");
}

describe("module-header claim-vs-reality (audit G-2/G-3)", () => {
  it("ocr.ts header does not claim a runtime trained-data download (offline is enforced)", async () => {
    const header = await moduleHeader("ocr.ts");
    expect(header).not.toMatch(/downloads the trained data/i);
    expect(header).not.toMatch(/outbound HTTP except the one-time/i);
    // POSITIVE: it states the enforced offline reality.
    expect(header).toMatch(/pre-installed|install-ocr-lang|fails? closed|ZERO outbound/i);
  });

  it("NEGATIVE control — the ocr detector fires on the pre-fix stale header string", () => {
    const stale = "// language downloads the trained data file (~10MB) into the cache dir.";
    expect(stale).toMatch(/downloads the trained data/i);
  });

  it("http-transport.ts header does not call a shipped feature 'deferred'", async () => {
    const header = await moduleHeader("http-transport.ts");
    expect(header).not.toMatch(/stateful sessions.*deferred/is);
    // POSITIVE: it describes the shipped opt-in.
    expect(header).toMatch(/stateful.*(opt-in|v2\.14|shipped)/is);
  });

  it("NEGATIVE control — the http detector fires on the pre-fix stale header string", () => {
    const stale = "// Stateful sessions (sessionId-keyed transports) are deferred to v2.7+";
    expect(stale).toMatch(/stateful sessions.*deferred/is);
  });
});
