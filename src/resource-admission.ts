import type { FtsIndex } from "./fts5.js";
import { readLiveFtsChunk } from "./tools/index.js";
import type { Vault } from "./vault.js";

const MAX_RESOURCE_MARKDOWN_FILES = 10_000;
const MAX_RESOURCE_VISITED_ENTRIES = 100_000;
const MAX_RESOURCE_LIST_UTF8_BYTES = 8 * 1024 * 1024;

/** A bounded markdown note descriptor exposed through MCP resource listing. */
export interface VaultNoteResource {
  /** Slash-preserving, component-encoded note URI. */
  uri: string;
  /** Note basename without the Markdown suffix. */
  name: string;
  /** Canonical vault-relative note path. */
  description: string;
  /** Fixed media type for a Markdown note. */
  mimeType: "text/markdown";
}

/**
 * Encode a normalized vault-relative path for a slash-preserving note URI.
 *
 * @param relPath - Canonical forward-slash vault-relative note path.
 * @returns A component-encoded path whose directory separators remain `/`.
 */
export function encodeNotePath(relPath: string): string {
  return relPath.split("/").map(encodeURIComponent).join("/");
}

/**
 * Decode the path portion of an Obsidian note resource URI.
 *
 * @param uriPath - Slash-separated, component-encoded URI path.
 * @returns A normalized forward-slash vault-relative path.
 */
export function decodeNotePath(uriPath: string): string {
  return uriPath.split("/").map(decodeURIComponent).join("/");
}

/**
 * Enumerate the complete Markdown resource surface within file, traversal and
 * serialized-response budgets.
 *
 * @param vault - Live path/privacy authority.
 * @returns Deterministically sorted note resource descriptors.
 */
export async function listVaultNoteResources(vault: Vault): Promise<VaultNoteResource[]> {
  const listing = await vault.listFilesByExtensionsBounded(
    [".md"],
    MAX_RESOURCE_MARKDOWN_FILES,
    MAX_RESOURCE_VISITED_ENTRIES
  );
  if (!listing.complete) {
    throw new Error(
      `Vault note resource inventory is incomplete within ${MAX_RESOURCE_MARKDOWN_FILES} files / ${MAX_RESOURCE_VISITED_ENTRIES} visited entries; discover notes through bounded search tools and construct obsidian://note/<path> URIs directly`
    );
  }

  const sorted = [...listing.entries].sort((left, right) =>
    left.relPath < right.relPath ? -1 : left.relPath > right.relPath ? 1 : 0
  );
  const resources: VaultNoteResource[] = [];
  let serializedBytes = Buffer.byteLength('{"resources":[]}', "utf8");
  for (const entry of sorted) {
    const resource: VaultNoteResource = {
      uri: `obsidian://note/${encodeNotePath(entry.relPath)}`,
      name: entry.basename.replace(/\.md$/i, ""),
      description: entry.relPath,
      mimeType: "text/markdown"
    };
    const resourceBytes = Buffer.byteLength(JSON.stringify(resource), "utf8") + (resources.length > 0 ? 1 : 0);
    if (resourceBytes > MAX_RESOURCE_LIST_UTF8_BYTES - serializedBytes) {
      throw new Error(
        `Vault note resource inventory exceeds ${MAX_RESOURCE_LIST_UTF8_BYTES} serialized UTF-8 bytes; discover notes through bounded search tools and construct obsidian://note/<path> URIs directly`
      );
    }
    serializedBytes += resourceBytes;
    resources.push(resource);
  }
  return resources;
}

/**
 * Build the exact vault-info payload from the same bounded inventory used by
 * resource listing.
 *
 * @param vault - Live path/privacy authority.
 * @param version - Server version exposed to the client.
 * @returns Vault metadata with an admitted exhaustive note count.
 */
export async function vaultResourceInfo(
  vault: Vault,
  version: string
): Promise<{
  root: string;
  note_count: number;
  write_enabled: boolean;
  max_file_bytes: number;
  max_cache_entries: number;
  version: string;
}> {
  const resources = await listVaultNoteResources(vault);
  return {
    root: vault.root,
    note_count: resources.length,
    write_enabled: vault.writeEnabled,
    max_file_bytes: vault.maxFileBytes,
    max_cache_entries: vault.maxCacheEntries,
    version
  };
}

/**
 * Resolve an MCP chunk resource request through canonical numeric and live
 * source-receipt admission.
 *
 * @param vault - Live path/privacy authority.
 * @param idx - FTS index that owns the chunk receipt.
 * @param uri - Requested chunk URI.
 * @param params - URI-template parameters supplied by the MCP SDK.
 * @returns A JSON resource envelope for the current live chunk.
 */
export async function readChunkResource(
  vault: Vault,
  idx: FtsIndex,
  uri: URL,
  params: Record<string, string | string[]>
): Promise<{ contents: Array<{ uri: string; mimeType: "application/json"; text: string }> }> {
  const indexRaw = String(params.chunkIndex ?? "");
  if (!/^(?:0|[1-9]\d*)$/u.test(indexRaw)) {
    throw new Error(`Invalid chunk index in URI: ${indexRaw}`);
  }
  const chunkIndex = Number(indexRaw);
  if (!Number.isSafeInteger(chunkIndex)) {
    throw new Error(`Invalid chunk index in URI: ${indexRaw}`);
  }
  const notePathRaw = Array.isArray(params.notePath) ? params.notePath.join("/") : (params.notePath ?? "");
  const decoded = decodeNotePath(notePathRaw);
  const payload = await readLiveFtsChunk(vault, idx, decoded, chunkIndex);
  return {
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(payload, null, 2) }]
  };
}
