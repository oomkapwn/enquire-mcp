// v3.9.0-rc.36 — ERASURE-COMPLETENESS INVARIANT (P0 structural defense).
//
// Closes the P-2 class inside the configured persistence namespaces: an on-disk
// artifact that carries user vault content but is NOT removed by the matching
// `clear-*` path — a right-to-erasure (GDPR) gap.
//   • rc.34 P-2: the HNSW `.meta.json` sidecar (raw `text_preview`) survived
//     `clear-embeddings` because `clearOnDisk` only erased the `.embed.db`.
//   • rc.36 F-2: the parse-cache `${cacheFile}.tmp` (full note bodies, written by
//     `saveDiskCache`'s atomic writeFile→rename) survived `clear-cache` because
//     `clearDiskCache` only unlinked the final file.
//
// WHY THE INTERNAL APPARATUS MISSED THIS (meta-audit, this session): the OIA +
// docs-consistency suite is drift/claim-driven — it checks that CLAIMS match
// reality, never that an artifact a WRITER creates is removed by its ERASER.
// Both P-2 instances were found by an EXTERNAL privacy/STRIDE lens. This file
// converts "did we remember to erase X?" (undecidable, recursion-prone) into a
// permanent CI check: (1) behavioral — `clearDiskCache` actually erases a
// leftover `.tmp`; (2) structural — each configured persistence-family eraser's
// source references every suffix of that family (in-scope writers ⊆ erasers).
// A note-adjacent nonce `writeNote` temp is not in a reserved persistence namespace
// and a token-only watcher guard is intentionally exact-vault recovery, never
// cross-vault prune authority. Mirrors the rc.25 ReDoS-fuzz move (assert the
// property, don't re-enumerate by hand).

import { promises as fs, readFileSync } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hnswPersistBase } from "../src/embed-db.js";
import { planCachePrune, planCachePruneOnDisk } from "../src/fts5.js";
import { clearHnswPersistedArtifacts, isHnswGenerationBasename } from "../src/hnsw.js";
import {
  assertCacheFilePath,
  assertEmbedDbFilePath,
  assertFeedbackFilePath,
  assertFtsIndexFilePath,
  assertHnswFilePath
} from "../src/persistence-path.js";
import {
  preflightSqliteArtifactFamily,
  publishSensitiveArtifact,
  readSensitiveArtifactText,
  removeSensitiveArtifactTemps,
  sensitiveArtifactFinalBasename
} from "../src/sensitive-artifact.js";
import { Vault } from "../src/vault.js";
import { replaceAllExactly, replaceExactly } from "./helpers/exact-source-mutation.js";

const repoRoot = path.resolve(__dirname, "..");

type PersistenceNamespace = "cache" | "embed" | "feedback" | "fts" | "hnsw";
type NamespaceAdmitter = (file: unknown) => void;

const PERSISTENCE_NAMESPACE_ADMITTERS: ReadonlyArray<{
  namespace: PersistenceNamespace;
  admit: NamespaceAdmitter;
  suffix: string;
}> = [
  { namespace: "cache", admit: (file) => assertCacheFilePath(file), suffix: ".json" },
  { namespace: "embed", admit: (file) => assertEmbedDbFilePath(file), suffix: ".embed.db" },
  { namespace: "feedback", admit: (file) => assertFeedbackFilePath(file), suffix: ".feedback.json" },
  { namespace: "fts", admit: (file) => assertFtsIndexFilePath(file), suffix: ".fts5.db" },
  { namespace: "hnsw", admit: (file) => assertHnswFilePath(file), suffix: ".hnsw" }
];

const PERSISTENCE_NAMESPACE_ARTIFACTS: ReadonlyArray<{
  artifact: string;
  file: string;
  admittedBy: PersistenceNamespace | null;
}> = [
  { artifact: "parse-cache main", file: "/cache/vault.json", admittedBy: "cache" },
  { artifact: "parse-cache legacy temp", file: "/cache/vault.json.tmp", admittedBy: null },
  { artifact: "feedback main", file: "/cache/vault.feedback.json", admittedBy: "feedback" },
  { artifact: "feedback legacy temp", file: "/cache/vault.feedback.json.tmp", admittedBy: null },
  { artifact: "FTS main", file: "/cache/vault.fts5.db", admittedBy: "fts" },
  { artifact: "FTS WAL", file: "/cache/vault.fts5.db-wal", admittedBy: null },
  { artifact: "FTS SHM", file: "/cache/vault.fts5.db-shm", admittedBy: null },
  { artifact: "FTS rollback journal", file: "/cache/vault.fts5.db-journal", admittedBy: null },
  { artifact: "embedding main", file: "/cache/vault.embed.db", admittedBy: "embed" },
  { artifact: "embedding WAL", file: "/cache/vault.embed.db-wal", admittedBy: null },
  { artifact: "embedding SHM", file: "/cache/vault.embed.db-shm", admittedBy: null },
  { artifact: "embedding rollback journal", file: "/cache/vault.embed.db-journal", admittedBy: null },
  {
    artifact: "watcher activation guard",
    file: "/cache/vault.embed.db.watcher-activation.guard",
    admittedBy: null
  },
  { artifact: "HNSW base", file: "/cache/vault.hnsw", admittedBy: "hnsw" },
  { artifact: "HNSW meta pointer", file: "/cache/vault.hnsw.meta.json", admittedBy: null },
  { artifact: "HNSW legacy binary", file: "/cache/vault.hnsw.bin", admittedBy: null },
  {
    artifact: "HNSW immutable generation",
    file: `/cache/vault.hnsw.${"a".repeat(48)}.bin`,
    admittedBy: null
  }
];

const PERSISTENCE_NAMESPACE_MATRIX = PERSISTENCE_NAMESPACE_ADMITTERS.flatMap(({ namespace, admit }) =>
  PERSISTENCE_NAMESPACE_ARTIFACTS.map(({ artifact, file, admittedBy }) => ({
    namespace,
    admit,
    artifact,
    file,
    accepted: admittedBy === namespace
  }))
);

const WINDOWS_PERSISTENCE_VALID_PATHS = PERSISTENCE_NAMESPACE_ADMITTERS.flatMap(({ namespace, admit, suffix }) => [
  { namespace, admit, boundary: "ordinary component", file: `C:\\Enquire\\Vault${suffix}` },
  { namespace, admit, boundary: "non-device COM10 component", file: `C:\\Enquire\\COM10${suffix}` },
  { namespace, admit, boundary: "UNC root", file: `\\\\server\\share\\Vault${suffix}` }
]);

const WINDOWS_PERSISTENCE_REJECTIONS = PERSISTENCE_NAMESPACE_ADMITTERS.flatMap(
  ({ namespace, admit, suffix }) =>
    [
      {
        hazard: "alternate data stream",
        file: `C:\\Enquire\\Vault${suffix}:stream${suffix}`,
        error: /alternate data stream/
      },
      {
        hazard: "drive-relative path",
        file: `C:Vault${suffix}`,
        error: /device namespace or drive-relative path/
      },
      {
        hazard: "device namespace",
        file: `\\\\?\\C:\\Enquire\\Vault${suffix}`,
        error: /device namespace or drive-relative path/
      },
      {
        hazard: "mixed-separator GLOBALROOT device namespace",
        file: `/\\?/GLOBALROOT/Device/HarddiskVolume1/Vault${suffix}`,
        error: /device namespace or drive-relative path/
      },
      {
        hazard: "mixed-separator pipe device namespace",
        file: `\\/./pipe/Vault${suffix}`,
        error: /device namespace or drive-relative path/
      },
      {
        hazard: "DOS device basename",
        file: `C:\\Enquire\\CON${suffix}`,
        error: /reserved Windows device basename/
      },
      {
        hazard: "trailing-dot component",
        file: `C:\\Enquire.\\Vault${suffix}`,
        error: /trailing-dot or trailing-space path component/
      },
      {
        hazard: "trailing-space component",
        file: `C:\\Enquire \\Vault${suffix}`,
        error: /trailing-dot or trailing-space path component/
      },
      {
        hazard: "forbidden-character component",
        file: `C:\\Bad?\\Vault${suffix}`,
        error: /portable Windows path/
      },
      {
        hazard: "control-character component",
        file: `C:\\Bad\u001f\\Vault${suffix}`,
        error: /portable Windows path/
      },
      {
        hazard: "current-directory alias",
        file: `C:\\Enquire\\.\\Vault${suffix}`,
        error: /portable Windows path/
      },
      {
        hazard: "parent-directory alias",
        file: `C:\\Enquire\\..\\Vault${suffix}`,
        error: /portable Windows path/
      },
      {
        hazard: "repeated mixed-separator alias",
        file: `C:\\Enquire\\/Vault${suffix}`,
        error: /portable Windows path/
      },
      {
        hazard: "zero-index DOS device basename",
        file: `C:\\Enquire\\COM0${suffix}`,
        error: /reserved Windows device basename/
      }
    ].map((testCase) => ({ namespace, admit, ...testCase }))
);

// ── Manifest: on-disk artifact family → (source file, eraser method, the literal
// suffix tokens the eraser MUST reference to fully erase the family). Adding a
// new on-disk artifact without listing it here (and without its eraser
// referencing every suffix) fails this invariant before an auditor finds it. ──
const ERASURE_MANIFEST = [
  {
    family: "embed-db + HNSW sidecars (vectors + raw text_preview)",
    file: "src/embed-db.ts",
    eraser: "clearOnDisk",
    requiredTokens: ["-wal", "-shm", "-journal", "hnswPersistBase(", "clearHnswPersistedArtifacts("],
    routeMembers: [
      {
        file: "src/hnsw.ts",
        member: "clearHnswPersistedArtifacts",
        requiredTokens: [
          "const plan = await planHnswErasure(file);",
          "removeSensitiveArtifactTempEntry(entry.entryPath)"
        ]
      },
      {
        file: "src/hnsw.ts",
        member: "planHnswErasure",
        requiredTokens: [".bin", ".meta.json", "sensitiveArtifactFinalBasename(entry)", "expectedHnswBasename("]
      },
      {
        file: "src/hnsw.ts",
        member: "expectedHnswBasename",
        requiredTokens: ["isHnswGenerationBasename("]
      }
    ]
  },
  {
    family: "FTS5 index + SQLite WAL/SHM/rollback-journal sidecars",
    file: "src/fts5.ts",
    eraser: "clearOnDisk",
    requiredTokens: ["-wal", "-shm", "-journal"]
  },
  {
    family: "parse cache + atomic-write temp (full note bodies)",
    file: "src/vault.ts",
    eraser: "clearDiskCache",
    requiredTokens: ["clearDiskCacheOnce("],
    routeMembers: [
      {
        file: "src/vault.ts",
        member: "clearDiskCacheOnce",
        requiredTokens: [".tmp", "preflightSensitiveArtifactTemps(file)", "removeSensitiveArtifactTemps(file)"]
      }
    ]
  }
] as const;

