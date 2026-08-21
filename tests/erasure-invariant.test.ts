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

import { promises as fs, readdirSync, readFileSync } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hnswPersistBase } from "../src/embed-db.js";
import { planCachePrune, planCachePruneOnDisk } from "../src/fts5.js";
import { clearHnswPersistedArtifacts, isHnswGenerationBasename } from "../src/hnsw.js";
import { acquirePersistenceFamilyLease } from "../src/persistence-coordination.js";
import {
  assertCacheFilePath,
  assertEmbedDbFilePath,
  assertFeedbackFilePath,
  assertFtsIndexFilePath,
  assertHnswFilePath
} from "../src/persistence-path.js";
import { SEMANTIC_PERSISTENCE_FAMILY_KEY } from "../src/semantic-persistence.js";
import {
  preflightSqliteArtifactFamily,
  publishSensitiveArtifact,
  readSensitiveArtifactText,
  removeSensitiveArtifactTemps,
  sensitiveArtifactFinalBasename,
  sha256SensitiveArtifact
} from "../src/sensitive-artifact.js";
import { Vault } from "../src/vault.js";
import { replaceExactly } from "./helpers/exact-source-mutation.js";

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

const WINDOWS_PERSISTENCE_REJECTIONS = PERSISTENCE_NAMESPACE_ADMITTERS.flatMap(({ namespace, admit, suffix }) =>
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
      hazard: "DOS device basename with an ignored trailing space",
      file: `C:\\Enquire\\CON ${suffix}`,
      error: /reserved Windows device basename/
    },
    {
      hazard: "numbered DOS device basename with an ignored trailing space",
      file: `C:\\Enquire\\COM1 ${suffix}`,
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
    requiredTokens: ["-wal", "-shm", "-journal", "hnswPersistBase(", "clearHnswPersistedArtifactsWithEraser("],
    routeMembers: [
      {
        file: "src/hnsw.ts",
        member: "clearHnswPersistedArtifactsWithEraser",
        requiredTokens: [
          "scopesFromActiveSemanticEraser(capability)",
          "clearHnswPersistedArtifactsUnchecked(canonicalFile)"
        ]
      },
      {
        file: "src/hnsw.ts",
        member: "clearHnswPersistedArtifactsUnchecked",
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
    eraser: "clearDiskCacheOperation",
    requiredTokens: ["clearDiskCacheCoordinated("],
    routeMembers: [
      {
        file: "src/vault.ts",
        member: "clearDiskCacheCoordinated",
        requiredTokens: [
          "acquirePersistenceEraser(request.requestedFile)",
          "clearDiskCacheOnce({ file })",
          "releasePersistenceHandle(eraser)"
        ]
      },
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
  needleOccurrences?: Readonly<Record<string, number>>;
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
const LEGACY_CACHE_TEMP_SOURCE_NEEDLE = "\x60\x24{file}.tmp\x60";
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
    member: "openOnce",
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
    member: "openOnce",
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
        "private async saveDiskCacheOnce(request: DiskCacheSaveRequest)",
        "const { requestedFile, publishedEpoch, cacheSnapshot } = request;",
        "const file = target.canonicalFile;",
        "for (const { abs, source } of cacheSnapshot)",
        "this.cache.get(abs) === source",
        "publishSensitiveArtifact(file, serialized, this.maxDiskCacheBytes)"
      ]
    },
    eraserRoutes: [
      {
        file: "src/vault.ts",
        member: "clearDiskCacheOperation",
        needles: [
          "this.cache = new Map();",
          "this.cacheGeneration += 1;",
          "const request: DiskCacheClearRequest = { requestedFile: file };",
          "this.pendingCacheClears.set(file, { request, promise: clear });",
          "this.clearDiskCacheCoordinated(request)"
        ]
      },
      {
        file: "src/vault.ts",
        member: "clearDiskCacheCoordinated",
        needles: [
          "acquirePersistenceEraser(request.requestedFile)",
          "clearDiskCacheOnce({ file })",
          "releasePersistenceHandle(eraser)"
        ]
      },
      {
        file: "src/vault.ts",
        member: "clearDiskCacheOnce",
        needles: [
          "private async clearDiskCacheOnce(request: DiskCachePhysicalClearRequest)",
          "preflightSensitiveArtifactTemps(file)",
          LEGACY_CACHE_TEMP_SOURCE_NEEDLE,
          "removeSensitiveArtifactTemps(file)"
        ],
        needleOccurrences: { [LEGACY_CACHE_TEMP_SOURCE_NEEDLE]: 2 }
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
      needles: ["publishSensitiveArtifact(this.file, serialized, MAX_FEEDBACK_FILE_BYTES)"]
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
      publisherNeedle: "const binary = await publishSensitiveArtifact(",
      pruneProbe: `${INVENTORY_OTHER}.hnsw.${TOKEN_48}.bin.enquire-stage-${TOKEN_48}`
    },
    {
      id: "hnsw-metadata-pointer",
      publisherNeedle: "publishSensitiveArtifact(metaFile, serializedMeta, MAX_HNSW_META_BYTES)",
      pruneProbe: `${INVENTORY_OTHER}.hnsw.meta.json.enquire-tmp-${TOKEN_48}`
    }
  ].map(({ id, publisherNeedle, pruneProbe }) => ({
    id,
    publisher: { file: "src/hnsw.ts", member: "saveTo", needles: [publisherNeedle] },
    eraserRoutes: [
      {
        file: "src/hnsw.ts",
        member: "clearHnswPersistedArtifactsWithEraser",
        needles: ["scopesFromActiveSemanticEraser(capability)", "clearHnswPersistedArtifactsUnchecked(canonicalFile)"]
      },
      {
        file: "src/hnsw.ts",
        member: "clearHnswPersistedArtifactsUnchecked",
        needles: ["const plan = await planHnswErasure(file);", "removeSensitiveArtifactTempEntry(entry.entryPath)"]
      },
      {
        file: "src/hnsw.ts",
        member: "planHnswErasure",
        needles: ["sensitiveArtifactFinalBasename(entry)", "expectedHnswBasename(file, ownedFinal, legacyBin, meta)"]
      },
      {
        file: "src/embed-db.ts",
        member: "clearOnDisk",
        needles: ["clearHnswPersistedArtifactsWithEraser(hnswBase, eraserCapability)"]
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

interface SensitiveReaderInventoryEntry {
  id: string;
  file: string;
  member: string;
  calls: number;
  exactCall: string;
  directArgument: string;
}

const SENSITIVE_READER_INVENTORY: readonly SensitiveReaderInventoryEntry[] = [
  {
    id: "parse-cache load",
    file: "src/vault.ts",
    member: "loadDiskCacheOnce",
    calls: 1,
    exactCall: "readSensitiveArtifactText(file, this.maxDiskCacheBytes)",
    directArgument: "file"
  },
  {
    id: "feedback load",
    file: "src/feedback.ts",
    member: "loadFeedbackData",
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
];

type SensitiveArtifactHelperName =
  | "inspectSensitiveArtifact"
  | "publishSensitiveArtifact"
  | "readSensitiveArtifactText"
  | "sha256SensitiveArtifact";

interface SensitiveHelperInventoryEntry {
  helper: SensitiveArtifactHelperName;
  file: string;
  member: string;
  calls: number;
}

// This is deliberately a census of calls routed through the shared sensitive-
// artifact helpers, not a claim that every raw `fs` sink in production has been
// classified. The raw-filesystem surface has different semantics and needs its
// own inventory rather than being smuggled into this narrower invariant.
const HNSW_SENSITIVE_HELPER_INVENTORY: readonly SensitiveHelperInventoryEntry[] = [
  {
    helper: "inspectSensitiveArtifact",
    file: "src/hnsw.ts",
    member: "preflightHnswNativeGeneration",
    calls: 1
  },
  {
    helper: "inspectSensitiveArtifact",
    file: "src/hnsw.ts",
    member: "readHnswMetaPointer",
    calls: 1
  },
  {
    helper: "sha256SensitiveArtifact",
    file: "src/hnsw.ts",
    member: "loadHnswFromDisk",
    calls: 2
  }
];

function runtimeMemberBodies(source: string, file: string, member: string): string[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bodies: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.name?.getText(sourceFile) === member &&
      node.body
    ) {
      bodies.push(node.getText(sourceFile));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bodies;
}

/** Mutate one exact runtime member without letting a same-text needle in an
 * unrelated method silently redirect a causal negative control. */
function replaceRuntimeMemberExactly(
  source: string,
  file: string,
  member: string,
  needle: string,
  replacement: string
): string {
  const bodies = runtimeMemberBodies(source, file, member);
  if (bodies.length !== 1) throw new Error(`${file}#${member}: expected one runtime member, found ${bodies.length}`);
  const body = bodies[0] ?? "";
  return replaceExactly(source, body, replaceExactly(body, needle, replacement));
}

interface ProductionTypeScriptSource {
  file: string;
  source: string;
}

function productionTypeScriptSources(overrides: ReadonlyMap<string, string> = new Map()): ProductionTypeScriptSource[] {
  const sources: ProductionTypeScriptSource[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        const file = path.relative(repoRoot, full).replace(/\\/gu, "/");
        sources.push({ file, source: overrides.get(file) ?? readFileSync(full, "utf8") });
      }
    }
  };
  walk(path.join(repoRoot, "src"));
  return sources.sort((left, right) => left.file.localeCompare(right.file));
}

function sensitiveArtifactHelperCallSites(overrides: ReadonlyMap<string, string> = new Map()): {
  sites: string[];
  violations: string[];
} {
  const sites: string[] = [];
  const violations: string[] = [];
  const helperNames = new Set<SensitiveArtifactHelperName>([
    "inspectSensitiveArtifact",
    "publishSensitiveArtifact",
    "readSensitiveArtifactText",
    "sha256SensitiveArtifact"
  ]);
  for (const { file, source } of productionTypeScriptSources(overrides)) {
    if (file === "src/sensitive-artifact.ts") continue;
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const importedHelpers = new Set<string>();
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      if (statement.moduleSpecifier.text !== "./sensitive-artifact.js") continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || ts.isNamespaceImport(bindings)) {
        violations.push(`${file}: sensitive-artifact helpers must use canonical named imports`);
        continue;
      }
      for (const specifier of bindings.elements) {
        const exportedName = specifier.propertyName?.text ?? specifier.name.text;
        if (!helperNames.has(exportedName)) continue;
        if (specifier.name.text !== exportedName) {
          violations.push(`${file}: ${exportedName} must not be imported through alias ${specifier.name.text}`);
          continue;
        }
        importedHelpers.add(exportedName);
      }
    }
    const visit = (node: ts.Node, containingMember: string): void => {
      let member = containingMember;
      if (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) {
        member = node.name?.getText(sourceFile) ?? "<anonymous>";
      } else if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) {
        member = node.name.getText(sourceFile);
      }
      if (ts.isIdentifier(node) && helperNames.has(node.text) && !ts.isImportSpecifier(node.parent)) {
        if (!importedHelpers.has(node.text)) {
          violations.push(`${file}#${member}: ${node.text} is not bound by its canonical named import`);
        } else if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
          sites.push(`${node.text}:${file}#${member}`);
        } else {
          violations.push(`${file}#${member}: ${node.text} escapes a direct helper call`);
        }
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        helperNames.has(node.name.text) &&
        ts.isCallExpression(node.parent) &&
        node.parent.expression === node
      ) {
        violations.push(`${file}#${member}: ${node.name.text} is called through a property alias`);
      }
      ts.forEachChild(node, (child) => visit(child, member));
    };
    visit(sourceFile, "<module>");
  }
  return { sites: sites.sort(), violations: violations.sort() };
}

function sensitiveArtifactHelperCensusProblems(overrides: ReadonlyMap<string, string> = new Map()): string[] {
  const expected = [
    ...SENSITIVE_PUBLISHER_INVENTORY.map(
      ({ publisher }) => `publishSensitiveArtifact:${publisher.file}#${publisher.member}`
    ),
    ...SENSITIVE_READER_INVENTORY.flatMap(({ file, member, calls }) =>
      Array.from({ length: calls }, () => `readSensitiveArtifactText:${file}#${member}`)
    ),
    ...HNSW_SENSITIVE_HELPER_INVENTORY.flatMap(({ helper, file, member, calls }) =>
      Array.from({ length: calls }, () => `${helper}:${file}#${member}`)
    )
  ].sort();
  const { sites: actual, violations } = sensitiveArtifactHelperCallSites(overrides);
  const expectedCounts = new Map<string, number>();
  const actualCounts = new Map<string, number>();
  for (const site of expected) expectedCounts.set(site, (expectedCounts.get(site) ?? 0) + 1);
  for (const site of actual) actualCounts.set(site, (actualCounts.get(site) ?? 0) + 1);
  const problems: string[] = [...violations];
  for (const site of new Set([...expectedCounts.keys(), ...actualCounts.keys()])) {
    const expectedCount = expectedCounts.get(site) ?? 0;
    const actualCount = actualCounts.get(site) ?? 0;
    if (expectedCount !== actualCount) {
      problems.push(`${site}: inventory expected ${expectedCount}, production has ${actualCount}`);
    }
  }
  return problems.sort();
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

type RuntimeMemberNode = ts.FunctionDeclaration | ts.MethodDeclaration;

function runtimeMemberNodes(
  source: string,
  file: string,
  member: string
): {
  sourceFile: ts.SourceFile;
  nodes: RuntimeMemberNode[];
} {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const nodes: RuntimeMemberNode[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name?.getText(sourceFile) === member &&
      node.body
    ) {
      nodes.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { sourceFile, nodes };
}

function callExpressions(root: ts.Node): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return calls;
}

function ifStatements(root: ts.Node): ts.IfStatement[] {
  const statements: ts.IfStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) statements.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return statements;
}

function variableDeclarations(root: ts.Node, sourceFile: ts.SourceFile, name: string): ts.VariableDeclaration[] {
  const declarations: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(sourceFile) === name) declarations.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return declarations;
}

function objectPropertyValue(
  object: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
  name: string
): ts.Expression | undefined {
  const matches = object.properties.filter(
    (property) =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      property.name.getText(sourceFile) === name
  );
  if (matches.length !== 1) return undefined;
  const property = matches[0];
  if (ts.isPropertyAssignment(property)) return property.initializer;
  return ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
}

function isPropertyCall(call: ts.CallExpression, sourceFile: ts.SourceFile, owner: string, member: string): boolean {
  return (
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.expression.getText(sourceFile) === owner &&
    call.expression.name.text === member
  );
}

function branchGuards(
  node: ts.Node,
  sourceFile: ts.SourceFile
): Array<{ branch: "then" | "else"; expression: string }> {
  const guards: Array<{ branch: "then" | "else"; expression: string }> = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (!ts.isIfStatement(parent)) continue;
    if (
      node.getStart(sourceFile) >= parent.thenStatement.getStart(sourceFile) &&
      node.end <= parent.thenStatement.end
    ) {
      guards.push({ branch: "then", expression: parent.expression.getText(sourceFile) });
    } else if (
      parent.elseStatement &&
      node.getStart(sourceFile) >= parent.elseStatement.getStart(sourceFile) &&
      node.end <= parent.elseStatement.end
    ) {
      guards.push({ branch: "else", expression: parent.expression.getText(sourceFile) });
    }
  }
  return guards;
}

function hasBranchGuard(
  guards: readonly { branch: "then" | "else"; expression: string }[],
  branch: "then" | "else",
  expression: string
): boolean {
  return guards.some((guard) => guard.branch === branch && guard.expression === expression);
}

