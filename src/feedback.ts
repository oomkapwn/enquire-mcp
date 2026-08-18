// v3.11.0 — closed-loop retrieval feedback (the "Karpathy loop"). An agent calls
// `obsidian_mark_useful` to record which recalled notes actually helped answer a
// query; the per-note useful / not-useful tally feeds an OPT-IN additive rank
// boost in `obsidian_search` (`--feedback-weight`, default 0 = provable no-op,
// mirroring the v3.10.0-rc.5 recency boost).
//
// PRIVACY (data-at-rest): state lives in a single routing-key-scoped JSON sidecar
// in the cache dir (`<hash>.feedback.json`) holding the canonical absolute vault root
// plus relative note-path keys, integer counts, and an ISO timestamp per entry
// — NO note content, snippets, or query text. It is lower-sensitivity than the
// content indexes, and it matches the `ENQUIRE_CACHE_ARTIFACT` pattern so a
// cross-stem `prune` erases it alongside the parse cache / FTS index / embed-db
// sidecars for non-colliding roots. The legacy SHA1-12 stem is routing, not exact
// root identity; the erasure-invariant
// (`tests/erasure-invariant.test.ts`) pins that prune coverage. It is preserved
// across `clear-cache` (it is user-generated signal, not regenerable cache).

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertFeedbackFilePath } from "./persistence-path.js";
import { publishSensitiveArtifact, readSensitiveArtifactText } from "./sensitive-artifact.js";

/** Per-note usefulness tally. `lastMarked` is an ISO-8601 timestamp (or "" if a
 *  loaded legacy/partial entry lacked one). */
export interface FeedbackEntry {
  useful: number;
  notUseful: number;
  lastMarked: string;
}

interface FeedbackData {
  version: 1;
  /**
   * v3.11.6-rc.8 (RFC-surfaced latent bug) — the canonical vault root recorded by
   * this store. It is verified on open so mismatched entries are not admitted
   * (mirrors the `data.root !== this.root` guard fts5/embed-db already have), but
   * does not make a shared SHA1-12 path collision-proof. Optional so pre-rc.8
   * sidecars (no `vault_root`) still load.
   */
  vault_root?: string;
  entries: Record<string, FeedbackEntry>;
}

/** Upper bound on distinct marked notes the store will hold. Far beyond any real
 *  vault's useful-marked set; bounds disk growth from a misbehaving client that
 *  marks unbounded fake paths over a long `serve-http` session (a mild fill-DoS).
 *  At the cap, EXISTING entries still update; NEW paths are ignored. */
export const MAX_FEEDBACK_ENTRIES = 100_000;
/** v3.11.0-rc.24 (Goose FIND-2) — upper bound on the sidecar file size read at `open()`.
 *  At MAX_FEEDBACK_ENTRIES × ~200 B/entry the legitimate file is ~20 MB; 64 MB is generous
 *  and bounds a corrupt/hostile file before readFile+JSON.parse (defense-in-depth — the
 *  sidecar is operator-controlled, not bearer-reachable). */
export const MAX_FEEDBACK_FILE_BYTES = 64 * 1024 * 1024;

/**
 * Cache-dir location of the routing-key-scoped feedback sidecar. MIRRORS `defaultIndexFile`
 * (fts5.ts): same `enquire` cache dir (honoring `$XDG_CACHE_HOME`) under the same
 * first-12-hex sha1(vaultRoot) key, so the file sits beside the other stem-scoped
 * artifacts and `prune`'s `ENQUIRE_CACHE_ARTIFACT` pattern recognizes it. The
 * truncated key is not collision-proof root identity; the dir+key parity with
 * `defaultIndexFile` is pinned by `tests/feedback.test.ts`.
 *
 * @param vaultRoot Absolute path to the vault root.
 * @returns Absolute path to `<cacheDir>/<hash>.feedback.json`.
 */
export function defaultFeedbackFile(vaultRoot: string): string {
  const base =
    process.env.XDG_CACHE_HOME ??
    (process.platform === "darwin" ? path.join(os.homedir(), "Library", "Caches") : path.join(os.homedir(), ".cache"));
  const hash = createHash("sha1").update(vaultRoot).digest("hex").slice(0, 12);
  return path.join(base, "enquire", `${hash}.feedback.json`);
}

/**
 * A note's feedback score in [0, 1): `useful / (useful + notUseful + 1)`. The +1
 * Laplace term keeps a single positive mark modest (0.5) and an unmarked note at
 * 0, so the search boost is gentle and monotonically increasing in NET
 * usefulness (more useful marks raise it; not-useful marks lower it).
 */
