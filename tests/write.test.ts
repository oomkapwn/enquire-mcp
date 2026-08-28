import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { opensBlockFence } from "../src/fence.js";
import { appendToNote, archiveNote, createNote, renameNote, replaceInNotes } from "../src/tools/index.js";
import { replaceStringOutsideCodeFences, rewriteOutsideCodeFences } from "../src/tools/write.js";
import { Vault } from "../src/vault.js";

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
  root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-write-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("createNote", () => {
  it("refuses to write when vault is read-only", async () => {
    const v = new Vault(root, { enableWrite: false });
    await v.ensureExists();
    await expect(createNote(v, { path: "x.md", content: "hi" })).rejects.toThrow(/read-only/);
  });

  it("creates a note with frontmatter", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    const out = await createNote(v, {
      path: "Inbox/Hello.md",
      content: "Body here.\n",
      frontmatter: { tags: ["foo", "bar"], title: "Hello" }
    });
    expect(out.path).toBe(path.join("Inbox", "Hello.md"));
    const text = await fs.readFile(path.join(root, "Inbox", "Hello.md"), "utf8");
    expect(text).toMatch(/^---\n/);
    expect(text).toMatch(/title: Hello/);
    expect(text).toMatch(/tags:\n {2}- foo\n {2}- bar/);
    expect(text).toMatch(/Body here\./);
  });

  it("auto-appends .md if missing", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    const out = await createNote(v, { path: "no-ext-note", content: "x" });
    expect(out.path).toBe("no-ext-note.md");
  });

  it("refuses to overwrite without overwrite=true", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await createNote(v, { path: "Twice.md", content: "first" });
    await expect(createNote(v, { path: "Twice.md", content: "second" })).rejects.toThrow(/already exists/);
  });

  // v3.7.14 F2 — renameFile has kernel-exclusive destination admission via link().
  // Pre-3.7.14 vault.renameFile had the same stat-then-rename race as
  // v3.7.13 M2 fixed for writeNote. POSIX rename(2) silently replaces the
  // destination; between a stat() returning ENOENT and the rename(), a
  // parallel writer could create the destination and our rename would
  // clobber it. Now link()+unlink() — link() fails atomically on EEXIST.
  it("renameFile uses exclusive admission and refuses distinct destination entries", async () => {
    const raceRoot = path.join(root, "F2-race-root");
    await fs.mkdir(raceRoot, { recursive: true });
    const v = new Vault(raceRoot, { enableWrite: true });
    await v.ensureExists();
    // Two source files vying to land at the same destination.
    await fs.writeFile(path.join(raceRoot, "src-A.md"), "from A");
    await fs.writeFile(path.join(raceRoot, "src-B.md"), "from B");
    const results = await Promise.allSettled([
      v.renameFile("src-A.md", "dest.md"),
      v.renameFile("src-B.md", "dest.md")
    ]);
    const succeeded = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(succeeded.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(((rejected[0] as PromiseRejectedResult).reason as Error).message).toMatch(/already exists/);

    // A same-inode hardlink at a lowercase-equivalent spelling is still a
    // distinct directory entry on a case-sensitive filesystem. POSIX rename
    // would otherwise report success without removing either name.
    const hardlinkRoot = path.join(root, "F2-hardlink-root");
    await fs.mkdir(hardlinkRoot, { recursive: true });
    const hardlinkSource = path.join(hardlinkRoot, "Hardlink.md");
    const hardlinkDestination = path.join(hardlinkRoot, "hardlink.md");
    await fs.writeFile(hardlinkSource, "shared hardlink sentinel");
    const hardlinkAliasBefore = await statOrNullIfMissing(hardlinkDestination);
    if (hardlinkAliasBefore === null) {
      await fs.link(hardlinkSource, hardlinkDestination);
      const [sourceStat, destinationStat] = await Promise.all([fs.stat(hardlinkSource), fs.stat(hardlinkDestination)]);
      expect(`${sourceStat.dev}:${sourceStat.ino}`).toBe(`${destinationStat.dev}:${destinationStat.ino}`);
      expect(await fs.realpath(hardlinkSource)).not.toBe(await fs.realpath(hardlinkDestination));

      const hardlinkVault = new Vault(hardlinkRoot, { enableWrite: true });
      await hardlinkVault.ensureExists();
      await expect(hardlinkVault.renameFile("Hardlink.md", "hardlink.md")).rejects.toThrow(/distinct hardlink entry/);
      await expect(hardlinkVault.renameFile("Hardlink.md", "hardlink.md", { overwrite: true })).rejects.toThrow(
        /distinct hardlink entry/
      );
      await expect(
        renameNote(hardlinkVault, {
          dry_run: true,
          from: "Hardlink.md",
          overwrite: true,
          to: "hardlink.md"
        })
      ).rejects.toThrow(/distinct hardlink entry/);
      const unrelatedHardlinkDestination = path.join(hardlinkRoot, "Unrelated-alias.md");
      await fs.link(hardlinkSource, unrelatedHardlinkDestination);
      await expect(hardlinkVault.renameFile("Hardlink.md", "Unrelated-alias.md", { overwrite: true })).rejects.toThrow(
        /distinct hardlink entry/
      );
      expect(await fs.readFile(hardlinkSource, "utf8")).toBe("shared hardlink sentinel");
      expect(await fs.readFile(hardlinkDestination, "utf8")).toBe("shared hardlink sentinel");
      expect(await fs.readFile(unrelatedHardlinkDestination, "utf8")).toBe("shared hardlink sentinel");
      expect((await fs.readdir(hardlinkRoot)).filter((name) => name.toLowerCase() === "hardlink.md")).toHaveLength(2);

      // Receipt recheck: a destination that changes after classification must
      // not inherit the earlier overwrite authority at the mutation boundary.
      const receiptRoot = path.join(root, "F2-receipt-root");
      await fs.mkdir(receiptRoot, { recursive: true });
      const receiptSource = path.join(receiptRoot, "Receipt.md");
      const receiptDestination = path.join(receiptRoot, "receipt.md");
      const receiptSourceBytes = "receipt source sentinel";
      const plannedDestinationBytes = "planned destination sentinel";
      const replacementDestinationBytes = "replacement destination sentinel with changed size";
      await fs.writeFile(receiptSource, receiptSourceBytes);
      await fs.writeFile(receiptDestination, plannedDestinationBytes);
      const receiptVault = new Vault(receiptRoot, { enableWrite: true });
      await receiptVault.ensureExists();
      const expectedDestination = await receiptVault.classifyRenameDestinationPublic(receiptSource, receiptDestination);
      expect(expectedDestination.kind).toBe("distinct");
      if (expectedDestination.kind !== "distinct") {
        throw new Error("receipt fixture must classify one distinct destination entry");
      }

      // Every receipt component is independently causal. If equality drops
      // even one field, that mutation inherits overwrite authority and this
      // otherwise unchanged fixture is destructively renamed.
      const receiptMutations: ReadonlyArray<{
        label: string;
        expected: typeof expectedDestination;
      }> = [
        {
          label: "canonicalRel",
          expected: { ...expectedDestination, canonicalRel: `changed/${expectedDestination.canonicalRel}` }
        },
        {
          label: "realRel",
          expected: {
            ...expectedDestination,
            receipt: { ...expectedDestination.receipt, realRel: `changed/${expectedDestination.receipt.realRel}` }
          }
        },
        {
          label: "dev",
          expected: {
            ...expectedDestination,
            receipt: { ...expectedDestination.receipt, dev: expectedDestination.receipt.dev + 1 }
          }
        },
        {
          label: "ino",
          expected: {
            ...expectedDestination,
            receipt: { ...expectedDestination.receipt, ino: expectedDestination.receipt.ino + 1 }
          }
        },
        {
          label: "size",
          expected: {
            ...expectedDestination,
            receipt: { ...expectedDestination.receipt, size: expectedDestination.receipt.size + 1 }
          }
        },
        {
          label: "mtimeMs",
          expected: {
            ...expectedDestination,
            receipt: { ...expectedDestination.receipt, mtimeMs: expectedDestination.receipt.mtimeMs + 1 }
          }
        },
        {
          label: "ctimeMs",
          expected: {
            ...expectedDestination,
            receipt: { ...expectedDestination.receipt, ctimeMs: expectedDestination.receipt.ctimeMs + 1 }
          }
        },
        {
          label: "mode",
          expected: {
            ...expectedDestination,
            receipt: { ...expectedDestination.receipt, mode: expectedDestination.receipt.mode ^ 0o100 }
          }
        }
      ];
      for (const mutation of receiptMutations) {
        await expect(
          receiptVault.renameFile("Receipt.md", "receipt.md", {
            overwrite: true,
            expectedDestination: mutation.expected
          }),
          `receipt field ${mutation.label} must bind overwrite authority`
        ).rejects.toThrow(/destination changed after planning/);
      }
      expect(await fs.readFile(receiptSource, "utf8")).toBe(receiptSourceBytes);
      expect(await fs.readFile(receiptDestination, "utf8")).toBe(plannedDestinationBytes);

      await fs.writeFile(receiptDestination, replacementDestinationBytes);
      await expect(
        receiptVault.renameFile("Receipt.md", "receipt.md", {
          overwrite: true,
          expectedDestination
        })
      ).rejects.toThrow(/destination changed after planning/);
      expect(await fs.readFile(receiptSource, "utf8")).toBe(receiptSourceBytes);
      expect(await fs.readFile(receiptDestination, "utf8")).toBe(replacementDestinationBytes);

      // Orchestrator binding: change the destination only after renameNote has
      // snapshotted it and rewritten the source self-link. The bound receipt
      // must refuse the move, and the ordinary-error path must restore source.
      const boundRoot = path.join(root, "F2-bound-receipt-root");
      await fs.mkdir(boundRoot, { recursive: true });
      const boundSourceRel = "Bound.md";
      const boundDestinationRel = "bound.md";
      const boundSourceBytes = "bound source sentinel\n\nSelf [[Bound]].\n";
      const boundPlannedDestinationBytes = "bound planned destination sentinel";
      const boundReplacementDestinationBytes = "bound replacement destination sentinel with changed size";
      await fs.writeFile(path.join(boundRoot, boundSourceRel), boundSourceBytes);
      await fs.writeFile(path.join(boundRoot, boundDestinationRel), boundPlannedDestinationBytes);
      const boundVault = new Vault(boundRoot, { enableWrite: true });
      await boundVault.ensureExists();
      const renameFile = boundVault.renameFile.bind(boundVault);
      let destinationReplacementCount = 0;
      boundVault.renameFile = async (...args: Parameters<Vault["renameFile"]>) => {
        if (destinationReplacementCount === 0 && args[0] === boundSourceRel && args[1] === boundDestinationRel) {
          destinationReplacementCount++;
          await fs.writeFile(path.join(boundRoot, boundDestinationRel), boundReplacementDestinationBytes);
        }
        return renameFile(...args);
      };
      await expect(
        renameNote(boundVault, {
          from: boundSourceRel,
          overwrite: true,
          to: boundDestinationRel
        })
      ).rejects.toThrow(/destination changed after planning/);
      expect(destinationReplacementCount).toBe(1);
      expect(await fs.readFile(path.join(boundRoot, boundSourceRel), "utf8")).toBe(boundSourceBytes);
      expect(await fs.readFile(path.join(boundRoot, boundDestinationRel), "utf8")).toBe(
        boundReplacementDestinationBytes
      );

      // Final check/use boundary: even overwrite=true must use the exclusive
      // move when planning and the final classification both saw `missing`,
      // because there are no rollback bytes for a destination born afterward.
      const missingRoot = path.join(root, "F2-missing-receipt-root");
      await fs.mkdir(missingRoot, { recursive: true });
      const missingSourceRel = "MissingSource.md";
      const missingDestinationRel = "MissingDestination.md";
      const missingSourceBytes = "missing source sentinel\n\nSelf [[MissingSource]].\n";
      const racedDestinationBytes = "destination created at the exclusive syscall boundary";
      await fs.writeFile(path.join(missingRoot, missingSourceRel), missingSourceBytes);
      const missingVault = new Vault(missingRoot, { enableWrite: true });
      await missingVault.ensureExists();
      const missingInternals = missingVault as unknown as {
        linkSafe(source: string, destination: string): Promise<void>;
      };
      const linkSafe = missingInternals.linkSafe.bind(missingVault);
      let racedDestinationCount = 0;
      missingInternals.linkSafe = async (source: string, destination: string): Promise<void> => {
        racedDestinationCount++;
        await fs.writeFile(destination, racedDestinationBytes);
        await linkSafe(source, destination);
      };
      await expect(
        renameNote(missingVault, {
          from: missingSourceRel,
          overwrite: true,
          to: missingDestinationRel
        })
      ).rejects.toThrow(/destination changed after planning/);
      expect(racedDestinationCount).toBe(1);
      expect(await fs.readFile(path.join(missingRoot, missingSourceRel), "utf8")).toBe(missingSourceBytes);
      expect(await fs.readFile(path.join(missingRoot, missingDestinationRel), "utf8")).toBe(racedDestinationBytes);
    } else if (process.platform === "linux" && process.env.CI) {
      throw new Error("mandatory Linux case-sensitive filesystem precondition failed for Hardlink.md/hardlink.md");
    }

    const unlinkRoot = path.join(root, "F2-source-unlink-root");
    await fs.mkdir(unlinkRoot, { recursive: true });
    const unlinkSourceRel = "UnlinkSource.md";
    const unlinkDestRel = "UnlinkDest.md";
    const unlinkSourceBytes = "source unlink sentinel\n";
    await fs.writeFile(path.join(unlinkRoot, unlinkSourceRel), unlinkSourceBytes);
    const unlinkVault = new Vault(unlinkRoot, { enableWrite: true });
    await unlinkVault.ensureExists();
    const unlinkInternals = unlinkVault as unknown as {
      unlinkSafe(target: string): Promise<void>;
    };
    const unlinkSafe = unlinkInternals.unlinkSafe.bind(unlinkVault);
    const unlinkSpy = vi.spyOn(unlinkInternals, "unlinkSafe").mockImplementation(async (target: string) => {
      if (String(target).replace(/\\/g, "/").endsWith("UnlinkSource.md")) {
        throw new Error("synthetic source unlink failure");
      }
      return unlinkSafe(target);
    });
    try {
      await expect(unlinkVault.renameFile(unlinkSourceRel, unlinkDestRel)).rejects.toThrow(
        /synthetic source unlink failure/
      );
      expect(await fs.readFile(path.join(unlinkRoot, unlinkSourceRel), "utf8")).toBe(unlinkSourceBytes);
      expect(await fs.readFile(path.join(unlinkRoot, unlinkDestRel), "utf8")).toBe(unlinkSourceBytes);
    } finally {
      unlinkSpy.mockRestore();
    }

    const statRoot = path.join(root, "F2-post-commit-stat-root");
    await fs.mkdir(statRoot, { recursive: true });
    const statSourceRel = "StatSource.md";
    const statDestRel = "StatDest.md";
    const statSourceBytes = "post-commit stat sentinel\n";
    await fs.writeFile(path.join(statRoot, statSourceRel), statSourceBytes);
    const statVault = new Vault(statRoot, { enableWrite: true });
    await statVault.ensureExists();
    const statInternals = statVault as unknown as {
      statSafe(target: string): Promise<import("node:fs").Stats>;
    };
    const statSafe = statInternals.statSafe.bind(statVault);
    const statSpy = vi.spyOn(statInternals, "statSafe").mockImplementation(async (target: string) => {
      if (String(target).replace(/\\/g, "/").endsWith("StatDest.md")) {
        const sourcePresent = await fs.stat(path.join(statRoot, statSourceRel)).catch(() => null);
        if (!sourcePresent) {
          throw new Error("synthetic post-commit stat failure");
        }
      }
      return statSafe(target);
    });
    try {
      const receipt = await statVault.renameFile(statSourceRel, statDestRel);
      expect(receipt.from).toBe(statSourceRel);
      expect(receipt.to).toBe(statDestRel);
      expect(await fs.stat(path.join(statRoot, statSourceRel)).catch(() => null)).toBeNull();
      expect(await fs.readFile(path.join(statRoot, statDestRel), "utf8")).toBe(statSourceBytes);
    } finally {
      statSpy.mockRestore();
    }

    // Cleanup
    await fs.rm(raceRoot, { recursive: true, force: true });
  });

  // v3.7.13 M2 — overwrite=false uses the `wx` flag for atomic exclusive
  // create. Pre-3.7.13 the path was stat-then-write: stat returned ENOENT
  // → write proceeded; if another process created the file between stat
  // and write, the overwrite-false guard was bypassed and the second
  // writer clobbered the first. With `wx`, the kernel atomically refuses
  // the open(). This integration test confirms the original-content
  // protection — both writers can't both succeed when overwrite=false.
  it("overwrite=false is atomic (parallel writers can't both succeed)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    // Fire two simultaneous createNote() calls (which use overwrite=false)
    // against the same path. Exactly one must succeed; the other must
    // reject with "Note already exists".
    const results = await Promise.allSettled([
      createNote(v, { path: "Race.md", content: "writer-A" }),
      createNote(v, { path: "Race.md", content: "writer-B" })
    ]);
    const succeeded = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(succeeded.length).toBe(1);
    expect(rejected.length).toBe(1);
    const rejReason = (rejected[0] as PromiseRejectedResult).reason as Error;
    expect(rejReason.message).toMatch(/already exists/);
  });

  it("overwrites when allowed", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await createNote(v, { path: "Twice.md", content: "first" });
    if (process.platform !== "win32") {
      await fs.chmod(path.join(root, "Twice.md"), 0o600);
    }
    await createNote(v, { path: "Twice.md", content: "second", overwrite: true });
    const text = await fs.readFile(path.join(root, "Twice.md"), "utf8");
    expect(text).toBe("second");
    if (process.platform !== "win32") {
      expect((await fs.stat(path.join(root, "Twice.md"))).mode & 0o777).toBe(0o600);
    }

    await fs.writeFile(path.join(root, "StatOverwrite.md"), "before\n");
    const overwriteInternals = v as unknown as {
      statSafe(target: string): Promise<import("node:fs").Stats>;
    };
    const overwriteStatSafe = overwriteInternals.statSafe.bind(v);
    const overwriteStatSpy = vi.spyOn(overwriteInternals, "statSafe").mockImplementation(async (target: string) => {
      if (String(target).replace(/\\/g, "/").endsWith("StatOverwrite.md")) {
        const live = await fs.readFile(target, "utf8").catch(() => "");
        if (live === "after\n") {
          throw new Error("synthetic post-commit stat failure");
        }
      }
      return overwriteStatSafe(target);
    });
    try {
      const receipt = await v.writeNote("StatOverwrite.md", "after\n", { overwrite: true });
      expect(receipt.relPath).toBe("StatOverwrite.md");
      expect(receipt.bytes).toBe(Buffer.byteLength("after\n"));
      expect(await fs.readFile(path.join(root, "StatOverwrite.md"), "utf8")).toBe("after\n");
    } finally {
      overwriteStatSpy.mockRestore();
    }
  });

  it("rejects traversal and fails closed when mutation leaf probes cannot complete", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await expect(createNote(v, { path: "../outside.md", content: "nope" })).rejects.toThrow(/escapes vault root/);

    const firstWriteLstat = vi
      .spyOn(fs, "lstat")
      .mockRejectedValueOnce(Object.assign(new Error("write preflight lstat denied"), { code: "EACCES" }));
    try {
      await expect(v.writeNote("DeniedWrite.md", "must not exist")).rejects.toThrow(/write preflight lstat denied/);
    } finally {
      firstWriteLstat.mockRestore();
    }
    expect(await fs.stat(path.join(root, "DeniedWrite.md")).catch(() => null)).toBeNull();

    const secondWriteLstat = vi
      .spyOn(fs, "lstat")
      .mockRejectedValueOnce(Object.assign(new Error("missing write leaf"), { code: "ENOENT" }))
      .mockRejectedValueOnce(Object.assign(new Error("write near-mutation lstat denied"), { code: "EACCES" }));
    try {
      await expect(v.writeNote("DeniedSecondWrite.md", "must not exist")).rejects.toThrow(
        /write near-mutation lstat denied/
      );
    } finally {
      secondWriteLstat.mockRestore();
    }
    expect(await fs.stat(path.join(root, "DeniedSecondWrite.md")).catch(() => null)).toBeNull();

    await fs.writeFile(path.join(root, "ProbeSource.md"), "SOURCE");
    const firstRenameLstat = vi
      .spyOn(fs, "lstat")
      .mockRejectedValueOnce(Object.assign(new Error("rename preflight lstat denied"), { code: "EACCES" }));
    try {
      await expect(renameNote(v, { from: "ProbeSource.md", to: "DeniedRename.md" })).rejects.toThrow(
        /rename preflight lstat denied/
      );
    } finally {
      firstRenameLstat.mockRestore();
    }
    expect(await fs.readFile(path.join(root, "ProbeSource.md"), "utf8")).toBe("SOURCE");
    expect(await fs.stat(path.join(root, "DeniedRename.md")).catch(() => null)).toBeNull();

    const secondRenameLstat = vi
      .spyOn(fs, "lstat")
      .mockRejectedValueOnce(Object.assign(new Error("missing rename leaf"), { code: "ENOENT" }))
      .mockRejectedValueOnce(Object.assign(new Error("rename near-mutation lstat denied"), { code: "EACCES" }));
    try {
      await expect(v.renameFile("ProbeSource.md", "DeniedSecondRename.md")).rejects.toThrow(
        /rename near-mutation lstat denied/
      );
    } finally {
      secondRenameLstat.mockRestore();
    }
    expect(await fs.readFile(path.join(root, "ProbeSource.md"), "utf8")).toBe("SOURCE");
    expect(await fs.stat(path.join(root, "DeniedSecondRename.md")).catch(() => null)).toBeNull();

    const fresh = await v.writeNote("Fresh.md", "fresh");
    expect(fresh.relPath).toBe("Fresh.md");
    const renamed = await renameNote(v, { from: "ProbeSource.md", to: "Renamed.md" });
    expect(renamed.to).toBe("Renamed.md");
  });

  it("rejects writes and renames through a symlink whose target is outside the vault (audit v0.7.3 P1)", async (ctx) => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-link-out-"));
    const outsideTarget = path.join(outside, "outside-target.md");
    await fs.writeFile(outsideTarget, "BEFORE");
    try {
      await fs.symlink(outsideTarget, path.join(root, "Link.md")).catch(() => null);
      const linkExists = await fs.lstat(path.join(root, "Link.md")).catch(() => null);
      if (!linkExists) return ctx.skip();
      await fs.writeFile(path.join(root, "Source.md"), "SOURCE");
      await expect(renameNote(v, { from: "Source.md", to: "Link.md", overwrite: true })).rejects.toThrow(
        /destination is a symlink/
      );
      await expect(createNote(v, { path: "Link.md", content: "AFTER", overwrite: true })).rejects.toThrow(
        /target is a symlink/
      );
      expect(await fs.readFile(path.join(root, "Source.md"), "utf8")).toBe("SOURCE");
      const after = await fs.readFile(outsideTarget, "utf8");
      expect(after).toBe("BEFORE");
    } finally {
      await fs.unlink(path.join(root, "Link.md")).catch(() => {});
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects writes whose parent dir is a symlink to outside the vault", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    // Create a symlinked subfolder inside the vault that resolves OUTSIDE the vault.
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-parent-link-"));
    try {
      await fs.symlink(outside, path.join(root, "linked-folder"));
      const linkExists = await fs.lstat(path.join(root, "linked-folder")).catch(() => null);
      if (!linkExists) return;
      await expect(
        createNote(v, { path: "linked-folder/sneaky.md", content: "should not land outside vault" })
      ).rejects.toThrow(/parent directory resolves outside vault/);
      const escaped = await fs.stat(path.join(outside, "sneaky.md")).catch(() => null);
      expect(escaped).toBeNull();
    } finally {
      await fs.unlink(path.join(root, "linked-folder")).catch(() => {});
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("write_then_append moves mtime forward", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    const created = await createNote(v, { path: "MtimeCheck.md", content: "first" });
    await new Promise((r) => setTimeout(r, 12));
    const appended = await appendToNote(v, { path: "MtimeCheck.md", content: "second" });
    expect(new Date(appended.mtime).getTime()).toBeGreaterThan(new Date(created.mtime).getTime());
  });

  it("handles values that look like booleans by quoting them", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await createNote(v, {
      path: "Tricky.md",
      content: "body",
      frontmatter: { status: "true", note: "yes" }
    });
    const text = await fs.readFile(path.join(root, "Tricky.md"), "utf8");
    // gray-matter (js-yaml) emits single-quoted scalars by default; both
    // styles are valid YAML and round-trip the same. What matters: the values
    // are quoted, not bare (otherwise YAML would parse them back as boolean).
    expect(text).toMatch(/status: ['"]true['"]/);
    expect(text).toMatch(/note: ['"]yes['"]/);
  });

  it("renders date-like strings as strings, not as YAML timestamps (audit v0.7.6 P2)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await createNote(v, {
      path: "Dated.md",
      content: "body",
      frontmatter: { due: "2026-05-03" }
    });
    const round = await readNoteRaw(v, "Dated.md");
    expect(typeof round.frontmatter.due).toBe("string");
    expect(round.frontmatter.due).toBe("2026-05-03");
  });

  it("creates new note with regular file permissions, not executable (audit v0.8 P0)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await createNote(v, { path: "Permcheck.md", content: "body" });
    const stat = await fs.stat(path.join(root, "Permcheck.md"));
    // Owner write + at least one of read; no exec bits set anywhere.
    const mode = stat.mode & 0o777;
    expect(mode & 0o600).toBeTruthy(); // user can read+write
    expect(mode & 0o111).toBe(0); // no exec bits anywhere
  });

  it("renders YAML-special strings (!important, a | b, leading @) without breaking YAML (audit v0.7.6 P2)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await createNote(v, {
      path: "YamlSpecial.md",
      content: "body",
      frontmatter: { bang: "!important", pipe: "a | b", at: "@mention", gt: ">arrow" }
    });
    const round = await readNoteRaw(v, "YamlSpecial.md");
    expect(round.frontmatter.bang).toBe("!important");
    expect(round.frontmatter.pipe).toBe("a | b");
    expect(round.frontmatter.at).toBe("@mention");
    expect(round.frontmatter.gt).toBe(">arrow");
  });
});

