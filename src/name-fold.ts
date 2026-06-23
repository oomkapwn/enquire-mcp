/**
 * Canonical case-fold for note/file NAME comparison and name-keyed Maps/Sets.
 *
 * v3.10.0-rc.46 — the NFC name-resolution CLASS fix. rc.43's `foldKey()` (in
 * `tools/meta.ts`) closed ONE instance of this in wikilink/`find_path` resolution;
 * an RCA re-sweep found the same bug live in 13 other name-comparison sites
 * (`communities.ts`, `vault.ts` findByTitle/findAllByTitle, `bases.ts`
 * linksTo/`file.name ==`, `tools/meta.ts` lint_vault_wiki titleSet,
 * `tools/search.ts` title 3-grams, `tools/write.ts` suggestSimilar).
 *
 * The bug: macOS APFS returns filenames decomposed (NFD), while wikilinks /
 * user-typed titles / editors usually produce composed (NFC). `"café"` (NFC,
 * `café`) !== `"café"` (NFD, `café`) even after `.toLowerCase()`,
 * so any name match or name-keyed Map silently fails to resolve accented names
 * on macOS. The fix is to Unicode-normalize to a single canonical form (NFC)
 * BEFORE case-folding, on BOTH sides of every comparison.
 *
 * EVERY name comparison or name-keyed Map/Set MUST route its keys through this
 * (or through `foldKey`, which additionally strips a `.md`/file extension). A
 * new site that lowercases a note name without NFC folding is caught by
 * `tests/name-fold-invariant.test.ts` (the md-strip-then-lowercase signature).
 *
 * Note: this normalizes Unicode form, it does NOT strip diacritics — `"café"`
 * folds to `"café"` (single accented code point), never to `"cafe"`. That is
 * deliberate: we want NFC == NFD, not accent-insensitivity.
 *
 * @param name - a file basename, wikilink target, or title fragment
 * @returns the NFC-normalized, lower-cased key
 * @example
 * foldName("Café.md".replace(/\.md$/i, "")); // "café" (NFC)
 */
export function foldName(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/**
 * NFC-fold + case-fold a TAG for comparison or tag-keyed Maps/Sets. Strips any
 * leading `#`(s) first, then applies {@link foldName}. Tags are a user-authored
 * Unicode identity surface (Obsidian permits Unicode letters in tags), so the
 * SAME canonical-key discipline as note names applies: a `#café` tag stored NFD
 * (macOS) must match an NFC `café` query and dedupe against an NFC frontmatter
 * `tags: [café]`. v3.11.0-rc.9 — the NFC class's tag sibling (the rc.46 name
 * sweep + its invariant covered note names, never the parallel tag surface;
 * confirmed by an external re-audit as L-TAG-1, with ~13 unfolded tag sites).
 *
 * @param tag - a raw tag, with or without leading `#`
 * @returns the `#`-stripped, NFC-normalized, lower-cased comparison key
 */
export function foldTag(tag: string): string {
  return foldName(tag.replace(/^#+/, ""));
}

/**
 * NFC + case fold for a user-authored frontmatter / query VALUE before a
 * case-INSENSITIVE compare (DQL `looseEq` / `contains`, `obsidian_search`
 * `filter_frontmatter`). Semantically identical to {@link foldName} but named for
 * the value surface so intent — and the NFC-class invariant — is explicit, so an
 * NFD-on-disk value matches an NFC query literal. v3.11.0-rc.9 centralizes the
 * rc.8 DQL-local `nfcLower` here so every query surface shares ONE implementation.
 *
 * @param value - a user-authored frontmatter or query-literal string
 * @returns the NFC-normalized, lower-cased value
 */
export function nfcLower(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

/**
 * NFC-normalize a value WITHOUT case-folding, for a case-SENSITIVE compare
 * (Obsidian Bases frontmatter `==` / `contains`, which mirror Bases' own
 * case-sensitive semantics). Canonicalizes Unicode form only — `café`(NFC) ===
 * `café`(NFD) — while still distinguishing `Café` from `café`. v3.11.0-rc.9.
 *
 * @param value - a user-authored frontmatter or query-literal string
 * @returns the NFC-normalized value (original case preserved)
 */
export function nfc(value: string): string {
  return value.normalize("NFC");
}

/**
 * Case/NFC-insensitive frontmatter KEY lookup. Obsidian "properties" / Dataview
 * treat field NAMES case-insensitively, but a raw `frontmatter[key]` / `key in
 * frontmatter` is exact-string by JS semantics — so a filter key `Status` (or an
 * NFC key vs an NFD-on-disk key) silently missed `status`. This folds BOTH sides
 * via {@link nfcLower} at LOOKUP time — NEVER at parse time (folding keys in
 * `parseFrontmatter` would collide a distinct-cased key and corrupt write
 * round-trips). v3.11.0-rc.10 (H1, external audit — the KEY sibling of the rc.9
 * VALUE fold).
 *
 * Precedence: an EXACT own-key wins (preserves byte-exact semantics when the key
 * is present verbatim); otherwise the FIRST own key (insertion order) whose fold
 * matches wins (deterministic on a `Status`+`status` collision).
 *
 * @param obj - a frontmatter object (own enumerable string keys)
 * @param key - the user/agent-supplied filter key
 * @returns `{ present, value }` — `present:false`, `value:undefined` if no own key folds to `key`.
 */
export function lookupFoldedKey(obj: Record<string, unknown>, key: string): { present: boolean; value: unknown } {
  if (Object.hasOwn(obj, key)) return { present: true, value: obj[key] };
  const want = nfcLower(key);
  for (const k of Object.keys(obj)) {
    if (nfcLower(k) === want) return { present: true, value: obj[k] };
  }
  return { present: false, value: undefined };
}

/**
 * Folded lookup across an ORDERED list of candidate frontmatter keys: returns the first
 * candidate present with a non-nullish value (case/NFC-insensitive via {@link lookupFoldedKey}),
 * else `undefined`. Preserves `a ?? b`-style precedence while folding the key — so a
 * producer reading `fm.tags ?? fm.tag` (or `fm.title`) no longer goes blind to a case/NFC
 * -variant property name (`Tags:`, `Title:`, an NFD-on-disk key).
 *
 * v3.11.0-rc.13 (rc.12-audit AUD-03 + the embed-title sibling) — closes the PRODUCER side
 * of the rc.10/rc.12 H1 frontmatter-key-fold class: rc.10/rc.12 folded the *consumer*
 * (query) reads, but the tag/title *producers* (parser/bases/meta/write/embed-pipeline)
 * still read the key raw, so `Tags: [x]` was invisible to tag search / DQL / Bases.
 *
 * @param obj - a frontmatter object
 * @param keys - candidate key names in precedence order (e.g. `["tags", "tag"]`)
 * @returns the first present non-nullish folded value, or `undefined`
 */
export function lookupFoldedAny(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const hit = lookupFoldedKey(obj, k);
    if (hit.present && hit.value != null) return hit.value;
  }
  return undefined;
}
