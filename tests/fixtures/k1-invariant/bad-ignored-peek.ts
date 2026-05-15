// v3.7.0 M-2 — NEGATIVE fixture: peek call exists but result is NEVER
// consumed in the constructor args. The grep-based invariant (v3.6.4)
// would pass this file because the peek call is present within 40 lines.
// The AST-based invariant (v3.7.0 M-2) must FAIL it because the
// constructor's `modelAlias` is a string literal independent of the peek
// result — that's the K-1 bug class.
//
// THIS FILE INTENTIONALLY HAS A K-1 BUG — do NOT fix it. The test asserts
// that the AST analyzer detects the bug. Fixing the bug here would mask a
// regression of the analyzer itself.

declare const peekEmbedDbMeta: (file: string) => Promise<{ model_alias?: string; dim?: string } | null>;
declare class EmbedDb {
  constructor(opts: { file: string; vaultRoot: string; modelAlias: string; dim: number });
}

// BUG: peek is called but its result is discarded. Constructor uses a
// hardcoded model alias.
async function ignoredPeek(embedFile: string, vaultRoot: string): Promise<void> {
  const _ignored = await peekEmbedDbMeta(embedFile);
  void _ignored; // Touch but don't actually consume in constructor.
  const db = new EmbedDb({
    file: embedFile,
    vaultRoot,
    modelAlias: "hardcoded-multilingual", // ← K-1 BUG: doesn't trace to peek
    dim: 384
  });
  void db;
}
