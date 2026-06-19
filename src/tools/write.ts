import * as path from "node:path";
import { parseFrontmatter, stringifyFrontmatter } from "../frontmatter.js";
import { foldName } from "../name-fold.js";
import { resolvePeriodicNoteName } from "../periodic.js";
import type { FileEntry, Vault } from "../vault.js";
import { findBestMatch, stripMd } from "./meta.js";

/**
 * Create a new note (or overwrite an existing one) with optional YAML
 * frontmatter.
 *
 * Frontmatter is serialized via the shared `stringifyFrontmatter` (js-yaml
 * underneath), so values like dates / lists / pipe-containing strings round-trip cleanly without
 * the hand-rolled-YAML corruption the old composer suffered. WRITE TOOL —
 * only registered when the server is started with `--enable-write`.
 *
 * @param vault - The vault. Must allow writes (`vault.writeEnabled` is true).
 * @param args - `path` is the vault-relative target. `content` is the body
 *   (frontmatter prepended automatically). `frontmatter` is the optional YAML.
 *   `overwrite` defaults to false — set true to replace an existing note.
 * @returns `{ path, mtime, bytes }` — resolved vault-relative path, ISO
 *   mtime, and UTF-8 byte size of the written file.
 * @throws {Error} If the vault is read-only, the destination exists and
 *   `overwrite` is not true, or the path is excluded by privacy filters.
 * @throws {VaultPathError} If the path traverses outside the vault root.
 * @example
 * ```ts
 * const r = await createNote(vault, {
 *   path: "Posts/2026/Hybrid-Retrieval.md",
 *   frontmatter: { status: "draft", tags: ["retrieval", "rag"] },
 *   content: "# Hybrid Retrieval\n\nBM25 + embeddings...",
 *   overwrite: false
 * });
 * console.log(r.path, r.bytes);
 * ```
 */
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

/**
 * Append content to the end of an existing note, with a configurable
 * separator.
 *
 * Resolves the target by path or title (same fuzzy-match as wikilinks). The
 * default separator is `"\n\n"` — a blank line — so appends read as a new
 * paragraph. Pass `separator: ""` for raw concatenation. WRITE TOOL — only
 * registered when the server is started with `--enable-write`.
 *
 * @param vault - The vault. Must allow writes.
 * @param args - One of `path` or `title` is required. `content` is the
 *   text to append. `separator` defaults to `"\n\n"`.
 * @returns `{ path, mtime, appended_bytes }` — the appended byte count
 *   includes the separator.
 * @throws {Error} If the vault is read-only or the target can't be resolved.
 * @throws {VaultPathError} If `path` resolves outside the vault.
 * @example
 * ```ts
 * await appendToNote(vault, {
 *   path: "Journal/2026-05-15.md",
 *   content: "Afternoon: shipped v3.6.0-rc.3",
 *   separator: "\n\n## "
 * });
 * ```
 */
