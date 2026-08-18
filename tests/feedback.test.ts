// v3.11.0 — closed-loop retrieval feedback. Covers (1) the FeedbackStore unit
// (open / record / scores / cap / fail-soft / atomic persist), (2) defaultFeedbackFile
// dir+hash parity with defaultIndexFile (so prune erases it), (3) the prune erasure
// of the <hash>.feedback.json family, and (4) the searchHybrid feedback boost —
// a PROVABLE no-op at weight 0, and a marked note rising at weight > 0. Each block
// pairs a POSITIVE assertion with a NEGATIVE control.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultFeedbackFile,
  FeedbackStore,
  feedbackScore,
  MAX_FEEDBACK_ENTRIES,
  MAX_FEEDBACK_FILE_BYTES
} from "../src/feedback.js";
import { defaultIndexFile, planCachePrune } from "../src/fts5.js";
import { searchHybrid } from "../src/tools/index.js";
import { Vault } from "../src/vault.js";

const NOW = "2026-06-22T00:00:00.000Z";

describe("FeedbackStore (v3.11.0 closed-loop feedback)", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-feedback-"));
    file = path.join(dir, "test.feedback.json");
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.each([
    ["generic JSON", "feedback.json"],
    ["uppercase suffix", "feedback.FEEDBACK.JSON"],
    ["trailing LF", "feedback.feedback.json\n"],
    ["trailing U+2028", "feedback.feedback.json\u2028"]
  ] as const)("rejects %s before filesystem work", async (_shape, basename) => {
    const absentParent = path.join(dir, `invalid-${Buffer.from(basename).toString("hex")}`);
    await expect(FeedbackStore.open(path.join(absentParent, basename))).rejects.toThrow(
      new TypeError("Feedback store file must end exactly in '.feedback.json'")
    );
    await expect(fs.lstat(absentParent)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("open() on a missing file yields an empty store (fail-soft)", async () => {
    const store = await FeedbackStore.open(file);
    expect(store.size()).toBe(0);
    expect(store.scores().size).toBe(0);
  });

  it("record() persists and reflects useful marks in scores immediately (the closed loop)", async () => {
    const store = await FeedbackStore.open(file);
    const n = await store.record(["Notes/A.md", "Notes/B.md"], true, NOW);
    expect(n).toBe(2);
    expect(store.size()).toBe(2);
    // useful/(useful+notUseful+1) = 1/(1+0+1) = 0.5
    expect(store.scores().get("Notes/A.md")).toBeCloseTo(0.5, 10);
    // persisted to disk
    const onDisk = JSON.parse(await fs.readFile(file, "utf8"));
    expect(onDisk.entries["Notes/A.md"].useful).toBe(1);
    // a fresh open sees the persisted tally
    const reopened = await FeedbackStore.open(file);
    expect(reopened.scores().get("Notes/A.md")).toBeCloseTo(0.5, 10);
  });

  it("useful:false lowers the score; repeated useful marks raise it (monotonic in net usefulness)", async () => {
    const store = await FeedbackStore.open(file);
    await store.record(["A.md"], true, NOW); // 1/(1+0+1)=0.5
    await store.record(["A.md"], true, NOW); // 2/(2+0+1)=0.667
    expect(store.scores().get("A.md")).toBeCloseTo(2 / 3, 10);
    await store.record(["A.md"], false, NOW); // 2/(2+1+1)=0.5
    expect(store.scores().get("A.md")).toBeCloseTo(0.5, 10);
  });

  it("dedupes paths within a single record() call and trims blanks", async () => {
    const store = await FeedbackStore.open(file);
    const n = await store.record(["A.md", "A.md", "  ", "B.md"], true, NOW);
    expect(n).toBe(2); // A (once), B; blank skipped
    expect(store.scores().get("A.md")).toBeCloseTo(0.5, 10);
  });

  it("NEGATIVE control — a never-marked note has no score (absent from scores map)", async () => {
    const store = await FeedbackStore.open(file);
    await store.record(["A.md"], true, NOW);
    expect(store.scores().has("Never/Marked.md")).toBe(false);
  });

  it("NEGATIVE control — a net-negative note (more notUseful than useful) is omitted from scores", async () => {
    const store = await FeedbackStore.open(file);
    await store.record(["Bad.md"], false, NOW); // 0/(0+1+1)=0 → omitted (>0 filter)
    expect(store.scores().has("Bad.md")).toBe(false);
    expect(store.size()).toBe(1); // still recorded (tally kept), just not boosted
  });

  it("open() on a corrupt / non-JSON file fails soft to an empty store (never throws)", async () => {
    await fs.writeFile(file, "}{ not json at all", { mode: 0o600 });
    const store = await FeedbackStore.open(file);
    expect(store.size()).toBe(0);
  });

  it("sanitizes loaded entries (negative/NaN counts → 0)", async () => {
    await fs.writeFile(file, JSON.stringify({ version: 1, entries: { "A.md": { useful: -5, notUseful: "x" } } }));
    const store = await FeedbackStore.open(file);
    // useful clamped to 0, notUseful (NaN) → 0 → score 0/(0+0+1)=0 → omitted
    expect(store.scores().has("A.md")).toBe(false);
  });

  // v3.11.0-rc.8 (pre-promotion audit MED) — prototype-pollution NEGATIVE control.
  // record() writes agent-supplied path strings as map keys; "__proto__" / "constructor"
  // must NOT reach Object.prototype (the entries map is null-prototype). Discriminates the
  // fix: on a normal-object map this leaves ({}).useful === NaN + size 0 (the vuln).
  it('record(["__proto__"]) must NOT pollute Object.prototype — stored as a harmless own key', async () => {
    const store = await FeedbackStore.open(file);
    await store.record(["__proto__", "constructor", "Real.md"], true, NOW);
    // Object.prototype untouched — a fresh plain object has none of the entry fields.
    expect(({} as Record<string, unknown>).useful).toBeUndefined();
    expect(({} as Record<string, unknown>).notUseful).toBeUndefined();
    expect(({} as Record<string, unknown>).lastMarked).toBeUndefined();
    // …and the reserved-named notes are still tracked as OWN keys (no silent data loss).
    expect(store.size()).toBe(3);
    expect(store.scores().get("__proto__")).toBeCloseTo(0.5, 10);
    // Round-trips through persist → reopen without polluting on reload either.
    const reopened = await FeedbackStore.open(file);
    expect(({} as Record<string, unknown>).useful).toBeUndefined();
    expect(reopened.scores().get("__proto__")).toBeCloseTo(0.5, 10);
  });

  it("feedbackScore is the Laplace-smoothed ratio useful/(useful+notUseful+1)", () => {
    expect(feedbackScore({ useful: 0, notUseful: 0, lastMarked: "" })).toBe(0);
    expect(feedbackScore({ useful: 1, notUseful: 0, lastMarked: "" })).toBeCloseTo(0.5, 10);
    expect(feedbackScore({ useful: 9, notUseful: 0, lastMarked: "" })).toBeCloseTo(0.9, 10);
    expect(feedbackScore({ useful: 1, notUseful: 4, lastMarked: "" })).toBeCloseTo(1 / 6, 10);
  });

  it("at MAX_FEEDBACK_ENTRIES, new paths are ignored but existing entries still update (disk-fill bound)", async () => {
    const store = await FeedbackStore.open(file);
    // Seed the cap with synthetic entries via a crafted on-disk file (faster than N records).
    const entries: Record<string, unknown> = {};
    for (let i = 0; i < MAX_FEEDBACK_ENTRIES; i++) entries[`n${i}.md`] = { useful: 1, notUseful: 0, lastMarked: NOW };
    await fs.writeFile(file, JSON.stringify({ version: 1, entries }));
    const full = await FeedbackStore.open(file);
    expect(full.size()).toBe(MAX_FEEDBACK_ENTRIES);
    // a brand-new path is ignored at the cap…
    await full.record(["BRAND_NEW.md"], true, NOW);
    expect(full.scores().has("BRAND_NEW.md")).toBe(false);
    // …but an EXISTING entry still updates.
    await full.record(["n0.md"], true, NOW); // 2/(2+0+1)=0.667
    expect(full.scores().get("n0.md")).toBeCloseTo(2 / 3, 10);
    void store;
  });

  it.for([{ overflowPath: "OVERFLOW.md" }])(
    "reopen caps a crafted cap+1 generation instead of retaining $overflowPath",
    async ({ overflowPath }) => {
      const entries: Record<string, unknown> = {};
      for (let i = 0; i < MAX_FEEDBACK_ENTRIES; i++) {
        entries[`n${i}.md`] = { useful: 1, notUseful: 0, lastMarked: NOW };
      }
      entries[overflowPath] = { useful: 1, notUseful: 0, lastMarked: NOW };
      await fs.writeFile(file, JSON.stringify({ version: 1, entries }));

      const capped = await FeedbackStore.open(file);
      expect(capped.size()).toBe(MAX_FEEDBACK_ENTRIES);
      expect(capped.scores().has(`n${MAX_FEEDBACK_ENTRIES - 1}.md`)).toBe(true);
      expect(capped.scores().has(overflowPath)).toBe(false);
    }
  );

  it.for([{ afterInspectionLimit: "AFTER_LIMIT.md" }])(
    "reopen inspects at most the raw property cap before $afterInspectionLimit",
    async ({ afterInspectionLimit }) => {
      const entries: Record<string, unknown> = {};
      for (let i = 0; i < MAX_FEEDBACK_ENTRIES; i++) entries[`invalid${i}`] = null;
      entries[afterInspectionLimit] = { useful: 1, notUseful: 0, lastMarked: NOW };
      await fs.writeFile(file, JSON.stringify({ version: 1, entries }));

      const bounded = await FeedbackStore.open(file);
      expect(bounded.size()).toBe(0);
      expect(bounded.scores().has(afterInspectionLimit)).toBe(false);
    }
  );

  it("defaultFeedbackFile shares the cache dir + 12-hex vault hash with defaultIndexFile (so prune erases it)", () => {
    const vaultRoot = "/Users/alex/Vault";
    const fb = defaultFeedbackFile(vaultRoot);
    const idx = defaultIndexFile(vaultRoot);
    expect(path.dirname(fb)).toBe(path.dirname(idx)); // same cache dir
    expect(path.basename(fb)).toMatch(/^[0-9a-f]{12}\.feedback\.json$/);
    // same 12-hex hash stem as the fts index
    expect(path.basename(fb).slice(0, 12)).toBe(path.basename(idx).slice(0, 12));
  });

  it("prune erases the feedback sidecar of OTHER vaults (right-to-erasure) — incl. its .tmp", () => {
    const KEEP = "aaaaaaaaaaaa";
    const OTHER = "bbbbbbbbbbbb";
    const removable = planCachePrune(
      [`${OTHER}.feedback.json`, `${OTHER}.feedback.json.tmp`, `${KEEP}.feedback.json`, `${KEEP}.fts5.db`],
      KEEP
    );
    expect(removable).toContain(`${OTHER}.feedback.json`);
    expect(removable).toContain(`${OTHER}.feedback.json.tmp`);
    expect(removable).not.toContain(`${KEEP}.feedback.json`); // kept vault preserved
  });

  it("NEGATIVE control — prune never selects a non-enquire file sharing the dir", () => {
    expect(planCachePrune(["my-notes.feedback.json", "feedback.json", "x.feedback.json"], "aaaaaaaaaaaa")).toEqual([]);
  });

  // v3.11.0-rc.1 audit response (MED): persist() must create the cache dir 0700
  // (every sibling cache writer does), so SECURITY.md's Enquire-created-parent
  // 0700 posture holds when feedback is the FIRST writer to materialize it.
  it("persist requests a private fresh parent, preserves an existing 0750 parent, and publishes 0600", async () => {
    // A parent that does NOT exist yet, so writeOnce's mkdir is the creator.
    const freshFile = path.join(dir, "nested", "enquire", "abc123def456.feedback.json");
    const store = await FeedbackStore.open(freshFile);
    await store.record(["A.md"], true, NOW); // first persist → recursive mode-0700 mkdir
    expect((await fs.stat(path.dirname(freshFile))).mode & 0o077).toBe(0); // umask may tighten 0700
    expect((await fs.stat(freshFile)).mode & 0o777).toBe(0o600);

    const existingParent = path.join(dir, "operator-managed-feedback-parent");
    await fs.mkdir(existingParent, { mode: 0o750 });
    await fs.chmod(existingParent, 0o750);
    const existingStore = await FeedbackStore.open(path.join(existingParent, "abc123def456.feedback.json"));
    await existingStore.record(["B.md"], true, NOW);
    expect((await fs.stat(existingParent)).mode & 0o777).toBe(0o750);
  });

  it.for([
    { boundary: "exact read limit", reportedBytes: MAX_FEEDBACK_FILE_BYTES, publishes: true },
    { boundary: "one byte over read limit", reportedBytes: MAX_FEEDBACK_FILE_BYTES + 1, publishes: false }
  ])("writer treats a $boundary snapshot as publishes=$publishes", async ({ reportedBytes, publishes }) => {
    const store = await FeedbackStore.open(file);
    await store.record(["Prior.md"], true, NOW);
    const priorBytes = await fs.readFile(file);
    const internals = store as unknown as {
      data: {
        entries: Record<string, { useful: number; notUseful: number; lastMarked: string }>;
      };
      writeOnce(): Promise<void>;
    };
    internals.data.entries["Next.md"] = { useful: 1, notUseful: 0, lastMarked: NOW };

    const byteLengthSpy = vi.spyOn(Buffer, "byteLength").mockImplementationOnce(() => reportedBytes);
    const openSpy = vi.spyOn(fs, "open");
    const renameSpy = vi.spyOn(fs, "rename");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let stderr = "";
    try {
      await expect(internals.writeOnce()).resolves.toBeUndefined();
      stderr = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
      if (publishes) {
        expect(openSpy).toHaveBeenCalled();
        expect(renameSpy.mock.calls.some((call) => String(call[1]) === file)).toBe(true);
      } else {
        expect(openSpy).not.toHaveBeenCalled();
        expect(renameSpy).not.toHaveBeenCalled();
      }
    } finally {
      byteLengthSpy.mockRestore();
      openSpy.mockRestore();
      renameSpy.mockRestore();
      stderrSpy.mockRestore();
    }

    if (publishes) {
      const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { entries: Record<string, unknown> };
      expect(parsed.entries["Next.md"]).toBeDefined();
      expect(stderr).not.toMatch(/feedback persist failed/);
    } else {
      expect(await fs.readFile(file)).toEqual(priorBytes);
      expect(stderr).toMatch(/feedback persist failed.*exceeds the persistent read limit/is);
    }
  });

  // The store is shared across serve-http sessions and the SDK dispatches tool
  // calls concurrently. Random exclusive temps prevent torn writes, but do NOT
  // provide generation order by themselves: an older delayed publication could
  // still rename after a newer one and lose the newest mark.
  it.for([{ family: "legacy deterministic temp" }])(
    "record() never follows a planted $family symlink",
    async (_fixture, { skip }) => {
      const store = await FeedbackStore.open(file);
      const sentinel = path.join(dir, "attacker-owned-feedback-sentinel.txt");
      await fs.writeFile(sentinel, "ATTACKER_FEEDBACK_SENTINEL");
      let plantedLegacyTempSymlink = false;
      try {
        await fs.symlink(sentinel, `${file}.tmp`, "file");
        plantedLegacyTempSymlink = true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
          skip(`filesystem cannot create the symlink control (${code})`);
          return;
        }
        throw err;
      }

      await store.record(["Safe.md"], true, NOW);
      expect((await FeedbackStore.open(file)).scores().get("Safe.md")).toBeGreaterThan(0);
      if (plantedLegacyTempSymlink) {
        expect(await fs.readFile(sentinel, "utf8")).toBe("ATTACKER_FEEDBACK_SENTINEL");
        expect((await fs.lstat(file)).isSymbolicLink()).toBe(false);
      }
    }
  );

  it("concurrent record() publishes whole generations in order", async () => {
    const store = await FeedbackStore.open(file);

    const realRename = fs.rename.bind(fs);
    let releaseFirstRename = (): void => {};
    let observeFirstRename = (): void => {};
    const firstRenameGate = new Promise<void>((resolve) => {
      releaseFirstRename = resolve;
    });
    const firstRenameObserved = new Promise<void>((resolve) => {
      observeFirstRename = resolve;
    });
    let finalRenameCount = 0;
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === file) {
        finalRenameCount += 1;
        if (finalRenameCount === 1) {
          observeFirstRename();
          await firstRenameGate;
        }
      }
      await realRename(from, to);
    });
    const internals = store as unknown as { writeOnce(): Promise<void> };
    const realWriteOnce = internals.writeOnce.bind(store);
    let writeOnceStarts = 0;
    const writeOnceSpy = vi.spyOn(internals, "writeOnce").mockImplementation(async () => {
      writeOnceStarts += 1;
      await realWriteOnce();
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let errs: string[] = [];
    try {
      const older = store.record(["Older.md"], true, NOW);
      await firstRenameObserved;
      const newer = store.record(["Newer.md"], true, NOW);
      await Promise.resolve();
      expect(writeOnceStarts, "the newer feedback generation must wait behind the blocked older rename").toBe(1);
      releaseFirstRename();
      await Promise.all([older, newer]);
      errs = stderrSpy.mock.calls.map((c) => String(c[0]));
    } finally {
      releaseFirstRename();
      renameSpy.mockRestore();
      writeOnceSpy.mockRestore();
      stderrSpy.mockRestore();
    }

    expect(finalRenameCount).toBe(2);
    expect(errs.filter((l) => /feedback persist failed/.test(l))).toEqual([]);
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    expect(Object.keys(parsed.entries).sort()).toEqual(["Newer.md", "Older.md"]);
    expect(parsed.entries["Older.md"].useful).toBe(1);
    expect(parsed.entries["Newer.md"].useful).toBe(1);
    const reopened = await FeedbackStore.open(file);
    expect(reopened.scores().get("Older.md")).toBeGreaterThan(0);
    expect(reopened.scores().get("Newer.md")).toBeGreaterThan(0);
  });
});

