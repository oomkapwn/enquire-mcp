import { stripTrailingRun } from "./wildcard-match.js";

const RESTRICTED_VAULT_SEGMENTS = new Set([".git", ".obsidian", ".trash", ".ds_store", "node_modules", "thumbs.db"]);
const isWindowsIgnoredSuffix = (code: number): boolean => code === 0x2e || code === 0x20;

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
 * those suffixes even on non-Windows CI; mixed separators are normalized for
 * the same reason. Ordinary dotted names such as `Project.v2/notes.md` remain
 * visible.
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
  const segments = relPath.replace(/\\/g, "/").split("/");
  for (const rawSegment of segments) {
    if (rawSegment.length === 0 || rawSegment === ".") continue;
    const windowsCanonical = stripTrailingRun(rawSegment, isWindowsIgnoredSuffix);
    if (rawSegment.startsWith(".") || RESTRICTED_VAULT_SEGMENTS.has(windowsCanonical.toLowerCase())) {
      return "hidden or reserved vault path";
    }
  }
  return null;
}
