import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DqlParseError, parseDql, runDql } from "../src/dql.js";
import { dataviewQuery, listTags } from "../src/tools.js";
import { Vault } from "../src/vault.js";

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-dql-"));
  await fs.mkdir(path.join(root, "projects"), { recursive: true });
  await fs.writeFile(
    path.join(root, "projects", "alpha.md"),
    "---\nstatus: active\npriority: 1\ntags: [project]\n---\nAlpha project body.\n"
  );
  await fs.writeFile(
    path.join(root, "projects", "beta.md"),
    "---\nstatus: done\npriority: 2\ntags: [project, archive]\n---\nBeta project body.\n"
  );
  await fs.writeFile(path.join(root, "ideas.md"), "---\ntags: [idea]\nstatus: active\n---\nLoose idea note.\n");
  const now = Date.now();
  await fs.utimes(path.join(root, "projects", "alpha.md"), new Date(now - 60_000), new Date(now - 60_000));
  await fs.utimes(path.join(root, "projects", "beta.md"), new Date(now - 30_000), new Date(now - 30_000));
  await fs.utimes(path.join(root, "ideas.md"), new Date(now), new Date(now));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("parseDql", () => {
  it("parses LIST FROM folder", () => {
    const q = parseDql('LIST FROM "projects"');
    expect(q.kind).toBe("LIST");
    expect(q.source).toEqual({ type: "folder", path: "projects" });
    expect(q.where).toEqual([]);
  });

  it("parses TABLE with columns", () => {
    const q = parseDql('TABLE status, priority FROM "projects"');
    expect(q.kind).toBe("TABLE");
    expect(q.columns).toEqual(["status", "priority"]);
  });

  it("parses tag source", () => {
    const q = parseDql("LIST FROM #idea");
    expect(q.source).toEqual({ type: "tag", tag: "idea" });
  });

  it("parses WHERE with multiple ANDs into a single OR-group", () => {
    const q = parseDql('LIST FROM "projects" WHERE status = "active" AND priority = 1');
    expect(q.where.length).toBe(1);
    expect(q.where[0]?.length).toBe(2);
    expect(q.where[0]?.[0]).toEqual({ field: "status", op: "=", value: "active" });
    expect(q.where[0]?.[1]).toEqual({ field: "priority", op: "=", value: 1 });
  });

  it("parses WHERE with OR into separate groups", () => {
    const q = parseDql('LIST WHERE status = "active" OR status = "review"');
    expect(q.where.length).toBe(2);
    expect(q.where[0]?.[0]?.value).toBe("active");
    expect(q.where[1]?.[0]?.value).toBe("review");
  });

  it("parses mixed AND/OR (OR has lower precedence)", () => {
    const q = parseDql('LIST WHERE status = "a" AND priority = 1 OR status = "b" AND priority = 2');
    expect(q.where.length).toBe(2);
    expect(q.where[0]?.length).toBe(2);
    expect(q.where[1]?.length).toBe(2);
  });

  it("parses LIKE with wildcard", () => {
    const q = parseDql('LIST WHERE file.name like "draft*"');
    expect(q.where[0]?.[0]).toEqual({ field: "file.name", op: "like", value: "draft*" });
  });

  it("parses SORT and LIMIT", () => {
    const q = parseDql('LIST FROM "projects" SORT file.mtime DESC LIMIT 10');
    expect(q.sort).toEqual({ field: "file.mtime", dir: "DESC" });
    expect(q.limit).toBe(10);
  });

  it("rejects bad source", () => {
    expect(() => parseDql("LIST FROM oops")).toThrow(DqlParseError);
  });

  it("rejects columns on LIST", () => {
    expect(() => parseDql('LIST status FROM "projects"')).toThrow(DqlParseError);
  });
});

