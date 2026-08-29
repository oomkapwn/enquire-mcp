// Integration tests for the v2.0 beta hybrid search. Exercises the
// graceful-degradation paths (no FTS5 + no embeddings → TF-IDF only;
// FTS5 + no embeddings → BM25 + TF-IDF). Embedding paths are excluded
// from CI — they need a real model load. The RRF math itself is unit-
// tested in tests/rrf.test.ts; this file verifies the wiring.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EmbedDb, hnswPersistBase } from "../src/embed-db.js";
import { defaultIndexFile, FtsIndex } from "../src/fts5.js";
import { textResult } from "../src/mcp-result.js";
import { searchHybrid } from "../src/tools/index.js";
import {
  buildTfidfIndex,
  embeddingsSearch,
  filterExcludedEmbedHits,
  frontmatterMatches,
  MAX_FANOUT_QUERIES,
  pruneExcludedHits,
  searchHybridMulti
} from "../src/tools/search.js";
import { Vault } from "../src/vault.js";
import {
  armWatcherActivationGuard,
  releaseWatcherActivationGuard,
  watcherActivationGuardPath
} from "../src/watcher-activation-guard.js";

let root: string;

interface SemanticAdmissionFixture {
  readonly scratch: string;
  readonly vaultRoot: string;
  readonly embedFile: string;
  readonly previousCacheHome: string | undefined;
}

async function createSemanticAdmissionFixture(): Promise<SemanticAdmissionFixture> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-semantic-admission-"));
  const vaultRoot = path.join(scratch, "vault");
  const cacheRoot = path.join(scratch, "cache");
  await fs.mkdir(vaultRoot);
  const previousCacheHome = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cacheRoot;
  const canonicalVaultRoot = await fs.realpath(vaultRoot);
  const embedFile = defaultIndexFile(canonicalVaultRoot).replace(/\.fts5\.db$/u, ".embed.db");
  await fs.mkdir(path.dirname(embedFile), { recursive: true });

  const noteFile = path.join(canonicalVaultRoot, "Semantic.md");
  await fs.writeFile(noteFile, "semantic admission marker\n");
  const noteStat = await fs.stat(noteFile);
  const seed = new EmbedDb({
    file: embedFile,
    vaultRoot: canonicalVaultRoot,
    modelAlias: "multilingual",
    dim: 384,
    quantization: "f32"
  });
  await seed.open();
  try {
    const vector = new Float32Array(384);
    vector[0] = 1;
    seed.upsertNote("Semantic.md", noteStat.mtimeMs, [
      {
        chunkIndex: 0,
        lineStart: 1,
        lineEnd: 1,
        textPreview: "semantic admission marker",
        vector
      }
    ]);
  } finally {
    await seed.closeAndRelease();
  }
  return { scratch, vaultRoot: canonicalVaultRoot, embedFile, previousCacheHome };
}

