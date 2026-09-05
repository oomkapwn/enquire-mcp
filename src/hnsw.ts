// HNSW (Hierarchical Navigable Small World) vector index for enquire-mcp.
//
// v2.13.0 — closes the "brute-force semantic search doesn't scale" gap. The
// existing path in `EmbedDb.search()` runs O(n) cosine over every embedded
// chunk per query. HNSW is the IR-standard graph-based index for approximate
// nearest-neighbor lookup. Real latency and recall depend on corpus shape,
// hardware, and the search/build parameters; benchmark the target vault.
//
// Architecture: in-memory rebuild on serve start.
//
// Persistence: SHIPPED in v2.16.0. Current storage uses immutable
// `.hnsw.<nonce>.bin` generations + a meta-last `.hnsw.meta.json` pointer next
// to `.embed.db`. Staleness check via `EmbedDb.computeSignature`.
// The compact format-4 pointer is capped at 64 KiB; immutable native
// generations are capped at 1 GiB on both publication and load. Writer peak
// memory remains proportional to the in-memory graph during native
// serialization; these byte caps are not a constant-memory save claim. An
// oversize snapshot stays usable in memory but is rebuilt rather than
// persisted/reloaded through an unbounded read allocation.
// Reload additionally caps the combined native allocation, caller + detached
// DB-canonical vectors, worst-case encoded BLOBs, row metadata/text, and fixed
// runtime headroom at 1 GiB before native import.
// Default on for `--use-hnsw`; opt out with `--no-hnsw-persist`.
// See `loadHnswFromDisk` + `saveTo` below for the WAL-style consistency
// handling. The in-memory-only fallback path is still here (when the
// persistence flag is off OR the sidecar files are missing/stale).
//
// Historical note (v3.7.6 audit cleanup): early prototypes considered
// `hnswlib-wasm` (Emscripten port) but its virtual-FS persistence
// model added complexity vs. host-disk for our use case. Final choice
// is `hnswlib-node` (native N-API binding to C++ hnswlib reference
// impl) which writes directly to host disk and is the production-grade
// path for server-side vault retrieval.
//
// Native dep: `hnswlib-node@^3.0` (Node-N-API binding to the C++ hnswlib
// reference impl). Native availability depends on the host platform/ABI;
// npm is allowed to omit an optional dependency whose native install fails.
// Lazy-loaded — same `optionalDependencies` pattern as tesseract.js /
// pdfjs-dist / @huggingface/transformers.
//
// (See "Historical note" above re: hnswlib-wasm vs hnswlib-node choice.)
//
// Users tuning for recall can pass `--hnsw-ef` to widen the search
// beam (default 100; higher is generally more accurate and slower).

import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { EmbedReceiptSearchHit, EmbedSearchHit } from "./embed-db.js";
import { removeArtifact } from "./erasure-receipt.js";
import { importOptionalDependency, optionalDepDetail } from "./optional-dep.js";
import {
  acquirePersistenceFamilyLease,
  acquirePersistenceFamilyLeaseInScopes,
  type PersistenceFamilyLeaseHandle,
  type PersistenceFamilyScopes
} from "./persistence-coordination.js";
import { assertHnswFilePath } from "./persistence-path.js";
import {
  type ActiveSemanticPersistenceEraser,
  defaultEmbedDbAuthorityForHnsw,
  hnswPathInSemanticScopes,
  SEMANTIC_PERSISTENCE_FAMILY_KEY,
  scopesFromActiveSemanticEraser
} from "./semantic-persistence.js";
import {
  inspectSensitiveArtifact,
  preflightSensitiveArtifactTempEntry,
  publishSensitiveArtifact,
  readSensitiveArtifactText,
  removeSensitiveArtifactTempEntry,
  sameCanonicalDirectoryEntry,
  sensitiveArtifactFinalBasename,
  sha256SensitiveArtifact
} from "./sensitive-artifact.js";

const HNSW_META_FORMAT_VERSION = 4;
const HNSW_GENERATION_TOKEN_BYTES = 24;
const MAX_HNSW_META_BYTES = 64 * 1024;
const LEGACY_MAX_HNSW_META_BYTES = 256 * 1024 * 1024;
const MAX_HNSW_GENERATION_BYTES = 1024 * 1024 * 1024;
const HNSW_NATIVE_UINT32_MAX = 0xffff_ffff;
const MAX_HNSW_DIM = 65_536;
const HNSW_NATIVE_HEADER_BYTES = 96;
const HNSW_NATIVE_LABEL_BYTES = 8n;
const HNSW_NATIVE_FLOAT_BYTES = 4n;
const HNSW_NATIVE_TABLEINT_BYTES = 4n;
const HNSW_NATIVE_LINKLIST_SIZE_BYTES = 4n;
const HNSW_NATIVE_DELETE_FLAG = 0x0001_0000;
const HNSW_NATIVE_RESERVED_FLAG_MASK = 0xfffe_0000;
const HNSW_NATIVE_UPPER_FLAG_MASK = 0xffff_0000;
const HNSW_NATIVE_PER_ELEMENT_HEADROOM_BYTES = 256n;
const HNSW_NATIVE_FIXED_HEADROOM_BYTES = 8n * 1024n * 1024n;
const MAX_HNSW_NATIVE_ALLOCATION_BYTES = BigInt(MAX_HNSW_GENERATION_BYTES);
const MAX_HNSW_COMBINED_WORKING_SET_BYTES = 1024n * 1024n * 1024n;
const HNSW_COMBINED_NON_NATIVE_FIXED_HEADROOM_BYTES = 56n * 1024n * 1024n;
const HNSW_TRUSTED_METADATA_PER_ROW_BYTES = 512n;
const HNSW_VECTOR_NORM_TOLERANCE = 1e-3;
const HNSW_DB_VECTOR_COMPONENT_TOLERANCE = 2e-6;
const HNSW_DB_VECTOR_L2_TOLERANCE = 1e-5;
const MAX_HNSW_M = 10_000;
const MAX_HNSW_LEVEL = 64;
const MIN_HNSW_TOMBSTONE_HEADROOM = 1024;
const HNSW_GENERATION_TOKEN_PATTERN = /^[0-9a-f]{48}(?![\s\S])/;
const SHA256_PATTERN = /^[0-9a-f]{64}(?![\s\S])/;
const DB_INSTANCE_UUID_PATTERN = /^[0-9a-f]{32}(?![\s\S])/;
const LEGACY_HNSW_DB_INSTANCE_UUID = "00000000000000000000000000000000";
const LEGACY_HNSW_DB_MUTATION_EPOCH = 1;
const HNSW_PERSISTED_ROW_KEYS = ["rel_path", "chunk_index", "line_start", "line_end", "text_preview", "kind"] as const;
const MAX_HNSW_PERSISTED_PATH_BYTES = 4096;
const MAX_HNSW_PERSISTED_PREVIEW_BYTES = 64 * 1024;

function isHnswNativeInteger(value: unknown, minimum: number, maximum = HNSW_NATIVE_UINT32_MAX): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function assertHnswNativeInteger(
  label: string,
  value: unknown,
  minimum: number,
  maximum = HNSW_NATIVE_UINT32_MAX
): void {
  if (!isHnswNativeInteger(value, minimum, maximum)) {
    throw new TypeError(`${label} must be a safe integer in [${minimum}, ${maximum}]`);
  }
}

function maxAdmittedHnswElements(activeRows: number): number {
  if (activeRows > Math.floor(HNSW_NATIVE_UINT32_MAX / 2)) return HNSW_NATIVE_UINT32_MAX;
  return Math.max(MIN_HNSW_TOMBSTONE_HEADROOM, activeRows * 2);
}

interface AdmittedHnswNativeHeader {
  currentCount: number;
  maxElements: number;
  m: number;
  estimatedNativeAllocationBytes: bigint;
  sha256: string;
  nativeSnapshotPath: string;
  nativeSnapshotDirectory: string;
  nativeSnapshotIdentity: Readonly<{ dev: bigint; ino: bigint }>;
  nativeSnapshotDirectoryIdentity: Readonly<{ dev: bigint; ino: bigint }>;
}

function sameHnswSnapshotIdentity(
  actual: Readonly<{ dev: bigint; ino: bigint }>,
  expected: Readonly<{ dev: bigint; ino: bigint }>
): boolean {
  return actual.dev === expected.dev && actual.ino === expected.ino && actual.ino > 0n;
}

async function removeHnswNativeSnapshot(snapshot: AdmittedHnswNativeHeader): Promise<void> {
  const directory = await fs.lstat(snapshot.nativeSnapshotDirectory, { bigint: true }).catch(() => null);
  if (
    !directory ||
    directory.isSymbolicLink() ||
    !directory.isDirectory() ||
    !sameHnswSnapshotIdentity(directory, snapshot.nativeSnapshotDirectoryIdentity)
  ) {
    return;
  }
  const file = await fs.lstat(snapshot.nativeSnapshotPath, { bigint: true }).catch(() => null);
  if (file?.isFile() && !file.isSymbolicLink() && sameHnswSnapshotIdentity(file, snapshot.nativeSnapshotIdentity)) {
    await fs.unlink(snapshot.nativeSnapshotPath);
  }
  if ((await fs.readdir(snapshot.nativeSnapshotDirectory)).length === 0) {
    await fs.rmdir(snapshot.nativeSnapshotDirectory);
  }
}

function estimatedHnswAllocationBytes(maxElements: number, dim: number, m: number): bigint {
  const level0Bytes =
    BigInt(m) * 2n * HNSW_NATIVE_TABLEINT_BYTES +
    HNSW_NATIVE_LINKLIST_SIZE_BYTES +
    BigInt(dim) * HNSW_NATIVE_FLOAT_BYTES +
    HNSW_NATIVE_LABEL_BYTES;
  return (
    HNSW_NATIVE_FIXED_HEADROOM_BYTES + BigInt(maxElements) * (level0Bytes + HNSW_NATIVE_PER_ELEMENT_HEADROOM_BYTES)
  );
}

function assertHnswAllocationEnvelope(label: string, maxElements: number, dim: number, m: number): void {
  if (estimatedHnswAllocationBytes(maxElements, dim, m) > MAX_HNSW_NATIVE_ALLOCATION_BYTES) {
    throw new RangeError(`${label} exceeds the practical ${MAX_HNSW_GENERATION_BYTES}-byte native allocation envelope`);
  }
}

async function readHeldBytes(
  handle: import("node:fs/promises").FileHandle,
  length: number,
  position: number
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) throw new Error("HNSW native generation ended before its declared geometry");
    filled += bytesRead;
  }
  return buffer;
}

