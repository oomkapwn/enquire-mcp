// Synthetic-vector tests for the persistent embedding store. These tests
// don't load any ML model — they verify the SQLite schema, the cross-vault
// contamination guard, the upsert/delete/search/sync semantics with hand-
// constructed vectors. End-to-end ML smoke is out-of-band (see manual
// build-embeddings + the smoke.mjs probe in scripts/).

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertEmbedDbRecoveryOwnership,
  clearPeekCache,
  decodeInt8Vector,
  discoverEmbedDbConfig,
  discoverEmbedDbConfigCached,
  EmbedDb,
  encodeInt8Vector,
  openEmbedReceiptReader,
  peekEmbedDbMeta,
  peekEmbedDbMetaCached
} from "../src/embed-db.js";
import { EMBED_DB_SCHEMA_VERSION } from "../src/schema-contract.js";

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
    refused.close();
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
    seed.close();
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
  it("opens, closes, and reopens cleanly with the same meta", async () => {
    const file = path.join(dir, "test.embed.db");
    const db1 = new EmbedDb({ file, vaultRoot: "/v1", modelAlias: "multilingual", dim: 4 });
    await db1.open();
    db1.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "hello", vector: l2([1, 0, 0, 0]) }
    ]);
    expect(db1.totalChunks()).toBe(1);
    db1.close();

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
    db2.close();

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
      candidate.close();
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
    missingInitializer.close();
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
    emptyInitializer.close();
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
        symlinkDb.close();
      }
      expect(symlinkError).toBeInstanceOf(Error);
      const symlinkMessage = symlinkError instanceof Error ? symlinkError.message : String(symlinkError);
      expect(symlinkMessage).toBe("Embedding index could not be inspected");
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
    expect(injectedCloseErrors).toBeGreaterThanOrEqual(4);

    let retryError: unknown;
    try {
      await closeRefused.open();
    } catch (error) {
      retryError = error;
    } finally {
      closeRefused.close();
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
    ledgerSeed.close();
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
    sqlitePrefixSeed.close();
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
    db1.close();
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
    configASeed.close();
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
    configBWriter.close();
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
    staleConfigOpen.close();
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
    currentConfigOpen.close();

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
    explicitASeed.close();
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
    explicitBWriter.close();
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
    betweenReadsSeed.close();
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
    expect(rootMutations).toBe(1);
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
        "/changed-between-admissions"
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
    db1.close();

    const db2 = new EmbedDb({ file, vaultRoot: "/v1", modelAlias: "bge", dim: 4 });
    await db2.open();
    expect(db2.totalChunks()).toBe(0);
    db2.close();
  });

  it("rebuilds when dim changes", async () => {
    const file = path.join(dir, "test.embed.db");
    const db1 = new EmbedDb({ file, vaultRoot: "/v1", modelAlias: "multilingual", dim: 4 });
    await db1.open();
    db1.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "hello", vector: l2([1, 0, 0, 0]) }
    ]);
    db1.close();

    const db2 = new EmbedDb({ file, vaultRoot: "/v1", modelAlias: "multilingual", dim: 8 });
    await db2.open();
    expect(db2.totalChunks()).toBe(0);
    db2.close();
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
    db.close();
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
    db.close();
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
    db.close();
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
    db.close();
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
    db.close();
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
    db.close();
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
    db.close();
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
    db.close();
  });

  it("clearOnDisk removes the .embed.db file (idempotent)", async () => {
    const file = path.join(dir, "test.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    db.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "x", vector: l2([1, 0, 0, 0]) }
    ]);
    db.close();

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
    // Idempotent — second call returns false but doesn't throw.
    expect(await db.clearOnDisk()).toBe(false);
  });

  // v3.9.0-rc.34 (deep-audit P-2) — clearOnDisk must ALSO remove the HNSW
  // persistence sidecars (`<base>.hnsw.bin` + `<base>.hnsw.meta.json`), since
  // the .meta.json carries `text_preview` (raw chunk text). Previously these
  // survived `clear-embeddings`, a right-to-erasure gap for `--use-hnsw` users.
  it("clearOnDisk also removes the HNSW sidecars (P-2 erasure)", async () => {
    const file = path.join(dir, "vaultx.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    db.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "secret note text", vector: l2([1, 0, 0, 0]) }
    ]);
    db.close();
    // Simulate the HNSW persist sidecars next to the embed-db (same base the
    // server derives: strip `.embed.db`, append `.hnsw`).
    const base = `${file.replace(/\.embed\.db$/, "")}.hnsw`;
    const binFile = `${base}.bin`;
    const metaFile = `${base}.meta.json`;
    await fs.writeFile(binFile, Buffer.from([1, 2, 3, 4]));
    await fs.writeFile(metaFile, JSON.stringify({ text_preview: "secret note text" }));

    expect(await db.clearOnDisk()).toBe(true);
    // Both the embed-db AND both HNSW sidecars must be gone.
    for (const p of [file, binFile, metaFile]) {
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
    db.close();
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
    db.close();

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
    db.close();
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
    db.close();

    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(file);
    raw.prepare("DELETE FROM source_state WHERE rel_path = ?").run("orphan.md");
    raw.close();

    const reopened = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await reopened.open();
    expect(reopened.search(l2([1, 0, 0, 0]), 10)).toEqual([]);
    expect(reopened.getAllVectors()).toEqual([]);
    expect(reopened.getSearchRowsByIds(inserted.newIds).size).toBe(0);
    reopened.quarantineSource("orphan.md", "md");
    reopened.deleteNote("orphan.md");
    expect(reopened.getQuarantinedPaths()).toEqual([]);
    reopened.close();
  }

  async function assertQuarantinePersistenceAndKindScope(): Promise<void> {
    const file = path.join(dir, "quarantine-persistence.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    db.quarantineSource("note.md", "md");
    db.quarantineSource("paper.pdf", "pdf");
    db.close();

    const reopened = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await reopened.open();
    expect(reopened.getQuarantinedPaths("md")).toEqual(["note.md"]);
    expect(reopened.getQuarantinedPaths("pdf")).toEqual(["paper.pdf"]);
    expect(reopened.auditKind("md").mismatched_files).toBe(1);
    reopened.close();
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
    db.close();
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
      db.close();
    }

    const Database = (await import("better-sqlite3")).default;
    const legacy = new Database(file);
    legacy.exec(`
      DROP TRIGGER IF EXISTS embed_source_state_revision_insert;
      DROP TRIGGER IF EXISTS embed_source_state_revision_update;
      DROP TRIGGER IF EXISTS embed_source_state_revision_delete;
      DROP TRIGGER IF EXISTS embed_source_quarantine_revision_insert;
      DROP TRIGGER IF EXISTS embed_source_quarantine_revision_update;
      DROP TRIGGER IF EXISTS embed_source_quarantine_revision_delete;
      DELETE FROM source_revision;
      CREATE TRIGGER embed_source_state_revision_insert
      AFTER INSERT ON source_revision
      BEGIN
        DELETE FROM embeddings;
      END;
    `);
    legacy.close();

    await expect(openEmbedReceiptReader(file, "/v")).rejects.toThrow(/compatible index/);

    // The same-name hostile trigger is admitted only so bootstrap can repair
    // it. It must be dropped before the revision backfill; the old ordering
    // fired this trigger and erased both embedding payloads.
    const migrated = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await migrated.open();
    let oldLegacy: ReturnType<EmbedDb["searchWithReceipts"]>[number] | undefined;
    let sibling: ReturnType<EmbedDb["searchWithReceipts"]>[number] | undefined;
    try {
      const migratedHits = new Map(migrated.searchWithReceipts(l2([1, 0, 0, 0]), 10).map((hit) => [hit.rel_path, hit]));
      oldLegacy = migratedHits.get("legacy.md");
      sibling = migratedHits.get("sibling.md");
      if (!oldLegacy || !sibling) throw new Error("expected backfilled legacy receipts");
      expect(oldLegacy.indexed_revision).toBe(1);
      expect(migrated.currentSourceReceiptMask([oldLegacy, sibling])).toEqual([true, true]);

      const reader = await openEmbedReceiptReader(file, "/v");
      try {
        expect(reader.currentSourceReceiptMask([oldLegacy, sibling])).toEqual([true, true]);
        migrated.upsertNote("legacy.md", 1000, [
          {
            chunkIndex: 0,
            lineStart: 1,
            lineEnd: 1,
            textPreview: "same-mtime replacement",
            vector: l2([1, 0, 0, 0])
          }
        ]);
        const newLegacy = migrated.searchWithReceipts(l2([1, 0, 0, 0]), 10).find((hit) => hit.rel_path === "legacy.md");
        if (!newLegacy) throw new Error("expected replacement receipt");
        expect(reader.currentSourceReceiptMask([oldLegacy, sibling, newLegacy])).toEqual([false, true, true]);
        expect(newLegacy.indexed_revision).toBeGreaterThan(oldLegacy.indexed_revision);
        expect(reader.isCurrentSourceReceipt("legacy.md", "md", Number.NaN, newLegacy.indexed_revision)).toBe(false);
        expect(reader.isCurrentSourceReceipt("legacy.md", "md", 1000, 0)).toBe(false);
        await expect(openEmbedReceiptReader(file, "/foreign-vault")).rejects.toThrow(/expected vault/);
        reader.close();
        expect(reader.currentSourceReceiptMask([newLegacy])).toEqual([false]);
      } finally {
        reader.close();
      }
    } finally {
      migrated.close();
    }

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
    await expect(openEmbedReceiptReader(file, "/v")).rejects.toThrow(/compatible index/);

    const repaired = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await repaired.open();
    try {
      const repairedReader = await openEmbedReceiptReader(file, "/v");
      try {
        const current = repaired.searchWithReceipts(l2([1, 0, 0, 0]), 10).find((hit) => hit.rel_path === "legacy.md");
        if (!oldLegacy || !sibling || !current) throw new Error("expected receipt after canonical trigger repair");
        expect(repairedReader.currentSourceReceiptMask([oldLegacy, sibling, current])).toEqual([false, true, true]);
      } finally {
        repairedReader.close();
      }
    } finally {
      repaired.close();
    }
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
      db.close();
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
      db.close();
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
      db.close();
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
    db.close();

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
      reopened.close();
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
    db.close();

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
      reopened.close();
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
    db.close();

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
      reopened.close();
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
    db.close();

    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(file);
    raw.prepare("UPDATE embeddings SET chunk_index = 0.5 WHERE rel_path = ? AND chunk_index = 1").run("a.md");
    raw.close();

    const reopened = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await reopened.open();
    expect(reopened.auditKind("md").mismatched_files).toBe(1);
    reopened.close();

    const corruptVector = new Database(file);
    corruptVector.prepare("UPDATE embeddings SET chunk_index = 1 WHERE rel_path = ? AND chunk_index = 0.5").run("a.md");
    corruptVector.prepare("UPDATE embeddings SET vector = x'00' WHERE rel_path = ? AND chunk_index = 1").run("a.md");
    corruptVector.close();

    const vectorAudit = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await vectorAudit.open();
    expect(vectorAudit.auditKind("md").mismatched_files).toBe(1);
    vectorAudit.close();

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
    numericalAudit.close();

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
    restoredAudit.close();

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
      kindAudit.close();
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
      crossKindAudit.close();
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
    db1.close();

    // Reopen with matching meta — should preserve data.
    const db2 = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db2.open();
    expect(db2.totalChunks()).toBe(1);
    db2.close();

    const Database = (await import("better-sqlite3")).default;

    // Current-v4 additive authority tables may both be absent after an older
    // interrupted rollout. Exact same-root core ownership repairs them without
    // rebuilding or changing the embedding payload/vector.
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
    repairRaw.exec(`
      ${DROP_EMBED_REVISION_TRIGGERS_SQL}
      DROP TABLE source_quarantine;
      DROP TABLE source_revision;
    `);
    repairRaw.close();
    expect(await peekEmbedDbMeta(repairFile, "/v")).toEqual(
      expect.objectContaining({ schema_version: String(EMBED_DB_SCHEMA_VERSION), vault_root: "/v" })
    );

    const repairedV4 = new EmbedDb({ file: repairFile, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await repairedV4.open();
    expect(repairedV4.totalChunks()).toBe(1);
    repairedV4.close();
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
      expect(repairedRaw.prepare("SELECT * FROM source_revision").all()).toEqual([
        { rel_path: "repair.md", kind: "md", revision: 1 }
      ]);
      expect(
        repairedRaw
          .prepare("SELECT count(*) FROM sqlite_master WHERE type = 'trigger' AND name GLOB 'embed_*_revision_*'")
          .pluck()
          .get()
      ).toBe(6);
    } finally {
      repairedRaw.close();
    }

    const raw = new Database(file);
    raw.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(EMBED_DB_SCHEMA_VERSION - 1));
    raw.close();

    // POSITIVE: rc.19's fp32 → q8 inference-contract migration discards old vectors.
    const db3 = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db3.open();
    expect(db3.totalChunks()).toBe(0);
    db3.upsertNote("b.md", 2000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "y", vector: l2([0, 1, 0, 0]) }
    ]);
    db3.close();

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
    // root are supported legacy provenance and may be destructively rebuilt.
    // The compact meta-table punctuation is intentional: SQLite preserves
    // caller formatting in sqlite_master, but whitespace around `(`, `)` and
    // `,` is not part of the historical class identity. The current v4
    // preservation path was pinned by db2 above.
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
      expect(migrated.totalChunks()).toBe(0);
      migrated.close();
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
      db.close();
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
    f32.close();

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
    int8.close();

    // Swap back to f32 — same rebuild trigger.
    const f32again = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await f32again.open();
    expect(f32again.totalChunks()).toBe(0);
    f32again.close();
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
    db1.close();

    const db2 = new EmbedDb({
      file,
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4,
      quantization: "int8"
    });
    await db2.open();
    expect(db2.totalChunks()).toBe(1);
    db2.close();
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
      f32Db.close();
      i8Db.close();
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
      db.close();
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
      a.close();
      b.close();
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
      expect(r.oldIds).toEqual([]);
      expect(r.newIds).toHaveLength(2);
      // AUTOINCREMENT IDs are positive integers, monotonically increasing.
      expect(r.newIds[0]).toBeGreaterThan(0);
      expect(r.newIds[1]).toBeGreaterThan(r.newIds[0] ?? 0);
    } finally {
      db.close();
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
      db.close();
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
      db.close();
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
      db.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("peekEmbedDbMeta is truly safe — never throws (v3.10.0-rc.34, RCA sibling of peekFtsMetaSafe)", () => {
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

  it("returns null (not throw) when the path is a DIRECTORY", async () => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-embed-dir-"));
    try {
      const modeBefore = (await fs.stat(d)).mode & 0o777;
      expect(await peekEmbedDbMeta(d)).toBeNull();
      expect(await discoverEmbedDbConfig(d, "/v")).toEqual({ kind: "refused" });
      expect(await discoverEmbedDbConfigCached(d, "/v")).toEqual({ kind: "refused" });
      const directoryDb = new EmbedDb({ file: d, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
      await expect(directoryDb.open()).rejects.toThrow("Embedding index could not be inspected");
      expect((await fs.stat(d)).mode & 0o777).toBe(modeBefore);
      await expectPathFreeRecoveryOwnershipRefusal(d, "/v");
    } finally {
      await fs.rm(d, { recursive: true, force: true });
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
