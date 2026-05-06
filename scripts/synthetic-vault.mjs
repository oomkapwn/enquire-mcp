#!/usr/bin/env node
// Build a tiny synthetic vault under a tmp dir and print its path.
// Used by CI to run the JSON-RPC smoke test without depending on a real Obsidian vault.
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-ci-vault-"));
await fs.mkdir(path.join(root, "01_Projects"), { recursive: true });
await fs.mkdir(path.join(root, "99_Daily"), { recursive: true });

await fs.writeFile(
  path.join(root, "INDEX.md"),
  "---\ntitle: INDEX\ntags: [hub]\n---\n\n# Vault index\n\nProjects: [[Apollo]] · [[Hermes]]\n"
);
await fs.writeFile(
  path.join(root, "01_Projects", "Apollo.md"),
  "---\nstatus: active\npriority: 1\ntags: [project]\n---\n\nApollo links to [[Hermes]] and embeds ![[INDEX]].\n"
);
await fs.writeFile(
  path.join(root, "01_Projects", "Hermes.md"),
  "---\nstatus: paused\npriority: 2\ntags: [project, archive]\n---\n\nHermes mentions search-target-ABC inline.\n#review\n"
);
await fs.writeFile(
  path.join(root, "99_Daily", "2026-05-02.md"),
  "---\ntags: [daily]\n---\n\nWorked on [[Apollo]] today. Logged #idea about velocity.\n"
);

// .obsidian/daily-notes.json so smoke exercises the v1.10 plugin-aware
// periodic-alias resolver. Without this, "today" / "daily" titles fall
// back to v0.11 hard-coded defaults — which works, but doesn't catch
// regressions in the loadPeriodicConfig + formatMoment codepath.
await fs.mkdir(path.join(root, ".obsidian"), { recursive: true });
await fs.writeFile(
  path.join(root, ".obsidian", "daily-notes.json"),
  JSON.stringify({ folder: "99_Daily", format: "YYYY-MM-DD", template: "" }, null, 2)
);

// Canvas board so smoke can exercise obsidian_list_canvases / read_canvas (v1.7).
await fs.mkdir(path.join(root, "Boards"), { recursive: true });
await fs.writeFile(
  path.join(root, "Boards", "Apollo Board.canvas"),
  JSON.stringify(
    {
      nodes: [
        { id: "n1", type: "text", x: 0, y: 0, width: 200, height: 80, text: "Apollo cluster" },
        { id: "n2", type: "file", x: 240, y: 0, width: 200, height: 80, file: "01_Projects/Apollo.md" },
        { id: "n3", type: "link", x: 480, y: 0, width: 200, height: 80, url: "https://example.com" }
      ],
      edges: [{ id: "e1", fromNode: "n1", toNode: "n2" }]
    },
    null,
    2
  )
);

console.log(root);
