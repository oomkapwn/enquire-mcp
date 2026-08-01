function assertExpectedOccurrences(expectedOccurrences: number): void {
  if (!Number.isSafeInteger(expectedOccurrences) || expectedOccurrences < 1) {
    throw new Error("mutation expectedOccurrences must be a positive safe integer");
  }
}

function literalMatchOffsets(source: string, needle: string): number[] {
  if (needle.length === 0) throw new Error("mutation needle must not be empty");
  const offsets: number[] = [];
  let cursor = 0;
  while (true) {
    const offset = source.indexOf(needle, cursor);
    if (offset === -1) return offsets;
    offsets.push(offset);
    cursor = offset + needle.length;
  }
}

function assertExactCount(
  needle: string,
  offsets: readonly number[],
  expectedOccurrences: number,
  occurrenceKind = "occurrence(s)"
): void {
  assertExpectedOccurrences(expectedOccurrences);
  if (offsets.length !== expectedOccurrences) {
    throw new Error(
      `mutation needle ${String(needle)} expected ${expectedOccurrences} ${occurrenceKind}, found ${offsets.length}`
    );
  }
}

function expandLiteralReplacement(source: string, needle: string, replacement: string, offset: number): string {
  let expanded = "";
  for (let index = 0; index < replacement.length; index++) {
    const current = replacement.charAt(index);
    if (current !== "$") {
      expanded += current;
      continue;
    }
    const next = replacement.charAt(index + 1);
    if (next === "$") expanded += "$";
    else if (next === "&") expanded += needle;
    else if (next === "`") expanded += source.slice(0, offset);
    else if (next === "'") expanded += source.slice(offset + needle.length);
    else {
      expanded += "$";
      continue;
    }
    index++;
  }
  return expanded;
}

function replaceAtOffsets(source: string, needle: string, replacement: string, offsets: readonly number[]): string {
  const fragments: string[] = [];
  let cursor = 0;
  for (const offset of offsets) {
    fragments.push(source.slice(cursor, offset));
    fragments.push(expandLiteralReplacement(source, needle, replacement, offset));
    cursor = offset + needle.length;
  }
  fragments.push(source.slice(cursor));
  const mutated = fragments.join("");
  if (mutated === source) throw new Error(`mutation needle ${String(needle)} did not change its source`);
  return mutated;
}

function isAsciiDigitAt(source: string, index: number): boolean {
  const code = source.charCodeAt(index);
  return code >= 48 && code <= 57;
}

/**
 * Replace the first literal source target only after proving its exact live count.
 *
 * @param source - Source text to mutate.
 * @param needle - Non-empty literal target.
 * @param replacement - String replacement with native literal-search substitution-token semantics.
 * @param expectedOccurrences - Required number of non-overlapping targets in the source.
 * @returns The source with only its first target replaced.
 * @example
 * replaceExactly("alpha alpha", "alpha", "omega", 2); // "omega alpha"
 */
export function replaceExactly(source: string, needle: string, replacement: string, expectedOccurrences = 1): string {
  const offsets = literalMatchOffsets(source, needle);
  assertExactCount(needle, offsets, expectedOccurrences);
  const firstOffset = offsets[0];
  if (firstOffset === undefined) throw new Error("mutation exact-count precondition admitted no target");
  return replaceAtOffsets(source, needle, replacement, [firstOffset]);
}

/**
 * Replace every literal source target only after proving its exact live count.
 *
 * @param source - Source text to mutate.
 * @param needle - Non-empty literal target.
 * @param replacement - String replacement with native literal-search substitution-token semantics.
 * @param expectedOccurrences - Required number of non-overlapping targets in the source.
 * @returns The source with every target replaced.
 * @example
 * replaceAllExactly("alpha alpha", "alpha", "omega", 2); // "omega omega"
 */
export function replaceAllExactly(
  source: string,
  needle: string,
  replacement: string,
  expectedOccurrences = 1
): string {
  const offsets = literalMatchOffsets(source, needle);
  assertExactCount(needle, offsets, expectedOccurrences);
  return replaceAtOffsets(source, needle, replacement, offsets);
}

/**
 * Replace every digit-bounded integer token only after proving its exact live count.
 *
 * @param source - Source text to mutate.
 * @param value - Safe integer whose decimal spelling is the target.
 * @param replacement - String replacement with native literal-search substitution-token semantics.
 * @param expectedOccurrences - Required number of digit-bounded targets in the source.
 * @returns The source with every matching integer token replaced.
 * @example
 * replaceIntegerAllExactly("7 1807 7", 7, "8", 2); // "8 1807 8"
 */
export function replaceIntegerAllExactly(
  source: string,
  value: number,
  replacement: string,
  expectedOccurrences: number
): string {
  if (!Number.isSafeInteger(value)) throw new Error("mutation integer value must be a safe integer");
  const needle = String(value);
  const offsets = literalMatchOffsets(source, needle).filter(
    (offset) =>
      (offset === 0 || !isAsciiDigitAt(source, offset - 1)) &&
      (offset + needle.length === source.length || !isAsciiDigitAt(source, offset + needle.length))
  );
  assertExactCount(needle, offsets, expectedOccurrences, "bounded occurrence(s)");
  return replaceAtOffsets(source, needle, replacement, offsets);
}
