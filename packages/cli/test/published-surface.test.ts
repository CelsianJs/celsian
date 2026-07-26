// @celsian/cli -- verifies the PUBLISHED package surface, not the source tree.
//
// Why this file exists: roughly a quarter of the suite lives outside packages/
// and imports source directly (`../../packages/core/src/app.js`). Those tests
// bypass every `exports` map, every `files` allowlist, and the build itself, so
// none of them can catch the class of bug where the code is fine but the
// package is unpublishable: a missing `exports` subpath, a `dist` file excluded
// from `files`, a broken `types` pointer.
//
// Everything here imports BY PACKAGE NAME, so resolution goes through each
// package.json `exports` map exactly as a consumer's would. It therefore
// requires a build first (CI runs `pnpm build` before `pnpm test`).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Packages whose root entry must be importable by name. */
const ROOT_ENTRIES = [
  "@celsian/core",
  "@celsian/schema",
  "@celsian/rpc",
  "@celsian/jwt",
  "@celsian/cache",
  "@celsian/compress",
  "@celsian/rate-limit",
  "celsian",
] as const;

describe("published package surface", () => {
  it.each(ROOT_ENTRIES)("%s is importable by package name", async (name) => {
    const mod = await import(name);
    expect(Object.keys(mod).length).toBeGreaterThan(0);
  });

  it("@celsian/core resolves through its exports map, not a deep dist path", async () => {
    const core = await import("@celsian/core");
    expect(typeof core.createApp).toBe("function");
    expect(typeof core.serve).toBe("function");
    expect(typeof core.cors).toBe("function");
  });

  it("every @celsian/core exports subpath actually resolves", async () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "packages/core/package.json"), "utf8"));
    const subpaths = Object.keys(pkg.exports).filter((k) => k.startsWith("./") && k !== "./package.json");
    expect(subpaths.length).toBeGreaterThan(0);

    for (const subpath of subpaths) {
      const specifier = `@celsian/core${subpath.slice(1)}`;
      const mod = await import(specifier);
      expect(Object.keys(mod).length, `${specifier} resolved but exported nothing`).toBeGreaterThan(0);
    }
  });

  it("declared exports targets exist on disk", () => {
    const packageDirs = ["core", "schema", "rpc", "jwt", "cache", "compress", "rate-limit", "celsian", "cli"];

    for (const dir of packageDirs) {
      const pkgPath = join(repoRoot, "packages", dir, "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const targets = new Set<string>();

      const collect = (value: unknown): void => {
        if (typeof value === "string") {
          if (value.startsWith("./")) targets.add(value);
          return;
        }
        if (value && typeof value === "object") {
          for (const nested of Object.values(value)) collect(nested);
        }
      };
      collect(pkg.exports);
      collect(pkg.main);
      collect(pkg.types);
      collect(pkg.bin);

      for (const target of targets) {
        const abs = join(repoRoot, "packages", dir, target);
        expect(existsSync(abs), `${pkg.name}: declares "${target}" but ${abs} does not exist`).toBe(true);
      }
    }
  });

  it("a real app can be built and served entirely through package-name imports", async () => {
    const { createApp } = await import("@celsian/core");
    const { rateLimit } = await import("@celsian/rate-limit");

    const app = createApp();
    await app.register(rateLimit({ max: 100, window: 60_000, keyGenerator: () => "test" }), {
      encapsulate: false,
    });
    app.get("/health", (_req, reply) => reply.json({ status: "ok" }));

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
