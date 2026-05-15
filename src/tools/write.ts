import * as path from "node:path";
import matter from "gray-matter";
import { resolvePeriodicNoteName } from "../periodic.js";
import type { FileEntry, Vault } from "../vault.js";
import { findBestMatch, stripMd } from "./meta.js";

export async function createNote(
  vault: Vault,
  args: { path: string; content: string; frontmatter?: Record<string, unknown>; overwrite?: boolean }
): Promise<{ path: string; mtime: string; bytes: number }> {
  await vault.ensureExists();
  const body = composeNote(args.frontmatter, args.content);
  const result = await vault.writeNote(args.path, body, { overwrite: args.overwrite });
  return {
    path: result.relPath,
    mtime: new Date(result.mtimeMs).toISOString(),
    bytes: result.bytes
  };
}

export async function appendToNote(
  vault: Vault,
  args: { path?: string; title?: string; content: string; separator?: string }
): Promise<{ path: string; mtime: string; appended_bytes: number }> {
  await vault.ensureExists();
  const target = await resolveTarget(vault, args);
  const sep = args.separator ?? "\n\n";
  const result = await vault.appendNote(target.absPath, sep + args.content);
  return {
    path: result.relPath,
    mtime: new Date(result.mtimeMs).toISOString(),
    appended_bytes: result.appended_bytes
  };
}

// ─── obsidian_rename_note (v1.1 atomic rename + backlink rewrite) ────────────
// Closes the longstanding "renaming a note breaks all backlinks" pain. Walks
// every other note in the vault, finds wikilinks/embeds whose findBestMatch
// resolves to the source file, rewrites only those literals (preserving
// `|alias`, `#section`, `^block`, and the user's chosen path-qualification),
// then atomically renames the file. dry_run returns the same plan without
// touching the disk.

export interface RenameProposal {
  path: string;
  rewrites: number;
  before: string;
  after: string;
}

export interface RenameNoteResult {
  from: string;
  to: string;
  dry_run: boolean;
  files_updated: RenameProposal[];
  total_links_rewritten: number;
}

