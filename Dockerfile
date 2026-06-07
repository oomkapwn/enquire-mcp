# enquire-mcp — Glama / awesome-mcp-servers introspection image.
#
# Why this exists. MCP directories (Glama, and via Glama the awesome-mcp-servers
# listing) introspect a server by *building its Dockerfile* and completing an MCP
# handshake + `tools/list` over stdio. The canonical install path stays
# `npm install -g @oomkapwn/enquire-mcp` (see README); this image is ONLY for
# directory introspection and quick container trials.
#
# Design notes:
#  - Builds from source so the image reflects the repo at HEAD, not a published
#    tag.
#  - Optional native deps (better-sqlite3, hnswlib-node, pdfjs-dist, tesseract.js,
#    @napi-rs/canvas) are PRESENT at build time (so `tsc` can resolve their type
#    declarations — they're referenced in typed dynamic imports) but NEVER
#    natively compiled (`npm ci --ignore-scripts` → no python/make/g++ needed)
#    and PRUNED from the slim runtime image. Each is loaded via a lazy
#    `await import()` only when a heavy tool is actually CALLED, so the MCP
#    handshake + `tools/list` work without them. The umbrella `obsidian_search`
#    degrades to pure-JS TF-IDF; heavy retrieval (FTS5 BM25, ML embeddings, HNSW,
#    PDF/OCR) needs those native deps — use the npm install path, which compiles
#    them for your platform. This image is for directory introspection + trials.
#  - `serve` (the default subcommand) is read-only by default — writes require an
#    explicit opt-in flag — so an introspection harness pointed at the baked
#    sample vault can never mutate anything.
#
# Quick read-only trial (tools/list + TF-IDF search) against your own vault:
#   docker run --rm -i -v /abs/path/to/vault:/vault enquire-mcp
# For FULL retrieval (FTS5/embeddings/PDF/OCR), install via npm so the native
# deps compile for your platform:
#   npm install -g @oomkapwn/enquire-mcp && enquire-mcp setup --vault /abs/vault

# ---- build stage: compile TypeScript -> dist (no native deps) ----
FROM node:22-slim AS build
WORKDIR /app
# Install ALL deps (incl. optional) but skip lifecycle scripts. `tsc` needs the
# optional packages' TYPE DECLARATIONS to resolve their typed dynamic imports
# (hnswlib-node, pdfjs-dist, tesseract.js, @napi-rs/canvas) — but it does NOT
# need them natively compiled, so --ignore-scripts keeps the build pure-JS and
# toolchain-free. After building, prune dev AND optional so the runtime is slim.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build && npm prune --omit=dev --omit=optional

# ---- runtime stage: slim image with built dist + prod deps only ----
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Baked minimal vault so `tools/list` introspection works with no mounted volume.
RUN mkdir -p /vault \
 && printf '# Welcome to enquire-mcp\n\nSample note so the MCP server can start for `tools/list` introspection.\nMount your own Obsidian vault at /vault (read-only by default) for real use.\n' > /vault/welcome.md
# Read-only-by-default MCP over stdio. `serve` is the default subcommand; it is
# named explicitly here so the introspection entrypoint is unambiguous.
ENTRYPOINT ["node", "dist/index.js"]
CMD ["serve", "--vault", "/vault"]