function hnswArtifactBoundaryProblems(source: string): string[] {
  const problems: string[] = [];
  const preflight = runtimeMemberNodes(source, "src/hnsw.ts", "preflightHnswNativeGeneration");
  if (preflight.nodes.length !== 1) {
    return [`expected one preflightHnswNativeGeneration implementation, found ${preflight.nodes.length}`];
  }
  const preflightBody = preflight.nodes[0]?.body;
  if (!preflightBody) return ["preflightHnswNativeGeneration body disappeared"];
  const inspectCalls = callExpressions(preflightBody).filter(
    (call) => call.expression.getText(preflight.sourceFile) === "inspectSensitiveArtifact"
  );
  if (inspectCalls.length !== 1) {
    problems.push(`HNSW preflight must use one held-descriptor inspector, found ${inspectCalls.length}`);
  } else {
    const inspectCall = inspectCalls[0];
    const callback = inspectCall?.arguments[2];
    if (
      inspectCall?.arguments[0]?.getText(preflight.sourceFile) !== "file" ||
      inspectCall.arguments[1]?.getText(preflight.sourceFile) !== "MAX_HNSW_GENERATION_BYTES"
    ) {
      problems.push("HNSW preflight must inspect its generation through the exact generation-byte cap");
    }
    if (
      !callback ||
      (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
      callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) !== true ||
      callback.parameters.map((parameter) => parameter.name.getText(preflight.sourceFile)).join(",") !==
        "handle,fileSize"
    ) {
      problems.push("HNSW preflight must parse through the inspector's held handle and stable size");
    } else {
      const heldReads = callExpressions(callback.body).filter(
        (call) => call.expression.getText(preflight.sourceFile) === "readHeldBytes"
      );
      if (
        heldReads.length < 3 ||
        heldReads.some((call) => call.arguments[0]?.getText(preflight.sourceFile) !== "handle")
      ) {
        problems.push("HNSW header, payload, and receipt hash must all read the inspector-held descriptor");
      }
      const cursorGuard = ifStatements(callback.body).find((statement) =>
        statement.expression.getText(preflight.sourceFile).includes("cursor !== fileSize")
      );
      const hashDeclarations = variableDeclarations(callback.body, preflight.sourceFile, "hash");
      const hashDeclaration = hashDeclarations[0];
      if (
        hashDeclarations.length !== 1 ||
        hashDeclaration?.initializer?.getText(preflight.sourceFile) !== 'createHash("sha256")' ||
        !cursorGuard ||
        hashDeclaration.getStart(preflight.sourceFile) <= cursorGuard.getStart(preflight.sourceFile)
      ) {
        problems.push(
          "HNSW held-descriptor digest must be computed only after the complete native payload is admitted"
        );
      }
      const snapshotPath = variableDeclarations(callback.body, preflight.sourceFile, "nativeSnapshotPath");
      const snapshotOpen = callExpressions(callback.body).filter(
        (call) => call.expression.getText(preflight.sourceFile) === "fs.open"
      );
      const admittedAssignments = callExpressions(callback.body).filter(
        (call) => call.expression.getText(preflight.sourceFile) === "removeHnswNativeSnapshot"
      );
      if (
        snapshotPath.length !== 1 ||
        snapshotPath[0]?.initializer?.getText(preflight.sourceFile) !==
          'path.join(nativeSnapshotDirectory, "artifact")' ||
        snapshotOpen.length !== 1 ||
        snapshotOpen[0]?.arguments.map((argument) => argument.getText(preflight.sourceFile)).join("|") !==
          'nativeSnapshotPath|"wx"|0o600' ||
        !cursorGuard ||
        (snapshotOpen[0]?.getStart(preflight.sourceFile) ?? -1) <= cursorGuard.getStart(preflight.sourceFile) ||
        admittedAssignments.length !== 1
      ) {
        problems.push(
          "HNSW preflight must copy fully-admitted held-descriptor bytes into one owned private artifact snapshot"
        );
      }
    }
  }
  const outerSnapshot = variableDeclarations(preflightBody, preflight.sourceFile, "admittedSnapshot");
  const outerCleanup = callExpressions(preflightBody).filter(
    (call) =>
      call.expression.getText(preflight.sourceFile) === "removeHnswNativeSnapshot" &&
      call.arguments[0]?.getText(preflight.sourceFile) === "admittedSnapshot"
  );
  if (
    outerSnapshot.length !== 1 ||
    outerSnapshot[0]?.initializer?.getText(preflight.sourceFile) !== "null" ||
    outerCleanup.length !== 1 ||
    !hasBranchGuard(branchGuards(outerCleanup[0] as ts.Node, preflight.sourceFile), "then", "admittedSnapshot")
  ) {
    problems.push("HNSW preflight must erase a private snapshot rejected by the inspector's final descriptor receipt");
  }

  const loader = runtimeMemberNodes(source, "src/hnsw.ts", "loadHnswFromDisk");
  if (loader.nodes.length !== 1) {
    problems.push(`expected one loadHnswFromDisk implementation, found ${loader.nodes.length}`);
    return problems;
  }
  const loaderBody = loader.nodes[0]?.body;
  if (!loaderBody) return [...problems, "loadHnswFromDisk body disappeared"];
  const loaderCalls = callExpressions(loaderBody);
  const callsNamed = (name: string): ts.CallExpression[] =>
    loaderCalls.filter((call) => call.expression.getText(loader.sourceFile) === name);
  const preflightCalls = callsNamed("preflightHnswNativeGeneration");
  const hashCalls = callsNamed("sha256SensitiveArtifact").sort(
    (left, right) => left.getStart(loader.sourceFile) - right.getStart(loader.sourceFile)
  );
  const nativeLoaderCalls = callsNamed("loadHnswlib");
  const nativeReadCalls = loaderCalls.filter((call) => call.expression.getText(loader.sourceFile) === "ctor.readIndex");
  if (
    preflightCalls.length !== 1 ||
    hashCalls.length !== 2 ||
    nativeLoaderCalls.length !== 1 ||
    nativeReadCalls.length !== 1
  ) {
    problems.push(
      "HNSW load must have one preflight, two bounded path receipts, one native import, and one native read"
    );
    return problems;
  }
  const preflightCall = preflightCalls[0];
  const beforeHash = hashCalls[0];
  const afterHash = hashCalls[1];
  const nativeLoader = nativeLoaderCalls[0];
  const nativeRead = nativeReadCalls[0];
  if (
    preflightCall?.arguments.map((argument) => argument.getText(loader.sourceFile)).join("|") !==
    "binFile|expectedDim|meta.size|admittedNativeElements|expectedLabels|expectedVectorsByLabel"
  ) {
    problems.push("HNSW native preflight must receive every independently trusted shape, label, and vector authority");
  }
  const preflightText = preflightBody.getText(preflight.sourceFile);
  for (const token of [
    "expectedVectorsByLabel.get(label)",
    "trustedValue / trustedNorm",
    "HNSW_DB_VECTOR_COMPONENT_TOLERANCE",
    "Math.sqrt(dbDistanceSquared) > HNSW_DB_VECTOR_L2_TOLERANCE"
  ]) {
    if (!preflightText.includes(token)) {
      problems.push(`HNSW native preflight must bind DB-canonical vector semantics via ${token}`);
    }
  }
  const loaderText = loaderBody.getText(loader.sourceFile);
  for (const token of [
    "expectedVectorsValue === undefined",
    "expectedVectorsByLabel.size !== declaredExpectedVectors",
    "!rowsByLabel.has(label)",
    "value.length !== expectedDim",
    "!Number.isFinite(vectorComponent)",
    "normSquared <= 0"
  ]) {
    if (!loaderText.includes(token)) {
      problems.push(`HNSW loader trusted-vector admission must enforce ${token}`);
    }
  }
  for (const token of [
    "admittedHeader.estimatedNativeAllocationBytes",
    "HNSW_COMBINED_NON_NATIVE_FIXED_HEADROOM_BYTES",
    "trustedVectorBytes * 3n",
    "BigInt(expectedActiveRows) * HNSW_TRUSTED_METADATA_PER_ROW_BYTES * 3n",
    "trustedRowTextBytes * 3n",
    "combinedWorkingSetBytes > MAX_HNSW_COMBINED_WORKING_SET_BYTES"
  ]) {
    if (!loaderText.includes(token)) {
      problems.push(`HNSW loader combined working-set envelope must include ${token}`);
    }
  }
  const hnswCombinedCaps = variableDeclarations(
    loader.sourceFile,
    loader.sourceFile,
    "MAX_HNSW_COMBINED_WORKING_SET_BYTES"
  );
  if (
    hnswCombinedCaps.length !== 1 ||
    hnswCombinedCaps[0]?.initializer?.getText(loader.sourceFile) !== "1024n * 1024n * 1024n"
  ) {
    problems.push("HNSW native loader combined working-set cap must remain exactly 1 GiB");
  }
  if (
    hashCalls.some(
      (call) =>
        call.arguments[0]?.getText(loader.sourceFile) !== "binFile" ||
        call.arguments[1]?.getText(loader.sourceFile) !== "MAX_HNSW_GENERATION_BYTES"
    )
  ) {
    problems.push("both pre/post-native HNSW path hashes must use the exact generation-byte cap");
  }
  const digestGuards = ifStatements(loaderBody).filter(
    (statement) =>
      statement.expression.getText(loader.sourceFile) ===
      "digestBefore !== admittedHeader.sha256 || digestBefore !== meta.binSha256"
  );
  const cleanupCalls = loaderCalls.filter(
    (call) =>
      call.expression.getText(loader.sourceFile) === "removeHnswNativeSnapshot" &&
      call.arguments[0]?.getText(loader.sourceFile) === "admittedHeader"
  );
  let cleanupInFinally = false;
  for (let parent = cleanupCalls[0]?.parent; parent; parent = parent.parent) {
    if (
      ts.isTryStatement(parent) &&
      parent.finallyBlock &&
      (cleanupCalls[0]?.getStart(loader.sourceFile) ?? -1) >= parent.finallyBlock.getStart(loader.sourceFile) &&
      (cleanupCalls[0]?.end ?? Number.POSITIVE_INFINITY) <= parent.finallyBlock.end
    ) {
      cleanupInFinally = true;
      break;
    }
  }
  if (
    !preflightCall ||
    !beforeHash ||
    !nativeLoader ||
    !nativeRead ||
    !afterHash ||
    !(preflightCall.getStart(loader.sourceFile) < beforeHash.getStart(loader.sourceFile)) ||
    digestGuards.length !== 1 ||
    !(beforeHash.getStart(loader.sourceFile) < (digestGuards[0]?.getStart(loader.sourceFile) ?? -1)) ||
    !(
      (digestGuards[0]?.getStart(loader.sourceFile) ?? Number.POSITIVE_INFINITY) <
      nativeLoader.getStart(loader.sourceFile)
    ) ||
    !(nativeLoader.getStart(loader.sourceFile) < nativeRead.getStart(loader.sourceFile)) ||
    !(nativeRead.getStart(loader.sourceFile) < afterHash.getStart(loader.sourceFile)) ||
    cleanupCalls.length !== 1 ||
    !cleanupInFinally ||
    !(nativeRead.getStart(loader.sourceFile) < (cleanupCalls[0]?.getStart(loader.sourceFile) ?? -1))
  ) {
    problems.push(
      "HNSW admission must bind held bytes before native import/read, re-hash after load, and erase the snapshot"
    );
  }
  if (
    nativeRead?.arguments.map((argument) => argument.getText(loader.sourceFile)).join("|") !==
    "admittedHeader.nativeSnapshotPath|true"
  ) {
    problems.push("HNSW native load must use the admitted private snapshot with tombstone replacement enabled");
  }
  return problems;
}

function hnswPublisherBoundaryProblems(source: string): string[] {
  const problems: string[] = [];
  const saveTo = runtimeMemberNodes(source, "src/hnsw.ts", "saveTo");
  if (saveTo.nodes.length !== 1) return [`expected one HNSW saveTo implementation, found ${saveTo.nodes.length}`];
  const body = saveTo.nodes[0]?.body;
  if (!body) return ["HNSW saveTo body disappeared"];
  const publishers = callExpressions(body).filter(
    (call) => call.expression.getText(saveTo.sourceFile) === "publishSensitiveArtifact"
  );
  const generation = publishers.filter((call) => call.arguments[0]?.getText(saveTo.sourceFile) === "generationFile");
  const metadata = publishers.filter((call) => call.arguments[0]?.getText(saveTo.sourceFile) === "metaFile");
  if (publishers.length !== 2 || generation.length !== 1 || metadata.length !== 1) {
    return ["HNSW saveTo must publish exactly one immutable generation and one metadata pointer"];
  }
  const generationCall = generation[0];
  const metadataCall = metadata[0];
  const generationWriter = generationCall?.arguments[1];
  if (
    !generationWriter ||
    !ts.isArrowFunction(generationWriter) ||
    generationWriter.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) !== true ||
    generationCall.arguments[2]?.getText(saveTo.sourceFile) !== "MAX_HNSW_GENERATION_BYTES"
  ) {
    problems.push("HNSW generation publication must use its async native writer under the exact binary cap");
  }
  if (
    metadataCall?.arguments[1]?.getText(saveTo.sourceFile) !== "serializedMeta" ||
    metadataCall.arguments[2]?.getText(saveTo.sourceFile) !== "MAX_HNSW_META_BYTES"
  ) {
    problems.push("HNSW pointer publication must use the exact serialized metadata and metadata-byte cap");
  }
  const formatVersion = variableDeclarations(saveTo.sourceFile, saveTo.sourceFile, "HNSW_META_FORMAT_VERSION");
  const metaCap = variableDeclarations(saveTo.sourceFile, saveTo.sourceFile, "MAX_HNSW_META_BYTES");
  if (
    formatVersion.length !== 1 ||
    formatVersion[0]?.initializer?.getText(saveTo.sourceFile) !== "4" ||
    metaCap.length !== 1 ||
    metaCap[0]?.initializer?.getText(saveTo.sourceFile) !== "64 * 1024"
  ) {
    problems.push("HNSW persistence must use compact format v4 under the fixed 64-KiB metadata cap");
  }
  const projectedMeta = variableDeclarations(body, saveTo.sourceFile, "projectedMeta");
  const projectedMetaInitializer = projectedMeta[0]?.initializer;
  const projectedKeys =
    projectedMetaInitializer && ts.isObjectLiteralExpression(projectedMetaInitializer)
      ? projectedMetaInitializer.properties.map((property) => property.name?.getText(saveTo.sourceFile) ?? "<spread>")
      : [];
  if (
    projectedMeta.length !== 1 ||
    !projectedMetaInitializer ||
    !ts.isObjectLiteralExpression(projectedMetaInitializer) ||
    projectedKeys.join("|") !==
      "formatVersion|binFile|binSha256|dim|size|signature|dbInstanceUuid|dbMutationEpoch|writtenAt" ||
    objectPropertyValue(projectedMetaInitializer, saveTo.sourceFile, "formatVersion")?.getText(saveTo.sourceFile) !==
      "HNSW_META_FORMAT_VERSION" ||
    objectPropertyValue(projectedMetaInitializer, saveTo.sourceFile, "dbInstanceUuid")?.getText(saveTo.sourceFile) !==
      "generationAuthority.dbInstanceUuid" ||
    objectPropertyValue(projectedMetaInitializer, saveTo.sourceFile, "dbMutationEpoch")?.getText(saveTo.sourceFile) !==
      "generationAuthority.dbMutationEpoch"
  ) {
    problems.push("HNSW v4 pointer must bind the DB generation in a compact nine-field receipt without row metadata");
  }
  const projectedCapGuards = ifStatements(body).filter(
    (statement) =>
      statement.expression.getText(saveTo.sourceFile) ===
      'Buffer.byteLength(projectedSerializedMeta, "utf8") > MAX_HNSW_META_BYTES'
  );
  const exactSizeGuards = ifStatements(body).filter(
    (statement) =>
      statement.expression.getText(saveTo.sourceFile) ===
      'Buffer.byteLength(serializedMeta, "utf8") !== Buffer.byteLength(projectedSerializedMeta, "utf8")'
  );
  const projectedCapGuard = projectedCapGuards[0];
  const exactSizeGuard = exactSizeGuards[0];
  if (
    projectedCapGuards.length !== 1 ||
    exactSizeGuards.length !== 1 ||
    !generationCall ||
    !metadataCall ||
    !projectedCapGuard ||
    !exactSizeGuard ||
    !(projectedCapGuard.getStart(saveTo.sourceFile) < generationCall.getStart(saveTo.sourceFile)) ||
    !(generationCall.getStart(saveTo.sourceFile) < exactSizeGuard.getStart(saveTo.sourceFile)) ||
    !(exactSizeGuard.getStart(saveTo.sourceFile) < metadataCall.getStart(saveTo.sourceFile))
  ) {
    problems.push("HNSW compact metadata must be capped before native write and stay exact before pointer commit");
  }
  return problems;
}

interface CandidateAssignment {
  origin: "built" | "loaded";
  node: ts.BinaryExpression;
  value: ts.ObjectLiteralExpression;
  guards: Array<{ branch: "then" | "else"; expression: string }>;
}

