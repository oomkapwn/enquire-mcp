import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renameNote, replaceInNotes } from "../src/tools/write.js";
import { Vault } from "../src/vault.js";
import { WriteRequestAbortedError } from "../src/write-lifecycle.js";

let root: string;

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
    const originals = new Map([
      ["Source.md", "# Source\n\nSelf [[Source]].\n"],
      ["Dest.md", "# Existing destination\n\nmust be restored\n"],
      ["Caller-A.md", "A points to [[Source]].\n"],
      ["Caller-B.md", "B points to [[Source|alias]].\n"]
    ]);
    for (const [name, content] of originals) await fs.writeFile(path.join(root, name), content);
    const vault = new Vault(root, { enableWrite: true });
    await vault.ensureExists();
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
