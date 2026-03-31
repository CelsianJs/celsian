// @celsian/adapter-fly — Adapter tests

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FlyAdapterOptions } from "../src/index.js";
import { flyAdapter } from "../src/index.js";

const TMP_DIR = join(import.meta.dirname, ".tmp-fly-test");

describe("flyAdapter", () => {
  it("returns an adapter with name 'fly'", () => {
    const adapter = flyAdapter();
    expect(adapter.name).toBe("fly");
    expect(typeof adapter.buildEnd).toBe("function");
  });

  it("accepts custom options", () => {
    const opts: FlyAdapterOptions = {
      appName: "my-app",
      primaryRegion: "lhr",
      regions: ["nrt"],
      memoryMb: 512,
    };
    const adapter = flyAdapter(opts);
    expect(adapter.name).toBe("fly");
  });

  describe("buildEnd", () => {
    beforeEach(() => {
      rmSync(TMP_DIR, { recursive: true, force: true });
      mkdirSync(TMP_DIR, { recursive: true });
    });

    afterEach(() => {
      rmSync(TMP_DIR, { recursive: true, force: true });
    });

    it("generates fly.toml, Dockerfile, and .dockerignore", async () => {
      const adapter = flyAdapter({ appName: "test-app" });
      await adapter.buildEnd({
        serverEntry: "dist/server/entry.js",
        clientDir: "dist/client",
        staticDir: "dist/static",
        outDir: TMP_DIR,
      });

      expect(existsSync(join(TMP_DIR, "fly.toml"))).toBe(true);
      expect(existsSync(join(TMP_DIR, "Dockerfile"))).toBe(true);
      expect(existsSync(join(TMP_DIR, ".dockerignore"))).toBe(true);

      const flyToml = readFileSync(join(TMP_DIR, "fly.toml"), "utf8");
      expect(flyToml).toContain("app = 'test-app'");
      expect(flyToml).toContain("primary_region = 'iad'");
    });
  });
});
