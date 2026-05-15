// Tiny synthetic-PDF builder for tests.
//
// Generates a minimal valid PDF 1.4 file with one or more pages, each
// carrying a single text run. Hand-written byte-by-byte to avoid pulling
// in a PDF-writer dependency just for tests.
//
// What's covered:
//   • Catalog → Pages → Page tree (with N kids)
//   • One text-stream object per page (BT … Tj … ET)
//   • Helvetica Type1 font (no embedded font data needed; pdfjs handles it)
//   • Optional doc-level metadata (Title / Author) via the Info dictionary
//   • Correct xref byte offsets (computed as we serialize)
//
// What's NOT covered:
//   • Encryption
//   • Compressed object streams (uncompressed only — keeps the format
//     trivially diff-able when a test fails)
//   • Multi-line layout / fonts other than Helvetica
//
// pdfjs-dist parses these blobs cleanly and exposes the text via
// `page.getTextContent()`.

import { Buffer } from "node:buffer";

interface MakePdfOptions {
  /** One string per page (the rendered text). At least one page required. */
  pages: string[];
  /** Optional document title (Info dict). */
  title?: string;
  /** Optional document author (Info dict). */
  author?: string;
  /** Optional document subject (Info dict). */
  subject?: string;
  /** Optional document keywords (Info dict). */
  keywords?: string;
  /** Optional document creator (Info dict). */
  creator?: string;
  /** Optional document producer (Info dict). */
  producer?: string;
  /** Optional creation date (Info dict — PDF-formatted, e.g. `D:20240101120000Z`). */
  creationDate?: string;
  /** Optional modification date (Info dict — PDF-formatted). */
  modDate?: string;
}

/**
 * Build a minimal valid PDF as a Buffer. Designed for tests — fast, no
 * external deps. Produces one Type1 Helvetica text run per page.
 */
export function makePdf(opts: MakePdfOptions): Buffer {
  const { pages, title, author, subject, keywords, creator, producer, creationDate, modDate } = opts;
  if (pages.length === 0) throw new Error("makePdf: at least one page is required");
  const hasAnyInfo = !!(title || author || subject || keywords || creator || producer || creationDate || modDate);

  // Object IDs (1-indexed by spec):
  //   1 = Catalog
  //   2 = Pages (root of page tree)
  //   3 = shared Font (Helvetica)
  //   4..(3+N) = per-page Page object
  //   (4+N)..(3+2N) = per-page Contents stream
  //   (4+2N) = Info (optional)
  const N = pages.length;
  const catalogId = 1;
  const pagesId = 2;
  const fontId = 3;
  const pageStart = 4;
  const contentsStart = pageStart + N;
  const infoId = hasAnyInfo ? contentsStart + N : 0;

  // Build content streams first so we know their lengths for /Length entries.
  const escapePdfString = (s: string): string => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const contentStreams = pages.map((text) => `BT\n/F1 24 Tf\n100 700 Td\n(${escapePdfString(text)}) Tj\nET\n`);

  // Serialize each object, tracking byte offsets for the xref table.
  const chunks: string[] = [];
  const offsets: number[] = [0]; // offsets[0] = unused (object 0 is the head of the free list)

  let cursor = 0;
  const append = (s: string): void => {
    chunks.push(s);
    cursor += Buffer.byteLength(s, "binary");
  };
  const recordOffset = (objId: number): void => {
    offsets[objId] = cursor;
  };

  append("%PDF-1.4\n");
  // Binary marker per PDF spec — helps tools detect PDF as binary.
  append("%\xE2\xE3\xCF\xD3\n");

  // Object 1: Catalog.
  recordOffset(catalogId);
  append(`${catalogId} 0 obj\n<< /Type /Catalog /Pages ${pagesId} 0 R >>\nendobj\n`);

  // Object 2: Pages tree root.
  recordOffset(pagesId);
  const kidsRefs = Array.from({ length: N }, (_, i) => `${pageStart + i} 0 R`).join(" ");
  append(`${pagesId} 0 obj\n<< /Type /Pages /Kids [ ${kidsRefs} ] /Count ${N} >>\nendobj\n`);

  // Object 3: shared Helvetica font.
  recordOffset(fontId);
  append(
    `${fontId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`
  );

  // Per-page Page objects (4..3+N).
  for (let i = 0; i < N; i++) {
    const id = pageStart + i;
    const contentId = contentsStart + i;
    recordOffset(id);
    append(
      `${id} 0 obj\n<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] ` +
        `/Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>\nendobj\n`
    );
  }

  // Per-page Contents streams (4+N..3+2N).
  for (let i = 0; i < N; i++) {
    const id = contentsStart + i;
    const stream = contentStreams[i] ?? "";
    const length = Buffer.byteLength(stream, "binary");
    recordOffset(id);
    append(`${id} 0 obj\n<< /Length ${length} >>\nstream\n${stream}endstream\nendobj\n`);
  }

  // Info dictionary (optional).
  if (infoId > 0) {
    recordOffset(infoId);
    const parts: string[] = ["<<"];
    if (title) parts.push(`/Title (${escapePdfString(title)})`);
    if (author) parts.push(`/Author (${escapePdfString(author)})`);
    if (subject) parts.push(`/Subject (${escapePdfString(subject)})`);
    if (keywords) parts.push(`/Keywords (${escapePdfString(keywords)})`);
    if (creator) parts.push(`/Creator (${escapePdfString(creator)})`);
    if (producer) parts.push(`/Producer (${escapePdfString(producer)})`);
    if (creationDate) parts.push(`/CreationDate (${escapePdfString(creationDate)})`);
    if (modDate) parts.push(`/ModDate (${escapePdfString(modDate)})`);
    parts.push(">>");
    append(`${infoId} 0 obj\n${parts.join(" ")}\nendobj\n`);
  }

  // xref table.
  const xrefOffset = cursor;
  const totalObjs = (infoId > 0 ? infoId : contentsStart + N - 1) + 1;
  append(`xref\n0 ${totalObjs}\n`);
  append("0000000000 65535 f \n");
  for (let id = 1; id < totalObjs; id++) {
    const off = offsets[id] ?? 0;
    append(`${off.toString().padStart(10, "0")} 00000 n \n`);
  }

  // Trailer.
  const trailerParts = [`/Size ${totalObjs}`, `/Root ${catalogId} 0 R`];
  if (infoId > 0) trailerParts.push(`/Info ${infoId} 0 R`);
  append(`trailer\n<< ${trailerParts.join(" ")} >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return Buffer.from(chunks.join(""), "binary");
}
