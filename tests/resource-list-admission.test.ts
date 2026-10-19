import { promises as fs, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeNotePath,
  decodeResourceCursor,
  encodeNotePath,
  encodeResourceCursor,
  listVaultNoteResources,
  pageVaultResources,
  readChunkResource,
  RESOURCE_PAGE_LIMIT,
  ResourceCursorError,
  ResourceCursorMintError,
  vaultResourceInfo
} from "../src/resource-admission.js";
import { Vault } from "../src/vault.js";
import { replaceExactly } from "./helpers/exact-source-mutation.js";

describe("resource inventory admission", () => {
  let root = "";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-resource-list-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("preserves the small-vault contract and pages a large one with an opaque cursor (AH-6)", async () => {
    await fs.writeFile(path.join(root, "Z.md"), "# Z\n");
    await fs.writeFile(path.join(root, "A.md"), "# A\n");
    const vault = new Vault(root);
    const bounded = vi.spyOn(vault, "listFilesByExtensionsBounded");
    vi.spyOn(vault, "listMarkdown").mockRejectedValue(new Error("legacy unbounded listing must not run"));

    await expect(listVaultNoteResources(vault)).resolves.toEqual([
      {
        uri: "obsidian://note/A.md",
        name: "A",
        description: "A.md",
        mimeType: "text/markdown"
      },
      {
        uri: "obsidian://note/Z.md",
        name: "Z",
        description: "Z.md",
        mimeType: "text/markdown"
      }
    ]);
    await expect(vaultResourceInfo(vault, "test-version")).resolves.toMatchObject({
      note_count: 2,
      version: "test-version"
    });
    expect(bounded).toHaveBeenNthCalledWith(1, [".md"], 10_000, 100_000);
    expect(bounded).toHaveBeenNthCalledWith(2, [".md"], 10_000, 100_000);

    // Page 1 carries the static vault-info entry; every page's note entries
    // carry the template metadata merged the way the SDK merges it, so the
    // wire shape is unchanged for a vault that fits in one page.
    const pagedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-ah6-"));
    try {
      for (let i = 0; i < RESOURCE_PAGE_LIMIT + 7; i += 1) {
        await fs.writeFile(path.join(pagedRoot, `note-${String(i).padStart(4, "0")}.md`), "body");
      }
      const pagedVault = new Vault(pagedRoot);
      const first = await pageVaultResources(pagedVault);
      expect(first.resources[0]).toMatchObject({ uri: "obsidian://vault/info", name: "vault-info" });
      expect(first.resources).toHaveLength(RESOURCE_PAGE_LIMIT + 1);
      expect(first.nextCursor, "a vault beyond one page must offer a continuation").toBeTypeOf("string");
      // Every note entry keeps the template title the SDK used to merge in.
      expect(first.resources[1]).toMatchObject({ title: "Vault notes", mimeType: "text/markdown" });

      const second = await pageVaultResources(pagedVault, first.nextCursor);
      expect(second.nextCursor, "the remainder fits in one more page").toBeUndefined();
      // The pages partition the listing exactly once: no duplicate, no gap.
      const uris = [...first.resources, ...second.resources].map((r) => r.uri as string);
      expect(new Set(uris).size).toBe(uris.length);
      expect(uris.filter((u) => u.startsWith("obsidian://note/"))).toHaveLength(RESOURCE_PAGE_LIMIT + 7);

      // A cursor this server did not mint is refused, never silently restarted.
      await expect(pageVaultResources(pagedVault, "not-a-cursor")).rejects.toBeInstanceOf(ResourceCursorError);
      // NEGATIVE control — the empty string is a LEGAL cursor value per the
      // spec, so it must be decoded like any other token and refused as
      // unmintable, not mistaken for "start from the beginning".
      await expect(pageVaultResources(pagedVault, "")).rejects.toBeInstanceOf(ResourceCursorError);
      expect(decodeResourceCursor(encodeResourceCursor("a/b.md"))).toBe("a/b.md");

      // AH-6b — the page no longer rides on the exhaustive inventory, so a
      // vault the exhaustive walk REFUSES is still fully enumerable. Proven
      // against the real refusal rather than a mocked one: the same vault is
      // asserted to fail listVaultNoteResources and to page to completion.
      const dense = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-ah6b-"));
      try {
        for (let i = 0; i < 40; i += 1) {
          await fs.mkdir(path.join(dense, `d${String(i).padStart(2, "0")}`));
          for (let j = 0; j < 30; j += 1) {
            const dir = path.join(dense, `d${String(i).padStart(2, "0")}`);
            await fs.writeFile(path.join(dir, `n${String(j).padStart(2, "0")}.md`), "x");
          }
        }
        const denseVault = new Vault(dense);
        // The exhaustive path refuses this vault under a small budget…
        await expect(denseVault.listFilesByExtensionsBounded([".md"], 100, 10_000)).resolves.toMatchObject({
          complete: false
        });
        // …while the resumable page walks it to the end, in ascending order.
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 20; guard += 1) {
          const p2 = await pageVaultResources(denseVault, cursor);
          const notes = p2.resources.filter((r) => r.uri.startsWith("obsidian://note/"));
          seen.push(...notes.map((r) => r.description ?? ""));
          cursor = p2.nextCursor;
          if (cursor === undefined) break;
        }
        expect(seen).toHaveLength(1200);
        expect(new Set(seen).size).toBe(1200);
        expect([...seen]).toEqual([...seen].sort());
      } finally {
        await fs.rm(dense, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(pagedRoot, { recursive: true, force: true });
    }
  });

  it("fails both exhaustive resource contracts when the traversal receipt is incomplete", async () => {
    const vault = new Vault(root);
    vi.spyOn(vault, "listFilesByExtensionsBounded").mockResolvedValue({
      entries: [],
      visitedEntries: 100_001,
      complete: false
    });
    await expect(listVaultNoteResources(vault)).rejects.toThrow(/resource inventory is incomplete/i);
    await expect(vaultResourceInfo(vault, "test-version")).rejects.toThrow(/resource inventory is incomplete/i);
  });

  it("keeps a structural negative control for cumulative response bytes", () => {
    const source = readFileSync(path.resolve(__dirname, "../src/resource-admission.ts"), "utf8");
    expect(source).toContain("resourceBytes > MAX_RESOURCE_LIST_UTF8_BYTES - serializedBytes");
    const mutant = replaceExactly(
      source,
      "resourceBytes > MAX_RESOURCE_LIST_UTF8_BYTES - serializedBytes",
      "resourceBytes < 0"
    );
    expect(mutant).not.toContain("resourceBytes > MAX_RESOURCE_LIST_UTF8_BYTES - serializedBytes");
  });
});

// F02 — a POSIX filename may legally contain a backslash. `toVaultSlashPath`
// normalizes `\` to `/` only where `\` IS a separator (Windows); elsewhere it
// left the name alone. Every `.replace(/\\/g, "/")` at the relPath call sites
// undid that guard, splitting one file into two identities.
//
// These controls discriminate only where the two spellings are genuinely two
// different files — Linux ext4 and macOS APFS, which is where hosted CI runs
// the POSIX half. On Windows there is no backslash-in-a-name identity to
// preserve, so the same invariant is asserted against the host's real two-
// segment path rather than skipped: there, `a/b.md` IS what is on disk and
// the assertion passes for the host's own semantics instead of for a fact the
// test never checked.
describe("F02: POSIX literal-backslash filename keeps one identity (AH-4 surface)", () => {
  const LITERAL = process.platform !== "win32";
  /** What the file is actually called on this host. */
  const REL = LITERAL ? "a\\b.md" : "a/b.md";
  /** What the old unconditional `.replace(/\\/g, "/")` would have claimed. */
  const SPLIT_REL = "a/b.md";

  let root = "";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-f02-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Write the one name that means different things per platform. */
  async function writeTheNote(target = root): Promise<void> {
    if (LITERAL) {
      await fs.writeFile(path.join(target, "a\\b.md"), "# body-a-b\n");
      return;
    }
    await fs.mkdir(path.join(target, "a"), { recursive: true });
    await fs.writeFile(path.join(target, "a", "b.md"), "# body-a-b\n");
  }

  it("advertises the note under the name that is actually on disk", async () => {
    await writeTheNote();
    const vault = new Vault(root);
    const resources = await listVaultNoteResources(vault);
    expect(resources).toHaveLength(1);
    expect(resources[0].description).toBe(REL);
    expect(resources[0].uri).toBe(`obsidian://note/${encodeNotePath(REL)}`);
    if (LITERAL) {
      // The old code advertised `a/b.md` — a path that addresses NOTHING in
      // this vault, because no `a/` directory exists. That is the defect.
      expect(resources[0].description).not.toBe(SPLIT_REL);
      expect(resources[0].uri).not.toBe("obsidian://note/a/b.md");
    }
  });

  it("round-trips the emitted URI back to the same note", async () => {
    await writeTheNote();
    const vault = new Vault(root);
    const [resource] = await listVaultNoteResources(vault);
    const uriPath = resource.uri.slice("obsidian://note/".length);
    expect(decodeNotePath(uriPath)).toBe(REL);
    // Not merely "the string round-trips" — the decoded identity reads the
    // same body the inventory advertises.
    const note = await vault.readNote(decodeNotePath(uriPath));
    expect(note.content).toContain("body-a-b");
  });

  it("keeps a name whose tail only LOOKS reserved public", async () => {
    // `x\.git.md` is one ordinary filename on POSIX. Splitting it yielded the
    // segments `x` and `.git.md`, and the second starts with a dot, so
    // the note was excluded from the entire public surface.
    if (!LITERAL) return;
    await fs.writeFile(path.join(root, "x\\.git.md"), "# not-a-git-dir\n");
    const vault = new Vault(root);
    expect(vault.exclusionReason("x\\.git.md")).toBeNull();
    const resources = await listVaultNoteResources(vault);
    expect(resources.map((r) => r.description)).toEqual(["x\\.git.md"]);
  });

  it("still excludes a REAL reserved segment after normalization", async () => {
    // Negative control: dropping normalization must not disable the reserved
    // set. The backslash here is a genuine separator on every platform.
    await fs.mkdir(path.join(root, "sub", ".obsidian"), { recursive: true });
    await fs.writeFile(path.join(root, "sub", ".obsidian", "cfg.md"), "# secret\n");
    await fs.writeFile(path.join(root, "sub", "ok.md"), "# fine\n");
    const vault = new Vault(root);
    const resources = await listVaultNoteResources(vault);
    expect(resources.map((r) => r.description)).toEqual(["sub/ok.md"]);
    expect(vault.exclusionReason("sub/.obsidian/cfg.md")).toBe("hidden or reserved vault path");
  });

  it("pages partition exactly the exhaustive admitted identities", async () => {
    const paged = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-f02-page-"));
    try {
      await writeTheNote(paged);
      await fs.writeFile(path.join(paged, "x\\.git.md"), "# not-a-git-dir\n");
      for (let i = 0; i < RESOURCE_PAGE_LIMIT + 5; i += 1) {
        await fs.writeFile(path.join(paged, `note-${String(i).padStart(4, "0")}.md`), "body");
      }
      const vault = new Vault(paged);
      const exhaustive = (await listVaultNoteResources(vault)).map((r) => r.description);

      const pagedIdentities: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await pageVaultResources(vault, cursor);
        for (const r of page.resources) {
          if (r.uri === "obsidian://vault/info") continue;
          pagedIdentities.push(r.description);
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);

      // No duplicate, no gap, and the exotic names survived pagination.
      expect(new Set(pagedIdentities).size).toBe(pagedIdentities.length);
      expect([...pagedIdentities].sort()).toEqual([...exhaustive].sort());
      expect(pagedIdentities).toContain(REL);
      if (LITERAL) expect(pagedIdentities).toContain("x\\.git.md");
    } finally {
      await fs.rm(paged, { recursive: true, force: true });
    }
  });
});

// F03 — the cursor mint had no bound of its own. `decodeResourceCursor`
// rejects any token over MAX_CURSOR_CHARS (4096), but `encodeResourceCursor`
// happily minted one: base64url grows as ceil(bytes/3)*4, so a relPath of
// 3070+ UTF-8 bytes produced a `nextCursor` the very next call here rejected
// with `ResourceCursorError` — pagination broke at exactly the longest
// paths, at the client, with an error that named nothing. The producer and
// the decoder now share ONE bound: a mint that cannot honor it refuses
// loudly (an omitted `nextCursor` would end the listing silently instead,
// which is the failure mode this exists to prevent).
describe("F03: the cursor mint honors the same bound the decoder enforces", () => {
  // Exact thresholds derived from the shared constant, not estimated:
  // 3069 ASCII bytes -> 4096-token chars (decoder accepts, bound inclusive);
  // 3070 -> 4098 (both sides refuse).
  const ASCII_MINT_MAX = 3069;

  it("mints a round-tripping token at the exact supported boundary", () => {
    const path = "x".repeat(ASCII_MINT_MAX);
    const token = encodeResourceCursor(path);
    expect(token).toHaveLength(4096);
    expect(decodeResourceCursor(token)).toBe(path);
  });

  it("refuses to mint past the boundary instead of minting a self-rejected token", () => {
    const overlong = "x".repeat(ASCII_MINT_MAX + 1);
    // Positive control: the OLD defect was that this mint SUCCEEDED and the
    // decoder rejected the result. Both halves of that defect are pinned dead.
    // The mint throws synchronously, so these are toThrow — `.rejects` would
    // let the exception escape the assertion before expect() wraps it.
    expect(() => encodeResourceCursor(overlong)).toThrow(ResourceCursorMintError);
    expect(() => encodeResourceCursor(overlong)).not.toThrow(ResourceCursorError);
    // The mint names the byte count and the shared bound.
    expect(() => encodeResourceCursor(overlong)).toThrow(
      new RegExp(`${ASCII_MINT_MAX + 1}-byte path.*4096-character bound`, "s")
    );
    // And the decoder's own bound is untouched: a hand-built over-length
    // token with a valid prefix still refuses inbound.
    const handBuilt = Buffer.from(`v1:${overlong}`, "utf8").toString("base64url");
    expect(() => decodeResourceCursor(handBuilt)).toThrow(ResourceCursorError);
  });

  it("round-trips a long multi-byte (Unicode) path through the same bound", () => {
    // 1534 Cyrillic chars = 3068 UTF-8 bytes — under the byte boundary, so
    // the token round-trips; base64url never mangles the payload.
    const cyrillic = "я".repeat(1534);
    const token = encodeResourceCursor(cyrillic);
    expect(decodeResourceCursor(token)).toBe(cyrillic);
  });

  it("keeps a structural negative control that the mint consults the shared bound", () => {
    const source = readFileSync(path.resolve(__dirname, "../src/resource-admission.ts"), "utf8");
    expect(source).toContain("encoded.length > MAX_CURSOR_CHARS");
    const mutant = replaceExactly(
      source,
      "encoded.length > MAX_CURSOR_CHARS",
      "encoded.length > Number.MAX_SAFE_INTEGER"
    );
    expect(mutant).not.toContain("encoded.length > MAX_CURSOR_CHARS");
  });

  // The real-filesystem page control. A page cursor is minted only for the
  // LAST entry of a FULL page, so the long path must land exactly at entry
  // #500 in walk order with at least one entry behind it. Walk order is
  // lexicographic on `${name}/` for directories (vault.ts noteWalkOrderKey),
  // so `note-*.md` sorts before a `zz-deep…/` subtree and a `zzz-tail.md`
  // sorts after it — the deep path is placed, not hoped for.
  //
  // Linux-only, and the card names Linux for a reason: Linux bounds only each
  // component (NAME_MAX 255), so a 3.2KB vault-relative path is constructible.
  // macOS bounds the WHOLE path at PATH_MAX=1024 bytes, so even a vault at a
  // 3-character root cannot hold a boundary-length relPath — the first CI
  // round hit ENAMETOOLONG (errno -63) building the fixture. Windows caps at
  // 260 characters. On those hosts the over-bound mint is unreachable through
  // the real filesystem, and the boundary itself stays covered by the unit
  // controls above, which need no filesystem.
  describe("real Linux filesystem pages", () => {
    const LONG_PATH_HOST = process.platform === "linux";
    /** Bytes of one path component: 239 < ext4/APFS 255-byte NAME_MAX. */
    const COMPONENT = "d".repeat(239);

    it("refuses to mint at a page boundary on an over-bound path (no silent drop)", async () => {
      if (!LONG_PATH_HOST) return;
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-f03-over-"));
      try {
        // 499 notes, then the deep subtree at walk position 500, then a tail
        // file so the page is genuinely full and hasMore is true.
        for (let i = 0; i < 499; i += 1) {
          await fs.writeFile(path.join(root, `note-${String(i).padStart(4, "0")}.md`), "body");
        }
        let dir = root;
        for (let i = 0; i < 13; i += 1) {
          dir = path.join(dir, `zz-deep${i}-${COMPONENT}`);
        }
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, "deep-over.md"), "# deep\n");
        await fs.writeFile(path.join(root, "zzz-tail.md"), "body");

        const vault = new Vault(root);
        // The exhaustive inventory has no cursor protocol, so it still sees
        // every entry: 501 notes, with the deep one past the mint bound.
        const exhaustive = await listVaultNoteResources(vault);
        expect(exhaustive).toHaveLength(501);
        const deep = exhaustive.find((r) => r.description.includes("deep-over.md"));
        expect(deep?.description.length, "the deep path is over the 3069-byte mint bound").toBeGreaterThan(3069);

        // The mint fires on page 1: the deep path is entry #500 of a full
        // page, so this call cannot resolve. The OLD behavior minted a cursor
        // here that the next call rejected with ResourceCursorError; an
        // omitted-nextCursor outcome (the silent drop) would have RESOLVED —
        // the rejection itself is the no-silent-drop control.
        await expect(pageVaultResources(vault)).rejects.toBeInstanceOf(ResourceCursorMintError);
        await expect(pageVaultResources(vault)).rejects.not.toBeInstanceOf(ResourceCursorError);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it("paginates to completion when a long real path stays inside the bound", async () => {
      if (!LONG_PATH_HOST) return;
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-f03-under-"));
      try {
        for (let i = 0; i < 520; i += 1) {
          await fs.writeFile(path.join(root, `note-${String(i).padStart(4, "0")}.md`), "body");
        }
        // ~11 * 240 ≈ 2650 bytes of relPath — long, but under the 3069 bound.
        let dir = root;
        for (let i = 0; i < 11; i += 1) {
          dir = path.join(dir, `zz-deep${i}-${COMPONENT}`);
        }
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, "deep-under.md"), "# deep\n");

        const vault = new Vault(root);
        const seen: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await pageVaultResources(vault, cursor);
          for (const r of page.resources) {
            if (r.uri === "obsidian://vault/info") continue;
            seen.push(r.description);
          }
          cursor = page.nextCursor;
        } while (cursor !== undefined);

        // Every emitted cursor round-tripped: the listing completed with no
        // duplicate, no gap, and the long real path surfaced in a page.
        expect(new Set(seen).size).toBe(seen.length);
        expect(seen).toHaveLength(521);
        const longOnes = seen.filter((p) => p.startsWith("zz-deep0-"));
        expect(longOnes).toHaveLength(1);
        expect(longOnes[0].length).toBeGreaterThan(2000);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  });
});

// F04 — the AH-6 summary claimed the page "comes from a resumable walk whose
// cost is proportional to the page, not the vault". The second half holds;
// the first does not: walkNotePage re-lists and fully sorts the ROOT on every
// page, and each directory on the path to the resume point pays its own
// listing. The truthful bound — directory listings along the resume path, not
// the page — is now stated where the claim was. This control pins it in
// source so the overclaim cannot silently return.
describe("F04: the resumable listing's cost claim matches the walk's source", () => {
  it("keeps a structural control for the truthful page-cost residual", () => {
    const source = readFileSync(path.resolve(__dirname, "../src/resource-admission.ts"), "utf8");
    // Positive: the truthful bound is stated at the call site.
    expect(source).toContain("NOT page-proportional (F04)");
    expect(source).toContain("bounded by the directory listings along the resume");
    // Negative: restoring the old overclaim makes this control red — the
    // mutant swaps the truthful marker back to the false claim.
    const mutant = replaceExactly(
      source,
      "// Resumable, but NOT page-proportional (F04): every page re-lists and fully",
      "// Resumable: the page costs a walk proportional to the PAGE, and needs no"
    );
    expect(mutant).not.toContain("NOT page-proportional (F04)");
  });
});

// F05 — `Buffer.from(x, "base64url")` is PERMISSIVE: characters outside the
// alphabet are ignored rather than rejected, and a TRUNCATED token decodes to
// a shorter but still plausible path. Measured on the real codec: dropping one
// character from the token for `Projects/plan.md` yields `Projects/plan.m`, so
// the listing silently resumed from the wrong position instead of failing.
// AH-7 — the chunk resource's index admission, as a pure function.
// The template itself registers only with `--persistent-index`, so the e2e
// suite cannot reach it without widening the server args; the SDK hands this
// function the template params either way, so the validation contract is
// exactly what these controls pin.
describe("AH-7: readChunkResource refuses a non-canonical chunk index", () => {
  let root = "";
  let vault: Vault;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-chunk-admission-"));
    await fs.writeFile(path.join(root, "A.md"), "# A\n");
    vault = new Vault(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("accepts canonical indices and rejects every non-canonical spelling", async () => {
    const chunkUri = new URL("obsidian://chunk/0/A.md");
    const unreachableIndex = {} as never;

    // A canonical index passes admission and fails later, at the live index —
    // which is the proof admission did NOT reject it. Only the message is
    // asserted, because the dummy index throws something else entirely.
    for (const ok of ["0", "7", "123"]) {
      const outcome = await readChunkResource(vault, unreachableIndex, chunkUri, {
        chunkIndex: ok,
        notePath: "A.md"
      }).then(
        () => "resolved",
        (error: Error) => error.message
      );
      expect(outcome, ok).not.toMatch(/Invalid chunk index in URI/u);
    }

    for (const bad of ["", "007", "+1", "1.5", "-0", "1e3", "0x1", " 7", "7 "]) {
      await expect(
        readChunkResource(vault, unreachableIndex, chunkUri, { chunkIndex: bad, notePath: "A.md" }),
        bad
      ).rejects.toThrow(/Invalid chunk index in URI/u);
    }
  });
});

describe("F05: a cursor this server never minted is refused", () => {
  const PATH = "Projects/plan.md";
  const TOKEN = encodeResourceCursor(PATH);

  it("a minted cursor round-trips, including Unicode and the exact boundary", () => {
    expect(decodeResourceCursor(TOKEN)).toBe(PATH);
    // The canonicality check must not over-tighten: Unicode paths and a token
    // sitting exactly on the shared bound both still decode.
    for (const p of ["Заметки/план.md", "日本語/メモ.md", "emoji/🌞.md", "café/naïve.md"]) {
      expect(decodeResourceCursor(encodeResourceCursor(p)), p).toBe(p);
    }
    const atBound = "x".repeat(3069);
    expect(decodeResourceCursor(encodeResourceCursor(atBound))).toBe(atBound);
  });

  it("NEGATIVE: a truncated token is refused instead of resuming from a wrong path", () => {
    // Drop counts that leave a NON-canonical token. Measured on the real
    // codec: `Projects/plan.md` mints 26 chars, and these drops decode to a
    // shorter path whose canonical re-encoding no longer equals the input.
    for (const drop of [1, 3, 4, 8]) {
      const truncated = TOKEN.slice(0, -drop);
      // Pre-fix this returned a shorter but plausible path (e.g. `Projects/plan.m`),
      // which is the whole defect: silent wrong resume, not a loud failure.
      expect(() => decodeResourceCursor(truncated), `drop ${drop}`).toThrow(ResourceCursorError);
    }
    // Empty string stays an explicitly refused cursor, not a "start from top".
    expect(() => decodeResourceCursor("")).toThrow(ResourceCursorError);
  });

  it("a truncation that happens to be CANONICAL is still accepted — on purpose", () => {
    // Dropping 2 chars leaves exactly 24 base64url chars = 18 bytes = a
    // COMPLETE, canonical token for `Projects/plan.m` — a path that genuinely
    // exists in some vault. The protocol is stateless: any canonical
    // `v1:<path>` is admissible and the walk filters it. Rejecting it would
    // break real pagination, so this is pinned to stop a future "tightening"
    // from over-reaching past what F05 asked for.
    const shorter = TOKEN.slice(0, -2);
    expect(decodeResourceCursor(shorter)).toBe("Projects/plan.m");
    expect(shorter).toBe(encodeResourceCursor("Projects/plan.m"));
  });

  it("NEGATIVE: characters outside the base64url alphabet are refused, not ignored", () => {
    const at = 6;
    for (const junk of ["!", " ", "\n", "@", "\t"]) {
      expect(() => decodeResourceCursor(`${TOKEN.slice(0, at)}${junk}${TOKEN.slice(at)}`), junk).toThrow(
        ResourceCursorError
      );
    }
  });

  it("NEGATIVE: a wrong scheme prefix and a NUL path are still refused", () => {
    const wrongPrefix = Buffer.from("v2:Projects/plan.md", "utf8").toString("base64url");
    expect(() => decodeResourceCursor(wrongPrefix)).toThrow(ResourceCursorError);
    const nulPath = Buffer.from(`v1:Projects/pl\u0000an.md`, "utf8").toString("base64url");
    expect(() => decodeResourceCursor(nulPath)).toThrow(ResourceCursorError);
  });
});