async function removeSemanticAdmissionFixture(fixture: SemanticAdmissionFixture): Promise<void> {
  if (fixture.previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = fixture.previousCacheHome;
  await fs.rm(fixture.scratch, { recursive: true, force: true });
}

function installSemanticAdmissionRuntimeMocks(
  buildHnsw: (...args: unknown[]) => Promise<unknown>,
  hnswOverrides: Record<string, unknown> = {}
): void {
  vi.resetModules();
  vi.doMock("@huggingface/transformers", () => ({
    env: { allowRemoteModels: true, allowLocalModels: true },
    pipeline: async () => async (input: string | string[]) => {
      const texts = typeof input === "string" ? [input] : input;
      const data = new Float32Array(texts.length * 384);
      for (let index = 0; index < texts.length; index += 1) data[index * 384] = 1;
      return { data, dims: [texts.length, 384] as const };
    }
  }));
  vi.doMock("../src/hnsw.js", async () => {
    const actual = await vi.importActual<typeof import("../src/hnsw.js")>("../src/hnsw.js");
    return { ...actual, buildHnsw, ...hnswOverrides };
  });
}

function resetSemanticAdmissionRuntimeMocks(): void {
  vi.doUnmock("../src/hnsw.js");
  vi.doUnmock("@huggingface/transformers");
  vi.resetModules();
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-search-hybrid-"));
  await fs.mkdir(path.join(root, "Auth"), { recursive: true });
  await fs.mkdir(path.join(root, "Cooking"), { recursive: true });

  await fs.writeFile(
    path.join(root, "Auth", "OAuth Flows.md"),
    "OAuth authentication flow with JWT tokens. Authorization server issues access tokens.\n"
  );
  await fs.writeFile(
    path.join(root, "Auth", "JWT Validation.md"),
    "JWT validation: verify signature, expiration, audience, issuer. Refresh token rotation.\n"
  );
  await fs.writeFile(
    path.join(root, "Cooking", "Carbonara.md"),
    "Carbonara: guanciale, pecorino romano, eggs, black pepper. Toss with hot pasta.\n"
  );
  await fs.writeFile(
    path.join(root, "Cooking", "Sourdough.md"),
    "Sourdough starter feeding schedule. Bulk fermentation 4 hours at 25C.\n"
  );
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("searchHybrid (v2.0 beta — RRF over available signals)", () => {
  it.each(["embeddingsSearch", "searchHybrid"])(
    "%s rejects an invalid embedding namespace before vault.ensureExists",
    async (route) => {
      let ensureCalls = 0;
      const v = {
        root,
        ensureExists: async () => {
          ensureCalls += 1;
        }
      } as unknown as Vault;
      const invalidEmbedFile = path.join(root, "unadmitted-index");
      const operation =
        route === "embeddingsSearch"
          ? embeddingsSearch(v, { query: "namespace admission" }, invalidEmbedFile)
          : searchHybrid(v, { query: "namespace admission" }, { ftsIndex: null, embedFile: invalidEmbedFile });

      await expect(operation).rejects.toThrowError(
        new TypeError("Embedding index file must end exactly in '.embed.db'")
      );
      expect(ensureCalls).toBe(0);
    }
  );

  it("TF-IDF-only path: no FTS5, no embeddings → returns TF-IDF-style ranking", async () => {
    const v = new Vault(root);
    const missingEmbedFile = path.join(root, "nonexistent.embed.db");
    const result = await searchHybrid(
      v,
      { query: "OAuth JWT tokens", limit: 5 },
      { ftsIndex: null, embedFile: missingEmbedFile }
    );
    expect(result.method).toBe("rrf");
    expect(result.signals_used).toEqual(["tfidf"]);
    expect(result.signal_errors?.embeddings).toBeUndefined();
    expect(result.matches.length).toBeGreaterThan(0);
    // Top hit should be from Auth/, not Cooking/.
    expect(result.matches[0]?.path.startsWith("Auth/")).toBe(true);
    // Per-signal must show only tfidf.
    expect(Object.keys(result.matches[0]?.per_signal ?? {})).toEqual(["tfidf"]);

    // S-8d: a live semantic-route quarantine keeps lexical retrieval
    // available but refuses the stale semantic route until this generation
    // is replaced.
    const availabilityQuarantined = await searchHybrid(
      v,
      { query: "OAuth JWT tokens", limit: 5 },
      {
        ftsIndex: null,
        embedFile: missingEmbedFile,
        watcherHealth: { semanticUsable: false }
      }
    );
    expect(availabilityQuarantined.signals_used).toEqual(["tfidf"]);
    expect(availabilityQuarantined.signal_errors?.embeddings).toMatch(/quarantined for this server generation/i);
    await expect(
      embeddingsSearch(v, { query: "OAuth JWT tokens", limit: 5 }, missingEmbedFile, undefined, {
        semanticUsable: false
      })
    ).rejects.toThrow(/quarantined for this server generation/i);

    // NEGATIVE control: a stranded watcher-startup interlock must quarantine
    // even an embedding DB that disappeared after preparation. Hybrid search
    // still degrades to TF-IDF, but reports a path-free embedding-arm failure.
    const guardPath = watcherActivationGuardPath(missingEmbedFile);
    await fs.mkdir(guardPath);
    try {
      const quarantined = await searchHybrid(
        v,
        { query: "OAuth JWT tokens", limit: 5 },
        { ftsIndex: null, embedFile: missingEmbedFile }
      );
      expect(quarantined.signals_used).toEqual(["tfidf"]);
      expect(quarantined.matches.length).toBeGreaterThan(0);
      expect(quarantined.signal_errors?.embeddings).toMatch(/quarantined after an incomplete watcher startup/i);
      expect(quarantined.signal_errors?.embeddings).toMatch(/custom embedding index.*exact `--embed-file` option/is);
      expect(quarantined.signal_errors?.embeddings).not.toContain(root);
      expect(quarantined.signal_errors?.embeddings).not.toContain(missingEmbedFile);
    } finally {
      await fs.rmdir(guardPath);
    }

    // Root-filtered configuration discovery must not turn a foreign index
    // into an explicit-model mismatch or a default-config open. A present
    // wrong-root artifact is refused by full-class discovery before
    // construction, so no destructive rebuild guidance is emitted.
    let sqliteAvailable = false;
    try {
      const Database = (await import("better-sqlite3")).default;
      const probe = new Database(":memory:");
      probe.close();
      sqliteAvailable = true;
    } catch {
      // Optional native dependency absent; standard CI exercises this phase.
    }
    if (sqliteAvailable) {
      const Database = (await import("better-sqlite3")).default;
      const owningVault = new Vault(root);
      await owningVault.ensureExists();
      const foreignRoot = path.join(owningVault.root, "foreign-owner");
      await fs.mkdir(foreignRoot);
      const canonicalForeignRoot = await fs.realpath(foreignRoot);
      const foreignEmbedFile = path.join(owningVault.root, "foreign-explicit.embed.db");
      const seed = new EmbedDb({
        file: foreignEmbedFile,
        vaultRoot: canonicalForeignRoot,
        modelAlias: "multilingual",
        dim: 2
      });
      await seed.open();
      seed.upsertNote("Foreign.md", 1, [
        {
          chunkIndex: 0,
          lineStart: 1,
          lineEnd: 1,
          textPreview: "foreign-search-marker",
          vector: new Float32Array([1, 0])
        }
      ]);
      seed.close();
      const logicalSnapshot = () => {
        const inspect = new Database(foreignEmbedFile, { readonly: true, fileMustExist: true });
        try {
          return {
            schema: inspect
              .prepare(
                `SELECT type, name, sql
                 FROM sqlite_master
                 WHERE name NOT GLOB 'sqlite_*'
                 ORDER BY type, name`
              )
              .all(),
            meta: inspect.prepare("SELECT key, value FROM meta ORDER BY key").all(),
            rows: inspect
              .prepare(
                `SELECT id, rel_path, chunk_index, line_start, line_end, text_preview,
                        hex(vector) AS vector_hex, kind
                 FROM embeddings
                 ORDER BY id`
              )
              .all(),
            sourceState: inspect.prepare("SELECT * FROM source_state ORDER BY rel_path, kind").all()
          };
        } finally {
          inspect.close();
        }
      };
      const logicalBeforeRefusal = logicalSnapshot();

      let explicitForeignRefusal: unknown;
      try {
        await embeddingsSearch(owningVault, { query: "foreign", limit: 1, model: "bge" }, foreignEmbedFile);
      } catch (error) {
        explicitForeignRefusal = error;
      }
      expect(explicitForeignRefusal).toBeInstanceOf(Error);
      const refusalMessage =
        explicitForeignRefusal instanceof Error ? explicitForeignRefusal.message : String(explicitForeignRefusal);
      expect(refusalMessage).toMatch(/configuration could not be verified/i);
      expect(refusalMessage).not.toMatch(/does not match|clear-embeddings|requested model/i);
      for (const sensitivePath of [owningVault.root, foreignRoot, canonicalForeignRoot, foreignEmbedFile]) {
        expect(refusalMessage).not.toContain(sensitivePath);
      }
      expect(logicalSnapshot()).toEqual(logicalBeforeRefusal);

      const combinedGuardPath = watcherActivationGuardPath(foreignEmbedFile);
      const combinedGuard = await armWatcherActivationGuard(foreignEmbedFile);
      try {
        let combinedRefusal: unknown;
        try {
          await embeddingsSearch(owningVault, { query: "foreign", limit: 1, model: "bge" }, foreignEmbedFile);
        } catch (error) {
          combinedRefusal = error;
        }
        expect(combinedRefusal).toBeInstanceOf(Error);
        const combinedMessage = combinedRefusal instanceof Error ? combinedRefusal.message : String(combinedRefusal);
        expect(combinedMessage).toBe("Embedding index ownership could not be verified");
        expect(combinedMessage).not.toMatch(/clear-embeddings|quarantined|requested model/i);
        for (const sensitivePath of [owningVault.root, foreignRoot, canonicalForeignRoot, foreignEmbedFile]) {
          expect(combinedMessage).not.toContain(sensitivePath);
        }
        expect(logicalSnapshot()).toEqual(logicalBeforeRefusal);
        expect((await fs.lstat(combinedGuardPath)).isDirectory()).toBe(true);

        const hybridCombined = await searchHybrid(
          owningVault,
          { query: "OAuth JWT tokens", limit: 1 },
          { ftsIndex: null, embedFile: foreignEmbedFile }
        );
        expect(hybridCombined.signals_used).toEqual(["tfidf"]);
        expect(hybridCombined.signal_errors?.embeddings).toBe("Embedding index ownership could not be verified");
        expect(hybridCombined.signal_errors?.embeddings).not.toMatch(/clear-embeddings|quarantined|requested model/i);
        for (const sensitivePath of [owningVault.root, foreignRoot, canonicalForeignRoot, foreignEmbedFile]) {
          expect(hybridCombined.signal_errors?.embeddings).not.toContain(sensitivePath);
        }
        expect(logicalSnapshot()).toEqual(logicalBeforeRefusal);
        expect((await fs.lstat(combinedGuardPath)).isDirectory()).toBe(true);
      } finally {
        await releaseWatcherActivationGuard(combinedGuard);
      }

      const verify = new EmbedDb({
        file: foreignEmbedFile,
        vaultRoot: canonicalForeignRoot,
        modelAlias: "multilingual",
        dim: 2
      });
      await verify.open();
      try {
        expect(verify.totalChunks()).toBe(1);
        expect(verify.search(new Float32Array([1, 0]), 1)[0]?.text_preview).toBe("foreign-search-marker");
      } finally {
        verify.close();
      }

      // Matching-root wrong-class controls: expected-root discovery must
      // validate the complete admitted metadata class, not merely vault_root.
      // Path-like stored values stay confidential and can never be resolved,
      // echoed, or laundered into a default configuration before open.
      const causalEmbedFile = path.join(owningVault.root, "same-root-wrong-class.embed.db");
      const causalSeed = new EmbedDb({
        file: causalEmbedFile,
        vaultRoot: owningVault.root,
        modelAlias: "multilingual",
        dim: 384,
        quantization: "f32"
      });
      await causalSeed.open();
      const causalVector = new Float32Array(384);
      causalVector[0] = 1;
      causalSeed.upsertNote("Owned.md", 1, [
        {
          chunkIndex: 0,
          lineStart: 1,
          lineEnd: 1,
          textPreview: "same-root-class-marker",
          vector: causalVector
        }
      ]);
      causalSeed.close();
      const causalSnapshot = () => {
        const inspect = new Database(causalEmbedFile, { readonly: true, fileMustExist: true });
        try {
          return {
            schema: inspect
              .prepare(
                `SELECT type, name, sql
                 FROM sqlite_master
                 WHERE name NOT GLOB 'sqlite_*'
                 ORDER BY type, name`
              )
              .all(),
            meta: inspect.prepare("SELECT key, value FROM meta ORDER BY key").all(),
            rows: inspect
              .prepare(
                `SELECT id, rel_path, chunk_index, line_start, line_end, text_preview,
                        hex(vector) AS vector_hex, kind
                 FROM embeddings
                 ORDER BY id`
              )
              .all(),
            sourceState: inspect.prepare("SELECT * FROM source_state ORDER BY rel_path, kind").all()
          };
        } finally {
          inspect.close();
        }
      };
      const writeMetaValue = (key: string, value: string) => {
        const mutate = new Database(causalEmbedFile);
        try {
          mutate.prepare("UPDATE meta SET value = ? WHERE key = ?").run(value, key);
        } finally {
          mutate.close();
        }
      };
      const pathLikeAlias = "../../private/model-alias-secret";
      writeMetaValue("model_alias", pathLikeAlias);
      const aliasBeforeRefusal = causalSnapshot();
      let aliasRefusal: unknown;
      try {
        await embeddingsSearch(owningVault, { query: "same-root", limit: 1 }, causalEmbedFile);
      } catch (error) {
        aliasRefusal = error;
      }
      expect(aliasRefusal).toBeInstanceOf(Error);
      const aliasMessage = aliasRefusal instanceof Error ? aliasRefusal.message : String(aliasRefusal);
      expect(aliasMessage).toBe("Embedding index configuration could not be verified");
      expect(aliasMessage).not.toMatch(/clear-embeddings|does not match|requested model/i);
      for (const sensitiveValue of [owningVault.root, causalEmbedFile, pathLikeAlias]) {
        expect(aliasMessage).not.toContain(sensitiveValue);
      }
      expect(causalSnapshot()).toEqual(aliasBeforeRefusal);

      writeMetaValue("model_alias", "multilingual");
      const pathLikeQuantization = "../q8-quantization-secret";
      writeMetaValue("quantization", pathLikeQuantization);
      const quantizationBeforeRefusal = causalSnapshot();
      let quantizationRefusal: unknown;
      try {
        await embeddingsSearch(owningVault, { query: "same-root", limit: 1 }, causalEmbedFile);
      } catch (error) {
        quantizationRefusal = error;
      }
      expect(quantizationRefusal).toBeInstanceOf(Error);
      const quantizationMessage =
        quantizationRefusal instanceof Error ? quantizationRefusal.message : String(quantizationRefusal);
      expect(quantizationMessage).toBe("Embedding index configuration could not be verified");
      expect(quantizationMessage).not.toMatch(/clear-embeddings|does not match|requested model/i);
      for (const sensitiveValue of [owningVault.root, causalEmbedFile, pathLikeQuantization]) {
        expect(quantizationMessage).not.toContain(sensitiveValue);
      }
      expect(causalSnapshot()).toEqual(quantizationBeforeRefusal);

      // Historical v1/v2 metadata intentionally has no quantization key.
      // Build a physically genuine v2 fixture: relabelling a current database
      // in metadata is not equivalent because later schemas add authority
      // objects which full-class discovery must never accept as historical.
      const legacyEmbedFile = path.join(owningVault.root, "legacy-v2.embed.db");
      const legacyRaw = new Database(legacyEmbedFile);
      try {
        legacyRaw.exec(`
          CREATE TABLE meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
          CREATE TABLE embeddings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rel_path TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            line_start INTEGER NOT NULL,
            line_end INTEGER NOT NULL,
            text_preview TEXT NOT NULL,
            vector BLOB NOT NULL,
            kind TEXT NOT NULL DEFAULT 'md',
            UNIQUE(rel_path, chunk_index)
          );
          CREATE INDEX embeddings_rel_path ON embeddings(rel_path);
          CREATE TABLE source_state (
            rel_path TEXT PRIMARY KEY,
            mtime_ms INTEGER NOT NULL,
            n_chunks INTEGER NOT NULL,
            kind TEXT NOT NULL DEFAULT 'md',
            indexed_at TEXT NOT NULL
          );
        `);
        const insertMeta = legacyRaw.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
        insertMeta.run("schema_version", "2");
        insertMeta.run("vault_root", owningVault.root);
        insertMeta.run("model_alias", "multilingual");
        insertMeta.run("dim", "384");
      } finally {
        legacyRaw.close();
      }
      const { peekEmbedDbMeta } = await import("../src/embed-db.js");
      const legacyMeta = await peekEmbedDbMeta(legacyEmbedFile, owningVault.root);
      expect(legacyMeta?.schema_version).toBe("2");
      expect(legacyMeta?.quantization).toBeUndefined();
      const legacyResult = await embeddingsSearch(owningVault, { query: "legacy", limit: 1 }, legacyEmbedFile);
      expect(legacyResult.total_chunks).toBe(0);
      expect(legacyResult.matches).toEqual([]);

      // NEGATIVE control: the former fixture shape was a current physical
      // database with only schema_version/quantization edited. The raw
      // diagnostic sees those bounded rows, while root-scoped full-class
      // admission and search reject the cross-generation metadata spoof.
      const spoofedLegacyFile = path.join(owningVault.root, "spoofed-legacy-v2.embed.db");
      const spoofedLegacySeed = new EmbedDb({
        file: spoofedLegacyFile,
        vaultRoot: owningVault.root,
        modelAlias: "multilingual",
        dim: 384,
        quantization: "f32"
      });
      await spoofedLegacySeed.open();
      spoofedLegacySeed.close();
      const spoofedLegacyRaw = new Database(spoofedLegacyFile);
      try {
        spoofedLegacyRaw.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
        spoofedLegacyRaw.prepare("DELETE FROM meta WHERE key = 'quantization'").run();
      } finally {
        spoofedLegacyRaw.close();
      }
      const spoofedRawMeta = await peekEmbedDbMeta(spoofedLegacyFile);
      expect(spoofedRawMeta?.schema_version).toBe("2");
      expect(Object.hasOwn(spoofedRawMeta ?? {}, "instance_uuid")).toBe(true);
      expect(await peekEmbedDbMeta(spoofedLegacyFile, owningVault.root)).toBeNull();
      await expect(
        embeddingsSearch(owningVault, { query: "spoofed-legacy", limit: 1 }, spoofedLegacyFile)
      ).rejects.toThrow("Embedding index configuration could not be verified");

      // Missing and present-but-empty are distinct discovery states. Search
      // must accept both zero-byte and schema-empty SQLite artifacts as safe
      // initialization candidates instead of confusing them with a refused
      // populated database and applying the generic class error.
      const zeroByteEmbedFile = path.join(owningVault.root, "zero-byte.embed.db");
      await fs.writeFile(zeroByteEmbedFile, "");
      const schemaEmptyEmbedFile = path.join(owningVault.root, "schema-empty.embed.db");
      const schemaEmpty = new Database(schemaEmptyEmbedFile);
      schemaEmpty.close();
      for (const emptyEmbedFile of [zeroByteEmbedFile, schemaEmptyEmbedFile]) {
        const emptyResult = await embeddingsSearch(owningVault, { query: "empty-discovery", limit: 1 }, emptyEmbedFile);
        expect(emptyResult.total_chunks).toBe(0);
        expect(emptyResult.matches).toEqual([]);
      }
    }
  });

  it("respects min_signals filter (consensus search)", async () => {
    const v = new Vault(root);
    // With only TF-IDF available, requiring min_signals=2 returns nothing.
    const result = await searchHybrid(
      v,
      { query: "OAuth", limit: 5, min_signals: 2 },
      { ftsIndex: null, embedFile: path.join(root, "nonexistent.embed.db") }
    );
    expect(result.matches.length).toBe(0);
  });

  it("respects folder filter end-to-end", async () => {
    const v = new Vault(root);
    const result = await searchHybrid(
      v,
      { query: "tokens", folder: "Cooking", limit: 10 },
      { ftsIndex: null, embedFile: path.join(root, "nonexistent.embed.db") }
    );
    // Cooking has no token-related notes, so we get either zero hits or
    // very weak matches — but never anything from Auth/.
    expect(result.matches.every((m) => m.path.startsWith("Cooking/"))).toBe(true);
  });

  it("rejects empty query", async () => {
    const v = new Vault(root);
    await expect(
      searchHybrid(v, { query: "" }, { ftsIndex: null, embedFile: path.join(root, "nonexistent.embed.db") })
    ).rejects.toThrow(/empty/);
    await expect(
      searchHybrid(v, { query: "   " }, { ftsIndex: null, embedFile: path.join(root, "nonexistent.embed.db") })
    ).rejects.toThrow(/empty/);
  });

  it("response includes RRF k=60 (Cormack et al constant)", async () => {
    const v = new Vault(root);
    const result = await searchHybrid(
      v,
      { query: "OAuth" },
      { ftsIndex: null, embedFile: path.join(root, "nonexistent.embed.db") }
    );
    expect(result.k).toBe(60);
  });

  it("limits the response to args.limit", async () => {
    const v = new Vault(root);
    const result = await searchHybrid(
      v,
      { query: "the", limit: 2 },
      { ftsIndex: null, embedFile: path.join(root, "nonexistent.embed.db") }
    );
    expect(result.matches.length).toBeLessThanOrEqual(2);
  });

  it("reports total_candidates (the fused set size before truncation)", async () => {
    const v = new Vault(root);
    const result = await searchHybrid(
      v,
      { query: "OAuth JWT pasta sourdough" },
      { ftsIndex: null, embedFile: path.join(root, "nonexistent.embed.db") }
    );
    // total_candidates is the number of fused docs before topK truncation;
    // should be ≥ matches.length and bounded by total notes.
    expect(result.total_candidates).toBeGreaterThanOrEqual(result.matches.length);
  });
});

// v2.0.0-beta.1 P2 fix: pre-fix, the BM25 codepath in searchHybrid had 0%
// coverage in CI — every test passed `ftsIndex: null` and skipped the
// chunk-collapse + rank-renumbering branch. A regression there (e.g.
// off-by-one in rank assignment, missed dedup) would silently land. These
// tests build a real FtsIndex against a tmp vault and verify BM25 + TF-IDF
// fusion end-to-end.
describe("searchHybrid — BM25 + TF-IDF fusion path", () => {
  let ftsRoot: string;
  let idx: FtsIndex;

  beforeAll(async () => {
    ftsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-hybrid-bm25-"));
    await fs.mkdir(path.join(ftsRoot, "Auth"), { recursive: true });
    await fs.mkdir(path.join(ftsRoot, "Cooking"), { recursive: true });

    // Two strong-signal notes about authentication, two unrelated.
    await fs.writeFile(
      path.join(ftsRoot, "Auth", "OAuth.md"),
      "OAuth authentication flow with JWT tokens. The authorization server issues access tokens.\n\nRefresh tokens rotate per session.\n"
    );
    await fs.writeFile(
      path.join(ftsRoot, "Auth", "JWT.md"),
      "JWT validation: verify signature, expiration, audience, issuer claim. Token introspection.\n"
    );
    await fs.writeFile(path.join(ftsRoot, "Cooking", "Pasta.md"), "Pasta carbonara with guanciale.\n");
    await fs.writeFile(path.join(ftsRoot, "Cooking", "Bread.md"), "Sourdough bread fermentation.\n");

    // Build a real FTS5 index.
    const v = new Vault(ftsRoot);
    await v.ensureExists();
    idx = new FtsIndex({ file: defaultIndexFile(ftsRoot), vaultRoot: ftsRoot });
    await idx.open();
    for (const e of await v.listMarkdown()) {
      const note = await v.readNote(e.absPath, e.mtimeMs);
      const wikilinkTargets = note.parsed.wikilinks.map((w) => w.target).filter((t) => t.length > 0);
      idx.reindexFile(e.relPath, e.mtimeMs, note.content, wikilinkTargets, note.parsed.tags);
    }
  });

  afterAll(async () => {
    await idx.closeAndRelease();
    await fs.rm(ftsRoot, { recursive: true, force: true });
  });

  it("uses both bm25 and tfidf signals when ftsIndex is provided", async () => {
    const v = new Vault(ftsRoot);
    const result = await searchHybrid(
      v,
      { query: "OAuth JWT tokens", limit: 5 },
      { ftsIndex: idx, embedFile: path.join(ftsRoot, "nonexistent.embed.db") }
    );
    expect(result.signals_used.sort()).toEqual(["bm25", "tfidf"]);
    expect(result.matches.length).toBeGreaterThan(0);
    // Top hit must be from Auth/, not Cooking/.
    expect(result.matches[0]?.path.startsWith("Auth/")).toBe(true);
  });

  it("hits ranked in BOTH signals score higher than single-signal hits (fusion working)", async () => {
    const v = new Vault(ftsRoot);
    const result = await searchHybrid(
      v,
      { query: "OAuth JWT tokens", limit: 10 },
      { ftsIndex: idx, embedFile: path.join(ftsRoot, "nonexistent.embed.db") }
    );
    // Find a doc with 2 signals and a doc with 1 signal — multi-signal
    // must outrank single-signal. With a strong-overlap query against both
    // Auth notes, both should rank in BM25 + TF-IDF.
    const multiSignalHits = result.matches.filter((m) => m.per_signal.bm25 && m.per_signal.tfidf);
    expect(multiSignalHits.length).toBeGreaterThan(0);
    // Its score must be >= 2/(60+1) — both signals contributing rank 1ish.
    expect(multiSignalHits[0]?.score).toBeGreaterThan(1 / 61);
  });

  it("min_signals=2 returns only multi-ranker consensus hits", async () => {
    const v = new Vault(ftsRoot);
    const result = await searchHybrid(
      v,
      { query: "OAuth JWT tokens", limit: 10, min_signals: 2 },
      { ftsIndex: idx, embedFile: path.join(ftsRoot, "nonexistent.embed.db") }
    );
    // Every hit must have BOTH bm25 and tfidf populated.
    for (const m of result.matches) {
      const numSignals = Object.keys(m.per_signal).length;
      expect(numSignals).toBeGreaterThanOrEqual(2);
    }

    const block = await searchHybrid(
      v,
      { query: "OAuth JWT tokens", limit: 10, min_signals: 2, granularity: "block" },
      { ftsIndex: idx, embedFile: path.join(ftsRoot, "nonexistent.embed.db") }
    );
    expect(block.matches.length).toBeGreaterThan(0);
    for (const m of block.matches) {
      expect(m.per_signal.bm25).toBeDefined();
      expect(m.per_signal.tfidf).toBeDefined();
    }
  });

  it("BM25 chunk-collapse: per_signal.bm25 carries chunk_index from the best chunk", async () => {
    const v = new Vault(ftsRoot);
    const result = await searchHybrid(
      v,
      { query: "OAuth", limit: 5 },
      { ftsIndex: idx, embedFile: path.join(ftsRoot, "nonexistent.embed.db") }
    );
    // OAuth.md has 2 paragraphs (2 chunks). Hybrid response should carry
    // the chunk_index from the higher-ranked chunk.
    const oauthHit = result.matches.find((m) => m.path === "Auth/OAuth.md");
    expect(oauthHit).toBeDefined();
    expect(oauthHit?.chunk_index).toBeGreaterThanOrEqual(0);
  });

  it("BM25-only on the synthetic Cooking folder reaches that subfolder", async () => {
    const v = new Vault(ftsRoot);
    const result = await searchHybrid(
      v,
      { query: "carbonara", folder: "Cooking", limit: 5 },
      { ftsIndex: idx, embedFile: path.join(ftsRoot, "nonexistent.embed.db") }
    );
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.every((m) => m.path.startsWith("Cooking/"))).toBe(true);

    // AH-1 receipt controls stay in this established BM25-route test so the
    // causal coverage does not add another test registration.
    {
      const v = new Vault(ftsRoot);
      const relPath = "Auth/Receipt generation.md";
      const absPath = path.join(ftsRoot, relPath);
      await fs.writeFile(absPath, "ah_one_persisted_secret before replacement\n");
      const indexedMtimeMs = (await fs.stat(absPath)).mtimeMs;
      idx.reindexFile(relPath, indexedMtimeMs, "ah_one_persisted_secret before replacement", [], []);

      // Positive control: the exact generation committed to source_state is
      // visible through the real hybrid BM25 route.
      const current = await searchHybrid(
        v,
        { query: "ah_one_persisted_secret", limit: 5 },
        { ftsIndex: idx, embedFile: path.join(ftsRoot, "nonexistent.embed.db") }
      );
      expect(
        current.matches.some((match) => match.path === relPath && match.snippet.includes("persisted_secret"))
      ).toBe(true);

      // Mutation control: preserve the old FTS bytes while replacing the live
      // source with another regular-file generation. BM25 must not contribute
      // or surface its retained snippet before watcher/bulk reconciliation.
      await fs.writeFile(absPath, "current generation contains no prior marker\n");
      const changedTime = new Date(indexedMtimeMs + 5000);
      await fs.utimes(absPath, changedTime, changedTime);
      expect(idx.search("ah_one_persisted_secret", { limit: 5 }).some((hit) => hit.rel_path === relPath)).toBe(true);

      const stale = await searchHybrid(
        v,
        { query: "ah_one_persisted_secret", limit: 5 },
        { ftsIndex: idx, embedFile: path.join(ftsRoot, "nonexistent.embed.db") }
      );
      expect(stale.matches.every((match) => match.path !== relPath)).toBe(true);
      expect(stale.matches.every((match) => !match.snippet.includes("before replacement"))).toBe(true);
    }

    // The same registration also owns the late frontmatter-await mutation.
    {
      const v = new Vault(ftsRoot);
      const relPath = "Auth/Late receipt.md";
      const absPath = path.join(ftsRoot, relPath);
      const oldContent = "---\nstatus: active\n---\nlate_receipt_secret belongs only to the indexed generation.\n";
      await fs.writeFile(absPath, oldContent);
      const indexedMtimeMs = (await fs.stat(absPath)).mtimeMs;
      idx.reindexFile(relPath, indexedMtimeMs, oldContent, [], []);

      try {
        const positive = await searchHybrid(
          v,
          { query: "late_receipt_secret", limit: 5, filter_frontmatter: { status: "active" } },
          { ftsIndex: idx, embedFile: path.join(ftsRoot, "nonexistent.embed.db") }
        );
        expect(positive.matches.some((match) => match.path === relPath)).toBe(true);

        const originalReadNote = v.readNote.bind(v);
        let replaced = false;
        v.readNote = async (...args: Parameters<Vault["readNote"]>) => {
          if (!replaced && args[0] === v.resolveInside(relPath) && args[1] === undefined) {
            replaced = true;
            idx.reindexFile(
              relPath,
              indexedMtimeMs,
              "---\nstatus: active\n---\nnew indexed generation without the secret.\n",
              [],
              []
            );
          }
          return originalReadNote(...args);
        };
        try {
          const raced = await searchHybrid(
            v,
            { query: "late_receipt_secret", limit: 5, filter_frontmatter: { status: "active" } },
            { ftsIndex: idx, embedFile: path.join(ftsRoot, "nonexistent.embed.db") }
          );
          expect(replaced).toBe(true);
          expect(raced.matches.every((match) => match.path !== relPath)).toBe(true);
          expect(raced.matches.every((match) => !match.snippet.includes("late_receipt_secret"))).toBe(true);
        } finally {
          v.readNote = originalReadNote;
        }
      } finally {
        idx.dropFile(relPath);
        await fs.unlink(absPath).catch(() => {});
      }
    }
  });
});

// v2.8.0 — verify the kind flag propagates from FTS5 hits through searchHybrid
// to the MCP response, and that markdown + PDF hits coexist in the same
// blended retrieval.
describe("searchHybrid — kind flag (v2.8.0)", () => {
  let blendRoot: string;
  let blendIdx: FtsIndex;

  beforeAll(async () => {
    blendRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-hybrid-kind-"));
    // One markdown note + one synthetic PDF — both contain "Apollo".
    await fs.writeFile(path.join(blendRoot, "notes.md"), "Apollo program notes from 1969.\n");
    await fs.writeFile(path.join(blendRoot, "apollo.pdf"), "synthetic PDF source fixture");
    blendIdx = new FtsIndex({
      file: path.join(blendRoot, ".cache", "test.fts5.db"),
      vaultRoot: blendRoot,
      tokenize: "unicode61"
    });
    await fs.mkdir(path.dirname(blendIdx.file), { recursive: true });
    await blendIdx.open();
    const noteMtimeMs = (await fs.stat(path.join(blendRoot, "notes.md"))).mtimeMs;
    const pdfMtimeMs = (await fs.stat(path.join(blendRoot, "apollo.pdf"))).mtimeMs;
    blendIdx.reindexFile("notes.md", noteMtimeMs, "Apollo program notes from 1969.");
    blendIdx.reindexPdfFile("apollo.pdf", pdfMtimeMs, [
      { pageNumber: 1, text: "Apollo guidance computer architecture" },
      { pageNumber: 2, text: "Saturn V launch sequence" }
    ]);
  });

  afterAll(async () => {
    await blendIdx?.closeAndRelease();
    await fs.rm(blendRoot, { recursive: true, force: true });
  });

  it("returns blended hits with kind='md' and kind='pdf'", async () => {
    const v = new Vault(blendRoot);
    const result = await searchHybrid(
      v,
      { query: "Apollo", limit: 10 },
      { ftsIndex: blendIdx, embedFile: path.join(blendRoot, "nonexistent.embed.db") }
    );
    const kinds = new Set(result.matches.map((m) => m.kind));
    expect(kinds).toContain("md");
    expect(kinds).toContain("pdf");
  });

  it("kind='pdf' hits use a .pdf-stripped title (no .md-strip)", async () => {
    const v = new Vault(blendRoot);
    const result = await searchHybrid(
      v,
      { query: "Apollo", limit: 10 },
      { ftsIndex: blendIdx, embedFile: path.join(blendRoot, "nonexistent.embed.db") }
    );
    const pdfHit = result.matches.find((m) => m.kind === "pdf");
    expect(pdfHit).toBeDefined();
    if (pdfHit) {
      expect(pdfHit.title).toBe("apollo");
      expect(pdfHit.path.endsWith(".pdf")).toBe(true);
    }
    const mdHit = result.matches.find((m) => m.kind === "md");
    expect(mdHit).toBeDefined();
    if (mdHit) {
      expect(mdHit.title).toBe("notes");
    }
  });

  it("kind defaults to 'md' on TF-IDF-only matches (no FTS5 / embedding hit)", async () => {
    // No FTS5 index → only TF-IDF (in-memory, scans markdown). No PDF hits possible.
    const v = new Vault(blendRoot);
    const result = await searchHybrid(
      v,
      { query: "Apollo", limit: 10 },
      { ftsIndex: null, embedFile: path.join(blendRoot, "nonexistent.embed.db") }
    );
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.every((m) => m.kind === "md")).toBe(true);

    // MCP result admission accepts only the plain JSON domain. Note-level
    // TF-IDF has no chunk/line evidence, so the producer must OMIT those
    // optional keys instead of materializing `undefined` (the pre-fix shape
    // made the public tool call return an MCP error string instead of JSON).
    const firstHit = result.matches[0];
    expect(firstHit).toBeDefined();
    expect(Object.hasOwn(firstHit ?? {}, "chunk_index")).toBe(false);
    expect(Object.hasOwn(firstHit ?? {}, "line_start")).toBe(false);
    expect(Object.hasOwn(firstHit ?? {}, "line_end")).toBe(false);
    expect(JSON.parse(textResult(result).content[0]?.text ?? "null")).toEqual(result);

    // NEGATIVE control: the exact old producer shape remains rejected at the
    // common boundary; this prevents a regression from being hidden by
    // weakening admission to silently accept non-JSON `undefined` values.
    const legacyUndefinedShape = {
      ...result,
      matches: [{ ...firstHit, chunk_index: undefined, line_start: undefined, line_end: undefined }]
    };
    expect(() => textResult(legacyUndefinedShape)).toThrow(/unsupported undefined/i);
  });

  // v3.7.12 M6 — graph boost must NOT call `vault.readNote` on `.pdf`
  // candidates. Pre-fix the boost code path attempted `readNote(*.pdf)`
  // for every fused PDF candidate, did a UTF-8 decode of binary bytes,
  // and silently swallowed the parse error via try/catch. The fix
  // restricts the candidate set to `.md` paths only.
  it("graph_boost skips .pdf candidates (M6 negative-control)", async () => {
    const v = new Vault(blendRoot);
    // Spy on vault.readNote — record every absolute path it's called with.
    const calls: string[] = [];
    const origReadNote = v.readNote.bind(v);
    v.readNote = async (...args: Parameters<typeof v.readNote>) => {
      calls.push(args[0]);
      return origReadNote(...args);
    };
    const result = await searchHybrid(
      v,
      { query: "Apollo", limit: 10, graph_boost: true },
      { ftsIndex: blendIdx, embedFile: path.join(blendRoot, "nonexistent.embed.db") }
    );
    // Confirm the fused set still contains both kinds (precondition for
    // a meaningful negative-control — otherwise the PDF skip is vacuous).
    const kinds = new Set(result.matches.map((m) => m.kind));
    expect(kinds).toContain("pdf");
    expect(kinds).toContain("md");
    // Critical: graph-boost-driven readNote calls must NEVER target .pdf.
    // (Tag-index lookups during TF-IDF can call readNote for `.md` files;
    // we only assert the absence of `.pdf` in the call list.)
    const pdfReadCalls = calls.filter((p) => p.toLowerCase().endsWith(".pdf"));
    expect(
      pdfReadCalls.length,
      `graph_boost called readNote on .pdf paths ${pdfReadCalls.join(", ")} — should be skipped post-3.7.12 M6`
    ).toBe(0);
  });
});

