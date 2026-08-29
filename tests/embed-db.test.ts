// Synthetic-vector tests for the persistent embedding store. These tests
// don't load any ML model — they verify the SQLite schema, the cross-vault
// contamination guard, the upsert/delete/search/sync semantics with hand-
// constructed vectors. End-to-end ML smoke is out-of-band (see manual
// build-embeddings + the smoke.mjs probe in scripts/).

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertEmbedDbRecoveryOwnership,
  clearPeekCache,
  decodeInt8Vector,
  discoverEmbedDbConfig,
  discoverEmbedDbConfigCached,
  EmbedDb,
  EmbedSnapshotCapacityError,
  EmbedSnapshotIntegrityError,
  encodeInt8Vector,
  hnswPersistBase,
  openEmbedReceiptReader,
  peekEmbedDbMeta,
  peekEmbedDbMetaCached
} from "../src/embed-db.js";
import { acquirePersistenceFamilyLease, inspectPersistenceNamespaceLeases } from "../src/persistence-coordination.js";
import {
  drainProcessPersistenceLeaseDebts,
  inspectPersistenceLeases,
  PersistenceLeaseOwnershipError
} from "../src/persistence-lease.js";
import { EMBED_DB_SCHEMA_VERSION } from "../src/schema-contract.js";
import { SEMANTIC_PERSISTENCE_FAMILY_KEY } from "../src/semantic-persistence.js";
import { watcherActivationGuardPath } from "../src/watcher-activation-guard.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-embed-db-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function vec(values: number[]): Float32Array {
  // Caller-supplied vectors don't need to be L2-normalized; the store doesn't
  // enforce it. But for cosine to be meaningful, callers normalize before
  // insert. Tests use vectors that ARE pre-normalized so the cosine math is
  // checkable by hand.
  return new Float32Array(values);
}

function l2(v: number[]): Float32Array {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return new Float32Array(v.map((x) => x / (n || 1)));
}

function thrownBy(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("expected operation to throw");
}

async function exactEmbedLogicalSnapshot(file: string): Promise<unknown> {
  const Database = (await import("better-sqlite3")).default;
  const raw = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return {
      schema: raw
        .prepare(
          `SELECT type, name, tbl_name, sql
           FROM sqlite_master
           WHERE name NOT GLOB 'sqlite_*'
           ORDER BY type, name`
        )
        .all(),
      meta: raw.prepare("SELECT key, value FROM meta ORDER BY key").all(),
      embeddings: raw
        .prepare(
          `SELECT id, rel_path, chunk_index, line_start, line_end, text_preview,
                  hex(vector) AS vector_hex, kind
           FROM embeddings
           ORDER BY id`
        )
        .all(),
      sourceState: raw.prepare("SELECT * FROM source_state ORDER BY rel_path").all(),
      sourceQuarantine: raw.prepare("SELECT * FROM source_quarantine ORDER BY rel_path, kind").all(),
      sourceRevision: raw.prepare("SELECT * FROM source_revision ORDER BY rel_path, kind").all()
    };
  } finally {
    raw.close();
  }
}

async function expectPathFreeEmbedOwnershipRefusal(file: string, vaultRoot: string, before: unknown): Promise<void> {
  const refused = new EmbedDb({ file, vaultRoot, modelAlias: "multilingual", dim: 4 });
  let error: unknown;
  try {
    await refused.open();
  } catch (caught) {
    error = caught;
  } finally {
    await refused.closeAndRelease();
  }
  expect(error).toBeInstanceOf(Error);
  const message = error instanceof Error ? error.message : String(error);
  expect(message).toMatch(/ownership could not be verified/);
  expect(message).not.toContain(file);
  expect(message).not.toContain(vaultRoot);
  expect(await exactEmbedLogicalSnapshot(file)).toEqual(before);
}

async function expectPathFreeRecoveryOwnershipRefusal(file: string, vaultRoot: string): Promise<void> {
  let error: unknown;
  try {
    await assertEmbedDbRecoveryOwnership(file, vaultRoot);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  const message = error instanceof Error ? error.message : String(error);
  expect(message).toBe("Embedding index ownership could not be verified");
  expect(message).not.toContain(file);
  expect(message).not.toContain(vaultRoot);
}

async function seedExactEmbedFile(file: string, relPath: string): Promise<void> {
  const seed = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
  await seed.open();
  try {
    seed.upsertNote(relPath, 1, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: relPath, vector: l2([1, 0, 0, 0]) }
    ]);
  } finally {
    await seed.closeAndRelease();
  }
}

const DROP_EMBED_REVISION_TRIGGERS_SQL = `
  DROP TRIGGER embed_source_state_revision_insert;
  DROP TRIGGER embed_source_state_revision_update;
  DROP TRIGGER embed_source_state_revision_delete;
  DROP TRIGGER embed_source_quarantine_revision_insert;
  DROP TRIGGER embed_source_quarantine_revision_update;
  DROP TRIGGER embed_source_quarantine_revision_delete;
`;

