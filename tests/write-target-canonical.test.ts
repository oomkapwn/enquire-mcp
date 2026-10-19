import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chatThreadAppend } from "../src/tools/read.js";
import { createNote, frontmatterSet } from "../src/tools/write.js";
import { Vault } from "../src/vault.js";

// FA-11 — a write path that is not the canonical path of its own file.
//
// `writeNoteContent` TRIMMED the relative path it was given, while the read
// side (`resolveInside`, `toRel`) did not. A target whose name carries a
// leading or trailing space (` Dest.md`) was therefore READ through its exact
// name and WRITTEN through the trimmed one — two different files. The write
// landed on the unrelated `Dest.md` and replaced its content, and the tool
// answered with the padded name it never wrote.
//
// The MCP input schemas do not trim either (`z.string()` /
// `z.string().min(1)`), so the padded path reached the tool intact:
// `obsidian_frontmatter_set({ path: " Dest.md", set: { … } })` was enough.
//
// The guard lives in the write PRIMITIVE, not in one caller: a name the write
// path cannot address is refused loudly there, so no caller can read one file
// and write another. The controls below pin that refusal, pin that the
// addresses the two sides used to disagree, and pin that the guard does not
// over-refuse a name whose space is INSIDE the path.

const SPACED = " Dest.md";
const PLAIN = "Dest.md";
const SPACED_BYTES = "# Spaced\n\nSPACED-SENTINEL\n";
const PLAIN_BYTES = "# Plain\n\nPLAIN-SENTINEL\n";
const NOT_CANONICAL = /Refusing to write — the target path is not canonical/u;

let root = "";

function vaultFor(): Vault {
  // `**/*.md` admits the padded name too, so the pre-fix write was never
  // blocked by the privacy filter — it was the write path itself that
  // redirected it.
  return new Vault(root, { enableWrite: true, readPaths: ["**/*.md"] });
}

