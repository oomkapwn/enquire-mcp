import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { semanticSearch } from "../src/tools/index.js";
import { Vault } from "../src/vault.js";

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-semantic-"));
  await fs.mkdir(path.join(root, "Auth"), { recursive: true });
  await fs.mkdir(path.join(root, "Other"), { recursive: true });

  // Auth-cluster notes — share OAuth / JWT / authentication terms.
  await fs.writeFile(
    path.join(root, "Auth", "OAuth Flows.md"),
    "OAuth authentication flow with JWT tokens. Authorization server issues access tokens and refresh tokens. Bearer tokens go in the Authorization header.\n"
  );
  await fs.writeFile(
    path.join(root, "Auth", "JWT Validation.md"),
    "JWT validation: verify signature, expiration, audience, issuer. Token introspection. Refresh token rotation policy.\n"
  );
  await fs.writeFile(
    path.join(root, "Auth", "Login UX.md"),
    "Login page redirects to authorization server. After consent the OAuth flow returns an access token used for API calls.\n"
  );

  // Cooking-cluster — completely unrelated.
  await fs.writeFile(
    path.join(root, "Other", "Pasta Carbonara.md"),
    "Carbonara: guanciale, pecorino romano, eggs, black pepper. Toss with hot pasta off the heat.\n"
  );
  await fs.writeFile(
    path.join(root, "Other", "Sourdough.md"),
    "Sourdough starter feeding schedule. Bulk fermentation 4 hours at 25C. Score before baking.\n"
  );

  // Hub — mentions everything but lightly.
  await fs.writeFile(path.join(root, "Index.md"), "Random index that mentions things lightly.\n");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("semanticSearch (v1.8 TF-IDF cosine)", () => {
  it("ranks auth-cluster notes above unrelated notes for a token query", async () => {
    const v = new Vault(root);
    const result = await semanticSearch(v, { query: "access token validation", limit: 10 });
    expect(result.method).toBe("tfidf-cosine");
    expect(result.matches.length).toBeGreaterThan(0);
    // Top hits must come from Auth/. Cooking notes shouldn't outrank them.
    const top3 = result.matches.slice(0, 3).map((m) => m.path);
    expect(top3.every((p) => p.startsWith("Auth/"))).toBe(true);
  });

  it("returns NO match when query has zero shared vocabulary with any doc", async () => {
    const v = new Vault(root);
    const result = await semanticSearch(v, { query: "xyzzy quux frobozz" });
    expect(result.matches.length).toBe(0);
  });

  it("respects folder filter — only returns notes from that folder", async () => {
    const v = new Vault(root);
    const result = await semanticSearch(v, { query: "carbonara pasta", folder: "Other" });
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.every((m) => m.path.startsWith("Other/"))).toBe(true);
  });

  it("includes matched_terms ranked highest-IDF first + a snippet", async () => {
    const v = new Vault(root);
    const result = await semanticSearch(v, { query: "JWT signature audience" });
    expect(result.matches.length).toBeGreaterThan(0);
    const top = result.matches[0];
    expect(top?.matched_terms.length).toBeGreaterThan(0);
    // The snippet should contain at least one of the matched terms.
    expect(top?.snippet).toBeTruthy();
    const someMatch = top?.matched_terms.some((t) => top.snippet.toLowerCase().includes(t));
    expect(someMatch).toBe(true);
  });

  it("respects min_score threshold", async () => {
    const v = new Vault(root);
    const all = await semanticSearch(v, { query: "OAuth", limit: 50, min_score: 0 });
    const tight = await semanticSearch(v, { query: "OAuth", limit: 50, min_score: 0.5 });
    // Tighter threshold returns ≤ as many hits.
    expect(tight.matches.length).toBeLessThanOrEqual(all.matches.length);
    // Every tight result has score ≥ threshold.
    expect(tight.matches.every((m) => m.score >= 0.5)).toBe(true);
  });

  it("rejects empty query", async () => {
    const v = new Vault(root);
    await expect(semanticSearch(v, { query: "" })).rejects.toThrow(/empty/);
    await expect(semanticSearch(v, { query: "   " })).rejects.toThrow(/empty/);
  });

  it("respects --read-paths allowlist", async () => {
    const v = new Vault(root, { readPaths: ["Other/**"] });
    await v.ensureExists();
    const result = await semanticSearch(v, { query: "OAuth flow access token", limit: 10 });
    // Auth/* is filtered out by allowlist — no auth notes in result.
    expect(result.matches.every((m) => m.path.startsWith("Other/"))).toBe(true);
  });

  it("scores are bounded in [0, 1] (cosine of L2-normalized vectors)", async () => {
    const v = new Vault(root);
    const result = await semanticSearch(v, { query: "JWT OAuth authentication tokens", limit: 50, min_score: 0 });
    for (const m of result.matches) {
      expect(m.score).toBeGreaterThanOrEqual(0);
      expect(m.score).toBeLessThanOrEqual(1.0001); // tiny float slop
    }
  });

  it("total_docs reports the corpus size used for IDF", async () => {
    const v = new Vault(root);
    const result = await semanticSearch(v, { query: "anything" });
    // We seeded 6 markdown files.
    expect(result.total_docs).toBe(6);
  });
});

