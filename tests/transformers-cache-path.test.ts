// v3.10.0-rc.12 — model-cache path resolution (bug-report Issues 1 + 2).
//
// Issue 1: `enquire-mcp doctor` reported "NOT READY — no Xenova model weights
//   found" on a fully-working GLOBAL install, because the cache probe only
//   looked under `process.cwd()/node_modules/...` — but a global install loads
//   the model from the package's OWN nested node_modules, relative to the
//   module, never relative to cwd.
// Issue 2: `install-model` / `setup` printed `cached under ~/.cache/huggingface/`
//   — a path that stays empty; the real cache is the transformers.js package
//   `.cache`. Three surfaces named three different (wrong) paths.
//
// Both now flow through ONE resolver: `resolveTransformersCacheDir()`. These
// tests pin the pure derivation (incl. the nested global-install layout that
// caused Issue 1) with a discriminating NEGATIVE control, and assert the doctor
// probe uses only the module-resolved runtime cache. Reporting a model from a
// legacy HF path that this transformers.js install never reads would be a
// false READY.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { candidateModelCacheRoots } from "../src/doctor.js";
import { deriveTransformersCacheDir, resolveTransformersCacheDir } from "../src/embeddings.js";

describe("transformers cache-path resolution (rc.12 — Issues 1 + 2)", () => {
  describe("deriveTransformersCacheDir (pure)", () => {
    it("derives <pkg>/.cache from a HOISTED layout main entry", () => {
      const main = path.join("/proj", "node_modules", "@huggingface", "transformers", "dist", "transformers.node.cjs");
      expect(deriveTransformersCacheDir(main)).toBe(
        path.join("/proj", "node_modules", "@huggingface", "transformers", ".cache")
      );
    });

    it("derives <pkg>/.cache from a NESTED global-install layout (the Issue 1 scenario)", () => {
      // `npm i -g @oomkapwn/enquire-mcp` with transformers NOT hoisted: it lives
      // inside the package's own nested node_modules. The pre-rc.12 cwd probe
      // could never see this — slicing at the INNERMOST marker fixes it.
      const main = path.join(
        "/usr/local/lib/node_modules",
        "@oomkapwn",
        "enquire-mcp",
        "node_modules",
        "@huggingface",
        "transformers",
        "dist",
        "transformers.node.cjs"
      );
      expect(deriveTransformersCacheDir(main)).toBe(
        path.join(
          "/usr/local/lib/node_modules",
          "@oomkapwn",
          "enquire-mcp",
          "node_modules",
          "@huggingface",
          "transformers",
          ".cache"
        )
      );
    });

    it("NEGATIVE control: returns null when the marker segment is absent", () => {
      // Proves the derivation actually discriminates — it doesn't blindly append
      // `.cache` to any path it's handed.
      expect(deriveTransformersCacheDir("/some/unrelated/path/module.js")).toBeNull();
      expect(deriveTransformersCacheDir("")).toBeNull();
    });
  });

  describe("resolveTransformersCacheDir (resolves the live install)", () => {
    it("resolves to the installed transformers package .cache dir", () => {
      // transformers IS installed in the test env (optional dep present), so the
      // resolve must succeed and point at the package's own `.cache`.
      const dir = resolveTransformersCacheDir();
      expect(dir).not.toBeNull();
      expect(dir).toContain(path.join("@huggingface", "transformers", ".cache"));
    });
  });

  describe("candidateModelCacheRoots (doctor) — Issue 1 regression guard", () => {
    it("uses exactly the module-resolved package cache", () => {
      const roots = candidateModelCacheRoots();
      const resolved = resolveTransformersCacheDir();
      expect(resolved).not.toBeNull();
      expect(roots).toEqual(resolved ? [resolved] : []);
    });

    it("NEGATIVE control: legacy HF env paths cannot create false runtime readiness", () => {
      const oldHfHome = process.env.HF_HOME;
      const oldTransformersCache = process.env.TRANSFORMERS_CACHE;
      process.env.HF_HOME = path.join("/tmp", "legacy-hf-home");
      process.env.TRANSFORMERS_CACHE = path.join("/tmp", "legacy-transformers-cache");
      try {
        const roots = candidateModelCacheRoots();
        expect(roots).toEqual(resolveTransformersCacheDir() ? [resolveTransformersCacheDir() as string] : []);
        expect(roots).not.toContain(process.env.HF_HOME);
        expect(roots).not.toContain(process.env.TRANSFORMERS_CACHE);
      } finally {
        if (oldHfHome === undefined) delete process.env.HF_HOME;
        else process.env.HF_HOME = oldHfHome;
        if (oldTransformersCache === undefined) delete process.env.TRANSFORMERS_CACHE;
        else process.env.TRANSFORMERS_CACHE = oldTransformersCache;
      }
    });
  });
});