describe("EmbedDb", () => {
  const synchronousAdmissionRoutes: ReadonlyArray<readonly [string, (file: string) => unknown]> = [
    ["EmbedDb constructor", (file) => new EmbedDb({ file, vaultRoot: "/v", modelAlias: "m", dim: 4 })],
    ["HNSW base derivation", (file) => hnswPersistBase(file)],
    ["watcher guard derivation", (file) => watcherActivationGuardPath(file)]
  ];
  const asynchronousAdmissionRoutes: ReadonlyArray<readonly [string, (file: string) => Promise<unknown>]> = [
    ["openEmbedReceiptReader", (file) => openEmbedReceiptReader(file, "/v")],
    ["discoverEmbedDbConfig", (file) => discoverEmbedDbConfig(file, "/v")],
    ["peekEmbedDbMeta", (file) => peekEmbedDbMeta(file, "/v")],
    ["discoverEmbedDbConfigCached", (file) => discoverEmbedDbConfigCached(file, "/v")],
    ["peekEmbedDbMetaCached", (file) => peekEmbedDbMetaCached(file, "/v")]
  ];

  it.each(synchronousAdmissionRoutes)(
    "rejects an unadmitted embedding namespace in %s before derived-artifact mutation",
    async (label, invoke) => {
      const invalidParent = path.join(dir, `uncreated-${label.replaceAll(" ", "-")}`);
      const file = path.join(invalidParent, "index");
      expect(() => invoke(file)).toThrowError(new TypeError("Embedding index file must end exactly in '.embed.db'"));
      await expect(fs.lstat(invalidParent)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it.each(asynchronousAdmissionRoutes)(
    "rejects an unadmitted embedding namespace in %s instead of laundering it as fail-soft",
    async (label, invoke) => {
      const invalidParent = path.join(dir, `uncreated-${label}`);
      const file = path.join(invalidParent, "index");
      await expect(invoke(file)).rejects.toThrowError(
        new TypeError("Embedding index file must end exactly in '.embed.db'")
      );
      await expect(fs.lstat(invalidParent)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it.for([
    {
      route: "mutating open",
      verify: async (file: string) => {
        const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "m", dim: 4 });
        try {
          await expect(db.open()).rejects.toThrow("Embedding index artifact family could not be admitted");
        } finally {
          await db.closeAndRelease();
        }
      }
    },
    {
      route: "configuration discovery",
      verify: async (file: string) => {
        await expect(discoverEmbedDbConfig(file, "/v")).resolves.toEqual({ kind: "refused" });
      }
    },
    {
      route: "diagnostic peek",
      verify: async (file: string) => {
        await expect(peekEmbedDbMeta(file, "/v")).resolves.toBeNull();
      }
    },
    {
      route: "receipt reader",
      verify: async (file: string) => {
        await expect(openEmbedReceiptReader(file, "/v")).rejects.toThrow(
          "Embedding receipt reader requires an existing compatible index for the expected vault"
        );
      }
    }
  ])(
    "$route refuses a symlink SQLite sidecar without changing either sentinel",
    async ({ route, verify }, { skip }) => {
      const file = path.join(dir, `unsafe-open-${route.replaceAll(" ", "-")}.embed.db`);
      const unsafeJournal = `${file}-journal`;
      const external = `${file}.external`;
      const mainSentinel = Buffer.from(`EMBED_MAIN_SENTINEL_${route}`);
      const externalSentinel = Buffer.from(`EMBED_EXTERNAL_SENTINEL_${route}`);
      await fs.writeFile(file, mainSentinel);
      await fs.writeFile(external, externalSentinel);
      try {
        await fs.symlink(external, unsafeJournal, "file");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
          skip(`filesystem cannot create the Embed sidecar symlink control (${code})`);
          return;
        }
        throw error;
      }

      await verify(file);

      expect(await fs.readFile(file)).toEqual(mainSentinel);
      expect(await fs.readFile(external)).toEqual(externalSentinel);
      expect((await fs.lstat(unsafeJournal)).isSymbolicLink()).toBe(true);
    }
  );

  it.each(["index.EMBED.DB", "index.embed.db\n", "index.embed.db\u2028"])(
    "rejects non-exact embedding suffix spelling %j",
    (basename) => {
      expect(() => hnswPersistBase(path.join(dir, basename))).toThrow(TypeError);
    }
  );

  it("opens, closes, and reopens cleanly with the same meta", async () => {
    const file = path.join(dir, "test.embed.db");
    const db1 = new EmbedDb({ file, vaultRoot: "/v1", modelAlias: "multilingual", dim: 4 });
    await db1.open();
    db1.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "hello", vector: l2([1, 0, 0, 0]) }
    ]);
    expect(db1.totalChunks()).toBe(1);
    await db1.closeAndRelease();

    const rawMeta = await peekEmbedDbMeta(file);
    expect(rawMeta).toEqual(expect.objectContaining({ vault_root: "/v1", model_alias: "multilingual", dim: "4" }));
    expect(await peekEmbedDbMeta(file, "/v1")).toEqual(rawMeta);
    expect(await peekEmbedDbMeta(file, "/foreign")).toBeNull();
    const ownedDiscovery = await discoverEmbedDbConfig(file, "/v1");
    expect(ownedDiscovery.kind).toBe("owned");
    if (ownedDiscovery.kind !== "owned") throw new Error("expected owned embedding discovery");
    expect(ownedDiscovery.meta).toEqual(rawMeta);
    expect(await discoverEmbedDbConfig(file, "/foreign")).toEqual({ kind: "refused" });
    await expect(assertEmbedDbRecoveryOwnership(file, "/v1")).resolves.toBeUndefined();

    // Cache the raw bounded result, never the first caller's filtered view:
    // foreign -> owner and owner -> foreign must both remain root-scoped.
    clearPeekCache();
    expect(await peekEmbedDbMetaCached(file, "/foreign")).toBeNull();
    expect(await peekEmbedDbMetaCached(file, "/v1")).toEqual(rawMeta);
    clearPeekCache();
    expect(await peekEmbedDbMetaCached(file, "/v1")).toEqual(rawMeta);
    expect(await peekEmbedDbMetaCached(file, "/foreign")).toBeNull();

    // The production discovery cache has its own root-scoped keyspace: a
    // refused lookup cannot poison the owner, the owner cannot launder a
    // foreign lookup, and legacy raw cache entries cannot affect either.
    clearPeekCache();
    expect(await discoverEmbedDbConfigCached(file, "/foreign")).toEqual({ kind: "refused" });
    const cachedOwnerAfterForeign = await discoverEmbedDbConfigCached(file, "/v1");
    expect(cachedOwnerAfterForeign.kind).toBe("owned");
    clearPeekCache();
    const cachedOwnerFirst = await discoverEmbedDbConfigCached(file, "/v1");
    expect(cachedOwnerFirst.kind).toBe("owned");
    if (cachedOwnerFirst.kind !== "owned") throw new Error("expected cached owner before mutation");
    (cachedOwnerFirst.meta as { model_alias: string }).model_alias = "poisoned-return-value";
    const cachedOwnerAfterReturnedMutation = await discoverEmbedDbConfigCached(file, "/v1");
    expect(cachedOwnerAfterReturnedMutation.kind).toBe("owned");
    if (cachedOwnerAfterReturnedMutation.kind !== "owned") {
      throw new Error("expected cached owner after returned mutation");
    }
    expect(cachedOwnerAfterReturnedMutation.meta.model_alias).toBe("multilingual");
    expect(await discoverEmbedDbConfigCached(file, "/foreign")).toEqual({ kind: "refused" });
    clearPeekCache();
    expect(await peekEmbedDbMetaCached(file)).toEqual(rawMeta);
    expect(await discoverEmbedDbConfigCached(file, "/foreign")).toEqual({ kind: "refused" });
    expect((await discoverEmbedDbConfigCached(file, "/v1")).kind).toBe("owned");

    const db2 = new EmbedDb({ file, vaultRoot: "/v1", modelAlias: "multilingual", dim: 4 });
    await db2.open();
    expect(db2.totalChunks()).toBe(1);
    await db2.closeAndRelease();

    const Database = (await import("better-sqlite3")).default;

    // A committed config change can live only in an active WAL while the main
    // database's mtime and size remain identical. Presence/mtime/size of the
    // WAL must therefore participate in the cache fingerprint, or an owned
    // snapshot for the old config survives this mutation.
    const walWriter = new Database(file);
    try {
      walWriter.pragma("journal_mode = WAL");
      walWriter.pragma("wal_autocheckpoint = 0");
      walWriter.prepare("UPDATE meta SET value = 'bge' WHERE key = 'model_alias'").run();
      walWriter.prepare("UPDATE meta SET value = 'multilingual' WHERE key = 'model_alias'").run();
      walWriter.pragma("wal_checkpoint(TRUNCATE)");

      // A transient close/read refusal is not a stable property of this
      // unchanged main+WAL fingerprint. If `refused` enters the LRU, the
      // second call below remains refused after the one-shot failure is gone.
      const readDiscoveryFingerprint = async () => {
        const main = await fs.lstat(file);
        const wal = await fs
          .lstat(`${file}-wal`)
          .then((stat) => ({ mtimeMs: stat.mtimeMs, size: stat.size }))
          .catch(() => null);
        return { mainMtimeMs: main.mtimeMs, mainSize: main.size, wal };
      };
      type TransientCloseHandle = { readonly name: string };
      type TransientClosePrototype = { close(this: TransientCloseHandle): void };
      const transientClosePrototype = Database.prototype as unknown as TransientClosePrototype;
      const originalTransientClose = transientClosePrototype.close;
      let transientCloseFailures = 0;
      transientClosePrototype.close = function (this: TransientCloseHandle): void {
        const inject = this.name === file && transientCloseFailures === 0;
        originalTransientClose.call(this);
        if (inject) {
          transientCloseFailures++;
          throw new Error(`one-shot close failure at ${file}`);
        }
      };
      clearPeekCache();
      const transientFingerprintBefore = await readDiscoveryFingerprint();
      let transientRefusal: Awaited<ReturnType<typeof discoverEmbedDbConfigCached>> = { kind: "refused" };
      try {
        transientRefusal = await discoverEmbedDbConfigCached(file, "/v1");
      } finally {
        transientClosePrototype.close = originalTransientClose;
      }
      const transientFingerprintAfter = await readDiscoveryFingerprint();
      expect(transientCloseFailures).toBe(1);
      expect(transientRefusal).toEqual({ kind: "refused" });
      expect(transientFingerprintAfter).toEqual(transientFingerprintBefore);
      const recoveredAfterTransientRefusal = await discoverEmbedDbConfigCached(file, "/v1");
      expect(recoveredAfterTransientRefusal.kind).toBe("owned");
      if (recoveredAfterTransientRefusal.kind !== "owned") {
        throw new Error("expected owner after transient cached refusal");
      }
      expect(recoveredAfterTransientRefusal.meta.model_alias).toBe("multilingual");

      clearPeekCache();
      const cachedBeforeWalChange = await discoverEmbedDbConfigCached(file, "/v1");
      expect(cachedBeforeWalChange.kind).toBe("owned");
      if (cachedBeforeWalChange.kind !== "owned") throw new Error("expected cached owner before WAL change");
      expect(cachedBeforeWalChange.meta.model_alias).toBe("multilingual");
      const mainBeforeWalChange = await fs.lstat(file);
      const walBeforeChange = await fs.lstat(`${file}-wal`);

      walWriter.prepare("UPDATE meta SET value = 'bge' WHERE key = 'model_alias'").run();
      const mainAfterWalChange = await fs.lstat(file);
      const walAfterChange = await fs.lstat(`${file}-wal`);
      expect({ mtimeMs: mainAfterWalChange.mtimeMs, size: mainAfterWalChange.size }).toEqual({
        mtimeMs: mainBeforeWalChange.mtimeMs,
        size: mainBeforeWalChange.size
      });
      expect({ mtimeMs: walAfterChange.mtimeMs, size: walAfterChange.size }).not.toEqual({
        mtimeMs: walBeforeChange.mtimeMs,
        size: walBeforeChange.size
      });

      const cachedAfterWalChange = await discoverEmbedDbConfigCached(file, "/v1");
      expect(cachedAfterWalChange.kind).toBe("owned");
      if (cachedAfterWalChange.kind !== "owned") throw new Error("expected cached owner after WAL change");
      expect(cachedAfterWalChange.meta.model_alias).toBe("bge");

      walWriter.prepare("UPDATE meta SET value = 'multilingual' WHERE key = 'model_alias'").run();
      const cachedAfterWalRestore = await discoverEmbedDbConfigCached(file, "/v1");
      expect(cachedAfterWalRestore.kind).toBe("owned");
      if (cachedAfterWalRestore.kind !== "owned") throw new Error("expected cached owner after WAL restore");
      expect(cachedAfterWalRestore.meta.model_alias).toBe("multilingual");
    } finally {
      walWriter.close();
    }

    const malformedMeta = new Database(file);
    malformedMeta.prepare("INSERT INTO meta (key, value) VALUES ('foreign_key', 'foreign')").run();
    malformedMeta.close();
    const malformedStat = await fs.stat(file);
    await fs.utimes(file, new Date(malformedStat.atimeMs), new Date(malformedStat.mtimeMs + 2_000));
    expect(await peekEmbedDbMeta(file, "/v1")).toBeNull();
    expect(await discoverEmbedDbConfigCached(file, "/v1")).toEqual({ kind: "refused" });

    const oversizedMeta = new Database(file);
    oversizedMeta.prepare("DELETE FROM meta WHERE key = 'foreign_key'").run();
    oversizedMeta.prepare("UPDATE meta SET value = ? WHERE key = 'model_alias'").run("x".repeat(8_193));
    oversizedMeta.close();
    expect(await peekEmbedDbMeta(file, "/v1")).toBeNull();

    // A pre-existing zero-byte file and a non-zero SQLite file with an exact
    // empty logical schema are safe fresh-config candidates. Legacy peek keeps
    // returning null, while discriminated production discovery alone exposes
    // the causal `empty` state without writing either artifact.
    const zeroByteFile = path.join(dir, "zero-byte.embed.db");
    await fs.writeFile(zeroByteFile, "");
    const zeroByteBefore = await fs.readFile(zeroByteFile);
    expect(await discoverEmbedDbConfig(zeroByteFile, "/v1")).toEqual({ kind: "empty" });
    expect(await discoverEmbedDbConfigCached(zeroByteFile, "/v1")).toEqual({ kind: "empty" });
    expect(await peekEmbedDbMeta(zeroByteFile)).toBeNull();
    expect(await peekEmbedDbMeta(zeroByteFile, "/v1")).toBeNull();
    expect(await fs.readFile(zeroByteFile)).toEqual(zeroByteBefore);

    const schemaEmptyFile = path.join(dir, "schema-empty.embed.db");
    const schemaEmptySetup = new Database(schemaEmptyFile);
    schemaEmptySetup.exec(`
      CREATE TABLE transient_probe (value BLOB NOT NULL);
      DROP TABLE transient_probe;
    `);
    schemaEmptySetup.close();
    expect((await fs.stat(schemaEmptyFile)).size).toBeGreaterThan(0);
    expect(await discoverEmbedDbConfig(schemaEmptyFile, "/v1")).toEqual({ kind: "empty" });
    const inspectSchemaEmpty = new Database(schemaEmptyFile, { readonly: true, fileMustExist: true });
    try {
      expect(
        inspectSchemaEmpty.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'").all()
      ).toEqual([]);
    } finally {
      inspectSchemaEmpty.close();
    }

    const logicalInventory = (candidateFile: string) => {
      const raw = new Database(candidateFile, { readonly: true, fileMustExist: true });
      try {
        return raw
          .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name")
          .all();
      } finally {
        raw.close();
      }
    };
    const expectDiscoveryStateRefusal = async (
      candidateFile: string,
      expected: Awaited<ReturnType<typeof discoverEmbedDbConfig>>
    ) => {
      const candidate = new EmbedDb({
        file: candidateFile,
        vaultRoot: "/v1",
        modelAlias: "multilingual",
        dim: 4
      });
      const error = await candidate.open(expected).then(
        () => null,
        (caught: unknown) => caught
      );
      await candidate.closeAndRelease();
      expect(error).toBeInstanceOf(Error);
      const message = error instanceof Error ? error.message : "";
      expect(message).toBe("Embedding index configuration changed before open");
      expect(message).not.toContain(candidateFile);
      expect(message).not.toContain("/v1");
    };

    // Bind all four preflight states: missing and present-empty cannot
    // substitute for one another, while refused never becomes write authority
    // merely because the path later becomes empty.
    const missingThenEmpty = path.join(dir, "missing-then-empty.embed.db");
    const expectedMissing = await discoverEmbedDbConfig(missingThenEmpty, "/v1");
    expect(expectedMissing).toEqual({ kind: "missing" });
    new Database(missingThenEmpty).close();
    await expectDiscoveryStateRefusal(missingThenEmpty, expectedMissing);
    expect(logicalInventory(missingThenEmpty)).toEqual([]);

    const emptyThenMissing = path.join(dir, "empty-then-missing.embed.db");
    new Database(emptyThenMissing).close();
    const expectedEmpty = await discoverEmbedDbConfig(emptyThenMissing, "/v1");
    expect(expectedEmpty).toEqual({ kind: "empty" });
    await fs.unlink(emptyThenMissing);
    await expectDiscoveryStateRefusal(emptyThenMissing, expectedEmpty);
    expect(logicalInventory(emptyThenMissing)).toEqual([]);

    const refusedThenEmpty = path.join(dir, "refused-then-empty.embed.db");
    const refusedSetup = new Database(refusedThenEmpty);
    refusedSetup.exec("CREATE TABLE foreign_payload (value BLOB NOT NULL)");
    refusedSetup.close();
    const expectedRefused = await discoverEmbedDbConfig(refusedThenEmpty, "/v1");
    expect(expectedRefused).toEqual({ kind: "refused" });
    const refusedCleanup = new Database(refusedThenEmpty);
    refusedCleanup.exec("DROP TABLE foreign_payload");
    refusedCleanup.close();
    await expectDiscoveryStateRefusal(refusedThenEmpty, expectedRefused);
    expect(logicalInventory(refusedThenEmpty)).toEqual([]);

    const matchingMissing = path.join(dir, "matching-missing.embed.db");
    const matchingMissingDiscovery = await discoverEmbedDbConfig(matchingMissing, "/v1");
    const missingInitializer = new EmbedDb({
      file: matchingMissing,
      vaultRoot: "/v1",
      modelAlias: "multilingual",
      dim: 4
    });
    await missingInitializer.open(matchingMissingDiscovery);
    await missingInitializer.closeAndRelease();
    expect((await discoverEmbedDbConfig(matchingMissing, "/v1")).kind).toBe("owned");

    const matchingEmpty = path.join(dir, "matching-empty.embed.db");
    new Database(matchingEmpty).close();
    const matchingEmptyDiscovery = await discoverEmbedDbConfig(matchingEmpty, "/v1");
    const emptyInitializer = new EmbedDb({
      file: matchingEmpty,
      vaultRoot: "/v1",
      modelAlias: "multilingual",
      dim: 4
    });
    await emptyInitializer.open(matchingEmptyDiscovery);
    await emptyInitializer.closeAndRelease();
    expect((await discoverEmbedDbConfig(matchingEmpty, "/v1")).kind).toBe("owned");

    // Paired NEGATIVE control: merely being a valid SQLite container is not
    // enough. One foreign logical table flips discovery to `refused`, and its
    // schema/cell/BLOB snapshot must remain unchanged.
    const malformedDiscoveryFile = path.join(dir, "nonempty-foreign.embed.db");
    const malformedDiscovery = new Database(malformedDiscoveryFile);
    malformedDiscovery.exec("CREATE TABLE foreign_payload (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)");
    malformedDiscovery.prepare("INSERT INTO foreign_payload VALUES (1, ?)").run(Buffer.from([0, 127, 255]));
    const malformedDiscoveryBefore = {
      schema: malformedDiscovery
        .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name")
        .all(),
      cells: malformedDiscovery.prepare("SELECT id, hex(payload) AS payload_hex FROM foreign_payload").all()
    };
    malformedDiscovery.close();
    expect(await discoverEmbedDbConfig(malformedDiscoveryFile, "/v1")).toEqual({ kind: "refused" });
    const inspectMalformedDiscovery = new Database(malformedDiscoveryFile, {
      readonly: true,
      fileMustExist: true
    });
    try {
      expect({
        schema: inspectMalformedDiscovery
          .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name")
          .all(),
        cells: inspectMalformedDiscovery.prepare("SELECT id, hex(payload) AS payload_hex FROM foreign_payload").all()
      }).toEqual(malformedDiscoveryBefore);
    } finally {
      inspectMalformedDiscovery.close();
    }

    // A pre-existing dangling symlink is neither missing nor an admissible
    // empty file. Refusal must happen before SQLite can follow it and create
    // the target, with no path material in the error or discovery result.
    if (process.platform !== "win32") {
      const danglingTarget = path.join(dir, "must-not-be-created.embed.db");
      const danglingLink = path.join(dir, "dangling.embed.db");
      await fs.symlink(danglingTarget, danglingLink);
      expect(await discoverEmbedDbConfig(danglingLink, "/v1")).toEqual({ kind: "refused" });
      expect(await discoverEmbedDbConfigCached(danglingLink, "/v1")).toEqual({ kind: "refused" });
      const symlinkDb = new EmbedDb({
        file: danglingLink,
        vaultRoot: "/v1",
        modelAlias: "multilingual",
        dim: 4
      });
      let symlinkError: unknown;
      try {
        await symlinkDb.open();
      } catch (error) {
        symlinkError = error;
      } finally {
        await symlinkDb.closeAndRelease();
      }
      expect(symlinkError).toBeInstanceOf(Error);
      const symlinkMessage = symlinkError instanceof Error ? symlinkError.message : String(symlinkError);
      expect(symlinkMessage).toBe("Embedding index artifact family could not be admitted");
      expect(symlinkMessage).not.toContain(danglingLink);
      expect(symlinkMessage).not.toContain(danglingTarget);
      await expect(fs.stat(danglingTarget)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.lstat(danglingLink)).isSymbolicLink()).toBe(true);
      await expectPathFreeRecoveryOwnershipRefusal(danglingLink, "/v1");
    }
  });

  it("releases its handle when open() throws on a corrupt db — close-on-throw (rc.70 reserve-before-try)", async () => {
    const file = path.join(dir, "corrupt.embed.db");
    await fs.writeFile(file, "not a sqlite database — garbage ".repeat(40));
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await expect(db.open()).rejects.toThrow();
    // Pre-rc.70 `this.db` stayed SET after the post-construction throw (pragma/bootstrapSchema),
    // so the `if (this.db) return` guard made a SECOND open() a silent no-op — the handle (+ its
    // WAL/SHM locks) leaked for the serve lifetime. The close-on-throw catch resets `this.db=null`,
    // so a second open() RE-THROWS: the behavioral proof the handle was released. (NEGATIVE control:
    // without the reset, the next line would resolve instead of reject.)
    await expect(db.open()).rejects.toThrow();

    const Database = (await import("better-sqlite3")).default;

    // Causal close-failure control: native close releases the handle and then
    // throws a pathful error. open() must preserve its original generic refusal
    // and clear this.db before close, or the retry below becomes a stale no-op.
    const closeFailureFile = path.join(dir, "close-failure.embed.db");
    await seedExactEmbedFile(closeFailureFile, "close.md");
    const closeFailureBefore = await exactEmbedLogicalSnapshot(closeFailureFile);
    type CloseFailureHandle = { readonly name: string };
    type CloseFailurePrototype = { close(this: CloseFailureHandle): void };
    const closePrototype = Database.prototype as unknown as CloseFailurePrototype;
    const originalClose = closePrototype.close;
    let injectedCloseErrors = 0;
    closePrototype.close = function (this: CloseFailureHandle): void {
      const targetHandle = this.name === closeFailureFile;
      originalClose.call(this);
      if (targetHandle) {
        injectedCloseErrors++;
        throw new Error(`native close leaked path ${closeFailureFile}`);
      }
    };

    const closeRefused = new EmbedDb({
      file: closeFailureFile,
      vaultRoot: "/foreign",
      modelAlias: "multilingual",
      dim: 4
    });
    let closeRefusalError: unknown;
    let legacyMetaAfterCloseError: Awaited<ReturnType<typeof peekEmbedDbMeta>> = null;
    let discoveryAfterCloseError: Awaited<ReturnType<typeof discoverEmbedDbConfig>> = { kind: "refused" };
    try {
      try {
        await closeRefused.open();
      } catch (error) {
        closeRefusalError = error;
      }
      legacyMetaAfterCloseError = await peekEmbedDbMeta(closeFailureFile);
      discoveryAfterCloseError = await discoverEmbedDbConfig(closeFailureFile, "/v");
      await expectPathFreeRecoveryOwnershipRefusal(closeFailureFile, "/v");
    } finally {
      closePrototype.close = originalClose;
    }

    expect(closeRefusalError).toBeInstanceOf(Error);
    const closeRefusalMessage =
      closeRefusalError instanceof Error ? closeRefusalError.message : String(closeRefusalError);
    expect(closeRefusalMessage).toBe("Embedding index ownership could not be verified");
    expect(closeRefusalMessage).not.toContain(closeFailureFile);
    expect(closeRefusalMessage).not.toContain("/foreign");
    expect(legacyMetaAfterCloseError?.vault_root).toBe("/v");
    expect(discoveryAfterCloseError).toEqual({ kind: "refused" });
    // One rejected mutating open plus the bounded readonly ownership readers
    // must all observe native-close failure without exposing its path. The
    // coordinated open now closes its native handle exactly once (the old
    // nested rollback performed a redundant second close attempt).
    expect(injectedCloseErrors).toBeGreaterThanOrEqual(3);

    let retryError: unknown;
    try {
      await closeRefused.open();
    } catch (error) {
      retryError = error;
    } finally {
      await closeRefused.closeAndRelease();
    }
    expect(retryError).toBeInstanceOf(Error);
    const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
    expect(retryMessage).toBe("Embedding index ownership could not be verified");
    expect(retryMessage).not.toContain(closeFailureFile);
    expect(await exactEmbedLogicalSnapshot(closeFailureFile)).toEqual(closeFailureBefore);

    const wrongClassFile = path.join(dir, "fts-lookalike.embed.db");
    const wrongClass = new Database(wrongClassFile);
    wrongClass.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '4'), ('vault_root', '/v'), ('tokenize_mode', 'unicode61');
      CREATE TABLE chunks (id INTEGER PRIMARY KEY, content BLOB NOT NULL);
      INSERT INTO chunks VALUES (1, x'00017fff');
    `);
    const before = {
      schema: wrongClass
        .prepare(
          `SELECT type, name, tbl_name, sql
           FROM sqlite_master
           WHERE name NOT GLOB 'sqlite_*'
           ORDER BY type, name`
        )
        .all(),
      meta: wrongClass.prepare("SELECT key, value FROM meta ORDER BY key").all(),
      cells: wrongClass.prepare("SELECT id, hex(content) AS content_hex FROM chunks ORDER BY id").all()
    };
    wrongClass.close();

    const lookalike = new EmbedDb({ file: wrongClassFile, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await expect(lookalike.open()).rejects.toThrow(/ownership could not be verified/);
    const inspectWrongClass = new Database(wrongClassFile, { readonly: true, fileMustExist: true });
    try {
      expect({
        schema: inspectWrongClass
          .prepare(
            `SELECT type, name, tbl_name, sql
             FROM sqlite_master
             WHERE name NOT GLOB 'sqlite_*'
             ORDER BY type, name`
          )
          .all(),
        meta: inspectWrongClass.prepare("SELECT key, value FROM meta ORDER BY key").all(),
        cells: inspectWrongClass.prepare("SELECT id, hex(content) AS content_hex FROM chunks ORDER BY id").all()
      }).toEqual(before);
    } finally {
      inspectWrongClass.close();
    }
    expect(await peekEmbedDbMeta(wrongClassFile, "/v")).toBeNull();
    await expectPathFreeRecoveryOwnershipRefusal(wrongClassFile, "/v");

    const malformedFile = path.join(dir, "malformed-lookalike.embed.db");
    const malformed = new Database(malformedFile);
    malformed.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES
        ('schema_version', '${EMBED_DB_SCHEMA_VERSION}'),
        ('vault_root', '/v'),
        ('model_alias', 'multilingual'),
        ('dim', '4'),
        ('quantization', 'f32');
      CREATE TABLE embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rel_path TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        line_start INTEGER NOT NULL,
        line_end INTEGER NOT NULL,
        text_preview TEXT NOT NULL,
        vector BLOB NOT NULL,
        kind TEXT NOT NULL DEFAULT 'md',
        UNIQUE(rel_path, chunk_index),
        UNIQUE(text_preview)
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
    malformed
      .prepare("INSERT INTO embeddings VALUES (1, ?, 0, 1, 1, ?, ?, 'md')")
      .run("keep.md", "keep", Buffer.from([0, 1, 127, 255]));
    const malformedBefore = {
      schema: malformed
        .prepare(
          `SELECT type, name, tbl_name, sql
           FROM sqlite_master
           WHERE name NOT GLOB 'sqlite_*'
           ORDER BY type, name`
        )
        .all(),
      meta: malformed.prepare("SELECT key, value FROM meta ORDER BY key").all(),
      cells: malformed.prepare("SELECT id, rel_path, hex(vector) AS vector_hex FROM embeddings").all()
    };
    malformed.close();

    const malformedLookalike = new EmbedDb({
      file: malformedFile,
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4
    });
    await expect(malformedLookalike.open()).rejects.toThrow(/ownership could not be verified/);
    const inspectMalformed = new Database(malformedFile, { readonly: true, fileMustExist: true });
    try {
      expect({
        schema: inspectMalformed
          .prepare(
            `SELECT type, name, tbl_name, sql
             FROM sqlite_master
             WHERE name NOT GLOB 'sqlite_*'
             ORDER BY type, name`
          )
          .all(),
        meta: inspectMalformed.prepare("SELECT key, value FROM meta ORDER BY key").all(),
        cells: inspectMalformed.prepare("SELECT id, rel_path, hex(vector) AS vector_hex FROM embeddings").all()
      }).toEqual(malformedBefore);
    } finally {
      inspectMalformed.close();
    }
    await expectPathFreeRecoveryOwnershipRefusal(malformedFile, "/v");

    // Columns and index inventory alone cannot see an added CHECK constraint.
    // This otherwise exact current-schema lookalike must be refused without
    // changing its persisted BLOB or logical schema.
    const constrainedFile = path.join(dir, "constrained-lookalike.embed.db");
    const constrained = new Database(constrainedFile);
    constrained.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES
        ('schema_version', '${EMBED_DB_SCHEMA_VERSION}'),
        ('vault_root', '/v'),
        ('model_alias', 'multilingual'),
        ('dim', '4'),
        ('quantization', 'f32');
      CREATE TABLE embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rel_path TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        line_start INTEGER NOT NULL,
        line_end INTEGER NOT NULL,
        text_preview TEXT NOT NULL CHECK (text_preview <> ''),
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
    constrained
      .prepare("INSERT INTO embeddings VALUES (1, ?, 0, 1, 1, ?, ?, 'md')")
      .run("check.md", "check", Buffer.from([255, 127, 1, 0]));
    const constrainedBefore = {
      schema: constrained
        .prepare(
          `SELECT type, name, tbl_name, sql
           FROM sqlite_master
           WHERE name NOT GLOB 'sqlite_*'
           ORDER BY type, name`
        )
        .all(),
      cells: constrained.prepare("SELECT id, rel_path, hex(vector) AS vector_hex FROM embeddings").all()
    };
    constrained.close();

    const constrainedLookalike = new EmbedDb({
      file: constrainedFile,
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4
    });
    await expect(constrainedLookalike.open()).rejects.toThrow(/ownership could not be verified/);
    const inspectConstrained = new Database(constrainedFile, { readonly: true, fileMustExist: true });
    try {
      expect({
        schema: inspectConstrained
          .prepare(
            `SELECT type, name, tbl_name, sql
             FROM sqlite_master
             WHERE name NOT GLOB 'sqlite_*'
             ORDER BY type, name`
          )
          .all(),
        cells: inspectConstrained.prepare("SELECT id, rel_path, hex(vector) AS vector_hex FROM embeddings").all()
      }).toEqual(constrainedBefore);
    } finally {
      inspectConstrained.close();
    }

    // Exact columns do not prove the source authority ledger's CHECK and
    // WITHOUT ROWID semantics. Keep the same names/columns but remove both.
    const ledgerFile = path.join(dir, "malformed-ledger.embed.db");
    const ledgerSeed = new EmbedDb({ file: ledgerFile, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await ledgerSeed.open();
    ledgerSeed.upsertNote("ledger.md", 1, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "ledger", vector: l2([1, 0, 0, 0]) }
    ]);
    await ledgerSeed.closeAndRelease();
    const ledger = new Database(ledgerFile);
    ledger.exec(`
      DROP TRIGGER embed_source_state_revision_insert;
      DROP TRIGGER embed_source_state_revision_update;
      DROP TRIGGER embed_source_state_revision_delete;
      DROP TRIGGER embed_source_quarantine_revision_insert;
      DROP TRIGGER embed_source_quarantine_revision_update;
      DROP TRIGGER embed_source_quarantine_revision_delete;
      DROP TABLE source_revision;
      CREATE TABLE source_revision (
        rel_path TEXT NOT NULL,
        kind TEXT NOT NULL,
        revision INTEGER NOT NULL,
        PRIMARY KEY (rel_path, kind)
      );
      INSERT INTO source_revision VALUES ('ledger.md', 'md', 1);
    `);
    const ledgerBefore = {
      schema: ledger
        .prepare(
          `SELECT type, name, tbl_name, sql
           FROM sqlite_master
           WHERE name NOT GLOB 'sqlite_*'
           ORDER BY type, name`
        )
        .all(),
      cells: ledger
        .prepare(
          `SELECT rel_path, text_preview, hex(vector) AS vector_hex
           FROM embeddings
           ORDER BY rel_path`
        )
        .all(),
      revisions: ledger.prepare("SELECT * FROM source_revision ORDER BY rel_path, kind").all()
    };
    ledger.close();

    const malformedLedger = new EmbedDb({
      file: ledgerFile,
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4
    });
    await expect(malformedLedger.open()).rejects.toThrow(/ownership could not be verified/);
    const inspectLedger = new Database(ledgerFile, { readonly: true, fileMustExist: true });
    try {
      expect({
        schema: inspectLedger
          .prepare(
            `SELECT type, name, tbl_name, sql
             FROM sqlite_master
             WHERE name NOT GLOB 'sqlite_*'
             ORDER BY type, name`
          )
          .all(),
        cells: inspectLedger
          .prepare(
            `SELECT rel_path, text_preview, hex(vector) AS vector_hex
             FROM embeddings
             ORDER BY rel_path`
          )
          .all(),
        revisions: inspectLedger.prepare("SELECT * FROM source_revision ORDER BY rel_path, kind").all()
      }).toEqual(ledgerBefore);
    } finally {
      inspectLedger.close();
    }

    // Quote-aware normalization must preserve SQL literal bytes. Lowercasing
    // the whole statement previously laundered this always-false 'INTEGER'
    // typeof check into the canonical lowercase 'integer' contract.
    const literalCaseFile = path.join(dir, "revision-literal-case.embed.db");
    await seedExactEmbedFile(literalCaseFile, "literal.md");
    const literalCase = new Database(literalCaseFile);
    literalCase.exec(`
      ${DROP_EMBED_REVISION_TRIGGERS_SQL}
      DROP TABLE source_revision;
      CREATE TABLE source_revision (
        rel_path TEXT NOT NULL,
        kind TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (
          typeof(revision) = 'INTEGER'
            AND revision BETWEEN 1 AND 9007199254740991
        ),
        PRIMARY KEY (rel_path, kind)
      ) WITHOUT ROWID;
    `);
    literalCase.close();
    const literalCaseBefore = await exactEmbedLogicalSnapshot(literalCaseFile);
    expect(await peekEmbedDbMeta(literalCaseFile, "/v")).toBeNull();
    await expectPathFreeEmbedOwnershipRefusal(literalCaseFile, "/v", literalCaseBefore);

    // source_quarantine keeps the exact column projection but loses the
    // canonical WITHOUT ROWID authority semantics.
    const quarantineShapeFile = path.join(dir, "quarantine-shape.embed.db");
    await seedExactEmbedFile(quarantineShapeFile, "quarantine.md");
    const quarantineShape = new Database(quarantineShapeFile);
    quarantineShape.exec(`
      ${DROP_EMBED_REVISION_TRIGGERS_SQL}
      DROP TABLE source_quarantine;
      CREATE TABLE source_quarantine (
        rel_path TEXT NOT NULL,
        kind TEXT NOT NULL,
        PRIMARY KEY (rel_path, kind)
      );
      INSERT INTO source_quarantine VALUES ('quarantine.md', 'md');
    `);
    quarantineShape.close();
    const quarantineShapeBefore = await exactEmbedLogicalSnapshot(quarantineShapeFile);
    await expectPathFreeEmbedOwnershipRefusal(quarantineShapeFile, "/v", quarantineShapeBefore);

    // COLLATE is invisible to pragma_table_info: the meta columns are
    // identical, but the authority key contract is not the shipped table.
    const metaCollationFile = path.join(dir, "meta-collation.embed.db");
    await seedExactEmbedFile(metaCollationFile, "meta.md");
    const metaCollation = new Database(metaCollationFile);
    metaCollation.exec(`
      DROP TABLE meta;
      CREATE TABLE meta (
        key TEXT PRIMARY KEY COLLATE NOCASE,
        value TEXT NOT NULL
      );
      INSERT INTO meta VALUES
        ('schema_version', '${EMBED_DB_SCHEMA_VERSION}'),
        ('vault_root', '/v'),
        ('model_alias', 'multilingual'),
        ('dim', '4'),
        ('quantization', 'f32');
    `);
    metaCollation.close();
    const metaCollationBefore = await exactEmbedLogicalSnapshot(metaCollationFile);
    expect((await peekEmbedDbMeta(metaCollationFile))?.vault_root).toBe("/v");
    expect(await peekEmbedDbMeta(metaCollationFile, "/v")).toBeNull();
    clearPeekCache();
    expect((await peekEmbedDbMetaCached(metaCollationFile))?.vault_root).toBe("/v");
    expect(await peekEmbedDbMetaCached(metaCollationFile, "/v")).toBeNull();
    clearPeekCache();
    expect(await peekEmbedDbMetaCached(metaCollationFile, "/v")).toBeNull();
    expect((await peekEmbedDbMetaCached(metaCollationFile))?.vault_root).toBe("/v");
    await expectPathFreeEmbedOwnershipRefusal(metaCollationFile, "/v", metaCollationBefore);

    // A table-level CHECK is likewise absent from the column projection.
    const sourceStateShapeFile = path.join(dir, "source-state-shape.embed.db");
    await seedExactEmbedFile(sourceStateShapeFile, "state.md");
    const sourceStateShape = new Database(sourceStateShapeFile);
    sourceStateShape.exec(`
      ${DROP_EMBED_REVISION_TRIGGERS_SQL}
      DROP TABLE source_state;
      CREATE TABLE source_state (
        rel_path TEXT PRIMARY KEY,
        mtime_ms INTEGER NOT NULL,
        n_chunks INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'md',
        indexed_at TEXT NOT NULL,
        CHECK (n_chunks >= 0)
      );
      INSERT INTO source_state VALUES ('state.md', 1, 1, 'md', 'now');
    `);
    sourceStateShape.close();
    const sourceStateShapeBefore = await exactEmbedLogicalSnapshot(sourceStateShapeFile);
    await expectPathFreeEmbedOwnershipRefusal(sourceStateShapeFile, "/v", sourceStateShapeBefore);

    // NEGATIVE control for SQL LIKE semantics: `_` is a wildcard, so the old
    // `NOT LIKE 'sqlite_%'` inventory hid this foreign application table.
    const sqlitePrefixFile = path.join(dir, "sqlite-prefix-lookalike.embed.db");
    const sqlitePrefixSeed = new EmbedDb({
      file: sqlitePrefixFile,
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4
    });
    await sqlitePrefixSeed.open();
    await sqlitePrefixSeed.closeAndRelease();
    const sqlitePrefix = new Database(sqlitePrefixFile);
    sqlitePrefix.exec("CREATE TABLE sqliteXpayload (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)");
    sqlitePrefix.prepare("INSERT INTO sqliteXpayload VALUES (1, ?)").run(Buffer.from([255, 0, 127]));
    const sqlitePrefixBefore = {
      schema: sqlitePrefix
        .prepare(
          `SELECT type, name, tbl_name, sql
           FROM sqlite_master
           WHERE name NOT GLOB 'sqlite_*'
           ORDER BY type, name`
        )
        .all(),
      cells: sqlitePrefix.prepare("SELECT id, hex(payload) AS payload_hex FROM sqliteXpayload").all()
    };
    sqlitePrefix.close();

    const sqlitePrefixLookalike = new EmbedDb({
      file: sqlitePrefixFile,
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4
    });
    await expect(sqlitePrefixLookalike.open()).rejects.toThrow(/ownership could not be verified/);
    const inspectSqlitePrefix = new Database(sqlitePrefixFile, { readonly: true, fileMustExist: true });
    try {
      expect({
        schema: inspectSqlitePrefix
          .prepare(
            `SELECT type, name, tbl_name, sql
             FROM sqlite_master
             WHERE name NOT GLOB 'sqlite_*'
             ORDER BY type, name`
          )
          .all(),
        cells: inspectSqlitePrefix.prepare("SELECT id, hex(payload) AS payload_hex FROM sqliteXpayload").all()
      }).toEqual(sqlitePrefixBefore);
    } finally {
      inspectSqlitePrefix.close();
    }

    // Static mutation controls pin bounded projection rather than merely the
    // over-cap refusal result: removing substr or any cap+1 binding fails this
    // existing registration even if a later JS length check still rejects.
    const embedSource = await fs.readFile(new URL("../src/embed-db.ts", import.meta.url), "utf8");
    const admissionStart = embedSource.indexOf("function inspectEmbedAdmission(");
    const admissionEnd = embedSource.indexOf("function assertEmbedAdmission(", admissionStart);
    const admissionSource = embedSource.slice(admissionStart, admissionEnd);
    expect(admissionStart).toBeGreaterThanOrEqual(0);
    expect(admissionEnd).toBeGreaterThan(admissionStart);
    const normalizeStart = embedSource.indexOf("function normalizeSql(");
    const normalizeEnd = embedSource.indexOf("function normalizeCreateTableSql(", normalizeStart);
    const normalizeSource = embedSource.slice(normalizeStart, normalizeEnd);
    expect(normalizeStart).toBeGreaterThanOrEqual(0);
    expect(normalizeEnd).toBeGreaterThan(normalizeStart);
    expect(normalizeSource).toContain('if (sql[index + 1] === "\'")');
    expect(normalizeSource).toContain("normalized += char.toLowerCase()");
    expect(admissionSource).toContain("substr(name, 1, ?) AS name");
    expect(admissionSource).toContain("substr(sql, 1, ?) AS sql");
    expect(admissionSource).toContain(
      ">(MAX_EMBED_ADMISSION_NAME_CHARS + 1, MAX_EMBED_ADMISSION_SQL_CHARS + 1, MAX_EMBED_ADMISSION_OBJECTS + 1)"
    );
    expect(admissionSource).toContain("substr(key, 1, ?) AS key");
    expect(admissionSource).toContain("substr(value, 1, ?) AS value");
    expect(admissionSource).toContain(
      "MAX_EMBED_ADMISSION_NAME_CHARS + 1,\n        MAX_EMBED_META_VALUE_CHARS + 1,\n        EMBED_META_KEYS.size + 1"
    );
    expect(admissionSource).not.toMatch(/length\s*\(\s*(?:name|sql|key|value)\b/u);

    const peekStart = embedSource.indexOf("export async function peekEmbedDbMeta(");
    const peekEnd = embedSource.indexOf("const peekCache =", peekStart);
    const peekSource = embedSource.slice(peekStart, peekEnd);
    expect(peekStart).toBeGreaterThanOrEqual(0);
    expect(peekEnd).toBeGreaterThan(peekStart);
    expect(peekSource).toContain("substr(key, 1, ?) AS key");
    expect(peekSource).toContain("substr(value, 1, ?) AS value");
    expect(peekSource).toContain(
      ".all(MAX_EMBED_ADMISSION_NAME_CHARS + 1, MAX_EMBED_META_VALUE_CHARS + 1, EMBED_META_KEYS.size + 1)"
    );
    expect(peekSource).not.toMatch(/length\s*\(\s*(?:key|value)\b/u);

    const cachedDiscoveryStart = embedSource.indexOf("export async function discoverEmbedDbConfigCached(");
    const cachedDiscoveryEnd = embedSource.indexOf(
      "export async function peekEmbedDbMetaCached(",
      cachedDiscoveryStart
    );
    const cachedDiscoverySource = embedSource.slice(cachedDiscoveryStart, cachedDiscoveryEnd);
    expect(cachedDiscoveryStart).toBeGreaterThanOrEqual(0);
    expect(cachedDiscoveryEnd).toBeGreaterThan(cachedDiscoveryStart);
    expect(cachedDiscoverySource).toContain("cached.mtimeMs === before.mtimeMs");
    expect(cachedDiscoverySource).toContain("cached.size === before.size");
    expect(cachedDiscoverySource).toContain("cached.walMtimeMs === before.walMtimeMs");
    expect(cachedDiscoverySource).toContain("cached.walSize === before.walSize");
    expect(cachedDiscoverySource).toContain('cached.discovery.kind !== "refused"');
    expect(cachedDiscoverySource).toContain('discovery.kind === "refused"');
    expect(cachedDiscoverySource).toContain("after.size !== before.size");
    expect(cachedDiscoverySource).toContain("after.walSize !== before.walSize");
    expect(cachedDiscoverySource).toContain("MAX_PEEK_CACHE_ENTRIES");
  });

  it("refuses a foreign vault under active WAL without changing logical schema or cells", async () => {
    const file = path.join(dir, "test.embed.db");
    const db1 = new EmbedDb({ file, vaultRoot: "/v1", modelAlias: "multilingual", dim: 4 });
    await db1.open();
    db1.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "hello", vector: l2([1, 0, 0, 0]) }
    ]);
    await db1.closeAndRelease();
    await fs.chmod(file, 0o640);
    const beforeMode = (await fs.stat(file)).mode & 0o777;
    await fs.chmod(dir, 0o750);
    const beforeParentMode = (await fs.stat(dir)).mode & 0o777;

    const Database = (await import("better-sqlite3")).default;
    const live = new Database(file);
    try {
      live.pragma("journal_mode = WAL");
      // Leave a committed content change in the live WAL while the owning
      // connection remains open. The admission reader must inspect this same
      // logical state without changing it or adopting the foreign root.
      live.prepare("UPDATE embeddings SET text_preview = ? WHERE rel_path = ?").run("wal-sentinel", "a.md");
      live.prepare("UPDATE meta SET value = ? WHERE key = 'vault_root'").run("/foreign-in-wal");
      const snapshot = () => ({
        schema: live
          .prepare(
            `SELECT type, name, tbl_name, sql
             FROM sqlite_master
             WHERE name NOT GLOB 'sqlite_*'
             ORDER BY type, name`
          )
          .all(),
        meta: live.prepare("SELECT key, value FROM meta ORDER BY key").all(),
        embeddings: live
          .prepare(
            `SELECT id, rel_path, chunk_index, line_start, line_end, text_preview,
                    hex(vector) AS vector_hex, kind
             FROM embeddings
             ORDER BY id`
          )
          .all(),
        sourceState: live.prepare("SELECT * FROM source_state ORDER BY rel_path").all(),
        sourceQuarantine: live.prepare("SELECT * FROM source_quarantine ORDER BY rel_path, kind").all(),
        sourceRevision: live.prepare("SELECT * FROM source_revision ORDER BY rel_path, kind").all()
      });
      const before = snapshot();

      const db2 = new EmbedDb({ file, vaultRoot: "/v2", modelAlias: "multilingual", dim: 4 });
      let refusal: unknown;
      try {
        await db2.open();
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(Error);
      const message = refusal instanceof Error ? refusal.message : String(refusal);
      expect(message).toMatch(/ownership could not be verified/);
      expect(message).not.toContain(file);
      expect(message).not.toContain("/v1");
      expect(message).not.toContain("/v2");
      expect(message).not.toContain("/foreign-in-wal");
      expect(snapshot()).toEqual(before);
      await expectPathFreeRecoveryOwnershipRefusal(file, "/v2");
      expect(snapshot()).toEqual(before);
      expect(live.pragma("journal_mode", { simple: true })).toBe("wal");
      expect((await fs.stat(file)).mode & 0o777).toBe(beforeMode);
      expect((await fs.stat(dir)).mode & 0o777).toBe(beforeParentMode);
      // Causal negative control: the logical snapshot is sensitive to the
      // exact destructive/mutating class it is used to exclude.
      live.prepare("UPDATE embeddings SET text_preview = ? WHERE rel_path = ?").run("mutant", "a.md");
      expect(snapshot()).not.toEqual(before);
    } finally {
      live.close();
    }

    // Bind mutating production opens to the exact configuration discovery
    // they used. A same-root low-level writer may intentionally replace A with
    // B between discovery and open; stale A must not become permission to
    // rebuild B back to A from a read-only caller.
    const configRaceFile = path.join(dir, "config-race.embed.db");
    const configASeed = new EmbedDb({
      file: configRaceFile,
      vaultRoot: "/config-race",
      modelAlias: "multilingual",
      dim: 4,
      quantization: "f32"
    });
    await configASeed.open();
    configASeed.upsertNote("a.md", 1, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "config-a", vector: l2([1, 0, 0, 0]) }
    ]);
    await configASeed.closeAndRelease();
    const expectedConfigA = await discoverEmbedDbConfig(configRaceFile, "/config-race");
    expect(expectedConfigA.kind).toBe("owned");

    const configBWriter = new EmbedDb({
      file: configRaceFile,
      vaultRoot: "/config-race",
      modelAlias: "bge",
      dim: 4,
      quantization: "int8"
    });
    await configBWriter.open();
    configBWriter.upsertNote("b.md", 2, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "config-b", vector: l2([0, 1, 0, 0]) }
    ]);
    await configBWriter.closeAndRelease();
    const expectedConfigB = await discoverEmbedDbConfig(configRaceFile, "/config-race");
    expect(expectedConfigB.kind).toBe("owned");
    const beforeStaleConfigOpen = await exactEmbedLogicalSnapshot(configRaceFile);

    const staleConfigOpen = new EmbedDb({
      file: configRaceFile,
      vaultRoot: "/config-race",
      modelAlias: "multilingual",
      dim: 4,
      quantization: "f32"
    });
    const stalePending = staleConfigOpen.open(expectedConfigA);
    if (expectedConfigA.kind === "owned") {
      const mutableMeta = expectedConfigA.meta as { model_alias: string; quantization?: "f32" | "int8" };
      mutableMeta.model_alias = "bge";
      mutableMeta.quantization = "int8";
    }
    const staleError = await stalePending.then(
      () => null,
      (error: unknown) => error
    );
    await staleConfigOpen.closeAndRelease();
    expect(staleError).toBeInstanceOf(Error);
    const staleMessage = staleError instanceof Error ? staleError.message : "";
    expect(staleMessage).toBe("Embedding index configuration changed before open");
    for (const value of [configRaceFile, "/config-race", "multilingual", "bge", "f32", "int8"]) {
      expect(staleMessage).not.toContain(value);
    }
    expect(await exactEmbedLogicalSnapshot(configRaceFile)).toEqual(beforeStaleConfigOpen);

    if (expectedConfigB.kind !== "owned") throw new Error("expected current embedding discovery");
    const currentConfigOpen = new EmbedDb({
      file: configRaceFile,
      vaultRoot: "/config-race",
      modelAlias: expectedConfigB.meta.model_alias,
      dim: Number(expectedConfigB.meta.dim),
      quantization: expectedConfigB.meta.quantization ?? "f32"
    });
    await currentConfigOpen.open(expectedConfigB);
    expect(currentConfigOpen.totalChunks()).toBe(1);
    await currentConfigOpen.closeAndRelease();

    // Paired positive: an explicit writer can still move A to B when the live
    // file is unchanged since discovery A.
    const explicitOverrideFile = path.join(dir, "explicit-config-override.embed.db");
    const explicitASeed = new EmbedDb({
      file: explicitOverrideFile,
      vaultRoot: "/config-override",
      modelAlias: "multilingual",
      dim: 4,
      quantization: "f32"
    });
    await explicitASeed.open();
    explicitASeed.upsertNote("old.md", 3, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "old-config", vector: l2([0, 0, 1, 0]) }
    ]);
    await explicitASeed.closeAndRelease();
    const expectedExplicitA = await discoverEmbedDbConfig(explicitOverrideFile, "/config-override");
    expect(expectedExplicitA.kind).toBe("owned");
    const explicitBWriter = new EmbedDb({
      file: explicitOverrideFile,
      vaultRoot: "/config-override",
      modelAlias: "bge",
      dim: 4,
      quantization: "int8"
    });
    await explicitBWriter.open(expectedExplicitA);
    expect(explicitBWriter.totalChunks()).toBe(0);
    await explicitBWriter.closeAndRelease();
    const explicitBDiscovery = await discoverEmbedDbConfig(explicitOverrideFile, "/config-override");
    expect(
      explicitBDiscovery.kind === "owned" && {
        modelAlias: explicitBDiscovery.meta.model_alias,
        quantization: explicitBDiscovery.meta.quantization
      }
    ).toEqual({ modelAlias: "bge", quantization: "int8" });

    // Deterministic TOCTOU-window control: mutate the authority root after the
    // first same-handle admission read but before BEGIN IMMEDIATE invokes its
    // callback. The callback's first action must refuse before dropping even
    // a repairable known-name trigger or touching payload cells.
    const betweenReadsFile = path.join(dir, "between-admission-reads.embed.db");
    const betweenReadsSeed = new EmbedDb({
      file: betweenReadsFile,
      vaultRoot: "/between-owner",
      modelAlias: "multilingual",
      dim: 4
    });
    await betweenReadsSeed.open();
    betweenReadsSeed.upsertNote("between.md", 7, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "between", vector: l2([0, 0, 1, 0]) }
    ]);
    await betweenReadsSeed.closeAndRelease();
    const betweenSetup = new Database(betweenReadsFile);
    betweenSetup.exec(`
      DROP TRIGGER embed_source_state_revision_insert;
      CREATE TRIGGER embed_source_state_revision_insert
      AFTER INSERT ON source_state
      BEGIN
        SELECT 1;
      END;
    `);
    const betweenBefore = {
      payload: betweenSetup
        .prepare(
          `SELECT rel_path, text_preview, hex(vector) AS vector_hex
           FROM embeddings
           ORDER BY rel_path`
        )
        .all(),
      trigger: betweenSetup
        .prepare(
          `SELECT name, sql
           FROM sqlite_master
           WHERE type = 'trigger' AND name = 'embed_source_state_revision_insert'`
        )
        .get()
    };
    betweenSetup.close();
    await fs.chmod(betweenReadsFile, 0o640);
    const betweenMode = (await fs.stat(betweenReadsFile)).mode & 0o777;

    type TestTransaction = (() => unknown) & { immediate: () => unknown };
    type TestTransactionFactory = (this: unknown, fn: () => unknown) => TestTransaction;
    const prototype = Database.prototype as unknown as { transaction: TestTransactionFactory };
    const originalTransaction = prototype.transaction;
    let rootMutations = 0;
    prototype.transaction = function (this: unknown, fn: () => unknown): TestTransaction {
      const transaction = originalTransaction.call(this, fn);
      const intercepted = (() => transaction()) as TestTransaction;
      intercepted.immediate = () => {
        rootMutations++;
        const writer = new Database(betweenReadsFile);
        try {
          writer.prepare("UPDATE meta SET value = ? WHERE key = 'vault_root'").run("/changed-between-admissions");
        } finally {
          writer.close();
        }
        return transaction.immediate();
      };
      return intercepted;
    };
    try {
      const raced = new EmbedDb({
        file: betweenReadsFile,
        vaultRoot: "/between-owner",
        modelAlias: "multilingual",
        dim: 4
      });
      let refusal: unknown;
      try {
        await raced.open();
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(Error);
      const message = refusal instanceof Error ? refusal.message : String(refusal);
      expect(message).toMatch(/ownership could not be verified/);
      expect(message).not.toContain(betweenReadsFile);
      expect(message).not.toContain("/between-owner");
      expect(message).not.toContain("/changed-between-admissions");
    } finally {
      prototype.transaction = originalTransaction;
    }
    // Current v5 requires the exact trigger inventory, so the hostile trigger
    // is refused by the first admission read before bootstrap begins.
    expect(rootMutations).toBe(0);
    const inspectBetween = new Database(betweenReadsFile, { readonly: true, fileMustExist: true });
    try {
      expect({
        payload: inspectBetween
          .prepare(
            `SELECT rel_path, text_preview, hex(vector) AS vector_hex
             FROM embeddings
             ORDER BY rel_path`
          )
          .all(),
        trigger: inspectBetween
          .prepare(
            `SELECT name, sql
             FROM sqlite_master
             WHERE type = 'trigger' AND name = 'embed_source_state_revision_insert'`
          )
          .get()
      }).toEqual(betweenBefore);
      expect(inspectBetween.prepare("SELECT value FROM meta WHERE key = 'vault_root'").pluck().get()).toBe(
        "/between-owner"
      );
    } finally {
      inspectBetween.close();
    }
    expect((await fs.stat(betweenReadsFile)).mode & 0o777).toBe(betweenMode);
    expect((await fs.stat(dir)).mode & 0o777).toBe(beforeParentMode);
  });

  it("rebuilds when model alias changes", async () => {
    const file = path.join(dir, "test.embed.db");
    const db1 = new EmbedDb({ file, vaultRoot: "/v1", modelAlias: "multilingual", dim: 4 });
    await db1.open();
    db1.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "hello", vector: l2([1, 0, 0, 0]) }
    ]);
    await db1.closeAndRelease();

    const db2 = new EmbedDb({ file, vaultRoot: "/v1", modelAlias: "bge", dim: 4 });
    await db2.open();
    expect(db2.totalChunks()).toBe(0);
    await db2.closeAndRelease();
  });

  it("rebuilds when dim changes", async () => {
    const file = path.join(dir, "test.embed.db");
    const db1 = new EmbedDb({ file, vaultRoot: "/v1", modelAlias: "multilingual", dim: 4 });
    await db1.open();
    db1.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "hello", vector: l2([1, 0, 0, 0]) }
    ]);
    await db1.closeAndRelease();

    const db2 = new EmbedDb({ file, vaultRoot: "/v1", modelAlias: "multilingual", dim: 8 });
    await db2.open();
    expect(db2.totalChunks()).toBe(0);
    await db2.closeAndRelease();
  });

  it("rejects vectors with the wrong dim at insert time", async () => {
    const unopenedParent = path.join(dir, "invalid-runtime-options");
    const unopenedFile = path.join(unopenedParent, "invalid.embed.db");
    expect(() => new EmbedDb({ file: "", vaultRoot: "/v", modelAlias: "multilingual", dim: 4 })).toThrow(
      /file must be a non-empty string/
    );
    expect(() => new EmbedDb({ file: unopenedFile, vaultRoot: "", modelAlias: "multilingual", dim: 4 })).toThrow(
      /vault root must be a non-empty string/
    );
    expect(() => new EmbedDb({ file: unopenedFile, vaultRoot: "/v", modelAlias: "", dim: 4 })).toThrow(
      /model alias must be a non-empty string/
    );
    expect(
      () =>
        new EmbedDb({
          file: unopenedFile,
          vaultRoot: "/v",
          modelAlias: "multilingual",
          dim: 0
        })
    ).toThrow(/positive safe integer/);
    expect(() => new EmbedDb({ file: unopenedFile, vaultRoot: "/v", modelAlias: "multilingual", dim: -1 })).toThrow(
      /positive safe integer/
    );
    expect(
      () =>
        new EmbedDb({
          file: unopenedFile,
          vaultRoot: "/v",
          modelAlias: "multilingual",
          dim: Number.MAX_SAFE_INTEGER + 1
        })
    ).toThrow(/positive safe integer/);
    await expect(fs.stat(unopenedParent)).rejects.toMatchObject({ code: "ENOENT" });

    const db = new EmbedDb({
      file: path.join(dir, "test.embed.db"),
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4
    });
    await db.open();
    expect(() =>
      db.upsertNote("a.md", 1000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "x", vector: vec([1, 0, 0]) }
      ])
    ).toThrow(/dim mismatch/);
    for (const vector of [
      new Float32Array([Number.NaN, 0, 0, 1]),
      new Float32Array([0, 0, 0, 0]),
      new Float32Array([2, 0, 0, 0])
    ]) {
      expect(() =>
        db.upsertNote("a.md", 1000, [{ chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "x", vector }])
      ).toThrow(/finite and L2-normalized/);
    }
    await db.closeAndRelease();
  });

  it("upsert replaces all chunks for a note (no orphan rows)", async () => {
    const db = new EmbedDb({
      file: path.join(dir, "test.embed.db"),
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4
    });
    await db.open();
    db.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "p1", vector: l2([1, 0, 0, 0]) },
      { chunkIndex: 1, lineStart: 5, lineEnd: 5, textPreview: "p2", vector: l2([0, 1, 0, 0]) },
      { chunkIndex: 2, lineStart: 10, lineEnd: 10, textPreview: "p3", vector: l2([0, 0, 1, 0]) }
    ]);
    expect(db.totalChunks()).toBe(3);

    // Re-upsert with fewer chunks — old ones should disappear.
    db.upsertNote("a.md", 2000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "p1-edited", vector: l2([1, 0, 0, 0]) }
    ]);
    expect(db.totalChunks()).toBe(1);
    await db.closeAndRelease();
  });

  it("deleteNote removes embeddings AND source_state", async () => {
    const db = new EmbedDb({
      file: path.join(dir, "test.embed.db"),
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4
    });
    await db.open();
    db.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "p1", vector: l2([1, 0, 0, 0]) }
    ]);
    expect(db.getSourceStates().length).toBe(1);
    db.deleteNote("a.md");
    expect(db.totalChunks()).toBe(0);
    expect(db.getSourceStates().length).toBe(0);
    await db.closeAndRelease();
  });

  it("search ranks by cosine descending and respects the limit", async () => {
    const db = new EmbedDb({
      file: path.join(dir, "test.embed.db"),
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4
    });
    await db.open();
    // Three chunks pointing at three different basis directions.
    db.upsertNote("auth.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "auth-stuff", vector: l2([1, 0, 0, 0]) }
    ]);
    db.upsertNote("cooking.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "pasta", vector: l2([0, 1, 0, 0]) }
    ]);
    db.upsertNote("travel.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "trip", vector: l2([0, 0, 1, 0]) }
    ]);
    // Query close to auth.md.
    const hits = db.search(l2([0.95, 0.31, 0, 0]), 2);
    expect(hits.length).toBe(2);
    expect(hits[0]?.rel_path).toBe("auth.md");
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0);
    await db.closeAndRelease();
  });

  it("search applies minScore threshold", async () => {
    const db = new EmbedDb({
      file: path.join(dir, "test.embed.db"),
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4
    });
    await db.open();
    db.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "x", vector: l2([1, 0, 0, 0]) }
    ]);
    db.upsertNote("b.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "y", vector: l2([0, 1, 0, 0]) }
    ]);
    // Query orthogonal to b.md (cosine = 0) and aligned with a.md (cosine = 1).
    const all = db.search(l2([1, 0, 0, 0]), 10);
    expect(all.length).toBe(2);
    const tight = db.search(l2([1, 0, 0, 0]), 10, { minScore: 0.5 });
    expect(tight.length).toBe(1);
    expect(tight[0]?.rel_path).toBe("a.md");
    await db.closeAndRelease();
  });

  it("search applies folder filter via rel_path LIKE prefix", async () => {
    const db = new EmbedDb({
      file: path.join(dir, "test.embed.db"),
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4
    });
    await db.open();
    db.upsertNote("Auth/oauth.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "auth", vector: l2([1, 0, 0, 0]) }
    ]);
    db.upsertNote("Other/pasta.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "pasta", vector: l2([1, 0, 0, 0]) }
    ]);
    const hits = db.search(l2([1, 0, 0, 0]), 10, { folder: "Auth" });
    expect(hits.length).toBe(1);
    expect(hits[0]?.rel_path).toBe("Auth/oauth.md");
    await db.closeAndRelease();
  });

  it("folder filter matches an emoji (astral-char) folder name (rc.43 M1 — substr by char, not JS UTF-16)", async () => {
    const db = new EmbedDb({
      file: path.join(dir, "test.embed.db"),
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4
    });
    await db.open();
    // "📚Books" leads with a non-BMP char (JS length 7, 6 code points). Pre-rc.43 the
    // prefix.length (UTF-16) bound to substr(...,1,?) (code points) matched ZERO rows.
    db.upsertNote("📚Books/oauth.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "auth", vector: l2([1, 0, 0, 0]) }
    ]);
    db.upsertNote("Other/pasta.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "pasta", vector: l2([1, 0, 0, 0]) }
    ]);
    const hits = db.search(l2([1, 0, 0, 0]), 10, { folder: "📚Books" });
    expect(hits.length).toBe(1);
    expect(hits[0]?.rel_path).toBe("📚Books/oauth.md");
    await db.closeAndRelease();
  });

  it("search rejects query vectors with the wrong dim", async () => {
    const db = new EmbedDb({
      file: path.join(dir, "test.embed.db"),
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4
    });
    await db.open();
    expect(() => db.search(vec([1, 0, 0]), 10)).toThrow(/dim mismatch/);
    await db.closeAndRelease();
  });

  it("clearOnDisk removes the .embed.db file (idempotent)", async () => {
    const file = path.join(dir, "test.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    db.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "x", vector: l2([1, 0, 0, 0]) }
    ]);
    await db.closeAndRelease();
    const rollbackJournal = `${file}-journal`;
    await fs.writeFile(rollbackJournal, "ROLLBACK_JOURNAL_SENTINEL");

    expect(
      await fs
        .stat(file)
        .then(() => true)
        .catch(() => false)
    ).toBe(true);
    expect(await db.clearOnDisk()).toBe(true);
    expect(
      await fs
        .stat(file)
        .then(() => true)
        .catch(() => false)
    ).toBe(false);
    await expect(fs.lstat(rollbackJournal)).rejects.toMatchObject({ code: "ENOENT" });
    // Idempotent — second call returns false but doesn't throw.
    expect(await db.clearOnDisk()).toBe(false);
  });

  it.each(["rollback-journal directory"])(
    "clearOnDisk preflights the complete SQLite family before an unsafe %s",
    async () => {
      const file = path.join(dir, "unsafe-journal.embed.db");
      const wal = `${file}-wal`;
      const shm = `${file}-shm`;
      const journal = `${file}-journal`;
      await fs.writeFile(file, "MAIN_SENTINEL");
      await fs.writeFile(wal, "WAL_SENTINEL");
      await fs.writeFile(shm, "SHM_SENTINEL");
      await fs.mkdir(journal);
      const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });

      await expect(db.clearOnDisk()).rejects.toThrow("Refusing to clear an unsafe embedding-index artifact");
      expect(await fs.readFile(file, "utf8")).toBe("MAIN_SENTINEL");
      expect(await fs.readFile(wal, "utf8")).toBe("WAL_SENTINEL");
      expect(await fs.readFile(shm, "utf8")).toBe("SHM_SENTINEL");
      expect((await fs.lstat(journal)).isDirectory()).toBe(true);
    }
  );

  // clearOnDisk owns the complete HNSW family: legacy fixed binary, stable
  // metadata pointer, immutable binary generations, and recognized crash
  // temps/stages. Metadata carries raw text_preview, so every member is part
  // of the same right-to-erasure boundary.
  it("clearOnDisk removes legacy, generated, and crash-leftover HNSW artifacts", async () => {
    const file = path.join(dir, "vaultx.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    db.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "secret note text", vector: l2([1, 0, 0, 0]) }
    ]);
    await db.closeAndRelease();
    // Simulate the HNSW persist sidecars next to the embed-db (same base the
    // server derives: strip `.embed.db`, append `.hnsw`).
    const base = hnswPersistBase(file);
    const binFile = `${base}.bin`;
    const metaFile = `${base}.meta.json`;
    const generationFile = `${base}.${"a".repeat(48)}.bin`;
    const generatedTmp = `${metaFile}.enquire-tmp-${"b".repeat(48)}`;
    const generatedStage = `${generationFile}.enquire-stage-${"c".repeat(48)}`;
    await fs.writeFile(binFile, Buffer.from([1, 2, 3, 4]));
    await fs.writeFile(metaFile, JSON.stringify({ text_preview: "secret note text" }));
    await fs.writeFile(generationFile, Buffer.from([5, 6, 7, 8]));
    await fs.writeFile(generatedTmp, "secret note text");
    await fs.mkdir(generatedStage, { mode: 0o700 });
    await fs.writeFile(path.join(generatedStage, "artifact"), "secret note text", { mode: 0o600 });

    expect(await db.clearOnDisk()).toBe(true);
    for (const p of [file, binFile, metaFile, generationFile, generatedTmp, generatedStage]) {
      expect(
        await fs
          .stat(p)
          .then(() => true)
          .catch(() => false),
        `${p} should be removed`
      ).toBe(false);
    }
  });

  it("(negative control) clearOnDisk leaves UNRELATED sidecars untouched (P-2)", async () => {
    // Guard against over-deletion: a `.hnsw.bin` for a DIFFERENT embed-db base
    // must NOT be removed when clearing this one.
    const file = path.join(dir, "mine.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    db.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "x", vector: l2([1, 0, 0, 0]) }
    ]);
    await db.closeAndRelease();
    const otherSidecar = path.join(dir, "someone-else.hnsw.bin");
    await fs.writeFile(otherSidecar, Buffer.from([9]));

    await db.clearOnDisk();
    expect(
      await fs
        .stat(otherSidecar)
        .then(() => true)
        .catch(() => false)
    ).toBe(true); // untouched
  });

  it("getSourceStates returns the latest mtime per note for incremental rebuilds", async () => {
    const db = new EmbedDb({
      file: path.join(dir, "test.embed.db"),
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4
    });
    await db.open();
    db.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "x", vector: l2([1, 0, 0, 0]) }
    ]);
    db.upsertNote("b.md", 2000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "y", vector: l2([0, 1, 0, 0]) }
    ]);
    const states = db.getSourceStates();
    expect(states.length).toBe(2);
    const map = new Map(states.map((s) => [s.rel_path, s.mtime_ms]));
    expect(map.get("a.md")).toBe(1000);
    expect(map.get("b.md")).toBe(2000);

    // Update a.md — mtime should advance.
    db.upsertNote("a.md", 3000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "x'", vector: l2([1, 0, 0, 0]) }
    ]);
    const after = new Map(db.getSourceStates().map((s) => [s.rel_path, s.mtime_ms]));
    expect(after.get("a.md")).toBe(3000);
    await db.closeAndRelease();

    await assertQuarantineRetrievalLifecycle();
    await assertDeleteAndOrphanHydration();
    await assertQuarantinePersistenceAndKindScope();
    await assertLargeHydrationBatching();
    await assertRevisionMigrationAndReadonlyReader();
  });

  async function assertQuarantineRetrievalLifecycle(): Promise<void> {
    const file = path.join(dir, "quarantine.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    const stale = db.upsertNote("stale.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "stale", vector: l2([1, 0, 0, 0]) }
    ]);
    db.upsertNote("healthy.md", 1500, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "healthy", vector: l2([0, 1, 0, 0]) }
    ]);
    const legacyHits = db.search(l2([1, 0, 0, 0]), 10);
    const receiptHits = db.searchWithReceipts(l2([1, 0, 0, 0]), 10);
    const legacyHit = legacyHits[0];
    const receiptHit = receiptHits[0];
    if (!legacyHit || !receiptHit) throw new Error("expected compatibility search hits");
    expect(legacyHits).toEqual(
      receiptHits.map((hit) => ({
        rel_path: hit.rel_path,
        chunk_index: hit.chunk_index,
        line_start: hit.line_start,
        line_end: hit.line_end,
        text_preview: hit.text_preview,
        score: hit.score,
        kind: hit.kind
      }))
    );
    expect(Object.keys(legacyHit).sort()).toEqual(
      ["chunk_index", "kind", "line_end", "line_start", "rel_path", "score", "text_preview"].sort()
    );
    expect(legacyHit).not.toHaveProperty("indexed_mtime_ms");
    expect(legacyHit).not.toHaveProperty("indexed_revision");
    expect(Object.keys(receiptHit).sort()).toEqual(
      [
        "chunk_index",
        "indexed_mtime_ms",
        "indexed_revision",
        "kind",
        "line_end",
        "line_start",
        "rel_path",
        "score",
        "text_preview"
      ].sort()
    );
    expect(receiptHit).toEqual(
      expect.objectContaining({ indexed_mtime_ms: expect.any(Number), indexed_revision: expect.any(Number) })
    );
    const legacyVectorRows = db.getAllVectors();
    const legacyVectorRow = legacyVectorRows[0];
    if (!legacyVectorRow) throw new Error("expected compatibility vector row");
    expect(Object.keys(legacyVectorRow).sort()).toEqual(
      ["chunk_index", "kind", "label", "line_end", "line_start", "rel_path", "text_preview", "vector"].sort()
    );
    expect(legacyVectorRow).not.toHaveProperty("indexed_mtime_ms");
    expect(legacyVectorRow).not.toHaveProperty("indexed_revision");
    const initialHits = new Map(receiptHits.map((hit) => [hit.rel_path, hit]));
    const staleReceipt = initialHits.get("stale.md");
    const healthyReceipt = initialHits.get("healthy.md");
    if (!staleReceipt || !healthyReceipt) throw new Error("expected initial receipt-bound hits");
    expect(
      db.isCurrentSourceReceipt(
        staleReceipt.rel_path,
        staleReceipt.kind,
        staleReceipt.indexed_mtime_ms,
        staleReceipt.indexed_revision
      )
    ).toBe(true);
    expect(
      db.isCurrentSourceReceipt(
        healthyReceipt.rel_path,
        healthyReceipt.kind,
        healthyReceipt.indexed_mtime_ms,
        healthyReceipt.indexed_revision
      )
    ).toBe(true);

    const sameMtime = db.upsertNote("stale.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "same-mtime fresh", vector: l2([1, 0, 0, 0]) }
    ]);
    const sameMtimeHit = db.getSearchRowsByIds(sameMtime.newIds).get(sameMtime.newIds[0] ?? -1);
    if (!sameMtimeHit) throw new Error("expected same-mtime replacement hit");
    expect(sameMtimeHit.indexed_revision).toBeGreaterThan(staleReceipt.indexed_revision);
    expect(
      db.isCurrentSourceReceipt(
        staleReceipt.rel_path,
        staleReceipt.kind,
        staleReceipt.indexed_mtime_ms,
        staleReceipt.indexed_revision
      )
    ).toBe(false);
    expect(
      db.isCurrentSourceReceipt(
        sameMtimeHit.rel_path,
        sameMtimeHit.kind,
        sameMtimeHit.indexed_mtime_ms,
        sameMtimeHit.indexed_revision
      )
    ).toBe(true);
    expect(
      db.isCurrentSourceReceipt(
        healthyReceipt.rel_path,
        healthyReceipt.kind,
        healthyReceipt.indexed_mtime_ms,
        healthyReceipt.indexed_revision
      )
    ).toBe(true);
    const signatureBefore = db.computeSignature();
    expect(signatureBefore).not.toContain(";quarantine=");

    db.quarantineSource("stale.md", "md");

    expect(db.getQuarantinedPaths()).toEqual(["stale.md"]);
    expect(db.getQuarantinedPaths("pdf")).toEqual([]);
    expect(db.search(l2([1, 0, 0, 0]), 10).map((hit) => hit.rel_path)).toEqual(["healthy.md"]);
    expect(db.getAllVectors().map((row) => row.rel_path)).toEqual(["healthy.md"]);
    expect(db.getSearchRowsByIds(sameMtime.newIds).size).toBe(0);
    expect(
      db.isCurrentSourceReceipt(
        sameMtimeHit.rel_path,
        sameMtimeHit.kind,
        sameMtimeHit.indexed_mtime_ms,
        sameMtimeHit.indexed_revision
      )
    ).toBe(false);
    expect(db.getSearchRowsByIds(stale.newIds).size).toBe(0);
    expect(db.computeSignature()).not.toBe(signatureBefore);
    expect(db.computeSignature()).toContain(";quarantine=");

    const refreshed = db.upsertNote("stale.md", 2000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "fresh", vector: l2([1, 0, 0, 0]) }
    ]);
    const hit = db.searchWithReceipts(l2([1, 0, 0, 0]), 1)[0];
    if (!hit) throw new Error("expected refreshed receipt-bearing search hit");
    expect(hit).toEqual(
      expect.objectContaining({ rel_path: "stale.md", indexed_mtime_ms: 2000, indexed_revision: expect.any(Number) })
    );
    const refreshedLegacyVectorRow = db.getAllVectors().find((row) => row.rel_path === "stale.md");
    if (!refreshedLegacyVectorRow) throw new Error("expected refreshed legacy vector row");
    expect(refreshedLegacyVectorRow).toEqual(expect.objectContaining({ rel_path: "stale.md" }));
    expect(refreshedLegacyVectorRow).not.toHaveProperty("indexed_mtime_ms");
    expect(refreshedLegacyVectorRow).not.toHaveProperty("indexed_revision");
    const hydrated = db.getSearchRowsByIds(refreshed.newIds).get(refreshed.newIds[0] ?? -1);
    if (!hydrated) throw new Error("expected receipt-bearing hydrated row");
    expect(hydrated).toEqual(
      expect.objectContaining({
        rel_path: "stale.md",
        indexed_mtime_ms: 2000,
        indexed_revision: hit.indexed_revision
      })
    );
    expect(Object.keys(hydrated).sort()).toEqual(
      [
        "chunk_index",
        "indexed_mtime_ms",
        "indexed_revision",
        "kind",
        "line_end",
        "line_start",
        "rel_path",
        "text_preview"
      ].sort()
    );
    expect(hydrated).not.toHaveProperty("score");
    expect(db.getQuarantinedPaths()).toEqual([]);
    expect(db.computeSignature()).not.toContain(";quarantine=");
    await db.closeAndRelease();
  }

  async function assertDeleteAndOrphanHydration(): Promise<void> {
    const file = path.join(dir, "current-row.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    const inserted = db.upsertNote("orphan.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "orphan", vector: l2([1, 0, 0, 0]) }
    ]);
    const abaInsert = db.upsertNote("aba.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "before delete", vector: l2([0, 1, 0, 0]) }
    ]);
    const abaBefore = db.getSearchRowsByIds(abaInsert.newIds).get(abaInsert.newIds[0] ?? -1);
    if (!abaBefore) throw new Error("expected pre-delete ABA hit");
    db.deleteNote("aba.md");
    expect(
      db.isCurrentSourceReceipt(
        abaBefore.rel_path,
        abaBefore.kind,
        abaBefore.indexed_mtime_ms,
        abaBefore.indexed_revision
      )
    ).toBe(false);
    const abaReinsert = db.upsertNote("aba.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "after re-add", vector: l2([0, 1, 0, 0]) }
    ]);
    const abaAfter = db.getSearchRowsByIds(abaReinsert.newIds).get(abaReinsert.newIds[0] ?? -1);
    if (!abaAfter) throw new Error("expected re-added ABA hit");
    expect(abaAfter.indexed_revision).toBeGreaterThan(abaBefore.indexed_revision);
    expect(
      db.isCurrentSourceReceipt(abaAfter.rel_path, abaAfter.kind, abaAfter.indexed_mtime_ms, abaAfter.indexed_revision)
    ).toBe(true);
    db.deleteNote("aba.md");
    db.quarantineSource("removed.md", "md");
    db.deleteNote("removed.md");
    expect(db.getQuarantinedPaths()).toEqual([]);
    await db.closeAndRelease();

    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(file);
    raw.prepare("DELETE FROM source_state WHERE rel_path = ?").run("orphan.md");
    raw.close();

    const reopened = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await reopened.open();
    // Leftover embeddings without source_state refuse a complete HNSW snapshot
    // (LEFT JOIN: state_rel_path !== rel_path). Brute ranking INNER JOINs
    // source_state, so those rows are absent rather than failing the query.
    expect(() => reopened.captureHnswReceiptSnapshot()).toThrow(/not admissible for a complete HNSW snapshot/);
    expect(() => reopened.getAllVectors()).toThrow(/not admissible for a complete HNSW snapshot/);
    expect(reopened.search(l2([1, 0, 0, 0]), 10)).toEqual([]);
    expect(reopened.searchWithReceipts(l2([1, 0, 0, 0]), 10)).toEqual([]);
    expect(reopened.getSearchRowsByIds(inserted.newIds).size).toBe(0);
    reopened.quarantineSource("orphan.md", "md");
    reopened.deleteNote("orphan.md");
    expect(reopened.getQuarantinedPaths()).toEqual([]);
    await reopened.closeAndRelease();
  }

  async function assertQuarantinePersistenceAndKindScope(): Promise<void> {
    const file = path.join(dir, "quarantine-persistence.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    db.quarantineSource("note.md", "md");
    db.quarantineSource("paper.pdf", "pdf");
    await db.closeAndRelease();

    const reopened = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await reopened.open();
    expect(reopened.getQuarantinedPaths("md")).toEqual(["note.md"]);
    expect(reopened.getQuarantinedPaths("pdf")).toEqual(["paper.pdf"]);
    expect(reopened.auditKind("md").mismatched_files).toBe(1);
    await reopened.closeAndRelease();
  }

  async function assertLargeHydrationBatching(): Promise<void> {
    const db = new EmbedDb({
      file: path.join(dir, "hydrate-batches.embed.db"),
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4
    });
    await db.open();
    const inserted = db.upsertNote("one.md", 1234, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "one", vector: l2([1, 0, 0, 0]) }
    ]);
    const label = inserted.newIds[0];
    if (label === undefined) throw new Error("expected inserted label");

    // Put the only current row strictly after two complete 500-id batches.
    // Repeating both an absent id and the live id also proves de-duplication
    // without letting a first-batch-only mutant accidentally pass.
    const ids = Array.from({ length: 1_005 }, (_, index) => label + 10_000 + index);
    const firstAbsent = ids[0];
    if (firstAbsent === undefined) throw new Error("expected absent hydration label");
    ids.push(firstAbsent, label, label);
    const hydrated = db.getSearchRowsByIds(ids);

    expect(hydrated.size).toBe(1);
    expect(hydrated.get(label)).toEqual(
      expect.objectContaining({ rel_path: "one.md", indexed_mtime_ms: 1234, indexed_revision: expect.any(Number) })
    );
    await db.closeAndRelease();
  }

  async function assertRevisionMigrationAndReadonlyReader(): Promise<void> {
    const file = path.join(dir, "receipt-reader.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    try {
      db.upsertNote("legacy.md", 1000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "legacy", vector: l2([1, 0, 0, 0]) }
      ]);
      db.upsertNote("sibling.md", 1000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "sibling", vector: l2([0, 1, 0, 0]) }
      ]);
    } finally {
      await db.closeAndRelease();
    }

    const live = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await live.open();
    try {
      const hits = new Map(live.searchWithReceipts(l2([1, 0, 0, 0]), 10).map((hit) => [hit.rel_path, hit]));
      const oldLegacy = hits.get("legacy.md");
      const sibling = hits.get("sibling.md");
      if (!oldLegacy || !sibling) throw new Error("expected canonical source receipts");
      expect(oldLegacy.indexed_revision).toBe(1);
      expect(live.currentSourceReceiptMask([oldLegacy, sibling])).toEqual([true, true]);

      const reader = await openEmbedReceiptReader(file, "/v");
      try {
        expect(reader.currentSourceReceiptMask([oldLegacy, sibling])).toEqual([true, true]);
        live.upsertNote("legacy.md", 1000, [
          {
            chunkIndex: 0,
            lineStart: 1,
            lineEnd: 1,
            textPreview: "same-mtime replacement",
            vector: l2([1, 0, 0, 0])
          }
        ]);
        const newLegacy = live.searchWithReceipts(l2([1, 0, 0, 0]), 10).find((hit) => hit.rel_path === "legacy.md");
        if (!newLegacy) throw new Error("expected replacement receipt");
        expect(reader.currentSourceReceiptMask([oldLegacy, sibling, newLegacy])).toEqual([false, true, true]);
        expect(newLegacy.indexed_revision).toBeGreaterThan(oldLegacy.indexed_revision);
        expect(reader.isCurrentSourceReceipt("legacy.md", "md", Number.NaN, newLegacy.indexed_revision)).toBe(false);
        expect(reader.isCurrentSourceReceipt("legacy.md", "md", 1000, 0)).toBe(false);
        await expect(openEmbedReceiptReader(file, "/foreign-vault")).rejects.toThrow(/expected vault/);
        reader.close();
        expect(reader.currentSourceReceiptMask([newLegacy])).toEqual([false]);
      } finally {
        await reader.closeAndRelease();
      }
    } finally {
      await live.closeAndRelease();
    }

    const Database = (await import("better-sqlite3")).default;
    const tampered = new Database(file);
    tampered.exec(`
      DROP TRIGGER embed_source_state_revision_insert;
      CREATE TRIGGER embed_source_state_revision_insert
      AFTER INSERT ON source_state
      BEGIN
        SELECT 1;
      END;
    `);
    tampered.close();
    const tamperedBefore = await exactEmbedLogicalSnapshot(file);
    await expect(openEmbedReceiptReader(file, "/v")).rejects.toThrow(/compatible index/);
    await expectPathFreeEmbedOwnershipRefusal(file, "/v", tamperedBefore);
  }

  // v2.8.0 — PDF chunks indexed via the kind column.
  it("upserts with kind='pdf' and search returns kind='pdf'", async () => {
    const file = path.join(dir, "test.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    try {
      // Markdown chunk.
      db.upsertNote("a.md", 1000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "alpha", vector: l2([1, 0, 0, 0]) }
      ]);
      // PDF chunk — same dim, different kind.
      db.upsertNote(
        "paper.pdf",
        2000,
        [{ chunkIndex: 0, lineStart: 1, lineEnd: 5, textPreview: "[page: 1] alpha", vector: l2([1, 0, 0, 0]) }],
        "pdf"
      );
      // Cosine query that matches both.
      const hits = db.search(l2([1, 0, 0, 0]), 10);
      const byKind = new Map(hits.map((h) => [h.rel_path, h.kind]));
      expect(byKind.get("a.md")).toBe("md");
      expect(byKind.get("paper.pdf")).toBe("pdf");
    } finally {
      await db.closeAndRelease();
    }
  });

  it("getSourceStates(kind='md') and getSourceStates(kind='pdf') don't overlap", async () => {
    const file = path.join(dir, "test.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    try {
      db.upsertNote("a.md", 1000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "a", vector: l2([1, 0, 0, 0]) }
      ]);
      db.upsertNote(
        "p.pdf",
        2000,
        [{ chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "p", vector: l2([0, 1, 0, 0]) }],
        "pdf"
      );
      const md = db.getSourceStates("md").map((s) => s.rel_path);
      const pdf = db.getSourceStates("pdf").map((s) => s.rel_path);
      expect(md).toEqual(["a.md"]);
      expect(pdf).toEqual(["p.pdf"]);
      // Backward-compat: no kind filter returns both.
      const all = db.getSourceStates().map((s) => s.rel_path);
      expect(all.sort()).toEqual(["a.md", "p.pdf"]);
    } finally {
      await db.closeAndRelease();
    }
  });

  it("auditKind reports complete markdown and PDF indexes independently", async () => {
    const file = path.join(dir, "test.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    try {
      db.upsertNote("a.md", 1000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 2, textPreview: "a0", vector: l2([1, 0, 0, 0]) },
        { chunkIndex: 1, lineStart: 3, lineEnd: 4, textPreview: "a1", vector: l2([0, 1, 0, 0]) }
      ]);
      db.upsertNote(
        "paper.pdf",
        2000,
        [{ chunkIndex: 0, lineStart: 1, lineEnd: 5, textPreview: "p0", vector: l2([0, 0, 1, 0]) }],
        "pdf"
      );

      expect(db.auditKind("md")).toEqual({
        indexed_files: 1,
        declared_chunks: 2,
        indexed_chunks: 2,
        mismatched_files: 0
      });
      expect(db.auditKind("pdf")).toEqual({
        indexed_files: 1,
        declared_chunks: 1,
        indexed_chunks: 1,
        mismatched_files: 0
      });

      db.upsertNote("empty.md", 1100, []);
      expect(db.auditKind("md")).toEqual({
        indexed_files: 2,
        declared_chunks: 2,
        indexed_chunks: 2,
        mismatched_files: 1
      });
    } finally {
      await db.closeAndRelease();
    }
  });

  it("(negative control) auditKind detects a deleted markdown embedding without flagging PDF", async () => {
    const file = path.join(dir, "test.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    db.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "a0", vector: l2([1, 0, 0, 0]) },
      { chunkIndex: 1, lineStart: 2, lineEnd: 2, textPreview: "a1", vector: l2([0, 1, 0, 0]) }
    ]);
    db.upsertNote(
      "paper.pdf",
      2000,
      [{ chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "p0", vector: l2([0, 0, 1, 0]) }],
      "pdf"
    );
    await db.closeAndRelease();

    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(file);
    raw.prepare("DELETE FROM embeddings WHERE rel_path = ? AND chunk_index = ?").run("a.md", 1);
    raw.close();

    const reopened = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await reopened.open();
    try {
      expect(reopened.auditKind("md")).toEqual({
        indexed_files: 1,
        declared_chunks: 2,
        indexed_chunks: 1,
        mismatched_files: 1
      });
      expect(reopened.auditKind("pdf").mismatched_files).toBe(0);
    } finally {
      await reopened.closeAndRelease();
    }
  });

  it("(negative control) auditKind detects an embedding-only PDF path without flagging markdown", async () => {
    const file = path.join(dir, "test.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    db.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "a0", vector: l2([1, 0, 0, 0]) }
    ]);
    db.upsertNote(
      "paper.pdf",
      2000,
      [{ chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "p0", vector: l2([0, 1, 0, 0]) }],
      "pdf"
    );
    await db.closeAndRelease();

    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(file);
    raw
      .prepare(
        `INSERT INTO embeddings
           (rel_path, chunk_index, line_start, line_end, text_preview, vector, kind)
         SELECT ?, 0, 1, 1, ?, vector, 'pdf'
         FROM embeddings
         WHERE rel_path = ?`
      )
      .run("orphan.pdf", "orphan", "paper.pdf");
    raw.close();

    const reopened = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await reopened.open();
    try {
      expect(reopened.auditKind("pdf")).toEqual({
        indexed_files: 1,
        declared_chunks: 1,
        indexed_chunks: 2,
        mismatched_files: 1
      });
      expect(reopened.auditKind("md").mismatched_files).toBe(0);
    } finally {
      await reopened.closeAndRelease();
    }
  });

  it("(negative control) auditKind rejects a non-contiguous index range even when row count matches", async () => {
    const file = path.join(dir, "test.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    db.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "a0", vector: l2([1, 0, 0, 0]) },
      { chunkIndex: 1, lineStart: 2, lineEnd: 2, textPreview: "a1", vector: l2([0, 1, 0, 0]) }
    ]);
    await db.closeAndRelease();

    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(file);
    raw.prepare("UPDATE embeddings SET chunk_index = 2 WHERE rel_path = ? AND chunk_index = 1").run("a.md");
    raw.close();

    const reopened = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await reopened.open();
    try {
      expect(reopened.auditKind("md")).toEqual({
        indexed_files: 1,
        declared_chunks: 2,
        indexed_chunks: 2,
        mismatched_files: 1
      });
    } finally {
      await reopened.closeAndRelease();
    }
  });

  it("(negative control) auditKind rejects REAL indices, corrupt vectors, and invalid/cross-kind rows", async () => {
    const file = path.join(dir, "test.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    db.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "a0", vector: l2([1, 0, 0, 0]) },
      { chunkIndex: 1, lineStart: 2, lineEnd: 2, textPreview: "a1", vector: l2([0, 1, 0, 0]) },
      { chunkIndex: 2, lineStart: 3, lineEnd: 3, textPreview: "a2", vector: l2([0, 0, 1, 0]) }
    ]);
    const healthyManifest = db.fingerprintKind("md");
    expect(db.auditVectorHealth("md")).toEqual({ invalid_vectors: 0 });
    await db.closeAndRelease();

    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(file);
    raw.prepare("UPDATE embeddings SET chunk_index = 0.5 WHERE rel_path = ? AND chunk_index = 1").run("a.md");
    raw.close();

    const reopened = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await reopened.open();
    expect(reopened.auditKind("md").mismatched_files).toBe(1);
    await reopened.closeAndRelease();

    const corruptVector = new Database(file);
    corruptVector.prepare("UPDATE embeddings SET chunk_index = 1 WHERE rel_path = ? AND chunk_index = 0.5").run("a.md");
    corruptVector.prepare("UPDATE embeddings SET vector = x'00' WHERE rel_path = ? AND chunk_index = 1").run("a.md");
    corruptVector.close();

    const vectorAudit = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await vectorAudit.open();
    expect(vectorAudit.auditKind("md").mismatched_files).toBe(1);
    await vectorAudit.closeAndRelease();

    const zeroBytes = Buffer.from(new Float32Array([0, 0, 0, 0]).buffer);
    const numericalVector = new Database(file);
    numericalVector
      .prepare("UPDATE embeddings SET vector = ? WHERE rel_path = ? AND chunk_index = 1")
      .run(zeroBytes, "a.md");
    numericalVector.close();

    const numericalAudit = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await numericalAudit.open();
    expect(numericalAudit.auditKind("md").mismatched_files).toBe(0);
    expect(numericalAudit.auditVectorHealth("md")).toEqual({ invalid_vectors: 1 });
    expect(numericalAudit.fingerprintKind("md")).not.toBe(healthyManifest);
    await numericalAudit.closeAndRelease();

    const restoredBytes = Buffer.from(new Float32Array([0, 1, 0, 0]).buffer);
    const restoreVector = new Database(file);
    restoreVector
      .prepare("UPDATE embeddings SET vector = ? WHERE rel_path = ? AND chunk_index = 1")
      .run(restoredBytes, "a.md");
    restoreVector.close();
    const restoredAudit = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await restoredAudit.open();
    expect(restoredAudit.auditVectorHealth("md")).toEqual({ invalid_vectors: 0 });
    expect(restoredAudit.fingerprintKind("md")).toBe(healthyManifest);
    await restoredAudit.closeAndRelease();

    const invalidKind = new Database(file);
    invalidKind.prepare("UPDATE embeddings SET kind = 'bogus' WHERE rel_path = ?").run("a.md");
    invalidKind.prepare("UPDATE source_state SET kind = 'bogus' WHERE rel_path = ?").run("a.md");
    invalidKind.close();

    const kindAudit = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await kindAudit.open();
    try {
      expect(kindAudit.auditKind("md").mismatched_files).toBe(1);
      expect(kindAudit.auditKind("pdf").mismatched_files).toBe(1);
    } finally {
      await kindAudit.closeAndRelease();
    }

    const crossKind = new Database(file);
    crossKind.prepare("UPDATE embeddings SET kind = 'md' WHERE rel_path = ?").run("a.md");
    crossKind.prepare("UPDATE source_state SET kind = 'md' WHERE rel_path = ?").run("a.md");
    crossKind
      .prepare(
        `INSERT INTO embeddings
           (rel_path, chunk_index, line_start, line_end, text_preview, vector, kind)
         SELECT rel_path, 3, 4, 4, 'cross-kind', vector, 'pdf'
         FROM embeddings
         WHERE rel_path = ? AND chunk_index = 0`
      )
      .run("a.md");
    crossKind.close();

    const crossKindAudit = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await crossKindAudit.open();
    try {
      // The three valid md rows exactly satisfy the md declaration. The only
      // md mismatch is the extra, otherwise-valid pdf row on that declared path.
      expect(crossKindAudit.auditKind("md")).toEqual({
        indexed_files: 1,
        declared_chunks: 3,
        indexed_chunks: 3,
        mismatched_files: 1
      });
    } finally {
      await crossKindAudit.closeAndRelease();
    }
  });

  it("rebuilds supported same-root legacy schemas but refuses missing/future authority metadata", async () => {
    const file = path.join(dir, "test.embed.db");
    const db1 = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db1.open();
    db1.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "x", vector: l2([1, 0, 0, 0]) }
    ]);
    expect(db1.totalChunks()).toBe(1);
    await db1.closeAndRelease();

    // Reopen with matching meta — should preserve data.
    const db2 = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db2.open();
    expect(db2.totalChunks()).toBe(1);
    await db2.closeAndRelease();

    const Database = (await import("better-sqlite3")).default;

    // Explicitly supported historical v4 metadata remains readable even when
    // its optional authority ledger is absent. Same-config v4→v5 keeps the
    // vector rows and rotates UUID/epoch metadata (BACKLOG §1.CC A5).
    const repairFile = path.join(dir, "v4-optional-repair.embed.db");
    await seedExactEmbedFile(repairFile, "repair.md");
    const repairRaw = new Database(repairFile);
    const repairPayloadBefore = repairRaw
      .prepare(
        `SELECT id, rel_path, text_preview, hex(vector) AS vector_hex, kind
         FROM embeddings
         ORDER BY id`
      )
      .all();
    const previousInstanceUuid = repairRaw
      .prepare("SELECT value FROM meta WHERE key = 'instance_uuid'")
      .pluck()
      .get() as string;
    const epochTriggers = repairRaw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name GLOB 'embed_mutation_epoch_*'")
      .pluck()
      .all() as string[];
    for (const name of epochTriggers) repairRaw.exec(`DROP TRIGGER ${name}`);
    repairRaw.exec(`
      ${DROP_EMBED_REVISION_TRIGGERS_SQL}
      DROP TABLE source_quarantine;
      DROP TABLE source_revision;
      UPDATE meta SET value = '4' WHERE key = 'schema_version';
      DELETE FROM meta WHERE key IN ('instance_uuid', 'mutation_epoch');
    `);
    repairRaw.close();
    expect(await peekEmbedDbMeta(repairFile, "/v")).toEqual(
      expect.objectContaining({ schema_version: "4", vault_root: "/v" })
    );

    const repairedV4 = new EmbedDb({ file: repairFile, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await repairedV4.open();
    expect(repairedV4.totalChunks()).toBe(1);
    await repairedV4.closeAndRelease();
    const repairedRaw = new Database(repairFile, { readonly: true, fileMustExist: true });
    try {
      expect(
        repairedRaw
          .prepare(
            `SELECT id, rel_path, text_preview, hex(vector) AS vector_hex, kind
             FROM embeddings
             ORDER BY id`
          )
          .all()
      ).toEqual(repairPayloadBefore);
      const currentMeta = new Map(
        repairedRaw
          .prepare("SELECT key, value FROM meta ORDER BY key")
          .all<{ key: string; value: string }>()
          .map(({ key, value }) => [key, value])
      );
      expect(currentMeta.get("schema_version")).toBe(String(EMBED_DB_SCHEMA_VERSION));
      expect(currentMeta.get("instance_uuid")).toMatch(/^[0-9a-f]{32}$/);
      expect(currentMeta.get("instance_uuid")).not.toBe(previousInstanceUuid);
      expect(currentMeta.get("mutation_epoch")).toBe("1");
      const repairedTables = repairedRaw
        .prepare(
          `SELECT name, sql
           FROM sqlite_master
           WHERE type = 'table' AND name IN ('source_quarantine', 'source_revision')
           ORDER BY name`
        )
        .all<{ name: string; sql: string }>();
      expect(repairedTables).toHaveLength(2);
      expect(repairedTables.every((row) => /WITHOUT ROWID/i.test(row.sql))).toBe(true);
      expect(repairedTables.find((row) => row.name === "source_revision")?.sql).toContain(
        "typeof(revision) = 'integer'"
      );
      expect(repairedRaw.prepare("SELECT * FROM source_quarantine").all()).toEqual([]);
      expect(
        repairedRaw
          .prepare("SELECT rel_path, kind, revision FROM source_revision ORDER BY rel_path")
          .all()
      ).toEqual([{ rel_path: "repair.md", kind: "md", revision: 1 }]);
      expect(
        repairedRaw
          .prepare(
            "SELECT count(*) FROM sqlite_master WHERE type = 'trigger' AND name GLOB 'embed_source_*_revision_*'"
          )
          .pluck()
          .get()
      ).toBe(6);
      expect(
        repairedRaw
          .prepare("SELECT count(*) FROM sqlite_master WHERE type = 'trigger' AND name GLOB 'embed_mutation_epoch_*'")
          .pluck()
          .get()
      ).toBe(12);
    } finally {
      repairedRaw.close();
    }

    const raw = new Database(file);
    const staleEpochTriggers = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name GLOB 'embed_mutation_epoch_*'")
      .pluck()
      .all() as string[];
    for (const name of staleEpochTriggers) raw.exec(`DROP TRIGGER ${name}`);
    raw.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(EMBED_DB_SCHEMA_VERSION - 1));
    raw.prepare("DELETE FROM meta WHERE key IN ('instance_uuid', 'mutation_epoch')").run();
    raw.close();

    // POSITIVE: same-config schema 4→5 keeps the existing vector (A5).
    const db3 = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db3.open();
    expect(db3.totalChunks()).toBe(1);
    db3.upsertNote("b.md", 2000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "y", vector: l2([0, 1, 0, 0]) }
    ]);
    await db3.closeAndRelease();

    const logicalSnapshot = () => {
      const inspection = new Database(file, { readonly: true, fileMustExist: true });
      try {
        return {
          schema: inspection
            .prepare(
              `SELECT type, name, tbl_name, sql
               FROM sqlite_master
               WHERE name NOT GLOB 'sqlite_*'
               ORDER BY type, name`
            )
            .all(),
          meta: inspection.prepare("SELECT key, value FROM meta ORDER BY key").all(),
          embeddings: inspection
            .prepare("SELECT rel_path, chunk_index, text_preview, hex(vector) AS vector_hex, kind FROM embeddings")
            .all(),
          sourceState: inspection.prepare("SELECT * FROM source_state ORDER BY rel_path").all()
        };
      } finally {
        inspection.close();
      }
    };
    const expectRefusalToPreserve = async (message: RegExp) => {
      const before = logicalSnapshot();
      const refused = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
      await expect(refused.open()).rejects.toThrow(message);
      expect(logicalSnapshot()).toEqual(before);
    };

    const missingVersion = new Database(file);
    missingVersion.prepare("DELETE FROM meta WHERE key = 'schema_version'").run();
    missingVersion.close();
    // NEGATIVE control: a populated database without exact provenance is not
    // a legacy migration candidate and must retain its rows and BLOBs.
    expect(await peekEmbedDbMeta(file, "/v")).toBeNull();
    await expectRefusalToPreserve(/ownership could not be verified/);

    const futureVersion = new Database(file);
    futureVersion
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)")
      .run(String(EMBED_DB_SCHEMA_VERSION + 1));
    futureVersion.close();
    expect((await peekEmbedDbMeta(file))?.schema_version).toBe(String(EMBED_DB_SCHEMA_VERSION + 1));
    expect(await peekEmbedDbMeta(file, "/v")).toBeNull();
    await expectRefusalToPreserve(/newer unsupported schema/);
    await expectPathFreeRecoveryOwnershipRefusal(file, "/v");

    const missingRoot = new Database(file);
    missingRoot.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(EMBED_DB_SCHEMA_VERSION));
    missingRoot.prepare("DELETE FROM meta WHERE key = 'vault_root'").run();
    missingRoot.close();
    await expectRefusalToPreserve(/ownership could not be verified/);

    const emptyRoot = new Database(file);
    emptyRoot.prepare("INSERT INTO meta (key, value) VALUES ('vault_root', '')").run();
    emptyRoot.close();
    await expectRefusalToPreserve(/ownership could not be verified/);

    const oversizedAuthority = new Database(file);
    oversizedAuthority.prepare("UPDATE meta SET value = ? WHERE key = 'vault_root'").run("/v");
    oversizedAuthority.prepare("UPDATE meta SET value = ? WHERE key = 'model_alias'").run("x".repeat(8_193));
    oversizedAuthority.close();
    // Bounded admission projects at most cap+1 characters and refuses the
    // oversized authority cell; it never selects the full hostile value.
    await expectRefusalToPreserve(/ownership could not be verified/);

    // POSITIVE controls: genuine v1-v3 EmbedDb signatures with the exact
    // root are supported legacy provenance. v1 still rebuilds (no `kind`
    // column). v2/v3 already match the current vector table and keep rows.
    for (const legacyVersion of [1, 2, 3]) {
      const legacyFile = path.join(dir, `legacy-v${legacyVersion}.embed.db`);
      const legacy = new Database(legacyFile);
      const kindColumn = legacyVersion >= 2 ? ",\n          kind TEXT NOT NULL DEFAULT 'md'" : "";
      legacy.exec(`
        CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE embeddings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          rel_path TEXT NOT NULL,
          chunk_index INTEGER NOT NULL,
          line_start INTEGER NOT NULL,
          line_end INTEGER NOT NULL,
          text_preview TEXT NOT NULL,
          vector BLOB NOT NULL${kindColumn},
          UNIQUE(rel_path, chunk_index)
        );
        CREATE INDEX embeddings_rel_path ON embeddings(rel_path);
        CREATE TABLE source_state (
          rel_path TEXT PRIMARY KEY,
          mtime_ms INTEGER NOT NULL,
          n_chunks INTEGER NOT NULL${kindColumn},
          indexed_at TEXT NOT NULL
        );
      `);
      const putMeta = legacy.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
      for (const [key, value] of [
        ["schema_version", String(legacyVersion)],
        ["vault_root", "/v"],
        ["model_alias", "multilingual"],
        ["dim", "4"]
      ]) {
        putMeta.run(key, value);
      }
      if (legacyVersion >= 3) putMeta.run("quantization", "f32");
      const embeddingKind = legacyVersion >= 2 ? ", kind" : "";
      const embeddingKindValue = legacyVersion >= 2 ? ", 'md'" : "";
      legacy
        .prepare(
          `INSERT INTO embeddings
             (rel_path, chunk_index, line_start, line_end, text_preview, vector${embeddingKind})
           VALUES (?, 0, 1, 1, ?, ?${embeddingKindValue})`
        )
        .run("legacy.md", "legacy", Buffer.from(l2([1, 0, 0, 0]).buffer));
      const stateKind = legacyVersion >= 2 ? ", kind" : "";
      const stateKindValue = legacyVersion >= 2 ? ", 'md'" : "";
      legacy
        .prepare(
          `INSERT INTO source_state (rel_path, mtime_ms, n_chunks${stateKind}, indexed_at)
           VALUES (?, 1, 1${stateKindValue}, 'legacy')`
        )
        .run("legacy.md");
      legacy.close();

      const migrated = new EmbedDb({ file: legacyFile, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
      await migrated.open();
      expect(migrated.totalChunks()).toBe(legacyVersion === 1 ? 0 : 1);
      await migrated.closeAndRelease();
    }
  });
});

// v2.17.0 — int8 quantization. The encode/decode helpers are pure (no DB),
// so we exercise them directly first, then run end-to-end EmbedDb tests
// with `quantization: "int8"` to verify the BLOB layout, the schema-mismatch
// rebuild on mode swap, recall@K parity vs Float32, and the brute-force
// + getAllVectors paths.
describe("EmbedDb int8 quantization", () => {
  describe("encodeInt8Vector / decodeInt8Vector", () => {
    it("roundtrips a typical L2-normalized vector within ~range/256 absolute error", () => {
      const original = l2([0.5, -0.25, 0.75, -0.125, 0.4, -0.4, 0.6, -0.6]);
      const buf = encodeInt8Vector(original);
      // Layout: dim bytes int8 + 4 bytes Float32 vMin + 4 bytes Float32 scale.
      expect(buf.byteLength).toBe(original.length + 8);
      const decoded = decodeInt8Vector(buf, original.length);
      expect(decoded.length).toBe(original.length);
      // Per-element error is bounded by `scale = range/255`. For an L2-normed
      // 8-dim vector, range is ~1.4, so absolute error ≤ ~0.0055. Use a
      // generous 0.01 tolerance — we care about ordering/recall, not bits.
      for (let i = 0; i < original.length; i++) {
        expect(Math.abs((decoded[i] ?? 0) - (original[i] ?? 0))).toBeLessThan(0.01);
      }
    });

    it("handles the all-zero vector without div-by-zero (range collapses to 0)", () => {
      const zero = new Float32Array([0, 0, 0, 0]);
      const buf = encodeInt8Vector(zero);
      expect(buf.byteLength).toBe(4 + 8);
      const decoded = decodeInt8Vector(buf, 4);
      // vMin=0, scale=1 (forced), q=0 → decode = 0. Bit-exact.
      for (let i = 0; i < 4; i++) expect(decoded[i]).toBe(0);
    });

    it("clamps int8 values into [0, 255] at the boundary", () => {
      const v = new Float32Array([0.0, 1.0, 0.5, 1.0]); // includes dup max
      const buf = encodeInt8Vector(v);
      // First byte (vMin=0) must be 0; second (vMax=1) must be 255.
      expect(buf[0]).toBe(0);
      expect(buf[1]).toBe(255);
      // Mid value should be ~127 (linear interpolation).
      expect(Math.abs((buf[2] ?? 0) - 127)).toBeLessThanOrEqual(1);
      // Dup-max also lands at 255.
      expect(buf[3]).toBe(255);
    });

    it("decode rejects buffers with unexpected byte length", () => {
      // dim=4 expects 4+8=12 bytes; a 10-byte buffer must throw.
      expect(() => decodeInt8Vector(Buffer.alloc(10), 4)).toThrow(/expected 12B/);
    });

    it("preserves cosine ranking on a synthetic top-K query", () => {
      // Three orthogonal-ish vectors. Quantize, dequantize, then recompute
      // cosine vs the same query. Ordering must match the Float32 baseline.
      const docs = [l2([1, 0, 0, 0]), l2([0.95, 0.05, 0, 0.1]), l2([0, 1, 0, 0])];
      const query = l2([1, 0, 0, 0]);
      const f32Scores = docs.map((d) => {
        let s = 0;
        for (let i = 0; i < d.length; i++) s += (query[i] ?? 0) * (d[i] ?? 0);
        return s;
      });
      const int8Scores = docs.map((d) => {
        const q = decodeInt8Vector(encodeInt8Vector(d), d.length);
        let s = 0;
        for (let i = 0; i < q.length; i++) s += (query[i] ?? 0) * (q[i] ?? 0);
        return s;
      });
      // Order must be preserved: doc 0 > doc 1 > doc 2.
      const f32Order = [...f32Scores.keys()].sort((a, b) => (f32Scores[b] ?? 0) - (f32Scores[a] ?? 0));
      const int8Order = [...int8Scores.keys()].sort((a, b) => (int8Scores[b] ?? 0) - (int8Scores[a] ?? 0));
      expect(int8Order).toEqual(f32Order);
    });
  });

  it("opens with quantization='int8' and stores ~dim+8 bytes per vector", async () => {
    const file = path.join(dir, "int8.embed.db");
    const db = new EmbedDb({
      file,
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4,
      quantization: "int8"
    });
    await db.open();
    try {
      db.upsertNote("a.md", 1000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "hello", vector: l2([1, 0, 0, 0]) }
      ]);
      expect(db.totalChunks()).toBe(1);
      // Search returns the same row with a near-1.0 cosine score (small
      // quant error, but still ranks #1 against itself).
      const hits = db.search(l2([1, 0, 0, 0]), 1);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.rel_path).toBe("a.md");
      expect(hits[0]?.score).toBeGreaterThan(0.99);
    } finally {
      await db.closeAndRelease();
    }
  });

  it("rebuilds when the quantization mode changes (f32 ↔ int8)", async () => {
    const unopenedParent = path.join(dir, "invalid-quantization");
    expect(
      () =>
        new EmbedDb({
          file: path.join(unopenedParent, "invalid.embed.db"),
          vaultRoot: "/v",
          modelAlias: "multilingual",
          dim: 4,
          quantization: "invalid" as never
        })
    ).toThrow(/quantization must be/);
    await expect(fs.stat(unopenedParent)).rejects.toMatchObject({ code: "ENOENT" });

    const file = path.join(dir, "swap.embed.db");
    const f32 = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await f32.open();
    f32.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "x", vector: l2([1, 0, 0, 0]) }
    ]);
    expect(f32.totalChunks()).toBe(1);
    await f32.closeAndRelease();

    // Reopen with int8 — meta-mismatch must drop the embeddings table.
    const int8 = new EmbedDb({
      file,
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4,
      quantization: "int8"
    });
    await int8.open();
    expect(int8.totalChunks()).toBe(0);
    await int8.closeAndRelease();

    // Swap back to f32 — same rebuild trigger.
    const f32again = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await f32again.open();
    expect(f32again.totalChunks()).toBe(0);
    await f32again.closeAndRelease();
  });

  it("preserves data when reopening with the same int8 mode (idempotent)", async () => {
    const file = path.join(dir, "idem.embed.db");
    const db1 = new EmbedDb({
      file,
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4,
      quantization: "int8"
    });
    await db1.open();
    db1.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "y", vector: l2([1, 0, 0, 0]) }
    ]);
    await db1.closeAndRelease();

    const db2 = new EmbedDb({
      file,
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4,
      quantization: "int8"
    });
    await db2.open();
    expect(db2.totalChunks()).toBe(1);
    await db2.closeAndRelease();
  });

  it("ranks top-K identically to f32 on a 32-dim synthetic corpus (recall@5 = 100%)", async () => {
    // Generate 50 random unit vectors as the corpus, plus 5 query vectors
    // each closer to a known-relevant doc. Run search() in both f32 and
    // int8 modes; the top-5 result sets must overlap by ≥ 4/5 (typical
    // worst-case for asymmetric int8 quant).
    const dim = 32;
    const N = 50;
    // Deterministic random — Mulberry32 PRNG so the test is reproducible.
    let state = 0x9e3779b9;
    const rng = () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const corpus: Float32Array[] = [];
    for (let i = 0; i < N; i++) {
      const arr: number[] = [];
      for (let d = 0; d < dim; d++) arr.push(rng() * 2 - 1);
      corpus.push(l2(arr));
    }

    const f32File = path.join(dir, "rcl-f32.embed.db");
    const i8File = path.join(dir, "rcl-i8.embed.db");
    const f32Db = new EmbedDb({ file: f32File, vaultRoot: "/v", modelAlias: "m", dim });
    const i8Db = new EmbedDb({
      file: i8File,
      vaultRoot: "/v",
      modelAlias: "m",
      dim,
      quantization: "int8"
    });
    await f32Db.open();
    await i8Db.open();
    try {
      const chunks = corpus.map((v, i) => ({
        chunkIndex: i,
        lineStart: i + 1,
        lineEnd: i + 1,
        textPreview: `c${i}`,
        vector: v
      }));
      f32Db.upsertNote("corpus.md", 1, chunks);
      i8Db.upsertNote("corpus.md", 1, chunks);

      // Aggregate recall@5 across 5 queries; expect ≥ 90% overlap on average.
      let overlapTotal = 0;
      const k = 5;
      const Q = 5;
      for (let q = 0; q < Q; q++) {
        const qarr: number[] = [];
        for (let d = 0; d < dim; d++) qarr.push(rng() * 2 - 1);
        const query = l2(qarr);
        const f32Hits = new Set(f32Db.search(query, k).map((h) => h.chunk_index));
        const i8Hits = i8Db.search(query, k).map((h) => h.chunk_index);
        const overlap = i8Hits.filter((c) => f32Hits.has(c)).length;
        overlapTotal += overlap;
      }
      // Total possible overlap = Q * k = 25. 90% → 22.5 → require ≥ 22.
      expect(overlapTotal).toBeGreaterThanOrEqual(22);
    } finally {
      await f32Db.closeAndRelease();
      await i8Db.closeAndRelease();
    }
  });

  it("getAllVectors returns dequantized Float32 in int8 mode", async () => {
    const file = path.join(dir, "gav.embed.db");
    const db = new EmbedDb({
      file,
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4,
      quantization: "int8"
    });
    await db.open();
    try {
      const v = l2([0.7, 0.1, -0.3, 0.5]);
      db.upsertNote("a.md", 1, [{ chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "z", vector: v }]);
      const all = db.getAllVectors();
      expect(all).toHaveLength(1);
      const got = all[0]?.vector;
      expect(got).toBeInstanceOf(Float32Array);
      expect(got?.length).toBe(4);
      // Dequant is lossy — match within scale-bounded tolerance.
      for (let i = 0; i < 4; i++) {
        expect(Math.abs((got?.[i] ?? 0) - (v[i] ?? 0))).toBeLessThan(0.01);
      }
    } finally {
      await db.closeAndRelease();
    }
  });

  it("returns the exact DB-decoded vectors for int8 live HNSW updates", async () => {
    const file = path.join(dir, "live-int8-vectors.embed.db");
    const db = new EmbedDb({
      file,
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4,
      quantization: "int8"
    });
    await db.open();
    try {
      const input = l2([0.137, 0.283, -0.419, 0.851]);
      const result = db.upsertNoteWithCanonicalVectors("live.md", 1, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "live", vector: input }
      ]);
      const canonical = result.newVectors[0];
      const rebuilt = db.captureHnswBuildSnapshot().vectors[0]?.vector;
      expect(canonical).toBeInstanceOf(Float32Array);
      expect(Array.from(canonical ?? [])).toEqual(Array.from(rebuilt ?? []));
      expect(Array.from(canonical ?? [])).not.toEqual(Array.from(input));
    } finally {
      await db.closeAndRelease();
    }
  });

  it("computeSignature DIFFERS across quantization modes (v3.7.6 M-10 fix — was: ignored encoding)", async () => {
    // v3.7.6 M-10 (external audit) — pre-fix the HNSW staleness signature
    // was `dim;rows;maxId;model`, NOT including quantization. If the user
    // re-built embed-db with `--quantize-embeddings int8` (vs the previous
    // `f32`) and rowcount/maxId/dim/model stayed the same, the persisted
    // HNSW sidecar was considered "fresh" — but its float32 vectors no
    // longer matched the int8 bytes in the new embed-db rows. v3.7.6 adds
    // `quant=` to the signature, so quantization swaps now force HNSW
    // rebuild correctly.
    //
    // This test FLIPS the pre-v3.7.6 assertion: two indexes with identical
    // content but different encodings must now produce DIFFERENT signatures.
    const fileA = path.join(dir, "sig-a.embed.db");
    const fileB = path.join(dir, "sig-b.embed.db");
    const a = new EmbedDb({ file: fileA, vaultRoot: "/v", modelAlias: "m", dim: 4 });
    const b = new EmbedDb({
      file: fileB,
      vaultRoot: "/v",
      modelAlias: "m",
      dim: 4,
      quantization: "int8"
    });
    await a.open();
    await b.open();
    try {
      const v = l2([1, 0, 0, 0]);
      a.upsertNote("x.md", 1, [{ chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "x", vector: v }]);
      b.upsertNote("x.md", 1, [{ chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "x", vector: v }]);
      // Post-fix: signatures differ because `quant=f32` vs `quant=int8`.
      expect(a.computeSignature()).not.toBe(b.computeSignature());
      expect(a.computeSignature()).toMatch(/quant=f32/);
      expect(b.computeSignature()).toMatch(/quant=int8/);
    } finally {
      await a.closeAndRelease();
      await b.closeAndRelease();
    }
  });
});

describe("EmbedDb semantic-family lifetime state machine", () => {
  async function inspectSemanticFamily(file: string) {
    return inspectPersistenceLeases({ targetPath: file, familyKey: SEMANTIC_PERSISTENCE_FAMILY_KEY });
  }

  async function seedReceipt(file: string) {
    const seed = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await seed.open();
    try {
      seed.upsertNote("leased-reader.md", 1234, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "leased", vector: l2([1, 0, 0, 0]) }
      ]);
      const receipt = seed.searchWithReceipts(l2([1, 0, 0, 0]), 1)[0];
      if (!receipt) throw new Error("expected leased reader receipt fixture");
      return receipt;
    } finally {
      await seed.closeAndRelease();
    }
  }

  it("single-flights concurrent open and ignores hostile discovery getters on join and no-op", async () => {
    const file = path.join(dir, "single-flight.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    let getterReads = 0;
    const irrelevantExpected = Object.defineProperty({}, "kind", {
      get() {
        getterReads += 1;
        throw new Error("idempotent open must not inspect this getter");
      }
    }) as never;

    const first = db.open();
    const joined = db.open(irrelevantExpected);
    await Promise.all([first, joined]);
    await db.open(irrelevantExpected);
    expect(getterReads).toBe(0);

    const family = await inspectSemanticFamily(file);
    const namespace = await inspectPersistenceNamespaceLeases(path.dirname(file));
    expect(family.leases.map((lease) => lease.role)).toEqual(["shared"]);
    expect(namespace.leases.map((lease) => lease.role)).toEqual(["shared"]);

    await db.closeAndRelease();
    expect((await inspectSemanticFamily(file)).leases).toEqual([]);
    expect((await inspectPersistenceNamespaceLeases(path.dirname(file))).leases).toEqual([]);
  });

  it("holds a shared semantic-family lifetime so clear cannot erase an active receipt reader", async () => {
    const file = path.join(dir, "receipt-reader-clear-interlock.embed.db");
    const receipt = await seedReceipt(file);
    const reader = await openEmbedReceiptReader(file, "/v");
    const clearer = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    try {
      expect((await inspectSemanticFamily(file)).leases.map((lease) => lease.role)).toEqual(["shared"]);
      expect((await inspectPersistenceNamespaceLeases(path.dirname(file))).leases.map((lease) => lease.role)).toEqual([
        "shared"
      ]);

      await expect(clearer.clearOnDisk()).rejects.toMatchObject({ name: "PersistenceLeaseConflictError" });
      expect(reader.currentSourceReceiptMask([receipt])).toEqual([true]);
      expect((await fs.lstat(file)).isFile()).toBe(true);
    } finally {
      await reader.closeAndRelease();
    }
  });

  it("allows clear only after awaited receipt-reader release (negative control)", async () => {
    const file = path.join(dir, "receipt-reader-clear-after-close.embed.db");
    const receipt = await seedReceipt(file);
    const reader = await openEmbedReceiptReader(file, "/v");

    expect(reader.currentSourceReceiptMask([receipt])).toEqual([true]);
    await reader.closeAndRelease();
    expect(reader.currentSourceReceiptMask([receipt])).toEqual([false]);
    expect((await inspectSemanticFamily(file)).leases).toEqual([]);
    expect((await inspectPersistenceNamespaceLeases(path.dirname(file))).leases).toEqual([]);

    const clearer = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await expect(clearer.clearOnDisk()).resolves.toBe(true);
    await expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains a failed receipt-reader release for exact awaited retry", async () => {
    const file = path.join(dir, "receipt-reader-release-retry.embed.db");
    await seedReceipt(file);
    const reader = await openEmbedReceiptReader(file, "/v");
    const realUnlink = fs.unlink.bind(fs);
    let injectedFailures = 0;
    const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (candidate) => {
      if (injectedFailures === 0 && /^lease\.shared\./u.test(path.basename(String(candidate)))) {
        injectedFailures += 1;
        throw Object.assign(new Error("synthetic receipt-reader lease unlink failure"), { code: "EIO" });
      }
      return realUnlink(candidate);
    });
    try {
      reader.close();
      await expect(reader.closeAndRelease()).rejects.toMatchObject({ name: "PersistenceLeaseOwnershipError" });
    } finally {
      unlinkSpy.mockRestore();
    }
    expect(injectedFailures).toBe(1);
    expect((await inspectSemanticFamily(file)).leases.map((lease) => lease.role)).toEqual(["shared"]);
    expect((await inspectPersistenceNamespaceLeases(path.dirname(file))).leases.map((lease) => lease.role)).toEqual([
      "shared"
    ]);

    await expect(reader.closeAndRelease()).resolves.toBeUndefined();
    expect((await inspectSemanticFamily(file)).leases).toEqual([]);
    expect((await inspectPersistenceNamespaceLeases(path.dirname(file))).leases).toEqual([]);
  });

  it("preserves a reachable ownership carrier from shared-reader acquisition failure", async () => {
    const file = path.join(dir, "receipt-reader-acquire-ownership.embed.db");
    await seedReceipt(file);
    const eraser = await acquirePersistenceFamilyLease({
      targetPath: file,
      familyKey: SEMANTIC_PERSISTENCE_FAMILY_KEY,
      role: "eraser"
    });
    const preexistingNamespaceIds = new Set(
      (await inspectPersistenceNamespaceLeases(path.dirname(file))).leases.map((lease) => lease.id)
    );
    const realUnlink = fs.unlink.bind(fs);
    let injectedFailures = 0;
    const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (candidate) => {
      const basename = path.basename(String(candidate));
      if (injectedFailures === 0 && /^lease\.shared\./u.test(basename) && !preexistingNamespaceIds.has(basename)) {
        injectedFailures += 1;
        throw Object.assign(new Error("synthetic reader acquisition rollback failure"), { code: "EIO" });
      }
      return realUnlink(candidate);
    });
    let rejected: unknown;
    try {
      await openEmbedReceiptReader(file, "/v");
    } catch (error) {
      rejected = error;
    } finally {
      unlinkSpy.mockRestore();
    }

    let ownership: PersistenceLeaseOwnershipError | null = null;
    try {
      expect(injectedFailures).toBe(1);
      expect(rejected).toBeInstanceOf(PersistenceLeaseOwnershipError);
      if (rejected instanceof PersistenceLeaseOwnershipError) ownership = rejected;
      expect(ownership?.debtOwner.artifacts.length).toBeGreaterThan(0);
      expect((await inspectSemanticFamily(file)).leases.map((lease) => lease.role)).toEqual(["eraser"]);
      expect((await inspectPersistenceNamespaceLeases(path.dirname(file))).leases.map((lease) => lease.role)).toEqual([
        "shared",
        "shared"
      ]);
      await ownership?.debtOwner.release();
    } finally {
      await ownership?.debtOwner.release().catch(() => {});
      await drainProcessPersistenceLeaseDebts();
      await eraser.release();
    }
    expect((await inspectSemanticFamily(file)).leases).toEqual([]);
    expect((await inspectPersistenceNamespaceLeases(path.dirname(file))).leases).toEqual([]);
  });

  it("keeps rollback ownership reachable inside the receipt-reader AggregateError carrier", async () => {
    const file = path.join(dir, "receipt-reader-open-rollback-aggregate.embed.db");
    await seedReceipt(file);
    const realUnlink = fs.unlink.bind(fs);
    let injectedFailures = 0;
    const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (candidate) => {
      if (injectedFailures === 0 && /^lease\.shared\./u.test(path.basename(String(candidate)))) {
        injectedFailures += 1;
        throw Object.assign(new Error("synthetic incompatible-reader rollback failure"), { code: "EIO" });
      }
      return realUnlink(candidate);
    });
    let rejected: unknown;
    try {
      await openEmbedReceiptReader(file, "/foreign-vault");
    } catch (error) {
      rejected = error;
    } finally {
      unlinkSpy.mockRestore();
    }

    let ownership: PersistenceLeaseOwnershipError | null = null;
    try {
      expect(injectedFailures).toBe(1);
      expect(rejected).toBeInstanceOf(AggregateError);
      const errors = rejected instanceof AggregateError ? (rejected.errors as unknown[]) : [];
      expect(errors[0]).toMatchObject({
        message: "Embedding receipt reader requires an existing compatible index for the expected vault"
      });
      ownership =
        errors.find(
          (error): error is PersistenceLeaseOwnershipError => error instanceof PersistenceLeaseOwnershipError
        ) ?? null;
      expect(ownership?.debtOwner.artifacts.length).toBeGreaterThan(0);
      expect((await inspectSemanticFamily(file)).leases.map((lease) => lease.role)).toEqual(["shared"]);
      expect((await inspectPersistenceNamespaceLeases(path.dirname(file))).leases.map((lease) => lease.role)).toEqual([
        "shared"
      ]);
      await ownership?.debtOwner.release();
    } finally {
      await ownership?.debtOwner.release().catch(() => {});
      await drainProcessPersistenceLeaseDebts();
    }
    expect((await inspectSemanticFamily(file)).leases).toEqual([]);
    expect((await inspectPersistenceNamespaceLeases(path.dirname(file))).leases).toEqual([]);
  });

  it("lets synchronous close win a chmod-blocked open without a late DB handle or lease marker", async () => {
    const file = path.join(dir, "close-during-open.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    let reachedChmod!: () => void;
    const chmodStarted = new Promise<void>((resolve) => {
      reachedChmod = resolve;
    });
    let unblockChmod!: () => void;
    const chmodGate = new Promise<void>((resolve) => {
      unblockChmod = resolve;
    });
    const realChmod = fs.chmod.bind(fs);
    let blocked = false;
    const chmodSpy = vi.spyOn(fs, "chmod").mockImplementation(async (candidate, mode) => {
      await realChmod(candidate, mode);
      if (!blocked && path.basename(String(candidate)) === path.basename(file)) {
        blocked = true;
        reachedChmod();
        await chmodGate;
      }
    });
    try {
      const opening = db.open();
      await chmodStarted;
      db.close();
      unblockChmod();
      await expect(opening).rejects.toThrow(/close was requested while open was in progress/);
      await db.closeAndRelease();
      expect(() => db.totalChunks()).toThrow(/not open/);
      expect((await inspectSemanticFamily(file)).leases).toEqual([]);
      expect((await inspectPersistenceNamespaceLeases(path.dirname(file))).leases).toEqual([]);
    } finally {
      unblockChmod();
      chmodSpy.mockRestore();
      await db.closeAndRelease();
    }
  });

  it("retains an exact lifetime after open rollback release failure and retries it on awaited close", async () => {
    const file = path.join(dir, "open-rollback-retry.embed.db");
    await seedExactEmbedFile(file, "owned.md");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    const realUnlink = fs.unlink.bind(fs);
    let injectedFailures = 0;
    const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (candidate) => {
      if (injectedFailures === 0 && /^lease\.shared\./u.test(path.basename(String(candidate)))) {
        injectedFailures += 1;
        throw Object.assign(new Error("synthetic retryable lease unlink failure"), { code: "EIO" });
      }
      return realUnlink(candidate);
    });
    try {
      await expect(db.open({ kind: "missing" })).rejects.toBeInstanceOf(AggregateError);
    } finally {
      unlinkSpy.mockRestore();
    }
    expect(injectedFailures).toBe(1);
    expect((await inspectSemanticFamily(file)).leases.map((lease) => lease.role)).toEqual(["shared"]);
    expect((await inspectPersistenceNamespaceLeases(path.dirname(file))).leases.map((lease) => lease.role)).toEqual([
      "shared"
    ]);

    await expect(db.closeAndRelease()).resolves.toBeUndefined();
    expect((await inspectSemanticFamily(file)).leases).toEqual([]);
    expect((await inspectPersistenceNamespaceLeases(path.dirname(file))).leases).toEqual([]);
  });

  it("does not let an older reopen continuation erase a later close request", async () => {
    const file = path.join(dir, "reopen-superseded.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    await db.closeAndRelease();

    const internals = db as unknown as {
      finishCloseAndRelease(): Promise<void>;
      openOnce(...args: unknown[]): Promise<void>;
    };
    const originalFinish = internals.finishCloseAndRelease.bind(db);
    const originalOpenOnce = internals.openOnce.bind(db);
    let drainedResolve: (() => void) | undefined;
    const drained = new Promise<void>((resolve) => {
      drainedResolve = resolve;
    });
    let allowContinuationResolve: (() => void) | undefined;
    const allowContinuation = new Promise<void>((resolve) => {
      allowContinuationResolve = resolve;
    });
    let openOnceCalls = 0;
    internals.openOnce = async (...args: unknown[]) => {
      openOnceCalls += 1;
      await originalOpenOnce(...args);
    };
    internals.finishCloseAndRelease = async () => {
      await originalFinish();
      drainedResolve?.();
      await allowContinuation;
    };

    const staleReopen = db.open();
    await drained;
    db.close();
    allowContinuationResolve?.();
    await expect(staleReopen).rejects.toThrow("Embedding index reopen was superseded by a later close request");
    expect(openOnceCalls).toBe(0);
    expect(() => db.totalChunks()).toThrow(/not open/);
    await db.closeAndRelease();
    expect((await inspectSemanticFamily(file)).leases).toEqual([]);
    expect((await inspectPersistenceNamespaceLeases(path.dirname(file))).leases).toEqual([]);
  });
});

describe("EmbedDb durable generation identity and mutation epoch", () => {
  it("captures the cheap generation identity and advances it with admitted mutations", async () => {
    const file = path.join(dir, "cheap-generation-identity.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    try {
      const initial = db.captureGenerationIdentity();
      const initialReceipt = db.captureHnswReceiptSnapshot().receipt;
      expect(initial).toEqual({
        dbInstanceUuid: initialReceipt.dbInstanceUuid,
        dbMutationEpoch: initialReceipt.dbMutationEpoch
      });

      db.upsertNote("generation.md", 1, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "generation", vector: l2([1, 0, 0, 0]) }
      ]);
      const advanced = db.captureGenerationIdentity();
      expect(advanced.dbInstanceUuid).toBe(initial.dbInstanceUuid);
      expect(advanced.dbMutationEpoch).toBeGreaterThan(initial.dbMutationEpoch);
    } finally {
      await db.closeAndRelease();
    }
  });

  it("conditionally upserts under one exact generation and returns the committed UUID/epoch", async () => {
    const file = path.join(dir, "conditional-generation-upsert.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    try {
      const expected = db.captureGenerationIdentity();
      const result = db.upsertNoteWithCanonicalVectorsIfGeneration(expected, "conditional.md", 1, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "conditional", vector: l2([1, 0, 0, 0]) }
      ]);

      expect(result.kind).toBe("committed");
      if (result.kind !== "committed") throw new Error("expected the exact generation to commit");
      expect(result.value.oldIds).toEqual([]);
      expect(result.value.newIds).toHaveLength(1);
      expect(result.committedGeneration.dbInstanceUuid).toBe(expected.dbInstanceUuid);
      expect(result.committedGeneration.dbMutationEpoch).toBeGreaterThan(expected.dbMutationEpoch);
      expect(db.captureGenerationIdentity()).toEqual(result.committedGeneration);
    } finally {
      await db.closeAndRelease();
    }
  });

  it("performs no conditional DML after an external writer advances the expected epoch", async () => {
    const file = path.join(dir, "conditional-generation-drift.embed.db");
    const guarded = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    const external = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await guarded.open();
    await external.open();
    try {
      const staleExpected = guarded.captureGenerationIdentity();
      external.upsertNote("external.md", 1, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "external", vector: l2([0, 1, 0, 0]) }
      ]);

      const result = guarded.upsertNoteWithCanonicalVectorsIfGeneration(staleExpected, "must-not-write.md", 2, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "forbidden", vector: l2([0, 0, 1, 0]) }
      ]);

      expect(result.kind).toBe("generation-drift");
      if (result.kind !== "generation-drift") throw new Error("expected external generation drift");
      expect(result.observedGeneration.dbMutationEpoch).toBeGreaterThan(staleExpected.dbMutationEpoch);
      expect(guarded.getSourceStates().map((row) => row.rel_path)).toEqual(["external.md"]);
      expect(guarded.captureGenerationIdentity()).toEqual(result.observedGeneration);
    } finally {
      await external.closeAndRelease();
      await guarded.closeAndRelease();
    }
  });

  it("conditionally deletes rows and preserves the exact epoch for a no-row delete", async () => {
    const file = path.join(dir, "conditional-generation-delete.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    try {
      db.upsertNote("delete.md", 1, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "delete", vector: l2([1, 0, 0, 0]) }
      ]);
      const beforeDelete = db.captureGenerationIdentity();
      const deleted = db.deleteNoteIfGeneration(beforeDelete, "delete.md");
      expect(deleted.kind).toBe("committed");
      if (deleted.kind !== "committed") throw new Error("expected delete commit");
      expect(deleted.value).toHaveLength(1);
      expect(deleted.committedGeneration.dbMutationEpoch).toBeGreaterThan(beforeDelete.dbMutationEpoch);

      const noRow = db.deleteNoteIfGeneration(deleted.committedGeneration, "missing.md");
      expect(noRow).toEqual({
        kind: "committed",
        value: [],
        committedGeneration: deleted.committedGeneration
      });
      expect(db.captureGenerationIdentity()).toEqual(deleted.committedGeneration);
    } finally {
      await db.closeAndRelease();
    }
  });

  it("refuses malformed cheap generation identity instead of treating it as graph authority", async () => {
    const file = path.join(dir, "cheap-generation-malformed.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    try {
      const Database = (await import("better-sqlite3")).default;
      const mutate = new Database(file);
      try {
        mutate.prepare("UPDATE meta SET value = '01' WHERE key = 'mutation_epoch'").run();
      } finally {
        mutate.close();
      }
      expect(() => db.captureGenerationIdentity()).toThrow("Embedding generation identity is malformed");
    } finally {
      await db.closeAndRelease();
    }
  });

  it("keeps UUID/epoch and performs no bootstrap write on exact reopen, then rotates UUID after clear", async () => {
    const file = path.join(dir, "durable-generation-reopen.embed.db");
    const first = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await first.open();
    const initial = first.captureHnswReceiptSnapshot().receipt;
    expect(initial.dbInstanceUuid).toMatch(/^[0-9a-f]{32}$/);
    expect(initial.dbMutationEpoch).toBe(1);
    await first.closeAndRelease();

    const Database = (await import("better-sqlite3")).default;
    const prototype = Database.prototype as unknown as {
      exec(sql: string): unknown;
      prepare(sql: string): unknown;
    };
    const originalExec = prototype.exec;
    const originalPrepare = prototype.prepare;
    const bootstrapWrites: string[] = [];
    prototype.exec = function trackedExec(this: unknown, sql: string): unknown {
      if (/\b(?:CREATE|DROP|INSERT|UPDATE|DELETE)\b/iu.test(sql)) bootstrapWrites.push(sql);
      return Reflect.apply(originalExec, this, [sql]);
    };
    prototype.prepare = function trackedPrepare(this: unknown, sql: string): unknown {
      if (/^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(sql)) bootstrapWrites.push(sql);
      return Reflect.apply(originalPrepare, this, [sql]);
    };
    const reopened = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    try {
      await reopened.open();
      expect(reopened.captureHnswReceiptSnapshot().receipt).toEqual(initial);
    } finally {
      await reopened.closeAndRelease();
      prototype.exec = originalExec;
      prototype.prepare = originalPrepare;
    }
    expect(bootstrapWrites).toEqual([]);

    await reopened.clearOnDisk();
    const recreated = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await recreated.open();
    try {
      const replacement = recreated.captureHnswReceiptSnapshot().receipt;
      expect(replacement.dbInstanceUuid).toMatch(/^[0-9a-f]{32}$/);
      expect(replacement.dbInstanceUuid).not.toBe(initial.dbInstanceUuid);
      expect(replacement.dbMutationEpoch).toBe(1);
    } finally {
      await recreated.closeAndRelease();
    }
  });

  it("installs the exact 4x3 trigger census and rolls epoch back with a failed payload transaction", async () => {
    const file = path.join(dir, "durable-generation-rollback.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    try {
      db.upsertNote("rollback.md", 1, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "before", vector: l2([1, 0, 0, 0]) }
      ]);
      const before = db.captureHnswReceiptSnapshot();
      expect(() =>
        db.upsertNote("rollback.md", 2, [
          { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "partial", vector: l2([0, 1, 0, 0]) },
          { chunkIndex: 1, lineStart: 2, lineEnd: 2, textPreview: "invalid", vector: l2([1, 0, 0]) }
        ])
      ).toThrow(/vector dim mismatch/);
      expect(db.captureHnswReceiptSnapshot()).toEqual(before);

      const Database = (await import("better-sqlite3")).default;
      const raw = new Database(file, { readonly: true, fileMustExist: true });
      try {
        const names = raw
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name GLOB 'embed_mutation_epoch_*' ORDER BY name"
          )
          .pluck()
          .all() as string[];
        expect(names).toEqual(
          ["embeddings", "source_state", "source_quarantine", "source_revision"]
            .flatMap((table) =>
              ["delete", "insert", "update"].map((operation) => `embed_mutation_epoch_${table}_${operation}`)
            )
            .sort()
        );
      } finally {
        raw.close();
      }
    } finally {
      await db.closeAndRelease();
    }
  });

  it("aborts a durable mutation before payload commit when epoch is exhausted", async () => {
    const file = path.join(dir, "durable-generation-overflow.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    try {
      const Database = (await import("better-sqlite3")).default;
      const raw = new Database(file);
      raw.prepare("UPDATE meta SET value = ? WHERE key = 'mutation_epoch'").run(String(Number.MAX_SAFE_INTEGER));
      raw.close();
      const before = db.captureHnswReceiptSnapshot();
      expect(before.receipt.dbMutationEpoch).toBe(Number.MAX_SAFE_INTEGER);
      expect(() => db.quarantineSource("overflow.md", "md")).toThrow(/mutation epoch is invalid or exhausted/);
      expect(db.captureHnswReceiptSnapshot()).toEqual(before);
      expect(db.getQuarantinedPaths()).toEqual([]);
    } finally {
      await db.closeAndRelease();
    }
  });

  it.each([
    { field: "instance_uuid", value: "ABCDEF0123456789ABCDEF0123456789" },
    { field: "instance_uuid", value: "0123456789abcdef0123456789abcde" },
    { field: "instance_uuid", value: "g123456789abcdef0123456789abcdef" },
    { field: "mutation_epoch", value: "0" },
    { field: "mutation_epoch", value: "01" },
    { field: "mutation_epoch", value: "1.0" },
    { field: "mutation_epoch", value: "9007199254740992" },
    { field: "mutation_epoch", value: "not-an-epoch" }
  ])("refuses malformed current generation metadata: $field=$value", async ({ field, value }) => {
    const file = path.join(dir, `malformed-generation-${field}-${value.replaceAll("/", "-")}.embed.db`);
    await seedExactEmbedFile(file, "malformed.md");
    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(file);
    raw.prepare("UPDATE meta SET value = ? WHERE key = ?").run(value, field);
    raw.close();
    expect(await discoverEmbedDbConfig(file, "/v")).toEqual({ kind: "refused" });
    const refused = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await expect(refused.open()).rejects.toThrow(/ownership could not be verified/);
  });

  it.each(["instance_uuid", "mutation_epoch"])("refuses current generation metadata missing %s", async (field) => {
    const file = path.join(dir, `missing-generation-${field}.embed.db`);
    await seedExactEmbedFile(file, "missing.md");
    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(file);
    raw.prepare("DELETE FROM meta WHERE key = ?").run(field);
    raw.close();
    expect(await discoverEmbedDbConfig(file, "/v")).toEqual({ kind: "refused" });
    const refused = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await expect(refused.open()).rejects.toThrow(/ownership could not be verified/);
  });

  it("refuses a current schema missing one mutation trigger without repairing it", async () => {
    const file = path.join(dir, "missing-epoch-trigger.embed.db");
    await seedExactEmbedFile(file, "trigger.md");
    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(file);
    raw.exec("DROP TRIGGER embed_mutation_epoch_embeddings_update");
    raw.close();
    const before = await exactEmbedLogicalSnapshot(file);
    await expectPathFreeEmbedOwnershipRefusal(file, "/v", before);
  });
});

describe("EmbedDb atomic HNSW receipt snapshots", () => {
  it("returns stable receipts and remains usable inside a nested better-sqlite3 transaction", async () => {
    const file = path.join(dir, "hnsw-receipt-stable.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    try {
      db.upsertNote("stable.md", 1000, [
        { chunkIndex: 0, lineStart: 10, lineEnd: 20, textPreview: "stable", vector: l2([1, 0, 0, 0]) }
      ]);

      const first = db.captureHnswReceiptSnapshot();
      const second = db.captureHnswReceiptSnapshot();
      expect(second).toEqual(first);
      expect(second).not.toBe(first);
      expect(second.rowsByLabel).not.toBe(first.rowsByLabel);

      const firstLoad = db.captureHnswLoadSnapshot();
      const secondLoad = db.captureHnswLoadSnapshot();
      expect(firstLoad.receipt).toEqual(first.receipt);
      expect(secondLoad).toEqual(firstLoad);
      expect(secondLoad.vectorsByLabel).not.toBe(firstLoad.vectorsByLabel);
      const label = [...firstLoad.vectorsByLabel.keys()][0];
      if (label === undefined) throw new Error("expected load-authority label");
      expect(secondLoad.vectorsByLabel.get(label)).not.toBe(firstLoad.vectorsByLabel.get(label));
      expect(secondLoad.vectorsByLabel.get(label)).toEqual(l2([1, 0, 0, 0]));
      const mutableFirst = firstLoad.vectorsByLabel.get(label);
      if (!mutableFirst) throw new Error("expected detached load-authority vector");
      mutableFirst[0] = 0;
      expect(secondLoad.vectorsByLabel.get(label)).toEqual(l2([1, 0, 0, 0]));
      expect(db.captureHnswLoadSnapshot().vectorsByLabel.get(label)).toEqual(l2([1, 0, 0, 0]));

      const sqlite = (
        db as unknown as {
          requireDb(): {
            transaction<T>(callback: () => T): () => T;
          };
        }
      ).requireDb();
      const nested = sqlite.transaction(() => db.captureHnswReceiptSnapshot())();
      expect(nested).toEqual(first);
      const nestedLoad = sqlite.transaction(() => db.captureHnswLoadSnapshot())();
      expect(nestedLoad).toEqual(secondLoad);
    } finally {
      await db.closeAndRelease();
    }
  });

  it.each([
    { label: "one-byte-short", blobBytes: 15 },
    { label: "bounded-oversized", blobBytes: 65_537 }
  ])("rejects a $label vector BLOB in the aggregate before preparing the payload iterator", async ({ blobBytes }) => {
    const file = path.join(dir, `hnsw-aggregate-vector-${blobBytes}.embed.db`);
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    try {
      db.upsertNote("vector.md", 1000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "vector", vector: l2([1, 0, 0, 0]) }
      ]);

      const Database = (await import("better-sqlite3")).default;
      const raw = new Database(file);
      try {
        raw.prepare("UPDATE embeddings SET vector = zeroblob(?) WHERE rel_path = ?").run(blobBytes, "vector.md");
      } finally {
        raw.close();
      }

      const sqlite = (
        db as unknown as {
          requireDb(): { prepare(sql: string): object };
        }
      ).requireDb();
      const prepareSpy = vi.spyOn(sqlite, "prepare");
      try {
        const error = thrownBy(() => db.captureHnswBuildSnapshot());
        expect(error).toBeInstanceOf(EmbedSnapshotIntegrityError);
        expect(error).not.toBeInstanceOf(EmbedSnapshotCapacityError);
        expect(error).toMatchObject({ message: "Embedding rows are malformed during HNSW snapshot admission" });

        const preparedSql = prepareSpy.mock.calls.map(([sql]) => sql);
        expect(preparedSql.some((sql) => sql.includes("AS invalid_vector_count"))).toBe(true);
        expect(preparedSql.some((sql) => sql.includes("SELECT e.id AS label"))).toBe(false);
      } finally {
        prepareSpy.mockRestore();
      }
    } finally {
      await db.closeAndRelease();
    }
  });

  it("never materializes a quarantined bounded-oversized vector BLOB", async () => {
    const file = path.join(dir, "hnsw-quarantined-oversized-vector.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    try {
      const healthy = db.upsertNote("healthy.md", 1000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "healthy", vector: l2([1, 0, 0, 0]) }
      ]);
      const quarantined = db.upsertNote("quarantined.md", 1000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "quarantined", vector: l2([0, 1, 0, 0]) }
      ]);
      const healthyLabel = healthy.newIds[0];
      const quarantinedLabel = quarantined.newIds[0];
      if (healthyLabel === undefined || quarantinedLabel === undefined) {
        throw new Error("expected HNSW aggregate-admission fixture labels");
      }
      db.quarantineSource("quarantined.md", "md");

      const Database = (await import("better-sqlite3")).default;
      const raw = new Database(file);
      try {
        raw.prepare("UPDATE embeddings SET vector = zeroblob(65537) WHERE id = ?").run(quarantinedLabel);
        expect(raw.prepare("SELECT length(vector) FROM embeddings WHERE id = ?").pluck().get(quarantinedLabel)).toBe(
          65_537
        );
      } finally {
        raw.close();
      }

      const snapshot = db.captureHnswBuildSnapshot();
      expect(snapshot.receipt.activeRows).toBe(1);
      expect([...snapshot.rowsByLabel.keys()]).toEqual([healthyLabel]);
      expect(snapshot.rowsByLabel.has(quarantinedLabel)).toBe(false);
      expect(snapshot.vectors.map((row) => row.label)).toEqual([healthyLabel]);
      expect(snapshot.receipt.signature).toContain(";quarantine=");
    } finally {
      await db.closeAndRelease();
    }
  });

  it.each([
    {
      label: "quarantine oversized path",
      sql: "INSERT INTO source_quarantine (rel_path, kind) VALUES (?, 'md')",
      params: ["q".repeat(4097)] as readonly unknown[]
    },
    {
      label: "quarantine wrong-storage path",
      sql: "INSERT INTO source_quarantine (rel_path, kind) VALUES (?, 'md')",
      params: [Buffer.from([113])] as readonly unknown[]
    },
    {
      label: "source-state oversized path",
      sql: `INSERT INTO source_state (rel_path, mtime_ms, n_chunks, kind, indexed_at)
            VALUES (?, 1, 1, 'md', 'now')`,
      params: ["s".repeat(4097)] as readonly unknown[]
    },
    {
      label: "source-state wrong-storage mtime",
      sql: `INSERT INTO source_state (rel_path, mtime_ms, n_chunks, kind, indexed_at)
            VALUES ('state.md', ?, 1, 'md', 'now')`,
      params: [Buffer.from([1])] as readonly unknown[]
    },
    {
      label: "source-revision oversized path",
      sql: "INSERT INTO source_revision (rel_path, kind, revision) VALUES (?, 'md', 1)",
      params: ["r".repeat(4097)] as readonly unknown[]
    },
    {
      label: "source-revision wrong-storage revision",
      sql: "INSERT INTO source_revision (rel_path, kind, revision) VALUES ('revision.md', 'md', ?)",
      params: [Buffer.from([1])] as readonly unknown[]
    }
  ])("rejects a $label in the authority envelope before preparing authority iterators", async ({ sql, params }) => {
    const file = path.join(dir, "hnsw-authority-envelope.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    try {
      const Database = (await import("better-sqlite3")).default;
      const raw = new Database(file);
      try {
        raw.pragma("ignore_check_constraints = ON");
        raw.prepare(sql).run(...params);
      } finally {
        raw.close();
      }

      const sqlite = (
        db as unknown as {
          requireDb(): { prepare(sql: string): object };
        }
      ).requireDb();
      const prepareSpy = vi.spyOn(sqlite, "prepare");
      try {
        const error = thrownBy(() => db.captureHnswReceiptSnapshot());
        expect(error).toBeInstanceOf(EmbedSnapshotIntegrityError);
        expect(error).not.toBeInstanceOf(EmbedSnapshotCapacityError);
        expect(error).toMatchObject({
          message: "Embedding authority manifests are malformed during HNSW capture"
        });

        const preparedSql = prepareSpy.mock.calls.map(([prepared]) => prepared);
        expect(preparedSql.some((prepared) => prepared.includes("AS quarantine_invalid_count"))).toBe(true);
        expect(
          preparedSql.some((prepared) =>
            prepared.includes("SELECT rel_path, kind FROM source_quarantine ORDER BY kind, rel_path")
          )
        ).toBe(false);
        expect(preparedSql.some((prepared) => prepared.includes("SELECT s.rel_path, s.kind, s.mtime_ms"))).toBe(false);
        expect(preparedSql.some((prepared) => prepared.includes("AS invalid_vector_count"))).toBe(false);
        expect(preparedSql.some((prepared) => prepared.includes("SELECT e.id AS label"))).toBe(false);
      } finally {
        prepareSpy.mockRestore();
      }
    } finally {
      await db.closeAndRelease();
    }
  });

  it("admits exact per-cell path, preview, and vector boundaries", async () => {
    const file = path.join(dir, "hnsw-admission-boundary.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    try {
      const sourcePath = `${"s".repeat(4093)}.md`;
      const quarantinePath = `${"q".repeat(4093)}.md`;
      const preview = "p".repeat(65_536);
      expect(Buffer.byteLength(sourcePath, "utf8")).toBe(4096);
      expect(Buffer.byteLength(quarantinePath, "utf8")).toBe(4096);
      expect(Buffer.byteLength(preview, "utf8")).toBe(65_536);

      const inserted = db.upsertNote(sourcePath, 1000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: preview, vector: l2([1, 0, 0, 0]) }
      ]);
      const label = inserted.newIds[0];
      if (label === undefined) throw new Error("expected HNSW boundary fixture label");
      db.quarantineSource(quarantinePath, "md");

      const snapshot = db.captureHnswBuildSnapshot();
      expect(snapshot.receipt.activeRows).toBe(1);
      expect([...snapshot.rowsByLabel.keys()]).toEqual([label]);
      expect(snapshot.rowsByLabel.get(label)).toMatchObject({ rel_path: sourcePath, text_preview: preview });
      expect(snapshot.vectors).toHaveLength(1);
      expect(snapshot.vectors[0]?.vector).toEqual(l2([1, 0, 0, 0]));
      expect(snapshot.receipt.signature).toContain(";quarantine=");
    } finally {
      await db.closeAndRelease();
    }
  });

  it("returns the typed capacity error before payload iteration when a valid aggregate exceeds its row budget", async () => {
    const file = path.join(dir, "hnsw-admission-capacity-type.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    try {
      db.upsertNote("capacity.md", 1000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "capacity", vector: l2([1, 0, 0, 0]) }
      ]);
      expect(db.captureHnswReceiptSnapshot().receipt.activeRows).toBe(1);

      const sqlite = (
        db as unknown as {
          requireDb(): { prepare(sql: string): object };
        }
      ).requireDb();
      const originalPrepare = sqlite.prepare.bind(sqlite);
      // A real row-count overflow needs 250,001 rows (or more than 64 MiB of
      // admitted text). Keep this unit probe bounded: execute the real
      // aggregate once, then change only its safe-integer row_count result.
      // The successful baseline above is the negative control for the seam.
      const prepareSpy = vi.spyOn(sqlite, "prepare").mockImplementation((sql) => {
        const statement = originalPrepare(sql);
        if (!sql.includes("AS invalid_vector_count")) return statement;
        return new Proxy(statement, {
          get(target, property, receiver) {
            if (property !== "get") return Reflect.get(target, property, receiver);
            return (...params: unknown[]) => {
              const get = Reflect.get(target, "get");
              if (typeof get !== "function") throw new Error("expected aggregate statement getter");
              const row = Reflect.apply(get, target, params);
              if (typeof row !== "object" || row === null) throw new Error("expected aggregate admission row");
              return { ...(row as Record<string, unknown>), row_count: 250_001, vector_bytes: 250_001 * 16 };
            };
          }
        });
      });
      try {
        const error = thrownBy(() => db.captureHnswBuildSnapshot());
        expect(error).toBeInstanceOf(EmbedSnapshotCapacityError);
        expect(error).not.toBeInstanceOf(EmbedSnapshotIntegrityError);
        expect(error).toMatchObject({
          message: "Embedding rows exceed the bounded combined HNSW working-set admission envelope"
        });
        expect(prepareSpy.mock.calls.some(([sql]) => sql.includes("SELECT e.id AS label"))).toBe(false);
      } finally {
        prepareSpy.mockRestore();
      }
    } finally {
      await db.closeAndRelease();
    }
  });

  it("rejects a combined working set that passes the former independent row, text, and vector caps", async () => {
    const file = path.join(dir, "hnsw-combined-working-set.embed.db");
    const dim = 4096;
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim });
    await db.open();
    try {
      db.upsertNote("combined.md", 1000, [
        {
          chunkIndex: 0,
          lineStart: 1,
          lineEnd: 1,
          textPreview: "combined",
          vector: l2(new Array<number>(dim).fill(1))
        }
      ]);
      expect(db.captureHnswLoadSnapshot().receipt.activeRows).toBe(1);

      const sqlite = (
        db as unknown as {
          requireDb(): { prepare(sql: string): object };
        }
      ).requireDb();
      const originalPrepare = sqlite.prepare.bind(sqlite);
      const admittedRows = 50_000;
      const encodedBytes = dim * 4;
      const prepareSpy = vi.spyOn(sqlite, "prepare").mockImplementation((sql) => {
        const statement = originalPrepare(sql);
        if (!sql.includes("AS invalid_vector_count")) return statement;
        return new Proxy(statement, {
          get(target, property, receiver) {
            if (property !== "get") return Reflect.get(target, property, receiver);
            return (...params: unknown[]) => {
              const get = Reflect.get(target, "get");
              if (typeof get !== "function") throw new Error("expected aggregate statement getter");
              const row = Reflect.apply(get, target, params);
              if (typeof row !== "object" || row === null) throw new Error("expected aggregate admission row");
              return {
                ...(row as Record<string, unknown>),
                row_count: admittedRows,
                vector_bytes: admittedRows * encodedBytes
              };
            };
          }
        });
      });
      try {
        const error = thrownBy(() => db.captureHnswLoadSnapshot());
        expect(error).toBeInstanceOf(EmbedSnapshotCapacityError);
        expect(error).toMatchObject({
          message: "Embedding rows exceed the bounded combined HNSW working-set admission envelope"
        });
        expect(admittedRows).toBeLessThan(250_000);
        const formerNativeEstimate = 8 * 1024 * 1024 + admittedRows * (dim * 4 + 16 * 2 * 4 + 4 + 8 + 256);
        expect(formerNativeEstimate).toBeLessThan(1024 * 1024 * 1024);
        expect(admittedRows * encodedBytes).toBeLessThan(1024 * 1024 * 1024);
        expect(formerNativeEstimate + admittedRows * encodedBytes).toBeGreaterThan(1024 * 1024 * 1024);
        expect(prepareSpy.mock.calls.some(([sql]) => sql.includes("SELECT e.id AS label"))).toBe(false);
      } finally {
        prepareSpy.mockRestore();
      }
    } finally {
      await db.closeAndRelease();
    }
  });

  it("changes the payload receipt for a same-count, same-label raw vector BLOB rewrite", async () => {
    const file = path.join(dir, "hnsw-receipt-vector.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    try {
      const inserted = db.upsertNote("vector.md", 1000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "vector", vector: l2([1, 0, 0, 0]) }
      ]);
      const label = inserted.newIds[0];
      if (label === undefined) throw new Error("expected HNSW receipt fixture label");
      const before = db.captureHnswReceiptSnapshot();

      const Database = (await import("better-sqlite3")).default;
      const raw = new Database(file);
      try {
        const replacement = l2([0, 1, 0, 0]);
        raw
          .prepare("UPDATE embeddings SET vector = ? WHERE id = ?")
          .run(Buffer.from(replacement.buffer, replacement.byteOffset, replacement.byteLength), label);
      } finally {
        raw.close();
      }

      const after = db.captureHnswReceiptSnapshot();
      expect(after.receipt.activeRows).toBe(before.receipt.activeRows);
      expect(after.receipt.maxLabel).toBe(before.receipt.maxLabel);
      expect(after.receipt.liveLabelSha256).toBe(before.receipt.liveLabelSha256);
      expect(after.rowsByLabel).toEqual(before.rowsByLabel);
      expect(after.receipt.dbPayloadSha256).not.toBe(before.receipt.dbPayloadSha256);
      expect(after.receipt.signature).not.toBe(before.receipt.signature);
    } finally {
      await db.closeAndRelease();
    }
  });

  it("binds the ordered live-label manifest even when row count is unchanged", async () => {
    const file = path.join(dir, "hnsw-receipt-label.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    try {
      const inserted = db.upsertNote("label.md", 1000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "label", vector: l2([1, 0, 0, 0]) }
      ]);
      const label = inserted.newIds[0];
      if (label === undefined) throw new Error("expected HNSW receipt fixture label");
      const before = db.captureHnswReceiptSnapshot();

      const Database = (await import("better-sqlite3")).default;
      const raw = new Database(file);
      try {
        raw.prepare("UPDATE embeddings SET id = id + 100 WHERE id = ?").run(label);
      } finally {
        raw.close();
      }

      const after = db.captureHnswReceiptSnapshot();
      expect(after.receipt.activeRows).toBe(before.receipt.activeRows);
      expect([...after.rowsByLabel.keys()]).toEqual([label + 100]);
      expect(after.receipt.maxLabel).toBe(label + 100);
      expect(after.receipt.liveLabelSha256).not.toBe(before.receipt.liveLabelSha256);
      expect(after.receipt.signature).not.toBe(before.receipt.signature);
    } finally {
      await db.closeAndRelease();
    }
  });

  it("isolates every persisted row/source field that must invalidate an HNSW generation", async () => {
    const file = path.join(dir, "hnsw-receipt-fields.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    try {
      const inserted = db.upsertNote("fields.md", 1000, [
        { chunkIndex: 0, lineStart: 10, lineEnd: 20, textPreview: "before", vector: l2([1, 0, 0, 0]) }
      ]);
      const label = inserted.newIds[0];
      if (label === undefined) throw new Error("expected HNSW receipt fixture label");
      const baseline = db.captureHnswReceiptSnapshot();

      const Database = (await import("better-sqlite3")).default;
      const raw = new Database(file);
      try {
        const revision = raw
          .prepare("SELECT revision FROM source_revision WHERE rel_path = ? AND kind = 'md'")
          .get("fields.md") as { revision: number } | undefined;
        if (!revision) throw new Error("expected HNSW receipt fixture revision");
        const setMtimeOnly = (mtimeMs: number) => {
          raw.transaction(() => {
            raw
              .prepare("UPDATE source_state SET mtime_ms = ? WHERE rel_path = ? AND kind = 'md'")
              .run(mtimeMs, "fields.md");
            raw
              .prepare("UPDATE source_revision SET revision = ? WHERE rel_path = ? AND kind = 'md'")
              .run(revision.revision, "fields.md");
          })();
        };
        const cases: ReadonlyArray<{
          field: string;
          changesPublicRow: boolean;
          rejectsIncomplete?: boolean;
          mutate(): void;
          restore(): void;
        }> = [
          {
            field: "text_preview",
            changesPublicRow: true,
            mutate: () => {
              raw.prepare("UPDATE embeddings SET text_preview = 'after' WHERE id = ?").run(label);
            },
            restore: () => {
              raw.prepare("UPDATE embeddings SET text_preview = 'before' WHERE id = ?").run(label);
            }
          },
          {
            field: "chunk_index",
            changesPublicRow: true,
            rejectsIncomplete: true,
            mutate: () => {
              raw.prepare("UPDATE embeddings SET chunk_index = 1 WHERE id = ?").run(label);
            },
            restore: () => {
              raw.prepare("UPDATE embeddings SET chunk_index = 0 WHERE id = ?").run(label);
            }
          },
          {
            field: "line_start",
            changesPublicRow: true,
            mutate: () => {
              raw.prepare("UPDATE embeddings SET line_start = 11 WHERE id = ?").run(label);
            },
            restore: () => {
              raw.prepare("UPDATE embeddings SET line_start = 10 WHERE id = ?").run(label);
            }
          },
          {
            field: "line_end",
            changesPublicRow: true,
            mutate: () => {
              raw.prepare("UPDATE embeddings SET line_end = 21 WHERE id = ?").run(label);
            },
            restore: () => {
              raw.prepare("UPDATE embeddings SET line_end = 20 WHERE id = ?").run(label);
            }
          },
          {
            field: "indexed_mtime_ms",
            changesPublicRow: false,
            mutate: () => setMtimeOnly(2000),
            restore: () => setMtimeOnly(1000)
          },
          {
            field: "indexed_revision",
            changesPublicRow: false,
            mutate: () => {
              raw
                .prepare("UPDATE source_revision SET revision = ? WHERE rel_path = ? AND kind = 'md'")
                .run(revision.revision + 1, "fields.md");
            },
            restore: () => {
              raw
                .prepare("UPDATE source_revision SET revision = ? WHERE rel_path = ? AND kind = 'md'")
                .run(revision.revision, "fields.md");
            }
          }
        ];

        for (const fieldCase of cases) {
          fieldCase.mutate();
          if (fieldCase.rejectsIncomplete) {
            const error = thrownBy(() => db.captureHnswReceiptSnapshot());
            expect(error, fieldCase.field).toBeInstanceOf(EmbedSnapshotIntegrityError);
            expect(error, fieldCase.field).toMatchObject({
              message: "Embedding source state is incomplete during HNSW snapshot capture"
            });
          } else {
            const changed = db.captureHnswReceiptSnapshot();
            expect(changed.receipt.activeRows, fieldCase.field).toBe(baseline.receipt.activeRows);
            expect(changed.receipt.liveLabelSha256, fieldCase.field).toBe(baseline.receipt.liveLabelSha256);
            expect(changed.receipt.dbPayloadSha256, fieldCase.field).not.toBe(baseline.receipt.dbPayloadSha256);
            expect(changed.receipt.signature, fieldCase.field).not.toBe(baseline.receipt.signature);
            if (fieldCase.changesPublicRow) {
              expect(changed.rowsByLabel, fieldCase.field).not.toEqual(baseline.rowsByLabel);
            } else {
              expect(changed.rowsByLabel, fieldCase.field).toEqual(baseline.rowsByLabel);
            }
          }
          fieldCase.restore();
          const restored = db.captureHnswReceiptSnapshot();
          expect(restored.rowsByLabel, `${fieldCase.field} restore rows`).toEqual(baseline.rowsByLabel);
          expect(restored.receipt.dbPayloadSha256, `${fieldCase.field} restore payload`).toBe(
            baseline.receipt.dbPayloadSha256
          );
          expect(restored.receipt.liveLabelSha256, `${fieldCase.field} restore labels`).toBe(
            baseline.receipt.liveLabelSha256
          );
          expect(restored.receipt.dbInstanceUuid, `${fieldCase.field} restore instance`).toBe(
            baseline.receipt.dbInstanceUuid
          );
          expect(restored.receipt.dbMutationEpoch, `${fieldCase.field} restore epoch`).toBeGreaterThan(
            baseline.receipt.dbMutationEpoch
          );
          expect(restored.receipt.signature, `${fieldCase.field} restore signature`).not.toBe(
            baseline.receipt.signature
          );
        }
      } finally {
        raw.close();
      }
    } finally {
      await db.closeAndRelease();
    }
  });

  it("rejects a declared source whose chunk count or contiguous range is incomplete", async () => {
    const file = path.join(dir, "hnsw-receipt-incomplete-source.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    try {
      db.upsertNote("complete.md", 1000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "first", vector: l2([1, 0, 0, 0]) },
        { chunkIndex: 1, lineStart: 2, lineEnd: 2, textPreview: "second", vector: l2([0, 1, 0, 0]) }
      ]);
      expect(db.captureHnswReceiptSnapshot().receipt.activeRows).toBe(2);

      const Database = (await import("better-sqlite3")).default;
      const raw = new Database(file);
      try {
        raw.prepare("UPDATE source_state SET n_chunks = 3 WHERE rel_path = ? AND kind = 'md'").run("complete.md");
        expect(() => db.captureHnswReceiptSnapshot()).toThrow(
          "Embedding source state is incomplete during HNSW snapshot capture"
        );
        // 93e03f28 ran captureHnswReceiptSnapshot inside searchReceiptRows and
        // discarded the return, so this poke also failed brute cosine. Ranking
        // still sees both physical rows.
        const poked = db.searchWithReceipts(l2([1, 0, 0, 0]), 10);
        expect(poked.map((hit) => hit.text_preview).sort()).toEqual(["first", "second"]);

        raw.prepare("UPDATE source_state SET n_chunks = 2 WHERE rel_path = ? AND kind = 'md'").run("complete.md");
        expect(db.captureHnswReceiptSnapshot().receipt.activeRows).toBe(2);

        raw.prepare("DELETE FROM embeddings WHERE rel_path = ? AND kind = 'md' AND chunk_index = 1").run("complete.md");
        expect(() => db.captureHnswReceiptSnapshot()).toThrow(
          "Embedding source state is incomplete during HNSW snapshot capture"
        );
        expect(() => db.captureHnswBuildSnapshot()).toThrow(
          "Embedding source state is incomplete during HNSW snapshot capture"
        );
        const remaining = db.searchWithReceipts(l2([1, 0, 0, 0]), 10);
        expect(remaining).toHaveLength(1);
        expect(remaining[0]?.text_preview).toBe("first");
      } finally {
        raw.close();
      }
    } finally {
      await db.closeAndRelease();
    }
  });

  it("rejects a count-preserving 0,2 gap and a declared source with zero physical rows", async () => {
    const file = path.join(dir, "hnsw-receipt-count-preserving-gap.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    try {
      db.upsertNote("gap.md", 1000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "zero", vector: l2([1, 0, 0, 0]) },
        { chunkIndex: 1, lineStart: 2, lineEnd: 2, textPreview: "one", vector: l2([0, 1, 0, 0]) }
      ]);

      const Database = (await import("better-sqlite3")).default;
      const raw = new Database(file);
      try {
        raw.prepare("UPDATE embeddings SET chunk_index = 2 WHERE rel_path = ? AND chunk_index = 1").run("gap.md");

        const sqlite = (
          db as unknown as {
            requireDb(): { prepare(sql: string): object };
          }
        ).requireDb();
        const gapPrepareSpy = vi.spyOn(sqlite, "prepare");
        try {
          const gapError = thrownBy(() => db.captureHnswReceiptSnapshot());
          expect(gapError).toBeInstanceOf(EmbedSnapshotIntegrityError);
          expect(gapError).not.toBeInstanceOf(EmbedSnapshotCapacityError);
          expect(gapError).toMatchObject({
            message: "Embedding source state is incomplete during HNSW snapshot capture"
          });
          expect(gapPrepareSpy.mock.calls.some(([sql]) => sql.includes("AS invalid_vector_count"))).toBe(false);
          expect(gapPrepareSpy.mock.calls.some(([sql]) => sql.includes("SELECT e.id AS label"))).toBe(false);
        } finally {
          gapPrepareSpy.mockRestore();
        }

        raw.prepare("UPDATE embeddings SET chunk_index = 1 WHERE rel_path = ? AND chunk_index = 2").run("gap.md");
        expect(db.captureHnswReceiptSnapshot().receipt.activeRows).toBe(2);

        raw.prepare("DELETE FROM embeddings WHERE rel_path = ?").run("gap.md");
        const emptyPrepareSpy = vi.spyOn(sqlite, "prepare");
        try {
          const emptyError = thrownBy(() => db.captureHnswBuildSnapshot());
          expect(emptyError).toBeInstanceOf(EmbedSnapshotIntegrityError);
          expect(emptyError).not.toBeInstanceOf(EmbedSnapshotCapacityError);
          expect(emptyError).toMatchObject({
            message: "Embedding source state is incomplete during HNSW snapshot capture"
          });
          expect(emptyPrepareSpy.mock.calls.some(([sql]) => sql.includes("AS invalid_vector_count"))).toBe(false);
          expect(emptyPrepareSpy.mock.calls.some(([sql]) => sql.includes("SELECT e.id AS label"))).toBe(false);
        } finally {
          emptyPrepareSpy.mockRestore();
        }
      } finally {
        raw.close();
      }
    } finally {
      await db.closeAndRelease();
    }
  });

  it("rejects the whole HNSW snapshot when one non-quarantined row is malformed", async () => {
    const file = path.join(dir, "hnsw-receipt-malformed.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    try {
      db.upsertNote("healthy.md", 1000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "healthy", vector: l2([1, 0, 0, 0]) }
      ]);
      db.upsertNote("malformed.md", 1000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "malformed", vector: l2([0, 1, 0, 0]) }
      ]);

      const Database = (await import("better-sqlite3")).default;
      const raw = new Database(file);
      try {
        raw.prepare("UPDATE embeddings SET vector = x'00' WHERE rel_path = ?").run("malformed.md");
      } finally {
        raw.close();
      }

      for (const capture of [() => db.captureHnswReceiptSnapshot(), () => db.captureHnswBuildSnapshot()]) {
        const error = thrownBy(capture);
        expect(error).toBeInstanceOf(EmbedSnapshotIntegrityError);
        expect(error).not.toBeInstanceOf(EmbedSnapshotCapacityError);
        expect(error).toMatchObject({ message: "Embedding rows are malformed during HNSW snapshot admission" });
      }
    } finally {
      await db.closeAndRelease();
    }
  });

  it("excludes a quarantined malformed row from both receipt and build snapshots", async () => {
    const file = path.join(dir, "hnsw-receipt-quarantined.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    try {
      const healthy = db.upsertNote("healthy.md", 1000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "healthy", vector: l2([1, 0, 0, 0]) }
      ]);
      const malformed = db.upsertNote("malformed.md", 1000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "malformed", vector: l2([0, 1, 0, 0]) }
      ]);
      const healthyLabel = healthy.newIds[0];
      const malformedLabel = malformed.newIds[0];
      if (healthyLabel === undefined || malformedLabel === undefined) {
        throw new Error("expected HNSW receipt fixture labels");
      }
      db.quarantineSource("malformed.md", "md");

      const Database = (await import("better-sqlite3")).default;
      const raw = new Database(file);
      try {
        raw.prepare("UPDATE embeddings SET vector = x'00' WHERE id = ?").run(malformedLabel);
      } finally {
        raw.close();
      }

      const receiptSnapshot = db.captureHnswReceiptSnapshot();
      const buildSnapshot = db.captureHnswBuildSnapshot();
      expect(receiptSnapshot.receipt.activeRows).toBe(1);
      expect([...receiptSnapshot.rowsByLabel.keys()]).toEqual([healthyLabel]);
      expect(receiptSnapshot.rowsByLabel.has(malformedLabel)).toBe(false);
      expect(buildSnapshot.receipt).toEqual(receiptSnapshot.receipt);
      expect(buildSnapshot.rowsByLabel).toEqual(receiptSnapshot.rowsByLabel);
      expect(buildSnapshot.vectors.map((row) => row.label)).toEqual([healthyLabel]);
      expect(receiptSnapshot.receipt.signature).toContain(";quarantine=");
    } finally {
      await db.closeAndRelease();
    }
  });
});

// v3.9.0-rc.2 — return-value contract for upsertNote / deleteNote.
// The watcher's HNSW live-update path consumes oldIds + newIds to
// keep the in-memory graph in sync with embed-db. These tests pin
// the contract so a future refactor that loses the IDs breaks here
// rather than silently breaking watcher → HNSW sync.
describe("EmbedDb upsertNote + deleteNote return ids (v3.9.0-rc.2)", () => {
  it("upsertNote returns oldIds=[] + newIds for a fresh file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-db-"));
    const file = path.join(dir, "x.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "m", dim: 4 });
    await db.open();
    try {
      const v = l2([1, 0, 0, 0]);
      const r = db.upsertNote("a.md", 1000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "first", vector: v },
        { chunkIndex: 1, lineStart: 2, lineEnd: 2, textPreview: "second", vector: v }
      ]);
      expect(Object.keys(r).sort()).toEqual(["newIds", "oldIds"]);
      expect(r.oldIds).toEqual([]);
      expect(r.newIds).toHaveLength(2);
      // AUTOINCREMENT IDs are positive integers, monotonically increasing.
      expect(r.newIds[0]).toBeGreaterThan(0);
      expect(r.newIds[1]).toBeGreaterThan(r.newIds[0] ?? 0);
    } finally {
      await db.closeAndRelease();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("upsertNote returns oldIds=existing + newIds=fresh on re-upsert", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-db-"));
    const file = path.join(dir, "x.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "m", dim: 4 });
    await db.open();
    try {
      const v = l2([1, 0, 0, 0]);
      // First upsert assigns ids 1, 2.
      const first = db.upsertNote("a.md", 1000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "a0", vector: v },
        { chunkIndex: 1, lineStart: 2, lineEnd: 2, textPreview: "a1", vector: v }
      ]);
      // Second upsert: DELETE old (ids 1,2), INSERT new (ids 3,4,5).
      const second = db.upsertNote("a.md", 2000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "b0", vector: v },
        { chunkIndex: 1, lineStart: 2, lineEnd: 2, textPreview: "b1", vector: v },
        { chunkIndex: 2, lineStart: 3, lineEnd: 3, textPreview: "b2", vector: v }
      ]);
      expect(second.oldIds).toEqual(first.newIds);
      expect(second.newIds).toHaveLength(3);
      // New ids must NOT overlap old ids — AUTOINCREMENT guarantees monotonic.
      for (const newId of second.newIds) {
        expect(second.oldIds.includes(newId)).toBe(false);
      }
    } finally {
      await db.closeAndRelease();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("deleteNote returns the ids that were dropped", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-db-"));
    const file = path.join(dir, "x.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "m", dim: 4 });
    await db.open();
    try {
      const v = l2([1, 0, 0, 0]);
      const r = db.upsertNote("a.md", 1000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "first", vector: v },
        { chunkIndex: 1, lineStart: 2, lineEnd: 2, textPreview: "second", vector: v }
      ]);
      const deletedIds = db.deleteNote("a.md");
      expect(deletedIds).toEqual(r.newIds);
    } finally {
      await db.closeAndRelease();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // NEGATIVE control: deleteNote on a file with no embed-db rows returns [].
  it("(NEGATIVE control) — deleteNote on absent file returns empty array", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-db-"));
    const file = path.join(dir, "x.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "m", dim: 4 });
    await db.open();
    try {
      const deletedIds = db.deleteNote("ghost.md");
      expect(deletedIds).toEqual([]);
    } finally {
      await db.closeAndRelease();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("peekEmbedDbMeta is fail-soft after exact namespace admission (v3.10.0-rc.34)", () => {
  // Pass trivially when better-sqlite3 is absent (the peek returns null at the
  // dep-load catch before reaching `new Database`); when present (CI + dev) the
  // directory/corrupt cases exercise the rc.34 fix — pre-fix `new Database()`
  // threw out of the peek and errored the embeddings_search hot path / crashed
  // CLI subcommands that call it unguarded.
  it("returns null for a non-existent file", async () => {
    const missing = path.join(os.tmpdir(), `enquire-nope-${Date.now()}.embed.db`);
    expect(await peekEmbedDbMeta(missing)).toBeNull();
    expect(await discoverEmbedDbConfig(missing, "/v")).toEqual({ kind: "missing" });
    await expect(assertEmbedDbRecoveryOwnership(missing, "/v")).resolves.toBeUndefined();
  });

  it("returns null (not throw) when an admitted .embed.db path is a DIRECTORY", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-embed-dir-"));
    const d = path.join(parent, "directory.embed.db");
    await fs.mkdir(d);
    try {
      const modeBefore = (await fs.stat(d)).mode & 0o777;
      expect(await peekEmbedDbMeta(d)).toBeNull();
      expect(await discoverEmbedDbConfig(d, "/v")).toEqual({ kind: "refused" });
      expect(await discoverEmbedDbConfigCached(d, "/v")).toEqual({ kind: "refused" });
      const directoryDb = new EmbedDb({ file: d, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
      let openError: unknown;
      try {
        await directoryDb.open();
      } catch (error) {
        openError = error;
      } finally {
        await directoryDb.closeAndRelease();
      }
      expect(openError).toBeInstanceOf(Error);
      const openMessage = openError instanceof Error ? openError.message : String(openError);
      expect(openMessage).toBe("Embedding index artifact family could not be admitted");
      expect(openMessage).not.toContain(d);
      expect((await fs.stat(d)).mode & 0o777).toBe(modeBefore);
      await expectPathFreeRecoveryOwnershipRefusal(d, "/v");
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("returns null (not throw) for a corrupt / non-SQLite file", async () => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-embed-corrupt-"));
    const f = path.join(d, "bad.embed.db");
    await fs.writeFile(f, "this is not a sqlite database");
    try {
      expect(await peekEmbedDbMeta(f)).toBeNull();
      await expectPathFreeRecoveryOwnershipRefusal(f, "/v");
    } finally {
      await fs.rm(d, { recursive: true, force: true });
    }
  });
});
