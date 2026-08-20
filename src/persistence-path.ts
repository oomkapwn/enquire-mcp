import { windowsRelativePathProblem } from "./windows-path.js";

function assertExactSuffix(file: unknown, suffix: string, label: string): asserts file is string {
  if (typeof file !== "string" || file.length === 0 || !file.endsWith(suffix)) {
    throw new TypeError(`${label} must end exactly in '${suffix}'`);
  }
  assertPortableWindowsPersistencePath(file, label);
}

function assertPortableWindowsPersistencePath(file: string, label: string): void {
  if (process.platform !== "win32") return;
  if (/^[\\/]{2}[?.][\\/]/u.test(file) || /^[a-z]:(?:[^\\/]|$)/iu.test(file)) {
    throw new TypeError(`${label} must not use a Windows device namespace or drive-relative path`);
  }
  const driveColon = /^[a-z]:[\\/]/iu.test(file) ? 1 : -1;
  if ([...file].some((character, index) => character === ":" && index !== driveColon)) {
    throw new TypeError(`${label} must not use a Windows alternate data stream`);
  }
  const normalized = file.replace(/\//gu, "\\");
  const withoutDrive = driveColon === 1 ? normalized.slice(2) : normalized;
  const rootPrefixLength =
    driveColon === 1 ? 1 : withoutDrive.startsWith("\\\\") ? 2 : withoutDrive.startsWith("\\") ? 1 : 0;
  const components = withoutDrive.slice(rootPrefixLength).split("\\");
  for (const component of components) {
    if (component === "." || component === "..") continue;
    if (/[ .](?![\s\S])/u.test(component)) {
      throw new TypeError(`${label} must not use a Windows trailing-dot or trailing-space path component`);
    }
    const deviceStem = (component.split(".")[0] ?? "").replace(/[ .]+(?![\s\S])/u, "");
    if (/^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?![\s\S])/iu.test(deviceStem)) {
      throw new TypeError(`${label} must not use a reserved Windows device basename`);
    }
  }
  const componentProblem = windowsRelativePathProblem(components.join("\\"));
  if (componentProblem !== null) {
    throw new TypeError(`${label} must use a portable Windows path: ${componentProblem}`);
  }
}

/**
 * Admit one parse-cache main path into its final/legacy-temp/generated-temp
 * namespace. Requiring `.json` while excluding the feedback and HNSW-meta
 * terminal namespaces keeps admitted mains disjoint from deterministic
 * sidecars owned by the other persistence families.
 *
 * @param file - Candidate parse-cache path supplied by configuration.
 * @returns Only after `file` ends exactly in lowercase `.json` and uses a portable Windows path when applicable.
 * @throws {TypeError} If the path is empty, non-string, reserved, or outside the portable namespace.
 * @example
 * assertCacheFilePath("/tmp/vault-cache.json");
 */
export function assertCacheFilePath(file: unknown): asserts file is string {
  assertExactSuffix(file, ".json", "Persistent cache file");
  const folded = file.normalize("NFC").toLowerCase();
  if (folded.endsWith(".feedback.json") || folded.endsWith(".hnsw.meta.json")) {
    throw new TypeError("Persistent cache file must not occupy a reserved feedback or HNSW metadata namespace");
  }
}

/**
 * Admit one embedding-database main path into the SQLite main/WAL/SHM/
 * rollback-journal, watcher-guard, and HNSW-derived namespaces.
 *
 * @param file - Candidate embedding-database path supplied by configuration.
 * @returns Only after `file` ends exactly in lowercase `.embed.db` and uses a portable Windows path when applicable.
 * @throws {TypeError} If the path is empty, non-string, or outside the portable namespace.
 * @example
 * assertEmbedDbFilePath("/tmp/vault.embed.db");
 */
export function assertEmbedDbFilePath(file: unknown): asserts file is string {
  assertExactSuffix(file, ".embed.db", "Embedding index file");
}

/**
 * Remove the admitted `.embed.db` suffix without accepting another spelling.
 *
 * @param file - Path previously admitted by {@link assertEmbedDbFilePath}.
 * @returns The exact path prefix before `.embed.db`.
 * @throws {TypeError} If `file` is outside the exact embedding namespace.
 * @example
 * embedDbFileStem("/tmp/vault.embed.db"); // "/tmp/vault"
 */
export function embedDbFileStem(file: string): string {
  assertEmbedDbFilePath(file);
  return file.slice(0, -".embed.db".length);
}

/**
 * Admit one feedback-store main path into its final/generated-temp namespace.
 *
 * @param file - Candidate feedback-store path supplied by a caller.
 * @returns Only after `file` ends exactly in lowercase `.feedback.json` and
 *   uses a portable Windows path when applicable.
 * @throws {TypeError} If the path is empty, non-string, or outside the portable namespace.
 * @example
 * assertFeedbackFilePath("/tmp/vault.feedback.json");
 */
export function assertFeedbackFilePath(file: unknown): asserts file is string {
  assertExactSuffix(file, ".feedback.json", "Feedback store file");
}

/**
 * Admit one FTS5 main path into its SQLite main/WAL/SHM/rollback-journal namespace.
 *
 * @param file - Candidate FTS5 path supplied by configuration or an API.
 * @returns Only after `file` ends exactly in lowercase `.fts5.db` and uses a portable Windows path when applicable.
 * @throws {TypeError} If the path is empty, non-string, or outside the portable namespace.
 * @example
 * assertFtsIndexFilePath("/tmp/vault.fts5.db");
 */
export function assertFtsIndexFilePath(file: unknown): asserts file is string {
  assertExactSuffix(file, ".fts5.db", "FTS index file");
}

/**
 * Admit one HNSW persistence base into its meta, legacy-bin, immutable-
 * generation, and generated-temp namespaces.
 *
 * @param file - Candidate HNSW persistence base supplied by a caller.
 * @returns Only after `file` ends exactly in lowercase `.hnsw` and uses a portable Windows path when applicable.
 * @throws {TypeError} If the path is empty, non-string, or outside the portable namespace.
 * @example
 * assertHnswFilePath("/tmp/vault.hnsw");
 */
export function assertHnswFilePath(file: unknown): asserts file is string {
  assertExactSuffix(file, ".hnsw", "HNSW persistence base");
}
