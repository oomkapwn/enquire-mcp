import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  checkpointEmbedDbForReplacement,
  discoverEmbedDbConfig,
  EmbedDb,
  type EmbedDbConfigDiscovery,
  hnswPersistBase
} from "./embed-db.js";
import { type EmbedSyncEvidence, syncEmbedDb, syncPdfEmbedDb } from "./embed-sync.js";
import { type Embedder, type EmbeddingModel, loadEmbedder } from "./embeddings.js";
import {
  clearHnswPersistedArtifactsWithEraser,
  preflightHnswPersistedArtifacts
} from "./hnsw.js";
import { PersistenceLeaseOwnershipError, resolvePersistenceLeaseScope } from "./persistence-lease.js";
import { EMBED_DB_SCHEMA_VERSION } from "./schema-contract.js";
import {
  SEMANTIC_PERSISTENCE_FAMILY_KEY,
  withEmbedReplacementStagePublisher,
  withSemanticPersistenceEraser
} from "./semantic-persistence.js";
import { preflightSqliteArtifactFamily, withPreparedSensitiveArtifact } from "./sensitive-artifact.js";
import type { Vault } from "./vault.js";
import { assertWatcherActivationGuardClear } from "./watcher-activation-guard.js";

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function assertStandaloneSqliteCandidate(file: string): Promise<void> {
  if (!(await preflightSqliteArtifactFamily(file))) {
    throw new Error("Staged embedding replacement disappeared before admission");
  }
  for (const sidecar of [`${file}-wal`, `${file}-shm`, `${file}-journal`]) {
    try {
      await fs.lstat(sidecar);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") continue;
      throw new Error("Staged embedding replacement sidecars could not be verified", { cause: error });
    }
    throw new Error("Staged embedding replacement is not a standalone SQLite generation");
  }
}

async function resolveCanonicalEmbedFile(file: string): Promise<string> {
  const scope = await resolvePersistenceLeaseScope({
    targetPath: file,
    familyKey: SEMANTIC_PERSISTENCE_FAMILY_KEY
  });
  return path.join(scope.canonicalParent, scope.targetName);
}

function candidateHasExactConfiguration(
  discovery: EmbedDbConfigDiscovery,
  vaultRoot: string,
  model: EmbeddingModel,
  quantization: "f32" | "int8"
): boolean {
  return (
    discovery.kind === "owned" &&
    discovery.meta.schema_version === String(EMBED_DB_SCHEMA_VERSION) &&
    discovery.meta.vault_root === vaultRoot &&
    discovery.meta.model_alias === model.alias &&
    discovery.meta.dim === String(model.dim) &&
    discovery.meta.quantization === quantization &&
    discovery.meta.instance_uuid !== undefined &&
    discovery.meta.mutation_epoch !== undefined
  );
}

function sameOwnedGeneration(left: EmbedDbConfigDiscovery, right: EmbedDbConfigDiscovery): boolean {
  return (
    left.kind === "owned" &&
    right.kind === "owned" &&
    left.meta.schema_version === right.meta.schema_version &&
    left.meta.vault_root === right.meta.vault_root &&
    left.meta.model_alias === right.meta.model_alias &&
    left.meta.dim === right.meta.dim &&
    left.meta.quantization === right.meta.quantization &&
    left.meta.instance_uuid === right.meta.instance_uuid &&
    left.meta.mutation_epoch === right.meta.mutation_epoch
  );
}

/** Reports produced by a successfully admitted staged embedding replacement. */
export interface EmbedReplacementReport {
  /** Complete replacement-grade Markdown synchronization evidence. */
  readonly markdown: EmbedSyncEvidence;
  /** Complete PDF evidence when the caller requested PDF embedding. */
  readonly pdf?: EmbedSyncEvidence;
}

/**
 * Decide whether opening the requested configuration would destructively
 * rebuild an existing owned EmbedDb. Missing/empty stores and same-config
 * historical schema upgrades keep their existing initialization paths.
 *
 * @param discovery - Fully admitted current EmbedDb configuration.
 * @param model - Resolved model requested or deliberately inherited by the CLI.
 * @param quantization - Requested or inherited on-disk vector encoding.
 * @returns `true` only for an owned model/dimension/quantization change.
 * @example
 * ```ts
 * if (embedConfigurationNeedsReplacement(discovery, model, "int8")) {
 *   // Build a complete sibling generation before touching the live database.
 * }
 * ```
 */
export function embedConfigurationNeedsReplacement(
  discovery: EmbedDbConfigDiscovery,
  model: EmbeddingModel,
  quantization: "f32" | "int8"
): boolean {
  if (discovery.kind !== "owned") return false;
  const storedQuantization = discovery.meta.quantization ?? "f32";
  return (
    discovery.meta.model_alias !== model.alias ||
    discovery.meta.dim !== String(model.dim) ||
    storedQuantization !== quantization
  );
}

/**
 * Load one catalog model and prove a real inference returns its declared vector
 * dimension before any caller may open a configuration-changing EmbedDb.
 *
 * @param model - Resolved catalog model.
 * @returns Loaded embedder after one deterministic smoke inference.
 * @throws If loading/inference fails or the returned vector shape is inconsistent.
 * @example
 * ```ts
 * const embedder = await loadValidatedEmbedder(resolveModel("multilingual"));
 * ```
 */
export async function loadValidatedEmbedder(model: EmbeddingModel): Promise<Embedder> {
  const embedder = await loadEmbedder(model.alias);
  const [smokeVector] = await embedder.embed(["hello"]);
  if (!smokeVector || smokeVector.length !== model.dim) {
    throw new Error(`Model ${model.alias} loaded but dim mismatch: ${smokeVector?.length} vs ${model.dim}`);
  }
  return embedder;
}