async function readNoteRaw(v: Vault, rel: string): Promise<{ frontmatter: Record<string, unknown> }> {
  const note = await v.readNote(path.join(v.root, rel));
  return { frontmatter: note.parsed.frontmatter as Record<string, unknown> };
}

describe("appendToNote", () => {
  it("appends to an existing note with default separator", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await createNote(v, { path: "Log.md", content: "first entry" });
    // Windows/Node may expose a different path-stat dev+ino identity than fstat
    // for the same file. Identity must remain descriptor-only; this mutation is
    // the deterministic negative control for the old mixed-stat comparison.
    const pathStat = await fs.stat(path.join(root, "Log.md"));
    const pathStatSpy = vi.spyOn(fs, "stat").mockResolvedValue(Object.assign(pathStat, { dev: pathStat.dev + 1 }));
    const out = await appendToNote(v, { path: "Log.md", content: "second entry" }).finally(() =>
      pathStatSpy.mockRestore()
    );
    expect(out.appended_bytes).toBeGreaterThan(0);
    const text = await fs.readFile(path.join(root, "Log.md"), "utf8");
    expect(text).toBe("first entry\n\nsecond entry");

    // A real replacement between the descriptor probe and write handle must
    // still fail closed; neither the original nor replacement may be changed.
    const swap = path.join(root, "Swap.md");
    await fs.writeFile(swap, "ORIGINAL");
    const canonicalSwap = await fs.realpath(swap);
    const canonicalMoved = path.join(path.dirname(canonicalSwap), "Swap-moved.md");
    const openTarget = v as unknown as {
      openSafe(p: string, flags: string | number, mode?: number): Promise<import("node:fs/promises").FileHandle>;
    };
    const realOpenSafe = openTarget.openSafe.bind(v);
    let swapOpens = 0;
    const openSafeSpy = vi.spyOn(openTarget, "openSafe").mockImplementation(async (p, flags, mode) => {
      if (p === canonicalSwap && ++swapOpens === 2) {
        await fs.rename(canonicalSwap, canonicalMoved);
        await fs.writeFile(canonicalSwap, "REPLACEMENT");
      }
      return mode === undefined ? realOpenSafe(p, flags) : realOpenSafe(p, flags, mode);
    });
    try {
      await expect(v.appendNote("Swap.md", "\nMUST NOT APPEND")).rejects.toThrow(/target changed while waiting/);
    } finally {
      openSafeSpy.mockRestore();
    }
    expect(await fs.readFile(canonicalMoved, "utf8")).toBe("ORIGINAL");
    expect(await fs.readFile(canonicalSwap, "utf8")).toBe("REPLACEMENT");
  });

  it("supports custom separator", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await createNote(v, { path: "Log.md", content: "first" });
    await appendToNote(v, { path: "Log.md", content: "second", separator: "\n---\n" });
    const text = await fs.readFile(path.join(root, "Log.md"), "utf8");
    expect(text).toBe("first\n---\nsecond");

    await createNote(v, { path: "AppendStat.md", content: "first" });
    const appendInternals = v as unknown as {
      openSafe(p: string, flags: string | number, mode?: number): Promise<import("node:fs/promises").FileHandle>;
    };
    const openSafe = appendInternals.openSafe.bind(v);
    const openSpy = vi.spyOn(appendInternals, "openSafe").mockImplementation(async (p, flags, mode) => {
      const handle = await openSafe(p, flags, mode);
      let published = false;
      const writeFile = handle.writeFile.bind(handle);
      const stat = handle.stat.bind(handle);
      const close = handle.close.bind(handle);
      handle.writeFile = (async (...args: Parameters<typeof handle.writeFile>) => {
        const result = await writeFile(...args);
        published = true;
        return result;
      }) as typeof handle.writeFile;
      handle.stat = (async (...args: Parameters<typeof handle.stat>) => {
        if (published) throw new Error("synthetic post-commit append stat failure");
        return stat(...args);
      }) as typeof handle.stat;
      handle.close = (async () => {
        if (published) throw new Error("synthetic post-commit append close failure");
        return close();
      }) as typeof handle.close;
      return handle;
    });
    try {
      const receipt = await v.appendNote("AppendStat.md", "\nsecond");
      expect(receipt.appended_bytes).toBe(Buffer.byteLength("\nsecond"));
      expect(await fs.readFile(path.join(root, "AppendStat.md"), "utf8")).toBe("first\nsecond");
    } finally {
      openSpy.mockRestore();
    }
  });

  it("can resolve target by title", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await createNote(v, { path: "Daily.md", content: "morning" });
    const out = await appendToNote(v, { title: "Daily", content: "evening" });
    expect(out.path).toBe("Daily.md");
  });

  it("refuses appends in read-only mode", async () => {
    const v = new Vault(root, { enableWrite: false });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Read.md"), "x");
    await expect(appendToNote(v, { path: "Read.md", content: "y" })).rejects.toThrow(/read-only/);
  });

  // v3.11.7-rc.1 (whole-repo audit A10) — the descriptor fstat and append
  // must be one in-process critical section. Exercise TWO Vault instances
  // because a per-instance queue would still let the exported API race.
  it("parallel appends across Vault instances cannot jointly exceed maxFileBytes (POSITIVE)", async () => {
    const target = path.join(root, "Cap.md");
    for (let trial = 0; trial < 12; trial++) {
      await fs.writeFile(target, "1234"); // 4 bytes; only one 4-byte append fits under cap=10
      const a = new Vault(root, { enableWrite: true, maxFileBytes: 10 });
      const b = new Vault(root, { enableWrite: true, maxFileBytes: 10 });
      await Promise.all([a.ensureExists(), b.ensureExists()]);
      const results = await Promise.allSettled([a.appendNote("Cap.md", "AAAA"), b.appendNote("Cap.md", "BBBB")]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      expect((await fs.stat(target)).size).toBe(8);
    }
  });

  it("NEGATIVE control — two uncoordinated O_APPEND handles both pass a stale cap check", async () => {
    const target = path.join(root, "Raw-cap-race.md");
    await fs.writeFile(target, "1234");
    const [a, b] = await Promise.all([fs.open(target, "a"), fs.open(target, "a")]);
    try {
      // This is the pre-fix Vault shape: both descriptors observe 4 before
      // either writes, so both independently conclude 4+4 <= 10.
      const [aBefore, bBefore] = await Promise.all([a.stat(), b.stat()]);
      expect(aBefore.size + 4).toBeLessThanOrEqual(10);
      expect(bBefore.size + 4).toBeLessThanOrEqual(10);
      await Promise.all([a.writeFile("AAAA", "utf8"), b.writeFile("BBBB", "utf8")]);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
    expect((await fs.stat(target)).size).toBe(12);
  });

  // v3.11.7-rc.2 (post-merge re-sweep A10-F1) — realpath cannot collapse
  // hardlinks, so the append queue must key the physical dev+ino identity.
  it("hardlink aliases share one append cap lock across Vault instances (POSITIVE)", async (ctx) => {
    const target = path.join(root, "Hardlink-cap.md");
    const alias = path.join(root, "Hardlink-alias.md");
    await fs.writeFile(target, "1234");
    try {
      await fs.link(target, alias);
    } catch {
      return ctx.skip();
    }
    const targetStat = await fs.stat(target);
    const aliasStat = await fs.stat(alias);
    if (targetStat.ino === 0 || aliasStat.ino === 0) return ctx.skip();
    expect(aliasStat.ino).toBe(targetStat.ino);

    const a = new Vault(root, { enableWrite: true, maxFileBytes: 10 });
    const b = new Vault(root, { enableWrite: true, maxFileBytes: 10 });
    await Promise.all([a.ensureExists(), b.ensureExists()]);
    for (let trial = 0; trial < 12; trial++) {
      await fs.writeFile(target, "1234");
      const results = await Promise.allSettled([
        a.appendNote("Hardlink-cap.md", "AAAA"),
        b.appendNote("Hardlink-alias.md", "BBBB")
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      expect((await fs.stat(target)).size).toBe(8);
    }
  });

  it("NEGATIVE control — uncoordinated hardlink handles exceed the shared inode cap", async (ctx) => {
    const target = path.join(root, "Raw-hardlink-cap.md");
    const alias = path.join(root, "Raw-hardlink-alias.md");
    await fs.writeFile(target, "1234");
    try {
      await fs.link(target, alias);
    } catch {
      return ctx.skip();
    }
    const targetStat = await fs.stat(target);
    const aliasStat = await fs.stat(alias);
    if (targetStat.ino === 0 || aliasStat.ino === 0) return ctx.skip();
    expect(aliasStat.ino).toBe(targetStat.ino);

    const [a, b] = await Promise.all([fs.open(target, "a"), fs.open(alias, "a")]);
    try {
      const [aBefore, bBefore] = await Promise.all([a.stat(), b.stat()]);
      expect(aBefore.size + 4).toBeLessThanOrEqual(10);
      expect(bBefore.size + 4).toBeLessThanOrEqual(10);
      await Promise.all([a.writeFile("AAAA", "utf8"), b.writeFile("BBBB", "utf8")]);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
    expect((await fs.stat(target)).size).toBe(12);
  });

  it("append never creates a missing note (NEGATIVE control for the old O_CREAT flag)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await expect(v.appendNote("Missing.md", "must not be created")).rejects.toThrow();
    expect(await fs.stat(path.join(root, "Missing.md")).catch(() => null)).toBeNull();
  });

  it("append cannot create a missing leaf through an out-of-vault parent symlink", async (ctx) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-append-escape-"));
    const link = path.join(root, "Public");
    try {
      await fs.symlink(outside, link);
      if (!(await fs.lstat(link).catch(() => null))) return ctx.skip();
      const v = new Vault(root, { enableWrite: true, readPaths: ["Public/**"] });
      await v.ensureExists();
      await expect(v.appendNote("Public/escaped.md", "outside-write")).rejects.toThrow(
        /canonical form escapes the vault/i
      );
      expect(await fs.stat(path.join(outside, "escaped.md")).catch(() => null)).toBeNull();

      // NEGATIVE control: the old string flag "a" itself follows the parent
      // symlink and creates the missing external leaf. This proves the setup
      // reaches the exact sink instead of passing vacuously.
      const raw = await fs.open(path.join(link, "raw-control.md"), "a");
      await raw.writeFile("outside-write", "utf8");
      await raw.close();
      expect(await fs.readFile(path.join(outside, "raw-control.md"), "utf8")).toBe("outside-write");
    } finally {
      await fs.unlink(link).catch(() => {});
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe("renameNote (v1.1)", () => {
  it("refuses to rename when vault is read-only", async () => {
    const v = new Vault(root, { enableWrite: false });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Foo.md"), "body");
    await expect(renameNote(v, { from: "Foo.md", to: "Bar.md" })).rejects.toThrow(/read-only/);
  });

  it("happy path: renames file + rewrites every wikilink to the new name", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Apollo.md"), "Apollo body.\n");
    await fs.writeFile(path.join(root, "Hub.md"), "See [[Apollo]] for details.\n");
    await fs.writeFile(path.join(root, "Daily.md"), "Today: [[Apollo]] and [[Apollo|the project]].\n");
    const out = await renameNote(v, { from: "Apollo.md", to: "Apollo Project.md" });
    expect(out.from).toBe("Apollo.md");
    expect(out.to).toBe("Apollo Project.md");
    expect(out.dry_run).toBe(false);
    expect(out.total_links_rewritten).toBe(3);
    expect(out.files_updated.map((p) => p.path).sort()).toEqual(["Daily.md", "Hub.md"]);
    // File was renamed.
    expect(await fs.stat(path.join(root, "Apollo Project.md")).catch(() => null)).not.toBeNull();
    expect(await fs.stat(path.join(root, "Apollo.md")).catch(() => null)).toBeNull();
    // Wikilinks rewritten correctly.
    const hub = await fs.readFile(path.join(root, "Hub.md"), "utf8");
    expect(hub).toContain("[[Apollo Project]]");
    expect(hub).not.toContain("[[Apollo]]");
    const daily = await fs.readFile(path.join(root, "Daily.md"), "utf8");
    expect(daily).toContain("[[Apollo Project]]");
    expect(daily).toContain("[[Apollo Project|the project]]");
  });

  it("preserves alias / section / block in the rewritten target", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Old.md"), "## Heading\n\n^block-id\nBody.\n");
    await fs.writeFile(
      path.join(root, "Caller.md"),
      "[[Old]] [[Old|alias]] [[Old#Heading]] [[Old#Heading|H]] [[Old^block-id]]\n"
    );
    await renameNote(v, { from: "Old.md", to: "New.md" });
    const txt = await fs.readFile(path.join(root, "Caller.md"), "utf8");
    expect(txt).toContain("[[New]]");
    expect(txt).toContain("[[New|alias]]");
    expect(txt).toContain("[[New#Heading]]");
    expect(txt).toContain("[[New#Heading|H]]");
    expect(txt).toContain("[[New^block-id]]");
    expect(txt).not.toContain("[[Old");
  });

  it("rewrites embeds (![[...]]) too", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Embedded.md"), "embed body");
    await fs.writeFile(path.join(root, "Page.md"), "Here is ![[Embedded]] and [[Embedded]].\n");
    const out = await renameNote(v, { from: "Embedded.md", to: "Renamed Embed.md" });
    expect(out.total_links_rewritten).toBe(2);
    const page = await fs.readFile(path.join(root, "Page.md"), "utf8");
    expect(page).toContain("![[Renamed Embed]]");
    expect(page).toContain("[[Renamed Embed]]");
  });

  it("dry_run returns the plan without touching disk", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Source.md"), "x");
    await fs.writeFile(path.join(root, "Caller.md"), "Sees [[Source]] here.\n");
    const out = await renameNote(v, { from: "Source.md", to: "Target.md", dry_run: true });
    expect(out.dry_run).toBe(true);
    expect(out.total_links_rewritten).toBe(1);
    expect(out.files_updated[0]?.path).toBe("Caller.md");
    // File NOT renamed.
    expect(await fs.stat(path.join(root, "Source.md")).catch(() => null)).not.toBeNull();
    expect(await fs.stat(path.join(root, "Target.md")).catch(() => null)).toBeNull();
    // Caller NOT modified.
    const caller = await fs.readFile(path.join(root, "Caller.md"), "utf8");
    expect(caller).toContain("[[Source]]");
  });

  it("supports moving across folders (rename to a different directory)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.mkdir(path.join(root, "Inbox"), { recursive: true });
    await fs.mkdir(path.join(root, "Archive"), { recursive: true });
    await fs.writeFile(path.join(root, "Inbox", "Note.md"), "body");
    // Bare-basename caller — should rewrite to bare-basename target.
    await fs.writeFile(path.join(root, "Bare.md"), "Bare ref [[Note]]\n");
    // Path-qualified caller — should rewrite to a path-qualified target pointing at the new folder.
    await fs.writeFile(path.join(root, "Qualified.md"), "Qualified [[Inbox/Note]]\n");
    await renameNote(v, { from: "Inbox/Note.md", to: "Archive/Note.md" });
    const bare = await fs.readFile(path.join(root, "Bare.md"), "utf8");
    expect(bare).toContain("[[Note]]"); // bare stays bare
    const qual = await fs.readFile(path.join(root, "Qualified.md"), "utf8");
    expect(qual).toContain("[[Archive/Note]]"); // path-qualified updated
  });

  it("does NOT rewrite wikilinks inside fenced code blocks", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Foo.md"), "body");
    await fs.writeFile(
      path.join(root, "Doc.md"),
      "Outside ref [[Foo]].\n\n```\nInside code [[Foo]] should stay verbatim.\n```\n\nAnother outside [[Foo]].\n"
    );
    const out = await renameNote(v, { from: "Foo.md", to: "Bar.md" });
    expect(out.total_links_rewritten).toBe(2); // 2 outside-fence, 1 inside-fence preserved
    const doc = await fs.readFile(path.join(root, "Doc.md"), "utf8");
    expect(doc).toContain("Outside ref [[Bar]]");
    expect(doc).toContain("Inside code [[Foo]] should stay verbatim"); // preserved
    expect(doc).toContain("Another outside [[Bar]]");
  });

  it("refuses if `to` already exists (without overwrite)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "A.md"), "a");
    await fs.writeFile(path.join(root, "B.md"), "b");
    await expect(renameNote(v, { from: "A.md", to: "B.md" })).rejects.toThrow(/already exists/);
    // Both files still present.
    expect(await fs.readFile(path.join(root, "A.md"), "utf8")).toBe("a");
    expect(await fs.readFile(path.join(root, "B.md"), "utf8")).toBe("b");

    // Case-sensitive negative control: lowercase-equivalent nested paths are
    // distinct entries. The path-qualified self-link makes source resolution
    // deterministic, so a late EEXIST cannot hide a pre-rename source rewrite.
    const upperCaseDir = path.join(root, "CaseScope");
    const lowerCaseDir = path.join(root, "casescope");
    await fs.mkdir(upperCaseDir, { recursive: true });
    const lowerCaseAliasBefore = await statOrNullIfMissing(lowerCaseDir);
    if (lowerCaseAliasBefore === null) {
      await fs.mkdir(lowerCaseDir, { recursive: true });
      const sourceRel = "CaseScope/Note.md";
      const destinationRel = "casescope/note.md";
      const sourcePath = path.join(root, sourceRel);
      const destinationPath = path.join(root, destinationRel);
      const sourceBytes = "# Case source\n\nsource-case sentinel\n\nSelf [[CaseScope/Note]].\n";
      const destinationBytes = "# Case destination\n\ndestination-case sentinel\n";
      await fs.writeFile(sourcePath, sourceBytes);
      await fs.writeFile(destinationPath, destinationBytes);
      const expectCaseFixtureUnchanged = async (): Promise<void> => {
        expect(await fs.readFile(sourcePath, "utf8")).toBe(sourceBytes);
        expect(await fs.readFile(destinationPath, "utf8")).toBe(destinationBytes);
      };

      await expect(renameNote(v, { from: sourceRel, to: destinationRel })).rejects.toThrow(/already exists/);
      await expectCaseFixtureUnchanged();
      await expect(renameNote(v, { from: sourceRel, to: destinationRel, dry_run: true })).rejects.toThrow(
        /already exists/
      );
      await expectCaseFixtureUnchanged();
    } else if (process.platform === "linux" && process.env.CI) {
      throw new Error("mandatory Linux case-sensitive filesystem precondition failed for CaseScope/casescope");
    }
  });

  it("refuses if `from` does not exist", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await expect(renameNote(v, { from: "MissingSource.md", to: "AnyName.md" })).rejects.toThrow();
  });

  it("overwrite:true does NOT lose the source when the destination backlinks the source (rc.60 WRITE-1)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    // Source A.md (the content that must survive) + an existing distinct destination B.md
    // that backlinks A. Pre-rc.60 the backlink-rewrite loop wrote B's PRE-rename content
    // back onto B.md AFTER the move put A's content there → A's content was silently lost.
    await fs.writeFile(path.join(root, "A.md"), "# Source A\n\nThe content that MUST survive.\n");
    await fs.writeFile(path.join(root, "B.md"), "# Dest B\n\nSee [[A]] for details.\n");
    await renameNote(v, { from: "A.md", to: "B.md", overwrite: true });
    const dest = await fs.readFile(path.join(root, "B.md"), "utf8");
    expect(dest, "destination must hold the moved SOURCE content, not B's clobbered old content").toContain(
      "The content that MUST survive."
    );
    expect(dest).not.toContain("See [[A]] for details."); // B's old content is gone (it was overwritten by the move — correct)
    expect(
      await fs
        .access(path.join(root, "A.md"))
        .then(() => true)
        .catch(() => false)
    ).toBe(false); // source moved away
  });

  it("overwrite:true to a destination that does NOT backlink the source still works (rc.60 NEGATIVE control)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "A.md"), "# Source A\n\nbody A\n");
    await fs.writeFile(path.join(root, "B.md"), "# Dest B\n\nunrelated, no link\n");
    await renameNote(v, { from: "A.md", to: "B.md", overwrite: true });
    expect(await fs.readFile(path.join(root, "B.md"), "utf8")).toContain("body A");
  });

  it("auto-appends .md to from/to when missing", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "WithExt.md"), "x");
    const out = await renameNote(v, { from: "WithExt", to: "Renamed" });
    expect(out.from).toBe("WithExt.md");
    expect(out.to).toBe("Renamed.md");
  });

  it("rejects from == to as a no-op error (don't silently succeed)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Same.md"), "x");
    await expect(renameNote(v, { from: "Same.md", to: "Same.md" })).rejects.toThrow(/same path/);
  });

  it("rewrites self-references inside the renamed file (audit P1 v1.1)", async () => {
    // Pre-fix: a note that linked to itself stayed referencing the old name
    // after rename, leaving the renamed file with a broken self-link.
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(
      path.join(root, "Foo.md"),
      "Foo describes itself and references [[Foo]] and ![[Foo]] from inside.\n"
    );
    const out = await renameNote(v, { from: "Foo.md", to: "Bar.md" });
    expect(out.total_links_rewritten).toBe(2);
    // The renamed file's self-references must point at the new name.
    const bar = await fs.readFile(path.join(root, "Bar.md"), "utf8");
    expect(bar).toContain("[[Bar]]");
    expect(bar).toContain("![[Bar]]");
    expect(bar).not.toContain("[[Foo]]");
    // The plan response surfaces the source-file rewrite at its NEW path.
    const sourceEntry = out.files_updated.find((p) => p.path === "Bar.md");
    expect(sourceEntry?.rewrites).toBe(2);
  });

  it("self-reference rewrite respects code fences (no rewrite inside ```)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(
      path.join(root, "Doc.md"),
      "Outside [[Doc]].\n\n```\nInside fence: [[Doc]] stays.\n```\n\nMore outside [[Doc]].\n"
    );
    const out = await renameNote(v, { from: "Doc.md", to: "Manual.md" });
    expect(out.total_links_rewritten).toBe(2); // 2 outside, 1 inside-fence preserved
    const txt = await fs.readFile(path.join(root, "Manual.md"), "utf8");
    expect(txt.match(/\[\[Manual\]\]/g)?.length).toBe(2);
    expect(txt).toContain("Inside fence: [[Doc]] stays.");
  });

  it("overwrite=true: clobbers destination, source content lands at to-path", async () => {
    // Spec: overwrite=true means "replace the file at `to` with the renamed
    // source's content (and its updated wikilinks)". Existing backlinks that
    // pointed at `to` will continue to syntactically resolve to it — they now
    // point at the renamed source's content. That's the contract.
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Source.md"), "I am source linking to nothing.\n");
    await fs.writeFile(path.join(root, "Dest.md"), "I am the doomed destination.\n");
    await fs.writeFile(path.join(root, "PointsAtDest.md"), "Hello [[Dest]].\n");
    await renameNote(v, { from: "Source.md", to: "Dest.md", overwrite: true });
    // Source file gone; Dest file present with Source's content.
    expect(await fs.stat(path.join(root, "Source.md")).catch(() => null)).toBeNull();
    expect(await fs.readFile(path.join(root, "Dest.md"), "utf8")).toContain("I am source linking to nothing");
    // PointsAtDest unchanged — its [[Dest]] still resolves (to Source's content now).
    expect(await fs.readFile(path.join(root, "PointsAtDest.md"), "utf8")).toContain("[[Dest]]");
  });

  it("self-reference + path-qualified target: [[Folder/Foo]] inside Folder/Foo.md (audit P2 v1.4)", async () => {
    // Pre-existing audit gap: a self-reference in a path-qualified form
    // (`Folder/Foo.md` containing `[[Folder/Foo]]`) was not explicitly tested.
    // After cross-folder rename, the path-qualified self-link must update its
    // path component AND its basename component.
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.mkdir(path.join(root, "Inbox"), { recursive: true });
    await fs.mkdir(path.join(root, "Archive"), { recursive: true });
    await fs.writeFile(
      path.join(root, "Inbox", "Foo.md"),
      "I link to myself path-qualified [[Inbox/Foo]] and bare [[Foo]].\n"
    );
    await renameNote(v, { from: "Inbox/Foo.md", to: "Archive/Bar.md" });
    const txt = await fs.readFile(path.join(root, "Archive", "Bar.md"), "utf8");
    // Path-qualified self-link → new folder + new basename.
    expect(txt).toContain("[[Archive/Bar]]");
    // Bare self-link → new basename only (no path).
    expect(txt).toContain("[[Bar]]");
    // Old form is fully gone.
    expect(txt).not.toContain("[[Inbox/Foo]]");
    expect(txt).not.toContain("[[Foo]]");
  });
});

