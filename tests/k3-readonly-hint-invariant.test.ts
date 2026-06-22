// v3.8.0-rc.5 K-3 class invariant — readOnlyHint structural guard.
//
// Background. MCP tool annotations carry `readOnlyHint` and
// `destructiveHint` to advertise to the client (and to the agent
// orchestrator) what each tool can do. Clients that gate destructive
// operations behind user confirmation rely on these annotations being
// truthful. If a tool annotated `readOnlyHint: true` is silently wired
// to a write handler (e.g. `createNote`, `appendToNote`), the client
// won't ask for confirmation and the agent can mutate the vault
// without the user knowing.
//
// In src/tool-registry.ts we declare two shorthand annotation objects:
//   READ_ONLY = { readOnlyHint: true,  idempotentHint: true,  ... }
//   WRITE     = { readOnlyHint: false, destructiveHint: true, ... }
//
// And the convention is that handler functions for WRITE tools live in
// `src/tools/write.ts` and are named explicitly (createNote, appendToNote,
// renameNote, replaceInNotes, archiveNote, chatThreadAppend,
// frontmatterSet). This invariant pins that mapping at the source level
// so the annotation can't drift away from the wired handler.
//
// This is a regex-based invariant (parses tool-registry.ts text directly,
// no AST). It catches the 80% case of "annotation says read-only but
// handler is in the write set" — the class of bug a `readOnlyHint`-driven
// client confirmation gate would silently swallow.
//
// Per CLAUDE.md anti-pattern "Invariant test without negative-control —
// Rule since v3.6.4": the scanner is exposed as a pure function so a
// fixture-based sibling test can prove it FAILS when the invariant is
// violated.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Canonical list of WRITE-handler function names. Any tool annotated
 * WRITE must wire to one of these; any tool annotated READ_ONLY must
 * NOT wire to any of these.
 */
const KNOWN_WRITE_HANDLERS = new Set([
  "createNote",
  "appendToNote",
  "renameNote",
  "replaceInNotes",
  "archiveNote",
  "chatThreadAppend",
  "frontmatterSet",
  // v3.11.0 — `obsidian_mark_useful`'s handler. A STATE mutator (writes the
  // per-vault feedback-store cache sidecar), NOT a vault writer — so it's gated
  // by `--feedback-weight` rather than `--enable-write` and lives in
  // tool-registry.ts (not write.ts/read.ts, so it's NOT in the rc.42 F2
  // fsMutatingExports derive-set — that's a SUPERSET check, extras are allowed).
  // Listed here so the WRITE-annotated tool satisfies "wires to a known handler".
  "markUseful"
]);

/**
 * v3.10.0-rc.40 (#11) — exported async fns in `src` whose body calls a vault MUTATION
 * method (`vault.write*`/`append*`/`rename*`/`delete*`/`move*`/`remove*`) or a raw fs
 * write (`writeFile`/`appendFile`/`rename`/`unlink`/`mkdir`/`rm`/`copyFile`). Coarse body
 * slice (signature → next top-level `export`) — sufficient for the flat exported-handler
 * shape of write.ts + read.ts. Used to assert KNOWN_WRITE_HANDLERS can't silently fall
 * behind a NEW fs-mutating handler (which, wired under READ_ONLY, would falsely advertise
 * readOnlyHint). rc.42 F2: callers MUST scan EVERY module hosting a write handler
 * (WRITE_HANDLER_SOURCES = write.ts + read.ts — `chatThreadAppend` lives in read.ts), not
 * just write.ts. Heuristic by design (mutation detection is undecidable) — catches the
 * common DIRECT-mutation forms; the NEGATIVE control below proves it's non-vacuous. Known
 * blind spot: a DELEGATING handler (e.g. `archiveNote` → `renameNote`, with no direct
 * mutation call of its own) isn't derived here — it's covered by its KNOWN_WRITE_HANDLERS
 * membership + the layer-1 wiring scan instead.
 */
