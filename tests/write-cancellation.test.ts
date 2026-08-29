import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renameNote, replaceInNotes } from "../src/tools/write.js";
import { Vault } from "../src/vault.js";
import { WriteRequestAbortedError } from "../src/write-lifecycle.js";

let root: string;

async function statOrNullIfMissing(absPath: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.stat(absPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-write-cancel-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("rollback-safe batch write cancellation", () => {
  it("replace_in_notes restores every committed file when cancellation lands after the first write", async () => {
    const originals = new Map([
      ["a.md", "alpha REPLACEME one\n"],
      ["b.md", "beta REPLACEME two\n"],
      ["c.md", "gamma REPLACEME three\n"]
    ]);
    for (const [name, content] of originals) await fs.writeFile(path.join(root, name), content);
    const vault = new Vault(root, { enableWrite: true });
    await vault.ensureExists();
    const abort = new AbortController();
    const writeNote = vault.writeNote.bind(vault);
    let forwardWrites = 0;
    vault.writeNote = async (...args: Parameters<Vault["writeNote"]>) => {
      const result = await writeNote(...args);
      if (!abort.signal.aborted && args[1].includes("REPLACED")) {
        forwardWrites += 1;
        abort.abort(new Error("deterministic post-commit cancellation"));
      }
      return result;
    };

    await expect(
      replaceInNotes(vault, { search: "REPLACEME", replace: "REPLACED" }, { signal: abort.signal })
    ).rejects.toBeInstanceOf(WriteRequestAbortedError);
    expect(forwardWrites).toBe(1);
    for (const [name, content] of originals) {
      expect(await fs.readFile(path.join(root, name), "utf8")).toBe(content);
    }
  });

  it("rename_note restores source, overwritten destination, and backlinks after post-rename cancellation", async () => {
    const cachedDestination = "# Existing destination\n\ncacheOLD\n";
    const replacementDestination = "# Existing destination\n\ndisk_NEW\n";
    expect(Buffer.byteLength(replacementDestination)).toBe(Buffer.byteLength(cachedDestination));
    const originals = new Map([
      ["Source.md", "# Source\n\nSelf [[Source]].\n"],
      ["Dest.md", cachedDestination],
      ["Caller-A.md", "A points to [[Source]].\n"],
      ["Caller-B.md", "B points to [[Source|alias]].\n"]
    ]);
    for (const [name, content] of originals) await fs.writeFile(path.join(root, name), content);
    const vault = new Vault(root, { enableWrite: true });
    await vault.ensureExists();
    const destinationAbs = path.join(root, "Dest.md");
    const fixedCacheTime = new Date("2020-01-02T03:04:05.000Z");
    await fs.utimes(destinationAbs, fixedCacheTime, fixedCacheTime);
    const cachedDestinationStat = await fs.stat(destinationAbs);
    expect((await vault.readNote(destinationAbs, cachedDestinationStat.mtimeMs)).content).toBe(cachedDestination);
    await fs.writeFile(destinationAbs, replacementDestination);
    await fs.utimes(destinationAbs, fixedCacheTime, fixedCacheTime);
    expect((await fs.stat(destinationAbs)).mtimeMs).toBe(cachedDestinationStat.mtimeMs);
    expect(await fs.readFile(destinationAbs, "utf8")).toBe(replacementDestination);
    // A restored mtime is no longer cache authority by itself: the private
    // source receipt must detect the same-size replacement before rename_note
    // snapshots the rollback bytes.
    expect((await vault.readNote(destinationAbs, cachedDestinationStat.mtimeMs)).content).toBe(replacementDestination);
    originals.set("Dest.md", replacementDestination);
    const abort = new AbortController();
    const writeNote = vault.writeNote.bind(vault);
    let rewrittenBacklinks = 0;
    vault.writeNote = async (...args: Parameters<Vault["writeNote"]>) => {
      const result = await writeNote(...args);
      const [relPath, content] = args;
      if (!abort.signal.aborted && relPath.startsWith("Caller-") && content.includes("[[Dest")) {
        rewrittenBacklinks += 1;
        abort.abort(new Error("deterministic post-rename cancellation"));
      }
      return result;
    };

    await expect(
      renameNote(vault, { from: "Source.md", to: "Dest.md", overwrite: true }, { signal: abort.signal })
    ).rejects.toBeInstanceOf(WriteRequestAbortedError);
    expect(rewrittenBacklinks).toBe(1);
    for (const [name, content] of originals) {
      expect(await fs.readFile(path.join(root, name), "utf8")).toBe(content);
    }

    // A lowercase-equivalent destination can still be a distinct file on a
    // case-sensitive filesystem. Cancellation after the destructive forward
    // rename must restore both directory entries, not just move source back.
    const upperCaseDir = path.join(root, "CancelCase");
    const lowerCaseDir = path.join(root, "cancelcase");
    await fs.mkdir(upperCaseDir, { recursive: true });
    const lowerCaseAliasBefore = await statOrNullIfMissing(lowerCaseDir);
    if (lowerCaseAliasBefore === null) {
      await fs.mkdir(lowerCaseDir, { recursive: true });
      const sourceRel = "CancelCase/Note.md";
      const destinationRel = "cancelcase/note.md";
      const sourceBytes = "# Cancellation source\n\ncancel-source sentinel\n\nSelf [[CancelCase/Note]].\n";
      const destinationBytes = Buffer.concat([
        Buffer.from("# Cancellation destination\n\ncancel-destination sentinel\n"),
        Buffer.from([0xff, 0xfe, 0x80, 0xc3, 0x28, 0x00, 0x0a])
      ]);
      expect(destinationBytes.includes(0xff)).toBe(true);
      await fs.writeFile(path.join(root, sourceRel), sourceBytes);
      await fs.writeFile(path.join(root, destinationRel), destinationBytes);

      const caseVault = new Vault(root, { enableWrite: true });
      await caseVault.ensureExists();
      const caseAbort = new AbortController();
      const renameFile = caseVault.renameFile.bind(caseVault);
      let forwardAbortCount = 0;
      caseVault.renameFile = async (...args: Parameters<Vault["renameFile"]>) => {
        const result = await renameFile(...args);
        if (forwardAbortCount === 0 && args[0] === sourceRel && args[1] === destinationRel) {
          forwardAbortCount += 1;
          caseAbort.abort(new Error("deterministic case-distinct post-rename cancellation"));
        }
        return result;
      };

      await expect(
        renameNote(caseVault, { from: sourceRel, to: destinationRel, overwrite: true }, { signal: caseAbort.signal })
      ).rejects.toBeInstanceOf(WriteRequestAbortedError);
      expect(forwardAbortCount).toBe(1);
      expect(await fs.readFile(path.join(root, sourceRel), "utf8")).toBe(sourceBytes);
      expect(await fs.readFile(path.join(root, destinationRel))).toEqual(destinationBytes);
    } else if (process.platform === "linux" && process.env.CI) {
      throw new Error("mandatory Linux case-sensitive filesystem precondition failed for CancelCase/cancelcase");
    }

    // Third phase — the reverse rename FAILS and the source has NO
    // self-reference, so nothing else holds its bytes. Before the fix the
    // destination snapshot was restored unconditionally whenever the forward
    // rename had happened, overwriting the only surviving copy of the source and
    // destroying the note permanently. This phase is the causal negative
    // control: it fails if the `sourceAbsent` guard in src/tools/write.ts is
    // removed. The fourth phase below is its counterpart — the case where the
    // source IS recoverable and the destination therefore MUST still be
    // restored.
    const reverseRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-reverse-fail-"));
    try {
      const sourceContent = "# Source\n\nSOURCE-CONTENT-SENTINEL\n";
      await fs.writeFile(path.join(reverseRoot, "Source.md"), sourceContent);
      await fs.writeFile(path.join(reverseRoot, "Dest.md"), "# Dest\n\nDEST-ORIGINAL-SENTINEL\n");
      await fs.writeFile(path.join(reverseRoot, "Caller-A.md"), "A points to [[Source]].\n");
      const reverseVault = new Vault(reverseRoot, { enableWrite: true });
      await reverseVault.ensureExists();

      const reverseAbort = new AbortController();
      const reverseWrite = reverseVault.writeNote.bind(reverseVault);
      reverseVault.writeNote = async (...args: Parameters<Vault["writeNote"]>) => {
        const result = await reverseWrite(...args);
        const [relPath, content] = args;
        if (!reverseAbort.signal.aborted && relPath.startsWith("Caller-") && content.includes("[[Dest")) {
          reverseAbort.abort(new Error("deterministic post-rename cancellation"));
        }
        return result;
      };
      const reverseRename = reverseVault.renameFile.bind(reverseVault);
      let reverseAttempts = 0;
      reverseVault.renameFile = async (...args: Parameters<Vault["renameFile"]>) => {
        const [from, to] = args;
        if (from === "Dest.md" && to === "Source.md") {
          reverseAttempts += 1;
          throw new Error("deterministic reverse-rename failure");
        }
        return reverseRename(...args);
      };

      const rejection = await renameNote(
        reverseVault,
        { from: "Source.md", to: "Dest.md", overwrite: true },
        { signal: reverseAbort.signal }
      ).then(
        () => null,
        (err: unknown) => err
      );
      // `throwCancelledAfterRollback` throws a plain Error rather than
      // WriteRequestAbortedError whenever the failure list is non-empty.
      expect(rejection).toBeInstanceOf(Error);
      expect(rejection).not.toBeInstanceOf(WriteRequestAbortedError);
      expect(reverseAttempts).toBe(1);

      // THE PROPERTY: the source note's content still exists on disk. It is
      // stuck at the destination path, but it was not overwritten.
      expect(await fs.readFile(path.join(reverseRoot, "Dest.md"), "utf8")).toBe(sourceContent);
      expect(await statOrNullIfMissing(path.join(reverseRoot, "Source.md"))).toBeNull();

      const message = rejection instanceof Error ? rejection.message : String(rejection);
      expect(message).toContain("rollback failed");
      expect(message).toContain("deterministic reverse-rename failure");
      expect(message).toContain("pre-rename destination bytes NOT restored");
      // The corrected wording, not just the shared prefix: the refused branch is
      // now reached by PROVEN absence of the source, not by a failed reverse.
      expect(message).toContain("no regular file is present at");
      expect(message).toContain("saved at");
      expect(message).toContain(".enquire-rollback/Dest.md");
      expect(message).not.toContain("NOT recoverable");
      expect(await fs.readFile(path.join(reverseRoot, ".enquire-rollback", "Dest.md"), "utf8")).toContain(
        "DEST-ORIGINAL-SENTINEL"
      );
      // The destination's own pre-rename bytes are deliberately NOT written back
      // here: they exist at the recovery path, while the source exists only on
      // disk at this path, so preserving the source is the correct trade.
      expect(await fs.readFile(path.join(reverseRoot, "Dest.md"), "utf8")).not.toContain("DEST-ORIGINAL");
    } finally {
      await fs.rm(reverseRoot, { recursive: true, force: true });
    }

    // Fourth phase — the reverse rename fails, but the source note DOES carry a
    // self-reference, so the `sourcePlan` rollback recreates it at the old path.
    // The source is then safe and the destination snapshot MUST still be
    // restored. Guarding on "did the reverse rename return?" instead of "does
    // the source exist?" silently abandons the destination here, which is a
    // regression against the pre-fix behaviour rather than a fix — this phase is
    // the positive control that pins it.
    const recoverableRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-reverse-recover-"));
    try {
      const selfRefSource = "# Source\n\nSelf [[Source]] plus SOURCE-RECOVERABLE-SENTINEL\n";
      const destinationOriginal = "# Dest\n\nDEST-MUST-SURVIVE-SENTINEL\n";
      await fs.writeFile(path.join(recoverableRoot, "Source.md"), selfRefSource);
      await fs.writeFile(path.join(recoverableRoot, "Dest.md"), destinationOriginal);
      await fs.writeFile(path.join(recoverableRoot, "Caller-A.md"), "A points to [[Source]].\n");
      const recoverVault = new Vault(recoverableRoot, { enableWrite: true });
      await recoverVault.ensureExists();

      const recoverAbort = new AbortController();
      const recoverWrite = recoverVault.writeNote.bind(recoverVault);
      recoverVault.writeNote = async (...args: Parameters<Vault["writeNote"]>) => {
        const result = await recoverWrite(...args);
        const [relPath, content] = args;
        if (!recoverAbort.signal.aborted && relPath.startsWith("Caller-") && content.includes("[[Dest")) {
          recoverAbort.abort(new Error("deterministic post-rename cancellation"));
        }
        return result;
      };
      const recoverRename = recoverVault.renameFile.bind(recoverVault);
      let recoverForward = 0;
      let recoverReverse = 0;
      recoverVault.renameFile = async (...args: Parameters<Vault["renameFile"]>) => {
        const [from, to] = args;
        if (from === "Dest.md" && to === "Source.md") {
          recoverReverse += 1;
          throw new Error("deterministic reverse-rename failure");
        }
        recoverForward += 1;
        return recoverRename(...args);
      };

      const recoverRejection = await renameNote(
        recoverVault,
        { from: "Source.md", to: "Dest.md", overwrite: true },
        { signal: recoverAbort.signal }
      ).then(
        () => null,
        (err: unknown) => err
      );
      // Witnesses: the path really executed. Without these the phase would pass
      // against a preflight refusal or any no-op that never renamed at all,
      // because both final properties are already true before the call.
      expect(recoverForward).toBe(1);
      expect(recoverReverse).toBe(1);
      expect(recoverRejection).toBeInstanceOf(Error);

      // Both notes survive: the source was recreated by its self-reference
      // rollback, so restoring the destination destroys nothing.
      // Exact bytes, not just the sentinel: a rollback that restored the
      // REWRITTEN form would keep the sentinel while leaving `[[Dest]]` behind.
      expect(await fs.readFile(path.join(recoverableRoot, "Source.md"), "utf8")).toBe(selfRefSource);
      expect(await fs.readFile(path.join(recoverableRoot, "Dest.md"), "utf8")).toBe(destinationOriginal);
    } finally {
      await fs.rm(recoverableRoot, { recursive: true, force: true });
    }

    // Fifth phase — the reverse rename fails AND a concurrent actor plants
    // `fromRel` as a symlink pointing at the destination. `Vault.stat` would
    // realpath through that link and read PRESENT, so the restore would
    // overwrite the renamed content. The public non-following probe must
    // treat the symlink as not a regular file and withhold the restore. The
    // symlink is planted in the reverse-rename wrapper, before the probe,
    // so wrapping `lstatIfExistsPublic` cannot fake a pass against `stat`.
    const followRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-source-symlink-"));
    try {
      const sourceContent = "# Source\n\nSOURCE-SYMLINK-SENTINEL\n";
      await fs.writeFile(path.join(followRoot, "Source.md"), sourceContent);
      await fs.writeFile(path.join(followRoot, "Dest.md"), "# Dest\n\nDEST-MUST-NOT-RESTORE\n");
      await fs.writeFile(path.join(followRoot, "Caller-A.md"), "A points to [[Source]].\n");
      const followVault = new Vault(followRoot, { enableWrite: true });
      await followVault.ensureExists();

      const followAbort = new AbortController();
      const followWrite = followVault.writeNote.bind(followVault);
      followVault.writeNote = async (...args: Parameters<Vault["writeNote"]>) => {
        const result = await followWrite(...args);
        const [relPath, content] = args;
        if (!followAbort.signal.aborted && relPath.startsWith("Caller-") && content.includes("[[Dest")) {
          followAbort.abort(new Error("deterministic post-rename cancellation"));
        }
        return result;
      };
      const followRename = followVault.renameFile.bind(followVault);
      let followReverse = 0;
      followVault.renameFile = async (...args: Parameters<Vault["renameFile"]>) => {
        const [from, to] = args;
        if (from === "Dest.md" && to === "Source.md") {
          followReverse += 1;
          await fs.symlink("Dest.md", path.join(followRoot, "Source.md"), "file");
          throw new Error("deterministic reverse-rename failure");
        }
        return followRename(...args);
      };

      const followRejection = await renameNote(
        followVault,
        { from: "Source.md", to: "Dest.md", overwrite: true },
        { signal: followAbort.signal }
      ).then(
        () => null,
        (err: unknown) => err
      );
      expect(followReverse).toBe(1);
      expect(followRejection).toBeInstanceOf(Error);
      expect(followRejection).not.toBeInstanceOf(WriteRequestAbortedError);
      expect(await fs.readFile(path.join(followRoot, "Dest.md"), "utf8")).toBe(sourceContent);
      const followMessage = followRejection instanceof Error ? followRejection.message : String(followRejection);
      expect(followMessage).toContain("pre-rename destination bytes NOT restored");
      expect(followMessage).toContain(".enquire-rollback/Dest.md");
      expect(await fs.readFile(path.join(followRoot, ".enquire-rollback", "Dest.md"), "utf8")).toContain(
        "DEST-MUST-NOT-RESTORE"
      );
      const planted = await fs.lstat(path.join(followRoot, "Source.md"));
      expect(planted.isSymbolicLink()).toBe(true);
      expect(await followVault.lstatIfExistsPublic("Source.md")).toEqual(
        expect.objectContaining({ isFile: false, isSymbolicLink: true })
      );
    } finally {
      await fs.rm(followRoot, { recursive: true, force: true });
    }

    // Sixth phase — the reverse rename fails AND the vacated source parent is
    // replaced with a regular file, so the probe path is `ENOTDIR`. Missing
    // is still proven: a parent component is not a directory, so the leaf
    // cannot exist. This would also pass against `Vault.stat`; the fifth phase
    // is the causal control for the non-following probe.
    const enotdirRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-enotdir-probe-"));
    try {
      const sourceContent = "# Source\n\nSOURCE-ENOTDIR-SENTINEL\n";
      await fs.mkdir(path.join(enotdirRoot, "Folder"));
      await fs.writeFile(path.join(enotdirRoot, "Folder", "Source.md"), sourceContent);
      await fs.writeFile(path.join(enotdirRoot, "Dest.md"), "# Dest\n\nDEST-MUST-NOT-RESTORE\n");
      await fs.writeFile(path.join(enotdirRoot, "Caller-A.md"), "A points to [[Folder/Source]].\n");
      const enotdirVault = new Vault(enotdirRoot, { enableWrite: true });
      await enotdirVault.ensureExists();

      const enotdirAbort = new AbortController();
      const enotdirWrite = enotdirVault.writeNote.bind(enotdirVault);
      enotdirVault.writeNote = async (...args: Parameters<Vault["writeNote"]>) => {
        const result = await enotdirWrite(...args);
        const [relPath, content] = args;
        if (!enotdirAbort.signal.aborted && relPath.startsWith("Caller-") && content.includes("[[Dest")) {
          enotdirAbort.abort(new Error("deterministic post-rename cancellation"));
        }
        return result;
      };
      const enotdirRename = enotdirVault.renameFile.bind(enotdirVault);
      let enotdirReverse = 0;
      enotdirVault.renameFile = async (...args: Parameters<Vault["renameFile"]>) => {
        const [from, to] = args;
        if (from === "Dest.md" && to === "Folder/Source.md") {
          enotdirReverse += 1;
          await fs.rm(path.join(enotdirRoot, "Folder"), { recursive: true, force: true });
          await fs.writeFile(path.join(enotdirRoot, "Folder"), "not-a-directory");
          throw new Error("deterministic reverse-rename failure");
        }
        return enotdirRename(...args);
      };

      const enotdirRejection = await renameNote(
        enotdirVault,
        { from: "Folder/Source.md", to: "Dest.md", overwrite: true },
        { signal: enotdirAbort.signal }
      ).then(
        () => null,
        (err: unknown) => err
      );
      expect(enotdirReverse).toBe(1);
      expect(enotdirRejection).toBeInstanceOf(Error);
      expect(enotdirRejection).not.toBeInstanceOf(WriteRequestAbortedError);
      expect(await fs.readFile(path.join(enotdirRoot, "Dest.md"), "utf8")).toBe(sourceContent);
      const enotdirMessage = enotdirRejection instanceof Error ? enotdirRejection.message : String(enotdirRejection);
      expect(enotdirMessage).toContain("pre-rename destination bytes NOT restored");
      expect(enotdirMessage).toContain(".enquire-rollback/Dest.md");
      expect(await fs.readFile(path.join(enotdirRoot, ".enquire-rollback", "Dest.md"), "utf8")).toContain(
        "DEST-MUST-NOT-RESTORE"
      );
    } finally {
      await fs.rm(enotdirRoot, { recursive: true, force: true });
    }
  });

  it("(negative-control) the same replace fixture commits fully when its signal remains active", async () => {
    await Promise.all([
      fs.writeFile(path.join(root, "a.md"), "REPLACEME a\n"),
      fs.writeFile(path.join(root, "b.md"), "REPLACEME b\n")
    ]);
    const vault = new Vault(root, { enableWrite: true });
    await vault.ensureExists();
    const out = await replaceInNotes(
      vault,
      { search: "REPLACEME", replace: "REPLACED" },
      { signal: new AbortController().signal }
    );

    expect(out.files_updated).toHaveLength(2);
    expect(await fs.readFile(path.join(root, "a.md"), "utf8")).toBe("REPLACED a\n");
    expect(await fs.readFile(path.join(root, "b.md"), "utf8")).toBe("REPLACED b\n");
  });
});
