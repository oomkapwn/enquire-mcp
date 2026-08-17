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
    expect((await vault.readNote(destinationAbs, cachedDestinationStat.mtimeMs)).content).toBe(cachedDestination);
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