// v3.10 — forgetting-aware freshness enrichment on hybrid hits. Verifies that
// searchHybrid stats each final hit's CURRENT on-disk mtime and attaches
// age_days/stale, that the threshold is the canonical 365 days, and that the
// enrichment is fail-soft (a deleted-after-fusion file omits the fields rather
// than throwing). Uses fs.utimes to control mtimes deterministically, mirroring
// tests/stale-notes.test.ts.
describe("searchHybrid — age_days/stale freshness enrichment (v3.10)", () => {
  const DAY = 86_400_000;
  let sRoot: string;

  beforeAll(async () => {
    sRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-hybrid-stale-"));
    // Two topically-matching notes so both surface for the same query.
    await fs.writeFile(path.join(sRoot, "old-note.md"), "kubernetes ingress controller routing rules.\n");
    await fs.writeFile(path.join(sRoot, "fresh-note.md"), "kubernetes ingress controller TLS termination.\n");
    const now = Date.now();
    // old-note: 400 days old → stale; fresh-note: 10 days old → not stale.
    await fs.utimes(path.join(sRoot, "old-note.md"), new Date(now - 400 * DAY), new Date(now - 400 * DAY));
    await fs.utimes(path.join(sRoot, "fresh-note.md"), new Date(now - 10 * DAY), new Date(now - 10 * DAY));
  });

  afterAll(async () => {
    await fs.rm(sRoot, { recursive: true, force: true });
  });

  it("attaches age_days (>= 0) and stale to every hit, reflecting live mtime", async () => {
    const v = new Vault(sRoot);
    const result = await searchHybrid(
      v,
      { query: "kubernetes ingress controller", limit: 5 },
      { ftsIndex: null, embedFile: path.join(sRoot, "nonexistent.embed.db") }
    );
    expect(result.matches.length).toBeGreaterThanOrEqual(2);
    const byPath = new Map(result.matches.map((m) => [m.path, m]));
    const old = byPath.get("old-note.md");
    const fresh = byPath.get("fresh-note.md");
    expect(old).toBeDefined();
    expect(fresh).toBeDefined();
    // age_days is a non-negative integer reflecting the file mtime we set.
    expect(typeof old?.age_days).toBe("number");
    expect(old?.age_days).toBeGreaterThanOrEqual(399);
    expect(typeof fresh?.age_days).toBe("number");
    expect(fresh?.age_days).toBeGreaterThanOrEqual(9);
    expect(fresh?.age_days).toBeLessThan(30);
    // stale crosses at the canonical 365-day threshold.
    expect(old?.stale).toBe(true);
    expect(fresh?.stale).toBe(false);
  });

  it("NEGATIVE control: an all-fresh vault yields stale=false on every hit", async () => {
    const freshRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-hybrid-allfresh-"));
    try {
      await fs.writeFile(path.join(freshRoot, "a.md"), "kubernetes ingress controller A.\n");
      await fs.writeFile(path.join(freshRoot, "b.md"), "kubernetes ingress controller B.\n");
      // Leave mtimes at creation time (now) — nothing is stale.
      const v = new Vault(freshRoot);
      const result = await searchHybrid(
        v,
        { query: "kubernetes ingress controller", limit: 5 },
        { ftsIndex: null, embedFile: path.join(freshRoot, "nonexistent.embed.db") }
      );
      expect(result.matches.length).toBeGreaterThan(0);
      for (const m of result.matches) {
        expect(m.stale).toBe(false);
        expect(m.age_days).toBeLessThan(2);
      }
    } finally {
      await fs.rm(freshRoot, { recursive: true, force: true });
    }
  });

  it("is fail-soft: the search still returns hits even if a hit path is unstattable", async () => {
    // FTS5-less TF-IDF path reads from the live vault, so every match path
    // exists at stat time; this asserts the happy path doesn't throw and the
    // fields are present (the catch-branch omission is exercised structurally
    // by the try/catch — a missing file simply omits the two fields).
    const v = new Vault(sRoot);
    const result = await searchHybrid(
      v,
      { query: "kubernetes", limit: 5 },
      { ftsIndex: null, embedFile: path.join(sRoot, "nonexistent.embed.db") }
    );
    expect(result.matches.length).toBeGreaterThan(0);
    // Every hit from a live vault gets enriched (no stat failures expected here).
    for (const m of result.matches) {
      expect(typeof m.age_days).toBe("number");
      expect(typeof m.stale).toBe("boolean");
    }
  });
});