export async function renameNote(
  vault: Vault,
  args: { from: string; to: string; dry_run?: boolean; overwrite?: boolean }
): Promise<RenameNoteResult> {
  await vault.ensureExists();
  const dryRun = args.dry_run === true;
  const fromRelNorm = args.from.toLowerCase().endsWith(".md") ? args.from : `${args.from}.md`;
  const toRelNorm = args.to.toLowerCase().endsWith(".md") ? args.to : `${args.to}.md`;

  // Resolve from (must exist) — vault.stat() rejects traversal + excluded paths
  // and confirms the file is real. resolveInside() is the public wrapper for
  // the same path-normalization logic without an existence check.
  const fromAbs = vault.resolveInside(fromRelNorm);
  const fromRel = vault.toRel(fromAbs);
  await vault.stat(fromAbs); // throws on missing source — fail fast.
  // Validate to-path early so we don't do O(N) work then fail.
  const toAbsCheck = vault.resolveInside(toRelNorm);
  const toRelCheck = vault.toRel(toAbsCheck);
  const renameReason = vault.exclusionReason(toRelCheck);
  if (renameReason) {
    // v2.0.0-beta.2 P1 fix: distinguish allowlist-vs-denylist same as
    // writeNote and Vault.renameFile do. Pre-fix the message always blamed
    // --exclude-glob even when --read-paths was the reason.
    throw new Error(`Refusing to rename — destination is excluded by ${renameReason}: ${toRelCheck}`);
  }
  if (fromRel === toRelCheck) {
    throw new Error(`from and to are the same path: ${fromRel}`);
  }
  if (!args.overwrite) {
    const exists = await vault
      .stat(toAbsCheck)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      throw new Error(`Destination already exists: ${toRelCheck} (pass overwrite=true to replace)`);
    }
  }

  const newBasename = stripMd(path.basename(toRelNorm));
  const newDir = path.dirname(toRelNorm).replace(/\\/g, "/");
  const entries = await vault.listMarkdown();

  // Build the rewrite plan. INCLUDES the source file itself so that any
  // self-references (e.g. `[[Foo]]` inside `Foo.md`) are also rewritten —
  // otherwise the renamed file would ship with a broken self-link. The source
  // is rewritten in place at the OLD path; fs.rename then carries the new
  // content to the new path in one atomic step.
  const plan: RenameProposal[] = [];
  let totalRewrites = 0;
  let sourcePlan: RenameProposal | null = null;
  for (const e of entries) {
    const isSource = e.absPath === fromAbs;
    const { content, parsed } = await vault.readNote(e.absPath, e.mtimeMs);

    // Find every wikilink + embed whose target resolves to fromAbs. Group by
    // raw inner text — multiple identical literals in the same file rewrite
    // together.
    const oldRawsToNew = new Map<string, { kind: "wikilink" | "embed"; newRaw: string }>();
    const candidates: Array<{ raw: string; target: string; kind: "wikilink" | "embed" }> = [
      ...parsed.wikilinks.map((l) => ({ raw: l.raw, target: l.target, kind: "wikilink" as const })),
      ...parsed.embeds.map((l) => ({ raw: l.raw, target: l.target, kind: "embed" as const }))
    ];
    for (const c of candidates) {
      if (oldRawsToNew.has(c.raw)) continue; // already mapped
      const m = findBestMatch(entries, c.target, e.relPath);
      if (!m || m.absPath !== fromAbs) continue;
      const newRaw = rewriteRawTarget(c.raw, c.target, newBasename, newDir);
      if (newRaw === c.raw) continue; // already correct (e.g., basename happened to match)
      oldRawsToNew.set(c.raw, { kind: c.kind, newRaw });
    }

    if (oldRawsToNew.size === 0) continue;

    // Apply the replacements with a code-fence-aware line walker so wikilinks
    // inside ``` / ~~~ blocks (which the parser ignores) stay verbatim.
    const { content: newContent, count } = rewriteOutsideCodeFences(content, oldRawsToNew);
    if (count === 0) continue;

    const proposal: RenameProposal = { path: e.relPath, rewrites: count, before: content, after: newContent };
    if (isSource) {
      // The source file's rewrite is held separately so we can write it last,
      // immediately before fs.rename, keeping the disk in a maximally-recoverable
      // state if anything between writes fails.
      sourcePlan = proposal;
    } else {
      plan.push(proposal);
    }
    totalRewrites += count;
  }

  if (!dryRun) {
    // Write order:
    //   1. All backlink-bearing files (other notes pointing at the source).
    //   2. Source file's rewritten content, written to its OLD path.
    //   3. fs.rename source's old path → new path.
    // A failure at any step leaves backlinks pointing at the still-present old
    // name (worst case: safe, recoverable).
    for (const p of plan) {
      await vault.writeNote(p.path, p.after, { overwrite: true });
    }
    if (sourcePlan) {
      await vault.writeNote(sourcePlan.path, sourcePlan.after, { overwrite: true });
    }
    // Atomic file move + cache invalidation.
    await vault.renameFile(fromRelNorm, toRelNorm, { overwrite: args.overwrite });
  }

  // Combine plans for the response so the caller sees the full picture.
  const allPlans = sourcePlan ? [...plan, sourcePlan] : plan;

  // Strip `before`/`after` from the response — the caller doesn't need the
  // full file contents back, just the per-file count. We kept them for the
  // pre-write loop; the response trims them. The source-file entry uses its
  // POST-rename path so the caller sees where the rewrite ended up.
  const trimmedPlan = allPlans.map((p) => ({
    path: p === sourcePlan ? toRelCheck : p.path,
    rewrites: p.rewrites,
    before: "",
    after: ""
  }));

  return {
    from: fromRel,
    to: toRelCheck,
    dry_run: dryRun,
    files_updated: trimmedPlan,
    total_links_rewritten: totalRewrites
  };
}