describe("replaceInNotes (v1.9 bulk find/replace)", () => {
  it("refuses to write when vault is read-only", async () => {
    const v = new Vault(root, { enableWrite: false });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "doc.md"), "alpha\n");
    await expect(replaceInNotes(v, { search: "alpha", replace: "beta" })).rejects.toThrow(/read-only/);
  });

  it("happy path: replaces every occurrence outside fenced code blocks", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(
      path.join(root, "Doc.md"),
      "Hello GPT-3.5. Refer to GPT-3.5.\n\n```\nInside fence: GPT-3.5 stays.\n```\n\nMore GPT-3.5 mentions.\n"
    );
    await fs.writeFile(path.join(root, "Other.md"), "No mention here.\n");
    const out = await replaceInNotes(v, { search: "GPT-3.5", replace: "GPT-4" });
    expect(out.dry_run).toBe(false);
    expect(out.total_replacements).toBe(3); // 3 outside-fence; 1 inside-fence preserved
    expect(out.files_updated.length).toBe(1);
    expect(out.files_updated[0]?.path).toBe("Doc.md");
    expect(out.files_updated[0]?.occurrences).toBe(3);
    const txt = await fs.readFile(path.join(root, "Doc.md"), "utf8");
    expect((txt.match(/GPT-4/g) ?? []).length).toBe(3);
    expect(txt).toContain("Inside fence: GPT-3.5 stays.");
    // Untouched file unchanged.
    expect(await fs.readFile(path.join(root, "Other.md"), "utf8")).toBe("No mention here.\n");
  });

  it("dry_run returns the plan without writing", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Live.md"), "v1 v1 v1\n");
    const out = await replaceInNotes(v, { search: "v1", replace: "v2", dry_run: true });
    expect(out.dry_run).toBe(true);
    expect(out.total_replacements).toBe(3);
    // File NOT modified.
    expect(await fs.readFile(path.join(root, "Live.md"), "utf8")).toBe("v1 v1 v1\n");
  });

  it("case_sensitive=false matches across case but inserts replace verbatim", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Mixed.md"), "API and api and Api\n");
    const out = await replaceInNotes(v, { search: "api", replace: "REST", case_sensitive: false });
    expect(out.total_replacements).toBe(3);
    const txt = await fs.readFile(path.join(root, "Mixed.md"), "utf8");
    // All three case variants replaced with literal "REST".
    expect(txt).toBe("REST and REST and REST\n");
  });

  it("case_sensitive=true (default) only matches exact case", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Mixed.md"), "API and api and Api\n");
    const out = await replaceInNotes(v, { search: "api", replace: "REST" });
    expect(out.total_replacements).toBe(1);
    const txt = await fs.readFile(path.join(root, "Mixed.md"), "utf8");
    expect(txt).toBe("API and REST and Api\n");
  });

  it("folder filter narrows the scope", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.mkdir(path.join(root, "Sub"), { recursive: true });
    await fs.writeFile(path.join(root, "RootDoc.md"), "target\n");
    await fs.writeFile(path.join(root, "Sub", "SubDoc.md"), "target\n");
    const out = await replaceInNotes(v, { search: "target", replace: "hit", folder: "Sub" });
    expect(out.total_replacements).toBe(1);
    expect(out.files_updated[0]?.path).toBe(path.join("Sub", "SubDoc.md"));
    // Root file untouched.
    expect(await fs.readFile(path.join(root, "RootDoc.md"), "utf8")).toBe("target\n");
  });

  it("returns total=0 when no notes match (no error)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "anything.md"), "no relevant text\n");
    const out = await replaceInNotes(v, { search: "xyzzy", replace: "quux" });
    expect(out.total_replacements).toBe(0);
    expect(out.files_updated).toEqual([]);
    expect(out.files_scanned).toBeGreaterThan(0);
  });

  it("rejects empty search", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await expect(replaceInNotes(v, { search: "", replace: "x" })).rejects.toThrow(/non-empty/);
  });

  it("rejects identical search and replace (no-op refused)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await expect(replaceInNotes(v, { search: "same", replace: "same" })).rejects.toThrow(/no-op/);
  });

  it("can delete every occurrence (replace is empty string, search is non-empty)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "stripme.md"), "Hello DEPRECATED world\nDEPRECATED line\n");
    const out = await replaceInNotes(v, { search: "DEPRECATED ", replace: "" });
    expect(out.total_replacements).toBe(2);
    const txt = await fs.readFile(path.join(root, "stripme.md"), "utf8");
    expect(txt).toBe("Hello world\nline\n");
  });

  it("respects --read-paths allowlist (writes outside allowlist refused)", async () => {
    const v = new Vault(root, { enableWrite: true, readPaths: ["Public/**"] });
    await v.ensureExists();
    await fs.mkdir(path.join(root, "Public"), { recursive: true });
    await fs.mkdir(path.join(root, "Private"), { recursive: true });
    await fs.writeFile(path.join(root, "Public", "p.md"), "marker\n");
    await fs.writeFile(path.join(root, "Private", "s.md"), "marker\n");
    const out = await replaceInNotes(v, { search: "marker", replace: "hit" });
    // Only Public/p.md is visible — and updated.
    expect(out.files_updated.map((p) => p.path)).toEqual([path.join("Public", "p.md")]);
    // Private file untouched.
    expect(await fs.readFile(path.join(root, "Private", "s.md"), "utf8")).toBe("marker\n");
  });
});

