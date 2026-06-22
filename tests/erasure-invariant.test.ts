// v3.9.0-rc.36 — ERASURE-COMPLETENESS INVARIANT (P0 structural defense).
//
// Closes the P-2 class: an on-disk artifact that carries user vault content but
// is NOT removed by the matching `clear-*` path — a right-to-erasure (GDPR) gap.
//   • rc.34 P-2: the HNSW `.meta.json` sidecar (raw `text_preview`) survived
//     `clear-embeddings` because `clearOnDisk` only erased the `.embed.db`.
//   • rc.36 F-2: the parse-cache `${cacheFile}.tmp` (full note bodies, written by
//     `saveDiskCache`'s atomic writeFile→rename) survived `clear-cache` because
//     `clearDiskCache` only unlinked the final file.
//
// WHY THE INTERNAL APPARATUS MISSED THIS (meta-audit, this session): the OIA +
// docs-consistency suite is drift/claim-driven — it checks that CLAIMS match
// reality, never that an artifact a WRITER creates is removed by its ERASER.
// Both P-2 instances were found by an EXTERNAL privacy/STRIDE lens. This file
// converts "did we remember to erase X?" (undecidable, recursion-prone) into a
// permanent CI check: (1) behavioral — `clearDiskCache` actually erases a
// leftover `.tmp`; (2) structural — each eraser's source references every suffix
// of its artifact family (writers ⊆ erasers). Mirrors the rc.25 ReDoS-fuzz move
// (assert the property, don't re-enumerate by hand).

import { promises as fs, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hnswPersistBase } from "../src/embed-db.js";
import { planCachePrune } from "../src/fts5.js";
import { Vault } from "../src/vault.js";

const repoRoot = path.resolve(__dirname, "..");

// ── Manifest: on-disk artifact family → (source file, eraser method, the literal
// suffix tokens the eraser MUST reference to fully erase the family). Adding a
// new on-disk artifact without listing it here (and without its eraser
// referencing every suffix) fails this invariant before an auditor finds it. ──
const ERASURE_MANIFEST = [
  {
    family: "embed-db + HNSW sidecars (vectors + raw text_preview)",
    file: "src/embed-db.ts",
    eraser: "clearOnDisk",
    requiredTokens: ["-wal", "-shm", ".hnsw", ".bin", ".meta.json"],
    // v3.10.0-rc.20 (audit M7) — clearOnDisk now derives the HNSW base via the
    // shared `hnswPersistBase` helper, so the `.hnsw` suffix literal lives in
    // that helper (not the eraser method body). Scan it too so the full
    // suffix set is still verified after the de-dup refactor.
    helperFns: ["hnswPersistBase"]
  },
  {
    family: "FTS5 index + SQLite WAL sidecars",
    file: "src/fts5.ts",
    eraser: "clearOnDisk",
    requiredTokens: ["-wal", "-shm"]
  },
  {
    family: "parse cache + atomic-write temp (full note bodies)",
    file: "src/vault.ts",
    eraser: "clearDiskCache",
    requiredTokens: [".tmp"]
  }
] as const;

/** Slice a 2-space-indented class method body: from `async <name>(` through its
 *  own closing `\n  }` (deeper-indented nested closers like `\n    }` don't
 *  match). Returns "" if the method isn't found. Pure — unit-tested below. */
function extractMethod(src: string, name: string): string {
  const start = src.indexOf(`async ${name}(`);
  if (start === -1) return "";
  const rest = src.slice(start);
  const m = rest.match(/\n {2}\}/);
  return m && m.index !== undefined ? rest.slice(0, m.index + m[0].length) : rest;
}

/** Slice a top-level `export (async )?function NAME(` body: from the signature
 *  to the first column-0 `\n}`. Used to scan a shared path helper that an eraser
 *  delegates to (e.g. `hnswPersistBase`), so a suffix moved out of the eraser
 *  method into a helper is still verified. Returns "" if not found. */