function hnswServerAtomicityProblems(source: string): string[] {
  const problems: string[] = [];
  const prepared = runtimeMemberNodes(source, "src/server.ts", "prepareServerDeps");
  if (prepared.nodes.length !== 1)
    return [`expected one prepareServerDeps implementation, found ${prepared.nodes.length}`];
  const body = prepared.nodes[0]?.body;
  if (!body) return ["prepareServerDeps body disappeared"];
  const sourceFile = prepared.sourceFile;
  const declarations = (name: string): ts.VariableDeclaration[] => variableDeclarations(body, sourceFile, name);
  const beforeLoad = declarations("beforeLoad");
  const buildSnapshot = declarations("buildSnapshot");
  const afterLoad = declarations("afterLoad");
  const afterAsync = declarations("afterAsync");
  const afterPersist = declarations("afterPersist");
  if (
    beforeLoad.length !== 1 ||
    beforeLoad[0]?.initializer?.getText(sourceFile) !== "db.captureHnswLoadSnapshot()" ||
    buildSnapshot.length !== 1 ||
    buildSnapshot[0]?.initializer?.getText(sourceFile) !== "db.captureHnswBuildSnapshot()" ||
    afterLoad.length !== 1 ||
    afterLoad[0]?.initializer?.getText(sourceFile) !== "db.captureHnswReceiptSnapshot()" ||
    afterAsync.length !== 1 ||
    afterAsync[0]?.initializer?.getText(sourceFile) !== "db.captureHnswReceiptSnapshot()" ||
    afterPersist.length !== 1 ||
    afterPersist[0]?.initializer?.getText(sourceFile) !== "db.captureHnswReceiptSnapshot()"
  ) {
    problems.push("server HNSW load/build must use one named capture snapshot at each authority boundary");
  }

  const calls = callExpressions(body);
  const loadCalls = calls.filter((call) => call.expression.getText(sourceFile) === "loadHnswFromDisk");
  if (loadCalls.length !== 1) {
    problems.push(`server must have one persisted-HNSW load call, found ${loadCalls.length}`);
  } else {
    const load = loadCalls[0];
    const options = load?.arguments[2];
    if (
      load.arguments[0]?.getText(sourceFile) !== "persistFile" ||
      load.arguments[1]?.getText(sourceFile) !== "beforeLoad.receipt.signature" ||
      !options ||
      !ts.isObjectLiteralExpression(options) ||
      objectPropertyValue(options, sourceFile, "expectedDim")?.getText(sourceFile) !== "beforeLoad.receipt.dim" ||
      objectPropertyValue(options, sourceFile, "expectedRowsByLabel")?.getText(sourceFile) !==
        "beforeLoad.rowsByLabel" ||
      objectPropertyValue(options, sourceFile, "expectedVectorsByLabel")?.getText(sourceFile) !==
        "beforeLoad.vectorsByLabel" ||
      objectPropertyValue(options, sourceFile, "expectedDbInstanceUuid")?.getText(sourceFile) !==
        "beforeLoad.receipt.dbInstanceUuid" ||
      objectPropertyValue(options, sourceFile, "expectedDbMutationEpoch")?.getText(sourceFile) !==
        "beforeLoad.receipt.dbMutationEpoch"
    ) {
      problems.push(
        "server load options must derive signature, generation, dimension, row, and vector authority from one beforeLoad snapshot"
      );
    }
  }

  const saveCalls = calls.filter((call) => call.expression.getText(sourceFile) === "index.saveTo");
  const saveAuthority = saveCalls[0]?.arguments[3];
  if (
    saveCalls.length !== 1 ||
    saveCalls[0]?.arguments[0]?.getText(sourceFile) !== "persistFile" ||
    saveCalls[0]?.arguments[1]?.getText(sourceFile) !== "afterAsync.rowsByLabel" ||
    saveCalls[0]?.arguments[2]?.getText(sourceFile) !== "afterAsync.receipt.signature" ||
    !saveAuthority ||
    !ts.isObjectLiteralExpression(saveAuthority) ||
    objectPropertyValue(saveAuthority, sourceFile, "dbInstanceUuid")?.getText(sourceFile) !==
      "afterAsync.receipt.dbInstanceUuid" ||
    objectPropertyValue(saveAuthority, sourceFile, "dbMutationEpoch")?.getText(sourceFile) !==
      "afterAsync.receipt.dbMutationEpoch"
  ) {
    problems.push("server persistence must bind the pointer to the same post-build DB UUID and epoch receipt");
  }

  const rows = declarations("rows");
  const buildCalls = calls.filter((call) => call.expression.getText(sourceFile) === "buildHnsw");
  const build = buildCalls[0];
  if (
    rows.length !== 1 ||
    rows[0]?.initializer?.getText(sourceFile) !== "buildSnapshot.vectors" ||
    buildCalls.length !== 1 ||
    build?.arguments[0]?.getText(sourceFile) !== "rows.map((r) => ({ label: r.label, vector: r.vector }))" ||
    build.arguments[1]?.getText(sourceFile) !== "{ dim: model.dim, maxElements: rows.length }"
  ) {
    problems.push("server HNSW build must consume only vectors from its atomic buildSnapshot");
  }

  const forbiddenPersistedRows = calls
    .flatMap((call) => [call.expression, ...call.arguments])
    .some((node) => node.getText(sourceFile).includes("loadResult.rowsByLabel"));
  if (forbiddenPersistedRows || body.getText(sourceFile).includes("loadResult.rowsByLabel")) {
    problems.push("server must never publish the persisted sidecar's rowsByLabel as database authority");
  }

  const candidates: CandidateAssignment[] = [];
  const contextAssignments: ts.BinaryExpression[] = [];
  const inspect = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.left.getText(sourceFile) === "candidate" &&
      ts.isObjectLiteralExpression(node.right)
    ) {
      const origin = objectPropertyValue(node.right, sourceFile, "origin")?.getText(sourceFile);
      if (origin === '"loaded"' || origin === '"built"') {
        candidates.push({
          origin: origin.slice(1, -1) as "built" | "loaded",
          node,
          value: node.right,
          guards: branchGuards(node, sourceFile)
        });
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.left.getText(sourceFile) === "hnswContext" &&
      ts.isObjectLiteralExpression(node.right)
    ) {
      contextAssignments.push(node);
    }
    ts.forEachChild(node, inspect);
  };
  inspect(body);
  const loaded = candidates.filter((candidate) => candidate.origin === "loaded");
  const built = candidates.filter((candidate) => candidate.origin === "built");
  if (loaded.length !== 1) {
    problems.push(`server must create one loaded HNSW candidate, found ${loaded.length}`);
  } else {
    const candidate = loaded[0];
    if (
      objectPropertyValue(candidate.value, sourceFile, "rowByLabel")?.getText(sourceFile) !== "afterLoad.rowsByLabel" ||
      objectPropertyValue(candidate.value, sourceFile, "receipt")?.getText(sourceFile) !== "afterLoad.receipt" ||
      !hasBranchGuard(candidate.guards, "then", "sameHnswPersistenceReceipt(beforeLoad.receipt, afterLoad.receipt)")
    ) {
      problems.push("loaded HNSW candidate must use post-load database rows inside the matching-receipt branch");
    }
  }
  if (built.length !== 1) {
    problems.push(`server must create one built HNSW candidate, found ${built.length}`);
  } else {
    const candidate = built[0];
    if (
      objectPropertyValue(candidate.value, sourceFile, "rowByLabel")?.getText(sourceFile) !==
        "afterAsync.rowsByLabel" ||
      objectPropertyValue(candidate.value, sourceFile, "receipt")?.getText(sourceFile) !== "afterAsync.receipt" ||
      objectPropertyValue(candidate.value, sourceFile, "index")?.getText(sourceFile) !== "index" ||
      !hasBranchGuard(
        candidate.guards,
        "else",
        "!sameHnswPersistenceReceipt(buildSnapshot.receipt, afterAsync.receipt)"
      ) ||
      !hasBranchGuard(candidate.guards, "then", "sameHnswPersistenceReceipt(afterAsync.receipt, afterPersist.receipt)")
    ) {
      problems.push("built HNSW candidate must remain inside both post-build and post-persist receipt guards");
    }
  }

  const attachCalls = calls.filter((call) => call.expression.getText(sourceFile) === "watcher.attachHnsw");
  const lastCandidatePosition = Math.max(...candidates.map((candidate) => candidate.node.getStart(sourceFile)), -1);
  const finalReceiptGuards = ifStatements(body).filter(
    (statement) =>
      statement.expression.getText(sourceFile) ===
      "sameHnswPersistenceReceipt(afterAsync.receipt, afterPersist.receipt)"
  );
  const attachCall = attachCalls[0];
  const attachSharesContextAuthority =
    attachCall?.arguments.length === 4 && attachCall.arguments[3]?.getText(sourceFile) === "hnswContext";
  const awaitsAfterFinalReceipt: ts.AwaitExpression[] = [];
  const collectPostReceiptAwaits = (node: ts.Node): void => {
    if (
      ts.isAwaitExpression(node) &&
      (finalReceiptGuards[0]?.expression.end ?? Number.POSITIVE_INFINITY) < node.getStart(sourceFile) &&
      node.getStart(sourceFile) < (attachCall?.getStart(sourceFile) ?? -1)
    ) {
      awaitsAfterFinalReceipt.push(node);
    }
    ts.forEachChild(node, collectPostReceiptAwaits);
  };
  collectPostReceiptAwaits(body);
  if (
    contextAssignments.length !== 1 ||
    !hasBranchGuard(branchGuards(contextAssignments[0] as ts.Node, sourceFile), "then", "candidate") ||
    objectPropertyValue(
      contextAssignments[0]?.right as ts.ObjectLiteralExpression,
      sourceFile,
      "dbInstanceUuid"
    )?.getText(sourceFile) !== "candidate.receipt.dbInstanceUuid" ||
    objectPropertyValue(
      contextAssignments[0]?.right as ts.ObjectLiteralExpression,
      sourceFile,
      "dbMutationEpoch"
    )?.getText(sourceFile) !== "candidate.receipt.dbMutationEpoch" ||
    (contextAssignments[0]?.getStart(sourceFile) ?? -1) <= lastCandidatePosition ||
    attachCalls.length !== 1 ||
    !attachSharesContextAuthority ||
    !hasBranchGuard(branchGuards(attachCalls[0] as ts.Node, sourceFile), "then", "candidate") ||
    (attachCalls[0]?.getStart(sourceFile) ?? -1) <= lastCandidatePosition ||
    finalReceiptGuards.length !== 1 ||
    awaitsAfterFinalReceipt.length !== 1 ||
    awaitsAfterFinalReceipt[0]?.expression.getText(sourceFile) !== "db.acquireSharedPersistenceLifetime()"
  ) {
    problems.push(
      "server must publish/attach the returned HNSW after its final receipt guard, sharing exact live authority across the sole lifetime-acquisition suspension"
    );
  }
  return problems;
}

function watcherCanonicalVectorProblems(source: string): string[] {
  const problems: string[] = [];
  const helper = runtimeMemberNodes(source, "src/watcher.ts", "upsertEmbedAndSyncHnsw");
  const helperBody = helper.nodes[0]?.body;
  if (helper.nodes.length !== 1 || !helperBody) {
    problems.push(`expected one upsertEmbedAndSyncHnsw implementation, found ${helper.nodes.length}`);
  } else {
    const calls = callExpressions(helperBody);
    const conditionalUpserts = calls.filter(
      (call) => call.expression.getText(helper.sourceFile) === "embedDb.upsertNoteWithCanonicalVectorsIfGeneration"
    );
    const fallbackUpserts = calls.filter(
      (call) => call.expression.getText(helper.sourceFile) === "embedDb.upsertNoteWithCanonicalVectors"
    );
    const zipped = calls.filter((call) => call.expression.getText(helper.sourceFile) === "zipHnswAddPoints");
    if (
      conditionalUpserts.length !== 1 ||
      conditionalUpserts[0]?.arguments
        .map((argument) => argument.getText(helper.sourceFile))
        .slice(1)
        .join("|") !== "relPath|mtimeMs|rows|kind" ||
      fallbackUpserts.length !== 2 ||
      fallbackUpserts.some(
        (call) =>
          call.arguments.map((argument) => argument.getText(helper.sourceFile)).join("|") !==
          "relPath|mtimeMs|rows|kind"
      ) ||
      zipped.length !== 1 ||
      zipped[0]?.arguments.map((argument) => argument.getText(helper.sourceFile)).join("|") !==
        "rows|mutation.newIds|mutation.newVectors"
    ) {
      problems.push(
        "upsertEmbedAndSyncHnsw must feed the exact DB-canonical vectors from both admitted/fallback upserts into HNSW"
      );
    }
  }

  for (const [member, kind] of [
    ["commitMarkdownGeneration", '"md"'],
    ["commitPdfGeneration", '"pdf"']
  ] as const) {
    const method = runtimeMemberNodes(source, "src/watcher.ts", member);
    if (method.nodes.length !== 1) {
      problems.push(`expected one ${member} implementation, found ${method.nodes.length}`);
      continue;
    }
    const body = method.nodes[0]?.body;
    if (!body) {
      problems.push(`${member} body disappeared`);
      continue;
    }
    const calls = callExpressions(body);
    const upserts = calls.filter(
      (call) => call.expression.getText(method.sourceFile) === "this.upsertEmbedAndSyncHnsw"
    );
    if (
      upserts.length !== 1 ||
      upserts[0]?.arguments.map((argument) => argument.getText(method.sourceFile)).join("|") !==
        `relPath|generation.mtimeMs|staged.embedResult.rows|${kind}`
    ) {
      problems.push(`${member} must delegate its exact staged rows and source kind to the canonical-vector helper`);
    }
  }
  return problems;
}

function isOrderedSubsequence(actual: readonly string[], expected: readonly string[]): boolean {
  let expectedIndex = 0;
  for (const value of actual) {
    if (value === expected[expectedIndex]) expectedIndex += 1;
  }
  return expectedIndex === expected.length;
}

