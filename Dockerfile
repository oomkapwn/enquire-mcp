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
#    @napi-rs/canvas) are intentionally OMITTED. Every one of them is loaded via a
#    lazy `await import()` only when a heavy tool is actually CALLED, so the MCP
#    handshake + `tools/list` work without them, the build needs no native
#    toolchain, and the image stays small and reproducible. The umbrella
#    `obsidian_search` degrades to pure-JS TF-IDF when embeddings are absent.
#  - `serve` (the default subcommand) is read-only by default — writes require an
#    explicit opt-in flag — so an introspection harness pointed at the baked
#    sample vault can never mutate anything.
#
# For real use, mount your Obsidian vault and run setup:
#   docker run --rm -i -v /abs/path/to/vault:/vault enquire-mcp \
#     setup --vault /vault
#   docker run --rm -i -v /abs/path/to/vault:/vault enquire-mcp

# ---- build stage: compile TypeScript -> dist (no native deps) ----
FROM node:22-slim AS build
WORKDIR /app
# Install prod+dev deps but skip optional native deps and lifecycle scripts;
# tsc compiles src/** only (tests excluded) and never statically imports the
# optional modules, so the build is pure-JS and toolchain-free.
COPY package.json package-lock.json ./
RUN npm ci --omit=optional --ignore-scripts
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