// v3.10 (rc.5) — opt-in recency re-ranking. A vault with a MORE-relevant but
// OLD note and a LESS-relevant but FRESH note: by default the old-but-relevant
// note ranks first; with a high recency weight the fresh note rises. weight=0
// must be a provable no-op. mtimes controlled via fs.utimes.
describe("searchHybrid — opt-in recency re-ranking (v3.10 rc.5)", () => {
  const DAY = 86_400_000;
  let rRoot: string;

  beforeAll(async () => {
    rRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-hybrid-recency-"));
    // alpha: 3× the query term → higher TF-IDF relevance, but OLD (1000 days).
    await fs.writeFile(path.join(rRoot, "alpha.md"), "kubernetes kubernetes kubernetes ingress controller.\n");
    // beta: 1× the term → lower relevance, but FRESH (1 day).
    await fs.writeFile(path.join(rRoot, "beta.md"), "kubernetes ingress controller notes.\n");
    const now = Date.now();
    await fs.utimes(path.join(rRoot, "alpha.md"), new Date(now - 1000 * DAY), new Date(now - 1000 * DAY));
    await fs.utimes(path.join(rRoot, "beta.md"), new Date(now - 1 * DAY), new Date(now - 1 * DAY));
  });

  afterAll(async () => {
    await fs.rm(rRoot, { recursive: true, force: true });
  });

  const embedFile = () => path.join(rRoot, "nonexistent.embed.db");

  it("baseline (no recency config): the more-relevant OLD note ranks first", async () => {
    const v = new Vault(rRoot);
    const result = await searchHybrid(v, { query: "kubernetes", limit: 5 }, { ftsIndex: null, embedFile: embedFile() });
    expect(result.matches.length).toBe(2);
    expect(result.matches[0]?.path).toBe("alpha.md"); // relevance wins by default
  });

  it("with recency weight 1.0, the FRESH note rises above the more-relevant old one", async () => {
    const v = new Vault(rRoot);
    const fixedNow = (await fs.stat(path.join(rRoot, "beta.md"))).mtimeMs + DAY;
    const result = await searchHybrid(
      v,
      { query: "kubernetes", limit: 5 },
      { ftsIndex: null, embedFile: embedFile(), recency: { weight: 1, staleDays: 365, nowMs: fixedNow } }
    );
    expect(result.matches.length).toBe(2);
    // weight 1 → order is purely by recency → the 1-day note beats the 1000-day note.
    expect(result.matches[0]?.path).toBe("beta.md");
    expect(result.matches[1]?.path).toBe("alpha.md");

    // NEGATIVE control: pinning the reference before both mtimes clamps both
    // ages to zero. Their recency keys tie, so stable relevance order returns.
    const beforeBothMtimes = await searchHybrid(
      v,
      { query: "kubernetes", limit: 5 },
      {
        ftsIndex: null,
        embedFile: embedFile(),
        recency: { weight: 1, staleDays: 365, nowMs: fixedNow - 2_000 * DAY }
      }
    );
    expect(beforeBothMtimes.matches.map((match) => match.path)).toEqual(["alpha.md", "beta.md"]);
  });

  // NEGATIVE control: weight 0 must NOT change anything — identical to baseline.
  // This proves the blend is a true no-op when off (the default), so nobody is
  // surprised by recency silently reordering relevance.
  it("NEGATIVE control — recency weight 0 is a provable no-op (order == baseline)", async () => {
    const v = new Vault(rRoot);
    const baseline = await searchHybrid(
      v,
      { query: "kubernetes", limit: 5 },
      { ftsIndex: null, embedFile: embedFile() }
    );
    const withZero = await searchHybrid(
      v,
      { query: "kubernetes", limit: 5 },
      { ftsIndex: null, embedFile: embedFile(), recency: { weight: 0, staleDays: 365 } }
    );
    expect(withZero.matches.map((m) => m.path)).toEqual(baseline.matches.map((m) => m.path));
    expect(withZero.matches[0]?.path).toBe("alpha.md"); // still relevance-first
  });

  it("a smaller staleDays (faster decay) still ranks the fresh note first at high weight", async () => {
    const v = new Vault(rRoot);
    const result = await searchHybrid(
      v,
      { query: "kubernetes", limit: 5 },
      { ftsIndex: null, embedFile: embedFile(), recency: { weight: 0.9, staleDays: 30 } }
    );
    expect(result.matches[0]?.path).toBe("beta.md");
  });
});

