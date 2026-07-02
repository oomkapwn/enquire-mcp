// Shared block-code-fence delimiter detection, used by every line-by-line `inFence`
// walker in the codebase (write.ts backlink/replace rewriters, read.ts heading map,
// fts5.ts breadcrumb enrichment). Extracted to one leaf so a fix lands everywhere and
// no walker can drift back to a naive `/^\s*(```|~~~)/` toggle (enforced by
// tests/fence-toggle-invariant.test.ts).
//
// v3.11.5-rc.2 (post-rc.1 re-sweep) — rc.1 fixed the WRITE-FENCE-TOGGLE-INLINE-SPAN MED
// in write.ts but left two read-path siblings live: readNote(format:"map") dropped every
// heading after a line-leading inline span, and fts5 breadcrumb attribution was frozen.
// Same class, so the fix is a shared primitive + an inventory invariant, not three edits.

/**
 * Is `line` a BLOCK code-fence delimiter (open or close) that should toggle an
 * `inFence` state machine? A line whose leading `` ``` `` / `~~~` run is CLOSED by
 * another run of the SAME fence char ON THE SAME LINE is a self-contained INLINE span
 * (e.g. `` ```code``` text ``) — NOT a block fence — so it must NOT toggle. This mirrors
 * how the parser's `stripCodeAndInline` consumes an inline span as one unit, keeping every
 * line walker in agreement with the parser.
 *
 * Leading whitespace is allowed (CommonMark permits up to 3 spaces of indent). Returns
 * `false` for a plain line, an inline code span (`` `x` ``), or a bare non-fence line.
 *
 * @example
 * opensBlockFence("```");                 // true  (bare open/close)
 * opensBlockFence("```js");               // true  (info-string open)
 * opensBlockFence("   ~~~");              // true  (indented fence)
 * opensBlockFence("```inline``` text");   // false (self-contained inline span)
 * opensBlockFence("plain text");          // false
 */
export function opensBlockFence(line: string): boolean {
  return blockFenceDelimiter(line) !== null;
}

/** The fence character (`` ` `` or `~`) if `line` is a BLOCK code-fence delimiter, else null.
 *  A leading run closed by another same-char run on the SAME line is an inline span → null. */
export type FenceChar = "`" | "~";
export function blockFenceDelimiter(line: string): FenceChar | null {
  const m = /^\s*(`{3,}|~{3,})/.exec(line);
  if (!m?.[1]) return null;
  const ch: FenceChar = m[1][0] === "~" ? "~" : "`";
  const rest = line.slice(m.index + m[0].length);
  // A later run of the SAME fence char on this line closes it inline → an inline span.
  return rest.includes(ch.repeat(3)) ? null : ch;
}

/**
 * Advance a CHAR-AWARE fence state machine by one line. Returns the new open-fence
 * marker (the char that opened the current block, or null when outside) and whether
 * this line is a block-fence DELIMITER (an open, or a CLOSE whose char matches the open).
 *
 * v3.11.5-rc.5 (meta-audit) — the correct pattern to replace the char-BLIND `inFence =
 * !inFence` toggle: a `` ``` `` line inside a `~~~` block (or vice versa) is LITERAL code,
 * NOT a delimiter, so it must not flip the state — matching CommonMark + the parser's
 * `stripCodeAndInline` (which pairs ``` with ``` and ~~~ with ~~~ independently). Only
 * fts5's breadcrumb walker tracked this; write.ts/read.ts/meta.ts used the blind toggle,
 * so a mismatched inner fence corrupted rename/replace edits, the heading map, and
 * open-questions. Callers: `const s = advanceFence(line, marker); marker = s.marker; if
 * (s.delimiter) {…continue…} if (marker !== null) {…in-fence…}`.
 */
export function advanceFence(line: string, marker: FenceChar | null): { marker: FenceChar | null; delimiter: boolean } {
  const d = blockFenceDelimiter(line);
  if (!d) return { marker, delimiter: false };
  if (marker === null) return { marker: d, delimiter: true }; // opens a block
  if (d === marker) return { marker: null, delimiter: true }; // closes it (matching char)
  return { marker, delimiter: false }; // different-char fence inside a block = literal content
}