describe("runDql", () => {
  it("runs LIST FROM folder", async () => {
    const v = new Vault(root);
    const rows = await runDql(v, parseDql('LIST FROM "projects"'));
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r["file.name"]).sort()).toEqual(["alpha", "beta"]);
  });

  it("runs LIST FROM tag", async () => {
    const v = new Vault(root);
    const rows = await runDql(v, parseDql("LIST FROM #idea"));
    expect(rows.map((r) => r["file.name"])).toEqual(["ideas"]);
  });

  it("runs WHERE field equality", async () => {
    const v = new Vault(root);
    const rows = await runDql(v, parseDql('LIST FROM "projects" WHERE status = "active"'));
    expect(rows.map((r) => r["file.name"])).toEqual(["alpha"]);
  });

  it("runs TABLE with columns", async () => {
    const v = new Vault(root);
    const rows = await runDql(v, parseDql('TABLE status, priority FROM "projects" SORT priority ASC'));
    expect(rows[0].status).toBe("active");
    expect(rows[0].priority).toBe(1);
    expect(rows[1].status).toBe("done");
  });

  it("respects SORT DESC + LIMIT", async () => {
    const v = new Vault(root);
    const rows = await runDql(v, parseDql('LIST FROM "projects" SORT priority DESC LIMIT 1'));
    expect(rows.length).toBe(1);
    expect(rows[0]["file.name"]).toBe("beta");
  });

  it("runs OR between predicate groups", async () => {
    const v = new Vault(root);
    const rows = await runDql(v, parseDql('LIST FROM "projects" WHERE status = "active" OR status = "done"'));
    expect(rows.map((r) => r["file.name"]).sort()).toEqual(["alpha", "beta"]);
  });

  it("runs LIKE with leading wildcard", async () => {
    const v = new Vault(root);
    const rows = await runDql(v, parseDql('LIST FROM "projects" WHERE file.name like "*lpha"'));
    expect(rows.map((r) => r["file.name"])).toEqual(["alpha"]);
  });

  it("runs LIKE with trailing wildcard", async () => {
    const v = new Vault(root);
    const rows = await runDql(v, parseDql('LIST FROM "projects" WHERE file.name like "alp*"'));
    expect(rows.map((r) => r["file.name"])).toEqual(["alpha"]);
  });

  it("LIKE is case-insensitive", async () => {
    const v = new Vault(root);
    const rows = await runDql(v, parseDql('LIST FROM "projects" WHERE file.name like "ALPHA"'));
    expect(rows.map((r) => r["file.name"])).toEqual(["alpha"]);
  });

  it("matches contains on tags array", async () => {
    const v = new Vault(root);
    const rows = await runDql(v, parseDql('LIST FROM "projects" WHERE file.tags contains "archive"'));
    expect(rows.map((r) => r["file.name"])).toEqual(["beta"]);
  });
});

describe("dataviewQuery (tool wrapper)", () => {
  it("returns query echo + rows", async () => {
    const v = new Vault(root);
    const result = await dataviewQuery(v, { query: 'LIST FROM "projects" WHERE status = "done"' });
    expect(result.query).toContain("done");
    expect(result.rows.map((r) => r["file.name"])).toEqual(["beta"]);
  });

  it("treats SQL keywords inside quoted strings as data, not clauses", async () => {
    // The string contains "SORT", "WHERE", and "LIMIT" — none should split clauses.
    const q = parseDql('LIST WHERE status = "active sort limit where or"');
    expect(q.where.length).toBe(1);
    expect(q.where[0]?.[0]?.value).toBe("active sort limit where or");
    expect(q.sort).toBeUndefined();
    expect(q.limit).toBeUndefined();
  });

  it("treats AND/OR inside quoted strings as data, not predicate join", async () => {
    const q = parseDql('LIST WHERE status = "first AND second" OR priority = 1');
    expect(q.where.length).toBe(2);
    expect(q.where[0]?.[0]?.value).toBe("first AND second");
    expect(q.where[1]?.[0]?.value).toBe(1);
  });
});

describe("listTags", () => {
  it("aggregates tag counts across frontmatter and inline", async () => {
    const v = new Vault(root);
    const tags = await listTags(v, {});
    const projectTag = tags.find((t) => t.tag === "project");
    expect(projectTag?.count).toBe(2);
    expect(projectTag?.frontmatter_count).toBe(2);
    expect(tags.find((t) => t.tag === "idea")?.count).toBe(1);
  });

  it("respects min_count", async () => {
    const v = new Vault(root);
    const tags = await listTags(v, { min_count: 2 });
    expect(tags.every((t) => t.count >= 2)).toBe(true);
  });
});

describe("runDql — row cap", () => {
  it("applies the default row cap when no LIMIT is given", async () => {
    const v = new Vault(root);
    const rows = await runDql(v, parseDql("LIST"), { defaultLimit: 1 });
    expect(rows.length).toBe(1);
  });

  it("an explicit LIMIT overrides the default cap", async () => {
    const v = new Vault(root);
    const rows = await runDql(v, parseDql("LIST LIMIT 2"), { defaultLimit: 1 });
    expect(rows.length).toBe(2);
  });
});