// v3.10.0-rc.8 (post-rc.7 audit) — the fusion-stage privacy prune. This guards
// the fusion-stage consumers of `fused` (graph-boost reads candidate CONTENT;
// recency stats candidate mtime) which run BEFORE the response-build
// isExcluded guard. Tested as a PURE unit (predicate injected) because the
// public searchHybrid path can't inject an excluded id into `fused` — the
// per-arm ranker filters already drop them — so an integration test would be
// vacuous (verified: it passed with the prune disabled).
describe("pruneExcludedHits (v3.10 rc.8 — fusion-stage isExcluded parity)", () => {
  const hits = [{ id: "Public/a.md" }, { id: "Personal/diary.md" }, { id: "Public/b.md" }];
  const isExcludedPersonal = (p: string) => p.startsWith("Personal/");

  it("removes excluded note-granularity ids, preserves order of the rest", () => {
    const out = pruneExcludedHits(hits, isExcludedPersonal, "note");
    expect(out.map((h) => h.id)).toEqual(["Public/a.md", "Public/b.md"]);
  });

  it("strips the #chunk suffix before the membership test (block granularity)", () => {
    const blockHits = [{ id: "Public/a.md#0" }, { id: "Personal/diary.md#3" }, { id: "Public/b.md#1" }];
    const out = pruneExcludedHits(blockHits, isExcludedPersonal, "block");
    expect(out.map((h) => h.id)).toEqual(["Public/a.md#0", "Public/b.md#1"]);
  });

  it("does NOT strip a literal '#' in a note-granularity filename (C# Notes.md)", () => {
    // In "note" granularity the id IS the path — a `#` in the name is part of it.
    const csharp = [{ id: "C# Notes.md" }];
    expect(pruneExcludedHits(csharp, () => false, "note").map((h) => h.id)).toEqual(["C# Notes.md"]);
    // And it's correctly excluded when the predicate matches the full name.
    expect(pruneExcludedHits(csharp, (p) => p === "C# Notes.md", "note")).toEqual([]);

    // Block ids may be unsuffixed (TF-IDF) or `path#<digits>`. lastIndexOf("#")
    // would treat `C# Notes.md` as path `C` and miss the exclusion.
    expect(pruneExcludedHits(csharp, (p) => p === "C# Notes.md", "block")).toEqual([]);
    expect(pruneExcludedHits(csharp, (p) => p === "C", "block").map((h) => h.id)).toEqual(["C# Notes.md"]);
    const csharpChunk = [{ id: "C# Notes.md#0" }];
    expect(pruneExcludedHits(csharpChunk, (p) => p === "C# Notes.md", "block")).toEqual([]);
    expect(pruneExcludedHits(csharpChunk, (p) => p === "C", "block").map((h) => h.id)).toEqual(["C# Notes.md#0"]);
  });

  // NEGATIVE control: the prune MUST be driven by the predicate. A predicate
  // that excludes nothing leaves the list intact; one that matches an entry
  // removes exactly it. A no-op impl (`return hits`) FAILS the second assertion
  // — this is what made the integration test vacuous and this one real.
  it("NEGATIVE control — driven by the predicate, not unconditional", () => {
    expect(pruneExcludedHits(hits, () => false, "note")).toHaveLength(3); // excludes nothing
    expect(pruneExcludedHits(hits, () => true, "note")).toHaveLength(0); // excludes everything
    expect(pruneExcludedHits(hits, isExcludedPersonal, "note")).toHaveLength(2); // exactly the 1 excluded removed
  });
});

// v3.10.0-rc.22 (audit M8) — embeddingsSearch's privacy filter, extracted from
// two inline `.filter(row => !vault.isExcluded(row.rel_path))` sites so it's
// unit-testable without the ML embedder. Before rc.22 the security test
// REIMPLEMENTED this filter inline (never ran the real one) — a vacuous test
// that would have passed even if embeddingsSearch dropped its guard.
describe("filterExcludedEmbedHits (v3.10 rc.22 — embeddingsSearch privacy filter)", () => {
  const rows = [
    { rel_path: "Public/a.md", score: 1 },
    { rel_path: "Personal/diary.md", score: 0.9 },
    { rel_path: "Public/b.md", score: 0.8 }
  ];
  const isExcludedPersonal = (p: string) => p.startsWith("Personal/");

  it("removes excluded rel_paths, preserves order of the rest", () => {
    const out = filterExcludedEmbedHits(rows, isExcludedPersonal);
    expect(out.map((r) => r.rel_path)).toEqual(["Public/a.md", "Public/b.md"]);
  });

  // NEGATIVE control: must be predicate-driven (a no-op `return hits` fails the
  // "excludes everything" assertion). This is the exact filter embeddingsSearch
  // applies at search.ts ~1100/1106.
  it("NEGATIVE control — driven by the predicate, not unconditional", () => {
    expect(filterExcludedEmbedHits(rows, () => false)).toHaveLength(3); // excludes nothing
    expect(filterExcludedEmbedHits(rows, () => true)).toHaveLength(0); // excludes everything
    expect(filterExcludedEmbedHits(rows, isExcludedPersonal)).toHaveLength(2); // exactly 1 removed
  });
});

// v3.10 (rc.10) — frontmatter-aware retrieval filter. Pure matcher unit-tested
// directly (semantics), then the opt-in filter exercised end-to-end through
// searchHybrid with a NEGATIVE control proving it actually narrows.
describe("frontmatterMatches (v3.10 rc.10 — filter semantics)", () => {
  it("scalar equality, strings case-insensitive", () => {
    expect(frontmatterMatches({ status: "Active" }, { status: "active" })).toBe(true);
    expect(frontmatterMatches({ status: "done" }, { status: "active" })).toBe(false);
  });
  it("array frontmatter value matches by membership", () => {
    expect(frontmatterMatches({ tags: ["proj", "x"] }, { tags: "proj" })).toBe(true);
    expect(frontmatterMatches({ tags: ["a", "b"] }, { tags: "proj" })).toBe(false);
  });
  it("array filter value is OR; multiple keys are AND", () => {
    expect(frontmatterMatches({ type: "meeting" }, { type: ["meeting", "decision"] })).toBe(true);
    expect(frontmatterMatches({ status: "active", type: "meeting" }, { status: "active", type: "decision" })).toBe(
      false
    );
  });
  it("numbers/booleans are strict (no cross-type coercion)", () => {
    expect(frontmatterMatches({ priority: 1, pinned: true }, { priority: 1, pinned: true })).toBe(true);
    expect(frontmatterMatches({ priority: 1 }, { priority: "1" })).toBe(false); // 1 ≠ "1"
  });
  it("missing key, empty, or absent frontmatter never matches a filter", () => {
    expect(frontmatterMatches({ status: "active" }, { type: "meeting" })).toBe(false); // missing key
    expect(frontmatterMatches({}, { status: "active" })).toBe(false);
    expect(frontmatterMatches(undefined, { status: "active" })).toBe(false);
    expect(frontmatterMatches(null, { status: "active" })).toBe(false);
  });
  // NEGATIVE control: the matcher must DISCRIMINATE — a satisfiable filter
  // returns true, an unsatisfiable one false. A constant impl fails one of these.
  it("NEGATIVE control — discriminates (not constant)", () => {
    const fm = { status: "active", type: "meeting" };
    expect(frontmatterMatches(fm, { status: "active" })).toBe(true);
    expect(frontmatterMatches(fm, { status: "archived" })).toBe(false);
  });
});

describe("searchHybrid — opt-in frontmatter filter (v3.10 rc.10)", () => {
  let fmRoot: string;
  beforeAll(async () => {
    fmRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-hybrid-fm-"));
    await fs.writeFile(
      path.join(fmRoot, "active.md"),
      "---\nstatus: active\ntype: project\n---\nkubernetes ingress controller routing.\n"
    );
    await fs.writeFile(
      path.join(fmRoot, "done.md"),
      "---\nstatus: done\ntype: project\n---\nkubernetes ingress controller routing.\n"
    );
    await fs.writeFile(path.join(fmRoot, "nofm.md"), "kubernetes ingress controller routing, no frontmatter.\n");
  });
  afterAll(async () => {
    await fs.rm(fmRoot, { recursive: true, force: true });
  });

  it("filters hits to notes whose frontmatter matches (and excludes no-frontmatter / non-matching)", async () => {
    const v = new Vault(fmRoot);
    const result = await searchHybrid(
      v,
      { query: "kubernetes ingress", limit: 10, filter_frontmatter: { status: "active" } },
      { ftsIndex: null, embedFile: path.join(fmRoot, "nonexistent.embed.db") }
    );
    expect(result.matches.map((m) => m.path)).toEqual(["active.md"]);
  });

  // NEGATIVE control: WITHOUT the filter, the same query returns all three —
  // proving the filter above actually removed done.md + nofm.md (not that the
  // query only matched one note).
  it("NEGATIVE control — no filter returns all three (the filter is what narrowed it)", async () => {
    const v = new Vault(fmRoot);
    const result = await searchHybrid(
      v,
      { query: "kubernetes ingress", limit: 10 },
      { ftsIndex: null, embedFile: path.join(fmRoot, "nonexistent.embed.db") }
    );
    const paths = result.matches.map((m) => m.path).sort();
    expect(paths).toEqual(["active.md", "done.md", "nofm.md"]);
  });

  it("array-value frontmatter filter (OR) + AND across keys", async () => {
    const v = new Vault(fmRoot);
    const result = await searchHybrid(
      v,
      { query: "kubernetes ingress", limit: 10, filter_frontmatter: { type: "project", status: ["active", "done"] } },
      { ftsIndex: null, embedFile: path.join(fmRoot, "nonexistent.embed.db") }
    );
    expect(result.matches.map((m) => m.path).sort()).toEqual(["active.md", "done.md"]); // both projects, nofm excluded
  });
});

