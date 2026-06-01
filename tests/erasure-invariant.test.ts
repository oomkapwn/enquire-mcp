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
    requiredTokens: ["-wal", "-shm", ".hnsw", ".bin", ".meta.json"]
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
        const body = extractMethod(readFileSync(path.join(repoRoot, m.file), "utf8"), m.eraser);
        expect(body, `${m.eraser} not found in ${m.file}`).not.toBe("");
        expect(
          missingErasureTokens(body, m.requiredTokens),
          `${m.file}#${m.eraser} is missing erasure suffixes`
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
});