async function preflightHnswNativeGeneration(
  file: string,
  expectedDim: number,
  expectedCount: number,
  maxElementsHeadroom: number,
  expectedLiveLabels: ReadonlySet<number>,
  expectedVectorsByLabel: ReadonlyMap<number, Float32Array>
): Promise<AdmittedHnswNativeHeader> {
  let admittedSnapshot: AdmittedHnswNativeHeader | null = null;
  try {
    return await inspectSensitiveArtifact(file, MAX_HNSW_GENERATION_BYTES, async (handle, fileSize) => {
      const headerBytes = BigInt(HNSW_NATIVE_HEADER_BYTES);
      if (fileSize < headerBytes) throw new Error("HNSW native generation has a truncated v3 header");
      const header = await readHeldBytes(handle, HNSW_NATIVE_HEADER_BYTES, 0);
      const offsetLevel0 = header.readBigUInt64LE(0);
      const maxElements = header.readBigUInt64LE(8);
      const currentCount = header.readBigUInt64LE(16);
      const sizeDataPerElement = header.readBigUInt64LE(24);
      const labelOffset = header.readBigUInt64LE(32);
      const offsetData = header.readBigUInt64LE(40);
      const maxLevel = header.readInt32LE(48);
      const entrypointNode = header.readUInt32LE(52);
      const maxM = header.readBigUInt64LE(56);
      const maxM0 = header.readBigUInt64LE(64);
      const m = header.readBigUInt64LE(72);
      const mult = header.readDoubleLE(80);
      const efConstruction = header.readBigUInt64LE(88);

      const expectedCountBig = BigInt(expectedCount);
      const expectedDimBig = BigInt(expectedDim);
      const headroomBig = BigInt(maxElementsHeadroom);
      if (
        offsetLevel0 !== 0n ||
        currentCount !== expectedCountBig ||
        maxElements < 1n ||
        currentCount > maxElements ||
        maxElements > headroomBig
      ) {
        throw new Error("HNSW native generation has an inadmissible count or capacity");
      }
      if (m < 2n || m > BigInt(MAX_HNSW_M) || maxM !== m || maxM0 !== m * 2n) {
        throw new Error("HNSW native generation has inconsistent M geometry");
      }
      const sizeLinksLevel0 = maxM0 * HNSW_NATIVE_TABLEINT_BYTES + HNSW_NATIVE_LINKLIST_SIZE_BYTES;
      const expectedOffsetData = sizeLinksLevel0;
      const expectedLabelOffset = expectedOffsetData + expectedDimBig * HNSW_NATIVE_FLOAT_BYTES;
      const expectedSizeData = expectedLabelOffset + HNSW_NATIVE_LABEL_BYTES;
      if (
        offsetData !== expectedOffsetData ||
        labelOffset !== expectedLabelOffset ||
        sizeDataPerElement !== expectedSizeData
      ) {
        throw new Error("HNSW native generation has inconsistent vector/label offsets");
      }
      const expectedMult = 1 / Math.log(Number(m));
      const multTolerance = Math.max(1, Math.abs(expectedMult)) * 1e-12;
      if (!Number.isFinite(mult) || mult <= 0 || Math.abs(mult - expectedMult) > multTolerance) {
        throw new Error("HNSW native generation has an inconsistent level multiplier");
      }
      if (efConstruction < m || efConstruction > BigInt(HNSW_NATIVE_UINT32_MAX)) {
        throw new Error("HNSW native generation has an inadmissible construction beam");
      }
      if (currentCount === 0n) {
        if (maxLevel !== -1 || entrypointNode !== HNSW_NATIVE_UINT32_MAX) {
          throw new Error("HNSW empty native generation has an invalid entrypoint");
        }
      } else if (maxLevel < 0 || maxLevel > MAX_HNSW_LEVEL || BigInt(entrypointNode) >= currentCount) {
        throw new Error("HNSW native generation has an invalid level or entrypoint");
      }

      let estimatedNativeAllocation =
        HNSW_NATIVE_FIXED_HEADROOM_BYTES +
        maxElements * (sizeDataPerElement + HNSW_NATIVE_PER_ELEMENT_HEADROOM_BYTES) +
        currentCount * 2n; // two byte-per-element upper-level validation manifests below
      if (estimatedNativeAllocation > MAX_HNSW_NATIVE_ALLOCATION_BYTES) {
        throw new Error("HNSW native generation exceeds the practical allocation envelope");
      }

      const level0End = headerBytes + currentCount * sizeDataPerElement;
      if (level0End > fileSize) throw new Error("HNSW native generation has a truncated level-0 region");
      const externalLabels = new Set<number>();
      const liveLabels = new Set<number>();
      const recordBytes = Number(sizeDataPerElement);
      const vectorOffset = Number(offsetData);
      const externalLabelOffset = Number(labelOffset);
      for (let element = 0n; element < currentCount; element += 1n) {
        const recordStart = headerBytes + element * sizeDataPerElement;
        const record = await readHeldBytes(handle, recordBytes, Number(recordStart));
        const linkState = record.readUInt32LE(0);
        const neighborCount = linkState & 0xffff;
        if ((linkState & HNSW_NATIVE_RESERVED_FLAG_MASK) !== 0 || BigInt(neighborCount) > maxM0) {
          throw new Error("HNSW native generation has invalid level-0 count or reserved flags");
        }
        for (let neighbor = 0; neighbor < neighborCount; neighbor += 1) {
          const neighborId = record.readUInt32LE(
            Number(HNSW_NATIVE_LINKLIST_SIZE_BYTES + BigInt(neighbor) * HNSW_NATIVE_TABLEINT_BYTES)
          );
          if (BigInt(neighborId) >= currentCount) {
            throw new Error("HNSW native generation has an out-of-range level-0 neighbor");
          }
        }

        const labelBig = record.readBigUInt64LE(externalLabelOffset);
        if (labelBig > BigInt(HNSW_NATIVE_UINT32_MAX)) {
          throw new Error("HNSW native generation has an external label outside uint32");
        }
        const label = Number(labelBig);
        if (externalLabels.has(label)) {
          throw new Error("HNSW native generation has duplicate external labels");
        }
        externalLabels.add(label);

        const trustedVector = expectedVectorsByLabel.get(label);
        if (!trustedVector) {
          throw new Error("HNSW native vector has no trusted embedding-row authority");
        }
        let trustedNormSquared = 0;
        for (let component = 0; component < expectedDim; component += 1) {
          const value = trustedVector[component];
          if (value === undefined) throw new Error("HNSW trusted vector dimension changed during preflight");
          trustedNormSquared += value * value;
        }
        const trustedNorm = Math.sqrt(trustedNormSquared);
        if (!Number.isFinite(trustedNorm) || trustedNorm <= 0) {
          throw new Error("HNSW trusted vector is not finite and non-zero");
        }

        let normSquared = 0;
        let dbDistanceSquared = 0;
        for (let component = 0; component < expectedDim; component += 1) {
          const value = record.readFloatLE(vectorOffset + component * Number(HNSW_NATIVE_FLOAT_BYTES));
          if (!Number.isFinite(value)) {
            throw new Error("HNSW native generation has a non-finite vector component");
          }
          normSquared += value * value;
          if (!Number.isFinite(normSquared)) {
            throw new Error("HNSW native generation has an unbounded vector norm");
          }
          const trustedValue = trustedVector[component];
          if (trustedValue === undefined) throw new Error("HNSW trusted vector dimension changed during preflight");
          const difference = value - trustedValue / trustedNorm;
          if (Math.abs(difference) > HNSW_DB_VECTOR_COMPONENT_TOLERANCE) {
            throw new Error("HNSW native vector differs from its trusted DB-canonical vector");
          }
          dbDistanceSquared += difference * difference;
          if (!Number.isFinite(dbDistanceSquared)) {
            throw new Error("HNSW native-to-DB vector distance is unbounded");
          }
        }
        const norm = Math.sqrt(normSquared);
        // hnswlib-node's cosine writer stores normalized float32 vectors but
        // deliberately leaves an all-zero input unchanged. Accept exactly that
        // policy, with a float-rounding tolerance for non-zero unit vectors.
        if (norm !== 0 && Math.abs(norm - 1) > HNSW_VECTOR_NORM_TOLERANCE) {
          throw new Error("HNSW native generation has a non-unit cosine vector");
        }
        if (Math.sqrt(dbDistanceSquared) > HNSW_DB_VECTOR_L2_TOLERANCE) {
          throw new Error("HNSW native vector has a meaningful angular drift from its trusted DB vector");
        }
        if ((linkState & HNSW_NATIVE_DELETE_FLAG) === 0) liveLabels.add(label);
      }
      if (
        liveLabels.size !== expectedLiveLabels.size ||
        [...liveLabels].some((label) => !expectedLiveLabels.has(label))
      ) {
        throw new Error("HNSW native live labels differ from the trusted embedding rows");
      }

      let cursor = level0End;
      const sizeLinksPerElement = maxM * HNSW_NATIVE_TABLEINT_BYTES + HNSW_NATIVE_LINKLIST_SIZE_BYTES;
      let observedMaxLevel = 0;
      const elementLevels = new Uint8Array(Number(currentCount));
      const requiredNeighborLevels = new Uint8Array(Number(currentCount));
      for (let element = 0n; element < currentCount; element += 1n) {
        if (cursor + HNSW_NATIVE_LINKLIST_SIZE_BYTES > fileSize) {
          throw new Error("HNSW native generation has a truncated upper-level length");
        }
        const linkListBytes = BigInt(
          (await readHeldBytes(handle, Number(HNSW_NATIVE_LINKLIST_SIZE_BYTES), Number(cursor))).readUInt32LE(0)
        );
        cursor += HNSW_NATIVE_LINKLIST_SIZE_BYTES;
        if (linkListBytes % sizeLinksPerElement !== 0n) {
          throw new Error("HNSW native generation has a misaligned level block");
        }
        const elementLevel = linkListBytes / sizeLinksPerElement;
        if (elementLevel > BigInt(MAX_HNSW_LEVEL) || cursor + linkListBytes > fileSize) {
          throw new Error("HNSW native generation has an inadmissible level block");
        }
        elementLevels[Number(element)] = Number(elementLevel);
        estimatedNativeAllocation += linkListBytes;
        if (estimatedNativeAllocation > MAX_HNSW_NATIVE_ALLOCATION_BYTES) {
          throw new Error("HNSW native generation exceeds the practical allocation envelope");
        }
        const upperBlock =
          linkListBytes === 0n ? Buffer.alloc(0) : await readHeldBytes(handle, Number(linkListBytes), Number(cursor));
        for (let level = 0n; level < elementLevel; level += 1n) {
          const levelStart = Number(level * sizeLinksPerElement);
          const linkState = upperBlock.readUInt32LE(levelStart);
          const neighborCount = linkState & 0xffff;
          if ((linkState & HNSW_NATIVE_UPPER_FLAG_MASK) !== 0 || BigInt(neighborCount) > maxM) {
            throw new Error("HNSW native generation has invalid upper-level count or flags");
          }
          for (let neighbor = 0; neighbor < neighborCount; neighbor += 1) {
            const neighborId = upperBlock.readUInt32LE(
              levelStart + Number(HNSW_NATIVE_LINKLIST_SIZE_BYTES) + neighbor * Number(HNSW_NATIVE_TABLEINT_BYTES)
            );
            if (BigInt(neighborId) >= currentCount) {
              throw new Error("HNSW native generation has an out-of-range upper-level neighbor");
            }
            const requiredLevel = Number(level) + 1;
            requiredNeighborLevels[neighborId] = Math.max(requiredNeighborLevels[neighborId] ?? 0, requiredLevel);
          }
        }
        observedMaxLevel = Math.max(observedMaxLevel, Number(elementLevel));
        cursor += linkListBytes;
      }
      if (cursor !== fileSize || (currentCount > 0n && observedMaxLevel !== maxLevel)) {
        throw new Error("HNSW native generation size or maximum level does not match its records");
      }
      for (let element = 0; element < elementLevels.length; element += 1) {
        if ((requiredNeighborLevels[element] ?? 0) > (elementLevels[element] ?? 0)) {
          throw new Error("HNSW native generation links to a node missing the referenced upper level");
        }
      }
      if (currentCount > 0n && (elementLevels[entrypointNode] ?? -1) !== maxLevel) {
        throw new Error("HNSW native generation entrypoint does not occupy the declared maximum level");
      }
      // Bind every admitted field to the exact descriptor generation parsed
      // above. The later path hash must match this receipt before native import;
      // otherwise an entry swap between preflight and hashing could authorize
      // different, unparsed bytes.
      const nativeSnapshotDirectory = `${file}.enquire-stage-${randomBytes(HNSW_GENERATION_TOKEN_BYTES).toString("hex")}`;
      const nativeSnapshotPath = path.join(nativeSnapshotDirectory, "artifact");
      let nativeSnapshotDirectoryIdentity: { dev: bigint; ino: bigint } | null = null;
      let nativeSnapshotIdentity: { dev: bigint; ino: bigint } | null = null;
      try {
        await fs.mkdir(nativeSnapshotDirectory, { mode: 0o700 });
        const directory = await fs.lstat(nativeSnapshotDirectory, { bigint: true });
        if (directory.isSymbolicLink() || !directory.isDirectory() || directory.ino <= 0n) {
          throw new Error("HNSW native snapshot directory is not an owned private directory");
        }
        nativeSnapshotDirectoryIdentity = { dev: directory.dev, ino: directory.ino };
        const snapshot = await fs.open(nativeSnapshotPath, "wx", 0o600);
        const snapshotStat = await snapshot.stat({ bigint: true });
        if (!snapshotStat.isFile() || snapshotStat.ino <= 0n) {
          await snapshot.close();
          throw new Error("HNSW native snapshot is not an owned regular file");
        }
        nativeSnapshotIdentity = { dev: snapshotStat.dev, ino: snapshotStat.ino };
        const hash = createHash("sha256");
        try {
          for (let position = 0n; position < fileSize; ) {
            const length = Math.min(64 * 1024, Number(fileSize - position));
            const bytes = await readHeldBytes(handle, length, Number(position));
            hash.update(bytes);
            let written = 0;
            while (written < bytes.length) {
              const result = await snapshot.write(bytes, written, bytes.length - written, Number(position) + written);
              if (result.bytesWritten === 0) throw new Error("HNSW native snapshot write made no progress");
              written += result.bytesWritten;
            }
            position += BigInt(length);
          }
          await snapshot.sync();
        } finally {
          await snapshot.close();
        }
        admittedSnapshot = {
          currentCount: Number(currentCount),
          maxElements: Number(maxElements),
          m: Number(m),
          estimatedNativeAllocationBytes: estimatedNativeAllocation,
          sha256: hash.digest("hex"),
          nativeSnapshotPath,
          nativeSnapshotDirectory,
          nativeSnapshotIdentity,
          nativeSnapshotDirectoryIdentity
        };
        return admittedSnapshot;
      } catch (err) {
        if (nativeSnapshotIdentity && nativeSnapshotDirectoryIdentity) {
          await removeHnswNativeSnapshot({
            currentCount: 0,
            maxElements: 0,
            m: 0,
            estimatedNativeAllocationBytes: 0n,
            sha256: "",
            nativeSnapshotPath,
            nativeSnapshotDirectory,
            nativeSnapshotIdentity,
            nativeSnapshotDirectoryIdentity
          }).catch(() => {});
        } else if (nativeSnapshotDirectoryIdentity) {
          const directory = await fs.lstat(nativeSnapshotDirectory, { bigint: true }).catch(() => null);
          if (
            directory?.isDirectory() &&
            !directory.isSymbolicLink() &&
            sameHnswSnapshotIdentity(directory, nativeSnapshotDirectoryIdentity) &&
            (await fs.readdir(nativeSnapshotDirectory).catch(() => ["unknown"])).length === 0
          ) {
            await fs.rmdir(nativeSnapshotDirectory).catch(() => {});
          }
        }
        throw err;
      }
    });
  } catch (err) {
    // inspectSensitiveArtifact performs its final descriptor receipt check
    // after the callback returns. Keep the private snapshot reachable here so
    // a source mutation detected by that post-check cannot strand sensitive
    // vector bytes outside the normal loader finally block.
    if (admittedSnapshot) await removeHnswNativeSnapshot(admittedSnapshot).catch(() => {});
    throw err;
  }
}

