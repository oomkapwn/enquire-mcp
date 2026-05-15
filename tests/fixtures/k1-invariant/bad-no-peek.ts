// v3.7.0 M-2 — NEGATIVE fixture: no peek call at all. Both the grep-based
// AND AST-based invariants must FAIL this.
//
// THIS FILE INTENTIONALLY HAS A K-1 BUG — do NOT fix it.

declare class FtsIndex {
  constructor(opts: { file: string; vaultRoot: string; tokenize?: "unicode61" | "trigram" });
}

// BUG: constructor with no peek, no escape-hatch marker, no derived input.
function noPeekAtAll(indexFile: string, vaultRoot: string): void {
  const idx = new FtsIndex({
    file: indexFile,
    vaultRoot,
    tokenize: "unicode61"
  });
  void idx;
}