describe("archiveNote (v1.11)", () => {
  it("refuses to write when vault is read-only", async () => {
    const v = new Vault(root, { enableWrite: false });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Old.md"), "x");
    await expect(archiveNote(v, { path: "Old.md" })).rejects.toThrow(/read-only/);
  });

  it("moves a note to the default Archive/ folder + bare backlinks stay valid", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Old.md"), "Body\n");
    // Bare wikilink — under rename_note's preserved-convention rules, a bare
    // basename target stays bare (and findBestMatch still resolves it after
    // the move because `Old.md` is unique by basename in the vault).
    await fs.writeFile(path.join(root, "Hub.md"), "Bare ref: [[Old]]\n");
    // Path-qualified wikilink — should be rewritten to point at the new path.
    await fs.writeFile(path.join(root, "Direct.md"), "Direct ref: [[Old]]\n");
    await fs.writeFile(path.join(root, "Qualified.md"), "Qualified: [[Old]]\n");
    // Add a path-qualified caller specifically.
    await fs.writeFile(path.join(root, "PathRef.md"), "From root: [[Old.md]]\n");
    const out = await archiveNote(v, { path: "Old.md" });
    expect(out.from).toBe("Old.md");
    expect(out.to).toBe(path.join("Archive", "Old.md"));
    expect(await fs.stat(path.join(root, "Archive", "Old.md")).catch(() => null)).not.toBeNull();
    expect(await fs.stat(path.join(root, "Old.md")).catch(() => null)).toBeNull();
    // Bare wikilink stays bare — still resolves via findBestMatch basename match.
    const hub = await fs.readFile(path.join(root, "Hub.md"), "utf8");
    expect(hub).toContain("[[Old]]");
  });

  it("supports custom archive_folder + strips a leading folder from source", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.mkdir(path.join(root, "Inbox"), { recursive: true });
    await fs.writeFile(path.join(root, "Inbox", "Stale.md"), "x\n");
    // Source is in Inbox/; archive folder is Archive/2026/. Result should be
    // Archive/2026/Stale.md (basename only, not Archive/2026/Inbox/Stale.md).
    const out = await archiveNote(v, { path: "Inbox/Stale.md", archive_folder: "Archive/2026" });
    expect(out.to).toBe(path.join("Archive", "2026", "Stale.md"));
    expect(await fs.stat(path.join(root, "Archive", "2026", "Stale.md")).catch(() => null)).not.toBeNull();
  });

  it("dry_run previews without touching disk", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Live.md"), "x\n");
    const out = await archiveNote(v, { path: "Live.md", dry_run: true });
    expect(out.dry_run).toBe(true);
    // File NOT moved.
    expect(await fs.stat(path.join(root, "Live.md")).catch(() => null)).not.toBeNull();
    expect(await fs.stat(path.join(root, "Archive", "Live.md")).catch(() => null)).toBeNull();
  });

  it("refuses if the archive destination already exists (overwrite=false)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.mkdir(path.join(root, "Archive"), { recursive: true });
    await fs.writeFile(path.join(root, "Dup.md"), "live\n");
    await fs.writeFile(path.join(root, "Archive", "Dup.md"), "already-archived\n");
    await expect(archiveNote(v, { path: "Dup.md" })).rejects.toThrow(/already exists/);
  });

  it("rejects empty path", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await expect(archiveNote(v, { path: "" })).rejects.toThrow(/required/);
  });

  it("trailing slash on archive_folder is normalized away", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Note.md"), "x\n");
    const out = await archiveNote(v, { path: "Note.md", archive_folder: "Archive///" });
    expect(out.to).toBe(path.join("Archive", "Note.md"));
  });
});

