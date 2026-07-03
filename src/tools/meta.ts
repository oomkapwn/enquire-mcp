import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { parseFrontmatter } from "../frontmatter.js";
import type { FtsIndex } from "../fts5.js";
import { foldName, foldTag, lookupFoldedAny, lookupFoldedKey } from "../name-fold.js";
import { INLINE_TAG_RE, scanWikilinkInners, stripCodeAndInline } from "../parser.js";
import { iterateBodyLines } from "../structure.js";
import type { FileEntry, Vault } from "../vault.js";
import { stripTrailingLineEnds } from "../wildcard-match.js";
import { capScanEntries } from "./limits.js";
import { getBacklinks, getRecentEdits, listTags } from "./read.js";
import { searchHybrid } from "./search.js";
import { resolveTarget, suggestSimilar } from "./write.js";

// ─── obsidian_validate_note_proposal (v0.12 anti-slop validator) ─────────────
// Closes the #1 user-pain finding: LLM-generated notes arrive structurally
// broken — bad YAML, fake wikilinks, inconsistent tags — and users spend
// minutes reformatting per note. This tool is called BEFORE create/append:
// the LLM proposes a draft, we lint it against the live vault, return
// errors/warnings/suggestions, and the LLM can fix-and-retry without ever
// writing a broken note.

/**
 * Arguments for {@link validateNoteProposal}.
 *
 * Pre-write validator — never mutates disk regardless of `mode`. The mode
 * only controls how the validator reports path collisions.
 */
export interface ValidateProposalArgs {
  /** Vault-relative path the LLM intends to write to (e.g. "Inbox/idea.md"). */
  path: string;
  /** Full proposed markdown content including any frontmatter block. */
  content: string;
  /** "create" (default) → fail if path exists. "overwrite" / "append" → ok if exists. */
  mode?: "create" | "overwrite" | "append";
}

/**
 * Structured validation report returned by {@link validateNoteProposal}.
 *
 * `ok` is true iff `errors` is empty — warnings don't block the agent.
 * `wikilinks[*].suggestions` carry did-you-mean hints for broken links so
 * the LLM can fix-and-retry without writing a broken note.
 */
export interface ValidateProposalResult {
  ok: boolean;
  proposed_path: string;
  mode: "create" | "overwrite" | "append";
  errors: Array<{ kind: string; message: string }>;
  warnings: Array<{ kind: string; message: string; suggestion?: string }>;
  yaml: {
    parsed: boolean;
    error: string | null;
    keys: string[];
    /** v3.11.0-rc.11 (rc.9-audit L4) — true if the frontmatter is valid YAML but NOT
     *  a mapping (a bare scalar / sequence), which `frontmatter_set` refuses (rc.64).
     *  Surfaced so an agent isn't surprised by a later refusal after a green validate. */
    coerced: boolean;
  };
  wikilinks: Array<{
    raw: string;
    target: string;
    status: "resolved" | "broken" | "ambiguous";
    resolved_path: string | null;
    suggestions: string[];
  }>;
  tags: Array<{
    name: string;
    status: "existing" | "new";
  }>;
  collision: {
    kind: "none" | "path-exists" | "title-exists-elsewhere";
    existing_path?: string;
  };
}

/**
 * Pre-write validator — lint an LLM-proposed note against the live vault
 * before writing.
 *
 * The "anti-slop" first call: the LLM proposes a draft, this validator
 * checks YAML / wikilinks / tags / path-collision against the vault, and
 * returns structured `errors[]` + `warnings[]`. The LLM can fix-and-retry
 * via the same call, finally invoking {@link createNote} / {@link appendToNote}
 * only after the validator reports `ok: true`. Read-only — never mutates
 * disk. Always returns a structured result for ANY input, even malformed —
 * path-traversal errors become `kind: "path-traversal"` errors rather than
 * exceptions.
 *
 * v3.7.16 P2-14 — errors[] now includes `path-excluded` when the
 * proposed destination is blocked by `--exclude-glob` / `--read-paths`.
 * Pre-3.7.16 the validator passed structurally-valid proposals into
 * excluded destinations; the actual write would then fail at runtime.
 * Pre-write parity with `writeNote` / `createNote` is the new contract.
 *
 * @param vault - The vault.
 * @param args - {@link ValidateProposalArgs}. `path` + `content` required.
 * @returns A {@link ValidateProposalResult} with `ok`, `errors`, `warnings`,
 *   YAML parse status, per-wikilink resolution, tag classification, and
 *   collision detection. Possible `errors[].kind` values include
 *   `path-traversal`, `path-excluded` (v3.7.16+), `yaml-invalid`,
 *   plus the wikilink / tag / collision categories.
 * @example
 * ```ts
 * const v = await validateNoteProposal(vault, {
 *   path: "Inbox/draft.md",
 *   content: "---\nstatus: draft\n---\n# Title\n\n[[Bar]] is broken.",
 *   mode: "create"
 * });
 * if (!v.ok) {
 *   for (const e of v.errors) console.error(e.kind, e.message);
 * }
 * ```
 */