// ─── obsidian_archive_note (v1.11 thin convenience wrapper around rename) ────
// Common workflow: move a note to a vault Archive folder, preserving every
// `[[wikilink]]` / `![[embed]]` that pointed at it. Just calls renameNote
// under the hood with a computed `to` path. Defaults the archive folder to
// `Archive/` but accepts override.

export interface ArchiveNoteArgs {
  /** Vault-relative path of the note to archive (with or without `.md`). */
  path: string;
  /** Archive folder. Defaults to `Archive/`. Trailing slash optional. */
  archive_folder?: string;
  /** Preview the rewrite plan without writing. Default false. */
  dry_run?: boolean;
  /** Allow overwriting an existing file at the archive destination. Default false. */
  overwrite?: boolean;
}

export interface FrontmatterSetArgs {
  path?: string;
  title?: string;
  /** Keys to set. Setting a key to `null` deletes it. */
  set: Record<string, unknown>;
  /** Optional: dry_run shows the diff without writing. */
  dry_run?: boolean;
}

export async function frontmatterSet(
  vault: Vault,
  args: FrontmatterSetArgs
): Promise<{
  path: string;
  changed_keys: string[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  dry_run: boolean;
}> {
  await vault.ensureExists();
  if (!args.set || Object.keys(args.set).length === 0) {
    throw new Error("frontmatter_set: `set` must be a non-empty object");
  }
  const target = await resolveTarget(vault, args);
  const note = await vault.readNote(target.absPath, target.mtimeMs);
  const before = { ...note.parsed.frontmatter };
  const after: Record<string, unknown> = { ...before };
  const changed: string[] = [];
  for (const [k, v] of Object.entries(args.set)) {
    if (v === null) {
      if (k in after) {
        delete after[k];
        changed.push(`-${k}`);
      }
    } else {
      const prev = after[k];
      if (JSON.stringify(prev) !== JSON.stringify(v)) {
        after[k] = v;
        changed.push(`${k in before ? "~" : "+"}${k}`);
      }
    }
  }
  if (changed.length === 0 || args.dry_run === true) {
    return { path: target.relPath, changed_keys: changed, before, after, dry_run: args.dry_run === true };
  }
  // Round-trip via gray-matter — same writer pattern as createNote.
  const newDoc = matter.stringify(note.parsed.body, after);
  await vault.writeNote(target.relPath, newDoc, { overwrite: true });
  return { path: target.relPath, changed_keys: changed, before, after, dry_run: false };
}

export async function archiveNote(vault: Vault, args: ArchiveNoteArgs): Promise<RenameNoteResult> {
  await vault.ensureExists();
  if (!args.path) throw new Error("archive_note: `path` is required");
  const folder = (args.archive_folder ?? "Archive").replace(/\/+$/, "");
  // Strip leading folders from the source so the basename lands cleanly in
  // the archive — e.g. `Inbox/Foo.md` → `Archive/Foo.md`, not
  // `Archive/Inbox/Foo.md`. Preserves the user's `.md` extension or appends
  // it if missing (renameNote handles that anyway).
  const basename = path.basename(args.path);
  const renameArgs: { from: string; to: string; dry_run?: boolean; overwrite?: boolean } = {
    from: args.path,
    to: `${folder}/${basename}`
  };
  if (args.dry_run !== undefined) renameArgs.dry_run = args.dry_run;
  if (args.overwrite !== undefined) renameArgs.overwrite = args.overwrite;
  return renameNote(vault, renameArgs);
}

// ─── obsidian_replace_in_notes (v1.9 bulk find/replace) ─────────────────────
// Code-fence-aware bulk string replacement across the vault. Reuses the same
// fence-tracking line walker as rename_note's wikilink rewriter so example
// snippets and code documentation stay verbatim. Read-only by design unless
// dry_run is false; returns per-file counts so the agent can verify before
// committing. WRITE TOOL — only registered when --enable-write is passed.

export interface ReplaceInNotesArgs {
  /** Literal substring to find. Empty string is rejected. */
  search: string;
  /** Replacement text. May be empty (= delete every occurrence). */
  replace: string;
  /** Restrict to a subfolder (vault-relative). Default: whole vault. */
  folder?: string;
  /** Preview the rewrite plan without touching disk. Default false. */
  dry_run?: boolean;
  /** Case-sensitive match (default true). False = case-insensitive substring. */
  case_sensitive?: boolean;
}

export interface ReplaceInNotesFileResult {
  path: string;
  occurrences: number;
}

export interface ReplaceInNotesResult {
  search: string;
  replace: string;
  case_sensitive: boolean;
  dry_run: boolean;
  scope: string;
  files_scanned: number;
  files_updated: ReplaceInNotesFileResult[];
  total_replacements: number;
  /** v2.0.0-beta.2 P1: when true, the apply pass aborted partway through.
   *  `files_updated` only contains files that DID write successfully. Files
   *  in `errors` (if present) failed mid-write — caller should retry just
   *  those and verify state. Always false on dry_run. */
  partial: boolean;
  /** v2.0.0-beta.2 P1: per-file write errors collected during apply. Only
   *  populated when the apply phase encountered errors (so happy-path
   *  responses stay narrow). */
  errors?: Array<{ path: string; message: string }>;
}

export async function replaceInNotes(vault: Vault, args: ReplaceInNotesArgs): Promise<ReplaceInNotesResult> {
  await vault.ensureExists();
  const dryRun = args.dry_run === true;
  const caseSensitive = args.case_sensitive !== false;
  if (!args.search) {
    throw new Error("replace_in_notes: `search` must be a non-empty string");
  }
  if (args.search === args.replace) {
    throw new Error("replace_in_notes: `search` and `replace` are identical — no-op refused");
  }
  // v2.0.0-beta.2 P2 fix: reject early if `args.folder` itself is excluded.
  // Pre-fix, listMarkdown(excludedFolder) returned [] and the response said
  // "scope: 02_Personal/, files_scanned: 0" — confirming the folder name
  // existed in the user's vault layout. Now we refuse, returning a clean
  // error that doesn't reveal whether the folder is real-but-empty,
  // real-but-excluded, or nonexistent.
  // Test both `<folder>` (folder itself excluded) and `<folder>/_probe.md`
  // (a representative path inside) — the user's glob may use `**` which
  // matches subpaths but not the bare folder name.
  if (args.folder) {
    const folderTrim = args.folder.replace(/\/+$/, "");
    if (vault.isExcluded(folderTrim) || vault.isExcluded(`${folderTrim}/_probe.md`)) {
      throw new Error(`replace_in_notes: folder is excluded by privacy filter: ${args.folder}`);
    }
  }

  const entries = await vault.listMarkdown(args.folder);
  const plan: Array<{ path: string; before: string; after: string; count: number }> = [];
  let total = 0;
  for (const e of entries) {
    const { content } = await vault.readNote(e.absPath, e.mtimeMs);
    const { content: rewritten, count } = replaceStringOutsideCodeFences(
      content,
      args.search,
      args.replace,
      caseSensitive
    );
    if (count === 0) continue;
    plan.push({ path: e.relPath, before: content, after: rewritten, count });
    total += count;
  }

  // v2.0.0-beta.2 P1 fix: per-file error collection on apply. Pre-fix, a
  // throw on file 5 of 20 would lose the response — files 1-4 silently
  // committed, agent had no way to discover which. Now we continue past
  // failures, collect errors, and return both `files_updated` (committed)
  // and `errors` (uncommitted) with `partial: true` flag.
  //
  // Systemic-error fast-path: if the vault is read-only OR the first write
  // fails synchronously (e.g. all paths excluded by --read-paths), throw
  // immediately rather than returning a "partial: true" with N errors —
  // that's a config problem, not a per-file failure.
  const updated: ReplaceInNotesFileResult[] = [];
  const errors: Array<{ path: string; message: string }> = [];
  if (!dryRun) {
    if (!vault.writeEnabled) {
      throw new Error("Vault is read-only — start the server with --enable-write to allow note creation");
    }
    for (const p of plan) {
      try {
        await vault.writeNote(p.path, p.after, { overwrite: true });
        updated.push({ path: p.path, occurrences: p.count });
      } catch (err) {
        errors.push({ path: p.path, message: err instanceof Error ? err.message : String(err) });
      }
    }
  } else {
    for (const p of plan) updated.push({ path: p.path, occurrences: p.count });
  }

  const result: ReplaceInNotesResult = {
    search: args.search,
    replace: args.replace,
    case_sensitive: caseSensitive,
    dry_run: dryRun,
    scope: args.folder ?? "(whole vault)",
    files_scanned: entries.length,
    files_updated: updated,
    total_replacements: total,
    partial: errors.length > 0
  };
  if (errors.length > 0) result.errors = errors;
  return result;
}

/** Given the raw inner text of a wikilink (`Foo|alias`, `Folder/Foo#sec`, etc.)
 *  and the resolved target string the parser already extracted, produce the new
 *  raw text after the file has been renamed. Preserves alias/section/block and
 *  the user's chosen path-qualification convention (bare-basename vs path). */
export function rewriteRawTarget(raw: string, oldTarget: string, newBasename: string, newDir: string): string {
  const wasPathQualified = oldTarget.includes("/");
  const newTargetBare = wasPathQualified
    ? newDir === "." || newDir === ""
      ? newBasename
      : `${newDir}/${newBasename}`
    : newBasename;

  // The raw text is `<target><suffix>` where suffix starts with the first of
  // |, #, or ^. Find the boundary.
  const pipeIdx = raw.indexOf("|");
  const hashIdx = raw.indexOf("#");
  const blockIdx = raw.indexOf("^");
  const idxs = [pipeIdx, hashIdx, blockIdx].filter((i) => i !== -1);
  const suffixStart = idxs.length === 0 ? raw.length : Math.min(...idxs);
  const suffix = raw.slice(suffixStart);
  return `${newTargetBare}${suffix}`;
}

/** Walk file content line by line. Toggle `inFence` at any line that opens or
 *  closes a ``` or ~~~ fence. Inside a fence, leave content untouched. Outside,
 *  replace each old literal with its new literal. Returns { content, count }
 *  where count is the total number of literal replacements applied. */
export function rewriteOutsideCodeFences(
  content: string,
  oldRawsToNew: Map<string, { kind: "wikilink" | "embed"; newRaw: string }>
): { content: string; count: number } {
  const lines = content.split("\n");
  let inFence = false;
  let count = 0;
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    let mutated = line;
    for (const [oldRaw, { kind, newRaw }] of oldRawsToNew) {
      const oldLit = `${kind === "embed" ? "![[" : "[["}${oldRaw}]]`;
      const newLit = `${kind === "embed" ? "![[" : "[["}${newRaw}]]`;
      if (oldLit === newLit) continue;
      // Use indexOf-based replacement so we count occurrences accurately.
      let idx = mutated.indexOf(oldLit);
      while (idx !== -1) {
        mutated = mutated.slice(0, idx) + newLit + mutated.slice(idx + oldLit.length);
        count += 1;
        idx = mutated.indexOf(oldLit, idx + newLit.length);
      }
    }
    out.push(mutated);
  }
  return { content: out.join("\n"), count };
}