/** A single labeled vector — used to populate the index. */
export interface LabeledVector {
  /** Stable identifier — lets the search code recover the source row from the EmbedDb. */
  label: number;
  /** L2-normalized vector. Caller is responsible for the normalization. */
  vector: Float32Array;
}

/**
 * Public legacy v1 metadata shape retained for source compatibility. Current
 * production persistence writes an internal v4 immutable-generation pointer;
 * an on-disk v1 fixed-bin record is explicitly rebuilt on first load.
 *
 * Historical v1 records were stored at `<file>.meta.json` next to
 * `<file>.bin`. Consumers may continue using this exported type, but it is not
 * the internal v4 disk-write authority.
 */
export interface HnswPersistedMeta {
  formatVersion: 1;
  /** Embedder dim — must match the corpus the index will be queried with. */
  dim: number;
  /** Vector count at write time. */
  size: number;
  /**
   * Embed-db signature at write time — when this differs from the current
   * embed-db's signature, the persisted index is stale and should be
   * rebuilt. The database signature binds current receipt-backed rowcount,
   * exact live labels, dimension, model, quantization, schema, source receipts,
   * row metadata, raw vector bytes, and quarantine markers.
   */
  signature: string;
  /**
   * Row label → source-row snapshot retained for persistence diagnostics and
   * watcher graph maintenance. Search output must rehydrate labels through
   * `EmbedDb.getSearchRowsByIds()`; this sidecar preview is never an egress
   * authority. JSON-friendly and deliberately receipt-free for format v1.
   */
  rowsByLabel: Record<
    string,
    {
      rel_path: string;
      chunk_index: number;
      line_start: number;
      line_end: number;
      text_preview: string;
      kind: "md" | "pdf";
    }
  >;
  /** ISO timestamp of the write — informational. */
  writtenAt: string;
}

/** Internal compact pointer format. Raw row paths/previews remain only in EmbedDb. */
interface HnswPersistedMetaV4 {
  formatVersion: typeof HNSW_META_FORMAT_VERSION;
  /** Strict same-directory basename of the immutable binary generation. */
  binFile: string;
  /** SHA-256 of `binFile`; binds this metadata to exactly one graph generation. */
  binSha256: string;
  /** Active embedding dimension. */
  dim: number;
  /** Exact live native element count; persisted graphs cannot contain tombstones. */
  size: number;
  /** Complete EmbedDb HNSW receipt signature. */
  signature: string;
  /** Exact physical EmbedDb generation identity. */
  dbInstanceUuid: string;
  /** Exact durable EmbedDb mutation epoch at graph publication. */
  dbMutationEpoch: number;
  /** Informational commit time. */
  writtenAt: string;
}
const HNSW_META_V4_KEYS = [
  "formatVersion",
  "binFile",
  "binSha256",
  "dim",
  "size",
  "signature",
  "dbInstanceUuid",
  "dbMutationEpoch",
  "writtenAt"
] as const;

function isHnswDbMutationEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function parseHnswDbGenerationSignature(signature: string): HnswDbGenerationAuthority | null {
  const match = /^instance=([0-9a-f]{32});epoch=([1-9][0-9]{0,15});/u.exec(signature);
  const dbInstanceUuid = match?.[1];
  const serializedEpoch = match?.[2];
  const dbMutationEpoch = Number(serializedEpoch);
  if (
    dbInstanceUuid === undefined ||
    serializedEpoch === undefined ||
    !DB_INSTANCE_UUID_PATTERN.test(dbInstanceUuid) ||
    !isHnswDbMutationEpoch(dbMutationEpoch) ||
    String(dbMutationEpoch) !== serializedEpoch
  ) {
    return null;
  }
  return { dbInstanceUuid, dbMutationEpoch };
}

function resolveHnswDbGenerationAuthority(
  signature: string,
  supplied?: Readonly<HnswDbGenerationAuthority>
): HnswDbGenerationAuthority {
  const signatureAuthority = parseHnswDbGenerationSignature(signature);
  if (supplied === undefined) {
    return (
      signatureAuthority ?? {
        dbInstanceUuid: LEGACY_HNSW_DB_INSTANCE_UUID,
        dbMutationEpoch: LEGACY_HNSW_DB_MUTATION_EPOCH
      }
    );
  }
  const admitted = admitHnswDbGenerationAuthority(supplied);
  if (
    signatureAuthority &&
    (signatureAuthority.dbInstanceUuid !== admitted.dbInstanceUuid ||
      signatureAuthority.dbMutationEpoch !== admitted.dbMutationEpoch)
  ) {
    throw new TypeError("HNSW EmbedDb generation authority differs from the receipt signature");
  }
  return admitted;
}

function admitHnswDbGenerationAuthority(
  supplied: Readonly<HnswDbGenerationAuthority>
): Readonly<HnswDbGenerationAuthority> {
  const value: unknown = supplied;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("HNSW EmbedDb generation authority must be an object");
  }
  const dbInstanceUuid: unknown = (value as Record<string, unknown>).dbInstanceUuid;
  const dbMutationEpoch: unknown = (value as Record<string, unknown>).dbMutationEpoch;
  if (
    typeof dbInstanceUuid !== "string" ||
    !DB_INSTANCE_UUID_PATTERN.test(dbInstanceUuid) ||
    !isHnswDbMutationEpoch(dbMutationEpoch)
  ) {
    throw new TypeError("HNSW EmbedDb generation authority must contain a lowercase 128-bit UUID and safe epoch");
  }
  return Object.freeze({ dbInstanceUuid, dbMutationEpoch });
}

async function acquireHnswPublisher(
  file: string,
  scopes?: PersistenceFamilyScopes
): Promise<{ file: string; lease: PersistenceFamilyLeaseHandle }> {
  const lease = scopes
    ? await acquirePersistenceFamilyLeaseInScopes(scopes, { role: "publisher" })
    : await acquirePersistenceFamilyLease({
        targetPath: defaultEmbedDbAuthorityForHnsw(file),
        familyKey: SEMANTIC_PERSISTENCE_FAMILY_KEY,
        role: "publisher"
      });
  try {
    return { file: hnswPathInSemanticScopes(file, lease.scopes), lease };
  } catch (error) {
    try {
      await lease.release();
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        "HNSW publisher acquisition succeeded but scope rejection rollback was incomplete"
      );
    }
    throw error;
  }
}

function admittedHnswPersistedRow(value: unknown): HnswPersistedMeta["rowsByLabel"][string] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== HNSW_PERSISTED_ROW_KEYS.length ||
    ownKeys.some((key) => typeof key !== "string" || !HNSW_PERSISTED_ROW_KEYS.includes(key as never))
  ) {
    return null;
  }
  const fields = Object.fromEntries(
    HNSW_PERSISTED_ROW_KEYS.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return [key, descriptor?.enumerable && "value" in descriptor ? descriptor.value : undefined];
    })
  ) as Record<(typeof HNSW_PERSISTED_ROW_KEYS)[number], unknown>;
  if (
    typeof fields.rel_path !== "string" ||
    fields.rel_path.length === 0 ||
    Buffer.byteLength(fields.rel_path, "utf8") > MAX_HNSW_PERSISTED_PATH_BYTES ||
    !Number.isSafeInteger(fields.chunk_index) ||
    (fields.chunk_index as number) < 0 ||
    !Number.isSafeInteger(fields.line_start) ||
    (fields.line_start as number) < 1 ||
    !Number.isSafeInteger(fields.line_end) ||
    (fields.line_end as number) < (fields.line_start as number) ||
    typeof fields.text_preview !== "string" ||
    Buffer.byteLength(fields.text_preview, "utf8") > MAX_HNSW_PERSISTED_PREVIEW_BYTES ||
    (fields.kind !== "md" && fields.kind !== "pdf")
  ) {
    return null;
  }
  return {
    rel_path: fields.rel_path,
    chunk_index: fields.chunk_index as number,
    line_start: fields.line_start as number,
    line_end: fields.line_end as number,
    text_preview: fields.text_preview,
    kind: fields.kind
  };
}

function isHnswPersistedRow(value: unknown): value is HnswPersistedMeta["rowsByLabel"][string] {
  return admittedHnswPersistedRow(value) !== null;
}

/** Build-time HNSW parameters. Defaults tuned for 384-dim cosine on PKM data. */
export interface HnswBuildOptions {
  /** Embedding dimensionality (must match the corpus). */
  dim: number;
  /** Maximum elements (caller's count of vectors); enables index pre-sizing. */
  maxElements: number;
  /**
   * Number of bidirectional links per node. Higher M = better recall but
   * more memory + slower build. Default 16 (Malkov & Yashunin, 2018, §4.1).
   */
  m?: number;
  /**
   * Beam width during build. Higher efConstruction = better recall,
   * slower build, no query-time cost. Default 200.
   */
  efConstruction?: number;
  /** Seed for build-time randomization (reproducibility in tests). */
  seed?: number;
}

/** Per-query parameters. */
export interface HnswQueryOptions {
  /**
   * Beam width during search. Higher = more accurate, slower. Default 100.
   * Must be ≥ k. Common range: 50-500.
   */
  ef?: number;
}

/** Trusted live EmbedDb facts required to admit a persisted native graph. */
export interface HnswLoadOptions {
  /** Active embedding-model dimension. */
  expectedDim: number;
  /** Exact DB-owned live row manifest from the same atomic EmbedDb snapshot. */
  expectedRowsByLabel: ReadonlyMap<number, HnswPersistedMeta["rowsByLabel"][string]>;
  /**
   * Exact DB-canonical decoded vectors from that same atomic snapshot.
   * Optional only for source compatibility; absence fails soft before I/O.
   */
  expectedVectorsByLabel?: ReadonlyMap<number, Float32Array>;
  /** Exact physical EmbedDb generation identity from the atomic load snapshot. */
  expectedDbInstanceUuid?: string;
  /** Exact durable EmbedDb mutation epoch from the same atomic load snapshot. */
  expectedDbMutationEpoch?: number;
}

/** Durable EmbedDb generation authority bound into one HNSW pointer. */
export interface HnswDbGenerationAuthority {
  /** Cryptographic lowercase-hex physical database identity. */
  readonly dbInstanceUuid: string;
  /** Positive safe-integer database mutation epoch. */
  readonly dbMutationEpoch: number;
}

/**
 * Exact immutable HNSW generation candidate for a meta-last pointer.
 * Callers may retain this receipt across asynchronous DB revalidation and
 * later request conditional cleanup without treating receipt possession as
 * proof that publication committed. Cleanup independently admits the live
 * pointer and its DB authority under the publisher lease.
 */
export interface HnswPublicationReceipt {
  /** Strict same-directory immutable-generation basename. */
  readonly binFile: string;
  /** SHA-256 bound into the meta pointer for that generation. */
  readonly binSha256: string;
}

/**
 * Caller-owned output slot populated by {@link HnswIndex.saveTo} once the
 * immutable generation is ready for meta-last publication. The receipt is a
 * cleanup candidate, not proof that publication committed: callers may pass
 * it to the internal stale-generation cleanup helper, which also compares the
 * live pointer's EmbedDb generation while holding the publisher lease.
 */
export interface HnswPublicationReceiptSink {
  /** Candidate generation for conditional post-publication cleanup. */
  receipt?: Readonly<HnswPublicationReceipt>;
}

/**
 * In-memory HNSW index over L2-normalized cosine vectors. Built once on
 * serve start from `EmbedDb.getAllVectors()`; queried per
 * `obsidian_search` / `obsidian_embeddings_search` invocation.
 */