async function fileExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.stat(absolutePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-write-target-"));
  await fs.writeFile(path.join(root, SPACED), SPACED_BYTES);
  await fs.writeFile(path.join(root, PLAIN), PLAIN_BYTES);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("FA-11: a write path that is not the canonical path of its own file", () => {
  it("CAUSE: the read side keeps the padded name, and the write side names the file it would have written", async () => {
    const vault = vaultFor();
    // The read side resolves and reports the padded name EXACTLY — this is
    // what made the two sides disagree.
    const abs = vault.resolveInside(SPACED);
    expect(path.basename(abs)).toBe(SPACED);
    expect(vault.toRel(abs)).toBe(SPACED);
    // The write side trims — that IS the defect — so it now refuses and says
    // which other file the old code would have replaced.
    const failure = await frontmatterSet(vault, { path: SPACED, set: { status: "changed" } }).then(
      () => "resolved",
      (error: Error) => error.message
    );
    expect(failure).toContain('" Dest.md"');
    expect(failure).toContain('"Dest.md"');
  });

  it("NEGATIVE: the write primitive refuses a padded path instead of replacing the trimmed file", async () => {
    const vault = vaultFor();
    await expect(vault.writeNote(SPACED, "# clobber\n", { overwrite: true })).rejects.toThrow(NOT_CANONICAL);
    // The point of the control: the file the old code would have written kept
    // its own bytes.
    expect(await fs.readFile(path.join(root, PLAIN), "utf8")).toBe(PLAIN_BYTES);
    expect(await fs.readFile(path.join(root, SPACED), "utf8")).toBe(SPACED_BYTES);
  });

  it("NEGATIVE: frontmatter_set on a padded name refuses instead of replacing the trimmed file", async () => {
    const vault = vaultFor();
    await expect(frontmatterSet(vault, { path: SPACED, set: { status: "changed" } })).rejects.toThrow(NOT_CANONICAL);
    expect(await fs.readFile(path.join(root, SPACED), "utf8")).toBe(SPACED_BYTES);
    expect(await fs.readFile(path.join(root, PLAIN), "utf8")).toBe(PLAIN_BYTES);
    // A refusal must not leave a transport file behind either.
    expect((await fs.readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("NEGATIVE: chat_thread_append on a padded name refuses instead of appending into the trimmed file", async () => {
    const vault = vaultFor();
    await expect(chatThreadAppend(vault, { note_path: SPACED, role: "user", content: "hello" })).rejects.toThrow(
      NOT_CANONICAL
    );
    expect(await fs.readFile(path.join(root, SPACED), "utf8")).toBe(SPACED_BYTES);
    expect(await fs.readFile(path.join(root, PLAIN), "utf8")).toBe(PLAIN_BYTES);
  });

  it("NEGATIVE: a trailing space is refused as well — the LAST segment moves too", async () => {
    await fs.writeFile(path.join(root, "Trailing.md "), "# Trailing\n\nTRAILING-SENTINEL\n");
    await fs.writeFile(path.join(root, "Trailing.md"), "# Trimmed\n\nTRIMMED-SENTINEL\n");
    // A name that ENDS in a space does not end in `.md`, so a `*.md` allowlist
    // never admits it and the target would simply be "not found". The broad
    // allowlist is what makes the trailing-space shape reachable at all —
    // which is why the realistic case is the LEADING space, and why this
    // control says so instead of pretending both are equally easy to reach.
    const vault = new Vault(root, { enableWrite: true, readPaths: ["**/*"] });
    await expect(frontmatterSet(vault, { path: "Trailing.md ", set: { status: "changed" } })).rejects.toThrow(
      NOT_CANONICAL
    );
    expect(await fs.readFile(path.join(root, "Trailing.md "), "utf8")).toBe("# Trailing\n\nTRAILING-SENTINEL\n");
    expect(await fs.readFile(path.join(root, "Trailing.md"), "utf8")).toBe("# Trimmed\n\nTRIMMED-SENTINEL\n");
  });

  it("NEGATIVE: create_note refuses a padded name instead of silently creating the trimmed one", async () => {
    const vault = vaultFor();
    await expect(createNote(vault, { path: " New.md", content: "# New\n" })).rejects.toThrow(NOT_CANONICAL);
    expect(await fileExists(path.join(root, " New.md"))).toBe(false);
    expect(await fileExists(path.join(root, "New.md"))).toBe(false);
  });

  it("NEGATIVE: a padded name with no trimmed sibling is refused and creates nothing", async () => {
    // The other half of the shape: with no `Dest.md` beside it, the old write
    // CREATED `Dest.md` out of the padded note's content, left the padded note
    // itself untouched, and answered with a change report for a file it never
    // changed. The refusal leaves no stray file either.
    await fs.rm(path.join(root, PLAIN));
    const vault = vaultFor();
    await expect(frontmatterSet(vault, { path: SPACED, set: { status: "changed" } })).rejects.toThrow(NOT_CANONICAL);
    expect(await fs.readFile(path.join(root, SPACED), "utf8")).toBe(SPACED_BYTES);
    expect(await fileExists(path.join(root, PLAIN))).toBe(false);
  });

  it("POSITIVE: a canonical name is still written, by the primitive and by the tool", async () => {
    const vault = vaultFor();
    await vault.writeNote(PLAIN, "# Plain\n\nWRITTEN-SENTINEL\n", { overwrite: true });
    expect(await fs.readFile(path.join(root, PLAIN), "utf8")).toBe("# Plain\n\nWRITTEN-SENTINEL\n");

    const result = await frontmatterSet(vault, { path: PLAIN, set: { status: "changed" } });
    expect(result.path).toBe(PLAIN);
    expect(result.changed_keys).toEqual(["+status"]);
    const written = await fs.readFile(path.join(root, PLAIN), "utf8");
    expect(written).toContain("status: changed");
    expect(written).toContain("WRITTEN-SENTINEL");
    // The padded neighbour is still untouched by a canonical write.
    expect(await fs.readFile(path.join(root, SPACED), "utf8")).toBe(SPACED_BYTES);
  });

  it("POSITIVE: a space INSIDE the path is a different file, and it is edited exactly", async () => {
    await fs.mkdir(path.join(root, "Notes"));
    await fs.writeFile(path.join(root, "Notes", SPACED), "# Interior\n\nINTERIOR-SENTINEL\n");
    const vault = vaultFor();
    // The whole path's EDGES carry the name, so an interior space is not a
    // padded name: the trim does not move it and the read and write sides
    // agree. The guard must not over-refuse it.
    const result = await frontmatterSet(vault, { path: `Notes/${SPACED}`, set: { status: "changed" } });
    expect(result.path).toBe(`Notes/${SPACED}`);
    const written = await fs.readFile(path.join(root, "Notes", SPACED), "utf8");
    expect(written).toContain("status: changed");
    expect(written).toContain("INTERIOR-SENTINEL");
  });
});
