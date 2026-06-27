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
  // (every sibling cache writer does), so SECURITY.md's "Parent dir mode is 0700"
  // holds even when the feedback store is the FIRST writer to materialize it.
  it("persist creates the cache dir 0700 (not 0755) and the file 0600", async () => {
    // A parent that does NOT exist yet, so writeOnce's mkdir is the creator.
    const freshFile = path.join(dir, "nested", "enquire", "abc123def456.feedback.json");
    const store = await FeedbackStore.open(freshFile);
    await store.record(["A.md"], true, NOW); // first persist → mkdir + chmod
    expect((await fs.stat(path.dirname(freshFile))).mode & 0o777).toBe(0o700); // no group/world access
    expect((await fs.stat(freshFile)).mode & 0o777).toBe(0o600);
  });

  // v3.11.0-rc.1 audit response (MED): the store is shared across serve-http
  // sessions and the SDK dispatches tool calls concurrently — persist()s must be
  // serialized so they never interleave into a torn file (which the fail-soft
  // open() would silently discard, losing ALL feedback).
  it("concurrent record() calls serialize persists — no tmp-rename collision (DISCRIMINATES the persistChain)", async () => {
    // The naive non-serialized version (writeOnce called directly from persist())
    // lets two concurrent writes stream into the SAME <file>.tmp; the first rename
    // consumes it, the rest hit ENOENT — which writeOnce logs as "feedback persist
    // failed". The shared in-memory map means the file still ends coherent either
    // way, so asserting JSON/tally alone is VACUOUS (it passed even without the
    // fix — the rc.4 audit finding). The ENOENT stderr line is the only signal
    // that actually distinguishes serialized from racing writes, so we assert on it.
    const store = await FeedbackStore.open(file);
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let errs: string[] = [];
    try {
      await Promise.all(Array.from({ length: 25 }, () => store.record(["Hot.md"], true, NOW)));
      errs = spy.mock.calls.map((c) => String(c[0]));
    } finally {
      spy.mockRestore();
    }
    // Zero persist failures ⇒ the persistChain prevented every tmp-rename collision.
    expect(errs.filter((l) => /feedback persist failed/.test(l))).toEqual([]);
    const parsed = JSON.parse(await fs.readFile(file, "utf8")); // and the file is coherent
    expect(parsed.entries["Hot.md"].useful).toBe(25);
    // a fresh open sees the full tally → proves no corrupt-file fail-soft discard
    expect((await FeedbackStore.open(file)).scores().get("Hot.md")).toBeGreaterThan(0);
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
    const file = path.join(dir, "fb.json");
    await fs.writeFile(
      file,
      JSON.stringify({ version: 1, entries: { "a.md": { useful: 3, notUseful: 1, lastMarked: "x" } } })
    );
    const store = await FeedbackStore.open(file);
    expect(store.size()).toBe(1);
    expect(store.scores().get("a.md")).toBeGreaterThan(0); // 3/(3+1+1) = 0.6
  });

  it("an over-MAX_FEEDBACK_FILE_BYTES file fail-softs to an EMPTY store (NEGATIVE control)", async () => {
    const file = path.join(dir, "huge.json");
    // A sparse file: stat.size exceeds the cap, but no disk is actually written — proves the
    // guard rejects on SIZE before readFile+JSON.parse (a real 64 MB write is unnecessary).
    const fh = await fs.open(file, "w");
    await fh.truncate(MAX_FEEDBACK_FILE_BYTES + 1);
    await fh.close();
    const store = await FeedbackStore.open(file);
    expect(store.size()).toBe(0); // empty store — guard rejected before parse
  });
});