// v1.11.1: tokenizer must accept Unicode letters (Cyrillic / Greek / Arabic /
// Hebrew etc.). The pre-1.11.1 ASCII-only regex silently dropped non-Latin
// content from both the index AND the query, returning zero hits for Russian /
// Greek / Hebrew vaults. Regression test catches the leak.
//
// Note: CJK languages (Chinese / Japanese / unsegmented Thai) need an
// Intl.Segmenter pass before this regex is useful — they don't use spaces.
// Tracked as v2.0 backlog; v1.11.1 fixes the >80% case (whitespace-segmented
// non-Latin scripts).
describe("semanticSearch (v1.11.1 Unicode tokenizer)", () => {
  let uroot: string;

  beforeAll(async () => {
    uroot = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-semantic-unicode-"));
    await fs.writeFile(
      path.join(uroot, "Аутентификация.md"),
      "Поток OAuth с токенами JWT. Сервер авторизации выдаёт токены доступа и обновления.\n"
    );
    await fs.writeFile(
      path.join(uroot, "Кулинария.md"),
      "Карбонара: гуанчиале, пекорино романо, яйца, чёрный перец. Перемешать с горячей пастой.\n"
    );
    await fs.writeFile(
      path.join(uroot, "Αυθεντικοποίηση.md"),
      "Ροή OAuth με JWT διακριτικά. Ο διακομιστής εξουσιοδότησης εκδίδει διακριτικά πρόσβασης.\n"
    );
  });

  afterAll(async () => {
    await fs.rm(uroot, { recursive: true, force: true });
  });

  it("indexes Cyrillic content and ranks the auth note above the cooking note", async () => {
    const v = new Vault(uroot);
    const result = await semanticSearch(v, { query: "токены авторизации", limit: 10 });
    expect(result.matches.length).toBeGreaterThan(0);
    // Top hit must be Аутентификация — token vocabulary overlaps there, not in
    // the carbonara recipe. Pre-1.11.1, the tokenizer dropped both query and
    // doc tokens, so this returned 0 matches.
    expect(result.matches[0]?.path).toBe("Аутентификация.md");
  });

  it("indexes Greek content for Greek queries", async () => {
    const v = new Vault(uroot);
    const result = await semanticSearch(v, { query: "διακριτικά εξουσιοδότησης", limit: 10 });
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0]?.path).toBe("Αυθεντικοποίηση.md");
  });
});

// v2.1.0: CJK / Thai / Khmer / Lao segmentation via Intl.Segmenter
describe("semanticSearch (v2.1.0 CJK/Thai segmentation)", () => {
  let croot: string;

  beforeAll(async () => {
    croot = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-cjk-"));
    await fs.writeFile(
      path.join(croot, "认证.md"),
      "JWT 令牌 OAuth 认证 流程。授权 服务器 颁发 访问 令牌 和 刷新 令牌。\n"
    );
    await fs.writeFile(
      path.join(croot, "烹饪.md"),
      "意大利面 培根 罗马诺 鸡蛋 黑胡椒。 与 热的 意大利面 一起 翻炒。\n"
    );
    await fs.writeFile(
      path.join(croot, "認証.md"),
      "JWT トークン を 使った OAuth 認証 フロー。 認可 サーバー が アクセス トークン を 発行 します。\n"
    );
  });

  afterAll(async () => {
    await fs.rm(croot, { recursive: true, force: true });
  });

  it("indexes Chinese (Hanzi) content via Intl.Segmenter word-break", async () => {
    const v = new Vault(croot);
    const result = await semanticSearch(v, { query: "JWT 令牌 认证", limit: 5 });
    expect(result.matches.length).toBeGreaterThan(0);
    // Top hit should be the auth note, NOT the cooking note (which has no
    // overlap with auth tokens).
    expect(result.matches[0]?.path).toBe("认证.md");
  });

  it("indexes Japanese (kana + kanji) via Intl.Segmenter", async () => {
    const v = new Vault(croot);
    const result = await semanticSearch(v, { query: "OAuth 認証 トークン", limit: 5 });
    expect(result.matches.length).toBeGreaterThan(0);
    // Top hit should be the Japanese auth note (uses katakana for tokens
    // and kanji for auth — Intl.Segmenter must word-break both correctly).
    expect(result.matches[0]?.path).toBe("認証.md");
  });
});