export function feedbackScore(e: FeedbackEntry): number {
  const denom = e.useful + e.notUseful + 1;
  return denom > 0 ? e.useful / denom : 0;
}

/**
 * Root-checked feedback store at one admitted path. Holds the tally in memory,
 * so a `mark_useful` during a `serve` session immediately influences the next
 * `obsidian_search` boost, and attempts each persisted generation atomically.
 *
 * Concurrency: `record` mutates the in-memory map synchronously (no `await`
 * between read and write of a given entry), so concurrent marks never interleave
 * the tally. Each on-disk attempt is whole-generation and last-write-wins,
 * while an I/O or size-cap failure remains in memory and is reported to stderr
 * because feedback is a fail-soft ranking signal.
 */
export class FeedbackStore {
  private constructor(
    readonly file: string,
    private data: FeedbackData
  ) {}

  /**
   * Open (or initialize) an admitted `.feedback.json` store. After namespace
   * admission, a missing / unreadable / malformed sidecar yields an EMPTY store
   * (the boost simply has no signal), so corrupt contents cannot break boot.
   * Loaded entries are sanitized (non-finite / negative counts → 0;
   * non-string `lastMarked` → ""). Reopen inspects at most
   * {@link MAX_FEEDBACK_ENTRIES} own enumerable properties and retains the
   * valid entries among that bounded ECMAScript enumeration prefix.
   *
   * @throws {TypeError} If `file` is outside the exact feedback namespace.
   */
  static async open(file: string, vaultRoot?: string): Promise<FeedbackStore> {
    assertFeedbackFilePath(file);
    // v3.11.0-rc.8 (pre-promotion audit MED) — `entries` is a NULL-PROTOTYPE map.
    // record() writes agent-supplied path strings directly as keys; on a normal
    // object an agent calling obsidian_mark_useful with `paths:["__proto__"]` would
    // resolve `entries["__proto__"]` to Object.prototype and pollute it process-wide
    // (remotely reachable on bearer serve-http when --feedback-weight > 0). A
    // null-proto map has no Object.prototype on its chain, so "__proto__" / "constructor"
    // become harmless OWN keys (a note literally named __proto__.md still round-trips).
    let data: FeedbackData = {
      version: 1,
      ...(vaultRoot ? { vault_root: vaultRoot } : {}),
      entries: Object.create(null) as Record<string, FeedbackEntry>
    };
    try {
      // v3.11.0-rc.24 (external rc.21 audit, Goose FIND-2) — bound the file size BEFORE
      // readFile+JSON.parse, mirroring vault.ts:loadDiskCache's `stat.size` guard. The
      // sidecar is operator-controlled (cache dir, not bearer-reachable) so this is
      // defense-in-depth, not an exploit fix; a corrupt/hostile multi-GB file now
      // fail-softs to an empty store instead of being parsed into memory.
      const stat = await fs.stat(file);
      if (stat.size > MAX_FEEDBACK_FILE_BYTES) return new FeedbackStore(file, data);
      const raw = await readSensitiveArtifactText(file, MAX_FEEDBACK_FILE_BYTES);
      const parsed = JSON.parse(raw) as unknown;
      // v3.11.6-rc.8 — foreign-vault guard: if the on-disk sidecar records a
      // vault_root that disagrees with the one we were opened for, do NOT load
      // its entries (it belongs to a different vault — a hash collision or a
      // relocated cache dir). Return the empty, correctly-keyed store instead of
      // boosting one vault's search with another's feedback. A sidecar with no
      // vault_root (pre-rc.8) is adopted as-is. Note (rc.12): the empty store
      // keeps the SAME file path, so the first record() OVERWRITES the foreign
      // sidecar. That legacy sha1-12 collision/relocation residual is not an
      // ownership guarantee; root-bound migration is tracked separately in AH-9e.
      const storedRoot =
        parsed && typeof parsed === "object" ? (parsed as { vault_root?: unknown }).vault_root : undefined;
      if (vaultRoot && typeof storedRoot === "string" && storedRoot.length > 0 && storedRoot !== vaultRoot) {
        return new FeedbackStore(file, data);
      }
      const rawEntries = parsed && typeof parsed === "object" ? (parsed as { entries?: unknown }).entries : undefined;
      if (rawEntries && typeof rawEntries === "object") {
        const entries: Record<string, FeedbackEntry> = Object.create(null);
        let inspectedEntryCount = 0;
        for (const k in rawEntries as Record<string, unknown>) {
          if (!Object.hasOwn(rawEntries, k)) continue;
          if (inspectedEntryCount >= MAX_FEEDBACK_ENTRIES) break;
          inspectedEntryCount += 1;
          const v = (rawEntries as Record<string, unknown>)[k];
          if (v && typeof v === "object") {
            const e = v as Partial<FeedbackEntry>;
            const u = Number(e.useful);
            const n = Number(e.notUseful);
            entries[k] = {
              useful: Number.isFinite(u) && u > 0 ? Math.floor(u) : 0,
              notUseful: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0,
              lastMarked: typeof e.lastMarked === "string" ? e.lastMarked : ""
            };
          }
        }
        data = { version: 1, ...(vaultRoot ? { vault_root: vaultRoot } : {}), entries };
      }
    } catch {
      // missing / unreadable / malformed JSON — start empty (fail-soft).
    }
    return new FeedbackStore(file, data);
  }

