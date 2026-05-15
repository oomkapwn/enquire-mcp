// v3.7.0 M-2 — positive fixture for AST-based K-1 invariant.
//
// This file mirrors the canonical peek-honor pattern used in production code
// (cli.ts:398/554, server.ts:174/254, doctor.ts:331, search.ts:917). The AST
// analyzer must classify ALL constructor calls below as "guarded" — peek
// result is materially consumed in the constructor args.
//
// THIS FILE IS A TEST FIXTURE — do NOT remove any peek-honor pattern from
// any of the constructors below, that would be a regression of the K-1
// invariant test itself. The negative cases live in `bad-*.ts` siblings.

// Stub imports — fixture doesn't compile-link to actual src/, just exists
// for AST analysis.
declare const peekEmbedDbMeta: (
  file: string
) => Promise<{ model_alias?: string; dim?: string; quantization?: string } | null>;
declare const peekFtsMetaSafe: (file: string) => Promise<{ tokenize_mode?: "unicode61" | "trigram" } | null>;
declare const resolveModel: (alias: string | undefined) => { alias: string; dim: number };
declare class EmbedDb {
  constructor(opts: { file: string; vaultRoot: string; modelAlias: string; dim: number; quantization?: string });
}
declare class FtsIndex {
  constructor(opts: { file: string; vaultRoot: string; tokenize?: "unicode61" | "trigram" });
}

// Pattern A — direct peek result threaded through `resolveModel` (search.ts:917 / server.ts:254).
async function directPeekHonor(embedFile: string, vaultRoot: string): Promise<void> {
  const existingMeta = await peekEmbedDbMeta(embedFile);
  const model = resolveModel(existingMeta?.model_alias);
  const db = new EmbedDb({
    file: embedFile,
    vaultRoot,
    modelAlias: model.alias, // ← traces back to existingMeta via resolveModel
    dim: model.dim
  });
  void db;
}

// Pattern B — explicit-flag vs peek choice (cli.ts:398 build-embeddings).
async function conditionalPeekHonor(
  embedFile: string,
  vaultRoot: string,
  explicitFlag: boolean,
  userAlias: string | undefined
): Promise<void> {
  const peeked = await peekEmbedDbMeta(embedFile);
  const requestedModel = resolveModel(userAlias);
  let model = requestedModel;
  if (!explicitFlag && peeked?.model_alias) {
    model = resolveModel(peeked.model_alias);
  }
  const db = new EmbedDb({
    file: embedFile,
    vaultRoot,
    modelAlias: model.alias, // ← model can be peek-derived via the if-branch
    dim: model.dim
  });
  void db;
}

// Pattern C — FtsIndex tokenize peek (server.ts:174 / cli.ts:638 eval).
async function ftsPeekHonor(indexFile: string, vaultRoot: string): Promise<void> {
  const peeked = await peekFtsMetaSafe(indexFile);
  const tokenize = peeked?.tokenize_mode ?? "unicode61";
  const idx = new FtsIndex({
    file: indexFile,
    vaultRoot,
    tokenize // ← shorthand, refers to peek-derived const
  });
  void idx;
}

// Pattern D — SAFE BY DESIGN escape hatch (cli.ts:269 clear-index).
// No peek, but explicit comment marks why bootstrapSchema can't fire.
function clearOnDiskOnly(indexFile: string, vaultRoot: string): void {
  // SAFE BY DESIGN (v3.7.0 M-2 fixture): never calls .open() in this path,
  // so bootstrapSchema cannot fire. Used only for clearOnDisk().
  const idx = new FtsIndex({
    file: indexFile,
    vaultRoot
  });
  void idx;
}