describe("searchHybrid feedback boost (v3.11.0)", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-feedback-search-"));
    // Three notes all mentioning "widget"; differing term frequency gives a stable
    // TF-IDF order so we can prove a feedback mark reorders it.
    await fs.writeFile(path.join(root, "High.md"), "widget widget widget widget widget gadget.\n");
    await fs.writeFile(path.join(root, "Mid.md"), "widget widget gadget notes.\n");
    await fs.writeFile(path.join(root, "Low.md"), "widget gadget reference material.\n");
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function order(feedback?: { weight: number; scores: Map<string, number> }): Promise<string[]> {
    const vault = new Vault(root);
    const res = await searchHybrid(
      vault,
      { query: "widget", limit: 10 },
      { ftsIndex: null, embedFile: path.join(root, "nonexistent.embed.db"), ...(feedback ? { feedback } : {}) }
    );
    return res.matches.map((r) => r.path);
  }

  it("weight 0 (or no feedback ctx) is a PROVABLE no-op — order is byte-identical", async () => {
    const base = await order();
    const zero = await order({ weight: 0, scores: new Map([["Low.md", 0.99]]) });
    expect(zero).toEqual(base); // weight 0 → skipped, relevance order preserved exactly
    expect(base.length).toBeGreaterThan(1);
  });

  it("weight > 0 lifts a feedback-marked note above its relevance rank", async () => {
    const base = await order();
    // Pick the LAST-ranked note and mark it strongly useful; it should rise.
    const last = base[base.length - 1] as string;
    const boosted = await order({ weight: 1, scores: new Map([[last, 0.99]]) });
    expect(boosted[0]).toBe(last); // weight 1 ⇒ feedback dominates ⇒ marked note first
    expect(boosted[0]).not.toBe(base[0]); // and it genuinely moved
  });

  it("NEGATIVE control — a feedback score on an IRRELEVANT path (not in results) leaves order unchanged", async () => {
    const base = await order();
    const noise = await order({ weight: 1, scores: new Map([["Unrelated/Ghost.md", 0.99]]) });
    expect(noise).toEqual(base); // no candidate matches the marked path ⇒ no reorder
  });
});

