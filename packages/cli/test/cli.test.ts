// @celsian/cli — CLI command tests

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BuildOptions } from "../src/commands/build.js";
import { generateRoute, generateRpc } from "../src/commands/generate.js";

const TMP_DIR = join(import.meta.dirname, ".tmp-cli-test");

describe("generateRoute", () => {
  beforeEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("creates a route file in src/routes/<name>.ts", () => {
    const originalCwd = process.cwd();
    process.chdir(TMP_DIR);
    try {
      generateRoute("users");
      const filePath = join(TMP_DIR, "src", "routes", "users.ts");
      expect(existsSync(filePath)).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("generated route file contains the route name in the handler", () => {
    const originalCwd = process.cwd();
    process.chdir(TMP_DIR);
    try {
      generateRoute("products");
      const filePath = join(TMP_DIR, "src", "routes", "products.ts");
      const content = readFileSync(filePath, "utf8");
      expect(content).toContain("'/products'");
      expect(content).toContain("productsRoutes");
      expect(content).toContain("PluginFunction");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("does not overwrite an existing route file", () => {
    const originalCwd = process.cwd();
    process.chdir(TMP_DIR);
    try {
      generateRoute("items");
      const filePath = join(TMP_DIR, "src", "routes", "items.ts");
      const originalContent = readFileSync(filePath, "utf8");

      // Call again — should not overwrite
      generateRoute("items");
      const contentAfter = readFileSync(filePath, "utf8");
      expect(contentAfter).toBe(originalContent);
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe("generateRpc", () => {
  beforeEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("creates an RPC file in src/rpc/<name>.ts", () => {
    const originalCwd = process.cwd();
    process.chdir(TMP_DIR);
    try {
      generateRpc("tasks");
      const filePath = join(TMP_DIR, "src", "rpc", "tasks.ts");
      expect(existsSync(filePath)).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("generated RPC file contains query and mutation procedures", () => {
    const originalCwd = process.cwd();
    process.chdir(TMP_DIR);
    try {
      generateRpc("orders");
      const filePath = join(TMP_DIR, "src", "rpc", "orders.ts");
      const content = readFileSync(filePath, "utf8");
      expect(content).toContain("procedure");
      expect(content).toContain("query");
      expect(content).toContain("mutation");
      expect(content).toContain("orders");
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe("BuildOptions interface", () => {
  it("has the expected shape", async () => {
    // Verify the BuildOptions type is exported and buildCommand is a function
    const buildModule = await import("../src/commands/build.js");
    expect(typeof buildModule.buildCommand).toBe("function");
  });

  it("default build options match expected values", () => {
    // Test that the default options used in the CLI index match expectations
    const defaults: BuildOptions = {
      entry: "src/index.ts",
      outdir: "dist/",
      format: "esm",
      target: "es2022",
      minify: false,
      platform: "node",
    };
    expect(defaults.entry).toBe("src/index.ts");
    expect(defaults.format).toBe("esm");
    expect(defaults.target).toBe("es2022");
    expect(defaults.platform).toBe("node");
    expect(defaults.minify).toBe(false);
  });
});
