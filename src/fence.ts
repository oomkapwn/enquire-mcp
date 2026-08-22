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
 * Is `line` a valid BLOCK code-fence opener when the parser is currently
 * outside a fence? Backtick info strings may not contain another backtick, so
 * a line-leading self-contained span such as `` ```code``` text `` is not an
 * opener. Closing admission is stateful and handled by {@link advanceFence}.
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

/** Fence marker character. */
export type FenceChar = "`" | "~";

/** Exact opening marker required to recognize its matching close. */
export interface FenceState {
  char: FenceChar;
  runLength: number;
}

function leadingFenceRun(line: string): { char: FenceChar; runLength: number; rest: string } | null {
  let offset = 0;
  while (offset < line.length && offset < 3 && line.charCodeAt(offset) === 32) offset += 1;
  // CommonMark permits at most three literal spaces here. A tab or fourth
  // leading space is indented code/text, not a fenced-code delimiter.
  const first = line[offset];
  if (first !== "`" && first !== "~") return null;
  let end = offset;
  while (line[end] === first) end += 1;
  const runLength = end - offset;
  if (runLength < 3) return null;
  return { char: first, runLength, rest: line.slice(end) };
}

/** Parse a valid fenced-code opener. Backtick info strings cannot contain a backtick. */
export function blockFenceDelimiter(line: string): FenceState | null {
  const run = leadingFenceRun(line);
  if (!run) return null;
  if (run.char === "`" && run.rest.includes("`")) return null;
  return { char: run.char, runLength: run.runLength };
}

function closesFence(line: string, marker: FenceState): boolean {
  const run = leadingFenceRun(line);
  if (!run || run.char !== marker.char || run.runLength < marker.runLength) return false;
  for (let i = 0; i < run.rest.length; i += 1) {
    const code = run.rest.charCodeAt(i);
    if (code !== 32 && code !== 9) return false;
  }
  return true;
}

/**
 * Advance a char-and-run-length-aware fence state machine by one line. Returns
 * the exact open marker (or null when outside) and whether this line is a valid
 * opener/closer. A close must use the same character, a run at least as long as
 * the opener, and no trailing text beyond spaces/tabs.
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
export function advanceFence(
  line: string,
  marker: FenceState | null
): { marker: FenceState | null; delimiter: boolean } {
  if (marker !== null) {
    return closesFence(line, marker) ? { marker: null, delimiter: true } : { marker, delimiter: false };
  }
  const opener = blockFenceDelimiter(line);
  return opener ? { marker: opener, delimiter: true } : { marker: null, delimiter: false };
}