/** Slice a 2-space-indented class method body: from `async <name>(` through its
 *  own closing `\n  }` (deeper-indented nested closers like `\n    }` don't
 *  match). Returns "" if the method isn't found. Pure — unit-tested below. */
function extractMethod(src: string, name: string): string {
  const start = src.indexOf(`async ${name}(`);
  if (start === -1) return "";
  const rest = src.slice(start);
  const m = rest.match(/\n {2}\}/);
  return m && m.index !== undefined ? rest.slice(0, m.index + m[0].length) : rest;
}

/** Pure: which required suffix tokens are ABSENT from `source`. Empty ⇒ the
 *  eraser references every artifact suffix (complete). */
function missingErasureTokens(source: string, required: readonly string[]): string[] {
  return required.filter((tok) => !source.includes(tok));
}

interface RuntimeMemberRequirement {
  file: string;
  member: string;
  needles: readonly string[];
}

interface SensitivePublisherInventoryEntry {
  id: string;
  publisher: RuntimeMemberRequirement;
  eraserRoutes: readonly RuntimeMemberRequirement[];
  pruneProbe: string;
}

const INVENTORY_OTHER = "bbbbbbbbbbbb";
const INVENTORY_KEEP = "aaaaaaaaaaaa";
const TOKEN_48 = "a".repeat(48);
const SQLITE_FAMILY_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;
const SQLITE_SIDECAR_SUFFIXES = SQLITE_FAMILY_SUFFIXES.slice(1) as ReadonlyArray<"-wal" | "-shm" | "-journal">;

const SQLITE_UNSAFE_FAMILY_CASES = [
  ...SQLITE_FAMILY_SUFFIXES.flatMap((suffix) =>
    (["symlink", "hardlink", "special"] as const).map((hazard) => ({ hazard, suffix }))
  ),
  ...SQLITE_FAMILY_SUFFIXES.map((suffix) => ({ hazard: "socket" as const, suffix })),
  ...SQLITE_SIDECAR_SUFFIXES.map((suffix) => ({ hazard: "orphan" as const, suffix }))
] as const;

interface SqliteNativeOpenRoute {
  id: string;
  file: "src/fts5.ts" | "src/embed-db.ts";
  member: string;
  fileArgument: "file" | "this.file";
  loaderNeedle: "loadBetterSqlite()" | 'import("better-sqlite3")';
  constructorNeedle: string;
}

const SQLITE_NATIVE_OPEN_ROUTES: readonly SqliteNativeOpenRoute[] = [
  {
    id: "FTS mutating open",
    file: "src/fts5.ts",
    member: "open",
    fileArgument: "this.file",
    loaderNeedle: "loadBetterSqlite()",
    constructorNeedle: "new Ctor(this.file)"
  },
  {
    id: "FTS discovery",
    file: "src/fts5.ts",
    member: "discoverFtsIndexConfig",
    fileArgument: "file",
    loaderNeedle: 'import("better-sqlite3")',
    constructorNeedle: "new Database(file, { readonly: true, fileMustExist: true })"
  },
  {
    id: "FTS diagnostic peek",
    file: "src/fts5.ts",
    member: "peekFtsMetaSafe",
    fileArgument: "file",
    loaderNeedle: 'import("better-sqlite3")',
    constructorNeedle: "new Database(file, { readonly: true, fileMustExist: true })"
  },
  {
    id: "Embed mutating open",
    file: "src/embed-db.ts",
    member: "open",
    fileArgument: "this.file",
    loaderNeedle: "loadBetterSqlite()",
    constructorNeedle: "new Ctor(this.file)"
  },
  {
    id: "Embed receipt reader",
    file: "src/embed-db.ts",
    member: "openEmbedReceiptReader",
    fileArgument: "file",
    loaderNeedle: "loadBetterSqlite()",
    constructorNeedle: "new Ctor(file, { readonly: true, fileMustExist: true })"
  },
  {
    id: "Embed discovery",
    file: "src/embed-db.ts",
    member: "discoverEmbedDbConfig",
    fileArgument: "file",
    loaderNeedle: "loadBetterSqlite()",
    constructorNeedle: "new Ctor(file, { readonly: true, fileMustExist: true })"
  },
  {
    id: "Embed diagnostic peek",
    file: "src/embed-db.ts",
    member: "peekEmbedDbMeta",
    fileArgument: "file",
    loaderNeedle: 'import("better-sqlite3")',
    constructorNeedle: "new Database(file, { readonly: true, fileMustExist: true })"
  }
];

// Runtime publishers only: SQLite manages its own journals and is covered by
// the existing suffix manifest. These are the plain-file publishers for which
// Enquire controls both the publish protocol and the recognized erasure paths.
const SENSITIVE_PUBLISHER_INVENTORY: readonly SensitivePublisherInventoryEntry[] = [
  {
    id: "parse-cache",
    publisher: {
      file: "src/vault.ts",
      member: "saveDiskCacheOnce",
      needles: [
        "private async saveDiskCacheOnce(file: string)",
        "const cacheSnapshot = [...this.cache];",
        "for (const [abs, cached] of cacheSnapshot)",
        "publishSensitiveArtifact(file, serialized)"
      ]
    },
    eraserRoutes: [
      {
        file: "src/vault.ts",
        member: "clearDiskCache",
        needles: [
          "const invocationEpoch = this.cacheEpoch;",
          "this.clearDiskCacheOnce(file, invocationEpoch)"
        ]
      },
      {
        file: "src/vault.ts",
        member: "clearDiskCacheOnce",
        needles: [
          "private async clearDiskCacheOnce(file: string, invocationEpoch: number)",
          "preflightSensitiveArtifactTemps(file)",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal template-source needle
          "`${file}.tmp`",
          "removeSensitiveArtifactTemps(file)",
          "this.cacheEpoch === invocationEpoch"
        ]
      },
      {
        file: "src/fts5.ts",
        member: "planCachePruneOnDisk",
        needles: ["planCachePrune(entries, keepHash)", "sameCanonicalDirectoryEntry("]
      }
    ],
    pruneProbe: `${INVENTORY_OTHER}.json.enquire-stage-${TOKEN_48}`
  },
  {
    id: "feedback",
    publisher: {
      file: "src/feedback.ts",
      member: "writeOnce",
      needles: ["publishSensitiveArtifact(this.file, serialized)"]
    },
    eraserRoutes: [
      {
        file: "src/fts5.ts",
        member: "planCachePruneOnDisk",
        needles: ["planCachePrune(entries, keepHash)", "sameCanonicalDirectoryEntry("]
      }
    ],
    pruneProbe: `${INVENTORY_OTHER}.feedback.json.enquire-tmp-${TOKEN_48}`
  },
  ...[
    {
      id: "hnsw-binary-generation",
      publisherNeedle: "publishSensitiveArtifact(generationFile, async (stagedPath) => {",
      pruneProbe: `${INVENTORY_OTHER}.hnsw.${TOKEN_48}.bin.enquire-stage-${TOKEN_48}`
    },
    {
      id: "hnsw-metadata-pointer",
      publisherNeedle: "publishSensitiveArtifact(metaFile, serializedMeta)",
      pruneProbe: `${INVENTORY_OTHER}.hnsw.meta.json.enquire-tmp-${TOKEN_48}`
    }
  ].map(({ id, publisherNeedle, pruneProbe }) => ({
    id,
    publisher: { file: "src/hnsw.ts", member: "saveTo", needles: [publisherNeedle] },
    eraserRoutes: [
      {
        file: "src/hnsw.ts",
        member: "clearHnswPersistedArtifacts",
        needles: [
          "const plan = await planHnswErasure(file);",
          "removeSensitiveArtifactTempEntry(entry.entryPath)"
        ]
      },
      {
        file: "src/hnsw.ts",
        member: "planHnswErasure",
        needles: ["sensitiveArtifactFinalBasename(entry)", "expectedHnswBasename(file, ownedFinal, legacyBin, meta)"]
      },
      {
        file: "src/embed-db.ts",
        member: "clearOnDisk",
        needles: ["clearHnswPersistedArtifacts(hnswBase)"]
      },
      {
        file: "src/fts5.ts",
        member: "planCachePruneOnDisk",
        needles: ["planCachePrune(entries, keepHash)", "sameCanonicalDirectoryEntry("]
      }
    ],
    pruneProbe
  }))
];

function runtimeMemberBodies(source: string, file: string, member: string): string[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bodies: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.name?.getText(sourceFile) === member
    ) {
      bodies.push(node.getText(sourceFile));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bodies;
}

function sensitiveReaderRouteProblems(
  source: string,
  file: string,
  member: string,
  expectedCalls: number,
  exactCall: string
): string[] {
  const bodies = runtimeMemberBodies(source, file, member);
  if (bodies.length !== 1) return [`${file}#${member}: expected one runtime member, found ${bodies.length}`];
  const body = bodies[0] ?? "";
  const helperCalls = body.match(/\breadSensitiveArtifactText\s*\(/g)?.length ?? 0;
  const exactCalls = body.split(exactCall).length - 1;
  const problems: string[] = [];
  if (helperCalls !== expectedCalls) {
    problems.push(`${file}#${member}: expected ${expectedCalls} shared-reader calls, found ${helperCalls}`);
  }
  if (exactCalls !== expectedCalls) {
    problems.push(`${file}#${member}: expected ${expectedCalls} exact bounded calls, found ${exactCalls}`);
  }
  if (/\b(?:readFile|readFileSync)\s*\(/.test(body)) {
    problems.push(`${file}#${member}: direct text reader bypasses the shared no-follow reader`);
  }
  return problems;
}

function cacheSnapshotProblems(source: string): string[] {
  const sourceFile = ts.createSourceFile("src/vault.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const methods: ts.MethodDeclaration[] = [];
  const findMethod = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && node.name.getText(sourceFile) === "saveDiskCacheOnce") {
      methods.push(node);
    }
    ts.forEachChild(node, findMethod);
  };
  findMethod(sourceFile);
  if (methods.length !== 1) return [`expected one saveDiskCacheOnce method, found ${methods.length}`];
  const method = methods[0];
  if (!method) return ["saveDiskCacheOnce method disappeared"];

  let snapshotDeclarations = 0;
  let snapshotPosition = Number.POSITIVE_INFINITY;
  let snapshotInitializer = "";
  let snapshotLoops = 0;
  let firstAwait = Number.POSITIVE_INFINITY;
  const inspect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(sourceFile) === "cacheSnapshot") {
      snapshotDeclarations += 1;
      snapshotPosition = Math.min(snapshotPosition, node.getStart(sourceFile));
      snapshotInitializer = node.initializer?.getText(sourceFile) ?? "";
    }
    if (ts.isForOfStatement(node) && node.expression.getText(sourceFile) === "cacheSnapshot") snapshotLoops += 1;
    if (ts.isAwaitExpression(node)) firstAwait = Math.min(firstAwait, node.getStart(sourceFile));
    ts.forEachChild(node, inspect);
  };
  inspect(method);

  const problems: string[] = [];
  if (snapshotDeclarations !== 1 || snapshotInitializer !== "[...this.cache]") {
    problems.push("saveDiskCacheOnce must take one synchronous cacheSnapshot");
  }
  if (snapshotLoops !== 1) problems.push(`saveDiskCacheOnce must iterate cacheSnapshot once, found ${snapshotLoops}`);
  if (snapshotPosition >= firstAwait) problems.push("saveDiskCacheOnce cacheSnapshot must precede its first await");
  return problems;
}