describe("searchHybridMulti — multi-query fan-out (v3.11.6-rc.7 C-4)", () => {
  const noEmbed = () => ({ ftsIndex: null, embedFile: path.join(root, "nonexistent.embed.db") });

  it.each([
    ["short", (length: number) => Array.from({ length: Math.max(0, length - 1) }, () => 0.5), /scores for/u],
    ["NaN", (length: number) => Array.from({ length }, () => Number.NaN), /non-finite/u],
    ["Infinity", (length: number) => Array.from({ length }, () => Number.POSITIVE_INFINITY), /non-finite/u]
  ])("atomically rejects a %s reranker vector and preserves the fused order", async (_kind, makeScores, reason) => {
    const v = new Vault(root);
    const args = { query: "OAuth authentication token", limit: 5 } as const;
    const baseline = await searchHybrid(v, args, noEmbed());
    expect(baseline.matches.length).toBeGreaterThan(1);
    const malformed = await searchHybrid(v, args, {
      ...noEmbed(),
      rerankerOverride: {
        score: async (_query: string, passages: readonly string[]) => makeScores(passages.length)
      }
    });
    expect(malformed.matches.map((match) => match.path)).toEqual(baseline.matches.map((match) => match.path));
    expect(malformed.reranked).toMatchObject({ applied: false });
    expect(malformed.reranked && "pairs" in malformed.reranked).toBe(false);
    expect(malformed.reranked?.reason).toMatch(reason);
    expect(malformed.signal_errors?.reranker).toMatch(reason);
    expect(malformed.matches.every((match) => match.reranker_score === undefined)).toBe(true);
  });

  it("applies one exact finite reranker vector after complete admission", async () => {
    const v = new Vault(root);
    const result = await searchHybrid(
      v,
      { query: "OAuth authentication token", limit: 5 },
      {
        ...noEmbed(),
        rerankerOverride: {
          score: async (_query: string, passages: readonly string[]) => passages.map((_passage, index) => index)
        }
      }
    );
    expect(result.matches.length).toBeGreaterThan(1);
    expect(result.reranked).toEqual({ applied: true, pairs: result.matches.length });
    expect(result.signal_errors?.reranker).toBeUndefined();
    expect(result.matches.some((match) => Number.isFinite(match.reranker_score))).toBe(true);
  });

  it.each(["empty fan-out"])("rejects an invalid embedding namespace before the %s import path", async () => {
    let ensureCalls = 0;
    const v = {
      root,
      ensureExists: async () => {
        ensureCalls += 1;
      }
    } as unknown as Vault;
    await expect(
      searchHybridMulti(
        v,
        { query: "", queries: [] },
        { ftsIndex: null, embedFile: path.join(root, "unadmitted-index") }
      )
    ).rejects.toThrowError(new TypeError("Embedding index file must end exactly in '.embed.db'"));
    expect(ensureCalls).toBe(0);
  });

  const syntheticTfidfScenario = (size: number) => {
    let snapshot = 1;
    let corpusReads = 0;
    const vault = {
      ensureExists: async () => {},
      listMarkdown: async () =>
        Array.from({ length: size }, (_, i) => ({
          absPath: `/synthetic/n${i}.md`,
          relPath: `n${i}.md`,
          basename: `n${i}.md`,
          mtimeMs: snapshot
        })),
      readNote: async (_absPath: string, knownMtimeMs?: number) => {
        if (typeof knownMtimeMs === "number") corpusReads += 1;
        const content = "scenario corpus filler body";
        return {
          content,
          parsed: { body: content },
          mtimeMs: knownMtimeMs ?? snapshot
        };
      }
    } as unknown as Vault;
    return {
      vault,
      corpusReads: () => corpusReads,
      invalidate: () => {
        snapshot += 1;
      }
    };
  };
  const runSyntheticTfidfScenario = async (vault: Vault, queryCount: 1 | 9) => {
    const ctx = { ftsIndex: null, embedFile: "/synthetic/nonexistent.embed.db" };
    if (queryCount === 1) {
      await searchHybrid(vault, { query: "zznomatch0", limit: 10 }, ctx);
      return;
    }
    await searchHybridMulti(
      vault,
      { queries: Array.from({ length: queryCount }, (_, i) => `zznomatch${i}`), limit: 10 },
      ctx
    );
  };

  it("fuses two phrasings so a note matching EITHER floats up (union behavior)", async () => {
    const v = new Vault(root);
    // "OAuth authentication" → OAuth Flows.md; "refresh token rotation" → JWT Validation.md.
    // Neither phrasing alone surfaces both Auth notes; the fan-out should.
    const result = await searchHybridMulti(
      v,
      { queries: ["OAuth authentication", "refresh token rotation"], limit: 5 },
      noEmbed()
    );
    expect(result.method).toBe("rrf");
    const paths = result.matches.map((m) => m.path);
    expect(paths).toContain("Auth/OAuth Flows.md");
    expect(paths).toContain("Auth/JWT Validation.md");
    // NEGATIVE control — irrelevant cooking notes stay out.
    expect(paths.some((p) => p.startsWith("Cooking/"))).toBe(false);
    // the echo joins the phrasings for observability
    expect(result.query).toBe("OAuth authentication | refresh token rotation");
  });

  it("a note ranking well in ANY single phrasing is not dropped by an unrelated phrasing", async () => {
    const v = new Vault(root);
    // "JWT signature validation" strongly hits JWT Validation.md; the second
    // phrasing is unrelated (carbonara) → JWT note must still surface via q0.
    const result = await searchHybridMulti(
      v,
      { queries: ["JWT signature validation", "carbonara guanciale"], limit: 5 },
      noEmbed()
    );
    const paths = result.matches.map((m) => m.path);
    expect(paths).toContain("Auth/JWT Validation.md");
  });

  it("single-phrasing fan-out returns the same top note as plain searchHybrid (sanity)", async () => {
    const v = new Vault(root);
    const multi = await searchHybridMulti(v, { queries: ["OAuth JWT tokens"], limit: 5 }, noEmbed());
    const single = await searchHybrid(v, { query: "OAuth JWT tokens", limit: 5 }, noEmbed());
    expect(multi.matches[0]?.path).toBe(single.matches[0]?.path);
  });

  it("dedupes a note that appears in multiple phrasings (one entry, fused score)", async () => {
    const v = new Vault(root);
    // both phrasings hit OAuth Flows.md; it must appear exactly once.
    const result = await searchHybridMulti(
      v,
      { queries: ["OAuth authorization server", "OAuth access tokens"], limit: 5 },
      noEmbed()
    );
    const oauthEntries = result.matches.filter((m) => m.path === "Auth/OAuth Flows.md");
    expect(oauthEntries.length).toBe(1);
  });

  it("caps the fan-out count (MAX_FANOUT_QUERIES = 8) — DoS bound on an always-on tool", () => {
    // The schema enforces the cap at the boundary; the constant is the contract.
    // (rc.12: the schema-side `.max()` pins are now ALSO in the
    // parser-input-cap-invariant inventory — this pins the constant's value.)
    expect(MAX_FANOUT_QUERIES).toBe(8);
  });

  // v3.12.0-rc.3 (compiled scenario matrix) — H-1 was measured at 6.4k notes,
  // but the original regression pinned only one cold 9-query/150-note cell.
  // Exercise both realistic and incident-scale corpora, single and maximum
  // legal fan-out, then repeat warm. NUMERIC-mtime reads isolate the corpus
  // build because every query deliberately has no matching token.
  it("matrix: cold/warm × 1/9 queries × 100/6400 notes builds one TF-IDF corpus pass (H-1)", async () => {
    for (const size of [100, 6_400]) {
      for (const queryCount of [1, 9] as const) {
        const scenario = syntheticTfidfScenario(size);
        const cell = `${size} notes / ${queryCount} ${queryCount === 1 ? "query" : "queries"}`;

        await runSyntheticTfidfScenario(scenario.vault, queryCount);
        expect(scenario.corpusReads(), `${cell}: cold must build exactly one corpus pass`).toBe(size);

        await runSyntheticTfidfScenario(scenario.vault, queryCount);
        expect(scenario.corpusReads(), `${cell}: warm must reuse the completed corpus`).toBe(size);

        // NEGATIVE control — a changed mtime snapshot must invalidate and add
        // exactly one new pass. This proves a frozen/no-op harness cannot pass.
        scenario.invalidate();
        await runSyntheticTfidfScenario(scenario.vault, queryCount);
        expect(scenario.corpusReads(), `${cell}: changed snapshot must rebuild`).toBe(2 * size);
      }
    }
  });

  // Same-scope callers share discovery + build. If the source changes while
  // that shared generation is in flight, every waiter fails closed and the
  // next call builds the new generation exactly once.
  it("a changed slow TF-IDF generation refuses every waiter then rebuilds once", async () => {
    let snapshot = 1;
    let reads = 0;
    let listings = 0;
    let oldReadStarted = false;
    let releaseOld: (() => void) | undefined;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const entry = (mtimeMs: number) => ({
      absPath: "/synthetic/Note.md",
      relPath: "Note.md",
      basename: "Note.md",
      mtimeMs
    });
    const fakeVault = {
      listMarkdown: async () => {
        listings += 1;
        return [entry(snapshot)];
      },
      readNote: async (_absPath: string, mtimeMs?: number) => {
        reads += 1;
        if (mtimeMs === 1) {
          oldReadStarted = true;
          await oldGate;
        }
        return { parsed: { body: `snapshot ${mtimeMs ?? 0}` } };
      }
    } as unknown as Vault;

    const oldBuild = buildTfidfIndex(fakeVault);
    await vi.waitFor(() => expect(oldReadStarted).toBe(true));

    snapshot = 2;
    const joinedBuild = buildTfidfIndex(fakeVault);
    const oldRefusal = expect(oldBuild).rejects.toMatchObject({ code: "TFIDF_GENERATION_CHANGED" });
    const joinedRefusal = expect(joinedBuild).rejects.toMatchObject({ code: "TFIDF_GENERATION_CHANGED" });
    expect(reads).toBe(1);
    expect(listings, "same-scope waiter must not repeat discovery").toBe(1);
    releaseOld?.();
    await Promise.all([oldRefusal, joinedRefusal]);

    const newest = await buildTfidfIndex(fakeVault);
    expect(newest.entriesRef[0]?.mtimeMs).toBe(2);
    expect(reads).toBe(2);

    const readsBeforeReuse = reads;
    const reused = await buildTfidfIndex(fakeVault);
    expect(reused).toBe(newest);
    expect(reused.entriesRef[0]?.mtimeMs).toBe(2);
    expect(reads, "newest cache must survive the older promise completing last").toBe(readsBeforeReuse);

    // NEGATIVE control: a genuinely newer third snapshot must still invalidate
    // and rebuild; the publication guard must not freeze snapshot 2 forever.
    snapshot = 3;
    const third = await buildTfidfIndex(fakeVault);
    expect(third.entriesRef[0]?.mtimeMs).toBe(3);
    expect(reads).toBe(readsBeforeReuse + 1);
  });

  // rc.12 (pre-promotion re-sweep) — the multi path used to silently DROP the
  // `reranked` response field even though every sub-query ran the reranker,
  // reopening the v3.10.0-rc.13 Issue-9 observability gap for `queries[]` callers.
  it("carries the reranker outcome through the fan-out (union of sub-query `reranked`)", async () => {
    const v = new Vault(root);
    const scored: number[][] = [];
    const rerankerOverride = {
      score: async (_q: string, passages: readonly string[]) => {
        const s = passages.map((_, i) => 1 - i * 0.01);
        scored.push(s);
        return s;
      }
    };
    const result = await searchHybridMulti(
      v,
      { queries: ["OAuth authentication", "refresh token rotation"], limit: 5 },
      { ...noEmbed(), rerankerOverride }
    );
    expect(result.reranked?.applied).toBe(true);
    // pairs = sum across sub-queries; the override really ran for each phrasing.
    expect(scored.length).toBe(2);
    expect(result.reranked && "pairs" in result.reranked ? result.reranked.pairs : 0).toBe(
      scored.reduce((n, s) => n + s.length, 0)
    );

    // AH-1 late fan-out receipt revalidation shares this established
    // reranker registration; the inner scope keeps its fixture independent.
    {
      const receiptVault = new Vault(root);
      const relPath = "Auth/Fanout receipt.md";
      const absPath = path.join(root, relPath);
      const siblingRelPath = "Auth/Fanout current sibling.md";
      const siblingAbsPath = path.join(root, siblingRelPath);
      const queries = ["fanreceiptzero", "fanreceiptone", "fanreceipttwo", "fanreceiptthree", "fanreceiptfour"];
      const oldContent = `${queries.join(" ")} fanout_persisted_secret\n`;
      const siblingContent = `${queries.join(" ")} fanout_current_sibling\n`;
      await fs.writeFile(absPath, oldContent);
      await fs.writeFile(siblingAbsPath, siblingContent);
      const indexedMtimeMs = (await fs.stat(absPath)).mtimeMs;
      const siblingMtimeMs = (await fs.stat(siblingAbsPath)).mtimeMs;
      const ftsFile = path.join(root, ".fanout-receipt.fts5.db");
      const fts = new FtsIndex({ file: ftsFile, vaultRoot: root });
      await fts.open();
      fts.reindexFile(relPath, indexedMtimeMs, oldContent, [], []);
      fts.reindexFile(siblingRelPath, siblingMtimeMs, siblingContent, [], []);

      let releaseBlocked: (() => void) | undefined;
      const mutationDone = new Promise<void>((resolve) => {
        releaseBlocked = resolve;
      });
      let replaced = false;
      let queryZeroSawOldGeneration = false;
      const receiptReranker = {
        score: async (query: string, passages: readonly string[]) => {
          if (query === queries[4]) {
            fts.reindexFile(relPath, indexedMtimeMs, "new indexed generation without prior markers\n", [], []);
            replaced = true;
            releaseBlocked?.();
          } else if (query === queries[0]) {
            queryZeroSawOldGeneration = passages.some((passage) => passage.includes("fanout_persisted_secret"));
          } else {
            await mutationDone;
          }
          return passages.map(() => 0.5);
        }
      };

      try {
        const receiptResult = await searchHybridMulti(
          receiptVault,
          { queries, limit: 5 },
          { ftsIndex: fts, embedFile: path.join(root, "nonexistent.embed.db"), rerankerOverride: receiptReranker }
        );
        expect(replaced).toBe(true);
        expect(queryZeroSawOldGeneration).toBe(true);
        expect(fts.totalChunks()).toBeGreaterThanOrEqual(2);
        expect(receiptResult.matches.every((match) => match.path !== relPath)).toBe(true);
        expect(receiptResult.matches.every((match) => !match.snippet.includes("fanout_persisted_secret"))).toBe(true);
        expect(receiptResult.matches.some((match) => match.path === siblingRelPath)).toBe(true);
      } finally {
        releaseBlocked?.();
        await fts.closeAndRelease();
        await fs.unlink(absPath).catch(() => {});
        await fs.unlink(siblingAbsPath).catch(() => {});
        for (const dbArtifact of [ftsFile, `${ftsFile}-wal`, `${ftsFile}-shm`]) {
          await fs.unlink(dbArtifact).catch(() => {});
        }
      }
    }
  });

  it("NEGATIVE control — no reranker configured ⇒ no `reranked` field on the multi response", async () => {
    const v = new Vault(root);
    const result = await searchHybridMulti(v, { queries: ["OAuth authentication"], limit: 5 }, noEmbed());
    expect("reranked" in result).toBe(false);
  });
});