export async function validateNoteProposal(vault: Vault, args: ValidateProposalArgs): Promise<ValidateProposalResult> {
  await vault.ensureExists();
  const mode = args.mode ?? "create";
  const errors: Array<{ kind: string; message: string }> = [];
  const warnings: Array<{ kind: string; message: string; suggestion?: string }> = [];

  // 1. Path sanity. resolveInside throws on traversal — capture as error,
  //    don't let it propagate as a generic exception (the validator should
  //    return a structured result for ANY input).
  let normalizedPath = args.path.toLowerCase().endsWith(".md") ? args.path : `${args.path}.md`;
  let absPath: string | null = null;
  try {
    absPath = vault.resolveInside(normalizedPath);
    normalizedPath = vault.toRel(absPath);
  } catch (err) {
    errors.push({
      kind: "path-traversal",
      message: err instanceof Error ? err.message : String(err)
    });
  }

  // v3.7.16 P2-14 — privacy-filter check. Pre-3.7.16 the validator only
  // checked structural concerns (traversal, YAML, wikilinks) and gave a
  // green light for proposals into excluded destinations — the actual
  // write would then fail at runtime with "destination is excluded by ...".
  // The pre-write validator is supposed to be the dry-run check before
  // calling createNote/appendToNote, so it should return the privacy
  // verdict too. Adds `path-excluded` error class.
  if (absPath !== null) {
    const exclusion = vault.exclusionReason(normalizedPath);
    if (exclusion !== null) {
      errors.push({
        kind: "path-excluded",
        message: `Destination is excluded by ${exclusion}: ${normalizedPath}`
      });
    }
  }

  // 2. YAML parse via the shared frontmatter module (the same parser used at write time).
  const yamlReport = { parsed: false, error: null as string | null, keys: [] as string[], coerced: false };
  let bodyAfterFm = args.content;
  try {
    const parsed = parseFrontmatter(args.content);
    yamlReport.parsed = true;
    yamlReport.keys = Object.keys(parsed.data ?? {});
    bodyAfterFm = parsed.content;
    // v3.11.0-rc.11 (rc.9-audit L4) — a valid-YAML-but-non-mapping frontmatter (bare
    // scalar / sequence) is coerced to {} here; frontmatter_set will REFUSE it (rc.64).
    // Surface it so an agent that validates green isn't surprised by a later refusal.
    yamlReport.coerced = parsed.coerced === true;
    if (yamlReport.coerced) {
      warnings.push({
        kind: "frontmatter-non-mapping",
        message:
          "Frontmatter is valid YAML but not a key/value mapping (a bare scalar or list); obsidian_frontmatter_set will refuse to edit it.",
        suggestion: "Use a `key: value` mapping block if you intend to set frontmatter fields."
      });
    }
  } catch (err) {
    yamlReport.error = err instanceof Error ? err.message : String(err);
    errors.push({ kind: "yaml-invalid", message: `YAML frontmatter could not be parsed: ${yamlReport.error}` });
  }

  // v3.11.5-rc.3 (post-rc.2 re-sweep, PARSER-DESYNC class) — sanitize (strip fenced +
  // inline code) before scanning for the proposed note's wikilinks + inline tags, matching
  // the canonical parseNote. Pre-rc.3 both scans ran on `bodyAfterFm` (frontmatter-stripped
  // only), so a `[[link]]` / `#tag` whose only occurrence is inside a ``` fence was reported
  // as a real (broken-link / proposed-tag) finding — a false positive vs Obsidian semantics.
  const sanitizedBodyAfterFm = stripCodeAndInline(bodyAfterFm);

  // 3. Wikilink resolution against the live vault.
  const all = await vault.listMarkdown();
  const wikilinks: ValidateProposalResult["wikilinks"] = [];
  // v3.10.0-rc.67 (round-3 re-sweep, DoS) — memoize suggestions per broken target so a body
  // packed with thousands of distinct (or repeated) broken `[[...]]` targets does not re-rank
  // (and, pre-rc.67, re-WALK the whole vault) once per link. Combined with passing the shared
  // `all` listing into suggestSimilar, the per-link cost drops from a fresh filesystem walk to a
  // single cached O(N) in-memory rank, and repeats are O(1). Closes the O(broken-links × vault)
  // serve-http amplifier (the rc.65 readCanvas resource-bound-escape class).
  const suggestionCache = new Map<string, string[]>();
  // v3.11.0-rc.17 (rc.16 re-audit, HIGH ReDoS) — was a BYTE-IDENTICAL hand-copy of
  // parser.ts's O(n²) lazy-quantifier wikilink regex (the rc.10 INLINE_TAG_RE
  // copy-class). Routed through the shared linear scanner; `raw` reconstructs the
  // full `[[…]]` match (the former `m[0]`) faithfully since inner excludes `]`/`\n`.
  for (const innerRaw of scanWikilinkInners(sanitizedBodyAfterFm, false)) {
    const raw = `[[${innerRaw}]]`;
    const inner = innerRaw.trim();
    if (!inner) continue;
    // Strip alias / section / block to get the bare target name.
    const beforePipe = inner.split("|")[0] ?? "";
    const beforeHash = beforePipe.split("#")[0] ?? "";
    const target = beforeHash.split("^")[0]?.trim() ?? "";
    if (!target) continue;
    const match = findBestMatch(all, target, normalizedPath);
    if (match) {
      wikilinks.push({
        raw,
        target,
        status: "resolved",
        resolved_path: match.relPath,
        suggestions: []
      });
    } else {
      let suggestions = suggestionCache.get(target);
      if (suggestions === undefined) {
        suggestions = await suggestSimilar(vault, target, all); // reuse the single listing (rc.67)
        suggestionCache.set(target, suggestions);
      }
      wikilinks.push({
        raw,
        target,
        status: "broken",
        resolved_path: null,
        suggestions
      });
      warnings.push({
        kind: "broken-wikilink",
        message: `[[${target}]] does not resolve to any existing note`,
        suggestion: suggestions.length ? `Closest matches: ${suggestions.join(", ")}` : undefined
      });
    }
  }

  // 4. Tag pre-classification (existing vs new).
  const existingTags = new Set((await listTags(vault, {})).map((t) => foldTag(t.tag)));
  const proposedTagsRaw = new Set<string>();
  // Frontmatter tags.
  const fmData = yamlReport.parsed ? parseFrontmatter(args.content).data : {};
  // v3.11.0-rc.13 (rc.12-audit AUD-03) — fold the `tags`/`tag` KEY (producer sibling of H1).
  const fmTags = lookupFoldedAny(fmData, ["tags", "tag"]);
  if (Array.isArray(fmTags)) {
    for (const t of fmTags) if (typeof t === "string" && t) proposedTagsRaw.add(t.replace(/^#/, ""));
  } else if (typeof fmTags === "string" && fmTags) {
    for (const t of fmTags.split(/[\s,]+/)) if (t) proposedTagsRaw.add(t.replace(/^#/, ""));
  }
  // Inline tags. v3.11.0-rc.10 (M1) — shared INLINE_TAG_RE (was a byte-identical
  // copy of parser's) + NFC-normalize BEFORE matching so an NFD inline tag isn't
  // truncated at its combining mark (parity with extractInlineTags); the
  // existing-vs-new classification below folds both sides via foldTag.
  for (const m of sanitizedBodyAfterFm.normalize("NFC").matchAll(INLINE_TAG_RE)) {
    if (m[1]) proposedTagsRaw.add(m[1]);
  }
  const tags: ValidateProposalResult["tags"] = [];
  for (const t of proposedTagsRaw) {
    const status = existingTags.has(foldTag(t)) ? "existing" : "new";
    tags.push({ name: t, status });
    if (status === "new") {
      warnings.push({
        kind: "new-tag",
        message: `#${t} is new — won't fork an existing tag (case-insensitive check)`
      });
    }
  }

  // 5. Path collision check.
  let collision: ValidateProposalResult["collision"] = { kind: "none" };
  if (absPath) {
    try {
      await vault.stat(absPath);
      // Path exists.
      if (mode === "create") {
        errors.push({
          kind: "path-collision",
          message: `Note already exists at ${normalizedPath} (mode="create" refuses overwrite)`
        });
      }
      collision = { kind: "path-exists", existing_path: normalizedPath };
    } catch {
      // Path doesn't exist — try title collision (an existing note at a different path).
      const titleFromBasename = stripMd(path.basename(normalizedPath));
      const existing = await vault.findByTitle(titleFromBasename);
      if (existing && existing.relPath !== normalizedPath) {
        warnings.push({
          kind: "title-collision",
          message: `A note titled "${titleFromBasename}" already exists at ${existing.relPath} — proceeding will create a same-titled file at a different path`,
          suggestion: existing.relPath
        });
        collision = { kind: "title-exists-elsewhere", existing_path: existing.relPath };
      }
    }
  }

  return {
    ok: errors.length === 0,
    proposed_path: normalizedPath,
    mode,
    errors,
    warnings,
    yaml: yamlReport,
    wikilinks,
    tags,
    collision
  };
}

// ─── obsidian_lint_wiki (v1.5 — Karpathy LLM-Wiki lint workflow) ─────────────
// Karpathy's gist (gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
// names three workflows for an LLM-maintained wiki: ingest, query, lint. We had
// the ingest+query primitives (create_note + search/find_similar/etc.) since
// 0.13. lint completes the trio in one tool call: orphans, broken links, stub
// pages, stale claims, and "concept mentioned in N+ notes but missing its own
// page." Each finding is shaped so the agent can fix it via existing tools
// (validate_note_proposal → create_note / append_to_note / rename_note).

/**
 * Arguments for {@link lintWiki}. All optional with sensible defaults.
 */
export interface LintWikiArgs {
  /** Folder to restrict the lint to (default: whole vault). */
  folder?: string;
  /** Word count below which a note is considered a "stub". Default 100. */
  stub_word_threshold?: number;
  /** A note is "stale" if its frontmatter `last_reviewed` (or mtime if missing)
   *  is older than this many days. Default 365. */
  stale_days?: number;
  /** A capitalised n-gram mentioned by ≥ N distinct notes but not having its
   *  own page is flagged as a concept candidate. Default 3. */
  concept_min_mentions?: number;
  /** Cap on each finding-bucket so the response stays bounded. Default 50. */
  max_per_bucket?: number;
}

/**
 * One lint finding. `details` carries kind-specific context (word count for
 * stubs, mention sources for concepts, etc.). `suggestion` is an action
 * hint the agent can paraphrase to the user.
 */
export interface LintWikiFinding {
  /** Lint category. */
  kind: "orphan" | "broken-link" | "stub" | "stale" | "concept-without-page";
  /** Vault-relative path of the offending note (absent on concept candidates). */
  path?: string;
  /** Human-readable description of the issue. */
  message: string;
  /** Action hint for fixing. */
  suggestion?: string;
  /** Kind-specific payload (word_count, mention_count, sources, etc.). */
  details?: Record<string, unknown>;
}

/**
 * Envelope returned by {@link lintWiki}.
 *
 * `summary` carries truncated counts (capped at `max_per_bucket`); use it
 * for the agent's headline message. `findings` carries the per-issue list.
 */
export interface LintWikiResult {
  scope: string;
  scanned: number;
  generated_at: string;
  summary: {
    orphans: number;
    broken_links: number;
    stubs: number;
    stale: number;
    concept_candidates: number;
  };
  findings: {
    orphans: LintWikiFinding[];
    broken_links: LintWikiFinding[];
    stubs: LintWikiFinding[];
    stale: LintWikiFinding[];
    concept_candidates: LintWikiFinding[];
  };
}

/**
 * Karpathy-style LLM-Wiki lint — single-call audit of orphans, broken
 * links, stubs, stale notes, and concept candidates.
 *
 * Implements the "lint" workflow from Karpathy's LLM-Wiki gist (which named
 * ingest/query/lint as the three primitives). Returns five finding buckets,
 * each capped to `max_per_bucket` for bounded responses. Findings are
 * shaped so the agent can act on them via existing tools
 * ({@link validateNoteProposal} → {@link createNote} / {@link appendToNote} /
 * {@link renameNote}).
 *
 * Concept candidates use a capitalised-phrase heuristic: 1-3 CapitalCase
 * tokens that appear in ≥ `concept_min_mentions` notes but don't have a
 * page of their own. Stop-words ("The", "This", etc.) at phrase start are
 * dropped.
 *
 * @param vault - The vault.
 * @param args - {@link LintWikiArgs}. All optional with documented defaults.
 * @returns A {@link LintWikiResult} with summary counts + per-bucket findings.
 * @throws {VaultPathError} If `folder` resolves outside the vault.
 * @example
 * ```ts
 * const lint = await lintWiki(vault, {
 *   folder: "Wiki",
 *   stub_word_threshold: 50,
 *   stale_days: 180
 * });
 * console.log(`Orphans: ${lint.summary.orphans}, Stubs: ${lint.summary.stubs}`);
 * for (const f of lint.findings.broken_links) console.log(f.message);
 * ```
 */
export async function lintWiki(vault: Vault, args: LintWikiArgs): Promise<LintWikiResult> {
  await vault.ensureExists();
  const stubThreshold = args.stub_word_threshold ?? 100;
  const staleDays = args.stale_days ?? 365;
  const conceptMinMentions = args.concept_min_mentions ?? 3;
  const cap = args.max_per_bucket ?? 50;

  const entries = await vault.listMarkdown(args.folder);
  const allEntries = await vault.listMarkdown();
  const staleMs = Date.now() - staleDays * 24 * 3600 * 1000;

  // Single pass: collect inbound counts, outbound presence, broken links,
  // word counts, last-reviewed times, capitalised-phrase mentions.
  const inbound = new Map<string, number>();
  const outboundPresence = new Set<string>();
  const broken: LintWikiFinding[] = [];
  const stubs: LintWikiFinding[] = [];
  const stale: LintWikiFinding[] = [];
  const titleSet = new Set<string>();
  for (const e of allEntries) titleSet.add(foldName(stripMd(e.basename)));

  // Capitalised-phrase mentions across the whole vault. A phrase is 1-3
  // CapitalCase tokens (e.g. "Reinforcement Learning", "Attention Heads").
  // Stop-words: dropped when they appear at the start of a phrase.
  const conceptStopwords = new Set([
    "The",
    "A",
    "An",
    "This",
    "That",
    "These",
    "Those",
    "If",
    "When",
    "While",
    "But",
    "And",
    "Or"
  ]);
  const capPhraseRe = /\b((?:[A-Z][a-z][a-z]+(?:\s+[A-Z][a-z][a-z]+){0,2}))\b/g;
  const conceptMentions = new Map<string, Set<string>>(); // phrase → set of source paths

  for (const e of entries) {
    const { parsed, mtimeMs } = await vault.readNote(e.absPath, e.mtimeMs);

    // Outbound + broken pass.
    if (parsed.wikilinks.length > 0) outboundPresence.add(e.relPath);
    for (const link of parsed.wikilinks) {
      const m = findBestMatch(allEntries, link.target, e.relPath);
      if (m) {
        inbound.set(m.relPath, (inbound.get(m.relPath) ?? 0) + 1);
      } else if (broken.length < cap) {
        broken.push({
          kind: "broken-link",
          path: e.relPath,
          message: `[[${link.target}]] in ${e.relPath} doesn't resolve`,
          suggestion: "create the missing note, fix the link, or remove it",
          details: { target: link.target, raw: link.raw }
        });
      }
    }

    // Stub pass.
    const wordCount = parsed.body.trim() ? parsed.body.trim().split(/\s+/).length : 0;
    if (wordCount < stubThreshold && stubs.length < cap) {
      stubs.push({
        kind: "stub",
        path: e.relPath,
        message: `${e.relPath} is ${wordCount} words (threshold ${stubThreshold})`,
        suggestion: "develop, merge into a hub, or archive",
        details: { word_count: wordCount, mtime: new Date(mtimeMs).toISOString() }
      });
    }

    // Stale pass — frontmatter `last_reviewed` overrides mtime if present.
    // v3.11.0-rc.12 (rc.11-audit H-2) — read the key through `lookupFoldedKey` so a
    // case/NFC-variant property (`Last_Reviewed`, `LAST_REVIEWED`, an NFD-on-disk
    // accented key) resolves, matching Obsidian's case-insensitive property semantics
    // and the rc.10 H1 key-fold class (this was the 7th, unwired, key-lookup site).
    // Both spellings (`last_reviewed` / `last-reviewed`) are kept — they are distinct
    // keys under the fold (`_` vs `-` is a spelling difference, not case; rc.9 narrowing).
    // js-yaml@5 (rc.6) loads YAML timestamps as strings (not Date); the Date branch
    // below stays as a defensive fallback for a caller that hands us a real Date.
    const fmForReview = parsed.frontmatter ?? {};
    const lastReviewedRaw =
      lookupFoldedKey(fmForReview, "last_reviewed").value ?? lookupFoldedKey(fmForReview, "last-reviewed").value;
    let lastTouchedMs = mtimeMs;
    if (lastReviewedRaw instanceof Date) {
      const t = lastReviewedRaw.getTime();
      if (Number.isFinite(t)) lastTouchedMs = t;
    } else if (typeof lastReviewedRaw === "string") {
      const t = Date.parse(lastReviewedRaw);
      if (Number.isFinite(t)) lastTouchedMs = t;
    } else if (typeof lastReviewedRaw === "number" && Number.isFinite(lastReviewedRaw)) {
      lastTouchedMs = lastReviewedRaw;
    }
    if (lastTouchedMs < staleMs && stale.length < cap) {
      stale.push({
        kind: "stale",
        path: e.relPath,
        message: `${e.relPath} not touched since ${new Date(lastTouchedMs).toISOString().slice(0, 10)}`,
        suggestion: "review for accuracy or archive",
        details: {
          last_touched: new Date(lastTouchedMs).toISOString(),
          source: lastReviewedRaw !== undefined ? "frontmatter.last_reviewed" : "mtime"
        }
      });
    }

    // Concept-mention pass — capitalised phrases in the body that aren't
    // already a wikilink target. Cap at 30 unique phrases per source to
    // bound memory, but loose enough that real concepts in long notes don't
    // get truncated.
    const seenInThisNote = new Set<string>();
    for (const m of parsed.body.matchAll(capPhraseRe)) {
      const phrase = m[1];
      if (!phrase) continue;
      const firstWord = phrase.split(/\s+/)[0];
      if (firstWord !== undefined && conceptStopwords.has(firstWord)) continue;
      if (seenInThisNote.has(phrase)) continue;
      if (seenInThisNote.size >= 30) break;
      // Skip phrases that are already a vault note (basename match).
      if (titleSet.has(foldName(phrase))) continue;
      seenInThisNote.add(phrase);
      const set = conceptMentions.get(phrase) ?? new Set<string>();
      set.add(e.relPath);
      conceptMentions.set(phrase, set);
    }
  }

  // Orphan findings (no inbound AND no outbound).
  const orphans: LintWikiFinding[] = [];
  for (const e of entries) {
    if (orphans.length >= cap) break;
    if (!inbound.get(e.relPath) && !outboundPresence.has(e.relPath)) {
      orphans.push({
        kind: "orphan",
        path: e.relPath,
        message: `${e.relPath} has no inbound or outbound wikilinks`,
        suggestion: "link from a hub note, archive, or delete",
        details: { mtime: new Date(e.mtimeMs).toISOString() }
      });
    }
  }

  // Concept candidates — phrases mentioned by ≥ N distinct notes.
  const conceptCandidates: LintWikiFinding[] = [];
  const ranked = [...conceptMentions.entries()]
    .filter(([, sources]) => sources.size >= conceptMinMentions)
    .sort((a, b) => b[1].size - a[1].size);
  for (const [phrase, sources] of ranked) {
    if (conceptCandidates.length >= cap) break;
    conceptCandidates.push({
      kind: "concept-without-page",
      message: `"${phrase}" is mentioned by ${sources.size} notes but has no page of its own`,
      suggestion: `create a page \`${phrase}.md\` and refile the most-developed mentions into it`,
      details: { phrase, mention_count: sources.size, sources: [...sources].slice(0, 5) }
    });
  }

  return {
    scope: args.folder ?? "(whole vault)",
    scanned: entries.length,
    generated_at: new Date().toISOString(),
    summary: {
      orphans: orphans.length,
      broken_links: broken.length,
      stubs: stubs.length,
      stale: stale.length,
      concept_candidates: conceptCandidates.length
    },
    findings: {
      orphans,
      broken_links: broken,
      stubs,
      stale,
      concept_candidates: conceptCandidates
    }
  };
}

// ─── obsidian_open_questions (v1.5 — surface unresolved threads) ─────────────
// Karpathy and other ML PKM workflows use "Open question:" / "Q:" / "TODO?" /
// "??" lines as deferred-thinking markers. This tool returns every such line
// across the vault with source + context heading + age, sorted oldest-first.

/**
 * One open question / TODO marker surfaced by {@link getOpenQuestions}.
 *
 * `context_heading` is the nearest preceding heading (any level) — useful
 * for context-locating the question without reading the surrounding note.
 * `age_days` is computed from the note's mtime, so it surfaces questions
 * that have aged without being touched.
 */
export interface OpenQuestion {
  /** Trimmed text of the question (capture group of the matcher). */
  question: string;
  /** Vault-relative path of the source note. */
  source_path: string;
  /** `.md`-stripped basename for display. */
  source_title: string;
  /** Nearest preceding heading, or null if at top of file. */
  context_heading: string | null;
  /** 1-based line number where the question appears. */
  line: number;
  /** Rounded days since the source note was last modified. */
  age_days: number;
  /** ISO-8601 mtime of the source note. */
  mtime: string;
}

/**
 * Max length of a caller-supplied `obsidian_open_questions` pattern. A hard
 * cap is the first line of defense (paired with {@link isCatastrophicRegex})
 * against an unbounded user regex compiled into V8's backtracking engine.
 */
export const MAX_QUESTION_PATTERN_LEN = 200;

/**
 * Hard wall-clock budget (ms) for matching a CALLER-SUPPLIED
 * `obsidian_open_questions` pattern against the vault, enforced by running the
 * match on a WORKER THREAD ({@link matchLinesBounded}). {@link isCatastrophicRegex}
 * is a best-effort static denylist (ReDoS detection is undecidable — a v3.10.0-rc.39
 * re-sweep confirmed a residual tail of nested patterns it under-flags); this is
 * the HARD backstop. Because matching runs off the main thread, the event loop can
 * NEVER hang regardless of pattern, and a pattern that blows the budget is rejected
 * fail-closed. Generous enough that a legit linear pattern over a large vault
 * finishes well under it, while a catastrophic-backtracking pattern (effectively
 * unbounded) is killed.
 * @internal v3.10.0-rc.39 — the hard ReDoS sink-bound (closes the static-detector
 *   residual the rc.36 re-sweep surfaced).
 */
export const MAX_QUESTION_SCAN_MS = 5000;

/**
 * Read the regex quantifier (if any) starting at `pos` in `src`. Returns
 * whether it is "unbounded/amplifying" — `*`, `+`, an open-ended `{n,}`, or
 * a brace whose max repetition exceeds {@link REPEAT_AMPLIFY_THRESHOLD} — and
 * how many source chars it spans (so the scanner can skip them). A trailing
 * lazy `?` is folded into the span. Non-quantifier positions return length 0.
 *
 * @internal exported only for unit tests of {@link isCatastrophicRegex}.
 */
const REPEAT_AMPLIFY_THRESHOLD = 10;
export function readUnboundedQuantifier(src: string, pos: number): { unbounded: boolean; length: number } {
  const c = src[pos];
  if (c === "*" || c === "+") {
    const next = src[pos + 1];
    const extra = next === "?" || next === "+" ? 1 : 0; // lazy/possessive marker
    return { unbounded: true, length: 1 + extra };
  }
  if (c === "{") {
    const close = src.indexOf("}", pos);
    if (close === -1) return { unbounded: false, length: 0 }; // literal `{`
    const body = src.slice(pos + 1, close);
    const m = /^(\d*)(,(\d*))?$/.exec(body);
    // Reject non-quantifier braces (e.g. `{}`, `{a}`) — treat as literals.
    if (!m || (m[1] === "" && m[2] === undefined)) return { unbounded: false, length: 0 };
    const lower = m[1] === "" ? 0 : Number(m[1]);
    const hasComma = m[2] !== undefined;
    const upper = m[3];
    const maxRep = !hasComma ? lower : upper === "" || upper === undefined ? Number.POSITIVE_INFINITY : Number(upper);
    const next = src[close + 1];
    const extra = next === "?" || next === "+" ? 1 : 0;
    return { unbounded: maxRep > REPEAT_AMPLIFY_THRESHOLD, length: close - pos + 1 + extra };
  }
  return { unbounded: false, length: 0 };
}

/**
 * Split a regex `body` on its TOP-LEVEL `|` alternations — a `|` inside a
 * nested group `(...)`, a char-class `[...]`, or escaped (`\|`) does not split.
 * @internal helper for {@link isCatastrophicRegex}.
 */
function splitTopLevelAlternation(body: string): string[] {
  const branches: string[] = [];
  let depth = 0;
  let inClass = false;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c === "(") {
      depth++;
      continue;
    }
    if (c === ")") {
      if (depth > 0) depth--;
      continue;
    }
    if (c === "|" && depth === 0) {
      branches.push(body.slice(start, i));
      start = i + 1;
    }
  }
  branches.push(body.slice(start));
  return branches;
}

/**
 * Fold a character for overlap comparison. `obsidian_open_questions` always
 * compiles the pattern case-INSENSITIVELY (`new RegExp(pattern, "i")`), so `a`
 * and `A` match the same input and must compare equal.
 * @internal v3.9.0-rc.24 — rc.21 compared case-sensitively, missing `(a|A)+`.
 */
function foldCase(ch: string): string {
  return ch.toLowerCase();
}

/**
 * Decode a regex escape whose body starts at `src[pos]` (the char AFTER the
 * backslash) to the single character it matches plus the number of source chars
 * the body consumes. `char` is `null` if the escape is not a resolvable
 * single-char escape (caller then treats it as a broad/ANY leading atom — the
 * safe over-flag direction). Handles `\\xHH`, `\\uHHHH`, `\\u{H+}`, the control escapes,
 * and punctuation/metacharacter escapes; leaves octal / backrefs / class
 * shorthands unresolved (`char: null`). `length` is the body length even when
 * `char` is null (1 for a single unknown char) so callers can still advance.
 *
 * Returning `length` makes this the SINGLE source of truth for escape spans:
 * `leadingAtomSet` and `branchIsNullable` both locate the atom end
 * through this function rather than re-parsing (a re-parse would risk diverging —
 * the exact recursion class CLAUDE.md tracks).
 *
 * @internal exported only for unit tests. v3.9.0-rc.24 — rc.21 returned the raw
 * byte after the backslash (`"x"` for `\\x61`), so `(\\x61|a)+` slipped the guard.
 * v3.9.0-rc.25 — also returns `length` (was `string | null`).
 */
export function decodeEscapedChar(src: string, pos: number): { char: string | null; length: number } {
  const e = src[pos];
  if (e === undefined) return { char: null, length: 0 };
  if (e === "x") {
    const h = src.slice(pos + 1, pos + 3);
    return /^[0-9a-fA-F]{2}$/.test(h)
      ? { char: String.fromCharCode(Number.parseInt(h, 16)), length: 3 }
      : { char: null, length: 1 };
  }
  if (e === "u") {
    if (src[pos + 1] === "{") {
      const end = src.indexOf("}", pos + 2);
      const h = end === -1 ? "" : src.slice(pos + 2, end);
      return /^[0-9a-fA-F]{1,6}$/.test(h)
        ? { char: String.fromCodePoint(Number.parseInt(h, 16)), length: end - pos + 1 }
        : { char: null, length: 1 };
    }
    const h = src.slice(pos + 1, pos + 5);
    return /^[0-9a-fA-F]{4}$/.test(h)
      ? { char: String.fromCharCode(Number.parseInt(h, 16)), length: 5 }
      : { char: null, length: 1 };
  }
  if (e === "t") return { char: "\t", length: 1 };
  if (e === "n") return { char: "\n", length: 1 };
  if (e === "r") return { char: "\r", length: 1 };
  if (e === "f") return { char: "\f", length: 1 };
  if (e === "v") return { char: "\v", length: 1 };
  if (e === "0" && !/[0-9]/.test(src[pos + 1] ?? "")) return { char: "\0", length: 1 };
  if (/[.*+?()[\]{}|^$/\\-]/.test(e)) return { char: e, length: 1 };
  return { char: null, length: 1 };
}

/**
 * Read a quantifier at `src[pos]` for nullability analysis. Unlike
 * {@link readUnboundedQuantifier} (which asks "is it amplifying?"), this asks
 * "does it permit ZERO repetitions?" — `?`, `*`, `{0,...}`, `{,...}`, `{0}` allow
 * zero; `+`, `{1,...}`, `{2}` do not. Returns whether a quantifier is present at
 * all, whether it allows zero, and the source span (incl. a trailing lazy/possessive
 * marker) so the caller can advance past it.
 * @internal helper for {@link leadingAtomToken} and {@link branchIsNullable}.
 */
function quantifierMinZero(src: string, pos: number): { isQuantifier: boolean; allowsZero: boolean; length: number } {
  const c = src[pos];
  if (c === "*" || c === "?") {
    const next = src[pos + 1];
    const extra = next === "?" || next === "+" ? 1 : 0;
    return { isQuantifier: true, allowsZero: true, length: 1 + extra };
  }
  if (c === "+") {
    const next = src[pos + 1];
    const extra = next === "?" || next === "+" ? 1 : 0;
    return { isQuantifier: true, allowsZero: false, length: 1 + extra };
  }
  if (c === "{") {
    const close = src.indexOf("}", pos);
    if (close === -1) return { isQuantifier: false, allowsZero: false, length: 0 };
    const body = src.slice(pos + 1, close);
    const m = /^(\d*)(,(\d*))?$/.exec(body);
    if (!m || (m[1] === "" && m[2] === undefined)) return { isQuantifier: false, allowsZero: false, length: 0 };
    const lower = m[1] === "" ? 0 : Number(m[1]);
    const next = src[close + 1];
    const extra = next === "?" || next === "+" ? 1 : 0;
    return { isQuantifier: true, allowsZero: lower === 0, length: close - pos + 1 + extra };
  }
  return { isQuantifier: false, allowsZero: false, length: 0 };
}

/**
 * Index just past the char-class `[...]` that starts at `src[start]` (`[`).
 * Honors an initial `]` (literal as first class member) and `\\]` escapes.
 * @internal helper for {@link branchIsNullable}.
 */
function classEnd(src: string, start: number): number {
  let j = start + 1;
  if (src[j] === "^") j++;
  if (src[j] === "]") j++; // leading `]` is a literal member, not the close
  while (j < src.length && src[j] !== "]") {
    if (src[j] === "\\") j++;
    j++;
  }
  return j + 1; // past the closing `]` (or past end if unterminated)
}

/**
 * Index just past the group `(...)` that starts at `src[start]` (`(`), matching
 * nested groups and skipping `[...]` / escapes.
 * @internal helper for {@link branchIsNullable}.
 */
function groupEnd(src: string, start: number): number {
  let depth = 1;
  let inCls = false;
  let j = start + 1;
  while (j < src.length && depth > 0) {
    const c = src[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (inCls) {
      if (c === "]") inCls = false;
      j++;
      continue;
    }
    if (c === "[") inCls = true;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    j++;
  }
  return j; // past the matching `)` (or end if unterminated)
}

/**
 * True if a single alternation `branch` can match the EMPTY string — every atom
 * is either zero-width (`^`/`$`) or made optional by a min-0 quantifier
 * (`?`/`*`/`{0,...}`), OR is a nested group whose own body is nullable. A nullable
 * body under an unbounded quantifier is the classic `(a?)+` / `(\\s*)*` ReDoS
 * (each repetition can consume nothing → exponential partitioning), which the
 * alternation-overlap analysis alone misses when there is only one branch.
 * Sound over-approximation: when an atom's status is uncertain it is treated as
 * MANDATORY (returns false early), so this never falsely calls a branch nullable.
 * @internal v3.9.0-rc.25 — closes the `(a?){25}` Shape-B bypass.
 */
function branchIsNullable(branch: string): boolean {
  let i = 0;
  while (i < branch.length) {
    const c = branch[i];
    if (c === undefined) break;
    if (c === "^" || c === "$") {
      i++;
      continue; // zero-width anchor — does not make the branch non-nullable
    }
    let atomEnd: number;
    let atomNullableBySelf = false;
    if (c === "\\") {
      const d = decodeEscapedChar(branch, i + 1);
      atomEnd = i + 1 + (d.length || 1); // a class shorthand (\d) decodes to null,length 1 → mandatory single char
    } else if (c === "[") {
      atomEnd = classEnd(branch, i);
    } else if (c === "(") {
      atomEnd = groupEnd(branch, i);
      let bs = i + 1;
      if (branch[bs] === "?") {
        const c2 = branch[bs + 1];
        if (c2 === ":" || c2 === "=" || c2 === "!") bs += 2;
        else if (c2 === "<") {
          const c3 = branch[bs + 2];
          if (c3 === "=" || c3 === "!") bs += 3;
          else {
            const gt = branch.indexOf(">", bs);
            bs = gt === -1 ? bs + 2 : gt + 1;
          }
        } else bs += 1;
      }
      const inner = branch.slice(bs, atomEnd - 1); // body between ( … )
      atomNullableBySelf = splitTopLevelAlternation(inner).some(branchIsNullable);
    } else {
      atomEnd = i + 1; // single-char atom (literal or `.`)
    }
    const qz = quantifierMinZero(branch, atomEnd);
    const skippable = atomNullableBySelf || (qz.isQuantifier && qz.allowsZero);
    if (!skippable) return false; // a mandatory atom → the branch cannot match empty
    i = atomEnd + qz.length;
  }
  return true; // every atom was skippable (or the branch is empty) → nullable
}

/**
 * Discriminated leading-atom analysis of an alternation branch:
 *  - `{ kind: "nullable" }` — the branch can match empty (every atom optional);
 *  - `{ kind: "any" }` — the leading set is broad/unknown (`.`, a `[class]`, a
 *    class shorthand, a nested group, or an unresolved escape can start it);
 *  - `{ kind: "set", chars }` — the exact (case-folded) chars the branch can
 *    START with.
 *
 * Returning a SET (not a single token) keeps the ambiguity check PRECISE when a
 * branch has an OPTIONAL leading atom: `a?b` can start with `a` OR `b`, so its
 * set is `{a,b}`. The single-token approximation (rc.21–rc.24) either dropped
 * the `b` (UNDER-flag → the C-1 ReDoS `(a?b|b)+`) or collapsed to ANY (OVER-flag
 * → disjoint alternations like `(a?b|c)+` falsely rejected). Still a sound
 * OVER-approximation: broad atoms widen to ANY, so it never under-flags.
 * @internal v3.9.0-rc.25 — replaces the single-token `leadingAtomToken`.
 */
type LeadingSet = { kind: "nullable" } | { kind: "any" } | { kind: "set"; chars: Set<string> };
function leadingAtomSet(branch: string): LeadingSet {
  const chars = new Set<string>();
  let i = 0;
  while (i < branch.length) {
    const c = branch[i];
    if (c === undefined) break;
    if (c === "^" || c === "$") {
      i++;
      continue; // zero-width anchor — look past it
    }
    if (c === "." || c === "[" || c === "(") return { kind: "any" }; // broad first atom
    if (c === "\\") {
      const n = branch[i + 1];
      if (n === undefined) return { kind: "any" };
      if (/[dDwWsSbBpP]/.test(n)) return { kind: "any" }; // class shorthand → broad
      const { char: decoded, length } = decodeEscapedChar(branch, i + 1);
      if (decoded === null) return { kind: "any" }; // unresolved escape → conservative ANY
      chars.add(foldCase(decoded));
      const qz = quantifierMinZero(branch, i + 1 + length);
      if (qz.isQuantifier && qz.allowsZero) {
        i = i + 1 + length + qz.length; // optional → the NEXT atom can also lead
        continue;
      }
      return { kind: "set", chars }; // mandatory escaped atom → set complete
    }
    chars.add(foldCase(c));
    const qz = quantifierMinZero(branch, i + 1);
    if (qz.isQuantifier && qz.allowsZero) {
      i = i + 1 + qz.length; // optional literal → include the next atom too
      continue;
    }
    return { kind: "set", chars }; // mandatory literal → set complete
  }
  return { kind: "nullable" }; // ran off the end → every atom optional → nullable
}

/**
 * True if an alternation `body` is AMBIGUOUS under repetition — two of its
 * top-level branches' leading sets intersect, a branch is broad (ANY), or a
 * branch is nullable. `(a|a)`, `(a|ab)`, `(.|a)`, `(a|)`, `(a?b|b)` are ambiguous
 * (→ catastrophic under `+`/`*`); `(a|b|c)`, `(cat|dog)`, `(a?b|c)` are NOT
 * (disjoint leading sets → linear). Built on {@link leadingAtomSet} (a sound
 * over-approximation: broad atoms widen to ANY), so it may over-flag a
 * shared-first-char-but-divergent group (`(cat|car)`) but never under-flags a
 * real overlap.
 * @internal exported only for unit tests of {@link isCatastrophicRegex}.
 */
export function alternationBodyAmbiguous(body: string): boolean {
  const branches = splitTopLevelAlternation(body);
  if (branches.length < 2) return false; // no alternation
  const leads = branches.map(leadingAtomSet);
  if (leads.some((l) => l.kind === "nullable")) return true; // nullable branch under + loops ambiguously
  if (leads.some((l) => l.kind === "any")) return true; // a broad branch overlaps any other
  for (let a = 0; a < leads.length; a++) {
    for (let b = a + 1; b < leads.length; b++) {
      const sa = leads[a];
      const sb = leads[b];
      if (sa?.kind === "set" && sb?.kind === "set") {
        for (const ch of sa.chars) if (sb.chars.has(ch)) return true; // leading sets intersect
      }
    }
  }
  return false;
}

/**
 * True if `body` contains a VARIABLE-LENGTH quantifier anywhere outside a char
 * class — `?`, `*`, `+`, `{m,}`, or `{m,n}` with `m !== n`. A fixed `{n}` and a
 * literal/escaped `?*+{` do not count. A variable-length body under an UNBOUNDED
 * outer quantifier (`(a{2,5})+`, `(\\w[ba]{0,3})+`, `(a[ab]?)+`) backtracks
 * super-linearly: consecutive repetitions can partition a long run many ways.
 * `readUnboundedQuantifier`'s amplify-threshold treats bounded ranges like
 * `{2,5}` as "not unbounded", so this is the term that closes that whole class
 * (found by the rc.25 fuzz harness). Sound but conservative — it OVER-flags an
 * anchored-separator body like `(\\w+\\s)+` (safe in practice). Per this guard's
 * documented stance, a rare false positive beats a hung event loop.
 * @internal v3.9.0-rc.25 helper for {@link isCatastrophicRegex}.
 */
function bodyHasVariableQuantifier(body: string): boolean {
  let inClass = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") {
      i++;
      continue; // escaped → literal
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue; // quantifier chars are literal inside a class
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c === "?" || c === "*" || c === "+") return true;
    if (c === "{") {
      const close = body.indexOf("}", i);
      if (close === -1) continue; // literal `{`
      const m = /^(\d*)(,(\d*))?$/.exec(body.slice(i + 1, close));
      if (!m || (m[1] === "" && m[2] === undefined)) continue; // not a quantifier brace
      const lower = m[1] === "" ? 0 : Number(m[1]);
      const hasComma = m[2] !== undefined;
      const upper = m[3];
      const max = !hasComma ? lower : upper === "" || upper === undefined ? Number.POSITIVE_INFINITY : Number(upper);
      if (max !== lower) return true; // variable range ({m,n} m≠n, or {m,})
      i = close; // fixed {n} — skip past it
    }
  }
  return false;
}

// v3.10.0-rc.36 — probe alphabet covering every char-equivalence-class the regex
// shorthands distinguish (digit / lower / upper / underscore / whitespace /
// punctuation / common metas) so atom overlap is decided by ACTUAL single-char
// regex membership (delegated to V8) instead of a hand-maintained class truth
// table — which would be its own under-flag bug surface, the recursion CLAUDE.md tracks.
const OVERLAP_PROBES = "0123456789abcxyzABCXYZ_ \t\n\r!#-.*:?/>@".split("");

/**
 * A single-char membership test for one regex ATOM (`.`, `\\w`, `[#.]`, `a`,
 * `\\x61`), or `"broad"` for a group / unparseable atom (overlaps everything — the
 * sound over-flag direction). Compiled case-INSENSITIVELY to mirror the
 * `new RegExp(pattern, "i")` the tool uses.
 * @internal v3.10.0-rc.36 helper for {@link atomsOverlap}.
 */
function atomOverlapMatcher(atomStr: string): ((ch: string) => boolean) | "broad" {
  if (atomStr === "" || atomStr[0] === "(") return "broad"; // group → conservative overlap
  let re: RegExp;
  try {
    re = new RegExp(`^(?:${atomStr})$`, "i");
  } catch {
    return "broad"; // unparseable in isolation → conservative
  }
  return (ch) => re.test(ch);
}

/**
 * True if two adjacent atoms can match a COMMON single character — so unbounded
 * quantifiers over them can split a shared run ambiguously. Decided by probing
 * {@link OVERLAP_PROBES} against each atom's single-char matcher: correct for
 * literals, `.`, char-classes, and shorthand overlaps (`\\w`⊃`\\d` overlap, `\\w`∩`\\s`=∅)
 * with NO hand truth table. Groups widen to `"broad"` (over-flag). A genuine
 * overlap only on a non-probe char would under-flag, but the probe set covers
 * every ASCII equivalence class the shorthands distinguish; the generative fuzz is
 * the empirical backstop.
 * @internal v3.10.0-rc.36 helper for {@link frameAdjacentOverlap}.
 */
function atomsOverlap(a: string, b: string): boolean {
  const ma = atomOverlapMatcher(a);
  const mb = atomOverlapMatcher(b);
  if (ma === "broad" || mb === "broad") return true;
  for (const ch of OVERLAP_PROBES) if (ma(ch) && mb(ch)) return true;
  return false;
}

/**
 * Index just past one atom starting at `src[start]` — an escape (`\\x`), a
 * char-class (`[...]`), a group (`(...)`), or a single char. Quantifier chars are
 * NOT consumed (the caller reads them separately).
 * @internal v3.10.0-rc.36 helper for {@link frameAdjacentOverlap} / {@link tailIsBenign}.
 */
function atomEndAt(src: string, start: number): number {
  const c = src[start];
  if (c === "\\") {
    const d = decodeEscapedChar(src, start + 1);
    return start + 1 + (d.length || 1);
  }
  if (c === "[") return classEnd(src, start);
  if (c === "(") return groupEnd(src, start);
  return start + 1;
}

/**
 * True if the atom at `src[start]` is a UNIVERSAL ABSORBER — `.` followed by an
 * unbounded quantifier (`.+`, `.*`, `.{n,}`), optionally wrapped in ONE group
 * layer (`(.+)`, `(?:.*)`). A `.`-greedy run matches ANY trailing chars, so it
 * consumes whatever a preceding adjacent-quantifier run could have matched and
 * reaches the end-anchor without forcing exponential redistribution — this is
 * exactly why the default `…\\s*[:\\-]?\\s*(.+)$` pattern is SAFE (~0.1ms) while
 * `…\\s*\\s*$` is NOT (~12s).
 * @internal v3.10.0-rc.36 helper for {@link tailIsBenign}.
 */
function isUniversalAbsorber(src: string, start: number): boolean {
  if (src[start] === ".") return readUnboundedQuantifier(src, start + 1).unbounded;
  if (src[start] === "(") {
    let bs = start + 1;
    if (src[bs] === "?") {
      const c2 = src[bs + 1];
      if (c2 === ":" || c2 === "=" || c2 === "!") bs += 2;
      else if (c2 === "<") {
        const c3 = src[bs + 2];
        if (c3 === "=" || c3 === "!") bs += 3;
        else {
          const gt = src.indexOf(">", bs);
          bs = gt === -1 ? bs + 2 : gt + 1;
        }
      } else bs += 1;
    }
    if (src[bs] === ".") return readUnboundedQuantifier(src, bs + 1).unbounded;
  }
  return false;
}

/**
 * True if the continuation of `branch` at `i` (everything AFTER an adjacent
 * overlapping-quantifier run) cannot force catastrophic backtracking — the run is
 * NEUTRALIZED. Walking from `i`: a `.`-greedy {@link isUniversalAbsorber} or the
 * end of the branch (no failing anchor) is BENIGN; an end anchor (`$`/`\\b`/`\\B`)
 * or any mandatory non-absorbing atom is a FAILING continuation (NOT benign).
 * Min-zero / nullable atoms and `^` are transparent. This is the ONE precision the
 * detector keeps (so the shipped default + `…\\s*X?\\s*(.+)$` user patterns aren't
 * rejected); everywhere else it over-flags. Errs toward NOT-benign when uncertain.
 * @internal v3.10.0-rc.36 helper for {@link frameAdjacentOverlap}.
 */
function tailIsBenign(branch: string, i: number): boolean {
  while (i < branch.length) {
    const c = branch[i];
    if (c === undefined) break;
    if (c === "^") {
      i++;
      continue; // non-failing zero-width anchor
    }
    if (c === "$") return false; // failing end anchor
    if (c === "\\" && (branch[i + 1] === "b" || branch[i + 1] === "B")) return false; // word-boundary anchor
    if (isUniversalAbsorber(branch, i)) return true; // `.+`/`.*` swallows any tail → reaches the end
    const atomEnd = atomEndAt(branch, i);
    const atomStr = branch.slice(i, atomEnd);
    const qz = quantifierMinZero(branch, atomEnd);
    if ((qz.isQuantifier && qz.allowsZero) || branchIsNullable(atomStr)) {
      i = atomEnd + (qz.isQuantifier ? qz.length : 0);
      continue; // optional / nullable atom → transparent
    }
    return false; // a mandatory, non-absorbing atom can fail after the run → catastrophic
  }
  return true; // reached the end with no failing anchor → greedy match succeeds
}

/**
 * v3.10.0-rc.36 — closes the 4th ReDoS recurrence (the top-level adjacency
 * bypass). True if a top-level concatenation branch of `body` contains TWO
 * ADJACENT atoms, each repeated by an UNBOUNDED quantifier, whose match sets
 * OVERLAP — the catastrophic `a*a*$` / `\\w*\\w*…$` / `(a)*(a)*$` shape (V8
 * redistributes a long shared run across the quantifiers super-linearly when the
 * continuation can fail; measured ~16s at 45 chars for `\\w*` ×8 + `$`, and ~1s at
 * 2000 chars for `a*a*$`). rc.21–rc.25 only evaluated the catastrophe verdict when
 * a QUANTIFIED GROUP closed (on `)`), so a BARE top-level sequence — frame 0 is
 * never popped — slipped entirely.
 *
 * Adjacency: zero-width anchors and min-zero (optional / nullable) atoms are
 * TRANSPARENT (the optional can vanish, keeping the two unbounded atoms adjacent —
 * `a*x?a*` is caught); a MANDATORY non-repeated atom BREAKS the run. Overlap is
 * decided by {@link atomsOverlap} (probe-based, so `\\d*\\s*` / `[#.]+\\s+` stay
 * accepted — disjoint — while `\\w*\\d*` is caught).
 *
 * `exemptByAbsorber`: at the TOP level the whole tail is visible, so a run
 * neutralized by a `.`-greedy absorber ({@link tailIsBenign}) is accepted — this
 * keeps the shipped default `…\\s*[:\\-]?\\s*(.+)$` safe. Inside a GROUP body the
 * external continuation is NOT visible, so pass `false` (over-flag: any in-group
 * adjacent overlap is treated as catastrophic — catches `(\\w*\\w*)x`).
 * @internal v3.10.0-rc.36 helper for {@link isCatastrophicRegex}.
 */
function frameAdjacentOverlap(body: string, exemptByAbsorber: boolean): boolean {
  for (const branch of splitTopLevelAlternation(body)) {
    let prevAtom: string | null = null; // the last unbounded atom (unit) while the run is unbroken
    let i = 0;
    while (i < branch.length) {
      const c = branch[i];
      if (c === undefined) break;
      if (c === "^" || c === "$") {
        i++;
        continue; // zero-width anchor — transparent, keeps the run
      }
      const atomEnd = atomEndAt(branch, i);
      const atomStr = branch.slice(i, atomEnd);
      const uq = readUnboundedQuantifier(branch, atomEnd);
      const qz = quantifierMinZero(branch, atomEnd);
      if (uq.unbounded) {
        if (prevAtom !== null && atomsOverlap(prevAtom, atomStr)) {
          if (!exemptByAbsorber || !tailIsBenign(branch, atomEnd + qz.length)) return true;
          prevAtom = null; // a `.`-greedy absorber neutralized this run; restart counting after it
        } else {
          prevAtom = atomStr;
        }
      } else if (!((qz.isQuantifier && qz.allowsZero) || branchIsNullable(atomStr))) {
        prevAtom = null; // a mandatory, non-repeated atom breaks the adjacency run
      }
      i = atomEnd + (qz.isQuantifier ? qz.length : 0);
    }
  }
  return false;
}

/**
 * Conservative, dependency-free guard against catastrophic-backtracking
 * (ReDoS) in a caller-supplied regex. V8's Irregexp engine backtracks, so
 * `(a+)+$`, `(.*)*`, or `(.*a){20}` can freeze the event loop for seconds on
 * a single long line. `obsidian_open_questions` runs the caller's `pattern`
 * against every line of every note, so an unvalidated regex is a remote DoS
 * on a bearer-authenticated `serve-http` (the tool is always registered).
 *
 * Catches four catastrophic shapes — each is an unbounded-quantified group
 * (`(...)+`, `(...)*`, `(...){n,}`, `(...){0,BIG}`) whose body is "dangerous":
 *  1. **Star height ≥ 2** — the body ALSO contains an unbounded quantifier
 *     (`(a+)+`, `(.*)*`).
 *  2. **Ambiguous alternation** (v3.9.0-rc.21/rc.24/rc.25) — the body's top-level
 *     branches' LEADING SETS intersect, so the backtracker can split one
 *     repetition many ways: `(a|a)+`, `(a|ab)*`, `(.|a)+`, `(a|A)+` (`/i`),
 *     `(\\x61|a)+` (escape alias), `(a?b|b)+` (optional leading atom). Decided by
 *     `alternationBodyAmbiguous` over `leadingAtomSet` (a sound
 *     over-approximation), so a DISJOINT alternation (`(a|b|c)+`, `(cat|dog)+`,
 *     `(a?b|c)+`) stays accepted and a NON-quantified alternation (`(?:a|b)\s*`,
 *     the default pattern's shape) is never flagged.
 *  3. **Nullable body** (v3.9.0-rc.25) — the body can match empty (`(a?)+`,
 *     `(\\s*)*`, `()+`), so each repetition can consume nothing.
 *  4. **Variable-length body** (v3.9.0-rc.25) — the body contains a
 *     variable-length quantifier (`(a{2,5})+`, `(\\w[ba]{0,3})+`, `(a[ab]?)+`);
 *     consecutive repetitions partition a long run exponentially. Gated on the
 *     OUTER quantifier being unbounded, so a BOUNDED outer (`(.+){2,5}`, ≤5 reps
 *     → polynomial) stays accepted.
 *  5. **Adjacent overlapping quantifiers** (v3.10.0-rc.36) — two ADJACENT atoms,
 *     each unbounded-quantified, whose match sets overlap, at ANY frame INCLUDING
 *     the TOP level: `a*a*$`, `\\w*\\w*$`, `(a)*(a)*$`. rc.21–rc.25 only evaluated
 *     the verdict when a QUANTIFIED GROUP closed, so a BARE top-level sequence
 *     (frame 0 is never popped) slipped — the rc.36 CRITICAL. Decided by
 *     `frameAdjacentOverlap`; a DISJOINT adjacency (`a*b*$`) stays accepted, and a
 *     `.`-greedy absorber tail (`…\\s*\\s*(.+)$`, the default's shape) is benign.
 *
 * Sound but conservative: it never UNDER-flags a real catastrophic shape (proven
 * by the `tests/redos-fuzz.test.ts` fuzz harness, which times a real
 * `exec` against the static verdict), but it MAY over-flag — `(cat|car)+`
 * (shared first char), `(a?b)+` / `(\\w+\\s)+` (variable but anchored). For a
 * security guard, a rare false positive (caller simplifies / omits the override)
 * beats a hung event loop.
 *
 * Honors char-classes (`[...]` contents are literal) and backslash escapes
 * (`\(`, `\+`, `\|` are literals). Still best-effort — ReDoS detection is
 * undecidable in general — so the caller also pairs it with
 * {@link MAX_QUESTION_PATTERN_LEN}.
 *
 * @param src - The raw regex source the caller wants to compile.
 * @returns true if the pattern risks catastrophic backtracking.
 * @example
 * ```ts
 * isCatastrophicRegex("(a+)+$");        // true  — nested unbounded quantifiers
 * isCatastrophicRegex("(a|a)+$");       // true  — ambiguous alternation under +
 * isCatastrophicRegex("(a?b|b)+$");     // true  — optional leading atom overlaps (rc.25)
 * isCatastrophicRegex("(a?){25}");      // true  — nullable body under repetition (rc.25)
 * isCatastrophicRegex("(a{2,5})+");     // true  — variable-length body under + (rc.25)
 * isCatastrophicRegex("\\w*\\w*$");       // true  — adjacent overlapping quantifiers (rc.36)
 * isCatastrophicRegex("a*b*$");         // false — adjacent but DISJOINT (linear)
 * isCatastrophicRegex("(a|b|c)+");      // false — disjoint alternation (linear)
 * isCatastrophicRegex("(.+){2,5}");     // false — variable body but BOUNDED outer
 * isCatastrophicRegex("^Q: (.+)$");     // false — single-level
 * isCatastrophicRegex("(?:a|b)\\s*c");  // false — alternation NOT unbounded-quantified
 * ```
 */
export function isCatastrophicRegex(src: string): boolean {
  const hadUnbounded: boolean[] = [false]; // per-frame: body has an unbounded quantifier
  const ambiguous: boolean[] = [false]; // per-frame: body has (or nested-bubbled) an ambiguous alternation
  const bodyStart: number[] = [0]; // per-frame: index where the group body begins
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") {
      i++; // skip the escaped char — it's a literal / class shorthand, never meta
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "(") {
      hadUnbounded.push(false);
      ambiguous.push(false);
      // Body begins after the `(` and any group-type prefix (`?:`, `?<name>`,
      // `?=`, `?!`, `?<=`, `?<!`) so branch-splitting sees the real branches.
      let bs = i + 1;
      if (src[bs] === "?") {
        const c2 = src[bs + 1];
        if (c2 === ":" || c2 === "=" || c2 === "!") bs += 2;
        else if (c2 === "<") {
          const c3 = src[bs + 2];
          if (c3 === "=" || c3 === "!")
            bs += 3; // lookbehind
          else {
            const gt = src.indexOf(">", bs); // named capture (?<name>
            bs = gt === -1 ? bs + 2 : gt + 1;
          }
        } else bs += 1;
      }
      bodyStart.push(bs);
      continue;
    }
    if (ch === ")") {
      const frameHad = hadUnbounded.pop() ?? false;
      const frameAmbiguous = ambiguous.pop() ?? false;
      const bs = bodyStart.pop() ?? i;
      // A group's body is ambiguous if a nested group bubbled ambiguity up OR
      // its own top-level alternation overlaps (`((a|a))+` → inner reaches outer).
      const body = src.slice(bs, i);
      // v3.10.0-rc.36: adjacent overlapping unbounded quantifiers INSIDE this group
      // body (`(\\w*\\w*)x`, `(a*a*)`) are catastrophic regardless of the outer
      // quantifier — the per-frame `hadUnbounded` flag alone never caught them.
      // exemptByAbsorber=false: the group's EXTERNAL continuation isn't visible
      // here, so any in-group adjacent overlap is treated as catastrophic.
      if (frameAdjacentOverlap(body, false)) return true;
      const bodyAmbiguous = frameAmbiguous || alternationBodyAmbiguous(body);
      // v3.9.0-rc.25: a NULLABLE body (can match empty) under an unbounded
      // quantifier is the classic `(a?)+` / `(\\s*)*` / `(a?){25}` ReDoS — each
      // repetition can consume nothing, so the backtracker partitions a long
      // input exponentially. `branchIsNullable` recurses into nested groups, so
      // `((a?))+` is caught here too (no separate bubble stack needed).
      const bodyNullable = splitTopLevelAlternation(body).some(branchIsNullable);
      const q = readUnboundedQuantifier(src, i + 1);
      // v3.9.0-rc.25: a VARIABLE-LENGTH body under an UNBOUNDED outer quantifier
      // partitions a long run super-linearly (`(a{2,5})+`, `(a[ab]?)+`). Gated on
      // `q.unbounded` so a BOUNDED outer like `(.+){2,5}` (≤5 reps → polynomial)
      // stays accepted. The fuzz harness found this whole class.
      const bodyVariable = q.unbounded && bodyHasVariableQuantifier(body);
      // Catastrophic if this group is unbounded-quantified AND its body either
      // nested an unbounded quantifier (star height ≥ 2), is an ambiguous
      // alternation (overlapping-alternation ReDoS), is nullable, or is
      // variable-length.
      if (q.unbounded && (frameHad || bodyAmbiguous || bodyNullable || bodyVariable)) return true;
      // Propagate to the parent frame.
      if (hadUnbounded.length > 0) {
        if (q.unbounded || frameHad) hadUnbounded[hadUnbounded.length - 1] = true;
        if (bodyAmbiguous) ambiguous[ambiguous.length - 1] = true;
      }
      i += q.length; // skip the quantifier chars we just consumed
      continue;
    }
    const q = readUnboundedQuantifier(src, i);
    if (q.unbounded && hadUnbounded.length > 0) {
      hadUnbounded[hadUnbounded.length - 1] = true;
    }
    if (q.length > 1) i += q.length - 1; // skip multi-char brace quantifiers
  }
  // v3.10.0-rc.36: the TOP-LEVEL frame (frame 0) is never popped (no `)` at depth
  // 0), so a bare `\\w*\\w*…$` / `a*a*…$` adjacency reaches here unflagged by the
  // pop logic above. Evaluate the same overlap check on the whole pattern, with
  // the absorber exemption (the full tail is visible → the safe-default shape
  // `…\s*[:\-]?\s*(.+)$` is correctly accepted).
  if (frameAdjacentOverlap(src, true)) return true;
  return false;
}

