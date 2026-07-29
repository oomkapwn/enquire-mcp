import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmbedDb } from "../src/embed-db.js";
import { embedSingleNote } from "../src/embed-pipeline.js";
import { FtsIndex } from "../src/fts5.js";
import { renameNote } from "../src/tools/write.js";
import { Vault } from "../src/vault.js";
import { VaultWatcher } from "../src/watcher.js";
import { windowsRelativePathProblem } from "../src/windows-path.js";

let root: string;
let outside: string;

const WATCHER_STATE_TIMEOUT_MS = 15_000;
const WATCHER_STABLE_WINDOW_MS = 1_200;
const WATCHER_POLL_MS = 75;

const watcherEmbedder = {
  model: {
    alias: "windows-watcher-mock",
    hfId: "local/test-only",
    dim: 4,
    multilingual: true,
    maxTokens: 128
  },
  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array([1, 0, 0, 0]));
  }
};

interface WindowsWatcherFixture {
  vault: Vault;
  fts: FtsIndex;
  embedDb: EmbedDb;
  watcher: VaultWatcher;
}

interface WindowsWatcherSnapshot {
  diskNames: string[];
  ftsByMarker: Record<string, string[]>;
  embedByMarker: Record<string, string[]>;
  embedPaths: string[];
  ftsAudit: ReturnType<FtsIndex["auditKind"]>;
  embedAudit: ReturnType<EmbedDb["auditKind"]>;
}

async function seedWindowsWatcherFixture(notes: Record<string, string>): Promise<WindowsWatcherFixture> {
  const vault = new Vault(root);
  await vault.ensureExists();
  const fts = new FtsIndex({ file: path.join(outside, "watcher.fts5.db"), vaultRoot: root });
  await fts.open();
  const embedDb = new EmbedDb({
    file: path.join(outside, "watcher.embed.db"),
    vaultRoot: root,
    modelAlias: watcherEmbedder.model.alias,
    dim: watcherEmbedder.model.dim,
    quantization: "f32"
  });
  await embedDb.open();

  for (const [relPath, content] of Object.entries(notes)) {
    const absPath = path.join(root, ...relPath.split("/"));
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content);
    const stat = await fs.stat(absPath);
    fts.reindexFile(relPath, stat.mtimeMs, content);
    const embedded = await embedSingleNote(
      vault,
      watcherEmbedder,
      { relPath, absPath, mtimeMs: stat.mtimeMs },
      { lateChunkContext: 0 }
    );
    if (!embedded) throw new Error(`test fixture note unexpectedly produced no chunks: ${relPath}`);
    embedDb.upsertNote(relPath, stat.mtimeMs, embedded.rows);
  }

  const watcher = new VaultWatcher({ vault, ftsIndex: fts, silent: true });
  watcher.attachEmbed(embedDb, watcherEmbedder, 0);
  return { vault, fts, embedDb, watcher };
}

async function snapshotWindowsWatcherState(
  fixture: WindowsWatcherFixture,
  markers: readonly string[]
): Promise<WindowsWatcherSnapshot> {
  const ftsByMarker: Record<string, string[]> = {};
  const embedByMarker: Record<string, string[]> = {};
  const embedRows = fixture.embedDb.getAllVectors();
  for (const marker of markers) {
    ftsByMarker[marker] = [
      ...new Set(fixture.fts.search(marker, { limit: 50 }).map((result) => result.rel_path))
    ].sort();
    embedByMarker[marker] = [
      ...new Set(
        embedRows.filter((row) => row.text_preview.includes(marker)).map((row) => row.rel_path)
      )
    ].sort();
  }
  return {
    diskNames: (await fs.readdir(root)).sort(),
    ftsByMarker,
    embedByMarker,
    embedPaths: [...new Set(fixture.embedDb.getSourceStates("md").map((state) => state.rel_path))].sort(),
    ftsAudit: fixture.fts.auditKind("md"),
    embedAudit: fixture.embedDb.auditKind("md")
  };
}