/** Generic code-fence-aware string replacer used by replaceInNotes (v1.9).
 *  Walks line-by-line, tracks ` ``` ` / `~~~` fences, and replaces every
 *  occurrence of `search` with `replace` outside fenced blocks. Case-sensitive
 *  by default; pass `caseSensitive: false` for case-insensitive substring
 *  match. Returns the rewritten content + replacement count. */
export function replaceStringOutsideCodeFences(
  content: string,
  search: string,
  replace: string,
  caseSensitive: boolean
): { content: string; count: number } {
  if (!search) return { content, count: 0 };
  const lines = content.split("\n");
  let inFence = false;
  let count = 0;
  const out: string[] = [];
  const needle = caseSensitive ? search : search.toLowerCase();
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (caseSensitive) {
      let mutated = line;
      let idx = mutated.indexOf(needle);
      while (idx !== -1) {
        mutated = mutated.slice(0, idx) + replace + mutated.slice(idx + search.length);
        count += 1;
        idx = mutated.indexOf(needle, idx + replace.length);
      }
      out.push(mutated);
    } else {
      // Case-insensitive: walk by lowering only when comparing, but preserve
      // the rest of the original line. Replace verbatim with `replace`.
      let mutated = line;
      let lowered = mutated.toLowerCase();
      let idx = lowered.indexOf(needle);
      while (idx !== -1) {
        mutated = mutated.slice(0, idx) + replace + mutated.slice(idx + search.length);
        lowered = mutated.toLowerCase();
        count += 1;
        idx = lowered.indexOf(needle, idx + replace.length);
      }
      out.push(mutated);
    }
  }
  return { content: out.join("\n"), count };
}