export interface HnswIndex {
  /** Vector dimensionality. */
  readonly dim: number;
  /** Number of points currently in the index. */
  readonly size: number;
  /**
   * k-NN search. Returns labels + distances (cosine distance, smaller =
   * more similar). Caller maps labels back to source rows via the same
   * `LabeledVector.label` they used at build time.
   */
  searchKnn(queryVec: Float32Array, k: number, opts?: HnswQueryOptions): { labels: number[]; distances: number[] };
  /**
   * v2.16.0 — persist the index to disk for fast reload on next serve
   * start. Writes an immutable `<file>.<nonce>.bin` generation, then
   * atomically publishes `<file>.meta.json` last as its basename + SHA-256
   * pointer. Returns true once that pointer commits; prior-generation cleanup
   * is best-effort and cannot turn a committed save into a reported failure.
   *
   * `file` must use the exact lowercase `.hnsw` suffix so separate configured
   * bases cannot collide with one another's generated artifacts. A missing
   * parent is requested via recursive
   * mode-`0700` mkdir subject to a more-restrictive umask; an existing/custom
   * parent is never path-chmod'd. Saves
   * on one wrapped index serialize in invocation order. A queued save whose
   * graph epoch changed before it starts rejects without publishing; live
   * native mutation is mutually excluded while `writeIndex` is in flight.
   * Compact pointer metadata larger than 64 KiB or a native generation larger
   * than 1 GiB is refused before pointer publication; the already-built
   * in-memory graph remains usable. Precommit orphan cleanup is best-effort: a failed cleanup
   * may leave a strict generated residue that explicit clear/prune covers.
   *
   * @param file - Exact lowercase `.hnsw` persistence base.
   * @param rowsByLabel - Exact DB-owned live-label metadata manifest. It is
   *   validated against the graph but is not copied into the compact pointer.
   * @param signature - Embed-database generation signature bound into the pointer.
   * @param dbGeneration - Exact DB UUID/epoch. Optional only for legacy source
   *   compatibility; current receipt signatures carry the same fields.
   * @param persistenceScopes - Pinned primary EmbedDb family scopes. Custom
   *   HNSW basenames require this authority; only default hash basenames may
   *   use the legacy fresh-resolution fallback.
   * @param publication - Optional caller-owned receipt slot. It is cleared at
   *   invocation and populated before the meta-last commit attempt, so it also
   *   remains available when a later publisher-lease release throws.
   * @returns `true` after the meta-last pointer commits.
   * @throws {TypeError} If `file` is outside the exact HNSW namespace.
   * @throws {Error} If the graph changes before snapshot, overlaps mutation, or publication fails.
   */
  saveTo(
    file: string,
    rowsByLabel: ReadonlyMap<
      number,
      {
        rel_path: string;
        chunk_index: number;
        line_start: number;
        line_end: number;
        text_preview: string;
        kind: "md" | "pdf";
      }
    >,
    signature: string,
    dbGeneration?: Readonly<HnswDbGenerationAuthority>,
    persistenceScopes?: PersistenceFamilyScopes,
    publication?: HnswPublicationReceiptSink
  ): Promise<boolean>;
  /**
   * v3.9.0-rc.2 — apply a live-update diff to the in-memory index. The
   * watcher calls this after `embedDb.upsertNoteWithCanonicalVectors()` returns its
   * `{ oldIds, newIds, newVectors }`, and passes the DB-canonical
   * `newVectors`, so search reflects the exact persisted numeric generation
   * immediately
   * (pre-3.9.0, search was stale until the next serve restart rebuilt
   * the index from the freshly upserted embed-db).
   *
   * Semantics:
   *   1. Each id in `removeLabels` is `markDelete`'d. Missing labels
   *      (e.g. a stale watcher tracking a label that was already evicted)
   *      are silently skipped.
   *   2. Each entry in `addPoints` is `addPoint`'d with `replaceDeleted`
   *      = true so deleted-but-allocated slots are reused before the
   *      index grows. Throws (wrapped) if capacity is exhausted AND the
   *      caller didn't pre-grow via {@link resize}.
   *
   * Atomicity: the SDK's underlying mutations are synchronous, but
   * `applyDiff` does not wrap them in a transaction. A throw mid-loop
   * leaves the index in a partial-update state (some labels removed,
   * some new points added, others not). Callers MUST treat throws as
   * "rebuild required" — there's no rollback path in hnswlib. The method also
   * throws before its first native mutation if a persistence snapshot is in
   * flight, so `writeIndex` can never race C++ graph mutation.
   *
   * @returns the number of labels removed + the number of points added
   *   (for logging / instrumentation). Sum should equal
   *   `removeLabels.length + addPoints.length` on success.
   */
  applyDiff(
    removeLabels: ReadonlyArray<number>,
    addPoints: ReadonlyArray<{ label: number; vector: Float32Array }>
  ): { removed: number; added: number };
  /**
   * v3.9.0-rc.2 — grow the index to at least `newMaxElements`. No-op if
   * already large enough. Used by the watcher before `applyDiff` when
   * the live-update would push us past current capacity. Native call
   * is synchronous (in-place re-allocation). Throws before resizing if a
   * persistence snapshot is in flight.
   */
  resize(newMaxElements: number): void;
  /**
   * v3.9.0-rc.2 — capacity introspection. `currentCount` is the number
   * of live points (deleted points still count toward this); `maxElements`
   * is the pre-allocated cap. Caller uses these to decide whether
   * {@link resize} is needed before {@link applyDiff}.
   */
  capacity(): { currentCount: number; maxElements: number };
}

/**
 * Lazy-load `hnswlib-node`. Same clean-error pattern as the other
 * optional-dep loaders (tesseract.js, pdfjs-dist, @huggingface/
 * transformers). Throws with an install hint if the dep isn't present
 * or its source-built native binding failed to load. npm may omit the
 * package entirely when that optional native installation fails.
 */
interface HnswlibNodeModule {
  HierarchicalNSW: new (space: "cosine" | "l2" | "ip", dim: number) => HnswNativeIndex;
}

interface HnswNativeIndex {
  initIndex(
    maxElements: number,
    m?: number,
    efConstruction?: number,
    randomSeed?: number,
    allowReplaceDeleted?: boolean
  ): void;
  addPoint(point: number[], label: number, replaceDeleted?: boolean): void;
  searchKnn(
    query: number[],
    k: number,
    filter?: (label: number) => boolean
  ): { distances: number[]; neighbors: number[] };
  setEf(ef: number): void;
  /** v2.16.0 — persistence (hnswlib-node@^3 API). */
  writeIndex(filename: string): Promise<boolean>;
  readIndex(filename: string, allowReplaceDeleted?: boolean): Promise<boolean>;
  /** v3.9.0-rc.2 — mark a label as deleted (the slot stays allocated; a
   *  later `addPoint(..., replaceDeleted=true)` can reuse it). Throws if
   *  the label was never added. */
  markDelete(label: number): void;
  /** v3.9.0-rc.2 — current allocated slot count + max capacity. Used by
   *  HnswIndex.applyDiff to detect capacity exhaustion BEFORE addPoint
   *  throws (the native error is "The number of elements exceeds the
   *  specified limit." which we want to wrap in a clearer message). */
  getCurrentCount(): number;
  getMaxElements(): number;
  /** v3.9.0-rc.2 — grow the index in place. Native call is sync. */
  resizeIndex(newMaxElements: number): void;
}

let cachedModule: HnswlibNodeModule | null = null;

function asHnswlibNodeModule(value: unknown): HnswlibNodeModule | null {
  if (typeof value !== "object" || value === null) return null;
  const namespace = value as Record<string, unknown>;
  for (const candidate of [namespace.default, namespace]) {
    if (typeof candidate !== "object" || candidate === null) continue;
    if (typeof (candidate as Record<string, unknown>).HierarchicalNSW === "function") {
      return candidate as unknown as HnswlibNodeModule;
    }
  }
  return null;
}

async function loadHnswlib(): Promise<HnswlibNodeModule> {
  if (cachedModule) return cachedModule;
  try {
    // hnswlib-node ships as CJS; ESM consumers may expose the module through
    // `.default`, named exports, or both. Narrow the untrusted namespace.
    const lib = asHnswlibNodeModule(await importOptionalDependency("hnswlib-node"));
    if (!lib) {
      throw new Error("hnswlib-node has no HierarchicalNSW export — package mismatch");
    }
    cachedModule = lib;
    return cachedModule;
  } catch (err) {
    // rc.59 (OPTDEP leak, post-rc.58 re-sweep) — code only; Node's ERR_MODULE_NOT_FOUND
    // message embeds the importing file's abs path. (This loader used a `const msg = …`
    // INDIRECTION the rc.57 detector was blind to — now caught by the strengthened invariant.)
    throw new Error(
      "enquire: hnswlib-node (optional dependency) is not available. HNSW requires it. " +
        `Install with: npm install hnswlib-node@^3 (or reinstall enquire-mcp without --omit=optional). (${optionalDepDetail(err)})`
    );
  }
}

/**
 * Build a fresh in-memory HNSW from labeled vectors.
 *
 * `vectors` must be L2-normalized — the cosine distance space treats
 * inputs as already-unit-length, so unnormalized inputs produce wrong
 * distances. The `EmbedDb` already L2-normalizes at insert time, so the
 * usual call path (loadAllVectors → buildHnsw) is safe by construction.
 *
 * Throws if `dim` doesn't match any vector's length, if `maxElements`
 * is less than the input count, or if `hnswlib-node` failed to load.
 */
export async function buildHnsw(vectors: ReadonlyArray<LabeledVector>, opts: HnswBuildOptions): Promise<HnswIndex> {
  const dim = opts.dim;
  assertHnswNativeInteger("buildHnsw dim", dim, 1, MAX_HNSW_DIM);
  assertHnswNativeInteger("buildHnsw maxElements", opts.maxElements, 0);
  if (vectors.length > opts.maxElements) {
    throw new Error(
      `buildHnsw: vectors.length=${vectors.length} exceeds maxElements=${opts.maxElements}; pre-size the index`
    );
  }
  const m = opts.m ?? 16;
  const efConstruction = opts.efConstruction ?? 200;
  const seed = opts.seed ?? 100;
  assertHnswNativeInteger("buildHnsw m", m, 2, MAX_HNSW_M);
  assertHnswNativeInteger("buildHnsw efConstruction", efConstruction, 1);
  assertHnswNativeInteger("buildHnsw seed", seed, 0);
  const initialCapacity = Math.max(opts.maxElements, 1);
  assertHnswAllocationEnvelope("buildHnsw maxElements", initialCapacity, dim, m);

  // Validate first — fail fast before pulling in the native module or making
  // any graph mutation. hnswlib-node converts these numbers through uint32.
  const labels = new Set<number>();
  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i];
    if (!v) continue;
    assertHnswNativeInteger(`buildHnsw label at index ${i}`, v.label, 0);
    if (labels.has(v.label)) throw new Error(`buildHnsw: duplicate label ${v.label}`);
    labels.add(v.label);
    if (v.vector.length !== dim) {
      throw new Error(`buildHnsw: vector at index ${i} has dim ${v.vector.length}, expected ${dim}`);
    }
    if (!v.vector.every(Number.isFinite)) {
      throw new Error(`buildHnsw: vector at index ${i} contains a non-finite value`);
    }
  }

  const lib = await loadHnswlib();
  const ctor = new lib.HierarchicalNSW("cosine", dim);
  // Pre-size the index. `m=16` and `efConstruction=200` are HNSW defaults
  // (Malkov & Yashunin, 2018) and produce ≥98% recall@10 vs brute-force on
  // typical PKM corpora.
  // v3.9.0-rc.2 — pass `allowReplaceDeleted=true` so the live-update
  // path (`applyDiff` → `addPoint(replaceDeleted=true)`) can reuse
  // markDelete'd slots. Hnswlib defaults this to false; calling addPoint
  // with replaceDeleted=true on an index that wasn't initialized with
  // this flag throws "Replacement of deleted elements is disabled in
  // constructor". Always-on costs nothing for the read-only path.
  ctor.initIndex(initialCapacity, m, efConstruction, seed, /* allowReplaceDeleted */ true);

  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i];
    if (!v) continue;
    // hnswlib-node accepts plain number[] (it copies into its own C++
    // buffer internally). Float32Array.from-via-Array.from would allocate
    // an intermediate; we use a plain spread which is fast and explicit.
    ctor.addPoint(Array.from(v.vector), v.label);
  }

  return wrapNativeIndex(ctor, dim, vectors.length, m, labels);
}

/**
 * v2.16.0 — wrap a native hnswlib-node index (built fresh OR loaded from
 * disk) as our `HnswIndex` type. Factored out of `buildHnsw` so the
 * load-from-disk path returns the same shape without re-running addPoint.
 */