function markerPaths(paths: Record<string, string[]>, marker: string): string[] {
  return paths[marker] ?? [];
}

async function waitForStableWindowsWatcherState(
  observe: () => Promise<WindowsWatcherSnapshot>,
  expected: (snapshot: WindowsWatcherSnapshot) => boolean
): Promise<WindowsWatcherSnapshot> {
  const deadline = Date.now() + WATCHER_STATE_TIMEOUT_MS;
  let stableSince: number | null = null;
  let last: WindowsWatcherSnapshot | undefined;
  while (Date.now() < deadline) {
    last = await observe();
    if (expected(last)) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= WATCHER_STABLE_WINDOW_MS) return last;
    } else {
      stableSince = null;
    }
    await new Promise((resolve) => setTimeout(resolve, WATCHER_POLL_MS));
  }
  throw new Error(`watcher state did not converge and remain stable: ${JSON.stringify(last)}`);
}

function watcherAuditsMatch(snapshot: WindowsWatcherSnapshot, expectedFiles: number): boolean {
  return (
    snapshot.ftsAudit.declared_files === expectedFiles &&
    snapshot.ftsAudit.indexed_files === expectedFiles &&
    snapshot.ftsAudit.mismatched_files === 0 &&
    snapshot.embedAudit.indexed_files === expectedFiles &&
    snapshot.embedAudit.mismatched_files === 0
  );
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-win-vault-"));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-win-outside-"));
});