export async function appendToNote(
  vault: Vault,
  args: { path?: string; title?: string; content: string; separator?: string }
): Promise<{ path: string; mtime: string; appended_bytes: number }> {
  await vault.ensureExists();
  // v3.7.16 P2-13 — write-side resolution refuses to silently mutate
  // when the title matches multiple notes.
  const target = await resolveTarget(vault, args, { strictOnAmbiguousTitle: true });
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

/**
 * Per-file entry of the {@link renameNote} rewrite plan.
 *
 * `before` / `after` carry the full file contents in the planning phase;
 * they are trimmed to empty strings in the public response (callers get
 * just the per-file `rewrites` count).
 */
export interface RenameProposal {
  /** Vault-relative path of the file whose links were rewritten. */
  path: string;
  /** Number of distinct wikilink/embed literals rewritten in this file. */
  rewrites: number;
  /** Original content (empty in the trimmed response). */
  before: string;
  /** Rewritten content (empty in the trimmed response). */
  after: string;
}

/**
 * Envelope returned by {@link renameNote}.
 *
 * `total_links_rewritten` is the sum across `files_updated`. `dry_run` echoes
 * the input so the caller can detect a forgotten flag.
 */
export interface RenameNoteResult {
  /** Source path (with `.md`). */
  from: string;
  /** Destination path (with `.md`). */
  to: string;
  /** Whether the file system was actually mutated. */
  dry_run: boolean;
  /** Per-file rewrites. The source file is the last entry, at its NEW path. */
  files_updated: RenameProposal[];
  /** Sum of `rewrites` across `files_updated`. */
  total_links_rewritten: number;
}

/**
 * Atomic note rename with cross-vault backlink rewrite.
 *
 * Closes the longstanding "renaming breaks all backlinks" pain point. Walks
 * every note, finds wikilinks / embeds whose `findBestMatch` resolves to the
 * source file, rewrites only those literals (preserving `|alias`, `#section`,
 * `^block`, and the user's path-qualification convention), then atomically
 * moves the file. `dry_run` returns the same plan without touching disk.
 *
 * Self-references inside the renamed file are also rewritten in the same
 * pass — the file ships with no broken self-links. v3.7.13 M1 — write
 * order is recoverable: (1) rewrite source content at OLD path → (2)
 * `fs.rename` OLD → NEW (atomic, runs FIRST so a failure here doesn't
 * leave updated backlinks pointing at a phantom target) → (3) rewrite
 * backlink-bearing files (destination already exists on disk). Every
 * failure mode is recoverable by re-running the same call (each step is
 * idempotent on re-input). Pre-v3.7.13 the order was (backlinks → source
 * → rename), which left backlinks rewritten to the NEW name pointing at
 * a phantom destination when the rename step failed.
 * WRITE TOOL — only registered when `--enable-write` is passed.
 *
 * @param vault - The vault. Must allow writes.
 * @param args - `from` and `to` are vault-relative paths (with or without
 *   `.md`). `dry_run` defaults to false — when true, returns the plan
 *   without writing. `overwrite` defaults to false — when true, allows
 *   replacing an existing destination.
 * @returns A {@link RenameNoteResult} with per-file rewrites and totals.
 * @throws {Error} If source doesn't exist, destination exists and `overwrite`
 *   is false, source equals destination, or destination is privacy-excluded.
 * @throws {VaultPathError} If either path resolves outside the vault.
 * @example
 * ```ts
 * // Preview first
 * const plan = await renameNote(vault, {
 *   from: "Inbox/draft-1.md",
 *   to: "Posts/Hybrid Retrieval.md",
 *   dry_run: true
 * });
 * console.log(`Would update ${plan.files_updated.length} files`);
 *
 * // Apply
 * await renameNote(vault, { from: "Inbox/draft-1.md", to: "Posts/Hybrid Retrieval.md" });
 * ```
 */
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
  // v3.7.16 P1-6 sibling — use the canonical-case form so case-insensitive
  // FS variants (`personal/x.md` vs `Personal/x.md`) don't slip past the
  // fast-fail and waste an O(N) backlink-rewrite walk before `renameFile`
  // catches them with the same canonical check.
  const toAbsCheck = vault.resolveInside(toRelNorm);
  const toRelCheck = vault.toRel(toAbsCheck);
  const canonicalToRel = await vault.canonicalRelForPrivacyCheckPublic(toAbsCheck);
  const renameReason = vault.exclusionReason(canonicalToRel);
  if (renameReason) {
    // v2.0.0-beta.2 P1 fix: distinguish allowlist-vs-denylist same as
    // writeNote and Vault.renameFile do. Pre-fix the message always blamed
    // --exclude-glob even when --read-paths was the reason.
    throw new Error(`Refusing to rename — destination is excluded by ${renameReason}: ${toRelCheck}`);
  }
  if (fromRel === toRelCheck) {
    throw new Error(`from and to are the same path: ${fromRel}`);
  }
  // v3.10.0-rc.61 (WRITE-3) — a case-only rename (Foo.md → foo.md) on a case-INSENSITIVE FS sees
  // the "destination" as existing because it IS the source (same inode). Skip this tool-level
  // existence guard for a case-only path difference and defer to `vault.renameFile`, which is the
  // authority: on a case-insensitive FS it does the rename (its `isSameInodeCaseRename` inode
  // check confirms same file); on a case-SENSITIVE FS where `to` is a distinct existing file it
  // still throws EEXIST → "Destination already exists". A non-case-only existing dest is rejected here.
  const caseOnlyRename = fromAbs !== toAbsCheck && fromAbs.toLowerCase() === toAbsCheck.toLowerCase();
  if (!args.overwrite && !caseOnlyRename) {
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
    // v3.10.0-rc.60 (WRITE-1, data-loss) — the DESTINATION must be excluded from the
    // backlink-rewrite plan: under overwrite=true, `renameFile` moves the SOURCE content
    // onto the destination path, so writing the destination's PRE-rename (rewritten) content
    // back afterwards would clobber the just-moved source (silent data loss when the
    // destination backlinks the source). The destination's post-rename content IS the source
    // (its self-refs already fixed via sourcePlan), so there is nothing to rewrite there.
    const isDest = e.absPath === toAbsCheck;
    if (isDest) continue;
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
    // v3.7.13 M1 — reordered to make the failure mode actually recoverable.
    //
    // Pre-3.7.13 order was:
    //   1. Rewrite backlink-bearing files (now pointing at the NEW name).
    //   2. Rewrite source file content at its OLD path.
    //   3. fs.rename source: OLD → NEW.
    // The CHANGELOG/comment claimed "failure leaves backlinks pointing at
    // still-present old name (safe, recoverable)" — but step 1 had ALREADY
    // rewritten those backlinks to the NEW name. A failure at step 3 left
    // backlinks pointing at a phantom NEW path that didn't exist on disk.
    //
    // Post-3.7.13 order:
    //   1. Rewrite source file content at its OLD path (self-references
    //      now use the NEW name, but the file lives at the OLD path).
    //   2. fs.rename source: OLD → NEW (atomic — the failure-prone step,
    //      runs FIRST so backlinks don't get touched on rename failure).
    //   3. Rewrite backlink-bearing files (all targets now resolve — the
    //      destination already exists on disk thanks to step 2).
    //
    // Failure modes:
    //   • Step 1 fails → no on-disk state changed (writeNote uses atomic
    //     rename internally for new files; for overwrite-mode it's a
    //     direct fs.writeFile — could partially write, but write of the
    //     SAME file just means the source has interrupted content. Re-run
    //     resumes normally because the rewrite is idempotent on re-input.)
    //   • Step 2 fails → source content updated at OLD path (self-links
    //     reference NEW name but file is at OLD path). User re-runs the
    //     same call — source's self-link rewrite is idempotent (count=0
    //     on already-rewritten files, see line 249's `continue`), and
    //     rename retries.
    //   • Step 3 fails partway → some backlinks updated, others not. The
    //     destination file IS at the NEW path (step 2 succeeded), so the
    //     already-updated backlinks point at a real file. User re-runs;
    //     the plan only includes files that still contain old refs, so
    //     resumes cleanly.
    //
    // Net: every failure mode is recoverable by re-running the same call.
    if (sourcePlan) {
      await vault.writeNote(sourcePlan.path, sourcePlan.after, { overwrite: true });
    }
    // Atomic file move + cache invalidation. Most likely to fail (cross-fs
    // rename, race on destination, permission issue). Run FIRST so failure
    // here doesn't leave updated backlinks pointing at a phantom target.
    await vault.renameFile(fromRelNorm, toRelNorm, { overwrite: args.overwrite });
    // Backlink rewrites — destination already exists on disk, so even a
    // partial failure leaves the cluster in a consistent (if half-renamed)
    // state that's resumable by re-running the same call.
    for (const p of plan) {
      await vault.writeNote(p.path, p.after, { overwrite: true });
    }
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

/**
 * Arguments for {@link archiveNote}.
 *
 * Thin wrapper around rename — moves a note into the archive folder while
 * preserving every wikilink and embed that points at it.
 */
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

/**
 * Arguments for {@link frontmatterSet}.
 *
 * Setting a key to `null` *deletes* it (not the same as setting to YAML
 * `null`). This is a deliberate convenience choice — agents typically don't
 * need to write literal YAML `null`, but they often need to remove a key.
 */
export interface FrontmatterSetArgs {
  /** Vault-relative path of the target note. */
  path?: string;
  /** Title (basename without `.md`) of the target note. */
  title?: string;
  /** Keys to set. Setting a key to `null` deletes it. */
  set: Record<string, unknown>;
  /** Preview the diff without writing. Default false. */
  dry_run?: boolean;
}

/**
 * Atomic YAML frontmatter mutation — set, update, or delete keys via a
 * `parseFrontmatter`∘`stringifyFrontmatter` round-trip (js-yaml@4).
 *
 * Replaces the error-prone "find/replace YAML text" pattern. Parses the
 * frontmatter, applies the diff, re-serializes via js-yaml (so date-like
 * strings, multi-line values, pipe-containing strings, etc. stay correct).
 * Reports per-key change markers in `changed_keys`: `"+key"` for added,
 * `"~key"` for updated, `"-key"` for deleted. No-op writes (every value
 * already matches) are skipped — the response still reports the empty diff.
 * WRITE TOOL — only registered with `--enable-write`.
 *
 * @param vault - The vault. Must allow writes.
 * @param args - {@link FrontmatterSetArgs}. `set` must be non-empty.
 * @returns `{ path, changed_keys, before, after, dry_run }` — `before`
 *   and `after` are the full frontmatter maps so the caller can diff.
 * @throws {Error} If `set` is empty, vault is read-only, or target can't
 *   be resolved.
 * @example
 * ```ts
 * // Mark a draft as published, set a date, delete a stale key
 * await frontmatterSet(vault, {
 *   path: "Posts/Article.md",
 *   set: {
 *     status: "published",
 *     published_at: "2026-05-15",
 *     draft_notes: null  // deletes the key
 *   }
 * });
 * ```
 */
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
  // v3.7.16 P2-13 — write-side resolution refuses to silently mutate
  // when the title matches multiple notes.
  const target = await resolveTarget(vault, args, { strictOnAmbiguousTitle: true });
  const note = await vault.readNote(target.absPath, target.mtimeMs);
  // v3.10.0-rc.61 (WRITE-2) + v3.10.0-rc.64 (round-3 audit, non-mapping sibling) — guard the
  // EXISTING frontmatter against two write-back data-loss shapes, both of which leave
  // `note.parsed.frontmatter` as `{}` (so `before:{}` would hide the loss) while the raw block
  // still holds real content that `stringifyFrontmatter(body, after)` would REPLACE:
  //   (a) MALFORMED YAML (e.g. tab-indented) — parseNote swallowed the parse error and fell
  //       back to a whole-file body; re-parsing the raw content THROWS. (rc.61)
  //   (b) valid-YAML NON-MAPPING — a bare scalar (`---\nhello\n---`) or sequence
  //       (`---\n- a\n---`); parseFrontmatter SUCCEEDS but coerces `data` to `{}` and sets
  //       `coerced` (it would otherwise be spread char-indexed). (rc.64 — the sibling the
  //       rc.61 throws-only guard missed.)
  // Refuse fail-closed in BOTH cases. (A note with NO frontmatter parses cleanly, `coerced`
  // is false → adding frontmatter stays allowed — the legitimate add path.)
  let existingFm: ReturnType<typeof parseFrontmatter>;
  try {
    existingFm = parseFrontmatter(note.content);
  } catch {
    throw new Error(
      `frontmatter_set: refusing to edit ${target.relPath} — its existing frontmatter is not valid YAML ` +
        `(e.g. a tab used for indentation, which YAML forbids). Fix the frontmatter by hand first, then retry.`
    );
  }
  if (existingFm.coerced) {
    throw new Error(
      `frontmatter_set: refusing to edit ${target.relPath} — its existing frontmatter is not a YAML mapping ` +
        `(it's a bare scalar or sequence). Editing it would replace and destroy that block. Fix the frontmatter by hand first, then retry.`
    );
  }
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
  // Round-trip via the shared frontmatter serializer — same writer pattern as createNote.
  let newDoc = stringifyFrontmatter(note.parsed.body, after);
  // v3.10.0-rc.48 (roundtrip-serialization-fidelity) — `stringifyFrontmatter` always
  // appends a trailing "\n" to the body (the behavior ported from gray-matter). The parser's `.body`
  // faithfully preserves the original body's trailing-newline state, so if the body had NO
  // trailing newline, dropping the one stringify added keeps a frontmatter-only
  // edit byte-faithful to the rest of the file (it must only touch the YAML).
  if (!note.parsed.body.endsWith("\n") && newDoc.endsWith("\n")) {
    newDoc = newDoc.slice(0, -1);
  }
  await vault.writeNote(target.relPath, newDoc, { overwrite: true });
  return { path: target.relPath, changed_keys: changed, before, after, dry_run: false };
}

/**
 * Move a note into the archive folder, preserving every backlink.
 *
 * Thin convenience wrapper around {@link renameNote}: computes the
 * destination path (`<archive_folder>/<basename>`, flattened — no source
 * folder is preserved), then delegates. Leading folders of the source are
 * stripped so `Inbox/Foo.md` archives to `Archive/Foo.md`, not
 * `Archive/Inbox/Foo.md`.
 *
 * @param vault - The vault. Must allow writes.
 * @param args - {@link ArchiveNoteArgs}. `path` is required.
 * @returns The same shape as {@link renameNote}.
 * @throws {Error} If `path` is missing, the vault is read-only, or
 *   rename fails (e.g., destination exists without `overwrite`).
 * @example
 * ```ts
 * await archiveNote(vault, {
 *   path: "Inbox/old-idea.md",
 *   archive_folder: "Archive/2026"
 * });
 * ```
 */
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

/**
 * Arguments for {@link replaceInNotes}.
 *
 * Literal substring find/replace — no regex, no globs. The agent is
 * responsible for picking unambiguous needles. `search === replace` is
 * rejected as a no-op.
 */
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

/**
 * Per-file count emitted by {@link replaceInNotes}.
 */
export interface ReplaceInNotesFileResult {
  /** Vault-relative path. */
  path: string;
  /** Number of literal replacements applied in this file. */
  occurrences: number;
}

/**
 * Envelope returned by {@link replaceInNotes}.
 *
 * `partial: true` signals that some writes failed mid-apply — check `errors`
 * for the per-file reasons. Always false on dry-run.
 */
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

/**
 * Bulk literal-substring find/replace across the vault, code-fence aware.
 *
 * Walks every note (optionally scoped to `folder`), replaces every
 * occurrence of `search` with `replace` outside fenced code blocks (` ``` `
 * and `~~~`), and writes results. The fence-awareness is critical — bulk
 * find/replace that touches example snippets in documentation has been a
 * historical foot-gun. Per-file write errors are collected (not thrown) so
 * a single bad write doesn't lose the rest of the apply; check `partial`
 * and `errors` in the response. WRITE TOOL — only registered with
 * `--enable-write`.
 *
 * @param vault - The vault. Must allow writes (for non-dry-run apply).
 * @param args - {@link ReplaceInNotesArgs}. `search` must be non-empty
 *   and not equal to `replace`.
 * @returns A {@link ReplaceInNotesResult} with per-file counts, totals,
 *   and partial-write observability.
 * @throws {Error} On invalid args (empty `search`, `search === replace`),
 *   privacy-excluded folder, or a systemic write failure (read-only vault).
 * @example
 * ```ts
 * // Preview a typo fix
 * const preview = await replaceInNotes(vault, {
 *   search: "embedings",
 *   replace: "embeddings",
 *   dry_run: true,
 *   case_sensitive: false
 * });
 * console.log(`Would update ${preview.files_updated.length} files`);
 *
 * // Apply
 * await replaceInNotes(vault, {
 *   search: "embedings",
 *   replace: "embeddings",
 *   case_sensitive: false
 * });
 * ```
 */
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

/**
 * Rewrite a single wikilink's raw inner text after the target file has
 * been renamed.
 *
 * Preserves the suffix (`|alias`, `#section`, `^block`) and respects the
 * user's chosen path-qualification convention — if the original link was
 * bare-basename (`[[Foo]]`), the rewrite stays bare; if it was path-
 * qualified (`[[Folder/Foo]]`), the rewrite uses the new directory.
 *
 * @internal
 * @param raw - Raw inner-bracket text from the parser
 *   (e.g. `"Foo|alias"`, `"Folder/Foo#section"`).
 * @param oldTarget - The resolved target string the parser extracted
 *   (used to detect path-qualification).
 * @param newBasename - New `.md`-stripped basename.
 * @param newDir - New directory (vault-relative, `.`/empty for vault root).
 * @returns The rewritten inner-bracket text.
 * @example
 * ```ts
 * rewriteRawTarget("Foo|alias", "Foo", "Bar", ".");
 * // → "Bar|alias"
 * rewriteRawTarget("Old/Foo#sec", "Old/Foo", "Bar", "New");
 * // → "New/Bar#sec"
 * ```
 */
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

/**
 * Walk file content line-by-line and rewrite wikilink / embed literals
 * outside fenced code blocks.
 *
 * Toggles `inFence` at any line opening or closing a ` ``` ` or `~~~`
 * block; lines inside a fence are passed through verbatim. Outside fences,
 * each entry in `oldRawsToNew` produces a `[[old]]` → `[[new]]` or
 * `![[old]]` → `![[new]]` rewrite (per `kind`). Used by {@link renameNote}.
 *
 * @internal
 * @param content - Full file content.
 * @param oldRawsToNew - Map from old raw inner-bracket text to new raw +
 *   link kind.
 * @returns `{ content, count }` — count is the total number of literal
 *   replacements applied.
 * @example
 * ```ts
 * const map = new Map([["Foo", { kind: "wikilink", newRaw: "Bar" }]]);
 * rewriteOutsideCodeFences("See [[Foo]]\n```\n[[Foo]]\n```", map);
 * // → { content: "See [[Bar]]\n```\n[[Foo]]\n```", count: 1 }
 * ```
 */
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

/**
 * Generic code-fence-aware substring replacer.
 *
 * Walks line-by-line, tracks ` ``` ` and `~~~` fences, and replaces every
 * occurrence of `search` with `replace` outside fenced blocks. The
 * code-fence skip is the critical correctness property — bulk
 * find/replace on documentation that wipes out example snippets is a
 * historical foot-gun.
 *
 * @internal
 * @param content - Full file content.
 * @param search - Literal substring to find. Empty string returns content
 *   unchanged with `count: 0`.
 * @param replace - Replacement text (may be empty).
 * @param caseSensitive - When false, match is case-insensitive but the
 *   replacement is inserted verbatim from `replace`.
 * @returns `{ content, count }` — rewritten content + replacement count.
 * @example
 * ```ts
 * replaceStringOutsideCodeFences("Hello WORLD\n```\nWORLD\n```", "world", "Earth", false);
 * // → { content: "Hello Earth\n```\nWORLD\n```", count: 1 }
 * ```
 */
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

/**
 * Compose a complete note string from optional frontmatter and a body.
 *
 * Delegates to the shared `stringifyFrontmatter` (backed by js-yaml) so YAML-special
 * strings — date-like (`"2026-05-03"`), `!`-prefixed, pipe-containing, etc.
 * — round-trip safely. Replaces an older hand-rolled renderer that
 * silently corrupted a long tail of valid string values. Empty / missing
 * frontmatter returns `content` verbatim (no leading `---` delimiter).
 *
 * @internal
 * @param frontmatter - YAML to serialize. Omitted or empty for body-only.
 * @param content - Body content (no leading `---` delimiter — `composeNote`
 *   adds them).
 * @returns The full note string ready for `vault.writeNote`.
 * @example
 * ```ts
 * composeNote({ status: "draft" }, "# Title\n\nBody");
 * // → "---\nstatus: draft\n---\n# Title\n\nBody"
 * composeNote(undefined, "Body");
 * // → "Body"
 * ```
 */
export function composeNote(frontmatter: Record<string, unknown> | undefined, content: string): string {
  if (!frontmatter || Object.keys(frontmatter).length === 0) return content;
  // Use `stringifyFrontmatter` (backed by js-yaml) so YAML-special strings —
  // date-like ("2026-05-03"), !-prefixed, pipe-containing, etc. — are
  // round-trip-safe. The hand-rolled renderer this replaced silently corrupted
  // a long tail of valid string values (e.g. "due: 2026-05-03" came back as a
  // Date object on read).
  return stringifyFrontmatter(content, frontmatter);
}

/**
 * Extract tags from a frontmatter map as a lowercased, `#`-stripped array.
 *
 * Accepts both Obsidian-common shapes:
 * - `tags: [foo, bar]` — YAML array
 * - `tags: "foo bar"` / `tags: "foo, bar"` — space- or comma-separated string
 * - `tag: ...` — singular variant (some users prefer this)
 *
 * Returns `[]` when the field is absent or has an unsupported shape.
 *
 * @internal
 * @param fm - Parsed frontmatter map.
 * @returns Lowercased, `#`-stripped tag strings. Original order preserved
 *   for array input; split order for string input.
 * @example
 * ```ts
 * extractFrontmatterTagsLower({ tags: ["#Foo", "BAR"] });
 * // → ["foo", "bar"]
 * extractFrontmatterTagsLower({ tag: "draft, rag" });
 * // → ["draft", "rag"]
 * ```
 */
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

/**
 * Resolve a periodic-note alias to its corresponding date-format basename.
 *
 * Accepts `"daily"` / `"today"` (→ `YYYY-MM-DD`), `"weekly"` (→ `YYYY-Www`,
 * ISO 8601 week number, Monday-based), or `"monthly"` (→ `YYYY-MM`). All
 * other inputs return `null`. The format strings match Obsidian's default
 * Daily-Notes / Periodic-Notes plugin conventions; custom formats are
 * out-of-scope — users with non-default conventions should address notes by
 * exact name. Used as a last-resort fallback in {@link resolveTarget} after
 * the plugin-config-aware resolver misses.
 *
 * @internal
 * @param title - Possible alias string (case-insensitive).
 * @returns The basename (no `.md` extension), or `null` if `title` isn't
 *   one of the supported aliases.
 * @example
 * ```ts
 * resolvePeriodicAlias("today");
 * // → "2026-05-15" (on 2026-05-15)
 * resolvePeriodicAlias("weekly");
 * // → "2026-W20"
 * resolvePeriodicAlias("monthly");
 * // → "2026-05"
 * ```
 */
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

/**
 * Suggest up to 3 vault-relative paths whose basename or path looks similar
 * to a missing target — used to enrich "note not found" errors.
 *
 * Helpful for LLMs that mistype a note name (e.g. `"Hybrid Reterival"` →
 * suggests `"Hybrid Retrieval"`). Tiered scoring: exact match (100), prefix
 * overlap (70), substring containment (50), relpath containment (30).
 * Failures are swallowed — the suggestion path must never surface its own
 * errors to the caller.
 *
 * @internal
 * @param vault - The vault.
 * @param target - The missed target string (with or without `.md`).
 * @param entries - v3.10.0-rc.67 (round-3 re-sweep, DoS) — OPTIONAL pre-fetched
 *   `listMarkdown()` result. When a caller already holds the vault listing (e.g.
 *   `validateNoteProposal`, which scans many wikilinks in one request), pass it
 *   so this helper does NOT re-walk the whole vault PER broken link — a fresh
 *   `listMarkdown()` per call is an O(broken-links × vault-size) filesystem-walk
 *   amplifier on the single event loop (a serve-http DoS via the always-on,
 *   bearer-reachable tool). Omitted → fetches once (the standalone contract).
 * @returns Up to 3 vault-relative paths, sorted by similarity score desc.
 *   Empty array on any error or no candidates.
 * @example
 * ```ts
 * const hints = await suggestSimilar(vault, "Hybrid Reterival");
 * // → ["Concepts/Hybrid Retrieval.md", "Reference/Retrieval.md"]
 * ```
 */
export async function suggestSimilar(vault: Vault, target: string, entries?: FileEntry[]): Promise<string[]> {
  try {
    const all = entries ?? (await vault.listMarkdown());
    const lower = foldName(target.replace(/\.md$/i, ""));
    const ranked = all
      .map((e) => {
        const baseLower = foldName(stripMd(e.basename));
        const relLower = foldName(e.relPath);
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

/**
 * Resolve a note target by either `path` or `title`, with periodic-alias and
 * fuzzy-suggestion fallbacks.
 *
 * The universal target-resolver used by every read/write tool. Resolution
 * order:
 * 1. If `path` is set → try exact path (with `.md` appended if missing).
 * 2. If `title` is set → try literal title match.
 * 3. If `title` is one of the periodic aliases (`daily` / `today` / `weekly` /
 *    `monthly`) → respect the user's Daily-Notes / Periodic-Notes plugin
 *    config first; fall back to default formats only if the plugin folder is
 *    at vault root (privacy-safe).
 * 4. On miss → throw with did-you-mean suggestions via `suggestSimilar`.
 *
 * @param vault - The vault.
 * @param args - Exactly one of `path` or `title` should be provided. If
 *   both are set, `path` takes precedence.
 * @returns A `FileEntry` pointing at the resolved file on disk.
 * @throws {Error} If neither is set, or no note matches (with did-you-mean
 *   hints in the message).
 * @throws {VaultPathError} If `path` traverses outside the vault.
 * @example
 * ```ts
 * // By path
 * const e1 = await resolveTarget(vault, { path: "Posts/Article.md" });
 *
 * // By title (basename match)
 * const e2 = await resolveTarget(vault, { title: "Article" });
 *
 * // By periodic alias — respects user's Daily-Notes config
 * const e3 = await resolveTarget(vault, { title: "today" });
 * ```
 */
/**
 * v3.7.16 P2-13 — `opts.strictOnAmbiguousTitle` controls whether
 * title-based lookup throws when multiple notes share the basename.
 * Write callers pass `true` (silent data corruption is unacceptable);
 * read callers default `false` (single best-effort match is fine).
 */
export async function resolveTarget(
  vault: Vault,
  args: { path?: string; title?: string },
  opts: { strictOnAmbiguousTitle?: boolean } = {}
): Promise<FileEntry> {
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
    // v3.7.16 P2-13 — fail loud on ambiguity FOR WRITE CALLERS ONLY.
    // Pre-3.7.16 `findByTitle` returned the first walk-order match,
    // so write operations against (e.g.) "Daily" silently mutated
    // whichever of `Work/Daily.md` / `Personal/Daily.md` came first.
    // Read callers (`read_note`, `get_outbound_links`, etc.) keep the
    // permissive behavior because they don't mutate — returning a
    // single best-effort match is what users expect for read APIs.
    // Write callers pass `opts.strictOnAmbiguousTitle: true`.
    if (opts.strictOnAmbiguousTitle === true) {
      const literalAll = await vault.findAllByTitle(args.title);
      if (literalAll.length > 1) {
        const candidates = literalAll
          .slice(0, 8)
          .map((e) => e.relPath)
          .join(", ");
        throw new Error(
          `Ambiguous title "${args.title}" — ${literalAll.length} notes share that basename: ${candidates}. ` +
            `Pass an explicit \`path\` argument instead (e.g. \`path: "${literalAll[0]?.relPath ?? "..."}"\` for the first match).`
        );
      }
      const literal = literalAll[0] ?? null;
      if (literal) return literal;
    } else {
      const literal = await vault.findByTitle(args.title);
      if (literal) return literal;
    }
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