function wrapNativeIndex(
  ctor: HnswNativeIndex,
  dim: number,
  size: number,
  m: number,
  initialLiveLabels: ReadonlySet<number>
): HnswIndex {
  // v3.9.0-rc.2 — `size` is a fallback. When the live-update methods
  // (`applyDiff`, `resize`) are unavailable on an older native library,
  // the index is read-only and `size` stays at the buildHnsw-time value. When the
  // methods ARE available, the `size` getter delegates to
  // `ctor.getCurrentCount()` so callers always see the live count after
  // mutations. We probe once at wrap time.
  const hasLiveUpdate =
    typeof ctor.markDelete === "function" &&
    typeof ctor.getCurrentCount === "function" &&
    typeof ctor.getMaxElements === "function" &&
    typeof ctor.resizeIndex === "function";
  let mutationEpoch = 0;
  let persistInFlight = false;
  let persistChain: Promise<void> = Promise.resolve();
  const liveLabels = new Set(initialLiveLabels);
  return {
    dim,
    get size(): number {
      return liveLabels.size;
    },
    searchKnn(queryVec: Float32Array, k: number, qOpts?: HnswQueryOptions): { labels: number[]; distances: number[] } {
      if (queryVec.length !== dim) {
        throw new Error(`HnswIndex.searchKnn: query dim ${queryVec.length} ≠ index dim ${dim}`);
      }
      if (!queryVec.every(Number.isFinite)) {
        throw new Error("HnswIndex.searchKnn: query contains a non-finite value");
      }
      assertHnswNativeInteger("HnswIndex.searchKnn k", k, 1);
      if (qOpts?.ef !== undefined) assertHnswNativeInteger("HnswIndex.searchKnn ef", qOpts.ef, 1);
      if (liveLabels.size === 0) return { labels: [], distances: [] };
      const effectiveK = Math.min(k, liveLabels.size);
      // ef must be ≥ k; the underlying lib enforces this but we surface a
      // friendlier error if the caller forgets.
      const ef = Math.max(qOpts?.ef ?? 100, effectiveK);
      ctor.setEf(ef);
      const result = ctor.searchKnn(Array.from(queryVec), effectiveK, undefined);
      return { labels: result.neighbors, distances: result.distances };
    },
    applyDiff(removeLabels, addPoints): { removed: number; added: number } {
      if (persistInFlight) {
        throw new Error("HnswIndex.applyDiff: persistence snapshot is in flight; refusing an overlapping mutation");
      }
      if (!hasLiveUpdate) {
        throw new Error(
          "HnswIndex.applyDiff: hnswlib-node native binding does not expose markDelete/addPoint/resizeIndex — " +
            "upgrade hnswlib-node to ≥3.0 (or rebuild from source) to use live-update; falling back to full rebuild on next serve restart"
        );
      }
      // v3.10.0-rc.16 (audit M6) — pre-validate ALL vector dims BEFORE any
      // mutation (markDelete / resizeIndex / addPoint). Previously the dim
      // check lived INSIDE the addPoint loop, so a mismatched vector threw
      // AFTER some labels were already markDelete'd and some points added —
      // leaving a half-applied index the caller had to rebuild (silent embed-db
      // ↔ HNSW divergence in the watcher path, which logs + continues rather
      // than rebuilding). Hoisting the check makes applyDiff ATOMIC for the
      // only caller-data-driven throw: if any dim is wrong, nothing mutates.
      const addLabels = new Set<number>();
      for (const pt of addPoints) {
        assertHnswNativeInteger("HnswIndex.applyDiff add label", pt.label, 0);
        if (addLabels.has(pt.label)) {
          throw new Error(`HnswIndex.applyDiff: duplicate add label ${pt.label}`);
        }
        addLabels.add(pt.label);
        if (pt.vector.length !== dim) {
          throw new Error(
            `HnswIndex.applyDiff: vector for label ${pt.label} has dim ${pt.vector.length}, expected ${dim}`
          );
        }
        if (!pt.vector.every(Number.isFinite)) {
          throw new Error(`HnswIndex.applyDiff: vector for label ${pt.label} contains a non-finite value`);
        }
      }
      for (const label of removeLabels) {
        assertHnswNativeInteger("HnswIndex.applyDiff remove label", label, 0);
      }
      const currentCount = ctor.getCurrentCount();
      const currentMaxElements = ctor.getMaxElements();
      assertHnswNativeInteger("HnswIndex.applyDiff native currentCount", currentCount, 0);
      assertHnswNativeInteger("HnswIndex.applyDiff native maxElements", currentMaxElements, 1);
      if (currentCount < liveLabels.size || currentMaxElements < currentCount) {
        throw new Error("HnswIndex.applyDiff: native capacity is inconsistent with the tracked live-label manifest");
      }
      const removeSet = new Set(removeLabels);
      const reusableDeletedSlots = currentCount - liveLabels.size;
      const newlyDeletedSlots = [...removeSet].filter((label) => liveLabels.has(label)).length;
      const additionalSlots = Math.max(0, addPoints.length - reusableDeletedSlots - newlyDeletedSlots);
      if (additionalSlots > HNSW_NATIVE_UINT32_MAX - currentCount) {
        throw new Error("HnswIndex.applyDiff: resulting native element count exceeds the uint32 limit");
      }
      const needed = currentCount + additionalSlots;
      const resizeTarget =
        needed > currentMaxElements
          ? Math.max(needed, Math.min(HNSW_NATIVE_UINT32_MAX, Math.ceil(currentMaxElements * 1.5)))
          : null;
      if (resizeTarget !== null) {
        assertHnswAllocationEnvelope("HnswIndex.applyDiff resize target", resizeTarget, dim, m);
      }
      for (const label of addLabels) {
        if (liveLabels.has(label) && !removeSet.has(label)) {
          throw new Error(`HnswIndex.applyDiff: add label ${label} is already live`);
        }
      }
      // From the first native mutation onward, any throw may leave a partial
      // graph. Advance conservatively before touching C++ so no later save can
      // mistake that graph for the previously admitted generation.
      mutationEpoch += 1;
      let removed = 0;
      for (const label of removeLabels) {
        // Missing/already-deleted labels are the one explicitly fail-soft
        // case. Any throw for a label this wrapper still considers live is a
        // native graph failure and must reach the watcher quarantine path.
        if (!liveLabels.has(label)) continue;
        ctor.markDelete(label);
        liveLabels.delete(label);
        removed += 1;
      }
      let added = 0;
      // Pre-grow if needed so addPoint doesn't throw mid-loop with a
      // half-applied diff. We size to currentCount + addPoints.length
      // with a small headroom multiplier so successive small diffs don't
      // ping-pong the resize call (allocations are O(n)).
      if (resizeTarget !== null) {
        // 1.5× the requested target — same growth factor most JS array
        // implementations use; balances allocation cost vs. memory waste.
        ctor.resizeIndex(resizeTarget);
      }
      for (const pt of addPoints) {
        // dim pre-validated above (audit M6); the only remaining throw is a
        // genuine native/capacity error — capacity is pre-grown above, so this
        // is rare and not caller-data-driven.
        ctor.addPoint(Array.from(pt.vector), pt.label, /* replaceDeleted */ true);
        liveLabels.add(pt.label);
        added += 1;
      }
      return { removed, added };
    },
    resize(newMaxElements: number): void {
      if (persistInFlight) {
        throw new Error("HnswIndex.resize: persistence snapshot is in flight; refusing an overlapping mutation");
      }
      if (!hasLiveUpdate) {
        throw new Error("HnswIndex.resize: hnswlib-node native binding does not expose resizeIndex");
      }
      assertHnswNativeInteger("HnswIndex.resize newMaxElements", newMaxElements, 1);
      if (newMaxElements > ctor.getMaxElements()) {
        assertHnswAllocationEnvelope("HnswIndex.resize newMaxElements", newMaxElements, dim, m);
        mutationEpoch += 1;
        ctor.resizeIndex(newMaxElements);
      }
    },
    capacity(): { currentCount: number; maxElements: number } {
      if (!hasLiveUpdate) {
        // v3.11.0-rc.9 (audit I-HNSW-1) — HONEST fallback. The read-only binding
        // can't introspect the real maxElements, so report it as Infinity (capacity
        // unknown / effectively unbounded) rather than fabricating `size`. The old
        // `maxElements: size` lied (cap == count → "0 free slots"); a future caller
        // computing `free = max - current` now reads Infinity ("never needs resize"),
        // which is correct here since resize()/applyDiff() both throw on this binding.
        return { currentCount: size, maxElements: Number.POSITIVE_INFINITY };
      }
      return { currentCount: ctor.getCurrentCount(), maxElements: ctor.getMaxElements() };
    },
    async saveTo(file, rowsByLabel, signature, dbGeneration, persistenceScopes, publication): Promise<boolean> {
      assertHnswFilePath(file);
      const requestedFile = file;
      if (publication !== undefined) {
        if (typeof publication !== "object" || publication === null || Array.isArray(publication)) {
          throw new TypeError("HnswIndex.saveTo publication receipt slot must be an object");
        }
        delete publication.receipt;
      }
      if (typeof signature !== "string" || signature.length === 0) {
        throw new TypeError("HnswIndex.saveTo signature must be a non-empty string");
      }
      const generationAuthority = resolveHnswDbGenerationAuthority(signature, dbGeneration);
      // Snapshot caller-owned metadata at invocation, then serialize native
      // writes for this wrapped index. This prevents an older invocation from
      // publishing its pointer after a newer invocation on the same instance.
      const invocationEpoch = mutationEpoch;
      const sizeSnapshot = hasLiveUpdate ? ctor.getCurrentCount() : size;
      assertHnswNativeInteger("HnswIndex.saveTo size", sizeSnapshot, 0);
      if (rowsByLabel.size !== liveLabels.size || [...rowsByLabel.keys()].some((label) => !liveLabels.has(label))) {
        throw new Error("HnswIndex.saveTo: row metadata does not exactly match the live native-label manifest");
      }
      if (sizeSnapshot !== liveLabels.size) {
        throw new Error("HnswIndex.saveTo: deleted native slots require a compact rebuild before persistence");
      }
      for (const [label, row] of rowsByLabel) {
        assertHnswNativeInteger("HnswIndex.saveTo row label", label, 0);
        if (!isHnswPersistedRow(row)) {
          throw new TypeError(`HnswIndex.saveTo: row for label ${label} has an invalid persisted shape`);
        }
      }
      const save = persistChain.then(async () => {
        if (mutationEpoch !== invocationEpoch) {
          throw new Error("HNSW changed before its queued persistence snapshot could start");
        }
        // Enter the native-graph critical section before publisher acquisition.
        // That acquisition performs awaited lease/path I/O; leaving the flag
        // false across it lets a same-turn applyDiff/resize mutate the graph
        // after the epoch check but before writeIndex, producing a pointer that
        // reports success yet cannot be admitted on restart.
        persistInFlight = true;
        let publisher: Awaited<ReturnType<typeof acquireHnswPublisher>> | undefined;
        let operationError: unknown;
        let operationResult: boolean | undefined;
        try {
          publisher = await acquireHnswPublisher(requestedFile, persistenceScopes);
          const file = publisher.file;
          const parentDir = path.dirname(file);
          // Create missing parents with no group/world grants (subject to a
          // more-restrictive umask), but never path-chmod an existing/custom
          // parent based on a racy pre-stat ownership guess.
          await fs.mkdir(parentDir, { recursive: true, mode: 0o700 });

          const metaFile = `${file}.meta.json`;
          const previous = await readHnswMetaPointer(metaFile, file);
          const generationBasename = hnswGenerationBasename(file);
          const generationFile = path.join(parentDir, generationBasename);
          const writtenAt = new Date().toISOString();
          const projectedMeta: HnswPersistedMetaV4 = {
            formatVersion: HNSW_META_FORMAT_VERSION,
            binFile: generationBasename,
            binSha256: "0".repeat(64),
            dim,
            size: sizeSnapshot,
            signature,
            dbInstanceUuid: generationAuthority.dbInstanceUuid,
            dbMutationEpoch: generationAuthority.dbMutationEpoch,
            writtenAt
          };
          const projectedSerializedMeta = JSON.stringify(projectedMeta, null, 2);
          if (Buffer.byteLength(projectedSerializedMeta, "utf8") > MAX_HNSW_META_BYTES) {
            throw new Error("HNSW metadata exceeds the persistence read limit");
          }
          let generationPublished = false;
          let metaPublished = false;
          try {
            // hnswlib-node accepts only a host path. The common publisher gives
            // it a pre-created mode-0600 file inside an owned unpredictable 0700
            // staging directory, validates the held inode, then promotes it as
            // an immutable generation.
            const binary = await publishSensitiveArtifact(
              generationFile,
              async (stagedPath) => {
                const written = await ctor.writeIndex(stagedPath);
                if (!written) throw new Error("hnswlib-node reported an unsuccessful index write");
              },
              MAX_HNSW_GENERATION_BYTES
            );
            generationPublished = true;
            const meta: HnswPersistedMetaV4 = { ...projectedMeta, binSha256: binary.sha256 };
            if (publication) {
              publication.receipt = Object.freeze({
                binFile: generationBasename,
                binSha256: binary.sha256
              });
            }
            // Meta is the sole generation pointer and is published LAST. A crash
            // before this rename leaves the previous pointer authoritative.
            const serializedMeta = JSON.stringify(meta, null, 2);
            if (Buffer.byteLength(serializedMeta, "utf8") !== Buffer.byteLength(projectedSerializedMeta, "utf8")) {
              throw new Error("HNSW metadata exceeds the persistence read limit");
            }
            await publishSensitiveArtifact(metaFile, serializedMeta, MAX_HNSW_META_BYTES);
            metaPublished = true;

            // Pointer commit is the success boundary. Generation GC is
            // best-effort and must never turn a committed save into a reported
            // failure that callers might retry as if nothing landed.
            try {
              const current = await readHnswMetaPointer(metaFile, file);
              if (current && current.binFile === generationBasename && current.binSha256 === binary.sha256) {
                if (previous && previous.binFile !== generationBasename) {
                  await unlinkHnswGeneration(path.join(parentDir, previous.binFile));
                }
                // Explicit migration cleanup for the pre-format-2 fixed binary.
                await unlinkHnswGeneration(`${file}.bin`);
              } else if (current) {
                // A concurrent publisher won the meta pointer. This invocation
                // may erase only its own now-unreferenced generation.
                await unlinkHnswGeneration(generationFile);
              }
            } catch {
              // Strict generation names are covered by explicit clear/prune;
              // an orphan is safer than rejecting after the pointer committed.
            }
            operationResult = true;
          } catch (err) {
            // Before the meta pointer commits, this generation is provably
            // unreferenced and owned by this invocation.
            if (generationPublished && !metaPublished) await unlinkHnswGeneration(generationFile).catch(() => {});
            throw err;
          }
        } catch (error) {
          operationError = error;
        }
        persistInFlight = false;
        let releaseError: unknown;
        if (publisher) {
          try {
            await publisher.lease.release();
          } catch (error) {
            releaseError = error;
          }
        }
        if (operationError !== undefined && releaseError !== undefined) {
          throw new AggregateError(
            [operationError, releaseError],
            "HNSW persistence failed and publisher release was incomplete"
          );
        }
        if (operationError !== undefined) throw operationError;
        if (releaseError !== undefined) throw releaseError;
        if (operationResult !== true) throw new Error("HNSW persistence completed without a result");
        return operationResult;
      });
      persistChain = save.then(
        () => {},
        () => {}
      );
      return save;
    }
  };
}

