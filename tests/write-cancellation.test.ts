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

function recoveryPathIn(message: string, basename: string): string {
  const escapedBasename = basename.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const found = message.match(new RegExp(`\\.enquire-rollback/[0-9a-f]{32}/${escapedBasename}`, "u"))?.[0];
  if (found === undefined) throw new Error(`Missing rollback recovery path for ${basename}: ${message}`);
  return found;
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
      const destinationRecovery = recoveryPathIn(message, "Dest.md");
      expect(message).not.toContain("NOT recoverable");
      expect(await fs.readFile(path.join(reverseRoot, destinationRecovery), "utf8")).toContain(
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
      const destinationRecovery = recoveryPathIn(followMessage, "Dest.md");
      expect(await fs.readFile(path.join(followRoot, destinationRecovery), "utf8")).toContain("DEST-MUST-NOT-RESTORE");
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
      const destinationRecovery = recoveryPathIn(enotdirMessage, "Dest.md");
      expect(await fs.readFile(path.join(enotdirRoot, destinationRecovery), "utf8")).toContain("DEST-MUST-NOT-RESTORE");
    } finally {
      await fs.rm(enotdirRoot, { recursive: true, force: true });
    }

    // Seventh phase — A13. Reverse rename fails AFTER a concurrent regular file
    // occupies vacated `fromRel`. Source carries a self-reference, so
    // sourcePlan would restore with overwrite:true and destroy the occupant.
    // Vacant reverse-fail still recreates (fourth phase). Occupant must survive;
    // dest restore is also withheld so the renamed note at Dest.md is not
    // overwritten on the strength of the occupant looking like a present source.
    const occupantRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-source-occupant-"));
    try {
      const selfRefSource = "# Source\n\nSelf [[Source]] plus SOURCE-OCCUPANT-SENTINEL\n";
      const destinationOriginal = "# Dest\n\nDEST-MUST-STAY-AT-RENAMED-SOURCE\n";
      await fs.writeFile(path.join(occupantRoot, "Source.md"), selfRefSource);
      await fs.writeFile(path.join(occupantRoot, "Dest.md"), destinationOriginal);
      await fs.writeFile(path.join(occupantRoot, "Caller-A.md"), "A points to [[Source]].\n");
      const occupantVault = new Vault(occupantRoot, { enableWrite: true });
      await occupantVault.ensureExists();

      const occupantAbort = new AbortController();
      const occupantWrite = occupantVault.writeNote.bind(occupantVault);
      occupantVault.writeNote = async (...args: Parameters<Vault["writeNote"]>) => {
        const result = await occupantWrite(...args);
        const [relPath, content] = args;
        if (!occupantAbort.signal.aborted && relPath.startsWith("Caller-") && content.includes("[[Dest")) {
          occupantAbort.abort(new Error("deterministic post-rename cancellation"));
        }
        return result;
      };
      const occupantRename = occupantVault.renameFile.bind(occupantVault);
      let occupantReverse = 0;
      occupantVault.renameFile = async (...args: Parameters<Vault["renameFile"]>) => {
        const [from, to] = args;
        if (from === "Dest.md" && to === "Source.md") {
          occupantReverse += 1;
          await fs.writeFile(path.join(occupantRoot, "Source.md"), "OCCUPANT-SENTINEL\n");
          throw new Error("deterministic reverse-rename failure");
        }
        return occupantRename(...args);
      };

      const occupantRejection = await renameNote(
        occupantVault,
        { from: "Source.md", to: "Dest.md", overwrite: true },
        { signal: occupantAbort.signal }
      ).then(
        () => null,
        (err: unknown) => err
      );
      expect(occupantReverse).toBe(1);
      expect(occupantRejection).toBeInstanceOf(Error);
      expect(occupantRejection).not.toBeInstanceOf(WriteRequestAbortedError);
      expect(await fs.readFile(path.join(occupantRoot, "Source.md"), "utf8")).toBe("OCCUPANT-SENTINEL\n");
      expect(await fs.readFile(path.join(occupantRoot, "Dest.md"), "utf8")).toContain("SOURCE-OCCUPANT-SENTINEL");
      expect(await fs.readFile(path.join(occupantRoot, "Dest.md"), "utf8")).not.toContain(
        "DEST-MUST-STAY-AT-RENAMED-SOURCE"
      );
      const occupantMessage =
        occupantRejection instanceof Error ? occupantRejection.message : String(occupantRejection);
      expect(occupantMessage).toContain("pre-rename source bytes NOT restored");
      const sourceRecovery = recoveryPathIn(occupantMessage, "Source.md");
      expect(occupantMessage).toContain("pre-rename destination bytes NOT restored");
      const destinationRecovery = recoveryPathIn(occupantMessage, "Dest.md");
      expect(occupantMessage).not.toContain("no regular file is present");
      expect(await fs.readFile(path.join(occupantRoot, sourceRecovery), "utf8")).toBe(selfRefSource);
      expect(await fs.readFile(path.join(occupantRoot, destinationRecovery), "utf8")).toContain(
        "DEST-MUST-STAY-AT-RENAMED-SOURCE"
      );
    } finally {
      await fs.rm(occupantRoot, { recursive: true, force: true });
    }

    // Eighth phase — A13 dest withhold without sourcePlan. Reverse fails AFTER a
    // concurrent regular file occupies vacated `fromRel`, and the source has NO
    // self-reference. Source restore would not run, but dest probe would read the
    // occupant as PRESENT and restore dest original over the only copy of the
    // renamed note. Occupant dest withhold must not depend on sourcePlan.
    const noSelfOccupantRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-noself-occupant-"));
    try {
      const sourceContent = "# Source\n\nSOURCE-NOSELF-OCCUPANT-SENTINEL\n";
      await fs.writeFile(path.join(noSelfOccupantRoot, "Source.md"), sourceContent);
      await fs.writeFile(path.join(noSelfOccupantRoot, "Dest.md"), "# Dest\n\nDEST-NOSELF-OCCUPANT-MUST-NOT-RESTORE\n");
      await fs.writeFile(path.join(noSelfOccupantRoot, "Caller-A.md"), "A points to [[Source]].\n");
      const noSelfOccupantVault = new Vault(noSelfOccupantRoot, { enableWrite: true });
      await noSelfOccupantVault.ensureExists();

      const noSelfAbort = new AbortController();
      const noSelfWrite = noSelfOccupantVault.writeNote.bind(noSelfOccupantVault);
      noSelfOccupantVault.writeNote = async (...args: Parameters<Vault["writeNote"]>) => {
        const result = await noSelfWrite(...args);
        const [relPath, content] = args;
        if (!noSelfAbort.signal.aborted && relPath.startsWith("Caller-") && content.includes("[[Dest")) {
          noSelfAbort.abort(new Error("deterministic post-rename cancellation"));
        }
        return result;
      };
      const noSelfRename = noSelfOccupantVault.renameFile.bind(noSelfOccupantVault);
      let noSelfReverse = 0;
      noSelfOccupantVault.renameFile = async (...args: Parameters<Vault["renameFile"]>) => {
        const [from, to] = args;
        if (from === "Dest.md" && to === "Source.md") {
          noSelfReverse += 1;
          await fs.writeFile(path.join(noSelfOccupantRoot, "Source.md"), "OCCUPANT-NOSELF-SENTINEL\n");
          throw new Error("deterministic reverse-rename failure");
        }
        return noSelfRename(...args);
      };

      const noSelfRejection = await renameNote(
        noSelfOccupantVault,
        { from: "Source.md", to: "Dest.md", overwrite: true },
        { signal: noSelfAbort.signal }
      ).then(
        () => null,
        (err: unknown) => err
      );
      expect(noSelfReverse).toBe(1);
      expect(noSelfRejection).toBeInstanceOf(Error);
      expect(noSelfRejection).not.toBeInstanceOf(WriteRequestAbortedError);
      expect(await fs.readFile(path.join(noSelfOccupantRoot, "Source.md"), "utf8")).toBe("OCCUPANT-NOSELF-SENTINEL\n");
      expect(await fs.readFile(path.join(noSelfOccupantRoot, "Dest.md"), "utf8")).toBe(sourceContent);
      const noSelfMessage = noSelfRejection instanceof Error ? noSelfRejection.message : String(noSelfRejection);
      expect(noSelfMessage).toContain("pre-rename destination bytes NOT restored");
      const destinationRecovery = recoveryPathIn(noSelfMessage, "Dest.md");
      expect(noSelfMessage).not.toContain("no regular file is present");
      expect(noSelfMessage).not.toContain("pre-rename source bytes NOT restored");
      expect(await fs.readFile(path.join(noSelfOccupantRoot, destinationRecovery), "utf8")).toContain(
        "DEST-NOSELF-OCCUPANT-MUST-NOT-RESTORE"
      );
      const recoveryEntries = await fs.readdir(path.join(noSelfOccupantRoot, ".enquire-rollback"), { recursive: true });
      expect(recoveryEntries.some((entry) => entry.replace(/\\/g, "/").endsWith("/Source.md"))).toBe(false);
    } finally {
      await fs.rm(noSelfOccupantRoot, { recursive: true, force: true });
    }

    // Ninth phase — the first post-reverse probe sees the source path vacant,
    // then a regular-file occupant appears before the destination probe. Mere
    // presence at the second probe cannot prove that the failed reverse
    // returned the renamed bytes. The destination must remain untouched while
    // the original destination snapshot goes to recovery.
    const lateOccupantRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-late-source-occupant-"));
    try {
      const sourceContent = "# Source\n\nSOURCE-LATE-OCCUPANT-SENTINEL\n";
      const destinationContent = "# Dest\n\nDEST-LATE-OCCUPANT-MUST-NOT-RESTORE\n";
      const occupantContent = "LATE-OCCUPANT-SENTINEL\n";
      await fs.writeFile(path.join(lateOccupantRoot, "Source.md"), sourceContent);
      await fs.writeFile(path.join(lateOccupantRoot, "Dest.md"), destinationContent);
      await fs.writeFile(path.join(lateOccupantRoot, "Caller-A.md"), "A points to [[Source]].\n");
      const lateOccupantVault = new Vault(lateOccupantRoot, { enableWrite: true });
      await lateOccupantVault.ensureExists();

      const lateAbort = new AbortController();
      const lateWrite = lateOccupantVault.writeNote.bind(lateOccupantVault);
      lateOccupantVault.writeNote = async (...args: Parameters<Vault["writeNote"]>) => {
        const result = await lateWrite(...args);
        const [relPath, content] = args;
        if (!lateAbort.signal.aborted && relPath.startsWith("Caller-") && content.includes("[[Dest")) {
          lateAbort.abort(new Error("deterministic post-rename cancellation"));
        }
        return result;
      };
      const lateRename = lateOccupantVault.renameFile.bind(lateOccupantVault);
      lateOccupantVault.renameFile = async (...args: Parameters<Vault["renameFile"]>) => {
        if (args[0] === "Dest.md" && args[1] === "Source.md") {
          throw new Error("deterministic reverse-rename failure");
        }
        return lateRename(...args);
      };
      const lateLstat = lateOccupantVault.lstatIfExistsPublic.bind(lateOccupantVault);
      let lateProbeCount = 0;
      lateOccupantVault.lstatIfExistsPublic = async (...args: Parameters<Vault["lstatIfExistsPublic"]>) => {
        lateProbeCount += 1;
        if (lateProbeCount === 1) return null;
        if (lateProbeCount === 2) {
          await fs.writeFile(path.join(lateOccupantRoot, "Source.md"), occupantContent);
        }
        return lateLstat(...args);
      };

      const lateRejection = await renameNote(
        lateOccupantVault,
        { from: "Source.md", to: "Dest.md", overwrite: true },
        { signal: lateAbort.signal }
      ).then(
        () => null,
        (error: unknown) => error
      );

      expect(lateProbeCount).toBe(2);
      expect(lateRejection).toBeInstanceOf(Error);
      expect(await fs.readFile(path.join(lateOccupantRoot, "Source.md"), "utf8")).toBe(occupantContent);
      expect(await fs.readFile(path.join(lateOccupantRoot, "Dest.md"), "utf8")).toBe(sourceContent);
      const lateMessage = lateRejection instanceof Error ? lateRejection.message : String(lateRejection);
      expect(lateMessage).toContain("no source snapshot restore committed");
      const destinationRecovery = recoveryPathIn(lateMessage, "Dest.md");
      expect(await fs.readFile(path.join(lateOccupantRoot, destinationRecovery), "utf8")).toBe(destinationContent);
    } finally {
      await fs.rm(lateOccupantRoot, { recursive: true, force: true });
    }

    // Tenth phase — CL-A13. Every occupant phase above makes the reverse rename
    // THROW, so none of them ever runs the real reverse against an occupied
    // `fromRel`. That is the gap: the reverse used to be issued with
    // `overwrite: true`, so with an occupant present it SUCCEEDED by destroying
    // it via rename(2) — no snapshot, no recovery copy, and rollback still
    // reported success. Here the occupant is planted and the real reverse runs.
    // Causal control: restoring `overwrite: true` in src/tools/write.ts makes the
    // occupant assertion fail.
    const liveOccupantRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-live-occupant-"));
    try {
      const liveSource = "# Source\n\nSOURCE-LIVE-OCCUPANT-SENTINEL\n";
      const liveOccupant = "OCCUPANT-MUST-SURVIVE\n";
      await fs.writeFile(path.join(liveOccupantRoot, "Source.md"), liveSource);
      await fs.writeFile(path.join(liveOccupantRoot, "Dest.md"), "# Dest\n\nDEST-ORIGINAL\n");
      await fs.writeFile(path.join(liveOccupantRoot, "Caller-A.md"), "A points to [[Source]].\n");
      const liveVault = new Vault(liveOccupantRoot, { enableWrite: true });
      await liveVault.ensureExists();

      const liveCtl = new AbortController();
      const liveWrite = liveVault.writeNote.bind(liveVault);
      liveVault.writeNote = async (...args: Parameters<Vault["writeNote"]>) => {
        const result = await liveWrite(...args);
        const [relPath, content] = args;
        if (!liveCtl.signal.aborted && relPath.startsWith("Caller-") && content.includes("[[Dest")) {
          liveCtl.abort(new Error("deterministic post-rename cancellation"));
        }
        return result;
      };
      const liveRename = liveVault.renameFile.bind(liveVault);
      let liveReverseAttempts = 0;
      liveVault.renameFile = async (...args: Parameters<Vault["renameFile"]>) => {
        const [from, to] = args;
        if (from === "Dest.md" && to === "Source.md") {
          liveReverseAttempts += 1;
          // Plant the occupant, then let the REAL reverse rename run against it.
          await fs.writeFile(path.join(liveOccupantRoot, "Source.md"), liveOccupant);
        }
        return liveRename(...args);
      };

      const liveRejection = await renameNote(
        liveVault,
        { from: "Source.md", to: "Dest.md", overwrite: true },
        { signal: liveCtl.signal }
      ).then(
        () => null,
        (error: unknown) => error
      );

      expect(liveReverseAttempts).toBe(1);
      expect(liveRejection).toBeInstanceOf(Error);
      // THE PROPERTY: the concurrent occupant is a file this operation never
      // owned. It must still be on disk, byte-identical.
      expect(await fs.readFile(path.join(liveOccupantRoot, "Source.md"), "utf8")).toBe(liveOccupant);
      // And the renamed note is not silently gone: it is either still at the
      // destination or preserved under the recovery namespace.
      const liveMessage = liveRejection instanceof Error ? liveRejection.message : String(liveRejection);
      const liveDestKeptRenamed = (await fs.readFile(path.join(liveOccupantRoot, "Dest.md"), "utf8")).includes(
        "SOURCE-LIVE-OCCUPANT-SENTINEL"
      );
      expect(liveDestKeptRenamed || liveMessage.includes("NOT restored")).toBe(true);
    } finally {
      await fs.rm(liveOccupantRoot, { recursive: true, force: true });
    }
  });

  it("rename_note withholds destination restore when the source probe is inconclusive", async () => {
    const sourceContent = "# Source\n\nSOURCE-EIO-SENTINEL\n";
    const destinationContent = "# Destination\n\nDESTINATION-EIO-SENTINEL\n";
    await fs.writeFile(path.join(root, "Source.md"), sourceContent);
    await fs.writeFile(path.join(root, "Dest.md"), destinationContent);
    await fs.writeFile(path.join(root, "Caller.md"), "Points to [[Source]].\n");

    const vault = new Vault(root, { enableWrite: true });
    await vault.ensureExists();
    const abort = new AbortController();
    const writeNote = vault.writeNote.bind(vault);
    vault.writeNote = async (...args: Parameters<Vault["writeNote"]>) => {
      const result = await writeNote(...args);
      if (!abort.signal.aborted && args[0] === "Caller.md" && args[1].includes("[[Dest]]")) {
        abort.abort(new Error("deterministic post-rename cancellation"));
      }
      return result;
    };
    const renameFile = vault.renameFile.bind(vault);
    vault.renameFile = async (...args: Parameters<Vault["renameFile"]>) => {
      if (args[0] === "Dest.md" && args[1] === "Source.md") {
        throw new Error("deterministic reverse-rename failure");
      }
      return renameFile(...args);
    };
    vault.lstatIfExistsPublic = async () => {
      throw Object.assign(new Error("deterministic source probe failure"), { code: "EIO" });
    };

    const rejection = await renameNote(
      vault,
      { from: "Source.md", to: "Dest.md", overwrite: true },
      { signal: abort.signal }
    ).then(
      () => null,
      (error: unknown) => error
    );

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).not.toBeInstanceOf(WriteRequestAbortedError);
    expect(await statOrNullIfMissing(path.join(root, "Source.md"))).toBeNull();
    expect(await fs.readFile(path.join(root, "Dest.md"), "utf8")).toBe(sourceContent);
    const message = rejection instanceof Error ? rejection.message : String(rejection);
    expect(message).toContain("pre-rename destination bytes NOT restored");
    expect(message).toContain("could not confirm whether a regular file is present");
    const recoveryMatch = message.match(/saved at ([^ ]+)/u);
    expect(recoveryMatch?.[1]).toBeDefined();
    expect(await fs.readFile(path.join(root, recoveryMatch?.[1] ?? ""), "utf8")).toBe(destinationContent);
  });

  it("rename_note does not overwrite an uninspectable source-path occupant", async () => {
    const sourceContent = "# Source\n\nSelf [[Source]] plus SOURCE-UNKNOWN-SENTINEL\n";
    const destinationContent = "# Destination\n\nDESTINATION-UNKNOWN-SENTINEL\n";
    const occupantContent = "CONCURRENT-OCCUPANT-MUST-SURVIVE\n";
    await fs.writeFile(path.join(root, "Source.md"), sourceContent);
    await fs.writeFile(path.join(root, "Dest.md"), destinationContent);
    await fs.writeFile(path.join(root, "Caller.md"), "Points to [[Source]].\n");

    const vault = new Vault(root, { enableWrite: true });
    await vault.ensureExists();
    const abort = new AbortController();
    const writeNote = vault.writeNote.bind(vault);
    vault.writeNote = async (...args: Parameters<Vault["writeNote"]>) => {
      const result = await writeNote(...args);
      if (!abort.signal.aborted && args[0] === "Caller.md" && args[1].includes("[[Dest]]")) {
        abort.abort(new Error("deterministic post-rename cancellation"));
      }
      return result;
    };
    const renameFile = vault.renameFile.bind(vault);
    vault.renameFile = async (...args: Parameters<Vault["renameFile"]>) => {
      if (args[0] === "Dest.md" && args[1] === "Source.md") {
        await fs.writeFile(path.join(root, "Source.md"), occupantContent);
        throw new Error("deterministic reverse-rename failure");
      }
      return renameFile(...args);
    };
    vault.lstatIfExistsPublic = async () => {
      throw Object.assign(new Error("deterministic source probe failure"), { code: "EIO" });
    };

    const rejection = await renameNote(
      vault,
      { from: "Source.md", to: "Dest.md", overwrite: true },
      { signal: abort.signal }
    ).then(
      () => null,
      (error: unknown) => error
    );

    expect(rejection).toBeInstanceOf(Error);
    expect(await fs.readFile(path.join(root, "Source.md"), "utf8")).toBe(occupantContent);
    expect(await fs.readFile(path.join(root, "Dest.md"), "utf8")).toContain("SOURCE-UNKNOWN-SENTINEL");
    const message = rejection instanceof Error ? rejection.message : String(rejection);
    const sourceRecovery = recoveryPathIn(message, "Source.md");
    const destinationRecovery = recoveryPathIn(message, "Dest.md");
    expect(await fs.readFile(path.join(root, sourceRecovery), "utf8")).toBe(sourceContent);
    expect(await fs.readFile(path.join(root, destinationRecovery), "utf8")).toBe(destinationContent);

    // Recovery publication itself can fail (for example ENOSPC/EACCES). That
    // must not weaken either fail-closed overwrite decision or fabricate a
    // successful receipt: both withheld snapshots are reported unrecoverable
    // with the underlying cause, while the concurrent occupant and renamed
    // source remain untouched on their public paths.
    const recoveryFailureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-recovery-enospc-"));
    try {
      await fs.writeFile(path.join(recoveryFailureRoot, "Source.md"), sourceContent);
      await fs.writeFile(path.join(recoveryFailureRoot, "Dest.md"), destinationContent);
      await fs.writeFile(path.join(recoveryFailureRoot, "Caller.md"), "Points to [[Source]].\n");
      const recoveryFailureVault = new Vault(recoveryFailureRoot, { enableWrite: true });
      await recoveryFailureVault.ensureExists();
      const failureAbort = new AbortController();
      const failureWrite = recoveryFailureVault.writeNote.bind(recoveryFailureVault);
      recoveryFailureVault.writeNote = async (...args: Parameters<Vault["writeNote"]>) => {
        const result = await failureWrite(...args);
        if (!failureAbort.signal.aborted && args[0] === "Caller.md" && args[1].includes("[[Dest]]")) {
          failureAbort.abort(new Error("deterministic post-rename cancellation"));
        }
        return result;
      };
      const failureRename = recoveryFailureVault.renameFile.bind(recoveryFailureVault);
      recoveryFailureVault.renameFile = async (...args: Parameters<Vault["renameFile"]>) => {
        if (args[0] === "Dest.md" && args[1] === "Source.md") {
          await fs.writeFile(path.join(recoveryFailureRoot, "Source.md"), occupantContent);
          throw new Error("deterministic reverse-rename failure");
        }
        return failureRename(...args);
      };
      recoveryFailureVault.lstatIfExistsPublic = async () => {
        throw Object.assign(new Error("deterministic source probe failure"), { code: "EIO" });
      };
      const recoveryAttempts: string[] = [];
      recoveryFailureVault.writeRollbackRecoveryPublic = async (relPath) => {
        recoveryAttempts.push(relPath);
        throw Object.assign(new Error("deterministic rollback recovery ENOSPC"), { code: "ENOSPC" });
      };

      const failureRejection = await renameNote(
        recoveryFailureVault,
        { from: "Source.md", to: "Dest.md", overwrite: true },
        { signal: failureAbort.signal }
      ).then(
        () => null,
        (error: unknown) => error
      );

      expect(failureRejection).toBeInstanceOf(Error);
      expect(recoveryAttempts).toEqual(["Source.md", "Dest.md"]);
      expect(await fs.readFile(path.join(recoveryFailureRoot, "Source.md"), "utf8")).toBe(occupantContent);
      expect(await fs.readFile(path.join(recoveryFailureRoot, "Dest.md"), "utf8")).toContain("SOURCE-UNKNOWN-SENTINEL");
      const failureMessage = failureRejection instanceof Error ? failureRejection.message : String(failureRejection);
      expect(failureMessage.match(/NOT recoverable/gu)).toHaveLength(2);
      expect(failureMessage.match(/deterministic rollback recovery ENOSPC/gu)).toHaveLength(2);
      expect(failureMessage).not.toContain("saved at");
      await expect(fs.lstat(path.join(recoveryFailureRoot, ".enquire-rollback"))).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await fs.rm(recoveryFailureRoot, { recursive: true, force: true });
    }
  });

  it("rollback recovery files are append-only and reject a planted recovery-root symlink", async () => {
    const vault = new Vault(root, { enableWrite: true });
    await vault.ensureExists();

    const first = await vault.writeRollbackRecoveryPublic("Folder/Dest.md", Buffer.from("first recovery\n"));
    const second = await vault.writeRollbackRecoveryPublic("Folder/Dest.md", Buffer.from("second recovery\n"));
    expect(second).not.toBe(first);
    expect(await fs.readFile(path.join(root, first), "utf8")).toBe("first recovery\n");
    expect(await fs.readFile(path.join(root, second), "utf8")).toBe("second recovery\n");

    const filteredRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-recovery-filters-"));
    try {
      await fs.mkdir(path.join(filteredRoot, "Public", "Denied"), { recursive: true });
      await fs.mkdir(path.join(filteredRoot, "Private"));
      const filteredVault = new Vault(filteredRoot, {
        enableWrite: true,
        readPaths: ["Public/**"],
        excludeGlobs: [".enquire-rollback/**", "Public/Denied/**"]
      });
      await filteredVault.ensureExists();

      // Recovery is authorized by the already-admitted public snapshot path.
      // The derived hidden path need not match the public allowlist and an
      // explicit deny-glob for the hidden namespace cannot discard its bytes.
      const admitted = await filteredVault.writeRollbackRecoveryPublic(
        "Public/Dest.md",
        Buffer.from("allowlisted recovery\n")
      );
      expect(await fs.readFile(path.join(filteredRoot, admitted), "utf8")).toBe("allowlisted recovery\n");
      await expect(filteredVault.readNote(admitted)).rejects.toThrow(/hidden or reserved vault path/i);

      // NEGATIVE controls: bypassing filters for the derived internal path
      // must not authorize a snapshot whose original public path was denied.
      const namespacesBeforeDeniedWrites = await fs.readdir(path.join(filteredRoot, ".enquire-rollback"));
      await expect(
        filteredVault.writeRollbackRecoveryPublic("Private/Dest.md", Buffer.from("must not be written\n"))
      ).rejects.toThrow(/--read-paths allowlist/i);
      await expect(
        filteredVault.writeRollbackRecoveryPublic("Public/Denied/Dest.md", Buffer.from("must not be written\n"))
      ).rejects.toThrow(/--exclude-glob denylist/i);
      expect(await fs.readdir(path.join(filteredRoot, ".enquire-rollback"))).toEqual(namespacesBeforeDeniedWrites);
    } finally {
      await fs.rm(filteredRoot, { recursive: true, force: true });
    }

    const symlinkRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-recovery-symlink-"));
    try {
      const targetDir = path.join(symlinkRoot, "UserNotes");
      const recoveryRoot = path.join(symlinkRoot, ".enquire-rollback");
      await fs.mkdir(targetDir);
      await fs.writeFile(path.join(targetDir, "sentinel.md"), "must remain unchanged\n");
      await fs.symlink(
        process.platform === "win32" ? targetDir : "UserNotes",
        recoveryRoot,
        process.platform === "win32" ? "junction" : "dir"
      );
      const symlinkVault = new Vault(symlinkRoot, { enableWrite: true });
      await symlinkVault.ensureExists();

      await expect(
        symlinkVault.writeRollbackRecoveryPublic("sentinel.md", Buffer.from("must not be written\n"))
      ).rejects.toThrow(/rollback recovery root.*real directory/i);
      expect(await fs.readFile(path.join(targetDir, "sentinel.md"), "utf8")).toBe("must remain unchanged\n");
      expect(await fs.readdir(targetDir)).toEqual(["sentinel.md"]);
    } finally {
      await fs.rm(symlinkRoot, { recursive: true, force: true });
    }
  });

  it("rename_note reports an incomplete rollback when destination publication precedes source-unlink failure", async () => {
    const sourceContent = "# Source\n\nPARTIAL-MOVE-SENTINEL\n";
    await fs.writeFile(path.join(root, "Source.md"), sourceContent);
    const vault = new Vault(root, { enableWrite: true });
    await vault.ensureExists();
    const abort = new AbortController();
    const internals = vault as unknown as {
      unlinkSafe(target: string): Promise<void>;
    };
    const unlinkSafe = internals.unlinkSafe.bind(vault);
    internals.unlinkSafe = async (target: string): Promise<void> => {
      if (target.replace(/\\/g, "/").endsWith("/Source.md")) {
        abort.abort(new Error("deterministic cancellation during source unlink"));
        throw new Error("deterministic source unlink failure");
      }
      return unlinkSafe(target);
    };

    const rejection = await renameNote(vault, { from: "Source.md", to: "Dest.md" }, { signal: abort.signal }).then(
      () => null,
      (error: unknown) => error
    );

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).not.toBeInstanceOf(WriteRequestAbortedError);
    const message = rejection instanceof Error ? rejection.message : String(rejection);
    expect(message).toContain("rollback failed");
    expect(message).toContain("was published by hardlink before source removal failed");
    const sourceStat = await fs.stat(path.join(root, "Source.md"));
    const destinationStat = await fs.stat(path.join(root, "Dest.md"));
    expect({ dev: destinationStat.dev, ino: destinationStat.ino }).toEqual({
      dev: sourceStat.dev,
      ino: sourceStat.ino
    });
    expect(sourceStat.nlink).toBeGreaterThanOrEqual(2);
    expect(await fs.readFile(path.join(root, "Source.md"), "utf8")).toBe(sourceContent);
    expect(await fs.readFile(path.join(root, "Dest.md"), "utf8")).toBe(sourceContent);
  });

  it("(negative-control) an uninterrupted exclusive rename leaves only the destination", async () => {
    const sourceContent = "# Source\n\nCOMPLETE-MOVE-SENTINEL\n";
    await fs.writeFile(path.join(root, "Source.md"), sourceContent);
    const vault = new Vault(root, { enableWrite: true });
    await vault.ensureExists();

    await expect(renameNote(vault, { from: "Source.md", to: "Dest.md" })).resolves.toEqual(
      expect.objectContaining({ from: "Source.md", to: "Dest.md", dry_run: false })
    );
    expect(await statOrNullIfMissing(path.join(root, "Source.md"))).toBeNull();
    expect(await fs.readFile(path.join(root, "Dest.md"), "utf8")).toBe(sourceContent);
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