function fsMutatingExports(src: string): string[] {
  const MUT =
    /\bvault\.(?:write|append|rename|delete|move|remove)\w*\s*\(|\b(?:fs\.)?(?:writeFile|appendFile|rename|unlink|mkdir|rm|rmdir|copyFile)\s*\(/;
  const fnRe = /export async function (\w+)\s*\(/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
  while ((m = fnRe.exec(src)) !== null) {
    const start = m.index;
    const next = src.indexOf("\nexport ", start + 1);
    const body = src.slice(start, next === -1 ? undefined : next);
    if (MUT.test(body)) out.push(m[1] as string);
  }
  return out;
}

interface ToolRegistration {
  toolName: string;
  annotationKind: "READ_ONLY" | "WRITE" | "UNKNOWN";
  /** Names of write-handler functions referenced in this tool's handler block. */
  writeHandlersReferenced: string[];
  /** Line number where `server.registerTool(` started — for diagnostics. */
  startLine: number;
}

/**
 * Scan a tool-registry-shaped text for all `server.registerTool(...)`
 * blocks and extract their (name, annotation, write-handler refs).
 *
 * Called by both the production tests (on `src/tool-registry.ts`) and
 * the negative-control sibling tests (on fixture files). Per CLAUDE.md
 * anti-pattern "Invariant test without negative-control": the function
 * stays in this file so fixtures can exercise it directly without
 * exposing scanner internals as a public API.
 */
function scanRegistry(source: string): ToolRegistration[] {
  const lines = source.split("\n");
  const out: ToolRegistration[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!/server\.registerTool\(\s*$/.test(line) && !/server\.registerTool\(\s*"[^"]+"/.test(line)) continue;
    // The tool name is either on the same line (rare) or the next non-blank line.
    let toolName = "";
    const inlineMatch = line.match(/server\.registerTool\(\s*"([^"]+)"/);
    if (inlineMatch?.[1]) {
      toolName = inlineMatch[1];
    } else {
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const m = (lines[j] ?? "").match(/^\s*"([^"]+)"\s*,/);
        if (m?.[1]) {
          toolName = m[1];
          break;
        }
      }
    }
    if (!toolName) continue;

    // Bound the block by the NEXT `server.registerTool(` call (or end
    // of file). Pre-rc.5 used a fixed 60-line window, which caused a
    // false positive: the last READ_ONLY tool's window extended into
    // the next `registerWriteTools()` function body and grabbed the
    // first WRITE tool's `createNote(` call. Hard upper bound of 120
    // lines for safety (longest legit block is ~50).
    let blockEnd = Math.min(i + 120, lines.length);
    for (let j = i + 1; j < blockEnd; j++) {
      const next = lines[j] ?? "";
      if (/server\.registerTool\(/.test(next)) {
        blockEnd = j;
        break;
      }
    }
    const block = lines.slice(i, blockEnd).join("\n");

    let annotationKind: ToolRegistration["annotationKind"] = "UNKNOWN";
    if (/annotations:\s*\{\s*\.\.\.READ_ONLY/.test(block)) annotationKind = "READ_ONLY";
    else if (/annotations:\s*\{\s*\.\.\.WRITE/.test(block)) annotationKind = "WRITE";

    // Collect every write-handler name that appears as `FN(` in the block.
    const writeHandlersReferenced: string[] = [];
    for (const fnName of KNOWN_WRITE_HANDLERS) {
      // Match the function as a CALL: `FN(` — not just as text in a comment
      // string. Word-boundary on the left avoids `someCreateNote` matching
      // `createNote`. The `(` on the right ensures it's invoked.
      const callRegex = new RegExp(`\\b${fnName}\\s*\\(`);
      if (callRegex.test(block)) {
        writeHandlersReferenced.push(fnName);
      }
    }
    out.push({ toolName, annotationKind, writeHandlersReferenced, startLine: i + 1 });
  }
  return out;
}

describe("K-3 invariant — readOnlyHint vs write-handler wiring", () => {
  it("every READ_ONLY-annotated tool wires to a non-write handler", async () => {
    const src = await fs.readFile(path.join("src", "tool-registry.ts"), "utf-8");
    const regs = scanRegistry(src);
    expect(regs.length).toBeGreaterThan(30); // sanity: tool-registry has 44 tools
    const violations = regs.filter((r) => r.annotationKind === "READ_ONLY" && r.writeHandlersReferenced.length > 0);
    if (violations.length > 0) {
      const detail = violations
        .map(
          (v) =>
            `  ✗ tool="${v.toolName}" (line ${v.startLine}) annotated READ_ONLY but references write handler(s): ${v.writeHandlersReferenced.join(", ")}`
        )
        .join("\n");
      throw new Error(
        `K-3 invariant violated — READ_ONLY tool wired to write handler:\n${detail}\n\n` +
          `Either change the annotation to WRITE (and ensure --enable-write gates registration) ` +
          `or move the logic to a non-write helper.`
      );
    }
  });

  it("every WRITE-annotated tool wires to exactly one known write handler", async () => {
    const src = await fs.readFile(path.join("src", "tool-registry.ts"), "utf-8");
    const regs = scanRegistry(src);
    const writeTools = regs.filter((r) => r.annotationKind === "WRITE");
    expect(writeTools.length).toBeGreaterThanOrEqual(5); // current count is 7
    const violations: string[] = [];
    for (const t of writeTools) {
      if (t.writeHandlersReferenced.length === 0) {
        violations.push(
          `  ✗ tool="${t.toolName}" (line ${t.startLine}) annotated WRITE but no known write handler called`
        );
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `K-3 invariant violated — WRITE tool not wired to a known write handler:\n${violations.join("\n")}\n\n` +
          `If this is a new write operation, add the handler name to KNOWN_WRITE_HANDLERS ` +
          `in tests/k3-readonly-hint-invariant.test.ts.`
      );
    }
  });

  it("every tool has an explicit READ_ONLY or WRITE annotation (no UNKNOWN)", async () => {
    const src = await fs.readFile(path.join("src", "tool-registry.ts"), "utf-8");
    const regs = scanRegistry(src);
    const unknowns = regs.filter((r) => r.annotationKind === "UNKNOWN");
    if (unknowns.length > 0) {
      const detail = unknowns.map((u) => `  ✗ tool="${u.toolName}" (line ${u.startLine})`).join("\n");
      throw new Error(
        `K-3 invariant violated — tools missing READ_ONLY/WRITE annotation:\n${detail}\n\n` +
          `Add annotations: { ...READ_ONLY, ... } or { ...WRITE, ... } to the registerTool config.`
      );
    }
  });

  // rc.42 F2 — WIDEN rc.40 #11. A real WRITE handler (`chatThreadAppend`) lives in
  // read.ts, NOT write.ts, so scanning only write.ts was scope-too-narrow: a new
  // fs-mutating handler added to read.ts would escape BOTH this derive-check AND the
  // layer-1 READ_ONLY-violation scan (which only flags names already in the set). Union
  // every module that hosts a write handler, mirroring resource-bound's SCANNER_SOURCES.
  const WRITE_HANDLER_SOURCES = ["src/tools/write.ts", "src/tools/read.ts"];
  it("KNOWN_WRITE_HANDLERS covers every fs-mutating exported fn in write.ts + read.ts (rc.42 F2)", async () => {
    const mutators = new Set<string>();
    for (const rel of WRITE_HANDLER_SOURCES) {
      const src = await fs.readFile(path.join(...rel.split("/")), "utf-8");
      for (const n of fsMutatingExports(src)) mutators.add(n);
    }
    // Sanity: the scan genuinely REACHES read.ts (chatThreadAppend mutates via
    // vault.writeNote there) — proves the union isn't vacuously scanning only write.ts.
    expect(mutators.has("chatThreadAppend"), "fsMutatingExports must detect read.ts's chatThreadAppend").toBe(true);
    const untracked = [...mutators].filter((n) => !KNOWN_WRITE_HANDLERS.has(n));
    expect(
      untracked,
      `fs-mutating exported fn(s) in ${WRITE_HANDLER_SOURCES.join(" / ")} missing from KNOWN_WRITE_HANDLERS: ${untracked.join(", ")} — add them (a READ_ONLY tool wired to one would falsely advertise readOnlyHint).`
    ).toEqual([]);
  });

  it("NEGATIVE control — fsMutatingExports flags an untracked fs-writing export (rc.40 #11)", () => {
    const fakeSrc = [
      "export async function deleteNote(vault, p) {",
      "  await fs.unlink(p);",
      "}",
      "export async function readSomething(v) {",
      "  return v.readNote('x');",
      "}",
      ""
    ].join("\n");
    const mutators = fsMutatingExports(fakeSrc);
    expect(mutators).toContain("deleteNote"); // fs.unlink → flagged as a mutator
    expect(mutators).not.toContain("readSomething"); // read-only → not flagged
    expect(KNOWN_WRITE_HANDLERS.has("deleteNote")).toBe(false); // → would be reported untracked
  });
});

describe("K-3 invariant — negative-control via fixtures (Rule since v3.6.4)", () => {
  it("scanRegistry detects READ_ONLY tool wired to write handler (fixture)", async () => {
    const fixture = await fs.readFile(
      path.join("tests", "fixtures", "k3-invariant", "bad-readonly-with-write.fixture.ts"),
      "utf-8"
    );
    const regs = scanRegistry(fixture);
    const bad = regs.find((r) => r.toolName === "obsidian_read_note_BAD");
    expect(bad).toBeDefined();
    expect(bad?.annotationKind).toBe("READ_ONLY");
    expect(bad?.writeHandlersReferenced).toContain("createNote");
  });

  it("scanRegistry detects WRITE tool with no write handler (fixture)", async () => {
    const fixture = await fs.readFile(
      path.join("tests", "fixtures", "k3-invariant", "bad-write-no-handler.fixture.ts"),
      "utf-8"
    );
    const regs = scanRegistry(fixture);
    const bad = regs.find((r) => r.toolName === "obsidian_write_no_handler_BAD");
    expect(bad).toBeDefined();
    expect(bad?.annotationKind).toBe("WRITE");
    expect(bad?.writeHandlersReferenced.length).toBe(0);
  });

  it("scanRegistry passes valid READ_ONLY + WRITE patterns (positive fixture)", async () => {
    const fixture = await fs.readFile(path.join("tests", "fixtures", "k3-invariant", "good.fixture.ts"), "utf-8");
    const regs = scanRegistry(fixture);
    expect(regs.length).toBeGreaterThanOrEqual(2);
    const ro = regs.find((r) => r.toolName === "obsidian_read_note_GOOD");
    expect(ro?.annotationKind).toBe("READ_ONLY");
    expect(ro?.writeHandlersReferenced.length).toBe(0);
    const wr = regs.find((r) => r.toolName === "obsidian_create_note_GOOD");
    expect(wr?.annotationKind).toBe("WRITE");
    expect(wr?.writeHandlersReferenced).toContain("createNote");
  });
});