interface HnswMetaPointer extends HnswPublicationReceipt {
  dbInstanceUuid?: string;
  dbMutationEpoch?: number;
}

function hnswGenerationBasename(file: string): string {
  return `${path.basename(file)}.${randomBytes(HNSW_GENERATION_TOKEN_BYTES).toString("hex")}.bin`;
}

/**
 * Test whether a basename is in the immutable-generation namespace reserved for `file`.
 *
 * @param file - Stable HNSW persistence base.
 * @param entryBasename - Candidate same-directory basename.
 * @returns `true` only for `<base>.<48-hex>.bin`.
 * @throws {TypeError} If `file` is outside the exact `.hnsw` namespace.
 * @example
 * isHnswGenerationBasename("/tmp/a.hnsw", "a.hnsw.000000000000000000000000000000000000000000000000.bin");
 * @internal
 */
export function isHnswGenerationBasename(file: string, entryBasename: string): boolean {
  assertHnswFilePath(file);
  const prefix = `${path.basename(file)}.`;
  const candidatePrefix = entryBasename.slice(0, prefix.length);
  if (candidatePrefix !== prefix || !entryBasename.endsWith(".bin")) return false;
  const token = entryBasename.slice(prefix.length, -".bin".length);
  return HNSW_GENERATION_TOKEN_PATTERN.test(token);
}

interface HnswEraseEntry {
  entryPath: string;
  generatedTemp: boolean;
}

/**
 * Validate the complete HNSW erasure family before any member is deleted.
 *
 * @param file - Stable HNSW persistence base passed to `saveTo`.
 * @returns `true` when at least one recognized artifact exists.
 * @throws {TypeError} If `file` is outside the exact `.hnsw` namespace.
 * @throws {Error} If a reserved-shape entry is malformed or its path spelling is ambiguous.
 * @example
 * await preflightHnswPersistedArtifacts("/tmp/vault.hnsw");
 * @internal
 */
export async function preflightHnswPersistedArtifacts(file: string): Promise<boolean> {
  assertHnswFilePath(file);
  return (await planHnswErasure(file)).length > 0;
}

/**
 * Erase the complete HNSW artifact family, including legacy fixed binaries,
 * immutable generations, the stable meta pointer, and recognized crash temps.
 *
 * @param file - Stable HNSW persistence base passed to `saveTo`.
 * @returns `true` when at least one artifact was removed.
 * @throws {TypeError} If `file` is outside the exact `.hnsw` namespace.
 * @throws {Error} If a recognized generated entry has an unsafe shape or cannot be removed.
 * @example
 * await clearHnswPersistedArtifacts("/tmp/0123456789ab.hnsw");
 * @internal
 */
export async function clearHnswPersistedArtifacts(
  file: string,
  persistenceScopes?: PersistenceFamilyScopes
): Promise<boolean> {
  assertHnswFilePath(file);
  const publisher = await acquireHnswPublisher(file, persistenceScopes);
  let operationResult = false;
  let operationError: unknown;
  try {
    operationResult = await clearHnswPersistedArtifactsUnchecked(publisher.file);
  } catch (error) {
    operationError = error;
  }
  let releaseError: unknown;
  try {
    await publisher.lease.release();
  } catch (error) {
    releaseError = error;
  }
  if (operationError !== undefined && releaseError !== undefined) {
    throw new AggregateError(
      [operationError, releaseError],
      "HNSW cleanup failed and publisher release was incomplete"
    );
  }
  if (operationError !== undefined) throw operationError;
  if (releaseError !== undefined) throw releaseError;
  return operationResult;
}

/**
 * Remove a stale HNSW publication while its invalidated EmbedDb generation is
 * still the live meta pointer. An exact save receipt is a fallback only for a
 * live legacy pointer without admissible DB authority. The comparison and both
 * unlinks run under the publisher lease, so a later cooperating publisher
 * either wins before this operation or runs after cleanup completes. A later
 * pointer for the same or an older epoch of the invalidated DB instance is
 * removed; a pointer bound to a newer epoch or different instance is preserved.
 *
 * This deliberately leaves unrelated orphan generations for the complete
 * explicit eraser. A post-save DB drift therefore cannot erase a newer valid
 * generation merely because it shares the same persistence family.
 *
 * @param file - Stable HNSW persistence base passed to `saveTo`.
 * @param expected - Optional exact generation candidate reported through the save sink.
 * @param invalidatedDbGeneration - EmbedDb generation proven stale by the caller's post-save receipt check.
 * @param persistenceScopes - Pinned primary EmbedDb family scopes.
 * @returns `true` only when the stale live pointer was removed; `false` when
 *   no pointer exists or a different DB generation is now current.
 * @throws {TypeError} If `file`, `expected`, or `invalidatedDbGeneration` is malformed.
 * @throws {Error} If a present pointer cannot be admitted, matching artifacts
 *   cannot be safely removed, or the lease cannot be released.
 * @example
 * await clearHnswPublishedGenerationIfStale("/tmp/0123456789ab.hnsw", receipt, staleDbGeneration);
 * @internal
 */
export async function clearHnswPublishedGenerationIfStale(
  file: string,
  expected: Readonly<HnswPublicationReceipt> | undefined,
  invalidatedDbGeneration: Readonly<HnswDbGenerationAuthority>,
  persistenceScopes?: PersistenceFamilyScopes
): Promise<boolean> {
  assertHnswFilePath(file);
  const expectedReceipt = expected === undefined ? undefined : admitHnswPublicationReceipt(file, expected);
  const invalidatedAuthority = admitHnswDbGenerationAuthority(invalidatedDbGeneration);
  const publisher = await acquireHnswPublisher(file, persistenceScopes);
  let operationResult = false;
  let operationError: unknown;
  try {
    operationResult = await clearHnswPublishedGenerationIfStaleUnchecked(
      publisher.file,
      expectedReceipt,
      invalidatedAuthority
    );
  } catch (error) {
    operationError = error;
  }
  let releaseError: unknown;
  try {
    await publisher.lease.release();
  } catch (error) {
    releaseError = error;
  }
  if (operationError !== undefined && releaseError !== undefined) {
    throw new AggregateError(
      [operationError, releaseError],
      "Conditional HNSW cleanup failed and publisher release was incomplete"
    );
  }
  if (operationError !== undefined) throw operationError;
  if (releaseError !== undefined) throw releaseError;
  return operationResult;
}

function admitHnswPublicationReceipt(
  file: string,
  candidate: Readonly<HnswPublicationReceipt>
): Readonly<HnswPublicationReceipt> {
  const value: unknown = candidate;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("HNSW publication receipt must be an object");
  }
  const binFile: unknown = (value as Record<string, unknown>).binFile;
  const binSha256: unknown = (value as Record<string, unknown>).binSha256;
  if (
    typeof binFile !== "string" ||
    !isHnswGenerationBasename(file, binFile) ||
    typeof binSha256 !== "string" ||
    !SHA256_PATTERN.test(binSha256)
  ) {
    throw new TypeError("HNSW publication receipt must name one exact digest-bound generation");
  }
  return Object.freeze({ binFile, binSha256 });
}

async function clearHnswPublishedGenerationIfStaleUnchecked(
  file: string,
  expected: Readonly<HnswPublicationReceipt> | undefined,
  invalidatedDbGeneration: Readonly<HnswDbGenerationAuthority>
): Promise<boolean> {
  const metaFile = `${file}.meta.json`;
  const current = await readHnswMetaPointer(metaFile, file);
  if (!current) {
    try {
      await fs.lstat(metaFile);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return false;
      throw error;
    }
    throw new Error("Refusing conditional HNSW cleanup because the live meta pointer is not admissible");
  }
  const exactPublication =
    expected !== undefined && current.binFile === expected.binFile && current.binSha256 === expected.binSha256;
  const hasDbAuthority = current.dbInstanceUuid !== undefined && current.dbMutationEpoch !== undefined;
  const invalidatedAuthority =
    current.dbInstanceUuid === invalidatedDbGeneration.dbInstanceUuid &&
    current.dbMutationEpoch !== undefined &&
    current.dbMutationEpoch <= invalidatedDbGeneration.dbMutationEpoch;
  if (!invalidatedAuthority && (hasDbAuthority || !exactPublication)) return false;

  const meta = await fs.lstat(metaFile);
  if (!meta.isFile()) throw new Error("Refusing to remove an unsafe HNSW meta pointer leaf");
  // Remove the authority first. If generation unlink then fails, restart sees
  // only an unreferenced orphan and rebuilds instead of loading stale bytes.
  await fs.unlink(metaFile);
  await unlinkHnswGeneration(path.join(path.dirname(file), current.binFile));
  return true;
}

/**
 * Erase HNSW artifacts while the caller's encompassing EmbedDb clear holds the
 * active family eraser. This path cannot self-conflict with the public cleanup
 * publisher, and retained or forged capabilities fail closed.
 *
 * @param file - Stable HNSW persistence base derived from the primary EmbedDb.
 * @param capability - Live capability supplied by the semantic eraser callback.
 * @returns `true` when at least one artifact was removed.
 * @throws {Error} If the capability is inactive or does not bind this HNSW base.
 * @internal
 */
export async function clearHnswPersistedArtifactsWithEraser(
  file: string,
  capability: ActiveSemanticPersistenceEraser
): Promise<boolean> {
  const scopes = scopesFromActiveSemanticEraser(capability);
  const canonicalFile = hnswPathInSemanticScopes(file, scopes);
  return clearHnswPersistedArtifactsUnchecked(canonicalFile);
}

async function clearHnswPersistedArtifactsUnchecked(file: string): Promise<boolean> {
  // Re-run the complete preflight immediately before deletion. No malformed
  // generated entry can make erasure stop after only part of the family.
  const plan = await planHnswErasure(file);
  let removed = false;
  for (const entry of plan) {
    if (entry.generatedTemp) {
      removed = (await removeSensitiveArtifactTempEntry(entry.entryPath)) || removed;
      continue;
    }
    removed = (await removeArtifact(entry.entryPath, "HNSW artifact")) || removed;
  }
  return removed;
}

async function planHnswErasure(file: string): Promise<HnswEraseEntry[]> {
  const parent = path.dirname(file);
  const legacyBin = `${path.basename(file)}.bin`;
  const meta = `${path.basename(file)}.meta.json`;
  let entries: string[];
  try {
    entries = await fs.readdir(parent);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return [];
    throw err;
  }

  const plan: HnswEraseEntry[] = [];
  for (const entry of entries) {
    const generatedFinal = sensitiveArtifactFinalBasename(entry);
    const ownedFinal = generatedFinal ?? entry;
    const expectedFinal = expectedHnswBasename(file, ownedFinal, legacyBin, meta);
    if (!expectedFinal) continue;
    const entryPath = path.join(parent, entry);
    const expectedEntry = generatedFinal
      ? `${expectedFinal}${entry.slice(generatedFinal.length).toLowerCase()}`
      : expectedFinal;
    if (entry !== expectedEntry) {
      if (!(await sameCanonicalDirectoryEntry(entryPath, path.join(parent, expectedEntry)))) {
        if (normalizedHnswEntrySpelling(entry) === normalizedHnswEntrySpelling(expectedEntry)) {
          throw new Error("Refusing HNSW erasure: a reserved-shape artifact has ambiguous path spelling");
        }
        continue;
      }
    }
    if (generatedFinal) {
      await preflightSensitiveArtifactTempEntry(entryPath);
      plan.push({ entryPath, generatedTemp: true });
      continue;
    }
    const entryStat = await fs.lstat(entryPath);
    if (!entryStat.isFile() && !entryStat.isSymbolicLink()) {
      throw new Error("Refusing HNSW erasure: an artifact is not a regular file or symlink leaf");
    }
    plan.push({ entryPath, generatedTemp: false });
  }
  return plan;
}

