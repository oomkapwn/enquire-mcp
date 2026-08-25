// v3.11.0-rc.9 (external re-audit T-MED-1 re-verify) — HNSW SHARED-STATE MUTATION
// MUST STAY A SYNCHRONOUS CRITICAL SECTION.
//
// The auditor flagged a cross-file watcher interleave as MEDIUM ("two different-file
// events interleave markDelete↔addPoint on the shared hnswlib index, leaving a
// partial apply"). Per-item re-verification (3/3 adversarial skeptics) found it a
// FALSE POSITIVE: `HnswIndex.applyDiff` and the watcher's `syncHnswForFile` are
// FULLY SYNCHRONOUS — there is no `await` between markDelete and addPoint, nor
// around the shared `hnswRowsByLabel` delete/set. On Node's single-threaded,
// run-to-completion event loop that makes the whole block atomic with respect to
// every OTHER task, so two different-file `handle()` chains can only context-switch
// at their `await`ed embed steps (which don't touch shared state). The synchronicity
// IS the cross-file serialization; an explicit mutation queue would be redundant.
//
// So the auditor's *fix* (a queue) is rejected, but the underlying property is
// LOAD-BEARING and was only implicit — a future refactor that makes either method
// async (e.g. to back a remote vector store) WOULD open a real interleave window and
// pass every drift/claim CI gate silently. This invariant converts the implicit
// "no await in the shared-HNSW critical section" assumption into a self-checking
// gate (the rc.36 transform: an undecidable "did we keep it atomic?" → an empirical
// CI assertion). Behavioral concurrency is exactly the class the internal apparatus
// is structurally blind to (CLAUDE.md rc.36 meta-audit).

import { readFileSync } from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { replaceExactly } from "./helpers/exact-source-mutation.js";

const repoRoot = path.resolve(__dirname, "..");

/** Strip `//` line comments so a comment mentioning "await" can't trip the check. */
function stripLineComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

/**
 * Pure: the code slice between two unique in-body anchors (inclusive of `end`).
 * Anchors are real statements inside the critical section, so this sidesteps the
 * brace-balancing hazard of method signatures whose params/return types contain `{`.
 */
function sliceBetween(source: string, start: string, end: string): string {
  const a = source.indexOf(start);
  if (a < 0) throw new Error(`critical-section anchor not found: ${start}`);
  const b = source.indexOf(end, a);
  if (b < 0) throw new Error(`critical-section anchor not found: ${end}`);
  return source.slice(a, b + end.length);
}

/** Pure detector — does a code slice contain an `await` token? */
function containsAwait(slice: string): boolean {
  return /\bawait\b/.test(slice);
}

