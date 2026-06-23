// v3.11.0-rc.13 — behavioral regression tests for the dual external rc.12 audit
// (Goose AUD-01/03/05 + audit-work L-1). Each finding was reproduced against the
// rc.12 code, fixed, and pinned here with a POSITIVE + NEGATIVE control per the
// CLAUDE.md rule since v3.6.4. Structural guards live in their inventory invariants
// (parser-input-cap for AUD-04 key caps; name-fold-invariant for the producer fold).

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractFrontmatterTags } from "../src/parser.js";
import { listTags } from "../src/tools/read.js";
import { createNote, frontmatterSet } from "../src/tools/write.js";
import { Vault } from "../src/vault.js";

const tmpRoots: string[] = [];
async function freshVault(opts: { enableWrite?: boolean } = {}): Promise<{ root: string; v: Vault }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-rc13-"));
  tmpRoots.push(root);
  return { root, v: new Vault(root, opts) };
}
afterEach(async () => {
  for (const r of tmpRoots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});

describe("rc.12-audit AUD-01 (Goose, MEDIUM) — atomic writeNote overwrite must not follow a pre-planted .tmp symlink", () => {
  it("a pre-planted `<note>.md.tmp` symlink to an OUT-OF-VAULT file does NOT redirect the write or replace the note (POSITIVE)", async () => {
    const { root, v } = await freshVault({ enableWrite: true });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-outside-"));
    tmpRoots.push(outside);
    const outsideFile = path.join(outside, "outside.txt");
    await fs.writeFile(path.join(root, "victim.md"), "OLD");
    await fs.writeFile(outsideFile, "OUTSIDE_OLD");
    // attacker pre-plants the (pre-rc.13 deterministic) tmp path as a symlink out of the vault
    await fs.symlink(outsideFile, path.join(root, "victim.md.tmp"));

    await v.writeNote("victim.md", "NEW_CONTENT", { overwrite: true });

    // the external file is untouched (the write did NOT follow the symlink) …
    expect(await fs.readFile(outsideFile, "utf8")).toBe("OUTSIDE_OLD");
    // … the note got the new content as a REGULAR file (not replaced by a symlink) …
    expect(await fs.readFile(path.join(root, "victim.md"), "utf8")).toBe("NEW_CONTENT");
    expect((await fs.lstat(path.join(root, "victim.md"))).isSymbolicLink()).toBe(false);
  });

  it("overwrite still works normally with no pre-planted tmp (NEGATIVE control — the fix didn't break the happy path)", async () => {
    const { root, v } = await freshVault({ enableWrite: true });
    await fs.writeFile(path.join(root, "n.md"), "OLD");
    await v.writeNote("n.md", "NEW", { overwrite: true });
    expect(await fs.readFile(path.join(root, "n.md"), "utf8")).toBe("NEW");
    // no nonce .tmp left behind on the success path
    const leftover = (await fs.readdir(root)).filter((f) => f.endsWith(".tmp"));
    expect(leftover).toEqual([]);
  });
});

describe("rc.12-audit AUD-03 (Goose, LOW) — tag PRODUCER folds the tags/tag KEY (case/NFC-variant `Tags:` is visible)", () => {
  it("extractFrontmatterTags recovers a case-variant `Tags`/`Tag` KEY (POSITIVE)", () => {
    // The KEY is folded (case/NFC); the tag VALUE's case is preserved (rc.9 `nfc()` is
    // case-preserving). Pre-rc.13 a `Tags:`/`TAG:` key returned [] (invisible to retrieval).
    expect(extractFrontmatterTags({ Tags: ["Project"] })).toEqual(["Project"]);
    expect(extractFrontmatterTags({ TAG: "idea" })).toEqual(["idea"]);
    // an NFD-on-disk key folds to NFC `tags`
    const nfdKey = `caf${String.fromCodePoint(0x65, 0x301)}tags`.normalize("NFD"); // not "tags" → must NOT match
    expect(extractFrontmatterTags({ [nfdKey]: ["x"] })).toEqual([]); // unrelated key → no tags
  });

  it("a genuinely tag-less frontmatter yields no tags (NEGATIVE control)", () => {
    expect(extractFrontmatterTags({ title: "no tags here" })).toEqual([]);
    expect(extractFrontmatterTags({})).toEqual([]);
  });

  it("list_tags aggregates a `Tags:` (upper) note together with a `tags:` (lower) note end-to-end (POSITIVE)", async () => {
    const { root, v } = await freshVault();
    await fs.writeFile(path.join(root, "upper.md"), "---\nTags: [Project]\n---\nbody\n");
    await fs.writeFile(path.join(root, "lower.md"), "---\ntags: [Project]\n---\nbody\n");
    const tags = await listTags(v, {});
    expect(tags.find((t) => t.tag === "project")?.count).toBe(2);
  });
});

describe("rc.12-audit AUD-05 (Goose, LOW) — frontmatter_set round-trips a literal `__proto__` key without pollution", () => {
  it("adding a literal `__proto__` key persists it as an own data property reported `+__proto__` (POSITIVE)", async () => {
    const { root, v } = await freshVault({ enableWrite: true });
    await createNote(v, { path: "n.md", content: "body" });
    const res = await frontmatterSet(v, { path: "n.md", set: JSON.parse('{"__proto__":"literal","status":"x"}') });
    expect(res.changed_keys).toContain("+__proto__"); // NEW key, not a prototype-chain `~`
    const text = await fs.readFile(path.join(root, "n.md"), "utf8");
    expect(text).toMatch(/^__proto__:/m); // actually written to disk
    // global prototype is NOT polluted
    expect(({} as Record<string, unknown>).literal).toBeUndefined();
  });

  it("a normal key still serializes as before (NEGATIVE control)", async () => {
    const { root, v } = await freshVault({ enableWrite: true });
    await createNote(v, { path: "n.md", content: "body" });
    const res = await frontmatterSet(v, { path: "n.md", set: { status: "published" } });
    expect(res.changed_keys).toEqual(["+status"]);
    expect(await fs.readFile(path.join(root, "n.md"), "utf8")).toMatch(/^status: published$/m);
  });
});