// v3.11.0-rc.18 — fixes for the 4-way external rc.17 audit (Codex findings).
// Inlined copies of the PRE-rc.18 (buggy/quadratic) loops serve as NEGATIVE controls.
function oldReplaceCI(line: string, search: string, needle: string, replace: string): string {
  let mutated = line;
  let lowered = mutated.toLowerCase();
  let idx = lowered.indexOf(needle);
  while (idx !== -1) {
    mutated = mutated.slice(0, idx) + replace + mutated.slice(idx + search.length);
    lowered = mutated.toLowerCase();
    idx = lowered.indexOf(needle, idx + replace.length);
  }
  return mutated;
}
function oldReplaceCS(line: string, search: string, replace: string): { content: string; count: number } {
  let mutated = line;
  let idx = mutated.indexOf(search);
  let count = 0;
  while (idx !== -1) {
    mutated = mutated.slice(0, idx) + replace + mutated.slice(idx + search.length);
    count += 1;
    idx = mutated.indexOf(search, idx + replace.length);
  }
  return { content: mutated, count };
}
function ms(fn: () => void): number {
  const a = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - a) / 1e6;
}

describe("replaceStringOutsideCodeFences (rc.18 audit) — Unicode offset + linearity", () => {
  it("case-insensitive replace applies offsets to ORIGINAL chars, not the folded string (Codex DATA-INTEGRITY)", () => {
    // `İ`(U+0130).toLowerCase() = `i̇` (2 units) → the rc.17 code mis-offset every match after it.
    expect(replaceStringOutsideCodeFences("İX", "x", "Y", false)).toEqual({ content: "İY", count: 1 });
    expect(replaceStringOutsideCodeFences("İX\nplain X\n", "x", "Y", false).content).toBe("İY\nplain Y\n");
    expect(replaceStringOutsideCodeFences("aBc", "b", "_", false).content).toBe("a_c"); // ASCII unaffected
  });

  it("NEGATIVE control — the pre-rc.18 fold-index-on-original code produced the wrong span", () => {
    // Proves the test discriminates: the old loop writes `İXY` (target X survives, Y misplaced).
    expect(oldReplaceCI("İX", "x", "x", "Y")).toBe("İXY");
    expect(replaceStringOutsideCodeFences("İX", "x", "Y", false).content).not.toBe("İXY");
  });

  it("v3.11.1-rc.1 — case-insensitive Greek word-final sigma matches (was a SILENT under-replace)", () => {
    // `"ΟΔΟΣ".toLowerCase()` === "οδος" (word-final ς) but the line folds per code point to
    // "οδοσ" (medial σ) — so the pre-rc.1 whole-string needle missed. Both fold per code point now.
    expect(replaceStringOutsideCodeFences("ΟΔΟΣ here", "ΟΔΟΣ", "ROAD", false)).toEqual({
      content: "ROAD here",
      count: 1
    });
    // medial-σ body, final-Σ search → still matches (the fold is context-free on both sides)
    expect(replaceStringOutsideCodeFences("οδοσ here", "ΟΔΟΣ", "ROAD", false).count).toBe(1);
    // controls that must NOT regress:
    expect(replaceStringOutsideCodeFences("ΟΔΟΣ here", "ΟΔΟΣ", "ROAD", true).count).toBe(1); // case-sensitive
    expect(replaceStringOutsideCodeFences("ΣΟ here", "ΣΟ", "X", false).count).toBe(1); // non-final sigma
    expect(replaceStringOutsideCodeFences("İX", "x", "Y", false)).toEqual({ content: "İY", count: 1 }); // rc.18 İ holds
  });

  it("NEGATIVE control — the pre-rc.1 whole-string `search.toLowerCase()` needle missed the final-sigma match", () => {
    // Reproduce the bug inline: whole-string fold the needle, per-code-point fold the haystack.
    const search = "ΟΔΟΣ";
    const body = "ΟΔΟΣ here";
    const wholeNeedle = search.toLowerCase(); // "οδος" (final ς) — the bug
    const perCpHaystack = [...body].map((c) => c.toLowerCase()).join(""); // "οδοσ here" (medial σ)
    expect(perCpHaystack.indexOf(wholeNeedle)).toBe(-1); // the silent miss the fix removes
    expect(replaceStringOutsideCodeFences(body, search, "ROAD", false).count).toBe(1); // fixed
  });

  it("case-sensitive single-pass ≡ the pre-rc.18 slice+concat loop (DIFFERENTIAL — fence-free corpus)", () => {
    const corpus: Array<[string, string, string]> = [
      ["abab", "ab", "x"],
      ["aaaa", "aa", "Z"],
      ["aaa", "aa", "X"],
      ["No match here", "zzz", "q"],
      ["a.b.c.d", ".", "/"],
      ["xXxX", "x", "—"],
      ["GPT-3.5 and GPT-3.5", "GPT-3.5", "GPT-4"],
      ["edge", "e", "EE"],
      ["", "a", "b"],
      ["repeat", "e", ""]
    ];
    for (const [line, s, r] of corpus) {
      const got = replaceStringOutsideCodeFences(line, s, r, true);
      const old = oldReplaceCS(line, s, r);
      expect(got, `mismatch for ${JSON.stringify([line, s, r])}`).toEqual(old);
    }
  });

  // rc.20 — generous ceiling for the POSITIVE + RATIO for the NEGATIVE (these wall-clock
  // tests are a CI-load flake surface; the ratio is runner-speed-independent).
  it("is O(n) on a dense single-match note (POSITIVE — generous ceiling; was ~30 s)", () => {
    const note = "a".repeat(10_000);
    const t = ms(() => replaceStringOutsideCodeFences(note, "a", "B".repeat(4096), false));
    expect(t).toBeLessThan(2000); // ~1 ms actual; the pre-rc.18 O(n²) loop was ~30 s
  });

  it("NEGATIVE control — the pre-rc.18 quadratic loop is slow on the same shape (FLOOR on the old time)", () => {
    const note = "a".repeat(2_000);
    const slow = ms(() => oldReplaceCS(note, "a", "B".repeat(4096)));
    // rc.22 — absolute floor, not a ratio (the rc.20 `slow/fast > 8` divided by a noise-dominated
    // sub-ms `fast` and flaked on CI). The O(n²) slice+concat rebuild is ~830 ms here on a laptop;
    // CI is slower, so a 50 ms floor can only fail at 16× laptop speed. Load pushes `slow` UP.
    expect(slow).toBeGreaterThan(50);
  });
});

