// v3.8.0-rc.4 — embed pipeline helpers, extracted from src/server.ts.
//
// `embedSingleNote` (markdown) was introduced in rc.2; `embedSinglePdf`
// (PDF with [page: N] markers) in rc.3. Both lived in server.ts initially
// because that's where the bulk-sync functions (syncEmbedDb /
// syncPdfEmbedDb) called them from. But:
//
//   1. src/server.ts is in the `RESTRICTED_MODULES` list of the Class A
//      invariant in tests/no-internal-imports.test.ts (the "registration
//      boilerplate" rule), so tests couldn't unit-test these helpers
//      directly. They got covered only end-to-end via watcher chokidar
//      tests, which flake at ~25% locally due to debounce timing.
//
//   2. The helpers don't depend on any McpServer / tool-registry /
//      cli wiring — they're pure pipeline functions (vault + embedder
//      → rows). They belong with other infrastructure (vault, fts5,
//      embed-db, embeddings), not with the server boilerplate.
//
// rc.4 splits them out into this dedicated module. server.ts +
// watcher.ts both import from here. tests/embed-pipeline.test.ts gets
// to import them directly (no invariant violation). watcher.ts coverage
// floor goes back up from the rc.3-deferred 69% → ≥71% as a result.
//
// Also re-exports `buildEmbedText` (the breadcrumb + late-chunk-context
// formatter) since both helpers use it. Stays declared in server.ts for
// backward compat — moving its public-API form would touch too many
// other call sites this release.

import * as path from "node:path";
import type { loadEmbedder } from "./embeddings.js";
import { chunkContent } from "./fts5.js";
import { buildEmbedText } from "./server.js";
import type { Vault } from "./vault.js";

/**
 * Per-chunk row shape used by both embedSingleNote + embedSinglePdf.
 * Matches the row shape that EmbedDb.upsertNote accepts.
 */
export interface EmbedRow {
  chunkIndex: number;
  lineStart: number;
  lineEnd: number;
  textPreview: string;
  vector: Float32Array;
}

/**
 * v3.8.0-rc.2 R-7 — embed-vector pipeline for a single markdown note.
 * Extracted from the inner loop of `syncEmbedDb` so both the bulk sync
 * and the runtime watcher can use the same chunking + embedding +
 * upsert path without duplicating logic.
 *
 * Returns null if the note has no body chunks (empty / whitespace-only
 * — caller should `db.deleteNote(relPath)` to drop any stale rows).
 *
 * v3.8.0-rc.4 — moved here from src/server.ts (see file header).
 */
export async function embedSingleNote(
  vault: Vault,
  embedder: Awaited<ReturnType<typeof loadEmbedder>>,
  entry: { relPath: string; absPath: string; mtimeMs: number },
  opts: { lateChunkContext?: number } = {}
): Promise<{ chunks: number; rows: EmbedRow[] } | null> {
  const contextChars = opts.lateChunkContext ?? 0;
  const note = await vault.readNote(entry.absPath, entry.mtimeMs);
  const chunks = chunkContent(note.parsed.body);
  if (chunks.length === 0) return null;
  const docTitle = note.parsed.frontmatter?.title || path.basename(entry.relPath, ".md");
  const embedTexts = chunks.map((_c, i) =>
    buildEmbedText(chunks, i, {
      docTitle: typeof docTitle === "string" ? docTitle : undefined,
      contextChars
    })
  );
  const vectors = await embedder.embed(embedTexts);
  const rows = chunks.map((c, i) => {
    const vector = vectors[i];
    if (!vector) throw new Error(`embedder returned no vector for chunk ${i} of ${entry.relPath}`);
    return {
      chunkIndex: i,
      lineStart: c.lineStart,
      lineEnd: c.lineEnd,
      textPreview: c.text.slice(0, 480),
      vector
    };
  });
  return { chunks: chunks.length, rows };
}

/**
 * v3.8.0-rc.3 R-7 (continuation) — embed-vector pipeline for a single
 * PDF file. Mirrors `embedSingleNote` but reads PDF bytes + extracts
 * text via pdfjs + joins pages with `[page: N]` markers before chunking.
 *
 * Returns null in two cases:
 *   - PDF is image-only (`hasText === false`); caller should
 *     `db.deleteNote(relPath)` to drop stale rows (round-22 H-4 fix).
 *   - PDF body chunks to zero (rare; would indicate all pages empty
 *     even after concatenation).
 *
 * v3.8.0-rc.4 — moved here from src/server.ts (see file header).
 */
export async function embedSinglePdf(
  vault: Vault,
  embedder: Awaited<ReturnType<typeof loadEmbedder>>,
  entry: { relPath: string; absPath: string; mtimeMs: number },
  opts: { lateChunkContext?: number } = {}
): Promise<{ chunks: number; rows: EmbedRow[] } | null> {
  const contextChars = opts.lateChunkContext ?? 0;
  const { extractPdfText } = await import("./pdf.js");
  const buf = await vault.readBinaryFile(entry.absPath);
  const extracted = await extractPdfText(buf);
  if (!extracted.hasText) return null; // image-only scan — caller drops rows
  // Join pages with [page: N] markers so embeddings carry page-citation context.
  const joined = extracted.pages.map((p) => `[page: ${p.pageNumber}]\n${p.text}`).join("\n\n");
  const chunks = chunkContent(joined);
  if (chunks.length === 0) return null;
  const docTitle = path.basename(entry.relPath, ".pdf");
  const embedTexts = chunks.map((_c, i) => buildEmbedText(chunks, i, { docTitle, contextChars }));
  const vectors = await embedder.embed(embedTexts);
  const rows = chunks.map((c, i) => {
    const vector = vectors[i];
    if (!vector) throw new Error(`embedder returned no vector for chunk ${i} of ${entry.relPath}`);
    return {
      chunkIndex: i,
      lineStart: c.lineStart,
      lineEnd: c.lineEnd,
      textPreview: c.text.slice(0, 480),
      vector
    };
  });
  return { chunks: chunks.length, rows };
}
