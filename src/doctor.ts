// Diagnostic + auto-setup for enquire-mcp.
//
// v2.11.0 — closes the biggest UX gap in the project: setup friction.
// Before this, getting full hybrid retrieval required 3 separate commands
// (`install-model` → `build-embeddings` → `serve --persistent-index`),
// and there was no quick way to see "is everything ready?" without
// triggering each codepath.
//
// Two new subcommands:
//
//   enquire-mcp doctor --vault <path>
//      Read-only health check. Lists every prerequisite for full hybrid
//      retrieval (vault path, optional deps, embedding model cache, FTS5
//      index, embed.db). Color-coded ✓ / ⚠ / ✗. Returns 0 if everything
//      is ready, 1 if any critical piece is missing.
//
//   enquire-mcp setup --vault <path>
//      Runs the install + build sequence in order, with progress messages
//      at each stage. Calls install-model + cold-build FTS5 + build-
//      embeddings under the hood. Idempotent — re-running on a fully
//      set-up vault is a no-op pass.
//
// Both are pure orchestration over existing CLI/library code — no new
// runtime deps, no schema changes. Same privacy filter applies (the
// doctor walks the vault via Vault.listMarkdown so excluded paths are
// hidden from its counts).

import { existsSync, promises as fs, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type EmbeddingModel, resolveTransformersCacheDir } from "./embeddings.js";
import { defaultIndexFile, FtsIndex, peekFtsMetaSafe } from "./fts5.js";
import { Vault } from "./vault.js";

/** Severity buckets surfaced in the diagnostic UI. */
export type CheckStatus = "ok" | "warn" | "missing" | "error";

export interface DoctorCheck {
  /** Stable id for programmatic consumers (e.g. JSON output). */
  id: string;
  /** Human-readable label (rendered next to the status icon). */
  label: string;
  status: CheckStatus;
  /** Optional detail line printed below the label. */
  detail?: string;
  /** Optional hint — usually the command that fixes it. */
  hint?: string;
}

export interface DoctorResult {
  vault: string;
  /** True iff every `missing`/`error` check is absent (`warn` is OK). */
  ready: boolean;
  checks: DoctorCheck[];
  /** Tally for quick consumer reporting. */
  summary: { ok: number; warn: number; missing: number; error: number };
}