/**
 * Build a complete same-parent EmbedDb generation and publish it only after the
 * original live generation is re-proved under the semantic-family eraser.
 * Model/corpus/candidate failures discard only the private stage. Promotion
 * checkpoints the old SQLite WAL, invalidates its HNSW family, then performs one
 * atomic main-file rename as the commit point. One transient lease-release
 * failure receives an immediate exact retry. A persistent or unclassified
 * post-commit cleanup failure is reported explicitly as committed and must not
 * relabel that durable generation as an uncommitted, safely retryable build.
 *
 * @param opts - Exact live authority, replacement configuration, corpus policy, and loaded embedder.
 * @returns Complete Markdown/PDF reports for the generation that was published.
 * @throws If the candidate is incomplete, the live generation changed, a
 *   watcher guard appeared, HNSW cannot be invalidated, or publication fails.
 * @example
 * ```ts
 * const report = await replaceEmbeddingIndex({
 *   file,
 *   vault,
 *   expectedDiscovery,
 *   model,
 *   quantization: "f32",
 *   embedder
 * });
 * ```
 */
export async function replaceEmbeddingIndex(opts: {
  readonly file: string;
  readonly vault: Vault;
  readonly expectedDiscovery: EmbedDbConfigDiscovery;
  readonly model: EmbeddingModel;
  readonly quantization: "f32" | "int8";
  readonly embedder: Embedder;
  readonly includePdfs?: boolean;
  readonly lateChunkContext?: number;
}): Promise<EmbedReplacementReport> {
  if (opts.expectedDiscovery.kind !== "owned") {
    throw new Error("Embedding replacement requires one previously owned generation");
  }
  if (opts.embedder.model.alias !== opts.model.alias || opts.embedder.model.dim !== opts.model.dim) {
    throw new Error("Loaded embedder does not match the requested replacement configuration");
  }
  const finalFile = await resolveCanonicalEmbedFile(opts.file);
  let markdown: EmbedSyncEvidence | null = null;
  let pdf: EmbedSyncEvidence | undefined;
  let promotionCommitted = false;
  let committedReport: EmbedReplacementReport | null = null;
  try {
    return await withEmbedReplacementStagePublisher(finalFile, async () => {
      const expectedDiscovery = await discoverEmbedDbConfig(finalFile, opts.vault.root);
      if (!sameOwnedGeneration(expectedDiscovery, opts.expectedDiscovery)) {
        throw new Error("Embedding index configuration changed before staged replacement");
      }
      return withPreparedSensitiveArtifact(
        finalFile,
        async (stagedFile) => {
          const stagedDiscovery = await discoverEmbedDbConfig(stagedFile, opts.vault.root);
          if (stagedDiscovery.kind !== "empty") {
            throw new Error("Embedding replacement stage was not exclusively initialized");
          }
          const stagedDb = new EmbedDb({
            file: stagedFile,
            vaultRoot: opts.vault.root,
            modelAlias: opts.model.alias,
            dim: opts.model.dim,
            quantization: opts.quantization
          });
          await stagedDb.open(stagedDiscovery);
          try {
            markdown = await syncEmbedDb(opts.vault, stagedDb, opts.embedder, {
              mode: "replacement",
              lateChunkContext: opts.lateChunkContext ?? 0
            });
            if (opts.includePdfs) {
              pdf = await syncPdfEmbedDb(opts.vault, stagedDb, opts.embedder, {
                mode: "replacement",
                lateChunkContext: opts.lateChunkContext ?? 0
              });
            }
            stagedDb.checkpointForReplacement();
          } finally {
            await stagedDb.closeAndRelease();
          }
          await assertStandaloneSqliteCandidate(stagedFile);
          const admitted = await discoverEmbedDbConfig(stagedFile, opts.vault.root);
          if (!candidateHasExactConfiguration(admitted, opts.vault.root, opts.model, opts.quantization)) {
            throw new Error("Staged embedding replacement failed final configuration admission");
          }
        },
        async (prepared) => {
          const markdownReport = markdown;
          const pdfReport = pdf;
          if (!markdownReport?.complete || (opts.includePdfs && !pdfReport?.complete)) {
            throw new Error("Staged embedding replacement lacks complete corpus evidence");
          }
          const report: EmbedReplacementReport =
            pdfReport === undefined
              ? { markdown: markdownReport }
              : { markdown: markdownReport, pdf: pdfReport };
          committedReport = report;
          await withSemanticPersistenceEraser(finalFile, undefined, async (eraser) => {
            await assertWatcherActivationGuardClear(finalFile);
            await checkpointEmbedDbForReplacement(opts.vault.root, expectedDiscovery, eraser);
            const hnswFile = hnswPersistBase(finalFile);
            await preflightHnswPersistedArtifacts(hnswFile);
            await clearHnswPersistedArtifactsWithEraser(hnswFile, eraser);
            await prepared.commit();
            promotionCommitted = true;
          });
          return report;
        }
      );
    });
  } catch (error) {
    // The rename is the publication boundary. Retry one exact retained owner
    // from either the semantic eraser or the outer stage barrier. Persistent
    // ownership and unclassified terminal failures stay explicitly committed;
    // every precommit failure still propagates normally.
    if (!promotionCommitted) throw error;
    if (error instanceof PersistenceLeaseOwnershipError) {
      try {
        await error.debtOwner.release();
        if (committedReport) return committedReport;
      } catch (cleanupError) {
        const message =
          "Embedding replacement committed, but persistence coordination cleanup remains incomplete; " +
          "do not retry it as an uncommitted build";
        throw new Error(message, { cause: cleanupError });
      }
    }
    const message =
      "Embedding replacement committed, but persistence coordination cleanup failed; " +
      "do not retry it as an uncommitted build";
    throw new Error(message, { cause: error });
  }
}