/**
 * Match `lines` against a caller-supplied regex `pattern` (compiled case-INsensitively)
 * on a WORKER THREAD, bounded by `budgetMs`. Returns `{ idx, q }` for every line whose
 * FIRST capture group matched (mirrors the `re.exec(line)?.[1]` contract
 * {@link getOpenQuestions} uses). The worker isolates V8's backtracking off the main
 * event loop and the timeout terminates it, so even a catastrophic-backtracking pattern
 * the best-effort static {@link isCatastrophicRegex} guard MISSED can never hang the
 * server — it's rejected fail-closed when the budget elapses. An invalid pattern rejects
 * with a clear error. This is the HARD ReDoS sink-bound; the static guard is a cheap
 * pre-filter in front of it.
 * @internal v3.10.0-rc.39 — closes the static-detector residual the rc.36 re-sweep found.
 */
export function matchLinesBounded(
  pattern: string,
  lines: readonly string[],
  budgetMs: number
): Promise<{ idx: number; q: string }[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      "const{parentPort,workerData}=require('node:worker_threads');" +
        "try{const re=new RegExp(workerData.pattern,'i');const L=workerData.lines;const out=[];" +
        "for(let i=0;i<L.length;i++){const m=re.exec(L[i]);if(m&&m[1]!=null)out.push({idx:i,q:m[1]});}" +
        "parentPort.postMessage({ok:true,out});}catch(e){parentPort.postMessage({ok:false,err:String((e&&e.message)||e)});}",
      { eval: true, workerData: { pattern, lines } }
    );
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(
      () =>
        settle(() =>
          reject(
            new Error(
              `obsidian_open_questions: pattern rejected — matching exceeded the ${budgetMs}ms safe budget ` +
                "(likely catastrophic backtracking / ReDoS). Simplify the pattern or omit it to use the safe default."
            )
          )
        ),
      budgetMs
    );
    worker.on("message", (msg: { ok: boolean; out?: { idx: number; q: string }[]; err?: string }) =>
      settle(() => {
        if (msg.ok) resolve(msg.out ?? []);
        else reject(new Error(`obsidian_open_questions: invalid pattern — ${msg.err ?? "could not compile"}`));
      })
    );
    worker.on("error", (e) => settle(() => reject(e instanceof Error ? e : new Error(String(e)))));
  });
}

