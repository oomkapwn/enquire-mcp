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
 * Registration metadata for the two resource entries, defined ONCE here so the
 * `resources/list` page and the SDK registration in `tool-registry.ts` cannot
 * describe the same resource differently. The SDK merges a template entry as
 * `{ ...templateMetadata, ...resource }` and a static entry as
 * `{ uri, name, ...metadata }`, so {@link mergeResourcePage} below reproduces
 * exactly that shape rather than inventing its own.
 */
export const VAULT_INFO_RESOURCE = {
  name: "vault-info",
  uri: "obsidian://vault/info",
  metadata: {
    title: "Vault metadata",
    description: "Root path, note count, write-enabled flag, and limits for the connected vault.",
    mimeType: "application/json"
  }
} as const;

/** See {@link VAULT_INFO_RESOURCE}. */
export const VAULT_NOTE_TEMPLATE_METADATA = {
  title: "Vault notes",
  description: "Each markdown note in the vault, addressable via `obsidian://note/<relative-path>`.",
  mimeType: "text/markdown"
} as const;

/**
 * Notes per `resources/list` page. The protocol leaves page size entirely to
 * the server ("clients MUST NOT assume a fixed page size"), so this is a free
 * choice: large enough that an ordinary vault answers in one page, small enough
 * that a page stays far inside the serialized-byte rail.
 */
export const RESOURCE_PAGE_LIMIT = 500;

/** Raised when a client supplies a cursor this server did not mint. */
export class ResourceCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceCursorError";
  }
}

const CURSOR_PREFIX = "v1:";
const MAX_CURSOR_CHARS = 4096;

/**
 * Mint the opaque continuation token for a page that ended at `lastRelPath`.
 *
 * The protocol requires the token be opaque to clients; it does NOT require it
 * to be unguessable, and this one deliberately carries no vault-identifying
 * material beyond a path the same response already returned.
 *
 * @param lastRelPath - Canonical vault-relative path of the page's final note.
 * @returns A base64url token to hand back as `nextCursor`.
 * @example
 * const nextCursor = encodeResourceCursor("Projects/plan.md");
 */
export function encodeResourceCursor(lastRelPath: string): string {
  return Buffer.from(`${CURSOR_PREFIX}${lastRelPath}`, "utf8").toString("base64url");
}

/**
 * Recover the resume position from a client-supplied cursor.
 *
 * @param cursor - Exact token previously returned as `nextCursor`.
 * @returns The vault-relative path the next page must start strictly after.
 * @throws {ResourceCursorError} If the token is not one this server minted. The
 *   caller maps this to JSON-RPC `-32602`, which is what the specification asks
 *   for an invalid cursor. Note an EMPTY STRING is a legal cursor value per the
 *   spec, so it is decoded like any other — never treated as "start" or "end".
 * @example
 * decodeResourceCursor(encodeResourceCursor("a.md")); // "a.md"
 */
export function decodeResourceCursor(cursor: string): string {
  if (cursor.length > MAX_CURSOR_CHARS) throw new ResourceCursorError("Invalid resources/list cursor");
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new ResourceCursorError("Invalid resources/list cursor");
  }
  if (!decoded.startsWith(CURSOR_PREFIX)) throw new ResourceCursorError("Invalid resources/list cursor");
  const relPath = decoded.slice(CURSOR_PREFIX.length);
  // A minted cursor always names a real, non-empty path; anything else is a
  // token this server did not produce (or a truncated one).
  if (relPath.length === 0 || relPath.includes("\u0000")) {
    throw new ResourceCursorError("Invalid resources/list cursor");
  }
  return relPath;
}

/**
 * One page of the `resources/list` reply.
 *
 * BOUNDED CLAIM — this is the protocol's own consistency floor, not more. The
 * specification states plainly that there is no cross-page consistency
 * guarantee and that "if the underlying data changes between page fetches,
 * clients may observe duplicates or gaps"; a client needing a coherent snapshot
 * re-fetches from the beginning without a cursor. This server does not pretend
 * otherwise: it holds no snapshot, and a note created or deleted between pages
 * changes what later pages contain. What IS guaranteed: within one unchanged
 * vault the pages partition the listing exactly once, in a deterministic order.
 *
 * @param vault - Live path/privacy authority. Privacy filtering happens inside
 *   the walk, so an excluded note is absent before anything is counted or cut.
 * @param cursor - Continuation from a previous page, or undefined for the first.
 * @returns The page's entries in the SDK's own merged wire shape, plus a
 *   `nextCursor` when more notes remain.
 * @throws {ResourceCursorError} On a cursor this server did not mint.
 * @throws {Error} If the bounded traversal could not complete — the vault
 *   exceeds the file/entry budget, which no page size can fix.
 * @example
 * const first = await pageVaultResources(vault);
 * const second = first.nextCursor ? await pageVaultResources(vault, first.nextCursor) : null;
 */
export async function pageVaultResources(
  vault: Vault,
  cursor?: string
): Promise<{ resources: Array<Record<string, unknown>>; nextCursor?: string }> {
  const after = cursor === undefined ? null : decodeResourceCursor(cursor);
  const notes = await listVaultNoteResources(vault);
  const start = after === null ? 0 : notes.findIndex((note) => note.description > after);
  // A cursor whose path sorts after every remaining note yields an empty final
  // page, which is a legal end state; -1 means exactly that.
  const from = start === -1 ? notes.length : start;
  const slice = notes.slice(from, from + RESOURCE_PAGE_LIMIT);
  const resources: Array<Record<string, unknown>> = [];
  if (after === null) {
    // The SDK merges a STATIC entry as `{ uri, name, ...metadata }`.
    resources.push({ uri: VAULT_INFO_RESOURCE.uri, name: VAULT_INFO_RESOURCE.name, ...VAULT_INFO_RESOURCE.metadata });
  }
  for (const note of slice) {
    // ...and a TEMPLATE entry as `{ ...templateMetadata, ...resource }`, so the
    // template's `title` survives while every other field comes from the note.
    resources.push({ ...VAULT_NOTE_TEMPLATE_METADATA, ...note });
  }
  const last = slice.at(-1);
  const more = from + slice.length < notes.length;
  return more && last ? { resources, nextCursor: encodeResourceCursor(last.description) } : { resources };
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
