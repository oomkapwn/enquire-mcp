// Canonical note-STRUCTURE accessors — v3.11.6-rc.2.
//
// The fence/parser-desync class (~6 RCs) had one root cause the meta-audit named: src/parser.ts
// exposed only {frontmatter, body, wikilinks, embeds, tags} — NO canonical line-structure accessor.
// So every tool that must walk lines fence-aware (write ×2 rewriters, read heading map, meta
// open-questions, fts5 breadcrumb) HAND-ROLLED the identical loop:
//     const lines = splitLines(body); let marker = null;
//     for (…) { const st = advanceFence(line, marker); marker = st.marker;
//               if (st.delimiter || marker !== null) …; else if (heading) … }
// copied 5× — and stripCodeAndInline used a DIFFERENT mechanism (paired non-greedy regexes), which
// is why they could diverge. This module is the single line-structure authority: ONE fence walk
// (via fence.ts advanceFence) + ONE heading parse (the CRLF/ReDoS-safe helpers), consumed by all.
//
// EXPOSED AS FREE FUNCTIONS over text / ParsedNote — never as methods/getters on ParsedNote. That
// is load-bearing, not stylistic: the disk cache JSON.stringify's `cached.parsed` and JSON.parse's
// it back as a PLAIN object (vault.ts), so a method/getter would be lost on reload and a new
// enumerable field would inflate every cached row + force a DISK_CACHE_VERSION bump that
// invalidates every user's persisted cache. Free functions keep ParsedNote's 6 fields
// byte-identical → zero cache impact, no version bump.
import { advanceFence, type FenceChar } from "./fence.js";
import type { ParsedNote } from "./parser.js";
import { splitLinesWithEnds, stripTrailingHashes, stripTrailingLineEnds } from "./wildcard-match.js";

/** The ATX-heading shape shared by read.ts / meta.ts / fts5.ts (a single anchored capture — NOT
 *  the combined `(.+?)\s*#*\s*$` form, which is the CodeQL js/polynomial-redos class the walkers
 *  split out; text is trimmed of trailing ATX-close `#` via the linear `stripTrailingHashes`). */
const HEADING_RE = /^(#{1,6})\s+(.+)$/;

/** One line of a note, fence-classified, with its heading + breadcrumb context. */
export interface StructLine {
  /** The line text, terminator-stripped (identical to `splitLines(text)[index]`). */
  text: string;
  /** The exact terminator that followed this line (`""` for the last line) — for byte-faithful write-back. */
  end: string;
  /** 0-based index into the walked string. */
  index: number;
  /** 1-based FILE-absolute line number (= base + index). */
  line: number;
  /** True iff this line is a block-fence DELIMITER or is INSIDE a block fence (i.e. not eligible to be a heading). */
  inFence: boolean;
  /** True iff this line opened/closed a matching block fence. */
  isFenceDelimiter: boolean;
  /**
   * The ATX heading on this line, iff it is OUTSIDE a fence and matches {@link HEADING_RE}. `text`
   * is the stripped heading text and MAY be `""` for a degenerate all-hashes heading (`# ###`) —
   * callers decide: read/meta treat empty text as "not a real heading" (`if (l.heading?.text)`),
   * fts5 pushes it to the breadcrumb stack regardless (its long-standing behavior, preserved here).
   */
  heading?: { level: number; text: string };
  /**
   * The full H1 > H2 > H3 heading stack in scope AT this line (a heading line includes itself),
   * computed with fts5's exact semantics (pushes even a degenerate empty heading). `breadcrumb.at(-1)`
   * is the nearest-heading text; `breadcrumb.join(" > ")` is fts5's per-line breadcrumb.
   */
  breadcrumb: string[];
}

/**
 * Walk `text` line by line, fence-aware, yielding a {@link StructLine} per line. `base` is the
 * 1-based file line number of the FIRST line (body walks pass `bodyStartLine`; content walks pass 1).
 * INTERNAL — callers use {@link iterateBodyLines} / {@link iterateContentLines} so `base` is never a
 * per-call decision (a wrong base silently shifts every line number — the rc.47 range-arithmetic class).
 */
function* iterateLines(text: string, base: number): Generator<StructLine> {
  const { lines, ends } = splitLinesWithEnds(text);
  let marker: FenceChar | null = null;
  const stack: string[] = []; // index = depth-1, value = heading text (fts5-exact)
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i] ?? "";
    const st = advanceFence(t, marker);
    marker = st.marker;
    const inFence = st.delimiter || marker !== null;
    let heading: { level: number; text: string } | undefined;
    if (!inFence) {
      const m = HEADING_RE.exec(stripTrailingLineEnds(t));
      if (m?.[1] && m[2]) {
        const level = m[1].length;
        const htext = stripTrailingHashes(m[2].trim()).trim();
        heading = { level, text: htext };
        // fts5-exact breadcrumb stack: push on any heading-SHAPED line, even if htext === "".
        stack.length = level - 1;
        stack.push(htext);
      }
    }
    yield {
      text: t,
      end: ends[i] ?? "",
      index: i,
      line: base + i,
      inFence,
      isFenceDelimiter: st.delimiter,
      heading,
      breadcrumb: [...stack]
    };
  }
}

/** Fence-aware line iterator over a note BODY (line numbers file-absolute via `parsed.bodyStartLine`). */
export function iterateBodyLines(parsed: ParsedNote): Generator<StructLine> {
  return iterateLines(parsed.body, parsed.bodyStartLine);
}

/** Fence-aware line iterator over full note CONTENT (frontmatter included; line 1 = content line 1). */
export function iterateContentLines(content: string): Generator<StructLine> {
  return iterateLines(content, 1);
}

/**
 * The ATX headings of a note body, file-absolute line numbers, in document order. A degenerate
 * all-hashes heading (`# ###` → empty text) is skipped (byte-identical to read.ts extractHeadings /
 * meta.ts's real-heading check). Headings inside code fences are excluded.
 */
export function noteHeadings(parsed: ParsedNote): Array<{ level: number; text: string; line: number }> {
  const out: Array<{ level: number; text: string; line: number }> = [];
  for (const l of iterateBodyLines(parsed)) {
    if (l.heading?.text) out.push({ level: l.heading.level, text: l.heading.text, line: l.line });
  }
  return out;
}