/**
 * Surface unresolved threads — `Open question:` / `Q:` / `TODO?` / `??`
 * markers across the vault.
 *
 * Karpathy and ML PKM workflows use these as deferred-thinking markers.
 * This tool returns every such line with source path, context heading,
 * and `age_days` for staleness ranking. Sorted oldest-first so aging
 * questions surface for the agent to nudge the user about.
 *
 * Scans `parsed.body` (frontmatter excluded) so YAML lines containing
 * "Q:"-ish tokens don't pollute results. The default matcher is
 * case-insensitive and accepts list-bullets / quote / heading prefixes
 * before the marker. Override `pattern` for a custom regex.
 *
 * @param vault - The vault.
 * @param args - All optional. `folder` restricts the scan. `limit`
 *   defaults to 100. `pattern` overrides the default matcher regex.
 * @returns Sorted `OpenQuestion[]` (oldest-first by `age_days`).
 * @throws {VaultPathError} If `folder` resolves outside the vault.
 * @example
 * ```ts
 * const qs = await getOpenQuestions(vault, { folder: "Reading", limit: 30 });
 * for (const q of qs.slice(0, 5)) {
 *   console.log(`${q.source_path}:${q.line} [${q.age_days}d ago] ${q.question}`);
 * }
 * ```
 */