describe("FeedbackStore.open file-size guard (rc.24 — external rc.21 audit, Goose FIND-2)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "feedback-size-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("a valid under-cap file still loads its entries (POSITIVE — guard doesn't break the happy path)", async () => {
    const file = path.join(dir, "fb.feedback.json");
    await fs.writeFile(
      file,
      JSON.stringify({ version: 1, entries: { "a.md": { useful: 3, notUseful: 1, lastMarked: "x" } } })
    );
    const store = await FeedbackStore.open(file);
    expect(store.size()).toBe(1);
    expect(store.scores().get("a.md")).toBeGreaterThan(0); // 3/(3+1+1) = 0.6
  });

  it("an over-MAX_FEEDBACK_FILE_BYTES file fail-softs to an EMPTY store (NEGATIVE control)", async () => {
    const file = path.join(dir, "huge.feedback.json");
    // A sparse file: stat.size exceeds the cap, but no disk is actually written — proves the
    // guard rejects on SIZE before readFile+JSON.parse (a real 64 MB write is unnecessary).
    const fh = await fs.open(file, "w");
    await fh.truncate(MAX_FEEDBACK_FILE_BYTES + 1);
    await fh.close();
    const store = await FeedbackStore.open(file);
    expect(store.size()).toBe(0); // empty store — guard rejected before parse
  });
});

