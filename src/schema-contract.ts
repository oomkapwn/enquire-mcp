// Internal on-disk schema contract shared by storage owners and diagnostics.
//
// This module is intentionally absent from package.json exports: the values
// coordinate implementation modules but are not a public package subpath.

/** Current on-disk FTS5 schema version. */
export const FTS_SCHEMA_VERSION = 5;

/** Current on-disk embedding database schema version. */
export const EMBED_DB_SCHEMA_VERSION = 3;