function expectedHnswBasename(file: string, candidate: string, legacyBin: string, meta: string): string | null {
  if (candidate === legacyBin || candidate === meta || isHnswGenerationBasename(file, candidate)) return candidate;
  if (/^.+\.meta\.json(?![\s\S])/is.test(candidate)) return meta;
  if (!/^.+\.bin(?![\s\S])/is.test(candidate)) return null;
  const generation = /^.+\.([0-9a-f]{48})\.bin(?![\s\S])/is.exec(candidate);
  const token = generation?.[1]?.toLowerCase();
  return token ? `${path.basename(file)}.${token}.bin` : legacyBin;
}

function normalizedHnswEntrySpelling(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

async function readHnswMetaPointer(metaFile: string, file: string): Promise<HnswMetaPointer | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readSensitiveArtifactText(metaFile, MAX_HNSW_META_BYTES)) as unknown;
  } catch {
    // Format 2 stored the full row-preview map and could exceed the compact
    // current compact cap. Its pointer fields were written first in a fixed canonical
    // order, so read only a bounded prefix from the held descriptor for
    // migration cleanup instead of materializing up to 256 MiB of legacy JSON.
    try {
      return await inspectSensitiveArtifact(metaFile, LEGACY_MAX_HNSW_META_BYTES, async (handle, size) => {
        const prefixBytes = Math.min(Number(size), 4096);
        const prefix = (await readHeldBytes(handle, prefixBytes, 0)).toString("utf8");
        const match =
          /^\{\n {2}"formatVersion": 2,\n {2}"binFile": "([^"]+)",\n {2}"binSha256": "([0-9a-f]{64})",/u.exec(prefix);
        const binFile = match?.[1];
        const binSha256 = match?.[2];
        return binFile && binSha256 && isHnswGenerationBasename(file, binFile) ? { binFile, binSha256 } : null;
      });
    } catch {
      return null;
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (
    (record.formatVersion !== HNSW_META_FORMAT_VERSION && record.formatVersion !== 3 && record.formatVersion !== 2) ||
    typeof record.binFile !== "string" ||
    !isHnswGenerationBasename(file, record.binFile) ||
    typeof record.binSha256 !== "string" ||
    !SHA256_PATTERN.test(record.binSha256)
  ) {
    return null;
  }
  const dbInstanceUuid = record.dbInstanceUuid;
  const dbMutationEpoch = record.dbMutationEpoch;
  return {
    binFile: record.binFile,
    binSha256: record.binSha256,
    ...(typeof dbInstanceUuid === "string" &&
    DB_INSTANCE_UUID_PATTERN.test(dbInstanceUuid) &&
    isHnswDbMutationEpoch(dbMutationEpoch)
      ? { dbInstanceUuid, dbMutationEpoch }
      : {})
  };
}

async function unlinkHnswGeneration(file: string): Promise<void> {
  let entry: import("node:fs").Stats;
  try {
    entry = await fs.lstat(file);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return;
    throw err;
  }
  if (!entry.isFile() && !entry.isSymbolicLink()) {
    throw new Error("Refusing to remove an unsafe HNSW generation leaf");
  }
  await fs.unlink(file);
}

/**
 * Load a persisted HNSW graph through the legacy two-argument compatibility
 * route. Without trusted runtime shape authority this route deliberately
 * returns `null` so the caller rebuilds instead of trusting sidecar metadata.
 *
 * @param file - Exact lowercase `.hnsw` persistence base.
 * @param expectedSignature - Current embed-database generation signature.
 * @returns `null` before persistence I/O so the caller takes the fail-soft rebuild path.
 * @throws {TypeError} If `file` is outside the exact HNSW namespace or
 * `expectedSignature` is empty.
 */
export function loadHnswFromDisk(
  file: string,
  expectedSignature: string
): Promise<{ index: HnswIndex; rowsByLabel: Map<number, HnswPersistedMeta["rowsByLabel"][string]> } | null>;

/**
 * v2.16.0 — load a previously-persisted HNSW index from disk. Returns
 * `null` (with a stderr warning) if:
 *   • The meta pointer or its immutable generation is missing
 *   • The compact meta pointer exceeds the bounded 64 KiB read cap
 *   • A legacy format-1/format-2/format-3 pointer requires a fail-soft rebuild
 *   • The generation digest or pre/post-load generation receipt differs
 *   • The pointer's EmbedDb instance UUID or mutation epoch differs
 *   • The meta's `signature` doesn't match the caller's current signature
 *   • The meta's `formatVersion` doesn't match
 *   • Trusted runtime shape options are absent (the legacy two-argument call
 *     remains source-compatible but intentionally returns `null` in v4)
 *   • Trusted DB-canonical vectors are absent (the former row-only options
 *     shape remains source-compatible but intentionally returns `null`)
 *   • The meta's `dim`/`size` are outside the bounded native uint32 contract
 *   • A supplied trusted dimension or active-row count differs from metadata
 *   • The stable 64-bit little-endian hnswlib-v3 header/records are malformed
 *   • The native count/capacity disagree with the preflighted binary header
 *   • The immutable binary exceeds the 1 GiB persistence fast-path cap
 *   • Native + DB-vector/metadata authority exceeds the combined 1 GiB working-set cap
 *   • The caller's trusted live-row/vector maps are malformed or differ from the graph
 *   • The native lib fails to load the .bin (corrupt / dim mismatch)
 *
 * On success returns `{ index, rowsByLabel }`, where `rowsByLabel` is a
 * validated detached projection of the caller's DB-owned manifest rather than
 * content recovered from the sidecar. The actual boot-time win depends on
 * index size and storage.
 *
 * @param file - Exact lowercase `.hnsw` persistence base.
 * @param expectedSignature - Current embed-database generation signature.
 * @param options - Trusted active model dimension plus exact DB-owned row/vector manifests.
 * @returns A digest/signature-validated graph and metadata map, or `null` for fail-soft rebuild.
 * @throws {TypeError} If `file` is outside the exact HNSW namespace.
 * @throws {TypeError} If `options.expectedDim` is outside the bounded native dimension contract.
 * @throws {TypeError} If either trusted manifest is not a bounded exact map.
 */