  /**
   * Record a usefulness mark for each DISTINCT relative note path. Updates the
   * in-memory tally (so the same-session search boost sees it immediately) and
   * attempts a whole-generation fail-soft persist. `nowIso` is injected so the
   * module is Date-free and the write is deterministic under test.
   *
   * @returns the count of distinct paths recorded (paths skipped at the entry cap
   *   are still counted if they refer to an EXISTING entry).
   */
  async record(paths: readonly string[], useful: boolean, nowIso: string): Promise<number> {
    const seen = new Set<string>();
    // Hoist the entry count out of the loop (was recomputed per path — up to 50
    // fresh Object.keys() allocations over a 100k-entry map at the cap); track it
    // locally and bump only when a genuinely-new path is admitted.
    let count = Object.keys(this.data.entries).length;
    for (const p of paths) {
      const rel = p.trim();
      if (!rel || seen.has(rel)) continue;
      const existing = this.data.entries[rel];
      // At the cap, only UPDATE existing entries; ignore brand-new paths.
      if (!existing && count >= MAX_FEEDBACK_ENTRIES) continue;
      seen.add(rel);
      const e = existing ?? { useful: 0, notUseful: 0, lastMarked: "" };
      if (useful) e.useful += 1;
      else e.notUseful += 1;
      e.lastMarked = nowIso;
      if (!existing) count += 1;
      this.data.entries[rel] = e;
    }
    if (seen.size > 0) await this.persist();
    return seen.size;
  }

  /**
   * Live snapshot: relPath → score in (0, 1). Recomputed per search call (the map
   * is small — one entry per marked note). Notes with a net-zero or negative score
   * are omitted; the boost treats an absent path as score 0.
   */
  scores(): Map<string, number> {
    const m = new Map<string, number>();
    for (const [k, e] of Object.entries(this.data.entries)) {
      const s = feedbackScore(e);
      if (s > 0) m.set(k, s);
    }
    return m;
  }

  /** Number of notes with any recorded feedback (for the tool response). */
  size(): number {
    return Object.keys(this.data.entries).length;
  }

  /**
   * Serializes persists behind a per-store promise chain. The store is a SINGLE
   * instance shared across all serve-http sessions and the MCP SDK dispatches tool
   * calls concurrently, so two `record()` calls can both reach `persist()` before
   * either finishes. Chaining preserves invocation order as well as per-write
   * atomicity: an older snapshot can never publish after a newer one.
   */
  private persistChain: Promise<void> = Promise.resolve();

  private async persist(): Promise<void> {
    const next = this.persistChain.then(() => this.writeOnce());
    // Swallow on the chain so one failed write doesn't poison the next; the
    // returned promise still resolves (writeOnce never throws — fail-soft).
    this.persistChain = next.catch(() => {});
    return next;
  }

  private async writeOnce(): Promise<void> {
    const dir = path.dirname(this.file);
    try {
      // A recursive 0700 mkdir (subject only to a more-restrictive umask)
      // creates a private cache parent without path-chmodding a directory that
      // another process or the operator already owns.
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      // The common publisher creates an unpredictable exclusive mode-0600
      // sibling and renames it over the final leaf. It cannot follow a
      // deterministic temp symlink, and it never chmods the published path.
      const serialized = JSON.stringify(this.data);
      if (Buffer.byteLength(serialized, "utf8") > MAX_FEEDBACK_FILE_BYTES) {
        throw new Error("feedback snapshot exceeds the persistent read limit");
      }
      await publishSensitiveArtifact(this.file, serialized);
    } catch (err) {
      // Best-effort persistence: a write failure leaves the in-memory tally
      // intact (the session still benefits). Surface to STDERR for the operator
      // (operator-side; never returned to an MCP client — no path-leak class).
      process.stderr.write(
        `obsidian_mark_useful: feedback persist failed — ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }
}