export async function getOpenQuestions(
  vault: Vault,
  args: { folder?: string; limit?: number; pattern?: string; scanBudgetMs?: number }
): Promise<OpenQuestion[]> {
  await vault.ensureExists();
  const limit = args.limit ?? 100;
  // Default pattern: "Open question:" / "Open question -" / "Q:" / "TODO?" / "??"
  // followed by space + question text. Anchored at line start (with optional
  // list-bullet / quote / heading prefix).
  // Default pattern matches deferred-thinking markers at line start (with
  // optional list-bullet / quote / heading prefix). Single-line `i` flag —
  // we apply it line-by-line below.
  const defaultPat = "^\\s*(?:[#\\->\\*\\d\\.]+\\s+)?(?:open\\s+question|q|todo\\?|\\?\\?)\\s*[:\\-]?\\s*(.+)$";
  // ReDoS guard (v3.9.0-rc.9 audit): the default pattern is safe, but a
  // caller-supplied override is compiled into V8's backtracking engine and
  // run against every line of every note — an unbounded regex would be a
  // remote DoS on serve-http. Reject over-long or catastrophic patterns
  // BEFORE compiling. See isCatastrophicRegex / MAX_QUESTION_PATTERN_LEN.
  // ReDoS defense (rc.9 + rc.39): the safe default is matched inline; a CALLER-
  // supplied override is (1) length-capped + cheaply pre-filtered by the best-effort
  // isCatastrophicRegex denylist (rejects OBVIOUS shapes without spawning a worker),
  // then (2) HARD-bounded by matching on a WORKER THREAD with a wall-clock budget
  // (matchLinesBounded below) — so even a shape the denylist misses (ReDoS is
  // undecidable; a rc.36 re-sweep confirmed a residual tail) can never hang the
  // event loop. See MAX_QUESTION_SCAN_MS. The worker compiles the pattern itself.
  if (args.pattern !== undefined) {
    if (args.pattern.length > MAX_QUESTION_PATTERN_LEN) {
      throw new Error(
        `obsidian_open_questions: pattern too long (${args.pattern.length} > ${MAX_QUESTION_PATTERN_LEN} chars). ` +
          "Simplify it or omit it to use the safe default."
      );
    }
    if (isCatastrophicRegex(args.pattern)) {
      throw new Error(
        "obsidian_open_questions: pattern rejected — it risks catastrophic backtracking (ReDoS) via " +
          "nested unbounded quantifiers (e.g. `(a+)+`, `(.*)*`) or an unbounded-quantified alternation " +
          "(e.g. `(a|a)+`, `(a|ab)*`). Simplify the pattern or omit it to use the safe default."
      );
    }
  }

  // v3.10.0-rc.16 (audit M5) — collect ALL matches across the (capped) scan,
  // THEN sort oldest-first + slice. The prior code broke at `limit` in vault-
  // WALK order and only then sorted, so on a vault with > `limit` questions it
  // returned an arbitrary limit-subset, NOT the documented oldest-first. The
  // scan is capped (capScanEntries) so a pathological vault can't drive
  // unbounded readNote I/O — defense-in-depth, same posture as the graph tools.
  const entries = capScanEntries(await vault.listMarkdown(args.folder), "obsidian_open_questions");
  const now = Date.now();
  // Collect candidate lines (skipping heading lines — never question hits) with
  // their resolved metadata, FLAT across notes, so the regex matching can run as one
  // bounded pass (in a worker for a caller pattern). Scan parsed.body so frontmatter
  // lines (which can contain "Q:"-ish tokens) don't pollute results.
  type Candidate = {
    line: string;
    relPath: string;
    basename: string;
    lineNo: number;
    heading: string | null;
    mtimeMs: number;
  };
  const candidates: Candidate[] = [];
  for (const e of entries) {
    const { parsed, mtimeMs } = await vault.readNote(e.absPath, e.mtimeMs);
    // v3.11.6-rc.2 — the fence-aware line walk + ATX-heading parse now come from the canonical
    // structure iterator (src/structure.ts): `l.text` === the former `splitLines(parsed.body)[i]`,
    // `l.line` === `bodyStartLine + i`, and `l.heading` mirrors the old headingMatch (a degenerate
    // `# ###` yields `l.heading` with empty text, so it still `continue`s as a non-hit heading line).
    let currentHeading: string | null = null;
    for (const l of iterateBodyLines(parsed)) {
      if (l.inFence) continue;
      if (l.heading) {
        if (l.heading.text) currentHeading = l.heading.text; // heading lines set context, aren't hits
        continue;
      }
      candidates.push({
        line: l.text,
        relPath: e.relPath,
        basename: e.basename,
        lineNo: l.line,
        heading: currentHeading,
        mtimeMs
      });
    }
  }
  // Match. A CALLER pattern runs on a worker thread with a hard wall-clock budget
  // (the rc.39 ReDoS sink-bound — the main event loop can never hang, any pattern);
  // the safe default runs inline (zero overhead). Each match yields the FIRST capture
  // group as the question text (the `re.exec(line)?.[1]` contract).
  // v3.11.0-rc.19 (rc.17 external audit, Cursor MED-1 — the 4th CRLF-blind `(.+)$` site
  // the rc.17 heading fix missed). `c.line` is a raw `parsed.body.split("\n")` line, so on
  // a CRLF note it keeps a trailing `\r` that JS `.`/`$` (no `s`/`m`) won't cross — the
  // default `…(.+)$` question pattern (and any caller pattern) then matched NOTHING on
  // every CRLF line, silently dropping a Windows note's open questions. Strip the trailing
  // line terminator before matching (covers BOTH the worker and inline paths below).
  const lineTexts = candidates.map((c) => stripTrailingLineEnds(c.line));
  let matches: { idx: number; q: string }[];
  if (args.pattern !== undefined) {
    matches = await matchLinesBounded(args.pattern, lineTexts, args.scanBudgetMs ?? MAX_QUESTION_SCAN_MS);
  } else {
    matches = [];
    const re = new RegExp(defaultPat, "i");
    for (let i = 0; i < lineTexts.length; i++) {
      const m = re.exec(lineTexts[i] ?? "");
      if (m?.[1] != null) matches.push({ idx: i, q: m[1] });
    }
  }
  const out: OpenQuestion[] = matches.map(({ idx, q }) => {
    const c = candidates[idx] as Candidate;
    return {
      question: q.trim(),
      source_path: c.relPath,
      source_title: stripMd(c.basename),
      context_heading: c.heading,
      line: c.lineNo,
      age_days: Math.round((now - c.mtimeMs) / (24 * 3600 * 1000)),
      mtime: new Date(c.mtimeMs).toISOString()
    };
  });
  // Sort oldest-first so things aging out surface first, THEN return the
  // `limit` genuinely-oldest — not an arbitrary walk-order subset (audit M5).
  out.sort((a, b) => b.age_days - a.age_days);
  return out.slice(0, limit);
}

