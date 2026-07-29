// v3.10.0-rc.55 (OPTDEP-MODULE-PATH-LEAK-02) — privacy-safe detail for a failed
// optional-dependency `import()`.
//
// Node's module-resolution error EMBEDS the ABSOLUTE path of the importing file:
//   "Cannot find package 'tesseract.js' imported from /Users/<you>/.../dist/ocr.js"
// Interpolating that `err.message` into a thrown Error leaks the host filesystem
// layout (home dir, install location) to bearer-auth serve-http clients — the
// abs-path-leak class (cf. rc.45 `sanitizeFsError` / rc.49 Vault `*Safe` wrappers
// for vault fs errors; this is the module-resolution sibling, outside the Vault).
//
// The actionable signal is the error CODE (distinguishes "not installed",
// ERR_MODULE_NOT_FOUND, from a binding/ABI load failure), not the path — so we
// surface the code and never the raw message.

/**
 * Import an optional package without coupling TypeScript compilation to that
 * package being installed on the current host.
 *
 * npm may legitimately omit an optional native dependency after its install
 * script fails. Passing the specifier through this runtime-only boundary lets
 * the rest of the package compile and preserves the feature's fail-soft loader.
 *
 * @param specifier - Runtime package or package-subpath specifier.
 * @returns The imported module namespace as an untrusted value for the caller
 *   to narrow before use.
 * @example
 * ```ts
 * const namespace = await importOptionalDependency("hnswlib-node");
 * ```
 */
export async function importOptionalDependency(specifier: string): Promise<unknown> {
  return import(specifier);
}

/**
 * Build a path-free detail suffix for a failed optional-dep `import()` catch.
 * Returns e.g. `error code: ERR_MODULE_NOT_FOUND` (or `error code: unknown`),
 * never the raw `err.message` (which embeds the importing file's absolute path).
 *
 * @param err - The caught error from `await import(...)`.
 * @returns A path-free error-code detail.
 * @example
 * ```ts
 * optionalDepDetail({ code: "ERR_MODULE_NOT_FOUND" }); // "error code: ERR_MODULE_NOT_FOUND"
 * ```
 */
export function optionalDepDetail(err: unknown): string {
  const code =
    err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code != null
      ? String((err as { code: unknown }).code)
      : "unknown";
  return `error code: ${code}`;
}
