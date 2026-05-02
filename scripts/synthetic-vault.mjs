#!/usr/bin/env node
// Build a tiny synthetic vault under a tmp dir and print its path.
// Used by CI to run the JSON-RPC smoke test without depending on a real Obsidian vault.
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-ci-vault-"));
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

console.log(root);