// ─── obsidian_paper_audit (v1.5 — verify #paper notes have citations) ────────
// For each note tagged #paper (configurable), verify frontmatter has at least
// one of arxiv/doi/url/isbn. Also flag notes whose body contains an arxiv ID
// (e.g. "arxiv:2401.12345") but doesn't carry it in frontmatter — common after
// quick-capture from a chat.

/**
 * One flagged paper note returned by {@link paperAudit}.
 *
 * `proposed_frontmatter_patch` is a ready-to-apply YAML patch the agent
 * can hand to {@link frontmatterSet}. Null when the body has no detectable
 * identifiers either (the note really has no citation, manual fix needed).
 */
export interface PaperAuditFinding {
  /** Vault-relative path of the offending note. */
  path: string;
  /** `.md`-stripped basename for display. */
  title: string;
  /** Whether the note has any of arxiv/doi/url/isbn in frontmatter. */
  has_frontmatter_citation: boolean;
  /** Identifiers detected in body text (deduplicated, URLs capped at 3). */
  found_in_body: { arxiv: string[]; doi: string[]; url: string[] };
  /** A ready-to-apply `{ arxiv | doi | url }` patch — or null. */
  proposed_frontmatter_patch: Record<string, string> | null;
  /** Human-readable description of the issue. */
  message: string;
}

/**
 * Audit `#paper`-tagged notes for missing citation metadata.
 *
 * Scans every note carrying the configured tag and verifies frontmatter has
 * at least one of `arxiv` / `doi` / `url` / `isbn`. Notes with detectable
 * identifiers in body text (e.g. `arxiv:2401.12345` from quick-capture)
 * but missing frontmatter receive an actionable `proposed_frontmatter_patch`.
 *
 * @param vault - The vault.
 * @param args - All optional. `tag` defaults to `"paper"` (leading `#`
 *   stripped if provided). `folder` restricts the scan. `limit` defaults
 *   to 100.
 * @returns `{ scanned, flagged }` — `scanned` counts notes carrying the
 *   tag; `flagged` is the subset with missing frontmatter citation.
 * @throws {VaultPathError} If `folder` resolves outside the vault.
 * @example
 * ```ts
 * const audit = await paperAudit(vault, { tag: "paper", limit: 50 });
 * console.log(`${audit.flagged.length}/${audit.scanned} papers need citation`);
 * for (const p of audit.flagged) {
 *   if (p.proposed_frontmatter_patch) {
 *     await frontmatterSet(vault, { path: p.path, set: p.proposed_frontmatter_patch });
 *   }
 * }
 * ```
 */