// ─── v3.11.6 (S-5) — opt-in `explain` mode ──────────────────────────────────
// The three ranker arms were already exposed via `per_signal` and the reranker
// via `reranker_score`, but graph-boost / recency / feedback contributions —
// and the RANK MOVEMENT any re-rank stage caused — were invisible, so you could
// not tell whether the opt-in `--recency-weight` / `--feedback-weight` stages
// actually changed the order (both were "evidence-poor" per the Codex audit).
// `explain: true` attaches a per-hit breakdown; off ⇒ no field (byte-identical).
describe("searchHybrid — opt-in explain mode (v3.11.6 S-5)", () => {
  let eRoot: string;

  beforeAll(async () => {
    eRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-hybrid-explain-"));
    // apex: 3× the query term → most relevant (TF-IDF rank 0).
    await fs.writeFile(path.join(eRoot, "apex.md"), "kubernetes kubernetes kubernetes ingress controller.\n");
    // base: 1× the term → less relevant (rank 1).
    await fs.writeFile(path.join(eRoot, "base.md"), "kubernetes ingress controller notes.\n");
  });

  afterAll(async () => {
    await fs.rm(eRoot, { recursive: true, force: true });
  });

  const embedFile = () => path.join(eRoot, "nonexistent.embed.db");

  it("attaches a per-hit explain (rrf rank/score + final_rank) when explain:true", async () => {
    const v = new Vault(eRoot);
    const result = await searchHybrid(
      v,
      { query: "kubernetes", limit: 5, explain: true },
      { ftsIndex: null, embedFile: embedFile() }
    );
    expect(result.matches.length).toBe(2);
    result.matches.forEach((m, i) => {
      expect(m.explain).toBeDefined();
      expect(m.explain?.final_rank).toBe(i);
      expect(typeof m.explain?.rrf.rank).toBe("number");
      expect(typeof m.explain?.rrf.score).toBe("number");
      // No reranker/recency/feedback stage ran → those sub-objects are absent.
      expect(m.explain?.reranker).toBeUndefined();
      expect(m.explain?.recency).toBeUndefined();
      expect(m.explain?.feedback).toBeUndefined();
    });
    // The RRF rank the explain reports is the pre-re-rank order (apex first).
    expect(result.matches[0]?.explain?.rrf.rank).toBe(0);
  });

  // NEGATIVE control — without explain, no hit carries the field, and the rest
  // of the response is byte-identical (proving the mode is opt-in, zero-cost).
  it("NEGATIVE control — no explain field when the flag is off (byte-identical default)", async () => {
    const v = new Vault(eRoot);
    const withoutFlag = await searchHybrid(
      v,
      { query: "kubernetes", limit: 5 },
      { ftsIndex: null, embedFile: embedFile() }
    );
    const withFalse = await searchHybrid(
      v,
      { query: "kubernetes", limit: 5, explain: false },
      { ftsIndex: null, embedFile: embedFile() }
    );
    for (const m of [...withoutFlag.matches, ...withFalse.matches]) {
      expect(m.explain).toBeUndefined();
      expect("explain" in m).toBe(false);
    }
    // Order + scores identical with the flag off vs absent.
    expect(withFalse.matches.map((m) => m.path)).toEqual(withoutFlag.matches.map((m) => m.path));
  });

  // The headline S-5 value: a feedback re-rank that actually MOVES a note is now
  // VISIBLE. weight 1 → order is purely by feedback score, so the boosted note
  // rises and explain records rank_before > rank_after (and the demoted note the
  // reverse). This is what "validate that mark_useful actually helps" means.
  it("makes feedback rank movement visible (rank_before → rank_after)", async () => {
    const v = new Vault(eRoot);
    const fbScores = new Map<string, number>([
      ["base.md", 0.9], // the LESS-relevant note gets a strong human upvote
      ["apex.md", 0.1]
    ]);
    const result = await searchHybrid(
      v,
      { query: "kubernetes", limit: 5, explain: true },
      { ftsIndex: null, embedFile: embedFile(), feedback: { weight: 1, scores: fbScores } }
    );
    // weight 1 → base (fb 0.9) beats apex (fb 0.1) → base is now rank 0.
    expect(result.matches[0]?.path).toBe("base.md");
    expect(result.matches[1]?.path).toBe("apex.md");
    const base = result.matches.find((m) => m.path === "base.md");
    const apex = result.matches.find((m) => m.path === "apex.md");
    // base moved UP (1 → 0); apex moved DOWN (0 → 1) — the explain proves it.
    expect(base?.explain?.feedback?.feedback_score).toBeCloseTo(0.9, 5);
    expect(base?.explain?.feedback?.rank_before).toBeGreaterThan(base?.explain?.feedback?.rank_after ?? -1);
    expect(apex?.explain?.feedback?.rank_after).toBeGreaterThan(apex?.explain?.feedback?.rank_before ?? -1);
  });

  it("exposes wikilink graph-boost in_degree for a hub note", async () => {
    const gRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-hybrid-explain-graph-"));
    try {
      await fs.writeFile(path.join(gRoot, "hub.md"), "central kubernetes topic.\n");
      await fs.writeFile(path.join(gRoot, "a.md"), "kubernetes see [[hub]] for more.\n");
      await fs.writeFile(path.join(gRoot, "b.md"), "kubernetes also [[hub]] here.\n");
      const v = new Vault(gRoot);
      const result = await searchHybrid(
        v,
        { query: "kubernetes", limit: 5, explain: true, graph_boost: true },
        { ftsIndex: null, embedFile: path.join(gRoot, "none.embed.db") }
      );
      const hub = result.matches.find((m) => m.path === "hub.md");
      expect(hub?.explain?.graph_boost?.in_degree).toBe(2); // a.md + b.md both link it
      expect(hub?.explain?.graph_boost?.score_delta).toBe(0);
      for (const m of result.matches) {
        expect(m.explain?.final_rank).toBe(m.explain?.rrf.rank);
      }
      // The leaf notes received no in-links → no graph_boost sub-object.
      // rc.12 — assert presence FIRST so the optional-chained absence check
      // can't pass vacuously if a.md ever drops out of the matches.
      const a = result.matches.find((m) => m.path === "a.md");
      expect(a).toBeDefined();
      expect(a?.explain?.graph_boost).toBeUndefined();
    } finally {
      await fs.rm(gRoot, { recursive: true, force: true });
    }
  });
});

describe("embeddingsSearch — HNSW database-generation authority", () => {
  it("queries HNSW while its physical UUID and mutation epoch match EmbedDb", async () => {
    const fixture = await createSemanticAdmissionFixture();
    const authorityDb = new EmbedDb({
      file: fixture.embedFile,
      vaultRoot: fixture.vaultRoot,
      modelAlias: "multilingual",
      dim: 384,
      quantization: "f32"
    });
    await authorityDb.open();
    const authority = authorityDb.captureGenerationIdentity();
    await authorityDb.closeAndRelease();

    const searchKnn = vi.fn(() => ({ labels: [1], distances: [0] }));
    installSemanticAdmissionRuntimeMocks(vi.fn(async () => undefined));
    try {
      const { embeddingsSearch: isolatedEmbeddingsSearch } = await import("../src/tools/search.js");
      const result = await isolatedEmbeddingsSearch(
        new Vault(fixture.vaultRoot),
        { query: "semantic admission marker", limit: 1 },
        fixture.embedFile,
        {
          index: { size: 1, searchKnn },
          rowByLabel: new Map(),
          modelAlias: "multilingual",
          dbInstanceUuid: authority.dbInstanceUuid,
          dbMutationEpoch: authority.dbMutationEpoch
        }
      );

      expect(searchKnn).toHaveBeenCalled();
      expect(result.matches.map((match) => match.path)).toEqual(["Semantic.md"]);
    } finally {
      resetSemanticAdmissionRuntimeMocks();
      await removeSemanticAdmissionFixture(fixture);
    }
  });

  it("never queries a stale graph after a second EmbedDb writer advances the epoch", async () => {
    const fixture = await createSemanticAdmissionFixture();
    const staleDb = new EmbedDb({
      file: fixture.embedFile,
      vaultRoot: fixture.vaultRoot,
      modelAlias: "multilingual",
      dim: 384,
      quantization: "f32"
    });
    await staleDb.open();
    const staleAuthority = staleDb.captureGenerationIdentity();
    await staleDb.closeAndRelease();

    const writer = new EmbedDb({
      file: fixture.embedFile,
      vaultRoot: fixture.vaultRoot,
      modelAlias: "multilingual",
      dim: 384,
      quantization: "f32"
    });
    await writer.open();
    try {
      const noteStat = await fs.stat(path.join(fixture.vaultRoot, "Semantic.md"));
      const vector = new Float32Array(384);
      vector[0] = 1;
      writer.upsertNote("Semantic.md", noteStat.mtimeMs, [
        {
          chunkIndex: 0,
          lineStart: 1,
          lineEnd: 1,
          textPreview: "current semantic generation",
          vector
        }
      ]);
      expect(writer.captureGenerationIdentity().dbMutationEpoch).toBeGreaterThan(staleAuthority.dbMutationEpoch);
    } finally {
      await writer.closeAndRelease();
    }

    const searchKnn = vi.fn(() => ({ labels: [1], distances: [0] }));
    installSemanticAdmissionRuntimeMocks(vi.fn(async () => undefined));
    try {
      const { embeddingsSearch: isolatedEmbeddingsSearch } = await import("../src/tools/search.js");
      const result = await isolatedEmbeddingsSearch(
        new Vault(fixture.vaultRoot),
        { query: "semantic admission marker", limit: 1 },
        fixture.embedFile,
        {
          index: { size: 1, searchKnn },
          rowByLabel: new Map(),
          modelAlias: "multilingual",
          dbInstanceUuid: staleAuthority.dbInstanceUuid,
          dbMutationEpoch: staleAuthority.dbMutationEpoch
        }
      );

      expect(searchKnn).not.toHaveBeenCalled();
      expect(result.matches.map((match) => match.path)).toEqual(["Semantic.md"]);
      expect(result.matches[0]?.snippet).toContain("current semantic generation");
    } finally {
      resetSemanticAdmissionRuntimeMocks();
      await removeSemanticAdmissionFixture(fixture);
    }
  });

  it("refuses all results when EmbedDb advances during awaited live-vault validation", async () => {
    const fixture = await createSemanticAdmissionFixture();
    installSemanticAdmissionRuntimeMocks(vi.fn(async () => undefined));
    let siblingMutated = false;
    let mutated = false;
    try {
      const { embeddingsSearch: isolatedEmbeddingsSearch } = await import("../src/tools/search.js");
      const unrelatedFile = path.join(fixture.vaultRoot, "Unrelated.md");
      await fs.writeFile(unrelatedFile, "unrelated sibling note\n");
      const siblingVault = new Vault(fixture.vaultRoot);
      await siblingVault.ensureExists();
      const originalSiblingStat = siblingVault.stat.bind(siblingVault);
      const siblingStatSpy = vi.spyOn(siblingVault, "stat").mockImplementation(async (relPath) => {
        if (!siblingMutated) {
          siblingMutated = true;
          const writer = new EmbedDb({
            file: fixture.embedFile,
            vaultRoot: fixture.vaultRoot,
            modelAlias: "multilingual",
            dim: 384,
            quantization: "f32"
          });
          await writer.open();
          try {
            const noteStat = await fs.stat(unrelatedFile);
            const vector = new Float32Array(384);
            vector[0] = 1;
            writer.upsertNote("Unrelated.md", noteStat.mtimeMs, [
              {
                chunkIndex: 0,
                lineStart: 1,
                lineEnd: 1,
                textPreview: "unrelated sibling note",
                vector
              }
            ]);
          } finally {
            await writer.closeAndRelease();
          }
        }
        return originalSiblingStat(relPath);
      });
      const siblingResult = await isolatedEmbeddingsSearch(
        siblingVault,
        { query: "semantic admission marker", limit: 1 },
        fixture.embedFile
      );
      expect(siblingMutated).toBe(true);
      expect(siblingResult.matches.map((match) => match.path)).toEqual(["Semantic.md"]);
      expect(siblingResult.matches[0]?.snippet).toContain("semantic admission marker");
      siblingStatSpy.mockRestore();

      const vault = new Vault(fixture.vaultRoot);
      await vault.ensureExists();
      const originalStat = vault.stat.bind(vault);
      vi.spyOn(vault, "stat").mockImplementation(async (relPath) => {
        if (!mutated) {
          mutated = true;
          const writer = new EmbedDb({
            file: fixture.embedFile,
            vaultRoot: fixture.vaultRoot,
            modelAlias: "multilingual",
            dim: 384,
            quantization: "f32"
          });
          await writer.open();
          try {
            const noteStat = await fs.stat(path.join(fixture.vaultRoot, "Semantic.md"));
            const vector = new Float32Array(384);
            vector[0] = 1;
            writer.upsertNote("Semantic.md", noteStat.mtimeMs, [
              {
                chunkIndex: 0,
                lineStart: 1,
                lineEnd: 1,
                textPreview: "mutated during terminal validation",
                vector
              }
            ]);
          } finally {
            await writer.closeAndRelease();
          }
        }
        return originalStat(relPath);
      });

      await expect(
        isolatedEmbeddingsSearch(vault, { query: "semantic admission marker", limit: 1 }, fixture.embedFile)
      ).rejects.toThrow("Embedding index changed during search; retry the request");
      expect(mutated).toBe(true);
    } finally {
      resetSemanticAdmissionRuntimeMocks();
      await removeSemanticAdmissionFixture(fixture);
    }
  });
});

