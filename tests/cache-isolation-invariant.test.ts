// v3.10.0-rc.11 — structural guard for the hermetic-cache fix (tests/setup.ts).
//
// Found by live-testing the install on a real machine: tests that spawn
// serve/setup/build-embeddings/index WITHOUT an explicit --index-file fell back
// to defaultIndexFile() → the REAL ~/Library/Caches/enquire, never cleaned up
// (~27k orphaned files / ~699 MB accumulated over weeks of `npm test`).
// tests/setup.ts now redirects XDG_CACHE_HOME to a throwaway temp dir. This
// invariant fails if that redirect is ever removed/broken — so the suite can
// never silently start polluting a real user cache again.
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultIndexFile } from "../src/fts5.js";

describe("cache-isolation invariant (v3.10 rc.11 — tests never write the real cache)", () => {
  const realCacheRoots = [
    path.join(os.homedir(), "Library", "Caches", "enquire"), // macOS default
    path.join(os.homedir(), ".cache", "enquire") // Linux default
  ];
  const underRealUserCache = (p: string): boolean => realCacheRoots.some((r) => p.startsWith(r));

  it("setup.ts redirected XDG_CACHE_HOME to a throwaway temp dir", () => {
    const xdg = process.env.XDG_CACHE_HOME;
    expect(xdg, "tests/setup.ts must set XDG_CACHE_HOME (hermetic cache)").toBeTruthy();
    expect(
      (xdg as string).startsWith(os.tmpdir()) || (xdg as string).includes("enquire-test-cache-"),
      `XDG_CACHE_HOME should be a temp dir, got: ${xdg}`
    ).toBe(true);
  });

  it("defaultIndexFile() resolves UNDER the temp cache, NOT the real user cache", () => {
    const f = defaultIndexFile("/Users/example/Documents/Obsidian Vault");
    expect(underRealUserCache(f), `index file leaked to the real user cache: ${f}`).toBe(false);
    expect(f.startsWith(process.env.XDG_CACHE_HOME as string)).toBe(true);
  });

  // NEGATIVE control: the underRealUserCache() classifier must DISCRIMINATE —
  // it flags a real-cache path true and the (temp-redirected) resolved file
  // false. A constant `() => false` classifier would make the test above
  // vacuous; this fails it.
  it("NEGATIVE control — classifier flags the real cache, clears the redirected one", () => {
    expect(underRealUserCache(path.join(os.homedir(), "Library", "Caches", "enquire", "abc.fts5.db"))).toBe(true);
    expect(underRealUserCache(path.join(os.homedir(), ".cache", "enquire", "abc.embed.db"))).toBe(true);
    expect(underRealUserCache(defaultIndexFile("/Users/example/Documents/Obsidian Vault"))).toBe(false);
  });
});
