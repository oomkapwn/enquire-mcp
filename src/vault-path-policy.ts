import path from "node:path";
import { stripTrailingRun } from "./wildcard-match.js";

const RESTRICTED_VAULT_SEGMENTS = new Set([".git", ".obsidian", ".trash", ".ds_store", "node_modules", "thumbs.db"]);
const isWindowsIgnoredSuffix = (code: number): boolean => code === 0x2e || code === 0x20;

/**
 * F02 — normalize a path into this project's slash-separated vault-relative
 * form, but only where `\` actually is a separator.
 *
 * On Windows `path.sep` is `\`, so backslashes become `/`. On POSIX a
 * backslash is a legal filename character, and replacing it splits ONE file
 * into TWO identities: `a\b.md` became `a/b.md`, so the note was admitted
 * under a path that names a directory rather than the file, and every
 * `obsidian://note/...` URI built from that identity addressed something else —
 * usually nothing. The platform guard already existed inside `vaultRelative`;
 * the defect was unconditional `.replace(/\\/g, "/")` at its callers, which
 * undid it.
 *
 * @param p - A path in platform-native or POSIX form.
 * @returns The slash-separated path on Windows; the path unchanged elsewhere.
 * @example
 * ```ts
 * toVaultSlashPath("Notes\\a.md"); // Windows => "Notes/a.md", POSIX => "Notes\\a.md"
 * ```
 */
export function toVaultSlashPath(p: string): string {
  return path.sep === "\\" ? p.replaceAll("\\", "/") : p;
}

/**
 * Stable reason returned when a path is outside the public vault surface.
 *
 * @example
 * ```ts
 * const reason: RestrictedVaultPathReason = "hidden or reserved vault path";
 * ```
 */
export type RestrictedVaultPathReason = "hidden or reserved vault path";

/**
 * Classify vault-relative paths that are never part of the public MCP surface.
 *
 * Any dot-prefixed segment is hidden, while Obsidian/Git metadata, trash,
 * dependency directories and OS metadata are reserved at every depth. Windows
 * strips trailing dots/spaces from path components, so the comparison folds
 * those suffixes even on non-Windows CI. Ordinary dotted names such as
 * `Project.v2/notes.md` remain visible.
 *
 * Segments come from `toVaultSlashPath`, so a POSIX filename that literally
 * contains a backslash stays ONE segment. Splitting it would make
 * `.git\config.md` — an ordinary public file — look like the reserved `.git`
 * directory, and `a\b.md` look like a path inside a directory named `a`.
 *
 * @param relPath - A vault-relative path in platform-native or POSIX form.
 * @returns A stable exclusion reason, or `null` when the path is public.
 * @example
 * ```ts
 * restrictedVaultPathReason("Projects/.private/note.md");
 * // => "hidden or reserved vault path"
 * ```
 */
export function restrictedVaultPathReason(relPath: string): RestrictedVaultPathReason | null {
  const segments = toVaultSlashPath(relPath).split("/");
  for (const rawSegment of segments) {
    if (rawSegment.length === 0 || rawSegment === ".") continue;
    const windowsCanonical = stripTrailingRun(rawSegment, isWindowsIgnoredSuffix);
    if (rawSegment.startsWith(".") || RESTRICTED_VAULT_SEGMENTS.has(windowsCanonical.toLowerCase())) {
      return "hidden or reserved vault path";
    }
  }
  return null;
}