describe("prepareServerDeps — complete semantic-generation admission", () => {
  it.each([false, true] as const)(
    "keeps brute-force semantic search when a declared source generation is incomplete (useHnsw=%s)",
    async (useHnsw) => {
      const fixture = await createSemanticAdmissionFixture();
      const healthyFile = path.join(fixture.vaultRoot, "Healthy.md");
      await fs.writeFile(healthyFile, "healthy sibling note\n");
      const healthyStat = await fs.stat(healthyFile);
      const writer = new EmbedDb({
        file: fixture.embedFile,
        vaultRoot: fixture.vaultRoot,
        modelAlias: "multilingual",
        dim: 384,
        quantization: "f32"
      });
      await writer.open();
      try {
        const vector = new Float32Array(384);
        vector[0] = 1;
        writer.upsertNote("Healthy.md", healthyStat.mtimeMs, [
          {
            chunkIndex: 0,
            lineStart: 1,
            lineEnd: 1,
            textPreview: "healthy sibling note",
            vector
          }
        ]);
      } finally {
        await writer.closeAndRelease();
      }
      const Database = (await import("better-sqlite3")).default;
      const mutate = new Database(fixture.embedFile);
      try {
        expect(
          mutate.prepare("UPDATE source_state SET n_chunks = 2 WHERE rel_path = ?").run("Semantic.md").changes
        ).toBe(1);
      } finally {
        mutate.close();
      }

      const buildHnsw = vi.fn(async (..._args: unknown[]) => {
        throw new Error("incomplete generations must never reach HNSW build");
      });
      installSemanticAdmissionRuntimeMocks(buildHnsw);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const [{ prepareServerDeps }, { embeddingsSearch: isolatedEmbeddingsSearch }] = await Promise.all([
          import("../src/server.js"),
          import("../src/tools/search.js")
        ]);
        const deps = await prepareServerDeps({
          vault: fixture.vaultRoot,
          useHnsw,
          hnswPersist: false
        });

        expect(deps.watcherHealth).toMatchObject({ semanticUsable: true, hnswUsable: true });
        expect(deps.hnswContext).toBeNull();
        expect(buildHnsw).not.toHaveBeenCalled();
        const result = await isolatedEmbeddingsSearch(
          deps.vault,
          { query: "semantic admission marker", limit: 2 },
          fixture.embedFile,
          deps.hnswContext,
          deps.watcherHealth
        );
        expect(result.method).toBe("embeddings-cosine");
        expect(result.matches.map((match) => match.path).sort()).toEqual(["Healthy.md", "Semantic.md"]);

        const log = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
        expect(log).not.toMatch(/failed complete semantic admission/i);
        if (useHnsw) {
          expect(log).toMatch(/HNSW build failed; falling back to brute-force semantic search/i);
        } else {
          expect(log).not.toMatch(/falling back to brute-force semantic search/i);
        }
      } finally {
        stderr.mockRestore();
        resetSemanticAdmissionRuntimeMocks();
        await removeSemanticAdmissionFixture(fixture);
      }
    }
  );

  it.each(["missing", "corrupt"] as const)(
    "keeps a healthy EmbedDb on the brute-force route when the HNSW sidecar is %s",
    async (sidecarState) => {
      const fixture = await createSemanticAdmissionFixture();
      const persistFile = hnswPersistBase(fixture.embedFile);
      if (sidecarState === "corrupt") {
        await fs.writeFile(`${persistFile}.meta.json`, '{"formatVersion":3');
      }
      const buildHnsw = vi.fn(async (..._args: unknown[]) => {
        throw new Error("bounded synthetic HNSW unavailability");
      });
      installSemanticAdmissionRuntimeMocks(buildHnsw);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const [{ prepareServerDeps }, { embeddingsSearch: isolatedEmbeddingsSearch }] = await Promise.all([
          import("../src/server.js"),
          import("../src/tools/search.js")
        ]);
        const deps = await prepareServerDeps({ vault: fixture.vaultRoot, useHnsw: true });

        expect(buildHnsw).toHaveBeenCalledTimes(1);
        expect(deps.hnswContext).toBeNull();
        expect(deps.watcherHealth).toMatchObject({ semanticUsable: true, hnswUsable: true });
        const result = await isolatedEmbeddingsSearch(
          deps.vault,
          { query: "semantic admission marker", limit: 1 },
          fixture.embedFile,
          deps.hnswContext,
          deps.watcherHealth
        );
        expect(result.method).toBe("embeddings-cosine");
        expect(result.matches.map((match) => match.path)).toEqual(["Semantic.md"]);

        const log = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
        expect(log).toMatch(/HNSW build failed; falling back to brute-force semantic search/i);
        expect(log).not.toMatch(/failed complete semantic admission/i);
      } finally {
        stderr.mockRestore();
        resetSemanticAdmissionRuntimeMocks();
        await removeSemanticAdmissionFixture(fixture);
      }
    }
  );

  it("treats saveTo(false) as an uncommitted optimization without a persisted-success receipt", async () => {
    const fixture = await createSemanticAdmissionFixture();
    const persistFile = hnswPersistBase(fixture.embedFile);
    const saveTo = vi.fn(async (..._args: unknown[]) => false);
    const buildHnsw = vi.fn(async (..._args: unknown[]) => ({
      dim: 384,
      size: 1,
      searchKnn: () => ({ labels: [1], distances: [0] }),
      setEf: () => {},
      applyDiff: async () => {},
      saveTo
    }));
    installSemanticAdmissionRuntimeMocks(buildHnsw);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { prepareServerDeps } = await import("../src/server.js");
      const deps = await prepareServerDeps({ vault: fixture.vaultRoot, useHnsw: true });

      expect(buildHnsw).toHaveBeenCalledTimes(1);
      expect(saveTo).toHaveBeenCalledTimes(1);
      expect(saveTo.mock.calls[0]?.[0]).toBe(persistFile);
      expect(deps.hnswContext?.index.size).toBe(1);
      expect(deps.watcherHealth).toMatchObject({ semanticUsable: true, hnswUsable: true });
      await expect(fs.lstat(`${persistFile}.meta.json`)).rejects.toMatchObject({ code: "ENOENT" });

      const log = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(log).toMatch(/HNSW persist failed.*did not commit its metadata pointer/is);
      expect(log).not.toMatch(/immutable generation \+ meta pointer persisted/i);
    } finally {
      stderr.mockRestore();
      resetSemanticAdmissionRuntimeMocks();
      await removeSemanticAdmissionFixture(fixture);
    }

    const drift = await createSemanticAdmissionFixture();
    const driftPersistFile = hnswPersistBase(drift.embedFile);
    const persistEvents: string[] = [];
    const clear = vi.fn(async (file: unknown, scopes: unknown) => {
      persistEvents.push("clear");
      const actual = await vi.importActual<typeof import("../src/hnsw.js")>("../src/hnsw.js");
      return actual.clearHnswPersistedArtifacts(file as string, scopes as never);
    });
    const driftSaveTo = vi.fn(async (file: unknown, ..._args: unknown[]) => {
      persistEvents.push("save");
      await fs.writeFile(`${String(file)}.meta.json`, '{"formatVersion":4}\n');
      const writer = new EmbedDb({
        file: drift.embedFile,
        vaultRoot: drift.vaultRoot,
        modelAlias: "multilingual",
        dim: 384,
        quantization: "f32"
      });
      await writer.open();
      try {
        const vector = new Float32Array(384);
        vector[0] = 1;
        writer.upsertNote("Unrelated.md", Date.now(), [
          {
            chunkIndex: 0,
            lineStart: 1,
            lineEnd: 1,
            textPreview: "unrelated note indexed during HNSW persist",
            vector
          }
        ]);
      } finally {
        await writer.closeAndRelease();
      }
      return true;
    });
    const driftBuild = vi.fn(async (..._args: unknown[]) => ({
      dim: 384,
      size: 1,
      searchKnn: () => ({ labels: [1], distances: [0] }),
      setEf: () => {},
      applyDiff: async () => {},
      saveTo: driftSaveTo
    }));
    installSemanticAdmissionRuntimeMocks(driftBuild, { clearHnswPersistedArtifacts: clear });
    const driftStderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const [{ prepareServerDeps }, { embeddingsSearch: isolatedEmbeddingsSearch }] = await Promise.all([
        import("../src/server.js"),
        import("../src/tools/search.js")
      ]);
      const deps = await prepareServerDeps({ vault: drift.vaultRoot, useHnsw: true });

      expect(driftBuild).toHaveBeenCalledTimes(1);
      expect(driftSaveTo).toHaveBeenCalledTimes(1);
      expect(driftSaveTo.mock.calls[0]?.[0]).toBe(driftPersistFile);
      expect(persistEvents).toEqual(["save", "clear"]);
      expect(clear).toHaveBeenCalledWith(driftPersistFile, driftSaveTo.mock.calls[0]?.[4]);
      expect(deps.hnswContext).toBeNull();
      expect(deps.watcherHealth).toMatchObject({ semanticUsable: true, hnswUsable: true });
      await expect(fs.lstat(`${driftPersistFile}.meta.json`)).rejects.toMatchObject({ code: "ENOENT" });

      const result = await isolatedEmbeddingsSearch(
        deps.vault,
        { query: "semantic admission marker", limit: 1 },
        drift.embedFile,
        deps.hnswContext,
        deps.watcherHealth
      );
      expect(result.method).toBe("embeddings-cosine");
      expect(result.matches.map((match) => match.path)).toEqual(["Semantic.md"]);

      const log = driftStderr.mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(log).toMatch(/embedding database changed while HNSW was persisting/i);
      expect(log).not.toMatch(/immutable generation \+ meta pointer persisted/i);
    } finally {
      driftStderr.mockRestore();
      resetSemanticAdmissionRuntimeMocks();
      await removeSemanticAdmissionFixture(drift);
    }

    const throwDrift = await createSemanticAdmissionFixture();
    const throwPersistFile = hnswPersistBase(throwDrift.embedFile);
    const throwPersistEvents: string[] = [];
    const throwClear = vi.fn(async (file: unknown, scopes: unknown) => {
      throwPersistEvents.push("clear");
      const actual = await vi.importActual<typeof import("../src/hnsw.js")>("../src/hnsw.js");
      return actual.clearHnswPersistedArtifacts(file as string, scopes as never);
    });
    const throwSaveTo = vi.fn(async (file: unknown, ..._args: unknown[]) => {
      throwPersistEvents.push("save");
      await fs.writeFile(`${String(file)}.meta.json`, '{"formatVersion":4}\n');
      const writer = new EmbedDb({
        file: throwDrift.embedFile,
        vaultRoot: throwDrift.vaultRoot,
        modelAlias: "multilingual",
        dim: 384,
        quantization: "f32"
      });
      await writer.open();
      try {
        const vector = new Float32Array(384);
        vector[0] = 1;
        writer.upsertNote("Unrelated.md", Date.now(), [
          {
            chunkIndex: 0,
            lineStart: 1,
            lineEnd: 1,
            textPreview: "unrelated note indexed during HNSW persist",
            vector
          }
        ]);
      } finally {
        await writer.closeAndRelease();
      }
      throw new Error("injected publisher lease-release failure");
    });
    const throwBuild = vi.fn(async (..._args: unknown[]) => ({
      dim: 384,
      size: 1,
      searchKnn: () => ({ labels: [1], distances: [0] }),
      setEf: () => {},
      applyDiff: async () => {},
      saveTo: throwSaveTo
    }));
    installSemanticAdmissionRuntimeMocks(throwBuild, { clearHnswPersistedArtifacts: throwClear });
    const throwStderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const [{ prepareServerDeps }, { embeddingsSearch: isolatedEmbeddingsSearch }] = await Promise.all([
        import("../src/server.js"),
        import("../src/tools/search.js")
      ]);
      const deps = await prepareServerDeps({ vault: throwDrift.vaultRoot, useHnsw: true });

      expect(throwBuild).toHaveBeenCalledTimes(1);
      expect(throwSaveTo).toHaveBeenCalledTimes(1);
      expect(throwSaveTo.mock.calls[0]?.[0]).toBe(throwPersistFile);
      expect(throwPersistEvents).toEqual(["save", "clear"]);
      expect(throwClear).toHaveBeenCalledWith(throwPersistFile, throwSaveTo.mock.calls[0]?.[4]);
      expect(deps.hnswContext).toBeNull();
      expect(deps.watcherHealth).toMatchObject({ semanticUsable: true, hnswUsable: true });
      await expect(fs.lstat(`${throwPersistFile}.meta.json`)).rejects.toMatchObject({ code: "ENOENT" });

      const result = await isolatedEmbeddingsSearch(
        deps.vault,
        { query: "semantic admission marker", limit: 1 },
        throwDrift.embedFile,
        deps.hnswContext,
        deps.watcherHealth
      );
      expect(result.method).toBe("embeddings-cosine");
      expect(result.matches.map((match) => match.path)).toEqual(["Semantic.md"]);

      const log = throwStderr.mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(log).toMatch(/HNSW persist failed.*injected publisher lease-release failure/is);
      expect(log).toMatch(/embedding database changed while HNSW was persisting/i);
      expect(log).not.toMatch(/immutable generation \+ meta pointer persisted/i);
    } finally {
      throwStderr.mockRestore();
      resetSemanticAdmissionRuntimeMocks();
      await removeSemanticAdmissionFixture(throwDrift);
    }
  });
});