describe("FeedbackStore vault_root keying + guard (v3.11.6-rc.8 — RFC latent-bug hardening)", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-fb-vroot-"));
    file = path.join(dir, "test.feedback.json");
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("persists vault_root and re-loads entries when the root matches (POSITIVE)", async () => {
    const store = await FeedbackStore.open(file, "/canonical/vault");
    await store.record(["A.md"], true, NOW);
    const onDisk = JSON.parse(await fs.readFile(file, "utf8"));
    expect(onDisk.vault_root).toBe("/canonical/vault");
    // same root → entries load
    const reopened = await FeedbackStore.open(file, "/canonical/vault");
    expect(reopened.size()).toBe(1);
    expect(reopened.scores().get("A.md")).toBeCloseTo(0.5, 10);
  });

  it("NEGATIVE control — a sidecar recorded for a DIFFERENT vault_root is NOT loaded (no cross-vault feedback bleed)", async () => {
    const store = await FeedbackStore.open(file, "/vault/A");
    await store.record(["Secret.md"], true, NOW);
    // opening the same file for a different vault must ignore the foreign entries
    const foreign = await FeedbackStore.open(file, "/vault/B");
    expect(foreign.size()).toBe(0);
    expect(foreign.scores().get("Secret.md")).toBeUndefined();
  });

  it("a pre-rc.8 sidecar with no vault_root is adopted (backward compat)", async () => {
    // hand-write a legacy file with entries but no vault_root field
    await fs.writeFile(
      file,
      JSON.stringify({ version: 1, entries: { "Old.md": { useful: 2, notUseful: 0, lastMarked: NOW } } })
    );
    const store = await FeedbackStore.open(file, "/any/vault");
    expect(store.size()).toBe(1);
    expect(store.scores().get("Old.md")).toBeCloseTo(2 / 3, 10); // 2/(2+0+1)
  });

  it("keys the sidecar off the CANONICAL vault root — path-spelling variants collapse to one file (the fix)", async () => {
    // A Vault canonicalizes its root; a trailing-slash spelling resolves to the
    // same root, so defaultFeedbackFile(vault.root) is stable across spellings —
    // which is why server.ts must pass vault.root, not the raw --vault arg.
    const physical = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-fb-canon-"));
    try {
      const v1 = new Vault(physical);
      await v1.ensureExists();
      const v2 = new Vault(`${physical}/`); // trailing slash — same physical dir
      await v2.ensureExists();
      expect(v1.root).toBe(v2.root); // canonicalized to the same root
      expect(defaultFeedbackFile(v1.root)).toBe(defaultFeedbackFile(v2.root));
    } finally {
      await fs.rm(physical, { recursive: true, force: true });
    }
  });
});

// ─── v3.11.6-rc.12 (pre-promotion re-sweep) — the rc.8 fix-site gate ─────────
// The rc.8 fix was the ONE-LINE rekey in server.ts (`defaultFeedbackFile(vault.root)`
// instead of the raw `opts.vault` arg). The leaf tests above prove the pieces, but a
// revert of that line would pass every one of them (each fragmented sidecar carries a
// self-consistent vault_root, so the guard can't fire). server.ts is un-importable
// per the no-internal-imports invariant, so — mirroring the rc.1 CRL-1 source-order
// precedent — pin the call site structurally in the source text.
describe("server.ts feedback keying (rc.8 fix-site gate, rc.12)", () => {
  it("prepareServerDeps keys the feedback sidecar off the CANONICAL vault.root", async () => {
    const src = await fs.readFile(new URL("../src/server.ts", import.meta.url), "utf8");
    expect(src).toContain("defaultFeedbackFile(vault.root)");
    // NEGATIVE control — the buggy raw-arg spelling must be absent.
    expect(src).not.toMatch(/defaultFeedbackFile\(\s*opts\.vault\s*\)/);
  });
});
