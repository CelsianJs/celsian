// @celsian/adapter-railway — Adapter tests

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RailwayAdapterOptions } from "../src/index.js";
import { railwayAdapter } from "../src/index.js";

const TMP_DIR = join(import.meta.dirname, ".tmp-railway-test");

describe("railwayAdapter", () => {
  it("returns an adapter with name 'railway'", () => {
    const adapter = railwayAdapter();
    expect(adapter.name).toBe("railway");
    expect(typeof adapter.buildEnd).toBe("function");
  });

  it("accepts custom options", () => {
    const opts: RailwayAdapterOptions = {
      healthCheckPath: "/health",
      dockerfile: true,
    };
    const adapter = railwayAdapter(opts);
    expect(adapter.name).toBe("railway");
  });

  describe("buildEnd", () => {
    beforeEach(() => {
      rmSync(TMP_DIR, { recursive: true, force: true });
      mkdirSync(TMP_DIR, { recursive: true });
    });

    afterEach(() => {
      rmSync(TMP_DIR, { recursive: true, force: true });
    });

    it("generates Procfile, railway.json, and .env.example", async () => {
      const adapter = railwayAdapter();
      await adapter.buildEnd({
        serverEntry: "dist/server/entry.js",
        clientDir: "dist/client",
        staticDir: "dist/static",
        outDir: TMP_DIR,
      });

      expect(existsSync(join(TMP_DIR, "Procfile"))).toBe(true);
      expect(existsSync(join(TMP_DIR, "railway.json"))).toBe(true);
      expect(existsSync(join(TMP_DIR, ".env.example"))).toBe(true);

      const railwayJson = JSON.parse(readFileSync(join(TMP_DIR, "railway.json"), "utf8"));
      expect(railwayJson.deploy.startCommand).toBe("node dist/server/entry.js");
      expect(railwayJson.deploy.healthcheckPath).toBe("/api/health");
    });
  });
});