export function composeNote(frontmatter: Record<string, unknown> | undefined, content: string): string {
  if (!frontmatter || Object.keys(frontmatter).length === 0) return content;
  // Use gray-matter's stringify (backed by js-yaml) so YAML-special strings —
  // date-like ("2026-05-03"), !-prefixed, pipe-containing, etc. — are
  // round-trip-safe. The hand-rolled renderer this replaced silently corrupted
  // a long tail of valid string values (e.g. "due: 2026-05-03" came back as a
  // Date object on read).
  return matter.stringify(content, frontmatter);
}

export function extractFrontmatterTagsLower(fm: Record<string, unknown>): string[] {
  const raw = fm.tags ?? fm.tag;
  if (!raw) return [];
  const list: string[] = Array.isArray(raw)
    ? raw.filter((t): t is string => typeof t === "string")
    : typeof raw === "string"
      ? raw.split(/[,\s]+/).filter(Boolean)
      : [];
  return list.map((t) => t.replace(/^#+/, "").toLowerCase());
}

/** Resolve "today"/"daily"/"weekly"/"monthly" to today's periodic-note name
 *  using the standard Obsidian Daily-Notes-plugin formats. Custom formats are
 *  out of scope (users with non-default conventions address by exact name). */
export function resolvePeriodicAlias(title: string): string | null {
  const lower = title.trim().toLowerCase();
  if (lower !== "daily" && lower !== "today" && lower !== "weekly" && lower !== "monthly") {
    return null;
  }
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  if (lower === "daily" || lower === "today") return `${yyyy}-${mm}-${dd}`;
  if (lower === "monthly") return `${yyyy}-${mm}`;
  // ISO week number (Mon-based, ISO 8601). Weekly format: YYYY-Www.
  const target = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayNum = target.getUTCDay() || 7; // Mon=1..Sun=7
  target.setUTCDate(target.getUTCDate() + 4 - dayNum); // Thursday of this week
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((target.valueOf() - yearStart.valueOf()) / 86400000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/** Up to 3 vault-relative paths whose basename or relPath looks similar to
 *  the missing target. Used to enrich `Note not found` errors with did-you-mean
 *  hints — meaningful for LLMs that mistype a note name. */
export async function suggestSimilar(vault: Vault, target: string): Promise<string[]> {
  try {
    const all = await vault.listMarkdown();
    const lower = target.toLowerCase().replace(/\.md$/i, "");
    const ranked = all
      .map((e) => {
        const baseLower = stripMd(e.basename).toLowerCase();
        const relLower = e.relPath.toLowerCase();
        let score = 0;
        if (baseLower === lower) score = 100;
        else if (baseLower.startsWith(lower) || lower.startsWith(baseLower)) score = 70;
        else if (baseLower.includes(lower) || lower.includes(baseLower)) score = 50;
        else if (relLower.includes(lower)) score = 30;
        return { path: e.relPath, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    return ranked.map((r) => r.path);
  } catch {
    return [];
  }
}

export async function resolveTarget(vault: Vault, args: { path?: string; title?: string }): Promise<FileEntry> {
  if (args.path) {
    const candidates = args.path.toLowerCase().endsWith(".md") ? [args.path] : [args.path, `${args.path}.md`];
    let lastErr: unknown;
    for (const candidate of candidates) {
      const abs = vault.resolveInside(candidate);
      try {
        const stat = await vault.stat(abs);
        return {
          absPath: abs,
          relPath: vault.toRel(abs),
          basename: path.basename(abs),
          mtimeMs: stat.mtimeMs
        };
      } catch (err) {
        lastErr = err;
      }
    }
    const suggestions = await suggestSimilar(vault, args.path);
    const hint = suggestions.length ? `. Did you mean: ${suggestions.join(", ")}?` : "";
    throw lastErr instanceof Error
      ? new Error(`${lastErr.message}${hint}`)
      : new Error(`Note not found: ${args.path}${hint}`);
  }
  if (args.title) {
    // Try literal title first — a user may have an actual file named
    // "Daily.md" / "Today.md" they meant to address. Only fall back to the
    // periodic-note alias when the literal lookup misses.
    const literal = await vault.findByTitle(args.title);
    if (literal) return literal;
    // v1.10: try the user's Daily / Periodic Notes plugin config first. The
    // user may have configured `Daily Notes/YYYY-MM-DD` or a custom format —
    // honor that before the v0.11 hard-coded defaults.
    const periodicConfig = await vault.getPeriodicConfig();
    const periodicResolved = resolvePeriodicNoteName(args.title, periodicConfig);
    if (periodicResolved) {
      // The user's config produced a vault-relative path stem. Look it up by
      // path (with .md appended); if THAT misses, fall back to basename match
      // for users whose plugin folder is empty (vault-root files).
      try {
        const tryPath = `${periodicResolved.relPath}.md`;
        const abs = vault.resolveInside(tryPath);
        const stat = await vault.stat(abs);
        return {
          absPath: abs,
          relPath: vault.toRel(abs),
          basename: path.basename(abs),
          mtimeMs: stat.mtimeMs
        };
      } catch (err) {
        // v1.11.1: surface exclusion errors instead of masking them as
        // "not found". The path-based lookup above already does this via
        // lastErr — keep both codepaths consistent. Exclusion errors come
        // from a user's own --read-paths / --exclude-glob config, so they
        // deserve a clear "excluded" message rather than silent fallthrough
        // to the legacy alias resolver (which won't help anyway).
        if (err instanceof Error && /excluded by --(read-paths|exclude-glob)/.test(err.message)) {
          throw err;
        }
        // Fall through to basename match on ENOENT-class errors only.
      }
      // v2.0.0-beta.2 P1 fix: only fall through to basename match if the
      // user's periodic config produces a folder-less stem (i.e., they keep
      // periodic notes at the vault root). If they configured a specific
      // folder, returning a same-basename note from a DIFFERENT folder is a
      // privacy/correctness hazard — silently redirects "today" to a note
      // the user never configured. The architecture audit (P1-4) traced an
      // exploit: with `--exclude-glob 'Daily Notes/**'` set AND a Public/
      // file named `2026-05-08.md`, basename match would surface that
      // unrelated note as "today".
      const periodicHasFolder = periodicResolved.relPath.includes("/");
      if (!periodicHasFolder) {
        const basenameMatch = await vault.findByTitle(path.basename(periodicResolved.relPath));
        if (basenameMatch) return basenameMatch;
      }
    }
    // Last-resort: legacy v0.11 hard-coded alias resolver, in case the user
    // has neither plugin configured but expects the default formats to work.
    const aliased = resolvePeriodicAlias(args.title);
    if (aliased) {
      const aliasMatch = await vault.findByTitle(aliased);
      if (aliasMatch) return aliasMatch;
    }
    const suggestions = await suggestSimilar(vault, args.title);
    const hint = suggestions.length ? `. Did you mean: ${suggestions.join(", ")}?` : "";
    const aliasHint = periodicResolved ? ` (also tried periodic alias "${periodicResolved.relPath}")` : "";
    throw new Error(`No note found with title: ${args.title}${aliasHint}${hint}`);
  }
  throw new Error("Either path or title is required");
}