export async function paperAudit(
  vault: Vault,
  args: { tag?: string; folder?: string; limit?: number }
): Promise<{ scanned: number; flagged: PaperAuditFinding[] }> {
  await vault.ensureExists();
  const tag = foldTag(args.tag ?? "paper");
  const limit = args.limit ?? 100;
  const entries = await vault.listMarkdown(args.folder);

  const arxivRe = /\barxiv[:\s]*([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)\b/gi;
  const doiRe = /\bdoi[:\s]*(10\.\d{4,9}\/[\w\-._;()/:]+)/gi;
  const urlRe = /\bhttps?:\/\/[^\s<>")\]]+/g;

  let scanned = 0;
  const flagged: PaperAuditFinding[] = [];
  for (const e of entries) {
    if (flagged.length >= limit) break;
    const { parsed } = await vault.readNote(e.absPath, e.mtimeMs);
    const tagsLower = parsed.tags.map((t) => foldTag(t));
    if (!tagsLower.includes(tag)) continue;
    scanned += 1;

    const fm = parsed.frontmatter ?? {};
    const fmKeys = new Set(Object.keys(fm).map((k) => k.toLowerCase()));
    const hasFmCitation = fmKeys.has("arxiv") || fmKeys.has("doi") || fmKeys.has("url") || fmKeys.has("isbn");

    // Scan parsed.body so the frontmatter's own arxiv/doi keys don't get
    // re-detected as "found in body".
    const body = parsed.body;
    const arxivIds = [...body.matchAll(arxivRe)].map((m) => m[1]).filter((v): v is string => !!v);
    const doiIds = [...body.matchAll(doiRe)].map((m) => m[1]).filter((v): v is string => !!v);
    const urls = [...body.matchAll(urlRe)].map((m) => m[0]);
    const foundInBody = {
      arxiv: [...new Set(arxivIds)],
      doi: [...new Set(doiIds)],
      url: [...new Set(urls)].slice(0, 3)
    };

    const bodyHasAnyId = foundInBody.arxiv.length > 0 || foundInBody.doi.length > 0 || foundInBody.url.length > 0;
    // Clean ⇒ has a frontmatter citation. The body might cite OTHER papers,
    // but this note itself is properly identified.
    if (hasFmCitation) continue;

    let proposed: Record<string, string> | null = null;
    if (bodyHasAnyId) {
      proposed = {};
      if (foundInBody.arxiv[0]) proposed.arxiv = foundInBody.arxiv[0];
      if (foundInBody.doi[0]) proposed.doi = foundInBody.doi[0];
      if (foundInBody.url[0] && !proposed.arxiv && !proposed.doi) proposed.url = foundInBody.url[0];
    }

    const msg = bodyHasAnyId
      ? `${e.relPath} has identifiers in body (${[
          ...foundInBody.arxiv.map((v) => `arxiv:${v}`),
          ...foundInBody.doi.map((v) => `doi:${v}`)
        ]
          .slice(0, 2)
          .join(", ")}) but missing frontmatter`
      : `${e.relPath} has #${tag} but no arxiv/doi/url anywhere — citation missing`;

    flagged.push({
      path: e.relPath,
      title: stripMd(e.basename),
      has_frontmatter_citation: hasFmCitation,
      found_in_body: foundInBody,
      proposed_frontmatter_patch: proposed,
      message: msg
    });
  }
  return { scanned, flagged };
}

// ─── obsidian_find_path (v1.6 multi-hop graph traversal) ────────────────────
// BFS over the wikilink graph from `from` to `to`, returning the shortest path
// (sequence of notes connected by wikilinks) up to `max_depth` hops. Closes
// the gap aaronsb's plugin opened: "find paths between concepts" was the
// most-praised graph feature in the competitive audit. We use the shared
// EntryIndex memo so repeat calls in a session reuse the basename index for
// O(1) target resolution.

/**
 * One step of a graph traversal path returned by {@link findPath}.
 */
export interface PathStep {
  /** Vault-relative path of this step. */
  path: string;
  /** `.md`-stripped basename. */
  title: string;
  /** Wikilink raw text (`[[…]]` content) used to traverse FROM the previous
   *  step to this one. Empty on the source step. */
  via: string;
}

/**
 * Result of a {@link findPath} traversal.
 *
 * `found: false` + `hops: -1` indicates no path within `max_depth`.
 * `alternatives` is populated only when `args.include_alternatives` is true
 * and at least one same-length alternative exists.
 */
export interface FindPathResult {
  /** Source path (vault-relative, with `.md`). */
  from: string;
  /** Destination path. */
  to: string;
  /** Whether a path was found within `max_depth`. */
  found: boolean;
  /** Shortest path as a sequence of {@link PathStep}. Empty on miss. */
  path: PathStep[];
  /** Number of hops in `path`. -1 when not found. 0 for from = to. */
  hops: number;
  /** Up to 10 same-length alternatives, only when include_alternatives=true. */
  alternatives?: PathStep[][];
}

/**
 * Find the shortest wikilink-graph path between two notes via BFS.
 *
 * Multi-hop graph traversal — closes the gap the competitive audit
 * surfaced ("find paths between concepts" was the most-praised graph
 * feature in competitor plugins). Returns the shortest path up to
 * `max_depth` hops; with `include_alternatives: true`, also returns up
 * to 10 same-length alternatives (useful for "show me different
 * connections").
 *
 * Uses the shared `EntryIndex` (basename → entries map) for O(1) target
 * resolution per hop, so repeat calls in a session reuse the index.
 * v1.8.1 perf fix: builds a `relPath → entry` map once before BFS
 * (pre-fix was O(N²) per visited node).
 *
 * @param vault - The vault.
 * @param args - One of `from` / `from_title` and one of `to` / `to_title`
 *   required. `max_depth` defaults to 5. `include_alternatives` defaults
 *   to false. `follow_embeds` defaults to true (include `![[embeds]]` as
 *   edges).
 * @returns A {@link FindPathResult}. When `found: false`, `path: []` and
 *   `hops: -1`.
 * @throws {Error} If from / to can't be resolved.
 * @example
 * ```ts
 * const r = await findPath(vault, {
 *   from_title: "Attention",
 *   to_title: "RLHF",
 *   max_depth: 4
 * });
 * if (r.found) {
 *   console.log(`${r.hops} hops:`, r.path.map(s => s.title).join(" → "));
 * }
 * ```
 */
export async function findPath(
  vault: Vault,
  args: {
    from?: string;
    from_title?: string;
    to?: string;
    to_title?: string;
    max_depth?: number;
    include_alternatives?: boolean;
    follow_embeds?: boolean;
  }
): Promise<FindPathResult> {
  await vault.ensureExists();
  const maxDepth = args.max_depth ?? 5;
  const includeAlts = args.include_alternatives === true;
  const followEmbeds = args.follow_embeds !== false;

  const fromArgs: { path?: string; title?: string } = {};
  if (args.from !== undefined) fromArgs.path = args.from;
  else if (args.from_title !== undefined) fromArgs.title = args.from_title;
  const fromEntry = await resolveTarget(vault, fromArgs);

  const toArgs: { path?: string; title?: string } = {};
  if (args.to !== undefined) toArgs.path = args.to;
  else if (args.to_title !== undefined) toArgs.title = args.to_title;
  const toEntry = await resolveTarget(vault, toArgs);

  if (fromEntry.absPath === toEntry.absPath) {
    return {
      from: fromEntry.relPath,
      to: toEntry.relPath,
      found: true,
      hops: 0,
      path: [{ path: fromEntry.relPath, title: stripMd(fromEntry.basename), via: "" }]
    };
  }

  const entries = await vault.listMarkdown();

  // BFS layer-by-layer. visited tracks shortest-known-depth so we don't
  // revisit at greater depths. We continue collecting at the depth where
  // we first hit the target IF include_alternatives is set.
  // v1.8.1 perf fix: build a relPath → entry map ONCE before the BFS loop.
  // Pre-fix: entries.find((e) => e.relPath === node.rel) was O(N) per visited
  // node, making the whole BFS O(N²) on large vaults.
  const byRel = new Map<string, FileEntry>();
  for (const e of entries) byRel.set(e.relPath, e);

  // v3.9.0-rc.34 (deep-audit R-5) — explicit visited-node cap. BFS is already
  // bounded by the vault's note count (each note is visited at most once) +
  // `maxDepth`, but on a very large, densely-wikilinked vault the per-layer
  // `readNote` I/O is unbounded work for an always-registered tool. This hard
  // cap bails gracefully (returns not-found) once an unreasonable number of
  // nodes has been expanded, bounding worst-case CPU/I/O regardless of vault
  // size — defense-in-depth against an adversarial/pathological graph.
  const MAX_VISITED = 50_000;
  type FrontierEntry = { rel: string; trail: PathStep[] };
  const visited = new Set<string>([fromEntry.relPath]);
  let frontier: FrontierEntry[] = [
    { rel: fromEntry.relPath, trail: [{ path: fromEntry.relPath, title: stripMd(fromEntry.basename), via: "" }] }
  ];
  const found: PathStep[][] = [];
  let foundDepth = -1;

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: FrontierEntry[] = [];
    for (const node of frontier) {
      const entry = byRel.get(node.rel);
      if (!entry) continue;
      const { parsed } = await vault.readNote(entry.absPath, entry.mtimeMs);
      const links = followEmbeds ? [...parsed.wikilinks, ...parsed.embeds] : parsed.wikilinks;
      for (const link of links) {
        const m = findBestMatch(entries, link.target, entry.relPath);
        if (!m) continue;
        if (visited.has(m.relPath) && m.absPath !== toEntry.absPath) continue;
        const newTrail: PathStep[] = [...node.trail, { path: m.relPath, title: stripMd(m.basename), via: link.raw }];
        if (m.absPath === toEntry.absPath) {
          if (foundDepth === -1) foundDepth = depth + 1;
          if (foundDepth === depth + 1) {
            found.push(newTrail);
            if (!includeAlts) {
              return {
                from: fromEntry.relPath,
                to: toEntry.relPath,
                found: true,
                hops: foundDepth,
                path: newTrail
              };
            }
          }
        } else {
          visited.add(m.relPath);
          next.push({ rel: m.relPath, trail: newTrail });
        }
      }
      // R-5 cap — stop expanding once we've visited an unreasonable number of
      // nodes. Returns whatever's been found so far (or not-found); never hangs.
      if (visited.size >= MAX_VISITED) {
        frontier = [];
        break;
      }
    }
    if (foundDepth !== -1 && depth + 1 === foundDepth) break;
    frontier = next;
  }

  if (found.length > 0) {
    found.sort((a, b) => a.length - b.length || (a[0]?.path ?? "").localeCompare(b[0]?.path ?? ""));
    const first = found[0];
    if (!first) {
      return { from: fromEntry.relPath, to: toEntry.relPath, found: false, hops: -1, path: [] };
    }
    const result: FindPathResult = {
      from: fromEntry.relPath,
      to: toEntry.relPath,
      found: true,
      hops: foundDepth,
      path: first
    };
    if (includeAlts) result.alternatives = found.slice(0, 10);
    return result;
  }

  return { from: fromEntry.relPath, to: toEntry.relPath, found: false, hops: -1, path: [] };
}

// ─── obsidian_open_in_ui (v1.6 cyanheads pattern) ───────────────────────────
// Returns an obsidian:// URI for hand-off to the desktop app. No filesystem or
// network side effect — the URI emission lets the agent say "open this in
// Obsidian" without enquire-mcp needing to coordinate with the running app.

/**
 * Result of {@link openInUi} — an `obsidian://` URI ready to hand off to
 * the desktop app.
 */
export interface OpenInUiResult {
  /** Full `obsidian://open?...` URI. */
  uri: string;
  /** Vault name as derived from the root folder leaf. */
  vault_name: string;
  /** Vault-relative path of the target note. */
  path: string;
  /** `.md`-stripped basename for display. */
  title: string;
}

/**
 * Emit an `obsidian://` URI for hand-off to the Obsidian desktop app.
 *
 * No filesystem or network side effect — the URI emission lets the agent
 * say "open this in Obsidian" without enquire-mcp needing to coordinate
 * with the running app (pattern from cyanheads' Obsidian MCP). The vault
 * name is the leaf of the vault root path; Obsidian matches by name OR by
 * file's absolute path, so this works even when the user opened the vault
 * under a different name client-side.
 *
 * @param vault - The vault.
 * @param args - One of `path` or `title` required. `new_pane: true` opens
 *   the note in a new pane.
 * @returns An {@link OpenInUiResult}. The caller is responsible for
 *   actually emitting the URI (e.g. via the MCP client surface or stdout).
 * @throws {Error} If target can't be resolved.
 * @example
 * ```ts
 * const r = await openInUi(vault, {
 *   path: "Reference/Article.md",
 *   new_pane: true
 * });
 * console.log(r.uri); // → obsidian://open?vault=Vault&file=Reference/Article&newpane=true
 * ```
 */
export async function openInUi(
  vault: Vault,
  args: { path?: string; title?: string; new_pane?: boolean }
): Promise<OpenInUiResult> {
  await vault.ensureExists();
  const target = await resolveTarget(vault, args);
  // Vault name = leaf of the vault root path. obsidian:// matches by name OR
  // by the file's absolute path; if the user opened the vault from a
  // different name in Obsidian, the file argument still resolves correctly.
  const vaultName = path.basename(vault.root);
  const noteRel = stripMd(target.relPath);
  const params = new URLSearchParams({ vault: vaultName, file: noteRel });
  if (args.new_pane) params.set("newpane", "true");
  return {
    uri: `obsidian://open?${params.toString()}`,
    vault_name: vaultName,
    path: target.relPath,
    title: stripMd(target.basename)
  };
}

// ─── obsidian_context_pack (v2.2.0 — token-budgeted vault context export) ───
// Smart Connections' "Send to Smart Context" pattern, MCP-native. Takes a
// query, runs hybrid retrieval, gathers note bodies + 1-line backlink
// summaries + recent daily notes, deduplicates, packs to a token budget,
// returns one ready-to-paste markdown string. The agent doesn't have to
// orchestrate 5 separate tool calls — one tool, one context blob.
//
// Why MCP-native > Obsidian-only: Smart Context only works inside Obsidian.
// This tool works in Claude Code, Cursor, Codex, anywhere — copy the result
// into ANY chat.

/**
 * Arguments for {@link contextPack}.
 */
export interface ContextPackArgs {
  /** Topic / question to gather context for. */
  query: string;
  /** Approximate token budget for the bundle. ~4 chars/token assumption. Default 4000. */
  budget_tokens?: number;
  /** Restrict retrieval to this folder. */
  folder?: string;
  /** Include backlinks of top-K notes (1-line each)? Default true. */
  include_backlinks?: boolean;
  /** Include the last N daily notes? Default 0 (off). Set to 3 for "what was I doing recently". */
  recent_dailies?: number;
}

/**
 * Result of {@link contextPack} — a ready-to-paste markdown bundle.
 *
 * `bundle` is the full markdown blob the caller can paste into any AI
 * chat. `sections` exposes per-section byte counts so the agent can
 * report what's inside ("4 notes + 12 backlinks + 3 daily notes").
 * `estimated_tokens` uses the ~4 chars/token heuristic for English /
 * Cyrillic; CJK estimates run higher (real tokenization is
 * model-dependent).
 */
export interface ContextPackResult {
  /** Echo of the input query. */
  query: string;
  /** The packed markdown bundle ready to paste into an AI chat. */
  bundle: string;
  /** Approximate token count (chars / 4). */
  estimated_tokens: number;
  /** Echo of the input budget. */
  budget_tokens: number;
  /** Per-section byte counts for observability. */
  sections: {
    notes: number;
    backlinks: number;
    dailies: number;
  };
  /** Top-K hit paths included in the bundle. */
  included_notes: string[];
}

/**
 * Token-budgeted vault context export — runs hybrid retrieval, gathers
 * note bodies + backlinks + recent dailies, packs to a token budget,
 * returns one ready-to-paste markdown blob.
 *
 * The MCP-native answer to Smart Connections' "Send to Smart Context"
 * pattern, but works in any chat (Claude / Cursor / Codex / web UI) by
 * producing a plain-text bundle. Saves the agent from orchestrating 5
 * separate tool calls.
 *
 * Budget enforcement: each note's body is truncated to ~50% of remaining
 * budget so room remains for backlinks + dailies; oversize bodies get a
 * `[…truncated…]` marker. As a final defense-in-depth, the assembled bundle
 * is hard-capped at `budget_tokens × 4` chars and marked `[…budget cap
 * reached…]` if truncated. Top-3 included notes get 1-line backlink
 * summaries when `include_backlinks` is true.
 *
 * @param vault - The vault.
 * @param args - {@link ContextPackArgs}. `query` required + non-empty.
 * @param ctx - Server-side context: `ftsIndex` (nullable) and `embedFile`
 *   (path may not exist) — same shape as {@link searchHybrid}.
 * @returns A {@link ContextPackResult} with the packed bundle + meta.
 * @throws {Error} If `query` is empty / whitespace-only.
 * @example
 * ```ts
 * const pack = await contextPack(
 *   vault,
 *   {
 *     query: "How do I tune the hybrid retrieval?",
 *     budget_tokens: 3000,
 *     include_backlinks: true,
 *     recent_dailies: 3
 *   },
 *   { ftsIndex, embedFile: "/path/to/vault.embed.db" }
 * );
 * console.log(pack.bundle); // ready to paste into any chat
 * ```
 */
export async function contextPack(
  vault: Vault,
  args: ContextPackArgs,
  ctx: { ftsIndex: FtsIndex | null; embedFile: string }
): Promise<ContextPackResult> {
  await vault.ensureExists();
  if (!args.query?.trim()) throw new Error("context_pack: `query` is required");
  const budget = args.budget_tokens ?? 4000;
  const charBudget = budget * 4; // ~4 chars/token
  const includeBacklinks = args.include_backlinks !== false;
  const recentN = Math.max(0, args.recent_dailies ?? 0);

  // 1) Hybrid retrieval — top-K notes
  const search = await searchHybrid(
    vault,
    { query: args.query, folder: args.folder, limit: 10 },
    { ftsIndex: ctx.ftsIndex, embedFile: ctx.embedFile }
  );

  const sections: string[] = [`# Context for: ${args.query}\n`];
  const includedNotes: string[] = [];
  let charsUsed = sections[0]?.length ?? 0;
  let notesBytes = 0;
  let backlinksBytes = 0;
  let dailiesBytes = 0;

  // 2) Pack note bodies until budget exhausted
  sections.push("## Top notes");
  for (const m of search.matches) {
    if (charsUsed >= charBudget) break;
    try {
      const note = await vault.readNote(vault.resolveInside(m.path), undefined);
      const body = note.parsed.body.trim();
      const headerLen = m.path.length + 5;
      const remaining = charBudget - charsUsed;
      // Truncate body to fit remaining budget for THIS note (~50% of remainder
      // so we leave room for backlinks + dailies).
      const noteCap = Math.min(body.length, Math.max(500, Math.floor(remaining * 0.5)));
      const trimmed = body.length <= noteCap ? body : `${body.slice(0, noteCap)}\n\n[…truncated…]`;
      const block = `### ${m.path}\n\n${trimmed}\n`;
      sections.push(block);
      charsUsed += block.length + headerLen;
      notesBytes += block.length;
      includedNotes.push(m.path);
    } catch {
      // skip unreadable notes
    }
  }

  // 3) 1-line backlink summaries for top-3
  if (includeBacklinks && includedNotes.length > 0 && charsUsed < charBudget) {
    sections.push("## Backlinks");
    let backlinksAdded = 0;
    for (const notePath of includedNotes.slice(0, 3)) {
      if (charsUsed >= charBudget) break;
      try {
        const links = await getBacklinks(vault, { path: notePath, limit: 5 });
        if (links.length > 0) {
          const block = `### → ${notePath}\n${links.map((l) => `- ${l.path} : ${(l.snippets[0] ?? "").slice(0, 80)}`).join("\n")}\n`;
          sections.push(block);
          charsUsed += block.length;
          backlinksBytes += block.length;
          backlinksAdded += links.length;
        }
      } catch {
        // skip
      }
    }
    if (backlinksAdded === 0) sections.pop(); // remove empty heading
  }

  // 4) Recent daily notes
  if (recentN > 0 && charsUsed < charBudget) {
    try {
      const recent = await getRecentEdits(vault, { since_minutes: 60 * 24 * 7, limit: recentN, folder: args.folder });
      const dailies = recent.filter((r) => /\d{4}-\d{2}-\d{2}/.test(r.path));
      if (dailies.length > 0) {
        sections.push(`## Recent (${dailies.length} dailies, last 7 days)`);
        for (const d of dailies) {
          if (charsUsed >= charBudget) break;
          const block = `- ${d.path} (${d.mtime})`;
          sections.push(block);
          charsUsed += block.length;
          dailiesBytes += block.length;
        }
      }
    } catch {
      // skip
    }
  }

  // v3.8.0-rc.6 R-4 — hard budget cap. The per-section checks above leave
  // small gaps (section headers like "## Top notes" aren't tracked, and
  // join("\n") overhead accumulates). Slice as defense-in-depth so the
  // returned bundle can never exceed the token budget regardless of those
  // small systematic underestimates.
  const raw = sections.join("\n");
  const bundle = raw.length > charBudget ? `${raw.slice(0, charBudget)}\n[…budget cap reached…]` : raw;
  return {
    query: args.query,
    bundle,
    estimated_tokens: Math.ceil(bundle.length / 4),
    budget_tokens: budget,
    sections: { notes: notesBytes, backlinks: backlinksBytes, dailies: dailiesBytes },
    included_notes: includedNotes
  };
}

// ─── small set / string helpers shared by find_similar / get_note_neighbors ─

/**
 * Compute the Jaccard similarity coefficient of two sets — `|A ∩ B| / |A ∪ B|`.
 *
 * Returns 0 for two empty sets (mathematically undefined; this convention
 * avoids NaN propagation in similarity score sums). Used by
 * {@link findSimilar}, {@link getNoteNeighbors}, and {@link searchHybrid}
 * for tag and co-backlink overlap computations.
 *
 * @internal
 * @param a - First set.
 * @param b - Second set.
 * @returns Similarity in `[0, 1]`. 1 means identical sets; 0 means disjoint
 *   or both empty.
 * @example
 * ```ts
 * jaccard(new Set([1, 2, 3]), new Set([2, 3, 4]));
 * // → 0.5  (intersection {2,3} over union {1,2,3,4})
 * ```
 */
export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Count elements present in both sets — `|A ∩ B|`.
 *
 * Cheaper than `new Set([...a].filter((x) => b.has(x))).size` when only
 * the count is needed (no intermediate set allocation). Used by
 * {@link findSimilar} for shared-outbound overlap percentage.
 *
 * @internal
 * @param a - First set.
 * @param b - Second set.
 * @returns Non-negative integer count of common elements.
 * @example
 * ```ts
 * intersectionSize(new Set([1, 2, 3]), new Set([2, 3, 4]));
 * // → 2
 * ```
 */
export function intersectionSize<T>(a: Set<T>, b: Set<T>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n += 1;
  return n;
}

/**
 * Build the character n-gram set of a string.
 *
 * Used by {@link findSimilar} for title 3-gram Jaccard similarity. Strings
 * shorter than `n` produce a single-element set containing the string
 * itself (so a 1-char title doesn't collapse to an empty signal).
 *
 * @internal
 * @param s - Input string.
 * @param n - N-gram length (typically 3 for title matching).
 * @returns Set of character n-grams. Empty only when `s` is empty.
 * @example
 * ```ts
 * ngrams("hello", 3);
 * // → Set { "hel", "ell", "llo" }
 * ngrams("a", 3);
 * // → Set { "a" }
 * ```
 */
export function ngrams(s: string, n: number): Set<string> {
  const out = new Set<string>();
  if (s.length < n) {
    if (s) out.add(s);
    return out;
  }
  for (let i = 0; i <= s.length - n; i++) out.add(s.slice(i, i + n));
  return out;
}

// Per-entries-array memo for the lookup indices findBestMatch needs. Keyed by
// the entries array reference so a fresh listMarkdown() result rebuilds the
// indices, but a hot loop calling findBestMatch repeatedly with the same
// `entries` argument shares one index. Closes the v1.2 bench finding that
// findBestMatch was the dominant cost in find_similar / get_note_neighbors /
// vault_stats / rename_note at 10k vaults (~2-3s p50 → ~50-200ms post-fix).
interface EntryIndex {
  byBasename: Map<string, FileEntry[]>;
  byRelPath: Map<string, FileEntry>;
  // v3.10.0-rc.72 (post-rc.70 re-sweep, DoS) — `/`-aligned path SUFFIX → first entry, for the
  // path-qualified `endsWith` fallback in findBestMatch. Keyed by foldKey(relPath) tails starting
  // at each internal `/` (segment index ≥ 1; the full path is the byRelPath case, not a `/…`
  // suffix). First-wins in `entries` order to preserve the old linear scan's result exactly.
  bySuffix: Map<string, FileEntry>;
}
const entryIndexCache = new WeakMap<FileEntry[], EntryIndex>();

/**
 * Build (or fetch from per-`entries`-array cache) the basename / relPath
 * lookup indices that `findBestMatch` needs.
 *
 * Cached via `WeakMap<FileEntry[], EntryIndex>` keyed by the entries array
 * reference: a fresh `listMarkdown()` result rebuilds the indices, but a
 * hot loop calling `findBestMatch` repeatedly with the same `entries`
 * argument shares one index. Closes the v1.2 bench finding that
 * `findBestMatch` was the dominant cost on 10k-note vaults
 * (~2-3s p50 → ~50-200ms post-fix).
 *
 * @internal
 * @param entries - File-entry array from `vault.listMarkdown()`.
 * @returns `{ byBasename, byRelPath }` — basename → entries (multi-value
 *   on collisions); relPath → entry (unique).
 */
/**
 * v3.10.0-rc.43 (G1) — canonical lookup key for wikilink/find_path resolution:
 * strip `.md`, Unicode-normalize to NFC, then case-fold. Both the index keys (built
 * here) and every query (in findBestMatch) MUST go through this, otherwise a `[[café]]`
 * link typed NFC never resolves to a `café.md` file whose name the OS returns in NFD
 * (macOS APFS returns NFD) — `"café"` (NFC) !== `"café"` (NFD) even after toLowerCase().
 * @internal
 */
function foldKey(s: string): string {
  return foldName(stripMd(s));
}

export function indexFor(entries: FileEntry[]): EntryIndex {
  const cached = entryIndexCache.get(entries);
  if (cached) return cached;
  const byBasename = new Map<string, FileEntry[]>();
  const byRelPath = new Map<string, FileEntry>();
  const bySuffix = new Map<string, FileEntry>();
  for (const e of entries) {
    const key = foldKey(e.basename);
    const slot = byBasename.get(key);
    if (slot) slot.push(e);
    else byBasename.set(key, [e]);
    const relKey = foldKey(e.relPath);
    byRelPath.set(relKey, e);
    // v3.10.0-rc.72 — index every `/`-aligned tail (segment index ≥ 1) so the path-qualified
    // `endsWith("/" + target)` fallback in findBestMatch is O(1) instead of an O(N) per-call scan
    // (the rc.67 validateNoteProposal amplifier sibling: K path-qualified broken links × N vault).
    // first-wins (don't overwrite) mirrors the old `for (const e of entries) … return e` order.
    const segs = relKey.split("/");
    for (let i = 1; i < segs.length; i++) {
      const suffix = segs.slice(i).join("/");
      if (!bySuffix.has(suffix)) bySuffix.set(suffix, e);
    }
  }
  const idx: EntryIndex = { byBasename, byRelPath, bySuffix };
  entryIndexCache.set(entries, idx);
  return idx;
}

/**
 * Resolve a wikilink target string to a concrete vault entry — the
 * Obsidian-style fuzzy matcher used by every link-traversal tool.
 *
 * Resolution priority:
 * 1. Relative paths (`./`, `../`) → resolve via `path.posix.normalize`
 *    against `fromNote`'s directory.
 * 2. Exact basename match. On collision, prefer the entry in `fromNote`'s
 *    directory; otherwise return the first.
 * 3. Path-qualified target → exact-relPath match, then `endsWith` fallback.
 *
 * Matches Obsidian's client-side link resolution closely enough that
 * agents and the desktop app agree on what `[[Target]]` points at.
 *
 * @internal
 * @param entries - File-entry array from `vault.listMarkdown()`.
 * @param target - Link target string (with or without `.md`).
 * @param fromNote - Source note's vault-relative path (biases resolution
 *   toward same folder; required for `./` / `../`).
 * @returns The resolved `FileEntry`, or null if no match.
 * @example
 * ```ts
 * const entries = await vault.listMarkdown();
 * findBestMatch(entries, "Foo");              // bare basename
 * findBestMatch(entries, "Sub/Foo", "X.md");  // path-qualified
 * findBestMatch(entries, "./Sibling", "Sub/X.md");  // relative
 * ```
 */
export function findBestMatch(entries: FileEntry[], target: string, fromNote?: string): FileEntry | null {
  const idx = indexFor(entries);

  if (target.startsWith("./") || target.startsWith("../") || target.includes("/../")) {
    if (fromNote) {
      const fromDir = path.dirname(fromNote);
      const joined = path.posix.normalize(path.posix.join(fromDir.split(path.sep).join("/"), target));
      const lower = foldKey(joined);
      const rel = idx.byRelPath.get(lower);
      if (rel) return rel;
    }
  }
  const norm = foldKey(target);
  const exact = idx.byBasename.get(norm) ?? [];
  if (exact.length === 1) return exact[0] ?? null;
  if (exact.length > 1 && fromNote) {
    const fromDir = path.dirname(fromNote);
    const sameDir = exact.find((e) => path.dirname(e.relPath) === fromDir);
    if (sameDir) return sameDir;
  }
  if (exact.length > 0) return exact[0] ?? null;
  if (target.includes("/")) {
    const lower = foldKey(target);
    const path1 = idx.byRelPath.get(lower);
    if (path1) return path1;
    // v3.10.0-rc.72 (post-rc.70 re-sweep, DoS) — path-qualified `endsWith` match via the O(1)
    // `bySuffix` index (was an O(N) `for (const e of entries)` scan per call). bySuffix keys are
    // `/`-aligned tails at segment index ≥ 1, so a hit is exactly the old `relPath.endsWith("/" +
    // lower)` (first-wins in entries order). Closes the rc.67 validateNoteProposal amplifier
    // sibling: a body of K distinct path-qualified broken `[[a/X]]` links no longer pays O(K × N).
    const sfx = idx.bySuffix.get(lower);
    if (sfx) return sfx;
  }
  return null;
}

/**
 * Strip a trailing `.md` extension (case-insensitive) from a filename or
 * basename.
 *
 * @internal
 * @param name - Filename or basename.
 * @returns The input with any trailing `.md` removed.
 * @example
 * ```ts
 * stripMd("Foo.md");   // → "Foo"
 * stripMd("Foo.MD");   // → "Foo"
 * stripMd("Foo.canvas"); // → "Foo.canvas" (only .md is stripped)
 * ```
 */
export function stripMd(name: string): string {
  return name.replace(/\.md$/i, "");
}

/**
 * Normalize a tag for comparison — strip leading `#` characters and
 * lowercase the rest.
 *
 * Used everywhere the toolkit compares tags ({@link listNotes},
 * {@link listTags}, {@link findSimilar}) to keep `#Draft` / `Draft` /
 * `#draft` / `DRAFT` all hashing to the same key.
 *
 * @internal
 * @param t - Tag string (with or without leading `#`).
 * @returns Lowercased, `#`-stripped tag.
 * @example
 * ```ts
 * normalizeTag("#Draft");   // → "draft"
 * normalizeTag("DRAFT");    // → "draft"
 * normalizeTag("##Idea");   // → "idea"
 * ```
 */
export function normalizeTag(t: string): string {
  // v3.11.0-rc.9 (L-TAG-1) — route through foldTag (strip `#` + NFC + lowercase)
  // so an NFD-on-disk accented tag matches its NFC query form (the rc.46 NFC
  // name-fold class, generalized to the tag identity surface).
  return foldTag(t);
}