afterEach(async () => {
  for (const junction of [path.join(root, "Outside"), path.join(root, "Incoming", "Outside")]) {
    const junctionStat = await fs.lstat(junction).catch(() => null);
    if (junctionStat?.isSymbolicLink()) {
      await fs.unlink(junction);
    }
  }
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

const windowsDescribe = process.platform === "win32" ? describe : describe.skip;

windowsDescribe("Windows hostile-filesystem contracts", () => {
  it("rejects reserved names, ADS, forbidden components, and traversal before filesystem I/O", async () => {
    const rejected = [
      "CON",
      "con.md",
      "PRN.txt",
      "AUX.tar.gz",
      "NUL.tar.gz",
      "COM0.md",
      "COM9",
      "COM¹.md",
      "COM².tar",
      "COM³",
      "LPT0",
      "LPT9.md",
      "LPT¹.ext",
      "LPT².ext",
      "LPT³.ext",
      "CONIN$",
      "conout$.md",
      "CON .txt",
      "NUL...txt",
      "COM1 .md",
      "Folder/NUL.md",
      "bad<.md",
      "bad>.md",
      'bad".md',
      "note:stream.md",
      "a|b.md",
      "a?b.md",
      "a*b.md",
      "x\u0000.md",
      "x\u0001.md",
      "x\u001f.md",
      "Folder./n.md",
      "Folder /n.md",
      "n.md.",
      "n.md "
    ];
    for (const candidate of rejected) {
      expect(windowsRelativePathProblem(candidate), candidate).not.toBeNull();
    }

    const accepted = [
      "",
      "Note.md",
      "Folder/Note.md",
      ".hidden.md",
      "CONTEXT.md",
      "AUXILIARY.md",
      "NULL.md",
      "NULish.md",
      "COM10.md",
      "LPT10.md",
      "COM0x.md",
      "CONINbox.md",
      "CON text.md",
      "name.with.dots.md",
      "café.md",
      "emoji-🧠.md"
    ];
    for (const candidate of accepted) {
      expect(windowsRelativePathProblem(candidate), candidate).toBeNull();
    }

    const vault = new Vault(root, { enableWrite: true });
    expect(() => vault.resolveInside("CON.md")).toThrow(/reserved Windows device name/);
    await vault.ensureExists();
    const absoluteGood = path.join(root, "Folder", "Good.md");
    expect(vault.resolveInside(absoluteGood)).toBe(path.join(vault.root, "Folder", "Good.md"));
    expect(() => vault.resolveInside(path.join(root, "NUL.md"))).toThrow(/reserved Windows device name/);
    await expect(vault.writeNote("CON.md", "must not exist")).rejects.toThrow(/Windows-unsafe vault path/);
    await expect(vault.writeNote("n.md ", "must not be trimmed into existence")).rejects.toThrow(
      /ends with a dot or space/
    );
    expect(await fs.stat(path.join(root, "n.md")).catch(() => null)).toBeNull();

    const realpathSpy = vi
      .spyOn(fs, "realpath")
      .mockRejectedValueOnce(Object.assign(new Error("canonical realpath denied"), { code: "EACCES" }));
    try {
      await expect(vault.canonicalRelForPrivacyCheckPublic(absoluteGood)).rejects.toThrow(/canonical realpath denied/);
    } finally {
      realpathSpy.mockRestore();
    }

    const drive = path.parse(root).root.slice(0, 2);
    const escapes = [
      "../escape.md",
      "..\\escape.md",
      path.join(outside, "escape.md"),
      drive,
      `${drive}escape.md`,
      "\\\\server\\share\\escape.md",
      `\\\\?\\${path.join(outside, "escape.md")}`
    ];
    for (const candidate of escapes) {
      expect(() => vault.resolveInside(candidate), candidate).toThrow();
    }

    for (const candidate of ["CONTEXT.md", "COM10.md", "LPT10.md"]) {
      await vault.writeNote(candidate, `positive control: ${candidate}`);
    }
    expect(await fs.readdir(root)).toEqual(expect.arrayContaining(["CONTEXT.md", "COM10.md", "LPT10.md"]));
  });

  it("does not traverse a real directory junction for list, read, create, append, or rename", async () => {
    const sentinel = path.join(outside, "Secret.md");
    await fs.writeFile(sentinel, "external sentinel");
    await fs.symlink(outside, path.join(root, "Outside"), "junction");
    expect(await fs.readFile(path.join(root, "Outside", "Secret.md"), "utf8")).toBe("external sentinel");

    await fs.mkdir(path.join(root, "Real"), { recursive: true });
    await fs.writeFile(path.join(root, "Real", "Visible.md"), "visible");
    await fs.writeFile(path.join(root, "Inside.md"), "inside");

    const vault = new Vault(root, { enableWrite: true });
    await vault.ensureExists();
    const listed = (await vault.listMarkdown()).map((entry) => entry.relPath);
    expect(listed).toContain("Real/Visible.md");
    expect(listed).not.toContain("Outside/Secret.md");

    await expect(vault.readFile("Outside/Secret.md")).rejects.toThrow(/escapes vault root/);
    await expect(vault.writeNote("Outside/New.md", "attack")).rejects.toThrow(/outside vault/);
    await expect(vault.appendNote("Outside/Secret.md", "\nattack")).rejects.toThrow(/escapes vault root/);
    await expect(vault.renameFile("Inside.md", "Outside/Moved.md")).rejects.toThrow(/outside vault/);

    expect(await fs.readFile(sentinel, "utf8")).toBe("external sentinel");
    expect(await fs.stat(path.join(outside, "New.md")).catch(() => null)).toBeNull();
    expect(await fs.stat(path.join(outside, "Moved.md")).catch(() => null)).toBeNull();
    expect(await fs.readFile(path.join(root, "Inside.md"), "utf8")).toBe("inside");

    const created = await vault.writeNote("Real/New.md", "local");
    expect(created.relPath).toBe("Real/New.md");
    const appended = await vault.appendNote("Real/New.md", "\nappend");
    expect(appended.relPath).toBe("Real/New.md");

    const configuredAlias = path.join(outside, "ConfiguredVault");
    await fs.mkdir(path.join(root, "Scope", "Private"), { recursive: true });
    await fs.writeFile(path.join(root, "Scope", "Public.md"), "public");
    await fs.writeFile(path.join(root, "Scope", "Public.canvas"), "{}");
    await fs.writeFile(path.join(root, "Scope", "Private", "Hidden.md"), "hidden");
    await fs.writeFile(path.join(root, "Scope", "Private", "Hidden.canvas"), "{}");
    await fs.symlink(root, configuredAlias, "junction");
    try {
      const aliasVault = new Vault(configuredAlias, { excludeGlobs: ["Scope/Private/**"] });
      await aliasVault.ensureExists();
      const throughConfiguredAlias = path.join(configuredAlias, "Real", "Visible.md");
      expect(aliasVault.resolveInside(throughConfiguredAlias)).toBe(path.join(aliasVault.root, "Real", "Visible.md"));
      expect(aliasVault.toRel(aliasVault.resolveInside(throughConfiguredAlias))).toBe("Real/Visible.md");
      expect(await aliasVault.readFile(throughConfiguredAlias)).toBe("visible");
      expect(await aliasVault.readFile(path.join(aliasVault.root, "Real", "Visible.md"))).toBe("visible");

      const aliasMarkdown = await aliasVault.listMarkdown(path.join(configuredAlias, "Scope"));
      expect(aliasMarkdown.map((entry) => entry.relPath)).toContain("Scope/Public.md");
      expect(aliasMarkdown.map((entry) => entry.relPath)).not.toContain("Scope/Private/Hidden.md");
      expect(aliasMarkdown.every((entry) => !entry.relPath.startsWith(".."))).toBe(true);
      const aliasCanvases = await aliasVault.listFilesByExtension(".canvas", path.join(configuredAlias, "Scope"));
      expect(aliasCanvases.map((entry) => entry.relPath)).toEqual(["Scope/Public.canvas"]);

      const aliasRealpathSpy = vi.spyOn(fs, "realpath").mockRejectedValueOnce(
        Object.assign(new Error(`EACCES: cannot resolve '${throughConfiguredAlias}'`), {
          code: "EACCES",
          path: throughConfiguredAlias
        })
      );
      try {
        const sanitized = await aliasVault.readFile(throughConfiguredAlias).then(
          () => null,
          (error: unknown) => error
        );
        expect(sanitized).toBeInstanceOf(Error);
        expect((sanitized as Error).message).not.toContain(configuredAlias);
        expect((sanitized as NodeJS.ErrnoException).path).not.toContain(configuredAlias);
      } finally {
        aliasRealpathSpy.mockRestore();
      }
    } finally {
      await fs.unlink(configuredAlias);
    }
  });

  it("uses forward-slash identities and keeps case-folded privacy fail-closed", async () => {
    await fs.mkdir(path.join(root, "Folder"), { recursive: true });
    await fs.writeFile(path.join(root, "Folder", "Note.md"), "note");
    await fs.writeFile(path.join(root, "Folder", "Second.md"), "second");
    await fs.writeFile(path.join(root, "Folder", "Board.canvas"), "{}");

    const cacheFile = path.join(outside, "parse-cache.json");
    const vault = new Vault(root, { enableWrite: true, persistentCache: true, cacheFile });
    await vault.ensureExists();
    const markdown = await vault.listMarkdown();
    const noteEntry = markdown.find((entry) => entry.basename === "Note.md");
    expect(noteEntry?.relPath).toBe("Folder/Note.md");
    if (!noteEntry) throw new Error("Windows walker did not return the positive-control note");
    const canvases = await vault.listFilesByExtension(".canvas");
    expect(canvases[0]?.relPath).toBe("Folder/Board.canvas");
    expect(vault.toRel(path.join(vault.root, "Folder", "Note.md"))).toBe("Folder/Note.md");

    const folderFts = new FtsIndex({ file: path.join(outside, "folder-filter.fts5.db"), vaultRoot: root });
    await folderFts.open();
    try {
      folderFts.reindexFile(noteEntry.relPath, noteEntry.mtimeMs, "portablefoldermarker");
      folderFts.reindexFile("Elsewhere/Other.md", noteEntry.mtimeMs, "portablefoldermarker");
      expect(folderFts.search("portablefoldermarker", { folder: "Folder" }).map((hit) => hit.rel_path)).toEqual([
        "Folder/Note.md"
      ]);
      expect(folderFts.search("portablefoldermarker", { folder: "Missing" })).toEqual([]);
    } finally {
      folderFts.close();
    }

    await vault.readNote("Folder/Note.md");
    await vault.readNote("Folder/Second.md");
    await vault.saveDiskCache();
    const persisted = JSON.parse(await fs.readFile(cacheFile, "utf8")) as {
      entries?: Array<{ relPath?: string; content?: string }>;
    };
    expect(persisted.entries?.[0]?.relPath).toBe("Folder/Note.md");
    const legacyEntry = persisted.entries?.find((entry) => entry.relPath === "Folder/Second.md");
    if (!legacyEntry) throw new Error("persistent cache did not contain the migration-control note");
    legacyEntry.relPath = "folder\\Second.md";
    legacyEntry.content = "legacy-cache-sentinel";
    await fs.writeFile(cacheFile, JSON.stringify(persisted));
    const legacyCacheVault = new Vault(root, { persistentCache: true, cacheFile, maxCacheEntries: 2 });
    await legacyCacheVault.ensureExists();
    expect((await legacyCacheVault.readNote("Folder/Second.md")).content).toBe("legacy-cache-sentinel");
    await legacyCacheVault.saveDiskCache();
    const migrated = JSON.parse(await fs.readFile(cacheFile, "utf8")) as {
      entries?: Array<{ relPath?: string }>;
    };
    expect(migrated.entries?.map((entry) => entry.relPath)).toEqual(["Folder/Note.md", "Folder/Second.md"]);

    await fs.mkdir(path.join(root, "Private"), { recursive: true });
    await fs.writeFile(path.join(root, "Private", "Secret.md"), "private-cache-sentinel");

    const caseCacheFile = path.join(outside, "case-privacy-cache.json");
    const caseCacheSource = new Vault(root, { persistentCache: true, cacheFile: caseCacheFile });
    await caseCacheSource.ensureExists();
    await caseCacheSource.readNote("Private/Secret.md");
    await caseCacheSource.saveDiskCache();
    const caseCache = JSON.parse(await fs.readFile(caseCacheFile, "utf8")) as {
      entries?: Array<{ relPath?: string; content?: string }>;
    };
    const caseVariantSecret = caseCache.entries?.[0];
    if (!caseVariantSecret) throw new Error("persistent cache did not contain the privacy-control note");
    caseVariantSecret.relPath = "private\\Secret.md";
    await fs.writeFile(caseCacheFile, JSON.stringify(caseCache));
    const caseFilteredVault = new Vault(root, {
      persistentCache: true,
      cacheFile: caseCacheFile,
      excludeGlobs: ["Private/**"]
    });
    await caseFilteredVault.ensureExists();
    await caseFilteredVault.saveDiskCache();
    const casePruned = await fs.readFile(caseCacheFile, "utf8");
    expect((JSON.parse(casePruned) as { entries?: unknown[] }).entries).toEqual([]);
    expect(casePruned).not.toContain("private-cache-sentinel");

    const tailCacheFile = path.join(outside, "tail-privacy-cache.json");
    const tailCacheSource = new Vault(root, { persistentCache: true, cacheFile: tailCacheFile });
    await tailCacheSource.ensureExists();
    await tailCacheSource.readNote("Folder/Note.md");
    await tailCacheSource.readNote("Folder/Second.md");
    await tailCacheSource.readNote("Private/Secret.md");
    await tailCacheSource.saveDiskCache();
    const tailFilteredVault = new Vault(root, {
      persistentCache: true,
      cacheFile: tailCacheFile,
      maxCacheEntries: 1,
      excludeGlobs: ["Private/**"]
    });
    await tailFilteredVault.ensureExists();
    await tailFilteredVault.saveDiskCache();
    const tailPruned = await fs.readFile(tailCacheFile, "utf8");
    expect(
      (JSON.parse(tailPruned) as { entries?: Array<{ relPath?: string }> }).entries?.map((entry) => entry.relPath)
    ).toEqual(["Folder/Note.md"]);
    expect(tailPruned).not.toContain("private-cache-sentinel");

    const written = await vault.writeNote("Folder/New.md", "new");
    expect(written.relPath).toBe("Folder/New.md");
    const appended = await vault.appendNote("Folder/New.md", "\nmore");
    expect(appended.relPath).toBe("Folder/New.md");
    const renamed = await vault.renameFile("Folder/New.md", "Archive/Renamed.md");
    expect(renamed).toMatchObject({ from: "Folder/New.md", to: "Archive/Renamed.md" });

    const droppedPaths: string[] = [];
    const ftsStub = {
      dropFile: (relPath: string) => {
        droppedPaths.push(relPath);
      }
    } as unknown as FtsIndex;
    const watcher = new VaultWatcher({ vault, ftsIndex: ftsStub, silent: true });
    const handle = (
      watcher as unknown as {
        handle(absPath: string, kind: "add" | "change" | "unlink"): Promise<void>;
      }
    ).handle.bind(watcher);
    await handle(path.join(vault.root, "Folder", "Deleted.md"), "unlink");
    expect(droppedPaths).toEqual(["Folder/Deleted.md"]);

    await fs.writeFile(path.join(root, "Private", "Secret.md"), "private");
    const filtered = new Vault(root, { enableWrite: true, excludeGlobs: ["Private/**"] });
    await filtered.ensureExists();
    expect((await filtered.listMarkdown()).map((entry) => entry.relPath)).not.toContain("Private/Secret.md");
    await expect(filtered.readFile("private/secret.md")).rejects.toThrow(/excluded.*Private\/Secret\.md/);
    await expect(filtered.writeNote("private/new.md", "blocked")).rejects.toThrow(/excluded/);
    expect(await fs.stat(path.join(root, "Private", "new.md")).catch(() => null)).toBeNull();
  });

  it("canonicalizes a case-variant rename source before rewriting self-links and backlinks", async () => {
    await fs.writeFile(path.join(root, "Foo.md"), "# Foo\n\nSelf [[Foo]].\n");
    await fs.writeFile(path.join(root, "Hub.md"), "See [[Foo]].\n");
    const vault = new Vault(root, { enableWrite: true });
    await vault.ensureExists();

    const mixedCase = await renameNote(vault, { from: "foo.md", to: "Bar.md" });
    expect(mixedCase.total_links_rewritten).toBe(2);
    expect(await fs.readFile(path.join(root, "Bar.md"), "utf8")).toContain("[[Bar]]");
    expect(await fs.readFile(path.join(root, "Hub.md"), "utf8")).toContain("[[Bar]]");
    expect(await fs.stat(path.join(root, "Foo.md")).catch(() => null)).toBeNull();

    await fs.writeFile(path.join(root, "Exact.md"), "# Exact\n\nSelf [[Exact]].\n");
    await fs.writeFile(path.join(root, "ExactHub.md"), "See [[Exact]].\n");
    const exactCase = await renameNote(vault, { from: "Exact.md", to: "ExactNew.md" });
    expect(exactCase.total_links_rewritten).toBe(2);
    expect(await fs.readFile(path.join(root, "ExactNew.md"), "utf8")).toContain("[[ExactNew]]");
    expect(await fs.readFile(path.join(root, "ExactHub.md"), "utf8")).toContain("[[ExactNew]]");
  });

  it("watcher converges after an ordinary rename without stale FTS or embedding paths", async () => {
    const fixture = await seedWindowsWatcherFixture({
      "Old.md": "# Old\n\nordinarywatchermarker\n",
      "Keep.md": "# Keep\n\nkeepwatchermarker\n"
    });
    const markers = ["ordinarywatchermarker", "keepwatchermarker"] as const;
    const expected = (snapshot: WindowsWatcherSnapshot): boolean =>
      snapshot.diskNames.includes("New.md") &&
      !snapshot.diskNames.includes("Old.md") &&
      markerPaths(snapshot.ftsByMarker, markers[0]).join() === "New.md" &&
      markerPaths(snapshot.embedByMarker, markers[0]).join() === "New.md" &&
      markerPaths(snapshot.ftsByMarker, markers[1]).join() === "Keep.md" &&
      markerPaths(snapshot.embedByMarker, markers[1]).join() === "Keep.md" &&
      snapshot.embedPaths.join() === "Keep.md,New.md" &&
      watcherAuditsMatch(snapshot, 2);

    try {
      await fixture.watcher.start();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const before = await snapshotWindowsWatcherState(fixture, markers);
      expect(expected(before), "NEGATIVE control: pre-rename state must not satisfy the final predicate").toBe(
        false
      );
      expect(markerPaths(before.ftsByMarker, markers[0])).toEqual(["Old.md"]);
      expect(markerPaths(before.embedByMarker, markers[0])).toEqual(["Old.md"]);

      await fs.rename(path.join(root, "Old.md"), path.join(root, "New.md"));

      const stable = await waitForStableWindowsWatcherState(
        () => snapshotWindowsWatcherState(fixture, markers),
        expected
      );
      expect(expected(stable)).toBe(true);
      await fixture.watcher.close();
      expect(expected(await snapshotWindowsWatcherState(fixture, markers))).toBe(true);
    } finally {
      await fixture.watcher.close();
      fixture.embedDb.close();
      fixture.fts.close();
    }
  });

  it("watcher converges to the exact on-disk casing after a case-only rename", async () => {
    const fixture = await seedWindowsWatcherFixture({
      "Foo.md": "# Foo\n\ncasewatchermarker\n"
    });
    const markers = ["casewatchermarker"] as const;
    const expected = (snapshot: WindowsWatcherSnapshot): boolean =>
      snapshot.diskNames.filter((name) => name.toLowerCase() === "foo.md").join() === "foo.md" &&
      markerPaths(snapshot.ftsByMarker, markers[0]).join() === "foo.md" &&
      markerPaths(snapshot.embedByMarker, markers[0]).join() === "foo.md" &&
      snapshot.embedPaths.join() === "foo.md" &&
      watcherAuditsMatch(snapshot, 1);

    try {
      await fixture.watcher.start();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await fs.readFile(path.join(root, "foo.md"), "utf8")).toContain("casewatchermarker");
      const before = await snapshotWindowsWatcherState(fixture, markers);
      expect(expected(before), "NEGATIVE control: pre-rename casing must not satisfy the final predicate").toBe(
        false
      );
      expect(markerPaths(before.ftsByMarker, markers[0])).toEqual(["Foo.md"]);
      expect(markerPaths(before.embedByMarker, markers[0])).toEqual(["Foo.md"]);

      await fs.rename(path.join(root, "Foo.md"), path.join(root, "foo.md"));

      const stable = await waitForStableWindowsWatcherState(
        () => snapshotWindowsWatcherState(fixture, markers),
        expected
      );
      expect(expected(stable)).toBe(true);
      await fixture.watcher.close();
      expect(expected(await snapshotWindowsWatcherState(fixture, markers))).toBe(true);
    } finally {
      await fixture.watcher.close();
      fixture.embedDb.close();
      fixture.fts.close();
    }
  });

  it("watcher converges after one same-path atomic replacement without stale content", async () => {
    const fixture = await seedWindowsWatcherFixture({
      "Atomic.md": "# Atomic\n\noldatomicwatchermarker\n"
    });
    const replacement = path.join(root, "Atomic.swap");
    await fs.writeFile(replacement, "# Atomic\n\nnewatomicwatchermarker\n");
    const markers = ["oldatomicwatchermarker", "newatomicwatchermarker"] as const;
    const expected = (snapshot: WindowsWatcherSnapshot): boolean =>
      !snapshot.diskNames.includes("Atomic.swap") &&
      snapshot.diskNames.includes("Atomic.md") &&
      markerPaths(snapshot.ftsByMarker, markers[0]).length === 0 &&
      markerPaths(snapshot.embedByMarker, markers[0]).length === 0 &&
      markerPaths(snapshot.ftsByMarker, markers[1]).join() === "Atomic.md" &&
      markerPaths(snapshot.embedByMarker, markers[1]).join() === "Atomic.md" &&
      snapshot.embedPaths.join() === "Atomic.md" &&
      watcherAuditsMatch(snapshot, 1);

    try {
      await fixture.watcher.start();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const before = await snapshotWindowsWatcherState(fixture, markers);
      expect(expected(before), "NEGATIVE control: old bytes must not satisfy the replacement predicate").toBe(
        false
      );
      expect(markerPaths(before.ftsByMarker, markers[0])).toEqual(["Atomic.md"]);
      expect(markerPaths(before.embedByMarker, markers[0])).toEqual(["Atomic.md"]);

      await fs.rename(replacement, path.join(root, "Atomic.md"));

      const stable = await waitForStableWindowsWatcherState(
        () => snapshotWindowsWatcherState(fixture, markers),
        expected
      );
      expect(expected(stable)).toBe(true);
      expect(await fs.readFile(path.join(root, "Atomic.md"), "utf8")).toContain("newatomicwatchermarker");
      await fixture.watcher.close();
      expect(expected(await snapshotWindowsWatcherState(fixture, markers))).toBe(true);
    } finally {
      await fixture.watcher.close();
      fixture.embedDb.close();
      fixture.fts.close();
    }
  });

  it("watcher indexes a moved-in directory but never follows its junction", async () => {
    const fixture = await seedWindowsWatcherFixture({});
    const sentinelDir = path.join(outside, "sentinel");
    const sentinel = path.join(sentinelDir, "Secret.md");
    const staging = path.join(outside, "Incoming.staging");
    await fs.mkdir(sentinelDir, { recursive: true });
    await fs.writeFile(sentinel, "# Secret\n\njunctionsecretwatchermarker\n");
    await fs.mkdir(staging, { recursive: true });
    await fs.writeFile(path.join(staging, "Visible.md"), "# Visible\n\njunctionvisiblewatchermarker\n");
    await fs.symlink(sentinelDir, path.join(staging, "Outside"), "junction");
    const markers = ["junctionvisiblewatchermarker", "junctionsecretwatchermarker"] as const;
    const expected = (snapshot: WindowsWatcherSnapshot): boolean =>
      snapshot.diskNames.includes("Incoming") &&
      markerPaths(snapshot.ftsByMarker, markers[0]).join() === "Incoming/Visible.md" &&
      markerPaths(snapshot.embedByMarker, markers[0]).join() === "Incoming/Visible.md" &&
      markerPaths(snapshot.ftsByMarker, markers[1]).length === 0 &&
      markerPaths(snapshot.embedByMarker, markers[1]).length === 0 &&
      snapshot.embedPaths.join() === "Incoming/Visible.md" &&
      watcherAuditsMatch(snapshot, 1);

    try {
      await fixture.watcher.start();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const before = await snapshotWindowsWatcherState(fixture, markers);
      expect(
        expected(before),
        "NEGATIVE control: the empty index must not satisfy the moved-tree predicate"
      ).toBe(false);

      await fs.rename(staging, path.join(root, "Incoming"));

      const stable = await waitForStableWindowsWatcherState(
        () => snapshotWindowsWatcherState(fixture, markers),
        expected
      );
      expect(expected(stable)).toBe(true);
      expect(await fs.readFile(path.join(root, "Incoming", "Outside", "Secret.md"), "utf8")).toContain(
        "junctionsecretwatchermarker"
      );
      expect(await fs.readFile(sentinel, "utf8")).toContain("junctionsecretwatchermarker");
      await fixture.watcher.close();
      expect(expected(await snapshotWindowsWatcherState(fixture, markers))).toBe(true);
    } finally {
      await fixture.watcher.close();
      const junction = path.join(root, "Incoming", "Outside");
      if ((await fs.lstat(junction).catch(() => null))?.isSymbolicLink()) await fs.unlink(junction);
      fixture.embedDb.close();
      fixture.fts.close();
    }
  });
});