function statementInDirectBlock(node: ts.Node): ts.Statement | null {
  let current = node;
  while (current.parent && !ts.isBlock(current.parent)) current = current.parent;
  if (!ts.isStatement(current) || !current.parent || !ts.isBlock(current.parent)) return null;
  return current;
}

function sqliteNativeOpenProblems(overrides: ReadonlyMap<string, string> = new Map()): string[] {
  const problems: string[] = [];
  for (const route of SQLITE_NATIVE_OPEN_ROUTES) {
    const source = overrides.get(route.file) ?? readFileSync(path.join(repoRoot, route.file), "utf8");
    const bodies = runtimeMemberBodies(source, route.file, route.member);
    if (bodies.length !== 1) {
      problems.push(`${route.id}: expected one ${route.member} body, found ${bodies.length}`);
      continue;
    }
    const body = bodies[0] ?? "";
    const preflightNeedle = `preflightSqliteArtifactFamily(${route.fileArgument})`;
    const preflightCount = body.split(preflightNeedle).length - 1;
    const constructorCount = body.split(route.constructorNeedle).length - 1;
    const firstPreflight = body.indexOf(preflightNeedle);
    const loader = body.indexOf(route.loaderNeedle);
    const lastPreflight = body.lastIndexOf(preflightNeedle);
    const constructorOffset = body.indexOf(route.constructorNeedle);
    if (preflightCount !== 2) problems.push(`${route.id}: expected two family preflights, found ${preflightCount}`);
    if (constructorCount !== 1) problems.push(`${route.id}: expected one disk constructor, found ${constructorCount}`);
    if (!(firstPreflight >= 0 && firstPreflight < loader && loader < lastPreflight && lastPreflight < constructorOffset)) {
      problems.push(`${route.id}: preflight/load/preflight/open order is not exact`);
    }

    const sourceFile = ts.createSourceFile(route.file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const members: ts.Node[] = [];
    const findMember = (node: ts.Node): void => {
      if (
        (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) &&
        node.name?.getText(sourceFile) === route.member
      ) {
        members.push(node);
      }
      ts.forEachChild(node, findMember);
    };
    findMember(sourceFile);
    const member = members[0];
    if (members.length !== 1 || !member) continue;
    const preflightCalls: ts.CallExpression[] = [];
    const constructors: ts.NewExpression[] = [];
    const inspect = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.getText(sourceFile) === preflightNeedle) preflightCalls.push(node);
      if (ts.isNewExpression(node) && node.getText(sourceFile) === route.constructorNeedle) constructors.push(node);
      ts.forEachChild(node, inspect);
    };
    inspect(member);
    preflightCalls.sort((left, right) => left.getStart() - right.getStart());
    const nearPreflight = preflightCalls[preflightCalls.length - 1];
    const diskConstructor = constructors[0];
    const preflightStatement = nearPreflight ? statementInDirectBlock(nearPreflight) : null;
    const constructorStatement = diskConstructor ? statementInDirectBlock(diskConstructor) : null;
    const directBlock = preflightStatement?.parent;
    if (
      !preflightStatement ||
      !constructorStatement ||
      !directBlock ||
      !ts.isBlock(directBlock) ||
      directBlock !== constructorStatement.parent
    ) {
      problems.push(`${route.id}: final preflight and disk constructor are not in one direct block`);
      continue;
    }
    const statements = directBlock.statements;
    if (statements.indexOf(constructorStatement) !== statements.indexOf(preflightStatement) + 1) {
      problems.push(`${route.id}: final preflight is not constructor-adjacent`);
    }
  }

  let diskConstructors = 0;
  let memoryProbes = 0;
  for (const file of ["src/fts5.ts", "src/embed-db.ts"] as const) {
    const source = overrides.get(file) ?? readFileSync(path.join(repoRoot, file), "utf8");
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node)) {
        const constructorText = node.expression.getText(sourceFile);
        const firstArgument = node.arguments?.[0]?.getText(sourceFile);
        if (constructorText === "ctor" && firstArgument === '":memory:"') memoryProbes += 1;
        if (
          (constructorText === "Ctor" || constructorText === "Database") &&
          (firstArgument === "file" || firstArgument === "this.file")
        ) {
          diskConstructors += 1;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  if (diskConstructors !== 7) problems.push(`SQLite disk-constructor census expected 7, found ${diskConstructors}`);
  if (memoryProbes !== 2) problems.push(`SQLite :memory: probe census expected 2, found ${memoryProbes}`);
  return problems;
}

function expectPersistenceAdmissionBeforeFilesystem(
  admit: NamespaceAdmitter,
  file: string,
  expectedError?: RegExp
): void {
  const accessSpy = vi.spyOn(fs, "access");
  const lstatSpy = vi.spyOn(fs, "lstat");
  const openSpy = vi.spyOn(fs, "open");
  const readFileSpy = vi.spyOn(fs, "readFile");
  const statSpy = vi.spyOn(fs, "stat");
  try {
    if (expectedError) expect(() => admit(file)).toThrow(expectedError);
    else expect(() => admit(file)).not.toThrow();
    expect(accessSpy).not.toHaveBeenCalled();
    expect(lstatSpy).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
    expect(readFileSpy).not.toHaveBeenCalled();
    expect(statSpy).not.toHaveBeenCalled();
  } finally {
    accessSpy.mockRestore();
    lstatSpy.mockRestore();
    openSpy.mockRestore();
    readFileSpy.mockRestore();
    statSpy.mockRestore();
  }
}

function emptyHnswRowsBranch(source: string): string {
  const sourceFile = ts.createSourceFile("server.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const branches: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node) && node.expression.getText(sourceFile) === "rows.length === 0") {
      branches.push(node.thenStatement.getText(sourceFile));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (branches.length !== 1) throw new Error(`expected one empty-HNSW rows branch, found ${branches.length}`);
  return branches[0] ?? "";
}

function publisherInventoryProblems(overrides: ReadonlyMap<string, string> = new Map()): string[] {
  const problems: string[] = [];
  for (const entry of SENSITIVE_PUBLISHER_INVENTORY) {
    for (const [role, requirement] of [
      ["publisher", entry.publisher],
      ...entry.eraserRoutes.map((route) => ["eraser", route] as const)
    ] as const) {
      const source = overrides.get(requirement.file) ?? readFileSync(path.join(repoRoot, requirement.file), "utf8");
      const bodies = runtimeMemberBodies(source, requirement.file, requirement.member);
      if (bodies.length !== 1) {
        problems.push(`${entry.id}:${role}:${requirement.file}#${requirement.member} count ${bodies.length}`);
        continue;
      }
      const body = bodies[0] ?? "";
      for (const needle of requirement.needles) {
        if (!body.includes(needle)) {
          problems.push(`${entry.id}:${role}:${requirement.file}#${requirement.member} missing ${needle}`);
        }
      }
    }
    if (!planCachePrune([entry.pruneProbe, `${INVENTORY_KEEP}.fts5.db`], INVENTORY_KEEP).includes(entry.pruneProbe)) {
      problems.push(`${entry.id}:prune probe not selected`);
    }
  }
  return problems;
}

const PUBLISHER_INVENTORY_MUTANTS = SENSITIVE_PUBLISHER_INVENTORY.flatMap((entry) =>
  ([entry.publisher, ...entry.eraserRoutes] as const).flatMap((requirement, requirementIndex) =>
    requirement.needles.map((needle) => ({
      id: entry.id,
      role: requirementIndex === 0 ? "publisher" : "eraser",
      file: requirement.file,
      member: requirement.member,
      needle
    }))
  )
);

async function createDistinctFoldedHardlinks(
  exactPath: string,
  foldedPath: string,
  skip: (note?: string) => void
): Promise<boolean> {
  try {
    await fs.writeFile(exactPath, "HARDLINK_SENTINEL", { flag: "wx", mode: 0o600 });
    await fs.link(exactPath, foldedPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (["EEXIST", "EPERM", "EACCES", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EXDEV"].includes(code ?? "")) {
      skip(`filesystem cannot host distinct folded-name hardlinks (${code ?? "unknown"})`);
      return false;
    }
    throw err;
  }
  const [exactReal, foldedReal, exactStat, foldedStat] = await Promise.all([
    fs.realpath(exactPath),
    fs.realpath(foldedPath),
    fs.lstat(exactPath, { bigint: true }),
    fs.lstat(foldedPath, { bigint: true })
  ]);
  if (exactReal === foldedReal) {
    skip("filesystem canonicalizes folded names to one directory entry");
    return false;
  }
  expect(foldedStat.dev).toBe(exactStat.dev);
  expect(foldedStat.ino).toBe(exactStat.ino);
  return true;
}

async function createDistinctFoldedHardlinkedSymlinks(
  exactPath: string,
  foldedPath: string,
  targetPath: string,
  skip: (note?: string) => void
): Promise<boolean> {
  try {
    await fs.writeFile(targetPath, "HARDLINKED_SYMLINK_TARGET", { flag: "wx", mode: 0o600 });
    await fs.symlink(targetPath, exactPath, "file");
    await fs.link(exactPath, foldedPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (["EEXIST", "EPERM", "EACCES", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EXDEV"].includes(code ?? "")) {
      skip(`filesystem cannot host distinct folded hardlinks to one symlink (${code ?? "unknown"})`);
      return false;
    }
    throw err;
  }
  const [exactStat, foldedStat] = await Promise.all([
    fs.lstat(exactPath, { bigint: true }),
    fs.lstat(foldedPath, { bigint: true })
  ]);
  if (!exactStat.isSymbolicLink() || !foldedStat.isSymbolicLink()) {
    skip("filesystem hardlink operation followed the symlink leaf");
    return false;
  }
  expect(foldedStat.dev).toBe(exactStat.dev);
  expect(foldedStat.ino).toBe(exactStat.ino);
  return true;
}

describe("erasure-completeness invariant (rc.36, P-2 class)", () => {
  let root: string;
  let cacheDir: string;
  let cacheFile: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-erasure-vault-"));
    cacheDir = await fs.mkdtemp(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "enq-e-"));
    cacheFile = path.join(cacheDir, "cache.json");
    await fs.writeFile(path.join(root, "Secret.md"), "---\ntags: [secret]\n---\n\nSENSITIVE_VAULT_BODY_XYZ\n");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  it.for([
    { shape: "whole family absent", suffixes: [] as readonly string[], mainExists: false },
    { shape: "singly linked regular main", suffixes: [""], mainExists: true },
    { shape: "singly linked regular main plus WAL/SHM/hot journal", suffixes: SQLITE_FAMILY_SUFFIXES, mainExists: true }
  ])("SQLite preflight admits a $shape family", async ({ shape, suffixes, mainExists }) => {
    const mainFile = path.join(cacheDir, `positive-${shape.replaceAll(/[^a-z]+/gi, "-")}.fts5.db`);
    for (const suffix of suffixes) await fs.writeFile(`${mainFile}${suffix}`, `REGULAR${suffix || "-main"}`);
    await expect(preflightSqliteArtifactFamily(mainFile)).resolves.toBe(mainExists);
  });

  it.for(SQLITE_UNSAFE_FAMILY_CASES)(
    "SQLite preflight rejects a $hazard $suffix leaf without changing it",
    async ({ hazard, suffix }, { skip }) => {
      const suffixLabel = suffix || "main";
      const mainFile = path.join(cacheDir, `unsafe-${hazard}-${suffixLabel.replace("-", "")}.fts5.db`);
      const target = `${mainFile}${suffix}`;
      if (suffix !== "" && hazard !== "orphan") await fs.writeFile(mainFile, "MAIN_SENTINEL");

      let external = "";
      let alias = "";
      let socketServer: net.Server | null = null;
      let socketListening = false;
      if (hazard === "symlink") {
        external = `${mainFile}.external`;
        await fs.writeFile(external, "EXTERNAL_SENTINEL");
        try {
          await fs.symlink(external, target, "file");
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
            skip(`filesystem cannot create SQLite-family symlink control (${code})`);
            return;
          }
          throw error;
        }
      } else if (hazard === "hardlink") {
        await fs.writeFile(target, "HARDLINK_SENTINEL");
        alias = `${mainFile}.hardlink-alias`;
        try {
          await fs.link(target, alias);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "EPERM" || code === "EACCES" || code === "ENOSYS" || code === "EMLINK") {
            skip(`filesystem cannot create SQLite-family hardlink control (${code})`);
            return;
          }
          throw error;
        }
      } else if (hazard === "special") {
        await fs.mkdir(target);
      } else if (hazard === "socket") {
        if (process.platform === "win32") {
          skip("Unix-domain SQLite-family socket control is POSIX-only");
          return;
        }
        socketServer = net.createServer();
        try {
          await new Promise<void>((resolve, reject) => {
            socketServer?.once("error", reject);
            socketServer?.listen(target, () => {
              socketServer?.removeListener("error", reject);
              socketListening = true;
              resolve();
            });
          });
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (["EPERM", "EACCES", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(code ?? "")) {
            skip(`filesystem cannot create SQLite-family socket control (${code ?? "unknown"})`);
            return;
          }
          throw error;
        }
      } else {
        await fs.writeFile(target, "ORPHAN_SIDECAR_SENTINEL");
      }

      try {
        await expect(preflightSqliteArtifactFamily(mainFile)).rejects.toThrow(
          hazard === "orphan" ? /sidecars without their main file/ : /unsafe SQLite artifact family/
        );
        if (hazard === "symlink") {
          expect(await fs.readFile(external, "utf8")).toBe("EXTERNAL_SENTINEL");
          expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
        } else if (hazard === "hardlink") {
          expect(await fs.readFile(target, "utf8")).toBe("HARDLINK_SENTINEL");
          expect(await fs.readFile(alias, "utf8")).toBe("HARDLINK_SENTINEL");
        } else if (hazard === "special") {
          expect((await fs.lstat(target)).isDirectory()).toBe(true);
        } else if (hazard === "socket") {
          expect((await fs.lstat(target)).isSocket()).toBe(true);
        } else {
          expect(await fs.readFile(target, "utf8")).toBe("ORPHAN_SIDECAR_SENTINEL");
        }
      } finally {
        if (socketServer && socketListening) {
          await new Promise<void>((resolve) => socketServer?.close(() => resolve()));
        }
      }
    }
  );

  it.for([
    {
      id: "parse-cache load",
      file: "src/vault.ts",
      member: "loadDiskCache",
      calls: 1,
      exactCall: "readSensitiveArtifactText(file, this.maxDiskCacheBytes)",
      directArgument: "file"
    },
    {
      id: "feedback load",
      file: "src/feedback.ts",
      member: "open",
      calls: 1,
      exactCall: "readSensitiveArtifactText(file, MAX_FEEDBACK_FILE_BYTES)",
      directArgument: "file"
    },
    {
      id: "HNSW pointer read",
      file: "src/hnsw.ts",
      member: "readHnswMetaPointer",
      calls: 1,
      exactCall: "readSensitiveArtifactText(metaFile, MAX_HNSW_META_BYTES)",
      directArgument: "metaFile"
    },
    {
      id: "HNSW load receipt",
      file: "src/hnsw.ts",
      member: "loadHnswFromDisk",
      calls: 2,
      exactCall: "readSensitiveArtifactText(metaFile, MAX_HNSW_META_BYTES)",
      directArgument: "metaFile"
    }
  ])(
    "$id routes every sensitive text read through the shared no-follow reader",
    ({ file, member, calls, exactCall, directArgument }) => {
      const source = readFileSync(path.join(repoRoot, file), "utf8");
      const bodies = runtimeMemberBodies(source, file, member);
      expect(bodies).toHaveLength(1);
      const body = bodies[0] ?? "";
      expect(sensitiveReaderRouteProblems(source, file, member, calls, exactCall)).toEqual([]);
      const mutantBody = replaceExactly(
        body,
        exactCall,
        `${exactCall} + (await fs.readFile(${directArgument}, "utf8"))`,
        calls
      );
      const mutantSource = replaceExactly(source, body, mutantBody);
      expect(sensitiveReaderRouteProblems(mutantSource, file, member, calls, exactCall)).not.toEqual([]);
      const unboundedBody = replaceExactly(
        body,
        exactCall,
        `readSensitiveArtifactText(${directArgument})`,
        calls
      );
      const unboundedSource = replaceExactly(source, body, unboundedBody);
      expect(sensitiveReaderRouteProblems(unboundedSource, file, member, calls, exactCall)).not.toEqual([]);
    }
  );

  it.each([
    ["cache artifact", "LF", "\n"],
    ["cache artifact", "U+2028", "\u2028"],
    ["HNSW generation token", "LF", "\n"],
    ["HNSW generation token", "U+2028", "\u2028"],
    ["publisher wrapper", "LF", "\n"],
    ["publisher wrapper", "U+2028", "\u2028"]
  ] as const)("absolute-end %s classifier rejects a trailing %s", (surface, _label, terminator) => {
    const token = "4".repeat(48);
    const accepted =
      surface === "cache artifact"
        ? planCachePrune([`${INVENTORY_OTHER}.json${terminator}`], INVENTORY_KEEP).length > 0
        : surface === "HNSW generation token"
          ? isHnswGenerationBasename(
              path.join(cacheDir, "strict-end.hnsw"),
              `strict-end.hnsw.${token}${terminator}.bin`
            )
          : sensitiveArtifactFinalBasename(`${INVENTORY_OTHER}.json.enquire-tmp-${token}${terminator}`) !== null;
    expect(accepted).toBe(false);
  });

  // ── Behavioral: the actual F-2 fix + regression guard ──
  it("clearDiskCache erases legacy and generated publisher leftovers", async () => {
    const v = new Vault(root, { persistentCache: true, cacheFile });
    await v.ensureExists();
    await v.readNote(path.join(root, "Secret.md"));
    await v.saveDiskCache(); // writes cache.json (the .tmp is renamed away on success)

    // Simulate a crash (or EXDEV) that left a `.tmp` behind with raw note bodies.
    await fs.writeFile(`${cacheFile}.tmp`, JSON.stringify({ entries: [{ content: "SENSITIVE_VAULT_BODY_XYZ" }] }), {
      mode: 0o600
    });

    const generatedTmp = `${cacheFile}.enquire-tmp-${"a".repeat(48)}`;
    const generatedStage = `${cacheFile}.enquire-stage-${"b".repeat(48)}`;
    await fs.writeFile(generatedTmp, "SENSITIVE_VAULT_BODY_XYZ", { mode: 0o600 });
    await fs.mkdir(generatedStage, { mode: 0o700 });
    await fs.writeFile(path.join(generatedStage, "artifact"), "SENSITIVE_VAULT_BODY_XYZ", { mode: 0o600 });

    const removed = await v.clearDiskCache();
    expect(removed).toBe(true);

    const cacheGone = await fs
      .stat(cacheFile)
      .then(() => false)
      .catch(() => true);
    const tmpGone = await fs
      .stat(`${cacheFile}.tmp`)
      .then(() => false)
      .catch(() => true);
    expect(cacheGone).toBe(true);
    expect(tmpGone).toBe(true); // THE FIX — pre-rc.36 this was false (raw text persisted)
    await expect(fs.lstat(generatedTmp)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(generatedStage)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.for([{ family: "generated temp" }])(
    "clearDiskCache unlinks a $family symlink without touching its target",
    async (_fixture, { skip }) => {
      const v = new Vault(root, { persistentCache: true, cacheFile });
      await v.ensureExists();
      const generatedSymlink = `${cacheFile}.enquire-tmp-${"c".repeat(48)}`;
      const sentinel = path.join(cacheDir, "foreign-symlink-target.txt");
      await fs.writeFile(sentinel, "FOREIGN_SENTINEL");
      try {
        await fs.symlink(sentinel, generatedSymlink, "file");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
          skip(`filesystem cannot create the symlink control (${code})`);
          return;
        }
        throw err;
      }

      expect(await v.clearDiskCache()).toBe(true);
      await expect(fs.lstat(generatedSymlink)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(sentinel, "utf8")).toBe("FOREIGN_SENTINEL");
    }
  );

  it.for([{ kind: "tmp" as const }, { kind: "stage" as const }])(
    "generated $kind erasure recognizes a POSIX final basename containing a newline",
    async ({ kind }, { skip }) => {
      if (process.platform === "win32") {
        skip("Win32 filenames cannot contain a newline");
        return;
      }
      const finalPath = path.join(cacheDir, "line\nbreak.json");
      const generated = `${finalPath}.enquire-${kind}-${"7".repeat(48)}`;
      if (kind === "tmp") {
        await fs.writeFile(generated, "NEWLINE_TEMP_SENTINEL", { flag: "wx", mode: 0o600 });
      } else {
        await fs.mkdir(generated, { mode: 0o700 });
        await fs.writeFile(path.join(generated, "artifact"), "NEWLINE_STAGE_SENTINEL", { mode: 0o600 });
      }

      await expect(removeSensitiveArtifactTemps(finalPath)).resolves.toBe(1);
      await expect(fs.lstat(generated)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it.for([{ route: "eraser" as const }, { route: "prune" as const }])(
    "a newline appended after the generated token is ignored by the $route parser",
    async ({ route }, { skip }) => {
      const token = "8".repeat(48);
      const finalName = `${INVENTORY_OTHER}.json`;
      const malformedName = `${finalName}.enquire-tmp-${token}\n`;
      if (route === "prune") {
        expect(planCachePrune([malformedName], INVENTORY_KEEP)).toEqual([]);
        return;
      }
      if (process.platform === "win32") {
        skip("Win32 filenames cannot contain a newline");
        return;
      }
      const malformedPath = path.join(cacheDir, malformedName);
      await fs.writeFile(malformedPath, "TRAILING_NEWLINE_SENTINEL", { flag: "wx", mode: 0o600 });
      await expect(removeSensitiveArtifactTemps(path.join(cacheDir, finalName))).resolves.toBe(0);
      expect(await fs.readFile(malformedPath, "utf8")).toBe("TRAILING_NEWLINE_SENTINEL");
    }
  );

  it.for([
    { kind: "regular file" as const },
    { kind: "symlink" as const },
    { kind: "Unix-domain socket" as const }
  ])("sensitive reader enforces the $kind leaf contract", async ({ kind }, { skip }) => {
    const file = path.join(cacheDir, `reader-${kind.replaceAll(" ", "-")}.json`);
    if (kind === "regular file") {
      await fs.writeFile(file, "REGULAR_READER_BYTES", { flag: "wx", mode: 0o600 });
      await expect(readSensitiveArtifactText(file)).resolves.toBe("REGULAR_READER_BYTES");
      return;
    }

    if (kind === "symlink") {
      const target = path.join(cacheDir, "reader-symlink-target.txt");
      await fs.writeFile(target, "SYMLINK_TARGET_SENTINEL", { flag: "wx", mode: 0o600 });
      try {
        await fs.symlink(target, file, "file");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (["EPERM", "EACCES", "ENOSYS"].includes(code ?? "")) {
          skip(`filesystem cannot create the reader symlink control (${code ?? "unknown"})`);
          return;
        }
        throw err;
      }
      const openSpy = vi.spyOn(fs, "open");
      try {
        await expect(readSensitiveArtifactText(file)).rejects.toThrow(/non-regular sensitive artifact/);
        expect(openSpy).not.toHaveBeenCalled();
      } finally {
        openSpy.mockRestore();
      }
      expect(await fs.readFile(target, "utf8")).toBe("SYMLINK_TARGET_SENTINEL");
      return;
    }

    if (process.platform === "win32") {
      skip("Unix-domain socket pathname control is POSIX-only");
      return;
    }
    const server = net.createServer();
    let listening = false;
    try {
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(file, () => {
            server.removeListener("error", reject);
            listening = true;
            resolve();
          });
        });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (["EPERM", "EACCES", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(code ?? "")) {
          skip(`filesystem cannot create the reader socket control (${code ?? "unknown"})`);
          return;
        }
        throw err;
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("sensitive reader blocked on a special leaf")), 1000);
      });
      try {
        await expect(Promise.race([readSensitiveArtifactText(file), timeout])).rejects.toThrow(
          /non-regular sensitive artifact/
        );
      } finally {
        if (timer) clearTimeout(timer);
      }
      expect((await fs.lstat(file)).isSocket()).toBe(true);
    } finally {
      if (listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });

  it.for([{ growth: "before bounded read" as const }, { growth: "during bounded read" as const }])(
    "sensitive reader bounds a generation that grows $growth",
    async ({ growth }) => {
      const file = path.join(cacheDir, `reader-growth-${growth.replaceAll(" ", "-")}.json`);
      const maxBytes = 8;
      await fs.writeFile(file, "SMALL", { flag: "wx", mode: 0o600 });
      const realOpen = fs.open.bind(fs);
      let statCalls = 0;
      let readCalls = 0;
      let largestReadRequest = 0;
      let grown = false;
      const openSpy = vi.spyOn(fs, "open").mockImplementation(async (candidate, flags, mode) => {
        const handle = await realOpen(candidate, flags, mode);
        const realStat = handle.stat.bind(handle) as (
          options: { bigint: true }
        ) => Promise<import("node:fs").BigIntStats>;
        const realRead = handle.read.bind(handle) as (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number | null
        ) => Promise<{ bytesRead: number; buffer: Buffer }>;
        return new Proxy(handle, {
          get(target, property) {
            if (property === "stat") {
              return async (options: { bigint: true }) => {
                statCalls += 1;
                if (growth === "before bounded read" && statCalls === 2 && !grown) {
                  grown = true;
                  await fs.appendFile(file, "G".repeat(maxBytes + 2));
                }
                return realStat(options);
              };
            }
            if (property === "read") {
              return async (buffer: Buffer, offset: number, length: number, position: number | null) => {
                readCalls += 1;
                largestReadRequest = Math.max(largestReadRequest, length);
                if (growth === "during bounded read" && !grown) {
                  grown = true;
                  await fs.appendFile(file, "G".repeat(maxBytes + 2));
                }
                return realRead(buffer, offset, length, position);
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
      });
      try {
        await expect(readSensitiveArtifactText(file, maxBytes)).rejects.toThrow(/exceeds its read limit/);
      } finally {
        openSpy.mockRestore();
      }
      expect(grown).toBe(true);
      expect(statCalls).toBeGreaterThanOrEqual(2);
      expect(readCalls).toBe(growth === "before bounded read" ? 0 : 1);
      expect(largestReadRequest).toBeLessThanOrEqual(maxBytes + 1);
      expect((await fs.stat(file)).size).toBeGreaterThan(maxBytes);
    }
  );

  it.for([
    { kind: "missing" as const },
    { kind: "regular file" as const },
    { kind: "symlink" as const }
  ])("publisher admits a $kind final leaf", async ({ kind }, { skip }) => {
    const finalPath = path.join(cacheDir, `replaceable-${kind.replaceAll(" ", "-")}.bin`);
    const symlinkTarget = path.join(cacheDir, "replaceable-symlink-target.txt");
    if (kind === "regular file") {
      await fs.writeFile(finalPath, "OLD_FINAL_BYTES", { flag: "wx", mode: 0o600 });
    } else if (kind === "symlink") {
      await fs.writeFile(symlinkTarget, "FOREIGN_TARGET_SENTINEL", { flag: "wx", mode: 0o600 });
      try {
        await fs.symlink(symlinkTarget, finalPath, "file");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (["EPERM", "EACCES", "ENOSYS"].includes(code ?? "")) {
          skip(`filesystem cannot create the final-leaf symlink control (${code ?? "unknown"})`);
          return;
        }
        throw err;
      }
    }

    await expect(publishSensitiveArtifact(finalPath, "NEW_FINAL_BYTES")).resolves.toMatchObject({
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/)
    });
    expect((await fs.lstat(finalPath)).isFile()).toBe(true);
    expect(await fs.readFile(finalPath, "utf8")).toBe("NEW_FINAL_BYTES");
    if (kind === "symlink") {
      expect(await fs.readFile(symlinkTarget, "utf8")).toBe("FOREIGN_TARGET_SENTINEL");
    }
  });

  it.for([{ kind: "Unix-domain socket" as const }])(
    "publisher refuses a $kind final leaf before rename and leaves it intact",
    async (_fixture, { skip }) => {
      if (process.platform === "win32") {
        skip("Unix-domain socket pathname control is POSIX-only");
        return;
      }
      const finalPath = path.join(cacheDir, "special-final.socket");
      const server = net.createServer();
      let listening = false;
      try {
        try {
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(finalPath, () => {
              server.removeListener("error", reject);
              listening = true;
              resolve();
            });
          });
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (["EPERM", "EACCES", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(code ?? "")) {
            skip(`filesystem cannot create the Unix-domain socket control (${code ?? "unknown"})`);
            return;
          }
          throw err;
        }

        expect((await fs.lstat(finalPath)).isSocket()).toBe(true);
        const renameSpy = vi.spyOn(fs, "rename");
        try {
          await expect(publishSensitiveArtifact(finalPath, "SENSITIVE_BYTES")).rejects.toThrow(
            /non-regular sensitive-artifact destination/
          );
          expect(renameSpy).not.toHaveBeenCalled();
        } finally {
          renameSpy.mockRestore();
        }
        expect((await fs.lstat(finalPath)).isSocket()).toBe(true);
      } finally {
        if (listening) {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      }
    }
  );

  it.each(["zero inode"])("publisher rejects a %s identity before invoking a native source", async () => {
    const finalPath = path.join(cacheDir, "zero-identity.bin");
    const realOpen = fs.open.bind(fs);
    let sourceCalled = false;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (candidate, flags, mode) => {
      const handle = await realOpen(candidate, flags, mode);
      const realStat = handle.stat.bind(handle);
      const mutableHandle = handle as unknown as {
        stat(options: { bigint: true }): Promise<import("node:fs").BigIntStats>;
      };
      mutableHandle.stat = async () => {
        const stat = await realStat({ bigint: true });
        return new Proxy(stat, {
          get(target, property) {
            if (property === "ino") return 0n;
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
      };
      return handle;
    });
    try {
      await expect(
        publishSensitiveArtifact(finalPath, async (stagedPath) => {
          sourceCalled = true;
          await fs.writeFile(stagedPath, "SENSITIVE_NATIVE_BYTES");
        })
      ).rejects.toThrow(/usable temporary-file identity/);
    } finally {
      openSpy.mockRestore();
    }
    expect(sourceCalled).toBe(false);
    await expect(fs.lstat(finalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["above Number.MAX_SAFE_INTEGER"])("publisher compares %s inode identities as bigint", async () => {
    const finalPath = path.join(cacheDir, "bigint-identity.bin");
    const reservedIno = 2n ** 53n;
    const replacedIno = reservedIno + 1n;
    expect(Number(reservedIno)).toBe(Number(replacedIno));
    const realOpen = fs.open.bind(fs);
    let statCalls = 0;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (candidate, flags, mode) => {
      const handle = await realOpen(candidate, flags, mode);
      const realStat = handle.stat.bind(handle);
      const mutableHandle = handle as unknown as {
        stat(options: { bigint: true }): Promise<import("node:fs").BigIntStats>;
      };
      mutableHandle.stat = async () => {
        const stat = await realStat({ bigint: true });
        statCalls += 1;
        const ino = statCalls === 1 ? reservedIno : replacedIno;
        return new Proxy(stat, {
          get(target, property) {
            if (property === "ino") return ino;
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
      };
      return handle;
    });
    const renameSpy = vi.spyOn(fs, "rename");
    try {
      await expect(
        publishSensitiveArtifact(finalPath, async (stagedPath) => {
          await fs.writeFile(stagedPath, "SENSITIVE_NATIVE_BYTES");
        })
      ).rejects.toThrow(/replaced its owned temporary file/);
      expect(statCalls).toBeGreaterThanOrEqual(2);
      expect(renameSpy).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
      renameSpy.mockRestore();
    }
    await expect(fs.lstat(finalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.for([{ family: "generated temp", hnsw: false }, { family: "HNSW generation", hnsw: true }])(
    "folded-name hardlinks cannot impersonate a $family erasure target",
    async ({ hnsw }, { skip }) => {
      const token = "f".repeat(48);
      const exactBase = hnsw ? "CaseVault.hnsw" : "CaseCache.json";
      const foldedBase = hnsw ? "caseVault.hnsw" : "caseCache.json";
      const suffix = hnsw ? `.${token}.bin` : `.enquire-tmp-${token}`;
      const exactPath = path.join(cacheDir, `${exactBase}${suffix}`);
      const foldedPath = path.join(cacheDir, `${foldedBase}${suffix}`);
      if (!(await createDistinctFoldedHardlinks(exactPath, foldedPath, skip))) return;

      const erase = hnsw
        ? clearHnswPersistedArtifacts(path.join(cacheDir, exactBase))
        : removeSensitiveArtifactTemps(path.join(cacheDir, exactBase));
      await expect(erase).rejects.toThrow(/ambiguous|casing/i);
      expect(await fs.readFile(exactPath, "utf8")).toBe("HARDLINK_SENTINEL");
      expect(await fs.readFile(foldedPath, "utf8")).toBe("HARDLINK_SENTINEL");
    }
  );

  it.for([
    { route: "sensitive-artifact eraser" as const },
    { route: "HNSW eraser" as const },
    { route: "on-disk prune planner" as const }
  ])("distinct folded hardlinks to one symlink cannot authorize the $route", async ({ route }, { skip }) => {
    const token = "6".repeat(48);
    let exactName: string;
    let foldedName: string;
    if (route === "sensitive-artifact eraser") {
      exactName = `CaseCache.json.enquire-tmp-${token}`;
      foldedName = `caseCache.json.enquire-tmp-${token}`;
    } else if (route === "HNSW eraser") {
      exactName = `CaseVault.hnsw.${token}.bin`;
      foldedName = `caseVault.hnsw.${token}.bin`;
    } else {
      exactName = `${INVENTORY_OTHER}.feedback.json`;
      foldedName = exactName.toUpperCase();
    }
    const exactPath = path.join(cacheDir, exactName);
    const foldedPath = path.join(cacheDir, foldedName);
    const targetPath = path.join(cacheDir, `hardlinked-symlink-target-${route.replaceAll(" ", "-")}`);
    if (!(await createDistinctFoldedHardlinkedSymlinks(exactPath, foldedPath, targetPath, skip))) return;

    const operation =
      route === "sensitive-artifact eraser"
        ? removeSensitiveArtifactTemps(path.join(cacheDir, "CaseCache.json"))
        : route === "HNSW eraser"
          ? clearHnswPersistedArtifacts(path.join(cacheDir, "CaseVault.hnsw"))
          : planCachePruneOnDisk(cacheDir, [exactName, foldedName], INVENTORY_KEEP);
    await expect(operation).rejects.toThrow(/ambiguous|spelling/i);
    expect((await fs.lstat(exactPath)).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(foldedPath)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(targetPath, "utf8")).toBe("HARDLINKED_SYMLINK_TARGET");
  });

  it.for([{ family: "generated dangling-symlink temp alias" }])(
    "native equivalent spelling erases a $family without leaf realpath authority",
    async (_fixture, { skip }) => {
      const token = "5".repeat(48);
      const canonicalBase = "nativealias.json";
      const actualBase = canonicalBase.toUpperCase();
      const suffix = `.enquire-tmp-${token}`;
      const canonicalEntry = path.join(cacheDir, `${canonicalBase}${suffix}`);
      const actualEntry = path.join(cacheDir, `${actualBase}${suffix}`);
      const missingTarget = path.join(cacheDir, "intentionally-missing-target");
      try {
        await fs.symlink(missingTarget, actualEntry, "file");
        await fs.lstat(canonicalEntry);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (["ENOENT", "EEXIST", "EPERM", "EACCES", "ENOSYS"].includes(code ?? "")) {
          skip(`filesystem cannot expose a native equivalent-case dangling symlink (${code ?? "unknown"})`);
          return;
        }
        throw err;
      }

      await expect(removeSensitiveArtifactTemps(path.join(cacheDir, canonicalBase))).resolves.toBe(1);
      await expect(fs.lstat(actualEntry)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.lstat(missingTarget)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it.for([{ family: "cache-prune reserved alias" }])(
    "on-disk planner admits a native equivalent-case $family only after physical identity proof",
    async (_fixture, { skip }) => {
      const canonicalName = `${INVENTORY_OTHER}.hnsw.${"a".repeat(48)}.bin`;
      const aliasName = canonicalName.toUpperCase();
      const canonicalPath = path.join(cacheDir, canonicalName);
      const aliasPath = path.join(cacheDir, aliasName);
      await fs.writeFile(aliasPath, "NATIVE_ALIAS_SENTINEL", { flag: "wx", mode: 0o600 });
      try {
        const [canonicalReal, aliasReal] = await Promise.all([fs.realpath(canonicalPath), fs.realpath(aliasPath)]);
        if (canonicalReal !== aliasReal) {
          skip("temporary filesystem does not collapse equivalent-case spellings");
          return;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          skip("temporary filesystem is case-sensitive");
          return;
        }
        throw err;
      }

      expect(planCachePrune([aliasName], INVENTORY_KEEP)).toEqual([]);
      await expect(planCachePruneOnDisk(cacheDir, [aliasName], INVENTORY_KEEP)).resolves.toEqual([aliasName]);
      expect(await fs.readFile(aliasPath, "utf8")).toBe("NATIVE_ALIAS_SENTINEL");
    }
  );

  it.for([{ family: "cache-prune reserved alias" }])(
    "on-disk planner refuses a distinct folded hardlink $family before deletion",
    async (_fixture, { skip }) => {
      const canonicalName = `${INVENTORY_OTHER}.feedback.json`;
      const aliasName = canonicalName.toUpperCase();
      const canonicalPath = path.join(cacheDir, canonicalName);
      const aliasPath = path.join(cacheDir, aliasName);
      if (!(await createDistinctFoldedHardlinks(canonicalPath, aliasPath, skip))) return;

      await expect(planCachePruneOnDisk(cacheDir, [canonicalName, aliasName], INVENTORY_KEEP)).rejects.toThrow(
        /ambiguous path spelling/i
      );
      expect(await fs.readFile(canonicalPath, "utf8")).toBe("HARDLINK_SENTINEL");
      expect(await fs.readFile(aliasPath, "utf8")).toBe("HARDLINK_SENTINEL");
    }
  );

  it.for([{ platform: "win32" }])(
    "equivalent-case HNSW erasure removes the complete stable/generation/temp family on $platform",
    async (_fixture, { skip }) => {
      if (process.platform !== "win32") {
        skip("Windows case-equivalence control");
        return;
      }
      const configuredBase = path.join(cacheDir, "custom.hnsw");
      const actualBase = path.join(cacheDir, "CUSTOM.hnsw");
      const generation = `${actualBase}.${"D".repeat(48)}.BIN`;
      const paths = [
        `${actualBase}.bin`,
        `${actualBase}.meta.json`,
        generation,
        `${actualBase}.meta.json.enquire-tmp-${"e".repeat(48)}`
      ];
      for (const artifact of paths) await fs.writeFile(artifact, "SENSITIVE_WINDOWS_ARTIFACT", { mode: 0o600 });
      const stage = `${generation}.enquire-stage-${"a".repeat(48)}`;
      await fs.mkdir(stage, { mode: 0o700 });
      await fs.writeFile(path.join(stage, "artifact"), "SENSITIVE_WINDOWS_ARTIFACT", { mode: 0o600 });

      expect(await clearHnswPersistedArtifacts(configuredBase)).toBe(true);
      for (const artifact of [...paths, stage]) {
        await expect(fs.lstat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
      }
    }
  );

  it.for([{ family: "uppercase HNSW token/extension alias" }])(
    "case-sensitive distinct $family refuses before deleting either entry",
    async (_fixture, { skip }) => {
      const configuredBase = path.join(cacheDir, "strict.hnsw");
      const canonical = `${configuredBase}.${"a".repeat(48)}.bin`;
      const alias = `${path.join(cacheDir, "STRICT.hnsw")}.${"A".repeat(48)}.BIN`;
      await fs.writeFile(canonical, "CANONICAL_GENERATION", { flag: "wx", mode: 0o600 });
      try {
        await fs.writeFile(alias, "DISTINCT_ALIAS_GENERATION", { flag: "wx", mode: 0o600 });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          skip("temporary filesystem collapses equivalent-case spellings");
          return;
        }
        throw err;
      }

      await expect(clearHnswPersistedArtifacts(configuredBase)).rejects.toThrow(/ambiguous path spelling/i);
      expect(await fs.readFile(canonical, "utf8")).toBe("CANONICAL_GENERATION");
      expect(await fs.readFile(alias, "utf8")).toBe("DISTINCT_ALIAS_GENERATION");
    }
  );

  it.for([{ platform: "darwin", equivalence: "NFC/NFD" }])(
    "$platform erases one generated temp through an equivalent $equivalence final spelling",
    async (_fixture, { skip }) => {
      if (process.platform !== "darwin") {
        skip("native macOS normalization-equivalence control");
        return;
      }
      const nfcBase = "Caf\u00e9.json";
      const nfdBase = nfcBase.normalize("NFD");
      const suffix = `.enquire-tmp-${"9".repeat(48)}`;
      const actualEntry = path.join(cacheDir, `${nfcBase}${suffix}`);
      const equivalentEntry = path.join(cacheDir, `${nfdBase}${suffix}`);
      await fs.writeFile(actualEntry, "NORMALIZATION_SENTINEL", { flag: "wx", mode: 0o600 });
      try {
        const [actualReal, equivalentReal] = await Promise.all([
          fs.realpath(actualEntry),
          fs.realpath(equivalentEntry)
        ]);
        if (actualReal !== equivalentReal) {
          skip("temporary filesystem does not collapse NFC/NFD spellings to one entry");
          return;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          skip("temporary filesystem is normalization-sensitive");
          return;
        }
        throw err;
      }

      expect(await removeSensitiveArtifactTemps(path.join(cacheDir, nfdBase))).toBe(1);
      await expect(fs.lstat(actualEntry)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it.for([{ platform: "darwin", equivalence: "case/NFC/NFD" }])(
    "$platform erases an HNSW generation whose newline-containing custom base uses a native $equivalence alias",
    async (_fixture, { skip }) => {
      if (process.platform !== "darwin") {
        skip("native macOS newline/normalization-equivalence control");
        return;
      }
      const actualBaseName = "Caf\u00e9\nCustom.hnsw";
      const configuredBaseName = actualBaseName.normalize("NFD").toLowerCase();
      const actualGeneration = path.join(cacheDir, `${actualBaseName}.${"B".repeat(48)}.BIN`);
      const configuredGeneration = path.join(cacheDir, `${configuredBaseName}.${"b".repeat(48)}.bin`);
      try {
        await fs.writeFile(actualGeneration, "NEWLINE_HNSW_ALIAS_SENTINEL", { flag: "wx", mode: 0o600 });
        const [actualStat, configuredStat] = await Promise.all([
          fs.lstat(actualGeneration, { bigint: true }),
          fs.lstat(configuredGeneration, { bigint: true })
        ]);
        if (actualStat.dev !== configuredStat.dev || actualStat.ino !== configuredStat.ino) {
          skip("temporary filesystem does not collapse the requested HNSW spelling aliases");
          return;
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (["ENOENT", "EINVAL"].includes(code ?? "")) {
          skip(`temporary filesystem lacks newline/case/normalization equivalence (${code ?? "unknown"})`);
          return;
        }
        throw err;
      }

      await expect(clearHnswPersistedArtifacts(path.join(cacheDir, configuredBaseName))).resolves.toBe(true);
      await expect(fs.lstat(actualGeneration)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  // NEGATIVE control: an "incomplete eraser" that mimics the pre-rc.36 behavior
  // (unlink only the main file) MUST leave the .tmp behind — proving the leak
  // scenario is real and the positive test above genuinely discriminates.
  it("NEGATIVE control — an eraser that skips legacy/generated leftovers leaves raw text on disk", async () => {
    await fs.writeFile(cacheFile, "{}", { mode: 0o600 });
    await fs.writeFile(`${cacheFile}.tmp`, "SENSITIVE_VAULT_BODY_XYZ", { mode: 0o600 });
    const generatedTmp = `${cacheFile}.enquire-tmp-${"d".repeat(48)}`;
    const generatedStage = `${cacheFile}.enquire-stage-${"e".repeat(48)}`;
    await fs.writeFile(generatedTmp, "SENSITIVE_VAULT_BODY_XYZ", { mode: 0o600 });
    await fs.mkdir(generatedStage, { mode: 0o700 });
    await fs.writeFile(path.join(generatedStage, "artifact"), "SENSITIVE_VAULT_BODY_XYZ", { mode: 0o600 });
    await fs.unlink(cacheFile); // the buggy pre-fix eraser: main file only
    const tmpStillThere = await fs
      .stat(`${cacheFile}.tmp`)
      .then(() => true)
      .catch(() => false);
    expect(tmpStillThere).toBe(true); // exactly the gap rc.36 F-2 closes
    expect((await fs.lstat(generatedTmp)).isFile()).toBe(true);
    expect((await fs.lstat(generatedStage)).isDirectory()).toBe(true);
  });

  describe("runtime sensitive publishers are routed to matching erasers", () => {
    it.for(WINDOWS_PERSISTENCE_VALID_PATHS)(
      "Windows $namespace admission accepts a $boundary before filesystem I/O",
      ({ admit, file }, { skip }) => {
        if (process.platform !== "win32") {
          skip("native Windows persistence-path admission control");
          return;
        }
        expectPersistenceAdmissionBeforeFilesystem(admit, file);
      }
    );

    it.for(WINDOWS_PERSISTENCE_REJECTIONS)(
      "Windows $namespace admission rejects a $hazard before filesystem I/O",
      ({ admit, file, error }, { skip }) => {
        if (process.platform !== "win32") {
          skip("native Windows persistence-path rejection control");
          return;
        }
        expectPersistenceAdmissionBeforeFilesystem(admit, file, error);
      }
    );

    it.each(PERSISTENCE_NAMESPACE_MATRIX)(
      "$namespace admission treats $artifact as accepted=$accepted",
      ({ admit, file, accepted }) => {
        if (accepted) {
          expect(() => admit(file)).not.toThrow();
        } else {
          expect(() => admit(file)).toThrow(TypeError);
        }
      }
    );

    it.each(["live source"])("writer ⊆ eraser inventory accepts %s", () => {
      expect(publisherInventoryProblems()).toEqual([]);
    });

    it.each(["saveDiskCacheOnce"])("%s snapshots cache membership synchronously before its first await", () => {
      const vaultFile = "src/vault.ts";
      const source = readFileSync(path.join(repoRoot, vaultFile), "utf8");
      expect(cacheSnapshotProblems(source)).toEqual([]);
      const mutant = replaceExactly(
        source,
        "const cacheSnapshot = [...this.cache];",
        "const cacheSnapshot = await Promise.resolve([...this.cache]);"
      );
      expect(cacheSnapshotProblems(mutant)).not.toEqual([]);
    });

    it.each(["7 disk opens plus 2 in-memory dependency probes"])(
      "SQLite family-preflight census accepts exactly %s",
      () => {
        expect(sqliteNativeOpenProblems()).toEqual([]);
      }
    );

    it.each(SQLITE_NATIVE_OPEN_ROUTES)(
      "SQLite census rejects $id when its constructor-adjacent preflight is removed",
      (route) => {
        const source = readFileSync(path.join(repoRoot, route.file), "utf8");
        const bodies = runtimeMemberBodies(source, route.file, route.member);
        expect(bodies).toHaveLength(1);
        const body = bodies[0] ?? "";
        const preflightNeedle = `preflightSqliteArtifactFamily(${route.fileArgument})`;
        const lastPreflight = body.lastIndexOf(preflightNeedle);
        expect(lastPreflight).toBeGreaterThanOrEqual(0);
        const mutantBody =
          body.slice(0, lastPreflight) +
          "Promise.resolve(true)" +
          body.slice(lastPreflight + preflightNeedle.length);
        const mutantSource = replaceExactly(source, body, mutantBody);
        const problems = sqliteNativeOpenProblems(new Map([[route.file, mutantSource]]));
        expect(problems.some((problem) => problem.startsWith(`${route.id}:`))).toBe(true);
      }
    );

    it.each(PUBLISHER_INVENTORY_MUTANTS)(
      "inventory rejects $id when its $role route $file#$member is removed",
      ({ id, role, file, member, needle }) => {
        const source = readFileSync(path.join(repoRoot, file), "utf8");
        const bodies = runtimeMemberBodies(source, file, member);
        expect(bodies).toHaveLength(1);
        const body = bodies[0] ?? "";
        const replacement = needle.replace(
          /[A-Za-z_$][A-Za-z0-9_$]*(?=[^A-Za-z0-9_$]*$)/,
          "__erasure_mutant__"
        );
        const mutantBody = replaceAllExactly(body, needle, replacement, needle === "`${file}.tmp`" ? 2 : 1);
        expect(mutantBody).not.toContain(needle);
        const mutated = replaceExactly(source, body, mutantBody);
        expect(publisherInventoryProblems(new Map([[file, mutated]]))).toContain(
          `${id}:${role}:${file}#${member} missing ${needle}`
        );
      }
    );

    it.each(["await planCachePruneOnDisk(cacheDir, entries, keepHash)"])(
      "CLI prune routes destructive selection through %s",
      (route) => {
        const cliSource = readFileSync(path.join(repoRoot, "src/cli.ts"), "utf8");
        expect(cliSource).toContain(route);
        expect(replaceExactly(cliSource, route, "await planCachePrune(entries, keepHash)")).not.toContain(route);
      }
    );

    it.each(["hnsw.bin"])("CLI prune help names the erasable legacy %s family", (legacySuffix) => {
      const cliSource = readFileSync(path.join(repoRoot, "src/cli.ts"), "utf8");
      const claim = `<hash>.{json,fts5.db,embed.db,${legacySuffix},hnsw.meta.json,feedback.json}`;
      expect(cliSource).toContain(claim);
      expect(replaceExactly(cliSource, claim, claim.replace(`${legacySuffix},`, ""))).not.toContain(claim);
    });
  });

  // ── Structural: writers ⊆ erasers — every eraser references all its suffixes ──
  describe("erasure manifest — each eraser references every artifact suffix", () => {
    for (const m of ERASURE_MANIFEST) {
      it(`${m.eraser} in ${m.file} erases all suffixes of [${m.family}]`, () => {
        const src = readFileSync(path.join(repoRoot, m.file), "utf8");
        const body = extractMethod(src, m.eraser);
        expect(body, `${m.eraser} not found in ${m.file}`).not.toBe("");
        expect(
          missingErasureTokens(body, m.requiredTokens),
          `${m.file}#${m.eraser} is missing an erasure route`
        ).toEqual([]);
        const routes = "routeMembers" in m ? m.routeMembers : [];
        for (const route of routes) {
          const routeSource = readFileSync(path.join(repoRoot, route.file), "utf8");
          const routeBodies = runtimeMemberBodies(routeSource, route.file, route.member);
          expect(routeBodies, `${route.file}#${route.member} must resolve exactly once`).toHaveLength(1);
          expect(
            missingErasureTokens(routeBodies[0] ?? "", route.requiredTokens),
            `${route.file}#${route.member} is missing a delegated family token`
          ).toEqual([]);
        }
      });
    }

    // NEGATIVE control: the manifest checker must FLAG an eraser that drops a
    // suffix — otherwise the positive assertions above could pass vacuously.
    it("NEGATIVE control — manifest checker flags an eraser missing a suffix", () => {
      const buggy = 'async clearOnDisk() { await fs.unlink(this.file); await fs.unlink(this.file + "-wal"); }';
      const missing = missingErasureTokens(buggy, ["-wal", "-shm", ".hnsw", ".bin", ".meta.json"]);
      expect(missing).toContain(".meta.json"); // the rc.34 P-2 leak suffix
      expect(missing).toContain("-shm");
    });

    // NEGATIVE control: extractMethod must isolate the method body (so a token in
    // a DIFFERENT method can't satisfy the check by accident).
    it("NEGATIVE control — extractMethod stops at the method's own 2-space closer", () => {
      const src =
        '  async clearOnDisk() {\n    for (const p of t) {\n      go();\n    }\n  }\n  async other() {\n    leak(".meta.json");\n  }';
      const body = extractMethod(src, "clearOnDisk");
      expect(body).toContain("for (const p of t)");
      expect(body).not.toContain(".meta.json"); // belongs to other(), not clearOnDisk()
    });
  });

  // ── v3.10.0-rc.37 (audit #4): the CROSS-VAULT eraser (`prune` → planCachePrune)
  // must cover every cross-vault-erasable writer family too — not just the per-vault `clear-*`
  // erasers above. The #3 leak (a decommissioned vault's `<hash>.json` parse cache,
  // holding full note bodies, survived `prune` forever) shipped precisely because
  // THIS eraser surface was unpatrolled. Assert prune selects each erasable family
  // for an OTHER vault. Watcher activation guards are intentionally absent: only
  // exact-vault clear-embeddings recovery may remove that safety interlock. ──
  describe("prune covers every cross-vault-erasable writer family (rc.37 #4)", () => {
    const KEEP = "aaaaaaaaaaaa";
    const OTHER = "bbbbbbbbbbbb";
    // One representative basename per on-disk family a writer can produce.
    const WRITER_FAMILIES: Record<string, string> = {
      "parse cache (full note bodies)": `${OTHER}.json`,
      "parse cache atomic-write temp": `${OTHER}.json.tmp`,
      "parse cache generated temp": `${OTHER}.json.enquire-tmp-${TOKEN_48}`,
      "parse cache generated stage": `${OTHER}.json.enquire-stage-${TOKEN_48}`,
      "FTS5 index": `${OTHER}.fts5.db`,
      "FTS5 WAL sidecar": `${OTHER}.fts5.db-wal`,
      "FTS5 SHM sidecar": `${OTHER}.fts5.db-shm`,
      "FTS5 rollback journal": `${OTHER}.fts5.db-journal`,
      "embed-db": `${OTHER}.embed.db`,
      "embed-db WAL sidecar": `${OTHER}.embed.db-wal`,
      "embed-db SHM sidecar": `${OTHER}.embed.db-shm`,
      "embed-db rollback journal": `${OTHER}.embed.db-journal`,
      "HNSW legacy fixed index": `${OTHER}.hnsw.bin`,
      "HNSW immutable generation": `${OTHER}.hnsw.${TOKEN_48}.bin`,
      "HNSW generated stage": `${OTHER}.hnsw.${TOKEN_48}.bin.enquire-stage-${TOKEN_48}`,
      "HNSW meta pointer (raw text_preview)": `${OTHER}.hnsw.meta.json`,
      "HNSW meta generated temp": `${OTHER}.hnsw.meta.json.enquire-tmp-${TOKEN_48}`,
      // v3.11.0 — the closed-loop feedback store (relative note paths + usefulness
      // counts). Right-to-erasure: a decommissioned vault's feedback must not survive
      // prune. + its atomic-write .tmp leftover.
      "feedback store (paths + counts)": `${OTHER}.feedback.json`,
      "feedback store atomic-write temp": `${OTHER}.feedback.json.tmp`,
      "feedback store generated temp": `${OTHER}.feedback.json.enquire-tmp-${TOKEN_48}`,
      "feedback store generated stage": `${OTHER}.feedback.json.enquire-stage-${TOKEN_48}`
    };
    for (const [family, name] of Object.entries(WRITER_FAMILIES)) {
      it(`prune selects the ${family} of OTHER vaults (${name})`, () => {
        expect(planCachePrune([name, `${KEEP}.fts5.db`], KEEP)).toContain(name);
      });
    }
    // NEGATIVE control: a whitelist that OMITS the `.json` family (the literal
    // pre-rc.37 bug) must FAIL to select the parse cache — proving the coverage
    // assertions above genuinely discriminate (not vacuously true for any regex).
    it("NEGATIVE control — a whitelist missing the `.json` family leaves the parse cache (the #3 leak)", () => {
      const PRE_RC37 = /^[0-9a-f]{12}\.(fts5\.db|embed\.db|hnsw\.bin|hnsw\.meta\.json)(-wal|-shm)?$/;
      const buggyPrune = (entries: string[], keep: string) =>
        entries.filter((e) => PRE_RC37.test(e) && !e.startsWith(`${keep}.`));
      expect(buggyPrune([`${OTHER}.json`], KEEP)).toEqual([]); // leak: parse cache survives prune
      expect(planCachePrune([`${OTHER}.json`], KEEP)).toEqual([`${OTHER}.json`]); // rc.37: erased
      expect(planCachePrune([`${OTHER}.embed.db.watcher-activation.guard`], KEEP)).toEqual([]);
    });
  });

  // ── v3.10.0-rc.20 (audit M7): the HNSW persist BASE is derived by ONE shared
  // helper (`hnswPersistBase`) so the WRITER (server.ts `persistFile` → saveTo)
  // and the ERASER (`EmbedDb.clearOnDisk`) can't drift. A base drift (vs the
  // suffix drift the manifest above guards) would leave the `.hnsw.*` sidecars —
  // which carry raw `text_preview` — on disk after `clear-embeddings`: the rc.34
  // P-2 right-to-erasure gap, reintroduced through a different seam. ──
  describe("HNSW persist base shared between writer + eraser (rc.20 M7)", () => {
    const embedDbSrc = readFileSync(path.join(repoRoot, "src/embed-db.ts"), "utf8");
    const serverSrc = readFileSync(path.join(repoRoot, "src/server.ts"), "utf8");
    // The pre-rc.20 inline shape: `${x.replace(/\.embed\.db$/, "")}.hnsw`.
    const INLINE_BASE = /\.replace\(\/\\\.embed\\\.db\$\/[^)]*\)\}\.hnsw/;

    it("hnswPersistBase admits exact .embed.db names and maps distinct stems injectively", () => {
      expect(hnswPersistBase("/c/x.embed.db")).toBe("/c/x.hnsw");
      expect(hnswPersistBase("/cache/abc12.embed.db")).toBe("/cache/abc12.hnsw");
      expect(hnswPersistBase("/c/x2.embed.db")).toBe("/c/x2.hnsw");
      expect(hnswPersistBase("/c/Foo.embed.db")).toBe("/c/Foo.hnsw");
      expect(hnswPersistBase("/c/x.embed.db")).not.toBe(hnswPersistBase("/c/x2.embed.db"));
    });

    it("the eraser (clearOnDisk) and the writer (server.ts) both route through hnswPersistBase", () => {
      expect(extractMethod(embedDbSrc, "clearOnDisk")).toContain("hnswPersistBase(");
      expect(serverSrc, "server.ts writer must use hnswPersistBase").toContain("hnswPersistBase(");
      // …and the writer must NOT recompute the base inline (the drift this closes).
      expect(INLINE_BASE.test(serverSrc), "server.ts still recomputes the HNSW base inline").toBe(false);
    });

    it("v3.10.0-rc.37 (#8) — server.ts erases the stale HNSW sidecars when the embed-db is empty", () => {
      // An emptied embed-db builds no index → no `saveTo` to replace stale
      // generations/pointer. The empty branch must delegate the complete family
      // (legacy fixed binary, pointer, immutable generations, publisher temps)
      // to the same HNSW eraser used by clear-embeddings.
      expect(
        emptyHnswRowsBranch(serverSrc),
        "empty-embed-db branch must route through the complete HNSW eraser"
      ).toContain("clearHnswPersistedArtifacts(persistFile)");
    });

    it.each(["clearHnswPersistedArtifacts(persistFile)"])(
      "empty-HNSW branch detector rejects removal of %s",
      (route) => {
        const mutated = replaceExactly(serverSrc, route, "disabledClearHnswPersistedArtifacts(persistFile)");
        expect(emptyHnswRowsBranch(mutated)).not.toContain(route);
      }
    );

    // NEGATIVE control — the inline-base detector must FLAG the pre-rc.20 shape
    // (so the writer assertion above isn't vacuously true).
    it("NEGATIVE control — the inline-base detector flags a pre-rc.20 recomputation", () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture intentionally holds a literal ${...} representing the pre-rc.20 inline source shape
      const old = 'const persistFile = `${embedFile.replace(/\\.embed\\.db$/, "")}.hnsw`;';
      expect(INLINE_BASE.test(old)).toBe(true);
      expect(old.includes("hnswPersistBase(")).toBe(false);
    });
  });
});