function extractFn(src: string, name: string): string {
  const m = new RegExp(`export (?:async )?function ${name}\\s*\\(`).exec(src);
  if (!m) return "";
  const rest = src.slice(m.index);
  const end = rest.search(/\n\}/);
  return end === -1 ? rest : rest.slice(0, end + 2);
}

/** Pure: which required suffix tokens are ABSENT from `source`. Empty ⇒ the
 *  eraser references every artifact suffix (complete). */
function missingErasureTokens(source: string, required: readonly string[]): string[] {
  return required.filter((tok) => !source.includes(tok));
}

describe("erasure-completeness invariant (rc.36, P-2 class)", () => {
  let root: string;
  let cacheDir: string;
  let cacheFile: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-erasure-vault-"));
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-erasure-cache-"));
    cacheFile = path.join(cacheDir, "cache.json");
    await fs.writeFile(path.join(root, "Secret.md"), "---\ntags: [secret]\n---\n\nSENSITIVE_VAULT_BODY_XYZ\n");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  // ── Behavioral: the actual F-2 fix + regression guard ──
  it("clearDiskCache erases a leftover atomic-write .tmp holding raw note bodies", async () => {
    const v = new Vault(root, { persistentCache: true, cacheFile });
    await v.ensureExists();
    await v.readNote(path.join(root, "Secret.md"));
    await v.saveDiskCache(); // writes cache.json (the .tmp is renamed away on success)

    // Simulate a crash (or EXDEV) that left a `.tmp` behind with raw note bodies.
    await fs.writeFile(`${cacheFile}.tmp`, JSON.stringify({ entries: [{ content: "SENSITIVE_VAULT_BODY_XYZ" }] }), {
      mode: 0o600
    });

    const removed = await v.clearDiskCache();
    expect(removed).toBe(true);

    const cacheGone = await fs
      .stat(cacheFile)
      .then(() => false)
      .catch(() => true);
    const tmpGone = await fs
      .stat(`${cacheFile}.tmp`)
      .then(() => false)
      .catch(() => true);
    expect(cacheGone).toBe(true);
    expect(tmpGone).toBe(true); // THE FIX — pre-rc.36 this was false (raw text persisted)
  });

  // NEGATIVE control: an "incomplete eraser" that mimics the pre-rc.36 behavior
  // (unlink only the main file) MUST leave the .tmp behind — proving the leak
  // scenario is real and the positive test above genuinely discriminates.
  it("NEGATIVE control — an eraser that skips .tmp leaves raw text on disk", async () => {
    await fs.writeFile(cacheFile, "{}", { mode: 0o600 });
    await fs.writeFile(`${cacheFile}.tmp`, "SENSITIVE_VAULT_BODY_XYZ", { mode: 0o600 });
    await fs.unlink(cacheFile); // the buggy pre-fix eraser: main file only
    const tmpStillThere = await fs
      .stat(`${cacheFile}.tmp`)
      .then(() => true)
      .catch(() => false);
    expect(tmpStillThere).toBe(true); // exactly the gap rc.36 F-2 closes
  });

  // ── Structural: writers ⊆ erasers — every eraser references all its suffixes ──
  describe("erasure manifest — each eraser references every artifact suffix", () => {
    for (const m of ERASURE_MANIFEST) {
      it(`${m.eraser} in ${m.file} erases all suffixes of [${m.family}]`, () => {
        const src = readFileSync(path.join(repoRoot, m.file), "utf8");
        const body = extractMethod(src, m.eraser);
        expect(body, `${m.eraser} not found in ${m.file}`).not.toBe("");
        // v3.10.0-rc.20 (audit M7) — also scan any shared path helpers the
        // eraser delegates to, so a suffix moved into a helper still counts.
        const helperFns = "helperFns" in m ? m.helperFns : [];
        const helperBodies = helperFns.map((h) => extractFn(src, h)).join("\n");
        expect(
          missingErasureTokens(`${body}\n${helperBodies}`, m.requiredTokens),
          `${m.file}#${m.eraser} (+ helpers) is missing erasure suffixes`
        ).toEqual([]);
      });
    }

    // NEGATIVE control: the manifest checker must FLAG an eraser that drops a
    // suffix — otherwise the positive assertions above could pass vacuously.
    it("NEGATIVE control — manifest checker flags an eraser missing a suffix", () => {
      const buggy = 'async clearOnDisk() { await fs.unlink(this.file); await fs.unlink(this.file + "-wal"); }';
      const missing = missingErasureTokens(buggy, ["-wal", "-shm", ".hnsw", ".bin", ".meta.json"]);
      expect(missing).toContain(".meta.json"); // the rc.34 P-2 leak suffix
      expect(missing).toContain("-shm");
    });

    // NEGATIVE control: extractMethod must isolate the method body (so a token in
    // a DIFFERENT method can't satisfy the check by accident).
    it("NEGATIVE control — extractMethod stops at the method's own 2-space closer", () => {
      const src =
        '  async clearOnDisk() {\n    for (const p of t) {\n      go();\n    }\n  }\n  async other() {\n    leak(".meta.json");\n  }';
      const body = extractMethod(src, "clearOnDisk");
      expect(body).toContain("for (const p of t)");
      expect(body).not.toContain(".meta.json"); // belongs to other(), not clearOnDisk()
    });
  });

  // ── v3.10.0-rc.37 (audit #4): the CROSS-VAULT eraser (`prune` → planCachePrune)
  // must cover EVERY per-vault writer family too — not just the per-vault `clear-*`
  // erasers above. The #3 leak (a decommissioned vault's `<hash>.json` parse cache,
  // holding full note bodies, survived `prune` forever) shipped precisely because
  // THIS eraser surface was unpatrolled. Assert prune selects each writer family
  // for an OTHER vault (writers ⊆ prune-eraser). ──
  describe("prune (cross-vault eraser) covers every per-vault writer family (rc.37 #4)", () => {
    const KEEP = "aaaaaaaaaaaa";
    const OTHER = "bbbbbbbbbbbb";
    // One representative basename per on-disk family a writer can produce.
    const WRITER_FAMILIES: Record<string, string> = {
      "parse cache (full note bodies)": `${OTHER}.json`,
      "parse cache atomic-write temp": `${OTHER}.json.tmp`,
      "FTS5 index": `${OTHER}.fts5.db`,
      "FTS5 WAL sidecar": `${OTHER}.fts5.db-wal`,
      "embed-db": `${OTHER}.embed.db`,
      "HNSW index": `${OTHER}.hnsw.bin`,
      "HNSW meta sidecar (raw text_preview)": `${OTHER}.hnsw.meta.json`,
      // v3.11.0 — the closed-loop feedback store (relative note paths + usefulness
      // counts). Right-to-erasure: a decommissioned vault's feedback must not survive
      // prune. + its atomic-write .tmp leftover.
      "feedback store (paths + counts)": `${OTHER}.feedback.json`,
      "feedback store atomic-write temp": `${OTHER}.feedback.json.tmp`
    };
    for (const [family, name] of Object.entries(WRITER_FAMILIES)) {
      it(`prune selects the ${family} of OTHER vaults (${name})`, () => {
        expect(planCachePrune([name, `${KEEP}.fts5.db`], KEEP)).toContain(name);
      });
    }
    // NEGATIVE control: a whitelist that OMITS the `.json` family (the literal
    // pre-rc.37 bug) must FAIL to select the parse cache — proving the coverage
    // assertions above genuinely discriminate (not vacuously true for any regex).
    it("NEGATIVE control — a whitelist missing the `.json` family leaves the parse cache (the #3 leak)", () => {
      const PRE_RC37 = /^[0-9a-f]{12}\.(fts5\.db|embed\.db|hnsw\.bin|hnsw\.meta\.json)(-wal|-shm)?$/;
      const buggyPrune = (entries: string[], keep: string) =>
        entries.filter((e) => PRE_RC37.test(e) && !e.startsWith(`${keep}.`));
      expect(buggyPrune([`${OTHER}.json`], KEEP)).toEqual([]); // leak: parse cache survives prune
      expect(planCachePrune([`${OTHER}.json`], KEEP)).toEqual([`${OTHER}.json`]); // rc.37: erased
    });
  });

  // ── v3.10.0-rc.20 (audit M7): the HNSW persist BASE is derived by ONE shared
  // helper (`hnswPersistBase`) so the WRITER (server.ts `persistFile` → saveTo)
  // and the ERASER (`EmbedDb.clearOnDisk`) can't drift. A base drift (vs the
  // suffix drift the manifest above guards) would leave the `.hnsw.*` sidecars —
  // which carry raw `text_preview` — on disk after `clear-embeddings`: the rc.34
  // P-2 right-to-erasure gap, reintroduced through a different seam. ──
  describe("HNSW persist base shared between writer + eraser (rc.20 M7)", () => {
    const embedDbSrc = readFileSync(path.join(repoRoot, "src/embed-db.ts"), "utf8");
    const serverSrc = readFileSync(path.join(repoRoot, "src/server.ts"), "utf8");
    // The pre-rc.20 inline shape: `${x.replace(/\.embed\.db$/, "")}.hnsw`.
    const INLINE_BASE = /\.replace\(\/\\\.embed\\\.db\$\/[^)]*\)\}\.hnsw/;

    it("hnswPersistBase strips .embed.db and appends .hnsw (single source of truth)", () => {
      expect(hnswPersistBase("/c/x.embed.db")).toBe("/c/x.hnsw");
      expect(hnswPersistBase("/cache/abc12.embed.db")).toBe("/cache/abc12.hnsw");
      expect(hnswPersistBase("/c/no-suffix")).toBe("/c/no-suffix.hnsw");
    });

    it("the eraser (clearOnDisk) and the writer (server.ts) both route through hnswPersistBase", () => {
      expect(extractMethod(embedDbSrc, "clearOnDisk")).toContain("hnswPersistBase(");
      expect(serverSrc, "server.ts writer must use hnswPersistBase").toContain("hnswPersistBase(");
      // …and the writer must NOT recompute the base inline (the drift this closes).
      expect(INLINE_BASE.test(serverSrc), "server.ts still recomputes the HNSW base inline").toBe(false);
    });

    it("v3.10.0-rc.37 (#8) — server.ts erases the stale HNSW sidecars when the embed-db is empty", () => {
      // An emptied embed-db builds no index → no `saveTo` to overwrite the stale
      // `<base>.bin` + `.meta.json` (the latter carries deleted notes' raw
      // text_preview). The empty branch must unlink BOTH sidecars (persist-gated),
      // else an emptied --use-hnsw vault leaves raw text on disk.
      // Substrings without the `${` placeholder (so biome doesn't read this assertion
      // string as a template literal) — both sidecars must be unlinked in that branch.
      expect(serverSrc, "empty-embed-db branch must unlink the .bin sidecar").toContain("persistFile}.bin`");
      expect(serverSrc, "empty-embed-db branch must unlink the .meta.json sidecar (raw text_preview)").toContain(
        "persistFile}.meta.json`"
      );
    });

    // NEGATIVE control — the inline-base detector must FLAG the pre-rc.20 shape
    // (so the writer assertion above isn't vacuously true).
    it("NEGATIVE control — the inline-base detector flags a pre-rc.20 recomputation", () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture intentionally holds a literal ${...} representing the pre-rc.20 inline source shape
      const old = 'const persistFile = `${embedFile.replace(/\\.embed\\.db$/, "")}.hnsw`;';
      expect(INLINE_BASE.test(old)).toBe(true);
      expect(old.includes("hnswPersistBase(")).toBe(false);
    });
  });
});