function classMethodSource(source: string, className: string, methodName: string): string {
  const sourceFile = ts.createSourceFile("critical-section.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const matches: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === className) {
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && member.name.getText(sourceFile) === methodName) {
          matches.push(member.getText(sourceFile));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${className}.${methodName} method, found ${matches.length}`);
  }
  return matches[0] ?? "";
}

function drainsAcceptedFilesBeforeHnswFlush(source: string): boolean {
  const close = classMethodSource(source, "VaultWatcher", "close");
  const drain = "await Promise.allSettled([...this.fileQueues.values()]);";
  const flush = "await this.flushHnswToDisk();";
  const drainAt = close.indexOf(drain);
  const flushAt = close.indexOf(flush);
  return drainAt >= 0 && flushAt > drainAt;
}

function conditionalEmbedMutationOwnsImmediateWriteLock(source: string): boolean {
  const method = classMethodSource(source, "EmbedDb", "mutateIfGeneration");
  const observedAt = method.indexOf("const observedGeneration = captureEmbedDbGenerationIdentity(db);");
  const guardAt = method.indexOf("if (!sameEmbedDbGenerationIdentity(expected, observedGeneration))");
  const mutationAt = method.indexOf("const value = mutate();");
  const committedAt = method.indexOf("committedGeneration: captureEmbedDbGenerationIdentity(db)");
  const immediateAt = method.indexOf("return transaction.immediate();");
  return (
    observedAt >= 0 &&
    guardAt > observedAt &&
    mutationAt > guardAt &&
    committedAt > mutationAt &&
    immediateAt > committedAt
  );
}

function watcherPublishesGenerationAfterGraphDiff(source: string, methodName: string): boolean {
  const method = classMethodSource(source, "VaultWatcher", methodName);
  const publishToken = "this.publishCommittedHnswGeneration(committedGeneration)";
  const conditionalAt = method.indexOf("IfGeneration(");
  const quarantineAt = method.indexOf("this.quarantineHnswGeneration(", conditionalAt);
  const fallbackAt = method.indexOf(
    methodName === "upsertEmbedAndSyncHnsw"
      ? "mutation = embedDb.upsertNoteWithCanonicalVectors("
      : "deletedIds = embedDb.deleteNote(",
    quarantineAt
  );
  const graphDiffAt = method.indexOf("hnswResult = this.syncHnswForFile(", fallbackAt);
  const publishAt = method.indexOf(publishToken, graphDiffAt);
  return (
    method.split(publishToken).length - 1 === 1 &&
    conditionalAt >= 0 &&
    quarantineAt > conditionalAt &&
    fallbackAt > quarantineAt &&
    graphDiffAt > fallbackAt &&
    publishAt > graphDiffAt
  );
}

function serverSharesLiveHnswAuthority(source: string): boolean {
  const sourceFile = ts.createSourceFile("server.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const matches: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(sourceFile) === "watcher.attachHnsw") matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return (
    matches.length === 1 &&
    matches[0]?.arguments.length === 4 &&
    matches[0]?.arguments[3]?.getText(sourceFile) === "hnswContext"
  );
}

function watcherRevalidatesSharedAuthorityAtAttachment(source: string): boolean {
  const method = classMethodSource(source, "VaultWatcher", "attachHnsw");
  const captureAt = method.indexOf("const currentGeneration = this.embedDb.captureGenerationIdentity();");
  const compareAt = method.indexOf("!sameEmbedDbGenerationIdentity(sharedGenerationAuthority, currentGeneration)");
  const rejectAt = method.indexOf("shared HNSW authority does not match the current EmbedDb generation", compareAt);
  const publishAt = method.indexOf("this.hnsw = hnsw;", rejectAt);
  return captureAt >= 0 && compareAt > captureAt && rejectAt > compareAt && publishAt > rejectAt;
}

describe("HNSW shared-state critical section is synchronous (rc.9, T-MED-1)", () => {
  const hnswSrc = stripLineComments(readFileSync(path.join(repoRoot, "src/hnsw.ts"), "utf8"));
  const embedRaw = readFileSync(path.join(repoRoot, "src/embed-db.ts"), "utf8");
  const serverRaw = readFileSync(path.join(repoRoot, "src/server.ts"), "utf8");
  const watcherRaw = readFileSync(path.join(repoRoot, "src/watcher.ts"), "utf8");
  const watcherSrc = stripLineComments(watcherRaw);

  it("HnswIndex.applyDiff has NO await between markDelete and addPoint (POSITIVE — the class gate)", () => {
    // markDelete loop → resize → addPoint loop → return. Any await here would let
    // another file's applyDiff interleave a partial mutation on the shared index.
    const core = sliceBetween(hnswSrc, "for (const label of removeLabels)", "return { removed, added }");
    expect(containsAwait(core), "applyDiff critical section must be synchronous").toBe(false);
    // applyDiff must not be declared async.
    expect(hnswSrc).not.toMatch(/async\s+applyDiff\b/);
  });

  it("watcher.syncHnswForFile has NO await around the applyDiff + shared rowsByLabel mutation (POSITIVE)", () => {
    // applyDiff call → hnswDirty=true → rowsByLabel delete/set loops → return result.
    const core = sliceBetween(watcherSrc, "const result = this.hnsw.applyDiff(", "return result;");
    expect(containsAwait(core), "syncHnswForFile critical section must be synchronous").toBe(false);
    // syncHnswForFile must not be declared async.
    expect(watcherSrc).not.toMatch(/private\s+async\s+syncHnswForFile\b/);

    // S-8d extends the same run-to-completion contract across each prepared
    // FTS5 → EmbedDb → HNSW generation commit. All awaited parsing/embedding
    // must stay in the staging helpers above these methods.
    for (const [name, start] of [
      ["commitMarkdownGeneration", "this.ftsIndex?.reindexFile("],
      ["commitPdfGeneration", "this.ftsIndex?.reindexPdfFile("]
    ] as const) {
      const commit = sliceBetween(watcherSrc, start, "return embedNote;");
      expect(containsAwait(commit), `${name} must remain synchronous`).toBe(false);
      expect(watcherSrc).not.toMatch(new RegExp(`private\\s+async\\s+${name}\\b`));
    }
  });

  it.each(["live watcher close"])("%s drains accepted file queues before HNSW publication", () => {
    expect(drainsAcceptedFilesBeforeHnswFlush(watcherRaw)).toBe(true);
  });

  it.each(["flush-before-drain mutant"])("close-order detector rejects a %s", () => {
    const mutant = [
      "class VaultWatcher {",
      "  async close(): Promise<void> {",
      "    await this.flushHnswToDisk();",
      "    await Promise.allSettled([...this.fileQueues.values()]);",
      "  }",
      "}"
    ].join("\n");
    expect(drainsAcceptedFilesBeforeHnswFlush(mutant)).toBe(false);
  });

  it("binds live DB mutation, graph diff, and shared search authority in that exact order", () => {
    expect(conditionalEmbedMutationOwnsImmediateWriteLock(embedRaw)).toBe(true);
    expect(watcherPublishesGenerationAfterGraphDiff(watcherRaw, "upsertEmbedAndSyncHnsw")).toBe(true);
    expect(watcherPublishesGenerationAfterGraphDiff(watcherRaw, "deleteEmbedAndSyncHnsw")).toBe(true);
    expect(watcherRevalidatesSharedAuthorityAtAttachment(watcherRaw)).toBe(true);
    expect(serverSharesLiveHnswAuthority(serverRaw)).toBe(true);
  });

  it("live-generation detectors reject deferred locking, early blessing, and detached server wiring", () => {
    expect(
      conditionalEmbedMutationOwnsImmediateWriteLock(
        replaceExactly(embedRaw, "return transaction.immediate();", "return transaction();")
      )
    ).toBe(false);

    const earlyBlessing = replaceExactly(
      watcherRaw,
      "hnswResult = this.syncHnswForFile(\n        relPath,",
      "this.publishCommittedHnswGeneration(committedGeneration);\n      hnswResult = this.syncHnswForFile(\n        relPath,"
    );
    expect(earlyBlessing).not.toBe(watcherRaw);
    expect(watcherPublishesGenerationAfterGraphDiff(earlyBlessing, "upsertEmbedAndSyncHnsw")).toBe(false);

    const uncheckedAttachment = replaceExactly(
      watcherRaw,
      "!sameEmbedDbGenerationIdentity(sharedGenerationAuthority, currentGeneration)",
      "false"
    );
    expect(uncheckedAttachment).not.toBe(watcherRaw);
    expect(watcherRevalidatesSharedAuthorityAtAttachment(uncheckedAttachment)).toBe(false);

    const detachedServer = replaceExactly(
      serverRaw,
      "opts.hnswPersist !== false ? persistFile : undefined,\n                    hnswContext",
      "opts.hnswPersist !== false ? persistFile : undefined"
    );
    expect(detachedServer).not.toBe(serverRaw);
    expect(serverSharesLiveHnswAuthority(detachedServer)).toBe(false);
  });

  it("detector fires on an await inside the critical section so the gate is not vacuous (NEGATIVE control)", () => {
    // A synthetic applyDiff body with an await BETWEEN markDelete and addPoint — the
    // exact regression that would open the cross-file interleave window.
    const bad = [
      "for (const label of removeLabels) ctor.markDelete(label);",
      "await somethingAsync();",
      "for (const pt of addPoints) ctor.addPoint(pt);",
      "return { removed, added };"
    ].join("\n");
    const core = sliceBetween(bad, "for (const label of removeLabels)", "return { removed, added }");
    expect(containsAwait(core)).toBe(true);
    // POSITIVE control: the same body without the await is clean.
    const good = replaceExactly(bad, "await somethingAsync();", "ctor.resizeIndex(n);");
    expect(containsAwait(sliceBetween(good, "for (const label of removeLabels)", "return { removed, added }"))).toBe(
      false
    );

    // S-8d negative control: the same detector must fire for either complete
    // generation-commit anchor pair, not only for the historical HNSW slice.
    for (const start of ["this.ftsIndex?.reindexFile(", "this.ftsIndex?.reindexPdfFile("]) {
      const badCommit = [start, "await remoteSink();", "return embedNote;"].join("\n");
      expect(containsAwait(sliceBetween(badCommit, start, "return embedNote;"))).toBe(true);
      const goodCommit = replaceExactly(badCommit, "await remoteSink();", "this.embedDb?.totalChunks();");
      expect(containsAwait(sliceBetween(goodCommit, start, "return embedNote;"))).toBe(false);
    }
  });
});