describe("replaceInNotes (rc.18 audit) — projected-size cap refuses over-limit rewrites in BOTH modes", () => {
  it("dry_run reports an over-limit note as an error, not a phantom success (Codex RESOURCE-DOS)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-rc18-cap-"));
    const v = new Vault(dir, { enableWrite: true, maxFileBytes: 1000 });
    await v.ensureExists();
    await fs.writeFile(path.join(dir, "big.md"), "a".repeat(600)); // 600 'a' × replace "BB" → 1200 B > 1000
    const out = await replaceInNotes(v, { search: "a", replace: "BB", dry_run: true });
    expect(out.partial).toBe(true);
    expect(out.files_updated.length).toBe(0); // NOT reported as updated
    expect(out.errors?.[0]?.message).toMatch(/projected \d+ bytes exceeds limit 1000/);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("apply mode refuses the over-limit note and leaves it byte-unchanged (NEGATIVE control: a small note IS rewritten)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-rc18-cap2-"));
    const v = new Vault(dir, { enableWrite: true, maxFileBytes: 1000 });
    await v.ensureExists();
    await fs.writeFile(path.join(dir, "big.md"), "a".repeat(600));
    await fs.writeFile(path.join(dir, "small.md"), "a a a"); // tiny → rewritten fine
    const out = await replaceInNotes(v, { search: "a", replace: "BB" });
    expect(await fs.readFile(path.join(dir, "big.md"), "utf8")).toBe("a".repeat(600)); // refused, unchanged
    expect(await fs.readFile(path.join(dir, "small.md"), "utf8")).toBe("BB BB BB"); // applied
    expect(out.files_updated.map((f) => f.path)).toEqual(["small.md"]);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