function embedDbGenerationIdentityProblems(embedSource: string, schemaSource: string): string[] {
  const problems: string[] = [];
  const sourceFile = ts.createSourceFile(
    "src/embed-db.ts",
    embedSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const schemaFile = ts.createSourceFile(
    "src/schema-contract.ts",
    schemaSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const declaration = (name: string): ts.VariableDeclaration | undefined =>
    variableDeclarations(sourceFile, sourceFile, name)[0];
  const stringArray = (name: string): string[] | null => {
    let initializer = declaration(name)?.initializer;
    while (initializer && (ts.isAsExpression(initializer) || ts.isParenthesizedExpression(initializer))) {
      initializer = initializer.expression;
    }
    if (!initializer || !ts.isArrayLiteralExpression(initializer)) return null;
    const values: string[] = [];
    for (const element of initializer.elements) {
      if (!ts.isStringLiteralLike(element)) return null;
      values.push(element.text);
    }
    return values;
  };

  const schemaVersions = variableDeclarations(schemaFile, schemaFile, "EMBED_DB_SCHEMA_VERSION");
  if (
    schemaVersions.length !== 1 ||
    schemaVersions[0]?.initializer?.getText(schemaFile) !== "5" ||
    declaration("MAX_EMBED_MUTATION_EPOCH")?.initializer?.getText(sourceFile) !== "Number.MAX_SAFE_INTEGER"
  ) {
    problems.push("EmbedDb durable generation authority must use schema v5 and the safe-integer epoch ceiling");
  }
  if (
    stringArray("MUTATION_EPOCH_TABLES")?.join("|") !== "embeddings|source_state|source_quarantine|source_revision" ||
    stringArray("MUTATION_EPOCH_OPERATIONS")?.join("|") !== "INSERT|UPDATE|DELETE"
  ) {
    problems.push("EmbedDb mutation epoch must cover every operation on every admitted durable payload table");
  }

  const triggerDefinitions = declaration("MUTATION_EPOCH_TRIGGER_DEFINITIONS")?.initializer?.getText(sourceFile) ?? "";
  for (const fragment of [
    "MUTATION_EPOCH_TABLES.flatMap((table) =>",
    "MUTATION_EPOCH_OPERATIONS.map((operation) =>",
    "BEFORE $" + "{operation} ON $" + "{table}",
    "typeof(value) = 'text'",
    "value = CAST(CAST(value AS INTEGER) AS TEXT)",
    "CAST(value AS INTEGER) BETWEEN 1 AND $" + "{MAX_EMBED_MUTATION_EPOCH - 1}",
    "THEN RAISE(ABORT, 'embedding mutation epoch is invalid or exhausted') END",
    "SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)",
    "WHERE key = 'mutation_epoch'"
  ]) {
    if (!triggerDefinitions.includes(fragment)) {
      problems.push(`EmbedDb mutation trigger class must retain ${fragment}`);
    }
  }
  if (
    declaration("MUTATION_EPOCH_TRIGGER_NAMES")?.initializer?.getText(sourceFile) !==
    "MUTATION_EPOCH_TRIGGER_DEFINITIONS.map(({ name }) => name)"
  ) {
    problems.push("EmbedDb mutation trigger names must be derived from the complete trigger-definition class");
  }

  const historicalVersions = declaration("HISTORICAL_EMBED_DB_SCHEMA_VERSIONS")?.initializer?.getText(sourceFile);
  const admission = runtimeMemberNodes(embedSource, "src/embed-db.ts", "inspectEmbedAdmission");
  const admissionText = admission.nodes[0]?.body?.getText(admission.sourceFile) ?? "";
  if (
    historicalVersions !== "new Set([1, 2, 3, 4])" ||
    admission.nodes.length !== 1 ||
    !admissionText.includes("schemaVersion > EMBED_DB_SCHEMA_VERSION") ||
    !admissionText.includes("!currentSchema && !HISTORICAL_EMBED_DB_SCHEMA_VERSIONS.has(schemaVersion)") ||
    !admissionText.includes(
      '["schema_version", "vault_root", "model_alias", "dim", "quantization", "instance_uuid", "mutation_epoch"]'
    ) ||
    !admissionText.includes("rows.length !== expectedMetaKeys.length") ||
    !admissionText.includes("!EMBED_META_KEYS.has(row.key)") ||
    !admissionText.includes("Object.hasOwn(meta, row.key)") ||
    !admissionText.includes("!EMBED_INSTANCE_UUID_PATTERN.test(storedInstanceUuid)") ||
    !admissionText.includes("!isCanonicalMutationEpoch(storedMutationEpoch)") ||
    !admissionText.includes("...MUTATION_EPOCH_TRIGGER_NAMES") ||
    !admissionText.includes("!hasExactTriggerDefinitions(MUTATION_EPOCH_TRIGGER_DEFINITIONS)") ||
    !admissionText.includes("MUTATION_EPOCH_TRIGGER_NAMES.some((name) => objectTypes.has(name))")
  ) {
    problems.push(
      "EmbedDb admission must exactly separate supported historical schemas from current UUID/epoch metadata and triggers"
    );
  }

  const bootstrap = runtimeMemberNodes(embedSource, "src/embed-db.ts", "bootstrapSchema");
  const bootstrapText = bootstrap.nodes[0]?.body?.getText(bootstrap.sourceFile) ?? "";
  const noWriteReopen = bootstrapText.indexOf("if (!requiresBootstrap) return;");
  const triggerDrop = bootstrapText.indexOf(
    "for (const name of [...SOURCE_REVISION_TRIGGER_NAMES, ...MUTATION_EPOCH_TRIGGER_NAMES])"
  );
  const identityWrite = bootstrapText.indexOf("this.writeMeta({");
  const epochInstall = bootstrapText.indexOf("for (const definition of MUTATION_EPOCH_TRIGGER_DEFINITIONS)");
  if (
    bootstrap.nodes.length !== 1 ||
    noWriteReopen < 0 ||
    triggerDrop <= noWriteReopen ||
    identityWrite <= triggerDrop ||
    epochInstall <= identityWrite ||
    !bootstrapText.includes('instance_uuid: randomBytes(16).toString("hex")') ||
    !bootstrapText.includes('mutation_epoch: "1"') ||
    !bootstrapText.includes("db.exec(definition.sql)") ||
    !bootstrapText.includes("txn.immediate()")
  ) {
    problems.push(
      "EmbedDb bootstrap must preserve exact current identity and atomically install a fresh UUID/epoch generation on rebuild"
    );
  }

  const capture = runtimeMemberNodes(embedSource, "src/embed-db.ts", "captureHnswSnapshot");
  const captureText = capture.nodes[0]?.body?.getText(capture.sourceFile) ?? "";
  if (
    capture.nodes.length !== 1 ||
    !captureText.includes('"SELECT key, value FROM meta ORDER BY key LIMIT 8"') ||
    !captureText.includes("metaRows.length !== 7") ||
    !captureText.includes('!EMBED_INSTANCE_UUID_PATTERN.test(meta.get("instance_uuid") ?? "")') ||
    !captureText.includes('!isCanonicalMutationEpoch(meta.get("mutation_epoch"))') ||
    !captureText.includes('const dbInstanceUuid = meta.get("instance_uuid") as string') ||
    !captureText.includes('const dbMutationEpoch = Number(meta.get("mutation_epoch"))')
  ) {
    problems.push("EmbedDb HNSW snapshot must atomically admit and capture the exact current DB UUID and epoch");
  }
  return problems;
}

function embedHnswSnapshotProblems(source: string): string[] {
  const problems: string[] = [];
  const captured = runtimeMemberNodes(source, "src/embed-db.ts", "captureHnswSnapshot");
  if (captured.nodes.length !== 1) {
    return [`expected one captureHnswSnapshot implementation, found ${captured.nodes.length}`];
  }
  const body = captured.nodes[0]?.body;
  if (!body) return ["captureHnswSnapshot body disappeared"];
  const sourceFile = captured.sourceFile;
  const captureDeclarations = variableDeclarations(body, sourceFile, "capture");
  const capture = captureDeclarations[0];
  const transactionCall = capture?.initializer;
  const callback = ts.isCallExpression(transactionCall) ? transactionCall.arguments[0] : undefined;
  if (
    captureDeclarations.length !== 1 ||
    !transactionCall ||
    !ts.isCallExpression(transactionCall) ||
    transactionCall.expression.getText(sourceFile) !== "db.transaction" ||
    !callback ||
    !ts.isArrowFunction(callback) ||
    !ts.isBlock(callback.body)
  ) {
    return ["EmbedDb HNSW snapshot must be produced by one synchronous db.transaction callback"];
  }
  const callbackBody = callback.body;
  const callbackCalls = callExpressions(callbackBody);
  const preparedQueries = callbackCalls.filter((call) => isPropertyCall(call, sourceFile, "db", "prepare"));
  const allPreparedQueries = callExpressions(body).filter((call) => isPropertyCall(call, sourceFile, "db", "prepare"));
  const queryRoles = [
    {
      id: "configuration metadata",
      execute: "all",
      tokens: ["SELECT key, value FROM meta", "ORDER BY key", "LIMIT 8"]
    },
    {
      id: "authority envelope",
      execute: "get",
      tokens: [
        "AS quarantine_count",
        "AS quarantine_path_bytes",
        "AS quarantine_max_path_bytes",
        "AS state_count",
        "AS state_path_bytes",
        "AS state_max_path_bytes",
        "AS revision_count",
        "AS revision_path_bytes",
        "AS revision_max_path_bytes",
        "AS quarantine_invalid_count",
        "AS state_invalid_count",
        "AS revision_invalid_count",
        "length(CAST(rel_path AS BLOB)) NOT BETWEEN 1 AND $" + "{MAX_HNSW_SNAPSHOT_PATH_BYTES}",
        "typeof(kind) <> 'text' OR kind NOT IN ('md', 'pdf')",
        "typeof(mtime_ms) NOT IN ('integer', 'real')",
        "typeof(n_chunks) <> 'integer'",
        "n_chunks NOT BETWEEN 1 AND $" + "{MAX_HNSW_SNAPSHOT_ROWS}",
        "typeof(revision) <> 'integer'",
        "revision NOT BETWEEN 1 AND $" + "{MAX_SOURCE_REVISION}"
      ]
    },
    {
      id: "quarantine manifest",
      execute: "iterate",
      tokens: ["SELECT rel_path, kind FROM source_quarantine", "ORDER BY kind, rel_path"]
    },
    {
      id: "source completeness",
      execute: "iterate",
      tokens: [
        "FROM source_state AS s",
        "COUNT(e.id) AS actual_count",
        "MIN(e.chunk_index) AS min_chunk_index",
        "MAX(e.chunk_index) AS max_chunk_index",
        "LEFT JOIN source_revision AS r",
        "LEFT JOIN embeddings AS e",
        "WHERE q.rel_path IS NULL",
        "GROUP BY s.rel_path",
        "ORDER BY s.kind, s.rel_path"
      ]
    },
    {
      id: "embedding aggregate",
      execute: "get",
      tokens: [
        "SELECT COUNT(*) AS row_count",
        "AS text_bytes",
        "AS max_path_bytes",
        "AS max_preview_bytes",
        "AS vector_bytes",
        "typeof(e.vector) <> 'blob' OR length(e.vector) <> ?",
        "AS invalid_vector_count",
        "AS invalid_scalar_count",
        "typeof(e.id) <> 'integer'",
        "e.id NOT BETWEEN 0 AND $" + "{MAX_HNSW_NATIVE_LABEL}",
        "typeof(e.rel_path) <> 'text'",
        "length(CAST(e.rel_path AS BLOB)) NOT BETWEEN 1 AND $" + "{MAX_HNSW_SNAPSHOT_PATH_BYTES}",
        "typeof(e.chunk_index) <> 'integer'",
        "e.chunk_index < 0",
        "typeof(e.line_start) <> 'integer'",
        "e.line_start < 1",
        "typeof(e.line_end) <> 'integer'",
        "e.line_end < e.line_start",
        "typeof(e.text_preview) <> 'text'",
        "length(CAST(e.text_preview AS BLOB)) > $" + "{MAX_HNSW_SNAPSHOT_PREVIEW_BYTES}",
        "typeof(e.kind) <> 'text'",
        "e.kind NOT IN ('md', 'pdf')",
        "FROM embeddings AS e",
        "WHERE q.rel_path IS NULL"
      ]
    },
    {
      id: "embedding payload",
      execute: "iterate",
      tokens: [
        "SELECT e.id AS label",
        "e.text_preview, e.vector, e.kind",
        "s.mtime_ms AS indexed_mtime_ms",
        "r.revision AS indexed_revision",
        "q.rel_path AS quarantine_rel_path",
        "FROM embeddings e",
        "WHERE q.rel_path IS NULL",
        "ORDER BY e.id"
      ]
    }
  ] as const;
  const roleMatches = new Map<string, ts.CallExpression[]>();
  for (const role of queryRoles) {
    roleMatches.set(
      role.id,
      preparedQueries.filter((query) => {
        const sql = query.arguments[0]?.getText(sourceFile) ?? "";
        return role.tokens.every((token) => sql.includes(token));
      })
    );
  }
  const matchedQueries = new Set([...roleMatches.values()].flat());
  for (const role of queryRoles) {
    const matches = roleMatches.get(role.id) ?? [];
    const query = matches[0];
    const execute =
      query?.parent &&
      ts.isPropertyAccessExpression(query.parent) &&
      query.parent.parent &&
      ts.isCallExpression(query.parent.parent)
        ? query.parent.name.text
        : "<missing>";
    if (matches.length !== 1 || execute !== role.execute) {
      problems.push(`EmbedDb HNSW snapshot must have one ${role.id} ${role.execute} query`);
    }
  }
  if (
    allPreparedQueries.some((call) => !preparedQueries.includes(call)) ||
    preparedQueries.some((call) => !matchedQueries.has(call))
  ) {
    problems.push("every HNSW snapshot query must have one semantic role inside the single transaction callback");
  }
  for (const [name, fields] of [
    ["authorityCounts", ["quarantine_count", "state_count", "revision_count"]],
    ["authorityPathBytes", ["quarantine_path_bytes", "state_path_bytes", "revision_path_bytes"]],
    ["authorityMaxPathBytes", ["quarantine_max_path_bytes", "state_max_path_bytes", "revision_max_path_bytes"]],
    ["authorityInvalidCounts", ["quarantine_invalid_count", "state_invalid_count", "revision_invalid_count"]]
  ] as const) {
    const declarations = variableDeclarations(callbackBody, sourceFile, name);
    const initializer = declarations[0]?.initializer?.getText(sourceFile) ?? "";
    if (declarations.length !== 1 || fields.some((field) => !initializer.includes(`authorityEnvelope?.${field}`))) {
      problems.push(`EmbedDb authority envelope ${name} must bind every table-specific aggregate`);
    }
  }
  const authorityIntegrityGuards = ifStatements(callbackBody).filter((statement) =>
    statement.expression.getText(sourceFile).includes("authorityInvalidCounts")
  );
  const authorityCapacityGuards = ifStatements(callbackBody).filter((statement) => {
    const expression = statement.expression.getText(sourceFile);
    return expression.includes("authorityCounts") && expression.includes("MAX_HNSW_SNAPSHOT_ROWS");
  });
  const authorityIntegrityExpression = authorityIntegrityGuards[0]?.expression.getText(sourceFile) ?? "";
  const authorityCapacityExpression = authorityCapacityGuards[0]?.expression.getText(sourceFile) ?? "";
  for (const predicate of [
    "authorityCounts.some((value) => !Number.isSafeInteger(value) || (value as number) < 0)",
    "authorityPathBytes.some((value) => !Number.isSafeInteger(value) || (value as number) < 0)",
    "authorityMaxPathBytes.some((value) => !Number.isSafeInteger(value) || (value as number) < 0)",
    "authorityInvalidCounts.some((value) => value !== 0)"
  ]) {
    if (authorityIntegrityGuards.length !== 1 || !authorityIntegrityExpression.includes(predicate)) {
      problems.push(`EmbedDb authority integrity admission must enforce ${predicate}`);
    }
  }
  for (const predicate of [
    "authorityCounts.some((value) => (value as number) > MAX_HNSW_SNAPSHOT_ROWS)",
    "authorityPathBytes.some((value) => (value as number) > MAX_HNSW_SNAPSHOT_TEXT_BYTES)",
    "authorityMaxPathBytes.some((value) => (value as number) > MAX_HNSW_SNAPSHOT_PATH_BYTES)"
  ]) {
    if (authorityCapacityGuards.length !== 1 || !authorityCapacityExpression.includes(predicate)) {
      problems.push(`EmbedDb authority capacity admission must enforce ${predicate}`);
    }
  }
  let callbackAwaits = 0;
  const countAwaits = (node: ts.Node): void => {
    if (ts.isAwaitExpression(node)) callbackAwaits += 1;
    ts.forEachChild(node, countAwaits);
  };
  countAwaits(callbackBody);
  if (callbackAwaits !== 0)
    problems.push("EmbedDb HNSW capture transaction must remain synchronous and suspension-free");
  const returnsCapture = [...body.statements].filter(
    (statement): statement is ts.ReturnStatement =>
      ts.isReturnStatement(statement) && statement.expression?.getText(sourceFile) === "capture()"
  );
  if (returnsCapture.length !== 1 || returnsCapture[0]?.getStart(sourceFile) <= capture.getStart(sourceFile)) {
    problems.push("EmbedDb must execute and return the transaction-wrapped HNSW capture");
  }

  const hashDeclaration = (name: string, initializer: string): boolean => {
    const matches = variableDeclarations(callbackBody, sourceFile, name);
    return matches.length === 1 && matches[0]?.initializer?.getText(sourceFile) === initializer;
  };
  if (
    !hashDeclaration("liveLabelHash", 'createHash("sha256")') ||
    !hashDeclaration("payloadHash", 'createHash("sha256")')
  ) {
    problems.push("EmbedDb HNSW capture must initialize independent SHA-256 label and payload manifests");
  }
  const manifestCalls = callbackCalls.filter((call) => call.expression.getText(sourceFile) === "updateManifestValue");
  const labelValues = manifestCalls
    .filter((call) => call.arguments[0]?.getText(sourceFile) === "liveLabelHash")
    .map((call) => call.arguments[1]?.getText(sourceFile) ?? "<missing>");
  const payloadValues = manifestCalls
    .filter((call) => call.arguments[0]?.getText(sourceFile) === "payloadHash")
    .map((call) => call.arguments[1]?.getText(sourceFile) ?? "<missing>");
  if (!isOrderedSubsequence(labelValues, ["label"])) {
    problems.push("EmbedDb live-label manifest must bind each admitted native label");
  }
  const expectedPayloadValues = [
    "EMBED_DB_SCHEMA_VERSION",
    "this.modelAlias",
    "this.dim",
    "this.quantization",
    "row.kind",
    "row.rel_path",
    "state.kind",
    "state.rel_path",
    "state.mtime_ms",
    "state.n_chunks as number",
    "state.revision as number",
    "label",
    "metadata.rel_path",
    "metadata.kind",
    "metadata.chunk_index",
    "metadata.line_start",
    "metadata.line_end",
    "metadata.text_preview",
    "row.indexed_mtime_ms",
    "row.indexed_revision as number",
    "row.vector"
  ];
  if (!isOrderedSubsequence(payloadValues, expectedPayloadValues)) {
    problems.push(
      "EmbedDb payload manifest must bind configuration, quarantine, source completeness, row receipts, and vectors"
    );
  }

  const completenessGuards = ifStatements(callbackBody).filter((statement) => {
    const expression = statement.expression.getText(sourceFile);
    return expression.includes("state.actual_count") && expression.includes("state.n_chunks");
  });
  const completenessExpression = completenessGuards[0]?.expression.getText(sourceFile) ?? "";
  for (const predicate of [
    "(state.n_chunks as number) < 1",
    "state.revision_rel_path !== state.rel_path",
    "state.revision_kind !== state.kind",
    "(state.revision as number) < 1",
    "(state.revision as number) > MAX_SOURCE_REVISION",
    "state.actual_count !== state.n_chunks",
    "state.min_chunk_index !== 0",
    "state.max_chunk_index !== (state.n_chunks as number) - 1"
  ]) {
    if (completenessGuards.length !== 1 || !completenessExpression.includes(predicate)) {
      problems.push(`EmbedDb source completeness guard must enforce ${predicate}`);
    }
  }

  const aggregateIntegrityGuards = ifStatements(callbackBody).filter((statement) =>
    statement.expression.getText(sourceFile).includes("aggregate.invalid_vector_count")
  );
  const aggregateIndividualCapacityGuards = ifStatements(callbackBody).filter((statement) => {
    const expression = statement.expression.getText(sourceFile);
    return expression.includes("rowCount") && expression.includes("MAX_HNSW_SNAPSHOT_PREVIEW_BYTES");
  });
  const aggregateCombinedCapacityGuards = ifStatements(callbackBody).filter((statement) => {
    const expression = statement.expression.getText(sourceFile);
    return expression.includes("combinedWorkingSetBytes") && expression.includes("MAX_HNSW_COMBINED_WORKING_SET_BYTES");
  });
  const aggregateIntegrityExpression = aggregateIntegrityGuards[0]?.expression.getText(sourceFile) ?? "";
  for (const predicate of [
    "aggregate.invalid_vector_count !== 0",
    "aggregate.invalid_scalar_count !== 0",
    "aggregate.vector_bytes !== (aggregate.row_count as number) * this.encodedBytes"
  ]) {
    if (aggregateIntegrityGuards.length !== 1 || !aggregateIntegrityExpression.includes(predicate)) {
      problems.push(`EmbedDb aggregate integrity admission must enforce ${predicate}`);
    }
  }
  const aggregateIndividualCapacityExpression =
    aggregateIndividualCapacityGuards[0]?.expression.getText(sourceFile) ?? "";
  for (const predicate of [
    "rowCount > MAX_HNSW_SNAPSHOT_ROWS",
    "(aggregate.text_bytes as number) > MAX_HNSW_SNAPSHOT_TEXT_BYTES",
    "(aggregate.max_path_bytes as number) > MAX_HNSW_SNAPSHOT_PATH_BYTES",
    "(aggregate.max_preview_bytes as number) > MAX_HNSW_SNAPSHOT_PREVIEW_BYTES"
  ]) {
    if (aggregateIndividualCapacityGuards.length !== 1 || !aggregateIndividualCapacityExpression.includes(predicate)) {
      problems.push(`EmbedDb aggregate capacity admission must enforce ${predicate}`);
    }
  }
  if (
    aggregateCombinedCapacityGuards.length !== 1 ||
    aggregateCombinedCapacityGuards[0]?.expression.getText(sourceFile) !==
      "combinedWorkingSetBytes > BigInt(MAX_HNSW_COMBINED_WORKING_SET_BYTES)"
  ) {
    problems.push("EmbedDb aggregate capacity admission must enforce the exact combined working-set cap");
  }
  const combinedDeclarations = variableDeclarations(callbackBody, sourceFile, "combinedWorkingSetBytes");
  const combinedInitializer = combinedDeclarations[0]?.initializer?.getText(sourceFile) ?? "";
  for (const component of [
    "BigInt(HNSW_COMBINED_FIXED_HEADROOM_BYTES)",
    "BigInt(nativeCapacity) * BigInt(nativeBytesPerElement)",
    "BigInt(rowCount) * BigInt(this.dim * 4) * 2n",
    "BigInt(aggregate.vector_bytes as number)",
    "BigInt(rowCount) * BigInt(HNSW_SNAPSHOT_METADATA_PER_ROW_BYTES) * 3n",
    "BigInt(aggregate.text_bytes as number) * 3n",
    "BigInt(authorityManifestPathBytes) * 2n"
  ]) {
    if (combinedDeclarations.length !== 1 || !combinedInitializer.includes(component)) {
      problems.push(`EmbedDb combined HNSW working-set envelope must include ${component}`);
    }
  }
  const combinedCap = variableDeclarations(callbackBody, sourceFile, "MAX_HNSW_COMBINED_WORKING_SET_BYTES");
  if (combinedCap.length !== 0) {
    problems.push("combined HNSW cap must remain module-scoped rather than capture-local");
  }
  const moduleCombinedCap = variableDeclarations(sourceFile, sourceFile, "MAX_HNSW_COMBINED_WORKING_SET_BYTES");
  if (
    moduleCombinedCap.length !== 1 ||
    moduleCombinedCap[0]?.initializer?.getText(sourceFile) !== "1024 * 1024 * 1024"
  ) {
    problems.push("EmbedDb combined HNSW working-set cap must remain exactly 1 GiB");
  }
  const vectorMaps = variableDeclarations(callbackBody, sourceFile, "vectorsByLabel");
  const vectorMapSets = callbackCalls.filter((call) => call.expression.getText(sourceFile) === "vectorsByLabel.set");
  if (
    vectorMaps.length !== 1 ||
    vectorMaps[0]?.initializer?.getText(sourceFile) !== "new Map<number, Float32Array>()" ||
    vectorMapSets.length !== 1 ||
    vectorMapSets[0]?.arguments.map((argument) => argument.getText(sourceFile)).join("|") !== "label|vector" ||
    !hasBranchGuard(branchGuards(vectorMapSets[0] as ts.Node, sourceFile), "then", 'mode === "load"')
  ) {
    problems.push("EmbedDb load snapshot must retain DB-canonical vectors only for the atomic load mode");
  }
  const loadSnapshot = runtimeMemberNodes(source, "src/embed-db.ts", "captureHnswLoadSnapshot");
  const loadSnapshotBody = loadSnapshot.nodes[0]?.body?.getText(loadSnapshot.sourceFile) ?? "";
  if (
    loadSnapshot.nodes.length !== 1 ||
    !loadSnapshotBody.includes('return this.captureHnswSnapshot("load")') ||
    !callbackBody.getText(sourceFile).includes('if (mode === "load") return { ...snapshot, vectorsByLabel }')
  ) {
    problems.push("EmbedDb public HNSW load capture must return the transaction-owned vector authority map");
  }
  const aggregateQuery = roleMatches.get("embedding aggregate")?.[0];
  const aggregateExecution =
    aggregateQuery?.parent &&
    ts.isPropertyAccessExpression(aggregateQuery.parent) &&
    ts.isCallExpression(aggregateQuery.parent.parent)
      ? aggregateQuery.parent.parent
      : undefined;
  if (aggregateExecution?.arguments[0]?.getText(sourceFile) !== "this.encodedBytes") {
    problems.push("EmbedDb aggregate vector-shape census must bind the active encoded vector width");
  }

  const liveDigest = variableDeclarations(callbackBody, sourceFile, "liveLabelSha256");
  const payloadDigest = variableDeclarations(callbackBody, sourceFile, "dbPayloadSha256");
  const receiptDeclarations = variableDeclarations(callbackBody, sourceFile, "receipt");
  const receiptInitializer = receiptDeclarations[0]?.initializer;
  if (
    liveDigest.length !== 1 ||
    liveDigest[0]?.initializer?.getText(sourceFile) !== 'liveLabelHash.digest("hex")' ||
    payloadDigest.length !== 1 ||
    payloadDigest[0]?.initializer?.getText(sourceFile) !== 'payloadHash.digest("hex")' ||
    receiptDeclarations.length !== 1 ||
    !receiptInitializer ||
    !ts.isObjectLiteralExpression(receiptInitializer) ||
    objectPropertyValue(receiptInitializer, sourceFile, "dbInstanceUuid")?.getText(sourceFile) !== "dbInstanceUuid" ||
    objectPropertyValue(receiptInitializer, sourceFile, "dbMutationEpoch")?.getText(sourceFile) !== "dbMutationEpoch" ||
    objectPropertyValue(receiptInitializer, sourceFile, "liveLabelSha256")?.getText(sourceFile) !== "liveLabelSha256" ||
    objectPropertyValue(receiptInitializer, sourceFile, "dbPayloadSha256")?.getText(sourceFile) !== "dbPayloadSha256"
  ) {
    problems.push("EmbedDb HNSW receipt must expose the digests produced inside its capture transaction");
  } else {
    const signature = objectPropertyValue(receiptInitializer, sourceFile, "signature")?.getText(sourceFile) ?? "";
    const instanceBinding = "instance=$" + "{dbInstanceUuid}";
    const epochBinding = "epoch=$" + "{dbMutationEpoch}";
    const labelBinding = "labels=$" + "{liveLabelSha256}";
    const payloadBinding = "payload=$" + "{dbPayloadSha256}";
    if (
      !signature.includes(instanceBinding) ||
      !signature.includes(epochBinding) ||
      !signature.includes(labelBinding) ||
      !signature.includes(payloadBinding)
    ) {
      problems.push("EmbedDb HNSW signature must bind DB generation and both cryptographic manifests");
    }
  }

  const comparator = runtimeMemberNodes(source, "src/embed-db.ts", "sameHnswPersistenceReceipt");
  const comparatorBody = comparator.nodes[0]?.body?.getText(comparator.sourceFile) ?? "";
  for (const field of [
    "version",
    "signature",
    "dbInstanceUuid",
    "dbMutationEpoch",
    "dim",
    "activeRows",
    "maxLabel",
    "liveLabelSha256",
    "dbPayloadSha256"
  ]) {
    if (!comparatorBody.includes(`left.${field} === right.${field}`)) {
      problems.push(`HNSW receipt comparator must bind ${field}`);
    }
  }
  return problems;
}

function cacheSnapshotProblems(source: string): string[] {
  const sourceFile = ts.createSourceFile("src/vault.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const methods = new Map<string, ts.MethodDeclaration[]>();
  const receiptComparators: ts.FunctionDeclaration[] = [];
  const findMethod = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "cacheSourceReceiptsEqual") {
      receiptComparators.push(node);
    }
    if (ts.isMethodDeclaration(node)) {
      const name = node.name.getText(sourceFile);
      if (
        name === "saveDiskCache" ||
        name === "saveDiskCacheOperation" ||
        name === "saveDiskCacheOnce" ||
        name === "clearDiskCache" ||
        name === "clearDiskCacheOperation" ||
        name === "loadDiskCache" ||
        name === "loadDiskCacheOnce" ||
        name === "readNote" ||
        name === "readNoteWithCachePolicy"
      ) {
        const matches = methods.get(name) ?? [];
        matches.push(node);
        methods.set(name, matches);
      }
    }
    ts.forEachChild(node, findMethod);
  };
  findMethod(sourceFile);
  const saveMethods = methods.get("saveDiskCacheOperation") ?? [];
  const workerMethods = methods.get("saveDiskCacheOnce") ?? [];
  const clearMethods = methods.get("clearDiskCacheOperation") ?? [];
  const loadMethods = methods.get("loadDiskCacheOnce") ?? [];
  const readDelegateMethods = methods.get("readNote") ?? [];
  const readPolicyMethods = methods.get("readNoteWithCachePolicy") ?? [];
  const problems: string[] = [];
  if (saveMethods.length !== 1) {
    problems.push(`expected one saveDiskCacheOperation method, found ${saveMethods.length}`);
  }
  if (workerMethods.length !== 1) problems.push(`expected one saveDiskCacheOnce method, found ${workerMethods.length}`);
  if (clearMethods.length !== 1) {
    problems.push(`expected one clearDiskCacheOperation method, found ${clearMethods.length}`);
  }
  if (loadMethods.length !== 1) {
    problems.push(`expected one loadDiskCacheOnce method, found ${loadMethods.length}`);
  }
  if (readDelegateMethods.length !== 1) {
    problems.push(`expected one readNote delegate, found ${readDelegateMethods.length}`);
  }
  if (readPolicyMethods.length !== 1) {
    problems.push(`expected one readNoteWithCachePolicy method, found ${readPolicyMethods.length}`);
  }
  if (receiptComparators.length !== 1) {
    problems.push(`expected one cacheSourceReceiptsEqual function, found ${receiptComparators.length}`);
  } else {
    const comparatorText = receiptComparators[0]?.body?.getText(sourceFile) ?? "";
    for (const field of ["dev", "ino", "size", "mtimeMs", "ctimeMs"]) {
      if (comparatorText.split(`left.${field} === right.${field}`).length - 1 !== 1) {
        problems.push(`cacheSourceReceiptsEqual must compare receipt.${field} exactly once`);
      }
    }
  }
  const saveMethod = saveMethods[0];
  const workerMethod = workerMethods[0];
  const clearMethod = clearMethods[0];
  const loadMethod = loadMethods[0];
  const readDelegateMethod = readDelegateMethods[0];
  const readPolicyMethod = readPolicyMethods[0];
  if (
    !saveMethod?.body ||
    !workerMethod?.body ||
    !clearMethod?.body ||
    !loadMethod?.body ||
    !readDelegateMethod?.body ||
    !readPolicyMethod?.body
  ) {
    return problems;
  }

  const delegateStatements = [...readDelegateMethod.body.statements];
  const delegateReturn = delegateStatements[0];
  const delegateCall =
    delegateStatements.length === 1 &&
    delegateReturn &&
    ts.isReturnStatement(delegateReturn) &&
    delegateReturn.expression &&
    ts.isCallExpression(delegateReturn.expression)
      ? delegateReturn.expression
      : undefined;
  const delegateTarget = delegateCall?.expression;
  if (
    !delegateCall ||
    !delegateTarget ||
    !ts.isPropertyAccessExpression(delegateTarget) ||
    delegateTarget.expression.kind !== ts.SyntaxKind.ThisKeyword ||
    delegateTarget.name.text !== "readNoteWithCachePolicy" ||
    delegateCall.arguments.length !== 3 ||
    delegateCall.arguments[0]?.getText(sourceFile) !== "relOrAbs" ||
    delegateCall.arguments[1]?.getText(sourceFile) !== "knownMtimeMs" ||
    delegateCall.arguments[2]?.kind !== ts.SyntaxKind.TrueKeyword
  ) {
    problems.push("readNote must be a single direct cached-policy delegate");
  }

  let snapshotDeclarations = 0;
  let snapshotInitializer = "";
  let snapshotInitializerAwaits = 0;
  let requestCalls = 0;
  let snapshotLoops = 0;
  const inspectSave = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(sourceFile) === "cacheSnapshot") {
      snapshotDeclarations += 1;
      snapshotInitializer = node.initializer?.getText(sourceFile) ?? "";
      const countAwaits = (child: ts.Node): void => {
        if (ts.isAwaitExpression(child)) snapshotInitializerAwaits += 1;
        ts.forEachChild(child, countAwaits);
      };
      if (node.initializer) countAwaits(node.initializer);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(sourceFile) === "this.saveDiskCacheOnce" &&
      node.arguments[0]?.getText(sourceFile) === "{ requestedFile: file, publishedEpoch, cacheSnapshot }"
    ) {
      requestCalls += 1;
    }
    ts.forEachChild(node, inspectSave);
  };
  inspectSave(saveMethod);
  const inspectWorker = (node: ts.Node): void => {
    if (ts.isForOfStatement(node) && node.expression.getText(sourceFile) === "cacheSnapshot") snapshotLoops += 1;
    ts.forEachChild(node, inspectWorker);
  };
  inspectWorker(workerMethod);

  const directStatements = [...saveMethod.body.statements];
  const declarationIndex = (name: string): number =>
    directStatements.findIndex(
      (statement) =>
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some((declaration) => declaration.name.getText(sourceFile) === name)
    );
  const fileIndex = declarationIndex("file");
  const pendingClearIndex = declarationIndex("pendingClear");
  const publishedEpochIndex = declarationIndex("publishedEpoch");
  const snapshotIndex = declarationIndex("cacheSnapshot");
  const writeIndex = declarationIndex("write");
  const trackedWriteIndex = declarationIndex("trackedWrite");
  const cleanBarrierIndex = directStatements.findIndex((statement) => {
    if (!ts.isIfStatement(statement)) return false;
    const text = statement.getText(sourceFile);
    return (
      statement.expression.getText(sourceFile) === "!this.cacheDirty" &&
      text.includes("await pendingClear.promise;") &&
      text.includes("return;")
    );
  });
  const pendingLimitIndex = directStatements.findIndex(
    (statement) =>
      ts.isIfStatement(statement) &&
      statement.expression.getText(sourceFile) === "this.pendingCacheSaveRequests >= MAX_PENDING_DISK_CACHE_SAVES"
  );
  const pendingIncrementIndex = directStatements.findIndex(
    (statement) => statement.getText(sourceFile) === "this.pendingCacheSaveRequests += 1;"
  );
  const initializationIndex = directStatements.findIndex(
    (statement) =>
      ts.isIfStatement(statement) &&
      statement.expression.getText(sourceFile) === "!this.ready" &&
      statement.getText(sourceFile).includes("await this.ensureExists();")
  );
  if (
    !(
      initializationIndex >= 0 &&
      initializationIndex < fileIndex &&
      fileIndex >= 0 &&
      fileIndex < pendingClearIndex &&
      pendingClearIndex < cleanBarrierIndex &&
      cleanBarrierIndex < pendingLimitIndex &&
      pendingLimitIndex < publishedEpochIndex
    )
  ) {
    problems.push("saveDiskCache must initialize before capture and join a pending clear before a clean-cache return");
  }
  if (
    !(
      publishedEpochIndex >= 0 &&
      publishedEpochIndex < snapshotIndex &&
      snapshotIndex < pendingIncrementIndex &&
      pendingIncrementIndex < writeIndex &&
      writeIndex < trackedWriteIndex
    )
  ) {
    problems.push("saveDiskCache must capture epoch and cacheSnapshot before enqueue");
  }
  const awaitOutsideNestedFunction = (node: ts.Node): boolean => {
    let found = false;
    const visit = (child: ts.Node): void => {
      if (found) return;
      if (
        child !== node &&
        (ts.isArrowFunction(child) ||
          ts.isFunctionExpression(child) ||
          ts.isFunctionDeclaration(child) ||
          ts.isMethodDeclaration(child))
      ) {
        return;
      }
      if (ts.isAwaitExpression(child)) {
        found = true;
        return;
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  };
  for (let index = 0; index < snapshotIndex; index += 1) {
    const statement = directStatements[index];
    if (
      statement &&
      index !== initializationIndex &&
      index !== cleanBarrierIndex &&
      awaitOutsideNestedFunction(statement)
    ) {
      problems.push("saveDiskCache must not suspend before taking its invocation-bound snapshot");
    }
  }

  if (
    snapshotDeclarations !== 1 ||
    snapshotInitializer !== "Array.from(this.cache, ([abs, source]) => ({ abs, source }))"
  ) {
    problems.push("saveDiskCache must take one invocation-bound cacheSnapshot");
  }
  if (snapshotInitializer.includes("structuredClone")) {
    problems.push(
      "saveDiskCache snapshot admission must retain immutable entry identities without cloning full bodies"
    );
  }
  if (snapshotInitializerAwaits !== 0) problems.push("saveDiskCache cacheSnapshot must be synchronous");
  if (requestCalls !== 1) problems.push(`saveDiskCache must enqueue one exact snapshot request, found ${requestCalls}`);
  if (snapshotLoops !== 1) problems.push(`saveDiskCacheOnce must iterate cacheSnapshot once, found ${snapshotLoops}`);
  const writeStatementText = directStatements[writeIndex]?.getText(sourceFile) ?? "";
  const pendingWait = writeStatementText.indexOf("if (pendingClear) await pendingClear.promise;");
  const workerCall = writeStatementText.indexOf(
    "await this.saveDiskCacheOnce({ requestedFile: file, publishedEpoch, cacheSnapshot });"
  );
  if (
    !writeStatementText.includes("this.cachePublishChain.then(async () =>") ||
    pendingWait < 0 ||
    workerCall < 0 ||
    pendingWait > workerCall
  ) {
    problems.push("saveDiskCache must join its captured clear before the queued snapshot worker");
  }
  const trackedWriteText = directStatements[trackedWriteIndex]?.getText(sourceFile) ?? "";
  if (
    !trackedWriteText.includes("write.finally(() =>") ||
    !trackedWriteText.includes("this.pendingCacheSaveRequests -= 1;") ||
    !saveMethod.getText(sourceFile).includes("this.cachePublishChain = trackedWrite.catch(() => {});")
  ) {
    problems.push("saveDiskCache must release bounded request admission on every worker outcome");
  }
  if (!workerMethod.getText(sourceFile).includes("this.cache.get(abs) === source")) {
    problems.push("saveDiskCacheOnce must not delete a replacement cache generation");
  }
  if (!workerMethod.getText(sourceFile).includes("!this.cacheDirty")) {
    problems.push("saveDiskCacheOnce must skip a request invalidated by an earlier queued clear");
  }
  const workerText = workerMethod.getText(sourceFile);
  if (!workerText.includes("cacheSourceReceiptsEqual(cacheSourceReceipt(liveStat), cached.sourceReceipt)")) {
    problems.push("saveDiskCacheOnce must bind a persisted snapshot to the full live source receipt");
  }
  const oversizeAdmission = workerText.indexOf("let oversized = serializedBytes > this.maxDiskCacheBytes;");
  const oversizeBranch = workerText.indexOf("if (oversized) {", oversizeAdmission);
  const oversizeErase = workerText.indexOf("await this.clearDiskCacheCoordinated({ requestedFile });", oversizeBranch);
  const oversizeThrow = workerText.indexOf("throw new Error(", oversizeErase);
  if (
    !(
      oversizeAdmission >= 0 &&
      oversizeAdmission < oversizeBranch &&
      oversizeBranch < oversizeErase &&
      oversizeErase < oversizeThrow
    )
  ) {
    problems.push("saveDiskCacheOnce must erase the older generation and reject an oversized snapshot");
  }
  const graphPreflight = workerText.indexOf(
    "const measurement = measureBoundedDiskCacheJson(entry, this.maxDiskCacheBytes - serializedBytes - delimiterBytes);"
  );
  const invalidGraph = workerText.indexOf('if (measurement.kind === "invalid") continue;', graphPreflight);
  const overBudgetGraph = workerText.indexOf('if (measurement.kind === "over-budget") {', invalidGraph);
  const entrySerialization = workerText.indexOf("const fragment = JSON.stringify(entry);");
  const utf8Count = workerText.indexOf('const measuredFragmentBytes = Buffer.byteLength(fragment, "utf8");');
  const measurementAgreement = workerText.indexOf("measuredFragmentBytes !== measurement.bytes", utf8Count);
  const capBeforeRetain = workerText.indexOf("if (serializedBytes + fragmentBytes > this.maxDiskCacheBytes)");
  const retainFragment = workerText.indexOf("fragments.push(delimiter, fragment);");
  const overflowContinue = workerText.indexOf("if (oversized) continue;");
  if (
    !(
      overflowContinue >= 0 &&
      overflowContinue < graphPreflight &&
      graphPreflight < invalidGraph &&
      invalidGraph < overBudgetGraph &&
      overBudgetGraph < entrySerialization &&
      entrySerialization < utf8Count &&
      utf8Count < measurementAgreement &&
      measurementAgreement < capBeforeRetain &&
      capBeforeRetain < retainFragment
    )
  ) {
    problems.push("saveDiskCacheOnce must preflight one entry and enforce its UTF-8 cap before retaining bytes");
  }
  if (workerText.includes("JSON.stringify(cacheSnapshot)") || workerText.includes("JSON.stringify(payload)")) {
    problems.push("saveDiskCacheOnce must not materialize the whole cache graph before its byte cap");
  }
  if (workerText.includes("break;")) {
    problems.push("saveDiskCacheOnce must continue stale/private cleanup after detecting byte overflow");
  }
  if (!source.includes('if (seen.has(value)) return "invalid";')) {
    problems.push("disk-cache JSON preflight must reject cycles and repeated alias identities");
  }
  if (
    !source.includes("function measureJsonStringBytes(value: string, maxBytes: number)") ||
    !source.includes("const measured = measureJsonStringBytes(value, maxBytes - bytes);") ||
    !source.includes("code >= 0xd800 && code <= 0xdbff") ||
    !source.includes("additional > maxBytes - bytes")
  ) {
    problems.push("disk-cache JSON preflight must count escaped UTF-8 string bytes before serialization");
  }
  if (
    !source.includes('if (value.length > MAX_DISK_CACHE_JSON_VALUES - inspectedValues) return "invalid";') ||
    !source.includes('if (inspectedValues >= MAX_DISK_CACHE_JSON_VALUES) return "invalid";')
  ) {
    problems.push("disk-cache JSON preflight must reject over-wide containers before retaining their children");
  }
  const clearText = clearMethod.getText(sourceFile);
  const clearFile = clearText.indexOf("let file = this.cacheFile;");
  const clearResolution = clearText.indexOf("if (!file) file = await this.cacheFileForErasure();");
  const clearNoTarget = clearText.indexOf("if (!file) return false;");
  const clearMap = clearText.indexOf("this.cache = new Map();");
  const clearGeneration = clearText.indexOf("this.cacheGeneration += 1;");
  const clearRequest = clearText.indexOf("const request: DiskCacheClearRequest = { requestedFile: file };");
  const clearEnqueue = clearText.indexOf("this.clearDiskCacheCoordinated(request)");
  if (
    !(
      clearFile >= 0 &&
      clearFile < clearResolution &&
      clearResolution < clearNoTarget &&
      clearNoTarget < clearMap &&
      clearMap < clearGeneration &&
      clearGeneration < clearRequest &&
      clearRequest < clearEnqueue
    )
  ) {
    problems.push(
      "clearDiskCache must admit an already-known target without suspension and rotate memory before enqueueing erasure"
    );
  }
  if (
    !source.includes("this.cacheFileValue = opts.cacheFile === undefined ? null : path.resolve(opts.cacheFile);") ||
    !source.includes("const normalized = file === null ? null : path.resolve(file);")
  ) {
    problems.push("cache-file constructor and setter admissions must normalize lexical aliases");
  }
  const clearSet = clearText.indexOf("this.pendingCacheClears.set(file, { request, promise: clear });");
  const clearSuccess = clearText.indexOf("this.pendingCacheClears.get(file)?.request === request");
  const clearDelete = clearText.indexOf("this.pendingCacheClears.delete(file)", clearSuccess);
  const clearFailure = clearText.indexOf("// Keep the rejected barrier as a fail-closed tombstone.");
  if (
    !(clearEnqueue < clearSet && clearSet < clearSuccess && clearSuccess < clearDelete && clearDelete < clearFailure)
  ) {
    problems.push("clearDiskCache must remove only the still-current same-family tombstone after a successful retry");
  }
  const failureTail = clearFailure < 0 ? "" : clearText.slice(clearFailure);
  if (failureTail.includes("this.pendingCacheClears.delete(")) {
    problems.push("clearDiskCache must retain a rejected erasure barrier until an explicit retry succeeds");
  }
  const loadText = loadMethod.getText(sourceFile);
  const loadGeneration = loadText.indexOf("const { requestedFile, acceptedGeneration } = request;");
  const loadPendingClear = loadText.indexOf("const pendingClear = this.pendingCacheClears.get(requestedFile);");
  const loadClearWait = loadText.indexOf("await pendingClear.promise;");
  const loadDiskRead = loadText.indexOf("const stat = await this.statSafe(file);");
  if (
    !(
      loadGeneration >= 0 &&
      loadGeneration < loadPendingClear &&
      loadPendingClear < loadClearWait &&
      loadClearWait < loadDiskRead
    ) ||
    loadText.split("this.cacheGeneration !== acceptedGeneration || this.cacheFile !== requestedFile").length - 1 < 3
  ) {
    problems.push("loadDiskCache must join an accepted clear before reading and bind every commit to its generation");
  }
  if (!source.includes("if (this.cacheFileValue !== null) return this.cacheFileValue;")) {
    problems.push(
      "default cache-path erasure resolution must preserve a setter that wins while resolution is suspended"
    );
  }
  if (!loadText.includes("cacheSourceReceiptsEqual(cacheSourceReceipt(s), entry.sourceReceipt)")) {
    problems.push("loadDiskCache must reject persisted bodies from a different source receipt");
  }
  const readText = readPolicyMethod.getText(sourceFile);
  if (
    !readText.includes("const acceptedGeneration = this.cacheGeneration;") ||
    !readText.includes("if (useCache && this.cacheGeneration === acceptedGeneration) this.cacheSet(abs, entry);")
  ) {
    problems.push("readNoteWithCachePolicy must not populate a cache generation retired while its read was suspended");
  }
  if (
    !readText.includes("cacheSourceReceiptsEqual(cached.sourceReceipt, sourceReceipt)") ||
    !readText.includes("cacheSourceReceiptsEqual(sourceReceipt, cacheSourceReceipt(afterStat))")
  ) {
    problems.push("readNoteWithCachePolicy must bind both cache hits and newly read bytes to a full source receipt");
  }
  const freshClone = readText.indexOf("const detached = cloneCachedNote(entry);");
  const freshCache = readText.indexOf("this.cacheSet(abs, entry);", freshClone);
  const freshReturn = readText.indexOf("return detached;", freshCache);
  if (
    !readText.includes("return cloneCachedNote(cached);") ||
    !(freshClone >= 0 && freshClone < freshCache && freshCache < freshReturn)
  ) {
    problems.push("readNoteWithCachePolicy must return detached snapshots on both cache-hit and fresh-read paths");
  }
  if (
    !source.includes("parsed: cloneBoundedParsedNote(entry.parsed)") ||
    source.includes("structuredClone(entry.parsed)") ||
    !source.includes('if (active.has(value)) throw new Error("Parsed note contains a cyclic value");') ||
    !source.includes("const prior = clones.get(value);") ||
    !source.includes("inspectedValues > MAX_DISK_CACHE_JSON_VALUES")
  ) {
    problems.push("detached parsed-note clones must be bounded, alias-preserving, and cycle-rejecting");
  }
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
    if (
      !(firstPreflight >= 0 && firstPreflight < loader && loader < lastPreflight && lastPreflight < constructorOffset)
    ) {
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
  let bindingProbes = 0;
  let diagnosticSnapshots = 0;
  let literalImports = 0;
  let sharedLoaderCalls = 0;
  const unexpectedConstructors: string[] = [];
  for (const { file, source } of productionTypeScriptSources(overrides)) {
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const databaseBindings = new Set<string>();
    if (file === "src/fts5.ts" || file === "src/embed-db.ts") {
      databaseBindings.add("Ctor");
      databaseBindings.add("Database");
    }
    let addedBinding = true;
    while (addedBinding) {
      addedBinding = false;
      const collectAliases = (node: ts.Node): void => {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer &&
          ts.isIdentifier(node.initializer) &&
          databaseBindings.has(node.initializer.text) &&
          !databaseBindings.has(node.name.text)
        ) {
          databaseBindings.add(node.name.text);
          addedBinding = true;
        }
        ts.forEachChild(node, collectAliases);
      };
      collectAliases(sourceFile);
    }
    const allowedDiskConstructors = new Set(
      SQLITE_NATIVE_OPEN_ROUTES.filter((route) => route.file === file).map((route) => route.constructorNeedle)
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === "better-sqlite3"
      ) {
        literalImports += 1;
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text === "better-sqlite3"
      ) {
        literalImports += 1;
      }
      if (ts.isIdentifier(node) && node.text === "loadBetterSqlite") {
        if (ts.isFunctionDeclaration(node.parent) && node.parent.name === node) {
          // Canonical loader declaration.
        } else if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
          sharedLoaderCalls += 1;
        } else {
          unexpectedConstructors.push(`${file}: loadBetterSqlite binding escapes a direct call`);
        }
      }
      if (ts.isNewExpression(node)) {
        const constructorText = node.expression.getText(sourceFile);
        const firstArgument = node.arguments?.[0]?.getText(sourceFile);
        if (databaseBindings.has(constructorText)) {
          if (allowedDiskConstructors.has(node.getText(sourceFile))) diskConstructors += 1;
          else unexpectedConstructors.push(`${file}:${node.getText(sourceFile)}`);
        } else if (constructorText === "ctor" && firstArgument === '":memory:"') {
          bindingProbes += 1;
        } else if (
          file === "src/doctor.ts" &&
          constructorText === "Database" &&
          (firstArgument === '":memory:"' || firstArgument === "sourceBytes")
        ) {
          diagnosticSnapshots += 1;
        } else if (constructorText === "ctor") {
          unexpectedConstructors.push(`${file}:${constructorText}(${firstArgument ?? ""})`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  if (diskConstructors !== 7) problems.push(`SQLite disk-constructor census expected 7, found ${diskConstructors}`);
  if (bindingProbes !== 2) problems.push(`SQLite binding-probe census expected 2, found ${bindingProbes}`);
  if (diagnosticSnapshots !== 2) {
    problems.push(`SQLite diagnostic-snapshot census expected 2, found ${diagnosticSnapshots}`);
  }
  if (literalImports !== 6) problems.push(`SQLite literal-import census expected 6, found ${literalImports}`);
  if (sharedLoaderCalls !== 4) problems.push(`SQLite shared-loader census expected 4, found ${sharedLoaderCalls}`);
  problems.push(...unexpectedConstructors.map((site) => `SQLite unexpected constructor ${site}`));
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
        const expectedOccurrences = requirement.needleOccurrences?.[needle] ?? 1;
        const actualOccurrences = body.split(needle).length - 1;
        if (actualOccurrences !== expectedOccurrences) {
          problems.push(
            `${entry.id}:${role}:${requirement.file}#${requirement.member} expected ${expectedOccurrences} ${needle}, found ${actualOccurrences}`
          );
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
    requirement.needles.flatMap((needle) => {
      const expectedOccurrences = requirement.needleOccurrences?.[needle] ?? 1;
      return Array.from({ length: expectedOccurrences }, (_, occurrenceIndex) => ({
        id: entry.id,
        role: requirementIndex === 0 ? "publisher" : "eraser",
        file: requirement.file,
        member: requirement.member,
        needle,
        occurrenceIndex,
        occurrenceNumber: occurrenceIndex + 1,
        expectedOccurrences
      }));
    })
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

  it.for(SENSITIVE_READER_INVENTORY)(
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
      const unboundedBody = replaceExactly(body, exactCall, `readSensitiveArtifactText(${directArgument})`, calls);
      const unboundedSource = replaceExactly(source, body, unboundedBody);
      expect(sensitiveReaderRouteProblems(unboundedSource, file, member, calls, exactCall)).not.toEqual([]);
    }
  );

  it("bounds a held-descriptor sensitive-artifact hash before processing oversized bytes", async () => {
    const file = path.join(cacheDir, "bounded-hash.bin");
    await fs.writeFile(file, "ABCD");
    await expect(sha256SensitiveArtifact(file, 3)).rejects.toThrow(/bounded hash limit/);
    await expect(sha256SensitiveArtifact(file, 4)).resolves.toMatch(/^[0-9a-f]{64}$/);
    await expect(sha256SensitiveArtifact(file, -1)).rejects.toThrow(RangeError);
  });

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

  it.for([{ kind: "regular file" as const }, { kind: "symlink" as const }, { kind: "Unix-domain socket" as const }])(
    "sensitive reader enforces the $kind leaf contract",
    async ({ kind }, { skip }) => {
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
    }
  );

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
        const realStat = handle.stat.bind(handle) as (options: {
          bigint: true;
        }) => Promise<import("node:fs").BigIntStats>;
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

  it.for([{ kind: "missing" as const }, { kind: "regular file" as const }, { kind: "symlink" as const }])(
    "publisher admits a $kind final leaf",
    async ({ kind }, { skip }) => {
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
    }
  );

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

  it.for([
    { family: "generated temp", hnsw: false },
    { family: "HNSW generation", hnsw: true }
  ])("folded-name hardlinks cannot impersonate a $family erasure target", async ({ hnsw }, { skip }) => {
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
  });

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
      // Persistence scopes canonicalize their target basename to NFC. Keep the
      // authorized spelling NFC while the physical generation uses the native
      // equivalent NFD/case alias, so this still exercises all three axes.
      const canonicalBaseName = "Caf\u00e9\nCustom.hnsw";
      const actualBaseName = canonicalBaseName.normalize("NFD");
      const configuredBaseName = canonicalBaseName.toLowerCase();
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

      const configuredBase = path.join(cacheDir, configuredBaseName);
      const embedTarget = `${configuredBase.slice(0, -".hnsw".length)}.embed.db`;
      const lifetime = await acquirePersistenceFamilyLease({
        targetPath: embedTarget,
        familyKey: SEMANTIC_PERSISTENCE_FAMILY_KEY,
        role: "shared"
      });
      try {
        await expect(clearHnswPersistedArtifacts(configuredBase, lifetime.scopes)).resolves.toBe(true);
        await expect(fs.lstat(actualGeneration)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await lifetime.release();
      }
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

    it.each(["all enumerated shared sensitive-artifact helper call sites"])("helper-route census accepts %s", () => {
      expect(sensitiveArtifactHelperCensusProblems()).toEqual([]);
    });

    it.each([
      {
        file: "src/feedback.ts",
        helper: "publisher",
        addition:
          '\nexport async function unlistedSensitivePublisher(file: string): Promise<void> { await publishSensitiveArtifact(file, "bytes"); }\n',
        expected: "publishSensitiveArtifact:src/feedback.ts#unlistedSensitivePublisher"
      },
      {
        file: "src/feedback.ts",
        helper: "reader",
        addition:
          "\nexport async function unlistedSensitiveReader(file: string): Promise<string> { return readSensitiveArtifactText(file, 1); }\n",
        expected: "readSensitiveArtifactText:src/feedback.ts#unlistedSensitiveReader"
      },
      {
        file: "src/hnsw.ts",
        helper: "held-descriptor inspector",
        addition:
          "\nasync function unlistedSensitiveInspector(file: string): Promise<bigint> { return inspectSensitiveArtifact(file, 1, async (_handle, size) => size); }\n",
        expected: "inspectSensitiveArtifact:src/hnsw.ts#unlistedSensitiveInspector"
      },
      {
        file: "src/hnsw.ts",
        helper: "bounded hasher",
        addition:
          "\nasync function unlistedSensitiveHasher(file: string): Promise<string> { return sha256SensitiveArtifact(file, 1); }\n",
        expected: "sha256SensitiveArtifact:src/hnsw.ts#unlistedSensitiveHasher"
      }
    ])("helper-route census rejects a future unlisted $helper", ({ file, addition, expected }) => {
      const source = readFileSync(path.join(repoRoot, file), "utf8");
      const problems = sensitiveArtifactHelperCensusProblems(new Map([[file, `${source}${addition}`]]));
      expect(problems.some((problem) => problem.startsWith(`${expected}: inventory expected 0`))).toBe(true);
    });

    it.each([
      { file: "src/hnsw.ts", helper: "inspectSensitiveArtifact" },
      { file: "src/feedback.ts", helper: "publishSensitiveArtifact" },
      { file: "src/feedback.ts", helper: "readSensitiveArtifactText" },
      { file: "src/hnsw.ts", helper: "sha256SensitiveArtifact" }
    ] as const)("helper-route census rejects a $helper binding escape", ({ file, helper }) => {
      const source = readFileSync(path.join(repoRoot, file), "utf8");
      const addition = `\nexport function escapedSensitiveHelper(): unknown { const alias = ${helper}; return alias; }\n`;
      const problems = sensitiveArtifactHelperCensusProblems(new Map([[file, `${source}${addition}`]]));
      expect(problems.some((problem) => problem.includes(`${helper} escapes a direct helper call`))).toBe(true);
    });

    it("HNSW persistence binds held-descriptor preflight, exact caps, and native-load order", () => {
      const source = readFileSync(path.join(repoRoot, "src/hnsw.ts"), "utf8");
      expect(hnswArtifactBoundaryProblems(source)).toEqual([]);
      expect(hnswPublisherBoundaryProblems(source)).toEqual([]);
    });

    it.each([
      {
        mutant: "preflight loses the exact generation cap",
        apply: (source: string) =>
          replaceExactly(
            source,
            "inspectSensitiveArtifact(file, MAX_HNSW_GENERATION_BYTES, async (handle, fileSize) =>",
            "inspectSensitiveArtifact(file, Number.MAX_SAFE_INTEGER, async (handle, fileSize) =>"
          )
      },
      {
        mutant: "header parsing escapes the inspector-held descriptor",
        apply: (source: string) =>
          replaceExactly(
            source,
            "readHeldBytes(handle, HNSW_NATIVE_HEADER_BYTES, 0)",
            'readHeldBytes(await fs.open(file, "r"), HNSW_NATIVE_HEADER_BYTES, 0)'
          )
      },
      {
        mutant: "pre-native path hash is unbounded",
        apply: (source: string) =>
          replaceExactly(
            source,
            "sha256SensitiveArtifact(binFile, MAX_HNSW_GENERATION_BYTES)",
            "sha256SensitiveArtifact(binFile, Number.MAX_SAFE_INTEGER)",
            2
          )
      },
      {
        mutant: "held-descriptor digest no longer authorizes the path bytes",
        apply: (source: string) => replaceExactly(source, "digestBefore !== admittedHeader.sha256", "false")
      },
      {
        mutant: "native reader bypasses the admitted private snapshot",
        apply: (source: string) =>
          replaceExactly(
            source,
            "ctor.readIndex(admittedHeader.nativeSnapshotPath, /* allowReplaceDeleted */ true)",
            "ctor.readIndex(binFile, /* allowReplaceDeleted */ true)"
          )
      },
      {
        mutant: "private snapshot is hidden under an unrecognized child name",
        apply: (source: string) =>
          replaceExactly(
            source,
            'path.join(nativeSnapshotDirectory, "artifact")',
            'path.join(nativeSnapshotDirectory, "generation.bin")'
          )
      },
      {
        mutant: "loader strands the admitted private snapshot",
        apply: (source: string) =>
          replaceExactly(
            source,
            "await removeHnswNativeSnapshot(admittedHeader).catch(() => {});",
            "await Promise.resolve(admittedHeader);"
          )
      },
      {
        mutant: "inspector post-callback rejection strands its snapshot",
        apply: (source: string) =>
          replaceExactly(
            source,
            "if (admittedSnapshot) await removeHnswNativeSnapshot(admittedSnapshot).catch(() => {});",
            "if (admittedSnapshot) await Promise.resolve(admittedSnapshot);"
          )
      },
      {
        mutant: "native preflight loses DB-canonical vector authority",
        apply: (source: string) =>
          replaceExactly(
            source,
            "      expectedLabels,\n      expectedVectorsByLabel\n    );",
            "      expectedLabels,\n      new Map()\n    );"
          )
      },
      {
        mutant: "native semantic admission ignores accumulated angular drift",
        apply: (source: string) =>
          replaceExactly(source, "Math.sqrt(dbDistanceSquared) > HNSW_DB_VECTOR_L2_TOLERANCE", "dbDistanceSquared < 0")
      },
      {
        mutant: "native loader omits decoded trusted vectors from its combined envelope",
        apply: (source: string) => replaceExactly(source, "trustedVectorBytes * 3n +", "0n +")
      }
    ])("HNSW artifact-boundary invariant rejects $mutant", ({ apply }) => {
      const source = readFileSync(path.join(repoRoot, "src/hnsw.ts"), "utf8");
      expect(hnswArtifactBoundaryProblems(source)).toEqual([]);
      expect(hnswArtifactBoundaryProblems(apply(source))).not.toEqual([]);
    });

    it.each([
      {
        mutant: "native generation publisher drops its exact cap",
        apply: (source: string) =>
          replaceExactly(
            source,
            "              MAX_HNSW_GENERATION_BYTES\n            );",
            "              Number.MAX_SAFE_INTEGER\n            );"
          )
      },
      {
        mutant: "metadata pointer publisher drops its exact cap",
        apply: (source: string) =>
          replaceExactly(
            source,
            "publishSensitiveArtifact(metaFile, serializedMeta, MAX_HNSW_META_BYTES)",
            "publishSensitiveArtifact(metaFile, serializedMeta)"
          )
      },
      {
        mutant: "metadata pre-measurement uses a different limit",
        apply: (source: string) =>
          replaceExactly(
            source,
            'Buffer.byteLength(projectedSerializedMeta, "utf8") > MAX_HNSW_META_BYTES',
            'Buffer.byteLength(projectedSerializedMeta, "utf8") > Number.MAX_SAFE_INTEGER'
          )
      },
      {
        mutant: "v4 pointer reintroduces raw row metadata",
        apply: (source: string) =>
          replaceExactly(
            source,
            "            writtenAt\n          };",
            "            writtenAt,\n            rowsByLabel\n          };"
          )
      },
      {
        mutant: "v4 pointer drops the physical DB generation",
        apply: (source: string) =>
          replaceExactly(
            source,
            "dbInstanceUuid: generationAuthority.dbInstanceUuid",
            'dbInstanceUuid: "00000000000000000000000000000000"'
          )
      },
      {
        mutant: "v4 pointer drops the durable DB epoch",
        apply: (source: string) =>
          replaceExactly(source, "dbMutationEpoch: generationAuthority.dbMutationEpoch", "dbMutationEpoch: 1")
      }
    ])("HNSW publisher invariant rejects $mutant", ({ apply }) => {
      const source = readFileSync(path.join(repoRoot, "src/hnsw.ts"), "utf8");
      expect(hnswPublisherBoundaryProblems(source)).toEqual([]);
      expect(hnswPublisherBoundaryProblems(apply(source))).not.toEqual([]);
    });

    it("server publishes HNSW only from receipt-matched database snapshots", () => {
      const source = readFileSync(path.join(repoRoot, "src/server.ts"), "utf8");
      expect(hnswServerAtomicityProblems(source)).toEqual([]);
    });

    it.each([
      {
        mutant: "load row authority is captured by a second SQLite snapshot",
        apply: (source: string) =>
          replaceExactly(
            source,
            "expectedRowsByLabel: beforeLoad.rowsByLabel",
            "expectedRowsByLabel: db.captureHnswReceiptSnapshot().rowsByLabel"
          )
      },
      {
        mutant: "load vector authority is captured by a second SQLite snapshot",
        apply: (source: string) =>
          replaceExactly(
            source,
            "expectedVectorsByLabel: beforeLoad.vectorsByLabel",
            "expectedVectorsByLabel: db.captureHnswLoadSnapshot().vectorsByLabel"
          )
      },
      {
        mutant: "load UUID authority is captured by a second SQLite snapshot",
        apply: (source: string) =>
          replaceExactly(
            source,
            "expectedDbInstanceUuid: beforeLoad.receipt.dbInstanceUuid",
            "expectedDbInstanceUuid: db.captureHnswReceiptSnapshot().receipt.dbInstanceUuid"
          )
      },
      {
        mutant: "load epoch authority is captured by a second SQLite snapshot",
        apply: (source: string) =>
          replaceExactly(
            source,
            "expectedDbMutationEpoch: beforeLoad.receipt.dbMutationEpoch",
            "expectedDbMutationEpoch: db.captureHnswReceiptSnapshot().receipt.dbMutationEpoch"
          )
      },
      {
        mutant: "build vectors are captured by a second SQLite snapshot",
        apply: (source: string) =>
          replaceExactly(
            source,
            "const rows = buildSnapshot.vectors;",
            "const rows = db.captureHnswBuildSnapshot().vectors;"
          )
      },
      {
        mutant: "loaded candidate trusts sidecar row metadata",
        apply: (source: string) =>
          replaceExactly(source, "rowByLabel: afterLoad.rowsByLabel", "rowByLabel: loadResult.rowsByLabel")
      },
      {
        mutant: "loaded candidate bypasses its post-load receipt compare",
        apply: (source: string) =>
          replaceExactly(source, "if (sameHnswPersistenceReceipt(beforeLoad.receipt, afterLoad.receipt))", "if (true)")
      },
      {
        mutant: "built candidate bypasses its post-build receipt compare",
        apply: (source: string) =>
          replaceExactly(
            source,
            "if (!sameHnswPersistenceReceipt(buildSnapshot.receipt, afterAsync.receipt))",
            "if (false)"
          )
      },
      {
        mutant: "built candidate bypasses its post-persist receipt compare",
        apply: (source: string) =>
          replaceExactly(
            source,
            "if (sameHnswPersistenceReceipt(afterAsync.receipt, afterPersist.receipt))",
            "if (true)"
          )
      },
      {
        mutant: "persisted pointer uses a stale pre-build DB generation",
        apply: (source: string) =>
          replaceExactly(
            source,
            "dbInstanceUuid: afterAsync.receipt.dbInstanceUuid",
            "dbInstanceUuid: buildSnapshot.receipt.dbInstanceUuid"
          )
      },
      {
        mutant: "published context omits the receipt epoch",
        apply: (source: string) =>
          replaceExactly(source, "dbMutationEpoch: candidate.receipt.dbMutationEpoch", "dbMutationEpoch: undefined")
      },
      {
        mutant: "built candidate suspends after its final receipt check",
        apply: (source: string) =>
          replaceExactly(
            source,
            "if (sameHnswPersistenceReceipt(afterAsync.receipt, afterPersist.receipt)) {",
            "if (sameHnswPersistenceReceipt(afterAsync.receipt, afterPersist.receipt)) {\n                  await Promise.resolve();"
          )
      }
    ])("server HNSW atomicity invariant rejects $mutant", ({ apply }) => {
      const source = readFileSync(path.join(repoRoot, "src/server.ts"), "utf8");
      expect(hnswServerAtomicityProblems(source)).toEqual([]);
      expect(hnswServerAtomicityProblems(apply(source))).not.toEqual([]);
    });

    it("watcher sends DB-canonical vectors to HNSW for Markdown and PDF generations", () => {
      const source = readFileSync(path.join(repoRoot, "src/watcher.ts"), "utf8");
      expect(watcherCanonicalVectorProblems(source)).toEqual([]);
    });

    it("watcher canonical-vector invariant rejects an input-vector regression", () => {
      const source = readFileSync(path.join(repoRoot, "src/watcher.ts"), "utf8");
      const bodies = runtimeMemberBodies(source, "src/watcher.ts", "upsertEmbedAndSyncHnsw");
      expect(bodies).toHaveLength(1);
      const body = bodies[0] ?? "";
      const mutantBody = replaceExactly(
        body,
        "zipHnswAddPoints(rows, mutation.newIds, mutation.newVectors)",
        "zipHnswAddPoints(rows, mutation.newIds, rows.map((row) => row.vector))"
      );
      const mutant = replaceExactly(source, body, mutantBody);
      expect(watcherCanonicalVectorProblems(source)).toEqual([]);
      expect(watcherCanonicalVectorProblems(mutant)).not.toEqual([]);
    });

    it.each([
      { kind: "Markdown", member: "commitMarkdownGeneration" },
      { kind: "PDF", member: "commitPdfGeneration" }
    ])("watcher canonical-vector invariant rejects bypassing the $kind helper", ({ member }) => {
      const source = readFileSync(path.join(repoRoot, "src/watcher.ts"), "utf8");
      const bodies = runtimeMemberBodies(source, "src/watcher.ts", member);
      expect(bodies).toHaveLength(1);
      const body = bodies[0] ?? "";
      const mutantBody = replaceExactly(
        body,
        "this.upsertEmbedAndSyncHnsw(",
        "this.embedDb.upsertNoteWithCanonicalVectors("
      );
      const mutant = replaceExactly(source, body, mutantBody);
      expect(watcherCanonicalVectorProblems(source)).toEqual([]);
      expect(watcherCanonicalVectorProblems(mutant)).not.toEqual([]);
    });

    it("EmbedDb captures HNSW labels, payload bytes, and receipt in one transaction", () => {
      const source = readFileSync(path.join(repoRoot, "src/embed-db.ts"), "utf8");
      expect(embedHnswSnapshotProblems(source)).toEqual([]);
    });

    it("EmbedDb generation identity has exact current admission and complete mutation-trigger coverage", () => {
      const source = readFileSync(path.join(repoRoot, "src/embed-db.ts"), "utf8");
      const schemaSource = readFileSync(path.join(repoRoot, "src/schema-contract.ts"), "utf8");
      expect(embedDbGenerationIdentityProblems(source, schemaSource)).toEqual([]);
    });

    it.each([
      {
        mutant: "one durable table leaves the mutation-trigger class",
        apply: (source: string) =>
          replaceExactly(
            source,
            'const MUTATION_EPOCH_TABLES = ["embeddings", "source_state", "source_quarantine", "source_revision"] as const;',
            'const MUTATION_EPOCH_TABLES = ["embeddings", "source_state", "source_quarantine"] as const;'
          )
      },
      {
        mutant: "DELETE leaves the mutation-trigger class",
        apply: (source: string) =>
          replaceExactly(
            source,
            'const MUTATION_EPOCH_OPERATIONS = ["INSERT", "UPDATE", "DELETE"] as const;',
            'const MUTATION_EPOCH_OPERATIONS = ["INSERT", "UPDATE"] as const;'
          )
      },
      {
        mutant: "overflow stops aborting the payload transaction",
        apply: (source: string) =>
          replaceExactly(
            source,
            "THEN RAISE(ABORT, 'embedding mutation epoch is invalid or exhausted') END",
            "THEN 0 END"
          )
      },
      {
        mutant: "current schema stops requiring the complete epoch-trigger inventory",
        apply: (source: string) => replaceExactly(source, "        ...MUTATION_EPOCH_TRIGGER_NAMES\n", "")
      },
      {
        mutant: "reopen rotates the current generation",
        apply: (source: string) => replaceExactly(source, "if (!requiresBootstrap) return;", "if (false) return;")
      },
      {
        mutant: "new databases receive a fixed UUID",
        apply: (source: string) =>
          replaceExactly(
            source,
            'instance_uuid: randomBytes(16).toString("hex")',
            'instance_uuid: "00000000000000000000000000000000"'
          )
      }
    ])("EmbedDb generation invariant rejects $mutant", ({ apply }) => {
      const source = readFileSync(path.join(repoRoot, "src/embed-db.ts"), "utf8");
      const schemaSource = readFileSync(path.join(repoRoot, "src/schema-contract.ts"), "utf8");
      expect(embedDbGenerationIdentityProblems(source, schemaSource)).toEqual([]);
      expect(embedDbGenerationIdentityProblems(apply(source), schemaSource)).not.toEqual([]);
    });

    it.each([
      {
        mutant: "capture callback is no longer a SQLite transaction",
        apply: (source: string) =>
          replaceRuntimeMemberExactly(
            source,
            "src/embed-db.ts",
            "captureHnswSnapshot",
            "const capture = db.transaction(",
            "const capture = ("
          )
      },
      {
        mutant: "live-label manifest hashes a path instead of the native label",
        apply: (source: string) =>
          replaceExactly(
            source,
            "updateManifestValue(liveLabelHash, label)",
            "updateManifestValue(liveLabelHash, metadata.rel_path)"
          )
      },
      {
        mutant: "payload manifest omits raw vector bytes",
        apply: (source: string) =>
          replaceExactly(
            source,
            "updateManifestValue(payloadHash, row.vector)",
            "updateManifestValue(payloadHash, metadata.text_preview)"
          )
      },
      {
        mutant: "source completeness query stops counting physical chunks",
        apply: (source: string) => replaceExactly(source, "COUNT(e.id) AS actual_count", "MAX(e.id) AS actual_count")
      },
      {
        mutant: "authority envelope stops validating source-state scalar cells",
        apply: (source: string) =>
          replaceExactly(
            source,
            "FROM source_state) AS state_invalid_count",
            "FROM source_state) AS ignored_state_cells"
          )
      },
      {
        mutant: "source completeness accepts a missing chunk",
        apply: (source: string) =>
          replaceExactly(source, "state.actual_count !== state.n_chunks", "state.actual_count < 0")
      },
      {
        mutant: "source generation cardinality leaves the payload receipt",
        apply: (source: string) =>
          replaceExactly(
            source,
            "updateManifestValue(payloadHash, state.n_chunks as number)",
            "updateManifestValue(payloadHash, state.rel_path)"
          )
      },
      {
        mutant: "source revision leaves the payload receipt",
        apply: (source: string) =>
          replaceExactly(
            source,
            "updateManifestValue(payloadHash, state.revision as number)",
            "updateManifestValue(payloadHash, state.rel_path)"
          )
      },
      {
        mutant: "aggregate query stops rejecting malformed vector blobs",
        apply: (source: string) =>
          replaceExactly(
            source,
            "CASE WHEN typeof(e.vector) <> 'blob' OR length(e.vector) <> ? THEN 1 ELSE 0 END",
            "CASE WHEN length(e.vector) < 0 THEN 1 ELSE 0 END"
          )
      },
      {
        mutant: "combined working-set envelope omits encoded vector BLOB bytes",
        apply: (source: string) => replaceExactly(source, "BigInt(aggregate.vector_bytes as number) +", "0n +")
      },
      {
        mutant: "combined working-set envelope omits native graph capacity",
        apply: (source: string) =>
          replaceExactly(source, "BigInt(nativeCapacity) * BigInt(nativeBytesPerElement) +", "0n +")
      },
      {
        mutant: "combined working-set cap is disabled",
        apply: (source: string) =>
          replaceExactly(
            source,
            "combinedWorkingSetBytes > BigInt(MAX_HNSW_COMBINED_WORKING_SET_BYTES)",
            "combinedWorkingSetBytes < 0n"
          )
      },
      {
        mutant: "atomic load snapshot drops its DB-canonical vector map",
        apply: (source: string) =>
          replaceExactly(source, 'if (mode === "load") vectorsByLabel.set(label, vector);', "void vectorsByLabel;")
      },
      {
        mutant: "aggregate scalar manifest is no longer fail-closed",
        apply: (source: string) =>
          replaceExactly(source, "aggregate.invalid_scalar_count !== 0", "aggregate.invalid_scalar_count < 0")
      },
      {
        mutant: "receipt exposes a constant instead of its live-label digest",
        apply: (source: string) =>
          replaceExactly(
            source,
            "        liveLabelSha256,\n        dbPayloadSha256",
            '        liveLabelSha256: "stale",\n        dbPayloadSha256'
          )
      },
      {
        mutant: "receipt comparator ignores the raw-payload digest",
        apply: (source: string) => replaceExactly(source, "left.dbPayloadSha256 === right.dbPayloadSha256", "true")
      },
      {
        mutant: "receipt comparator ignores the physical DB generation",
        apply: (source: string) =>
          replaceRuntimeMemberExactly(
            source,
            "src/embed-db.ts",
            "sameHnswPersistenceReceipt",
            "left.dbInstanceUuid === right.dbInstanceUuid",
            "true"
          )
      },
      {
        mutant: "receipt comparator ignores the durable DB epoch",
        apply: (source: string) =>
          replaceRuntimeMemberExactly(
            source,
            "src/embed-db.ts",
            "sameHnswPersistenceReceipt",
            "left.dbMutationEpoch === right.dbMutationEpoch",
            "true"
          )
      }
    ])("EmbedDb HNSW snapshot invariant rejects $mutant", ({ apply }) => {
      const source = readFileSync(path.join(repoRoot, "src/embed-db.ts"), "utf8");
      expect(embedHnswSnapshotProblems(source)).toEqual([]);
      expect(embedHnswSnapshotProblems(apply(source))).not.toEqual([]);
    });

    it.each([
      {
        mutant: "unready save bypasses initialization",
        apply: (source: string) => {
          const bodies = runtimeMemberBodies(source, "src/vault.ts", "saveDiskCacheOperation");
          expect(bodies).toHaveLength(1);
          const body = bodies[0] ?? "";
          const mutantBody = replaceExactly(
            body,
            "if (!this.ready) await this.ensureExists();",
            "if (!this.ready) return;"
          );
          return replaceExactly(source, body, mutantBody);
        }
      },
      {
        mutant: "await inside snapshot initializer",
        apply: (source: string) =>
          replaceExactly(
            source,
            "Array.from(this.cache, ([abs, source]) => ({ abs, source }))",
            "Array.from(await Promise.resolve(this.cache), ([abs, source]) => ({ abs, source }))"
          )
      },
      {
        mutant: "snapshot admission clones every cached parsed graph",
        apply: (source: string) =>
          replaceExactly(
            source,
            "Array.from(this.cache, ([abs, source]) => ({ abs, source }))",
            "Array.from(this.cache, ([abs, source]) => ({ abs, source: structuredClone(source) }))"
          )
      },
      {
        mutant: "standalone suspension before snapshot",
        apply: (source: string) =>
          replaceExactly(
            source,
            "const publishedEpoch = this.cacheEpoch;",
            "await Promise.resolve();\n    const publishedEpoch = this.cacheEpoch;"
          )
      },
      {
        mutant: "non-terminal pending-clear barrier",
        apply: (source: string) =>
          replaceExactly(source, "await pendingClear.promise;\n      return;", "await pendingClear.promise;")
      },
      {
        mutant: "queued snapshot bypasses its accepted clear",
        apply: (source: string) =>
          replaceExactly(
            source,
            "if (pendingClear) await pendingClear.promise;\n      await this.saveDiskCacheOnce({ requestedFile: file, publishedEpoch, cacheSnapshot });",
            "await this.saveDiskCacheOnce({ requestedFile: file, publishedEpoch, cacheSnapshot });"
          )
      },
      {
        mutant: "disk load trusts restored mtime without the source receipt",
        apply: (source: string) =>
          replaceExactly(
            source,
            "cacheSourceReceiptsEqual(cacheSourceReceipt(s), entry.sourceReceipt)",
            "s.mtimeMs === entry.mtimeMs"
          )
      },
      {
        mutant: "disk save trusts restored mtime without the source receipt",
        apply: (source: string) =>
          replaceExactly(
            source,
            "cacheSourceReceiptsEqual(cacheSourceReceipt(liveStat), cached.sourceReceipt)",
            "liveStat.mtimeMs === cached.mtimeMs"
          )
      },
      {
        mutant: "memory hit trusts restored mtime without the source receipt",
        apply: (source: string) =>
          replaceExactly(
            source,
            "cacheSourceReceiptsEqual(cached.sourceReceipt, sourceReceipt)",
            "cached.mtimeMs === sourceReceipt.mtimeMs"
          )
      },
      ...(["dev", "ino", "size", "mtimeMs", "ctimeMs"] as const).map((field) => ({
        mutant: `source-receipt comparator ignores ${field}`,
        apply: (source: string) => {
          const comparatorOffset = source.indexOf("function cacheSourceReceiptsEqual");
          expect(comparatorOffset).toBeGreaterThanOrEqual(0);
          const prefix = source.slice(0, comparatorOffset);
          const comparatorAndTail = source.slice(comparatorOffset);
          return `${prefix}${replaceExactly(comparatorAndTail, `left.${field} === right.${field}`, "true")}`;
        }
      })),
      {
        mutant: "oversized snapshot reports success without erasing the retired disk generation",
        apply: (source: string) =>
          replaceExactly(
            source,
            "await this.clearDiskCacheCoordinated({ requestedFile });\n      throw new Error(",
            "return;\n      throw new Error("
          )
      },
      {
        mutant: "worker materializes the whole cache before the byte cap",
        apply: (source: string) =>
          replaceExactly(
            source,
            "const writtenAt = new Date().toISOString();",
            "JSON.stringify(cacheSnapshot);\n    const writtenAt = new Date().toISOString();"
          )
      },
      {
        mutant: "entry graph is serialized before its bounded-tree preflight",
        apply: (source: string) =>
          replaceExactly(
            source,
            "const measurement = measureBoundedDiskCacheJson(entry, this.maxDiskCacheBytes - serializedBytes - delimiterBytes);",
            "const fragment = JSON.stringify(entry);\n      const measurement = measureBoundedDiskCacheJson(entry, this.maxDiskCacheBytes - serializedBytes - delimiterBytes);"
          )
      },
      {
        mutant: "JSON graph preflight accepts repeated alias identities",
        apply: (source: string) =>
          replaceExactly(source, 'if (seen.has(value)) return "invalid";', 'if (false) return "invalid";')
      },
      {
        mutant: "entry bytes are retained without enforcing the cumulative cap",
        apply: (source: string) =>
          replaceExactly(
            source,
            "if (serializedBytes + fragmentBytes > this.maxDiskCacheBytes)",
            "if (false && serializedBytes + fragmentBytes > this.maxDiskCacheBytes)"
          )
      },
      {
        mutant: "byte overflow stops before later stale cleanup",
        apply: (source: string) =>
          replaceExactly(
            source,
            'if (measurement.kind === "over-budget") {\n        oversized = true;\n        continue;\n      }',
            'if (measurement.kind === "over-budget") {\n        oversized = true;\n        break;\n      }'
          )
      },
      {
        mutant: "entry byte measurement ignores the remaining persistence budget",
        apply: (source: string) =>
          replaceExactly(
            source,
            "measureBoundedDiskCacheJson(entry, this.maxDiskCacheBytes - serializedBytes - delimiterBytes)",
            "measureBoundedDiskCacheJson(entry, Number.MAX_SAFE_INTEGER)"
          )
      },
      {
        mutant: "entry cap counts UTF-16 code units instead of UTF-8 bytes",
        apply: (source: string) => replaceExactly(source, 'Buffer.byteLength(fragment, "utf8")', "fragment.length")
      },
      {
        mutant: "string byte meter ignores JSON escaping and UTF-8 width",
        apply: (source: string) =>
          replaceExactly(
            source,
            "const measured = measureJsonStringBytes(value, maxBytes - bytes);",
            "const measured = value.length + 2;"
          )
      },
      {
        mutant: "wide arrays allocate traversal work beyond the value budget",
        apply: (source: string) =>
          replaceExactly(
            source,
            'if (value.length > MAX_DISK_CACHE_JSON_VALUES - inspectedValues) return "invalid";',
            'if (false) return "invalid";'
          )
      },
      {
        mutant: "clear keeps the retired memory map",
        apply: (source: string) => replaceExactly(source, "this.cache = new Map();", "this.cache.clear();")
      },
      {
        mutant: "disk load loses one generation receipt",
        apply: (source: string) =>
          replaceExactly(
            source,
            "this.cacheGeneration !== acceptedGeneration || this.cacheFile !== requestedFile",
            "this.cacheFile !== requestedFile",
            3
          )
      },
      {
        mutant: "disk load bypasses an accepted clear",
        apply: (source: string) =>
          replaceExactly(
            source,
            "if (pendingClear) {\n      await pendingClear.promise;\n      if (this.cacheGeneration !== acceptedGeneration || this.cacheFile !== requestedFile) return 0;\n    }",
            "if (pendingClear) return 0;"
          )
      },
      {
        mutant: "known cache target suspends through the erasure resolver",
        apply: (source: string) =>
          replaceExactly(
            source,
            "let file = this.cacheFile;\n    if (!file) file = await this.cacheFileForErasure();",
            "const file = await this.cacheFileForErasure();"
          )
      },
      {
        mutant: "cache-file setter preserves a lexical alias",
        apply: (source: string) =>
          replaceExactly(
            source,
            "const normalized = file === null ? null : path.resolve(file);",
            "const normalized = file;"
          )
      },
      {
        mutant: "failed erasure deletes its fail-closed tombstone",
        apply: (source: string) =>
          replaceExactly(
            source,
            "// Keep the rejected barrier as a fail-closed tombstone.",
            "// Keep the rejected barrier as a fail-closed tombstone.\n        this.pendingCacheClears.delete(file);"
          )
      },
      {
        mutant: "an earlier successful clear deletes a later same-family barrier",
        apply: (source: string) =>
          replaceExactly(
            source,
            "if (this.pendingCacheClears.get(file)?.request === request) this.pendingCacheClears.delete(file);",
            "this.pendingCacheClears.delete(file);"
          )
      },
      {
        mutant: "default cache resolution overwrites a concurrent explicit retarget",
        apply: (source: string) =>
          replaceExactly(source, "if (this.cacheFileValue !== null) return this.cacheFileValue;", "")
      },
      {
        mutant: "pending cache-save admission is unbounded",
        apply: (source: string) =>
          replaceExactly(source, "if (this.pendingCacheSaveRequests >= MAX_PENDING_DISK_CACHE_SAVES)", "if (false)")
      },
      {
        mutant: "completed cache saves retain their admission slot",
        apply: (source: string) => replaceExactly(source, "this.pendingCacheSaveRequests -= 1;", "")
      },
      {
        mutant: "readNote bypasses the cached-policy delegate",
        apply: (source: string) =>
          replaceExactly(
            source,
            "return this.readNoteWithCachePolicy(relOrAbs, knownMtimeMs, true);",
            "return this.readNoteWithCachePolicy(relOrAbs, knownMtimeMs, false);"
          )
      },
      {
        mutant: "read populates a retired generation",
        apply: (source: string) =>
          replaceExactly(
            source,
            "if (useCache && this.cacheGeneration === acceptedGeneration) this.cacheSet(abs, entry);",
            "if (useCache) this.cacheSet(abs, entry);"
          )
      },
      {
        mutant: "cache hit exposes the mutable internal entry",
        apply: (source: string) => replaceExactly(source, "return cloneCachedNote(cached);", "return cached;")
      },
      {
        mutant: "fresh read exposes the entry stored in the cache",
        apply: (source: string) =>
          replaceExactly(source, "const detached = cloneCachedNote(entry);", "const detached = entry;")
      },
      {
        mutant: "detached parsed-note clone expands YAML aliases through structuredClone",
        apply: (source: string) =>
          replaceExactly(
            source,
            "parsed: cloneBoundedParsedNote(entry.parsed)",
            "parsed: structuredClone(entry.parsed)"
          )
      },
      {
        mutant: "detached parsed-note clone accepts cyclic aliases",
        apply: (source: string) =>
          replaceExactly(
            source,
            'if (active.has(value)) throw new Error("Parsed note contains a cyclic value");',
            'if (false) throw new Error("Parsed note contains a cyclic value");'
          )
      }
    ])("cache persistence census rejects $mutant", ({ apply }) => {
      const vaultFile = "src/vault.ts";
      const source = readFileSync(path.join(repoRoot, vaultFile), "utf8");
      expect(cacheSnapshotProblems(source)).toEqual([]);
      expect(cacheSnapshotProblems(apply(source))).not.toEqual([]);
    });

    it.each(["7 disk opens, 2 binding probes, and 2 path-free diagnostic snapshots"])(
      "SQLite family-preflight closed-world census accepts exactly %s",
      () => {
        expect(sqliteNativeOpenProblems()).toEqual([]);
      }
    );

    it.each([
      {
        route: "shared loader alias",
        addition:
          "\nasync function unlistedSqliteLoaderRoute(file: string): Promise<unknown> { const SQLite = await loadBetterSqlite(); return new SQLite(file); }\n"
      },
      {
        route: "literal import alias",
        addition:
          '\nasync function unlistedSqliteImportRoute(file: string): Promise<unknown> { const SQLite = (await import("better-sqlite3")).default; return new SQLite(file); }\n'
      }
    ])("SQLite census rejects a future unlisted $route", ({ addition }) => {
      const file = "src/fts5.ts";
      const source = readFileSync(path.join(repoRoot, file), "utf8");
      expect(sqliteNativeOpenProblems(new Map([[file, `${source}${addition}`]]))).not.toEqual([]);
    });

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
        const mutantBody = `${body.slice(0, lastPreflight)}Promise.resolve(true)${body.slice(
          lastPreflight + preflightNeedle.length
        )}`;
        const mutantSource = replaceExactly(source, body, mutantBody);
        const problems = sqliteNativeOpenProblems(new Map([[route.file, mutantSource]]));
        expect(problems.some((problem) => problem.startsWith(`${route.id}:`))).toBe(true);
      }
    );

    it.each(PUBLISHER_INVENTORY_MUTANTS)(
      "inventory rejects $id when occurrence $occurrenceNumber/$expectedOccurrences of its $role route $file#$member is removed",
      ({ id, role, file, member, needle, occurrenceIndex, expectedOccurrences }) => {
        const source = readFileSync(path.join(repoRoot, file), "utf8");
        const bodies = runtimeMemberBodies(source, file, member);
        expect(bodies).toHaveLength(1);
        const body = bodies[0] ?? "";
        const identifierReplacement = needle.replace(
          /[A-Za-z_$][A-Za-z0-9_$]*(?=[^A-Za-z0-9_$]*$)/,
          "__erasure_mutant__"
        );
        const replacement = identifierReplacement === needle ? "void __erasure_mutant__;" : identifierReplacement;
        const offsets: number[] = [];
        for (let offset = body.indexOf(needle); offset >= 0; offset = body.indexOf(needle, offset + needle.length)) {
          offsets.push(offset);
        }
        expect(offsets).toHaveLength(expectedOccurrences);
        const offset = offsets[occurrenceIndex] ?? -1;
        expect(offset).toBeGreaterThanOrEqual(0);
        const mutantBody = body.slice(0, offset) + replacement + body.slice(offset + needle.length);
        expect(mutantBody.split(needle)).toHaveLength(expectedOccurrences);
        const mutated = replaceExactly(source, body, mutantBody);
        expect(
          publisherInventoryProblems(new Map([[file, mutated]])).some(
            (problem) => problem.startsWith(`${id}:${role}:${file}#${member} expected `) && problem.includes(needle)
          )
        ).toBe(true);
      }
    );

    it.each(["await executeCachePrune(cacheDir, keepHash)", "await previewCachePrune(cacheDir, keepHash)"])(
      "CLI prune routes exact execution mode through %s",
      (route) => {
        const cliSource = readFileSync(path.join(repoRoot, "src/cli.ts"), "utf8");
        expect(cliSource).toContain(route);
        expect(replaceExactly(cliSource, route, "await planCachePrune(entries, keepHash)")).not.toContain(route);
      }
    );

    it("shared prune helpers route both bounded snapshots through on-disk admission", () => {
      const source = readFileSync(path.join(repoRoot, "src/cache-prune.ts"), "utf8");
      const route = "await planCachePruneOnDisk(canonicalDir, entries, keepHash)";
      expect(source.split(route)).toHaveLength(3);
      const mutant = source.replace(route, "await planCachePrune(entries, keepHash)");
      expect(mutant.split(route)).toHaveLength(2);
    });

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
      expect(() => planCachePrune([`${OTHER}.embed.db`, `${OTHER}.embed.db.watcher-activation.guard`], KEEP)).toThrow(
        /watcher activation guard is present/
      );
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
      ).toContain("clearHnswPersistedArtifacts(persistFile, db.getPersistenceFamilyScopes())");
    });

    it.each(["clearHnswPersistedArtifacts(persistFile, db.getPersistenceFamilyScopes())"])(
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