export function loadHnswFromDisk(
  file: string,
  expectedSignature: string,
  options: Readonly<HnswLoadOptions>
): Promise<{ index: HnswIndex; rowsByLabel: Map<number, HnswPersistedMeta["rowsByLabel"][string]> } | null>;
export async function loadHnswFromDisk(
  file: string,
  expectedSignature: string,
  options?: Readonly<HnswLoadOptions>
): Promise<{ index: HnswIndex; rowsByLabel: Map<number, HnswPersistedMeta["rowsByLabel"][string]> } | null> {
  assertHnswFilePath(file);
  if (typeof expectedSignature !== "string" || expectedSignature.length === 0) {
    throw new TypeError("loadHnswFromDisk expectedSignature must be a non-empty string");
  }
  const suppliedInstanceUuid = options?.expectedDbInstanceUuid;
  const suppliedMutationEpoch = options?.expectedDbMutationEpoch;
  if ((suppliedInstanceUuid === undefined) !== (suppliedMutationEpoch === undefined)) {
    throw new TypeError("loadHnswFromDisk DB generation authority must provide both UUID and epoch");
  }
  const expectedDbGeneration = resolveHnswDbGenerationAuthority(
    expectedSignature,
    suppliedInstanceUuid === undefined || suppliedMutationEpoch === undefined
      ? undefined
      : { dbInstanceUuid: suppliedInstanceUuid, dbMutationEpoch: suppliedMutationEpoch }
  );
  const expectedDim = options?.expectedDim;
  const expectedRowsValue: unknown = options?.expectedRowsByLabel;
  const expectedVectorsValue: unknown = options?.expectedVectorsByLabel;
  if (expectedDim !== undefined) {
    assertHnswNativeInteger("loadHnswFromDisk expectedDim", expectedDim, 1, MAX_HNSW_DIM);
  }
  // Metadata and the binary are both caller-writable persistence artifacts.
  // Without independently derived live model/row facts there is no trusted
  // capacity admission boundary, so skip disk I/O and rebuild in memory.
  if (expectedDim === undefined || expectedRowsValue === undefined || expectedVectorsValue === undefined) return null;
  if (
    typeof expectedRowsValue !== "object" ||
    expectedRowsValue === null ||
    !Number.isSafeInteger((expectedRowsValue as { size?: unknown }).size) ||
    ((expectedRowsValue as { size: number }).size as number) < 0 ||
    ((expectedRowsValue as { size: number }).size as number) > HNSW_NATIVE_UINT32_MAX ||
    typeof (expectedRowsValue as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== "function"
  ) {
    throw new TypeError("loadHnswFromDisk expectedRowsByLabel must be a bounded readonly map");
  }
  const declaredExpectedRows = (expectedRowsValue as { size: number }).size;
  const rowsByLabel = new Map<number, HnswPersistedMeta["rowsByLabel"][string]>();
  let trustedRowTextBytes = 0n;
  for (const entry of expectedRowsValue as Iterable<unknown>) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new TypeError("loadHnswFromDisk expectedRowsByLabel entries must be [label, row] pairs");
    }
    const [label, row] = entry;
    const admittedRow = admittedHnswPersistedRow(row);
    if (!isHnswNativeInteger(label, 0) || !admittedRow || rowsByLabel.has(label)) {
      throw new TypeError("loadHnswFromDisk expectedRowsByLabel contains an invalid or duplicate row");
    }
    rowsByLabel.set(label, admittedRow);
    trustedRowTextBytes += BigInt(
      Buffer.byteLength(admittedRow.rel_path, "utf8") + Buffer.byteLength(admittedRow.text_preview, "utf8")
    );
    if (rowsByLabel.size > declaredExpectedRows) {
      throw new TypeError("loadHnswFromDisk expectedRowsByLabel iterator exceeds its declared size");
    }
  }
  if (rowsByLabel.size !== declaredExpectedRows) {
    throw new TypeError("loadHnswFromDisk expectedRowsByLabel iterator does not match its declared size");
  }
  if (
    typeof expectedVectorsValue !== "object" ||
    expectedVectorsValue === null ||
    !Number.isSafeInteger((expectedVectorsValue as { size?: unknown }).size) ||
    ((expectedVectorsValue as { size: number }).size as number) < 0 ||
    ((expectedVectorsValue as { size: number }).size as number) > HNSW_NATIVE_UINT32_MAX ||
    typeof (expectedVectorsValue as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== "function"
  ) {
    throw new TypeError("loadHnswFromDisk expectedVectorsByLabel must be a bounded readonly map");
  }
  const declaredExpectedVectors = (expectedVectorsValue as { size: number }).size;
  if (declaredExpectedVectors !== rowsByLabel.size) {
    throw new TypeError("loadHnswFromDisk trusted row and vector maps must have identical cardinality");
  }
  const expectedVectorsByLabel = new Map<number, Float32Array>();
  for (const entry of expectedVectorsValue as Iterable<unknown>) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new TypeError("loadHnswFromDisk expectedVectorsByLabel entries must be [label, vector] pairs");
    }
    const [label, value] = entry;
    if (
      !isHnswNativeInteger(label, 0) ||
      !rowsByLabel.has(label) ||
      expectedVectorsByLabel.has(label) ||
      !(value instanceof Float32Array) ||
      value.length !== expectedDim
    ) {
      throw new TypeError("loadHnswFromDisk expectedVectorsByLabel contains an invalid or duplicate vector");
    }
    let normSquared = 0;
    const detached = new Float32Array(expectedDim);
    for (let component = 0; component < expectedDim; component += 1) {
      const vectorComponent = value[component];
      if (vectorComponent === undefined || !Number.isFinite(vectorComponent)) {
        throw new TypeError("loadHnswFromDisk expectedVectorsByLabel contains a non-finite vector");
      }
      detached[component] = vectorComponent;
      normSquared += vectorComponent * vectorComponent;
    }
    if (!Number.isFinite(normSquared) || normSquared <= 0) {
      throw new TypeError("loadHnswFromDisk expectedVectorsByLabel contains a zero or unbounded vector");
    }
    expectedVectorsByLabel.set(label, detached);
    if (expectedVectorsByLabel.size > declaredExpectedVectors) {
      throw new TypeError("loadHnswFromDisk expectedVectorsByLabel iterator exceeds its declared size");
    }
  }
  if (expectedVectorsByLabel.size !== declaredExpectedVectors) {
    throw new TypeError("loadHnswFromDisk expectedVectorsByLabel iterator does not match its declared size");
  }
  const expectedActiveRows = rowsByLabel.size;
  const expectedLabels = new Set(rowsByLabel.keys());
  const metaFile = `${file}.meta.json`;
  let metaRawBefore: string;
  try {
    metaRawBefore = await readSensitiveArtifactText(metaFile, MAX_HNSW_META_BYTES);
  } catch {
    return null; // No meta → no persisted index (or partial write).
  }
  let parsedMeta: unknown;
  try {
    parsedMeta = JSON.parse(metaRawBefore) as unknown;
  } catch (err) {
    process.stderr.write(
      `enquire: HNSW meta at ${metaFile} is malformed; rebuilding — ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }
  if (typeof parsedMeta !== "object" || parsedMeta === null || Array.isArray(parsedMeta)) {
    process.stderr.write(`enquire: HNSW meta at ${metaFile} is not an object; rebuilding\n`);
    return null;
  }
  const meta = parsedMeta as HnswPersistedMetaV4;
  const storedFormatVersion = (parsedMeta as { formatVersion?: unknown }).formatVersion;
  if (storedFormatVersion !== HNSW_META_FORMAT_VERSION) {
    const legacy = storedFormatVersion === 1;
    process.stderr.write(
      legacy
        ? "enquire: legacy HNSW fixed-bin metadata has no immutable generation digest; rebuilding\n"
        : `enquire: HNSW meta format ${String(storedFormatVersion)} ≠ expected ${HNSW_META_FORMAT_VERSION}; rebuilding (this happens on enquire-mcp upgrade)\n`
    );
    return null;
  }
  const metaKeys = Object.keys(parsedMeta);
  if (
    metaKeys.length !== HNSW_META_V4_KEYS.length ||
    metaKeys.some((key) => !HNSW_META_V4_KEYS.includes(key as (typeof HNSW_META_V4_KEYS)[number]))
  ) {
    process.stderr.write("enquire: HNSW meta has a non-canonical field inventory; rebuilding\n");
    return null;
  }
  if (
    typeof meta.binFile !== "string" ||
    !isHnswGenerationBasename(file, meta.binFile) ||
    typeof meta.binSha256 !== "string" ||
    !SHA256_PATTERN.test(meta.binSha256) ||
    typeof meta.dbInstanceUuid !== "string" ||
    !DB_INSTANCE_UUID_PATTERN.test(meta.dbInstanceUuid) ||
    !isHnswDbMutationEpoch(meta.dbMutationEpoch)
  ) {
    process.stderr.write("enquire: HNSW meta has an invalid generation pointer or digest; rebuilding\n");
    return null;
  }
  const binFile = path.join(path.dirname(file), meta.binFile);
  if (meta.dbInstanceUuid !== expectedDbGeneration.dbInstanceUuid) {
    process.stderr.write("enquire: HNSW pointer belongs to a different EmbedDb instance; rebuilding\n");
    return null;
  }
  if (meta.dbMutationEpoch !== expectedDbGeneration.dbMutationEpoch) {
    process.stderr.write("enquire: HNSW pointer has a stale EmbedDb mutation epoch; rebuilding\n");
    return null;
  }
  if (meta.signature !== expectedSignature) {
    process.stderr.write(
      `enquire: HNSW persisted index is stale (signature mismatch — embed-db changed since last write); rebuilding\n`
    );
    return null;
  }
  // v3.8.0-rc.10 P3-27 — shallow validation of dim/size/rowsByLabel before
  // passing them to the native hnswlib constructor. Malformed-but-valid-JSON
  // meta files with negative/non-integer dim or missing rowsByLabel would
  // previously produce a native crash or garbage results.
  if (!isHnswNativeInteger(meta.dim, 1, MAX_HNSW_DIM)) {
    process.stderr.write(`enquire: HNSW meta at ${metaFile} has invalid dim=${meta.dim}; rebuilding\n`);
    return null;
  }
  if (expectedDim !== undefined && meta.dim !== expectedDim) {
    process.stderr.write("enquire: HNSW persisted dimension differs from the active embedding model; rebuilding\n");
    return null;
  }
  if (!isHnswNativeInteger(meta.size, 0)) {
    process.stderr.write(`enquire: HNSW meta at ${metaFile} has invalid size=${meta.size}; rebuilding\n`);
    return null;
  }
  const admittedNativeElements = maxAdmittedHnswElements(expectedActiveRows);
  if (meta.size !== expectedActiveRows) {
    process.stderr.write("enquire: HNSW native live count differs from the active embedding rows; rebuilding\n");
    return null;
  }
  if (meta.size > admittedNativeElements) {
    process.stderr.write("enquire: HNSW native element count exceeds the active-row headroom; rebuilding\n");
    return null;
  }
  // Parse the bounded held-descriptor header before hashing the full binary:
  // a tiny forged header that advertises an unsafe native allocation is
  // rejected after 96 bytes rather than forcing a scan of the whole artifact.
  let admittedHeader: AdmittedHnswNativeHeader;
  try {
    admittedHeader = await preflightHnswNativeGeneration(
      binFile,
      expectedDim,
      meta.size,
      admittedNativeElements,
      expectedLabels,
      expectedVectorsByLabel
    );
  } catch (err) {
    process.stderr.write(
      `enquire: HNSW native generation failed bounded header preflight; rebuilding — ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }
  try {
    const trustedVectorBytes = BigInt(expectedActiveRows) * BigInt(expectedDim) * HNSW_NATIVE_FLOAT_BYTES;
    const combinedWorkingSetBytes =
      admittedHeader.estimatedNativeAllocationBytes +
      HNSW_COMBINED_NON_NATIVE_FIXED_HEADROOM_BYTES +
      // Caller snapshot + detached load authority + worst-case f32 DB BLOBs.
      trustedVectorBytes * 3n +
      // Caller snapshot + detached load authority + receipt recheck.
      BigInt(expectedActiveRows) * HNSW_TRUSTED_METADATA_PER_ROW_BYTES * 3n +
      trustedRowTextBytes * 3n;
    if (combinedWorkingSetBytes > MAX_HNSW_COMBINED_WORKING_SET_BYTES) {
      process.stderr.write(
        "enquire: HNSW + trusted DB snapshot exceed the combined 1-GiB working-set cap; rebuilding\n"
      );
      return null;
    }
    let digestBefore: string;
    try {
      digestBefore = await sha256SensitiveArtifact(binFile, MAX_HNSW_GENERATION_BYTES);
    } catch (err) {
      process.stderr.write(
        `enquire: HNSW generation is missing or unsafe; rebuilding — ${err instanceof Error ? err.message : String(err)}\n`
      );
      return null;
    }
    if (digestBefore !== admittedHeader.sha256 || digestBefore !== meta.binSha256) {
      process.stderr.write("enquire: HNSW generation digest does not match metadata; rebuilding\n");
      return null;
    }
    // Native code receives only the private byte-for-byte copy produced from
    // the held descriptor that passed the parser above. A pathname swap can no
    // longer steer readIndex to unvalidated bytes.
    const lib = await loadHnswlib();
    let ctor: HnswNativeIndex;
    let nativeSize: number;
    try {
      ctor = new lib.HierarchicalNSW("cosine", meta.dim);
      const loaded = await ctor.readIndex(admittedHeader.nativeSnapshotPath, /* allowReplaceDeleted */ true);
      if (!loaded) {
        process.stderr.write("enquire: hnswlib-node reported an unsuccessful index load; rebuilding\n");
        return null;
      }
      nativeSize = ctor.getCurrentCount();
      const nativeMaxElements = ctor.getMaxElements();
      if (
        !isHnswNativeInteger(nativeSize, 0) ||
        !isHnswNativeInteger(nativeMaxElements, 1) ||
        nativeSize !== meta.size ||
        nativeSize !== admittedHeader.currentCount ||
        nativeMaxElements < nativeSize ||
        nativeMaxElements !== admittedHeader.maxElements ||
        nativeMaxElements > admittedNativeElements
      ) {
        process.stderr.write("enquire: HNSW native shape does not match metadata; rebuilding\n");
        return null;
      }
    } catch (err) {
      process.stderr.write(
        `enquire: HNSW readIndex failed for the admitted private snapshot; rebuilding — ${err instanceof Error ? err.message : String(err)}\n`
      );
      return null;
    }
    // A different publisher may commit while native readIndex is in flight.
    // Re-hash the public path and re-read the pointer before attaching the
    // private admitted snapshot to the live DB row manifest.
    let digestAfter: string;
    let metaRawAfter: string;
    try {
      [digestAfter, metaRawAfter] = await Promise.all([
        sha256SensitiveArtifact(binFile, MAX_HNSW_GENERATION_BYTES),
        readSensitiveArtifactText(metaFile, MAX_HNSW_META_BYTES)
      ]);
    } catch {
      process.stderr.write("enquire: HNSW generation changed during load; rebuilding\n");
      return null;
    }
    if (digestAfter !== digestBefore || digestAfter !== meta.binSha256 || metaRawAfter !== metaRawBefore) {
      process.stderr.write("enquire: HNSW meta/generation changed during load; rebuilding\n");
      return null;
    }
    const index = wrapNativeIndex(ctor, meta.dim, nativeSize, admittedHeader.m, expectedLabels);
    return { index, rowsByLabel };
  } finally {
    await removeHnswNativeSnapshot(admittedHeader).catch(() => {});
  }
}

/**
 * Convert HNSW search results to legacy, receipt-free {@link EmbedSearchHit}
 * rows using a label-to-source-row lookup. This compatibility helper does not
 * establish live-source authority and must not be used directly for persisted
 * content egress; use {@link hnswResultsToReceiptHits} with current EmbedDb
 * hydration for that path.
 *
 * @param result Labels and cosine distances returned by the native HNSW index.
 * @param rowByLabel Receipt-free source rows keyed by the labels assigned at build time.
 * @returns Legacy hits for labels present in the supplied lookup.
 * @example
 * ```ts
 * const hits = hnswResultsToHits(result, loaded.rowsByLabel);
 * ```
 */
export function hnswResultsToHits(
  result: { labels: number[]; distances: number[] },
  rowByLabel: ReadonlyMap<
    number,
    {
      rel_path: string;
      chunk_index: number;
      line_start: number;
      line_end: number;
      text_preview: string;
      kind: "md" | "pdf";
    }
  >
): EmbedSearchHit[] {
  const hits: EmbedSearchHit[] = [];
  for (let i = 0; i < result.labels.length; i++) {
    const label = result.labels[i];
    const distance = result.distances[i];
    if (label === undefined || distance === undefined) continue;
    const row = rowByLabel.get(label);
    if (!row) continue; // race: row deleted between build and query — skip
    // hnswlib-node cosine distance = 1 - cosine_similarity.
    // Convert back so callers can compare against brute-force scores.
    const score = 1 - distance;
    hits.push({
      rel_path: row.rel_path,
      chunk_index: row.chunk_index,
      line_start: row.line_start,
      line_end: row.line_end,
      text_preview: row.text_preview,
      score,
      kind: row.kind
    });
  }
  return hits;
}

/**
 * Convert HNSW search results to receipt-bearing embedding hits using current
 * rows hydrated from `EmbedDb.getSearchRowsByIds()`. Persisted HNSW sidecar
 * previews are never an authority for this helper: stale, quarantined, or
 * missing labels must already be absent from the supplied EmbedDb lookup.
 * Cosine distance is converted back to similarity as `1 - distance`.
 *
 * @param result Labels and cosine distances returned by the native HNSW index.
 * @param rowByLabel Current receipt-bearing EmbedDb rows keyed by embedding id.
 * @returns Receipt-bearing hits for labels still present in the current EmbedDb.
 * @example
 * ```ts
 * const rows = embedDb.getSearchRowsByIds(result.labels);
 * const hits = hnswResultsToReceiptHits(result, rows);
 * ```
 */
export function hnswResultsToReceiptHits(
  result: { labels: number[]; distances: number[] },
  rowByLabel: ReadonlyMap<number, Omit<EmbedReceiptSearchHit, "score">>
): EmbedReceiptSearchHit[] {
  const hits: EmbedReceiptSearchHit[] = [];
  for (let i = 0; i < result.labels.length; i++) {
    const label = result.labels[i];
    const distance = result.distances[i];
    if (label === undefined || distance === undefined) continue;
    const row = rowByLabel.get(label);
    if (!row) continue;
    hits.push({
      rel_path: row.rel_path,
      chunk_index: row.chunk_index,
      line_start: row.line_start,
      line_end: row.line_end,
      text_preview: row.text_preview,
      score: 1 - distance,
      kind: row.kind,
      indexed_mtime_ms: row.indexed_mtime_ms,
      indexed_revision: row.indexed_revision
    });
  }
  return hits;
}

function errnoCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