// v3.11.5-rc.1 (full-audit WRITE-FENCE-TOGGLE-INLINE-SPAN, MED) — the write-path fence classifier
// used a bare `/^\s*(```|~~~)/` line-toggle that disagreed with the parser's stripCodeAndInline: a
// line STARTING with a self-contained inline ```span``` flipped inFence with no closing bare-fence
// line to flip it back, so every following line was treated as in-fence and rename_note backlink
// rewrites / replace_in_notes edits were silently dropped (rename still reported success). Fixed with
// opensBlockFence(), which recognizes an inline span (leading fence run CLOSED on the same line) as
// NOT a block-fence toggle. These pin the classifier + both rewriters + a real-block-fence control.
describe("write-path code-fence classifier — inline-span desync (v3.11.5-rc.1)", () => {
  it("opensBlockFence: bare/info-string fences toggle, a line-leading inline span does NOT", () => {
    for (const l of ["```", "```js", "~~~", "   ```", "````", "~~~ruby"]) {
      expect(opensBlockFence(l), `${JSON.stringify(l)} is a block-fence delimiter`).toBe(true);
    }
    for (const l of ["```inline``` at line start", "```a```", "`code`", "not a fence", "text ```x```"]) {
      expect(opensBlockFence(l), `${JSON.stringify(l)} is NOT a block-fence delimiter`).toBe(false);
    }
  });

  it("rename_note backlink rewrite is NOT dropped after a line-leading inline span (POSITIVE)", () => {
    const r = rewriteOutsideCodeFences(
      "```inline``` at line start\n[[Target]] should be renamed",
      new Map([["Target", { kind: "wikilink", newRaw: "Renamed" }]])
    );
    expect(r.count).toBe(1);
    expect(r.content).toContain("[[Renamed]]");
  });

  it("replace_in_notes edit is NOT skipped after a line-leading inline span (POSITIVE)", () => {
    const r = replaceStringOutsideCodeFences("```inline``` at line start\nplease fix teh typo", "teh", "the", true);
    expect(r.count).toBe(1);
    expect(r.content).toContain("the typo");
  });

  it("a REAL multi-line block fence still shields its contents (NEGATIVE control)", () => {
    const r = rewriteOutsideCodeFences(
      "[[A]] before\n```\n[[A]] inside\n```\n[[A]] after",
      new Map([["A", { kind: "wikilink", newRaw: "B" }]])
    );
    expect(r.count).toBe(2); // only the two OUTSIDE links
    expect(r.content).toContain("[[A]] inside"); // in-fence link untouched
  });

  it("v3.11.5-rc.5 — a `~~~` inside a ``` block does not un-shield later links (char-aware toggle)", () => {
    // Pre-rc.5 the char-blind toggle treated the inner `~~~` as closing the ``` block, so
    // [[B]] (still inside the block) was wrongly rewritten AND [[C]] (real, after) was skipped.
    const r = rewriteOutsideCodeFences(
      "```\n[[A]] in\n~~~\n[[B]] still in\n```\n[[C]] out",
      new Map([
        ["A", { kind: "wikilink", newRaw: "X" }],
        ["B", { kind: "wikilink", newRaw: "Y" }],
        ["C", { kind: "wikilink", newRaw: "Z" }]
      ])
    );
    expect(r.count).toBe(1); // only [[C]] → [[Z]]
    expect(r.content).toContain("[[B]] still in"); // in-fence, untouched (was [[Y]] pre-rc.5)
    expect(r.content).toContain("[[Z]] out"); // real, rewritten (was skipped pre-rc.5)
  });
});