/** Simple ANSI color helpers — autodetect TTY so piped output stays clean. */
const isTty = process.stdout.isTTY === true;
const c = {
  green: (s: string) => (isTty ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (isTty ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (isTty ? `\x1b[31m${s}\x1b[0m` : s),
  dim: (s: string) => (isTty ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (isTty ? `\x1b[1m${s}\x1b[0m` : s)
};

/** Render one DoctorCheck to a multi-line string. */
export function formatCheck(check: DoctorCheck): string {
  const icon =
    check.status === "ok"
      ? c.green("✓")
      : check.status === "warn"
        ? c.yellow("⚠")
        : check.status === "missing"
          ? c.red("✗")
          : c.red("✗");
  const lines: string[] = [`${icon}  ${check.label}`];
  if (check.detail) lines.push(c.dim(`   ${check.detail}`));
  if (check.hint && check.status !== "ok") lines.push(c.dim(`   → ${check.hint}`));
  return lines.join("\n");
}

/** Render a full DoctorResult to a banner string. */
export function formatDoctorResult(result: DoctorResult): string {
  const lines: string[] = [];
  lines.push(c.bold(`enquire-mcp doctor — ${result.vault}`));
  lines.push("");
  for (const check of result.checks) lines.push(formatCheck(check));
  lines.push("");
  const { ok, warn, missing, error } = result.summary;
  const verdict = result.ready
    ? c.green(`READY — all critical checks pass (${ok} ok, ${warn} warnings)`)
    : c.red(`NOT READY — ${missing + error} missing/error, ${warn} warnings, ${ok} ok`);
  lines.push(verdict);
  return lines.join("\n");
}

/**
 * Candidate locations where transformers.js may have cached embedding model
 * weights. We probe all of them and report `ok` if any contains data.
 *
 * Why multiple paths:
 *   - transformers.js v3+ default: `<package>/.cache/Xenova/...` (lives
 *     inside `node_modules/@huggingface/transformers/.cache`, the
 *     library's own cache dir relative to its install location).
 *   - Older HuggingFace Hub convention: `~/.cache/huggingface/...`.
 *   - macOS XDG override: `~/Library/Caches/huggingface/...`.
 *   - Custom env var: HF_HOME or TRANSFORMERS_CACHE if the user set them.
 *
 * We don't try to load transformers.js to read `env.cacheDir` — that
 * would defeat the doctor's "fast read-only health check" promise on
 * users who haven't installed the optional dep at all.
 */
export function candidateModelCacheRoots(): string[] {
  const candidates: string[] = [];
  // 1. transformers.js v3+ default — its OWN package `.cache`, resolved
  //    RELATIVE TO THIS MODULE (via createRequire, not cwd). This is the path
  //    transformers.js actually loads from, and the ONLY one correct for a
  //    global `npm i -g` install (the model lives in the package's nested
  //    node_modules, not under cwd). v3.10.0-rc.12 — bug-report Issue 1: the
  //    prior cwd-based probe missed it entirely → false NOT READY on a
  //    fully-working global install. Resolution-only (no ONNX load).
  const pkgCache = resolveTransformersCacheDir();
  if (pkgCache) candidates.push(pkgCache);
  // 1b. cwd-relative fallback — covers local-dev / npx layouts where the
  //     module-relative resolve above differs from the user's project tree.
  //     If transformers.js isn't installed, this just won't exist on disk.
  candidates.push(path.join(process.cwd(), "node_modules", "@huggingface", "transformers", ".cache"));
  // 2. HuggingFace Hub conventions.
  if (process.env.HF_HOME) candidates.push(path.join(process.env.HF_HOME, "hub"));
  if (process.env.TRANSFORMERS_CACHE) candidates.push(process.env.TRANSFORMERS_CACHE);
  candidates.push(path.join(os.homedir(), ".cache", "huggingface", "transformers.js"));
  candidates.push(path.join(os.homedir(), ".cache", "huggingface"));
  // 3. macOS XDG-ish convention.
  if (process.platform === "darwin") {
    candidates.push(path.join(os.homedir(), "Library", "Caches", "huggingface"));
  }
  return candidates;
}

/**
 * Default `.embed.db` location for a given vault root — same convention as
 * the rest of the codebase. Mirrors `embedDbPath` in src/index.ts.
 */
function defaultEmbedDbFile(vaultRoot: string): string {
  return defaultIndexFile(vaultRoot).replace(/\.fts5\.db$/, ".embed.db");
}

/**
 * Probe whether an optional dep is loadable in this process. Uses a
 * dynamic import inside a try/catch so we never crash the diagnostic
 * on a missing or broken native binding.
 */
async function probeOptionalDep(spec: string): Promise<boolean> {
  try {
    await import(spec);
    return true;
  } catch {
    return false;
  }
}

export interface RunDoctorOptions {
  vault: string;
  /** Override default cache root (mostly for tests). */
  modelCacheRoot?: string;
  /** Override default embed-db location. */
  embedFile?: string;
  /** Override default FTS5 index location. */
  indexFile?: string;
  /** Default model alias to check for (matches DEFAULT_MODEL_ALIAS). */
  modelAlias?: string;
  /**
   * Embedding-model catalog entry — passed in to avoid pulling
   * `@huggingface/transformers` into this module. Caller resolves it via
   * `resolveModel(alias)` from src/embeddings.ts.
   */
  modelEntry?: EmbeddingModel;
  /**
   * v3.9.0-rc.16 (P2-12) — privacy denylist, same semantics as `serve`'s
   * `--exclude-glob`. When set, the doctor walks the vault WITH the filter so
   * its counts + "privacy filter" claim reflect reality (pre-rc.16 it always
   * walked unfiltered yet labeled the count "privacy filter applied").
   */
  excludeGlobs?: string[];
  /**
   * v3.9.0-rc.16 (P2-12) — privacy allowlist, same semantics as `serve`'s
   * `--read-paths`.
   */
  readPaths?: string[];
}

/**
 * Run all the diagnostic checks. Pure data — caller decides how to
 * render (CLI banner, JSON, MCP tool response).
 */
export async function runDoctor(opts: RunDoctorOptions): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];

  // v3.9.0-rc.16 (P2-12) — build the Vault WITH the user's privacy filters so
  // the counts below reflect what tools actually see. The constructor fails
  // closed on empty-after-trim globs; catch that so a bad pattern surfaces as
  // a doctor error instead of crashing the whole diagnostic, then fall back
  // to an unfiltered vault so the remaining checks still run.
  const wantsPrivacy = (opts.excludeGlobs?.length ?? 0) > 0 || (opts.readPaths?.length ?? 0) > 0;
  let vault: Vault;
  let privacyActive = false;
  try {
    vault = new Vault(opts.vault, {
      ...(opts.excludeGlobs ? { excludeGlobs: opts.excludeGlobs } : {}),
      ...(opts.readPaths ? { readPaths: opts.readPaths } : {})
    });
    privacyActive = wantsPrivacy;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({
      id: "privacy",
      label: "Privacy filter configuration",
      status: "error",
      detail: msg,
      hint: "Fix or remove the offending --exclude-glob / --read-paths pattern"
    });
    vault = new Vault(opts.vault);
  }
  if (privacyActive) {
    checks.push({
      id: "privacy",
      label: "Privacy filter active",
      status: "ok",
      detail: `${opts.excludeGlobs?.length ?? 0} exclude-glob denylist · ${opts.readPaths?.length ?? 0} read-path allowlist pattern(s)`
    });
  }

  // 1. Vault path exists + is readable.
  let vaultExists = false;
  try {
    await vault.ensureExists();
    vaultExists = true;
    const noteCount = (await vault.listMarkdown()).length;
    const pdfCount = (await vault.listFilesByExtension(".pdf")).length;
    const canvasCount = (await vault.listFilesByExtension(".canvas")).length;
    checks.push({
      id: "vault",
      label: `Vault accessible at ${opts.vault}`,
      status: "ok",
      detail: `${noteCount} markdown · ${pdfCount} pdf · ${canvasCount} canvas${privacyActive ? " (after privacy filter)" : ""}`
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({
      id: "vault",
      label: `Vault path ${opts.vault}`,
      status: "error",
      detail: msg,
      hint: "Check the path exists and is a directory"
    });
  }

  // 2. better-sqlite3 — gates --persistent-index + ML embed-db.
  const hasSqlite = await probeOptionalDep("better-sqlite3");
  checks.push({
    id: "dep:better-sqlite3",
    label: "better-sqlite3 (FTS5 BM25 + embedding store)",
    status: hasSqlite ? "ok" : "missing",
    detail: hasSqlite ? "loaded; native binding works" : undefined,
    hint: hasSqlite ? undefined : "npm install better-sqlite3 (or remove --omit=optional from your install)"
  });

  // 3. @huggingface/transformers — gates ML embeddings + reranker.
  const hasTransformers = await probeOptionalDep("@huggingface/transformers");
  checks.push({
    id: "dep:transformers",
    label: "@huggingface/transformers (ML embeddings + cross-encoder reranker)",
    status: hasTransformers ? "ok" : "missing",
    detail: hasTransformers ? "loaded; ONNX runtime available" : undefined,
    hint: hasTransformers ? undefined : "npm install @huggingface/transformers"
  });

  // 4. pdfjs-dist — gates obsidian_read_pdf + PDF retrieval.
  const hasPdfjs = await probeOptionalDep("pdfjs-dist/legacy/build/pdf.mjs");
  checks.push({
    id: "dep:pdfjs",
    label: "pdfjs-dist (PDF read + indexing)",
    status: hasPdfjs ? "ok" : "warn",
    detail: hasPdfjs ? "loaded" : "PDFs in vault won't be indexable",
    hint: hasPdfjs ? undefined : "npm install pdfjs-dist@^6.0.227 (skip if you have no PDFs)"
  });

  // 5. tesseract.js + @napi-rs/canvas — gates obsidian_ocr_pdf.
  const [hasTesseract, hasCanvas] = await Promise.all([
    probeOptionalDep("tesseract.js"),
    probeOptionalDep("@napi-rs/canvas")
  ]);
  if (hasTesseract && hasCanvas) {
    checks.push({
      id: "dep:ocr",
      label: "tesseract.js + @napi-rs/canvas (OCR for scanned PDFs)",
      status: "ok",
      detail: "both loaded; PDF OCR ready"
    });
  } else {
    checks.push({
      id: "dep:ocr",
      label: "tesseract.js + @napi-rs/canvas (OCR for scanned PDFs)",
      status: "warn",
      detail: `tesseract.js=${hasTesseract ? "ok" : "missing"} · canvas=${hasCanvas ? "ok" : "missing"}`,
      hint: "npm install tesseract.js @napi-rs/canvas (skip if you have no scanned PDFs)"
    });
  }

  // 6. Embedding model cache — does the user have weights downloaded?
  // Probe every candidate path; whichever has Xenova-style model dirs
  // wins. Fall back to "missing" only if every candidate is empty/absent.
  const cacheRoots = opts.modelCacheRoot ? [opts.modelCacheRoot] : candidateModelCacheRoots();
  let foundCacheRoot: string | null = null;
  let cachedCount = 0;
  let cacheBytes = 0;
  for (const cacheRoot of cacheRoots) {
    if (!existsSync(cacheRoot)) continue;
    try {
      // Look for at least one Xenova/* directory or any direct model dir
      // (transformers.js stores models as `Xenova/<model-id>`).
      const xenovaPath = path.join(cacheRoot, "Xenova");
      if (existsSync(xenovaPath)) {
        const sub = await fs.readdir(xenovaPath, { withFileTypes: true });
        const models = sub.filter((e) => e.isDirectory());
        if (models.length > 0) {
          foundCacheRoot = cacheRoot;
          cachedCount = models.length;
          // Best-effort size sum — bounded per model dir.
          for (const m of models) {
            try {
              const files = await fs.readdir(path.join(xenovaPath, m.name));
              for (const f of files) {
                try {
                  cacheBytes += statSync(path.join(xenovaPath, m.name, f)).size;
                } catch {
                  /* skip */
                }
              }
            } catch {
              /* skip */
            }
          }
          break;
        }
      }
    } catch {
      /* try next candidate */
    }
  }
  if (foundCacheRoot && cachedCount > 0) {
    checks.push({
      id: "model:cache",
      label: "Embedding model cache",
      status: "ok",
      detail: `${cachedCount} model(s) cached under ${foundCacheRoot}/Xenova/ (~${Math.round(cacheBytes / 1024 / 1024)} MB)`
    });
  } else {
    checks.push({
      id: "model:cache",
      label: "Embedding model cache",
      status: "missing",
      detail: "no Xenova model weights found in any standard cache location",
      hint: opts.modelEntry
        ? `enquire-mcp install-model ${opts.modelEntry.alias}  (~${opts.modelEntry.approxSizeMB} MB)`
        : "enquire-mcp install-model multilingual"
    });
  }

  // 7. FTS5 index — does the persistent index exist for this vault?
  if (vaultExists) {
    const indexFile = opts.indexFile ?? defaultIndexFile(vault.root);
    if (existsSync(indexFile) && hasSqlite) {
      // v3.6.2 K-1b — `doctor` is a DIAGNOSTIC subcommand. It must NEVER
      // cause side effects. Pre-fix: opening FtsIndex with default tokenize
      // "unicode61" against an index built with "trigram" would fire the
      // bootstrapSchema DROP TABLE path — `doctor --vault X` would silently
      // destroy the user's FTS5 index. Peek tokenize_mode first; honor it.
      // External audit on v3.6.1 caught this as a sibling of K-1.
      const peeked = await peekFtsMetaSafe(indexFile);
      const honoredTokenize = peeked?.tokenize_mode ?? "unicode61";
      // Open + close to count files/chunks. If something's off, surface it
      // as a warn (not missing — caller can still serve without the index).
      try {
        const idx = new FtsIndex({ file: indexFile, vaultRoot: vault.root, tokenize: honoredTokenize });
        await idx.open();
        const totalFiles = idx.totalFiles();
        const totalChunks = idx.totalChunks();
        idx.close();
        checks.push({
          id: "index:fts5",
          label: "FTS5 BM25 index",
          status: "ok",
          detail: `${indexFile} — ${totalFiles} files / ${totalChunks} chunks`
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        checks.push({
          id: "index:fts5",
          label: "FTS5 BM25 index",
          status: "warn",
          detail: `${indexFile} present but failed to open: ${msg}`,
          hint: `enquire-mcp clear-index --vault ${opts.vault} && enquire-mcp index --vault ${opts.vault}`
        });
      }
    } else {
      checks.push({
        id: "index:fts5",
        label: "FTS5 BM25 index",
        status: "warn",
        detail: hasSqlite ? `${indexFile} not built` : "needs better-sqlite3 first",
        hint: hasSqlite ? `enquire-mcp index --vault ${opts.vault}` : "install better-sqlite3 first"
      });
    }
  }

  // 8. Embedding index — does the .embed.db exist for this vault?
  if (vaultExists) {
    const embedFile = opts.embedFile ?? defaultEmbedDbFile(vault.root);
    if (existsSync(embedFile) && hasSqlite && hasTransformers) {
      // Don't open the file (loading the model is expensive); just stat it
      // and rely on the existence + size check.
      try {
        const sz = statSync(embedFile).size;
        checks.push({
          id: "index:embed",
          label: "Embedding index (.embed.db)",
          status: "ok",
          detail: `${embedFile} — ${(sz / 1024 / 1024).toFixed(1)} MB`
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        checks.push({
          id: "index:embed",
          label: "Embedding index (.embed.db)",
          status: "warn",
          detail: msg,
          hint: `enquire-mcp clear-embeddings --vault ${opts.vault} && enquire-mcp build-embeddings --vault ${opts.vault}`
        });
      }
    } else {
      const blockers: string[] = [];
      if (!hasSqlite) blockers.push("better-sqlite3");
      if (!hasTransformers) blockers.push("@huggingface/transformers");
      checks.push({
        id: "index:embed",
        label: "Embedding index (.embed.db)",
        status: "warn",
        detail:
          blockers.length > 0
            ? `blocked on: ${blockers.join(", ")}`
            : `${embedFile} not built — semantic-search-only path will use TF-IDF cosine`,
        hint:
          blockers.length > 0
            ? `npm install ${blockers.join(" ")}`
            : `enquire-mcp build-embeddings --vault ${opts.vault}`
      });
    }
  }

  // Tally the summary.
  const summary = { ok: 0, warn: 0, missing: 0, error: 0 };
  for (const ch of checks) summary[ch.status] += 1;
  // "ready" means: no missing or error. Warnings are advisory — you can
  // still serve a useful subset of the surface (e.g. without ML embeddings).
  const ready = summary.missing === 0 && summary.error === 0;

  return { vault: opts.vault, ready, checks, summary };
}
