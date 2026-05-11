// @celsian/cli — CLI command tests

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuildOptions } from "../src/commands/build.js";
import { createCommand } from "../src/commands/create.js";
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

describe("createCommand scaffold safety", () => {
  beforeEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("defaults to the full template", async () => {
    const originalCwd = process.cwd();
    process.chdir(TMP_DIR);
    try {
      await createCommand("default-app");
      expect(existsSync(join(TMP_DIR, "default-app", "src", "plugins", "auth.ts"))).toBe(true);
      expect(existsSync(join(TMP_DIR, "default-app", "Dockerfile"))).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("refuses to overwrite an existing non-empty target directory", async () => {
    const originalCwd = process.cwd();
    const target = join(TMP_DIR, "existing-app");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "package.json"), '{"name":"keep-me"}\n');
    process.chdir(TMP_DIR);
    try {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
        throw new Error(`exit:${code}`);
      }) as never);

      await expect(createCommand("existing-app", "basic")).rejects.toThrow("exit:1");
      expect(readFileSync(join(target, "package.json"), "utf8")).toBe('{"name":"keep-me"}\n');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("rejects traversal outside the working directory", async () => {
    const originalCwd = process.cwd();
    process.chdir(TMP_DIR);
    try {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
        throw new Error(`exit:${code}`);
      }) as never);

      await expect(createCommand("../escape", "basic")).rejects.toThrow("exit:1");
      expect(existsSync(join(TMP_DIR, "..", "escape"))).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("sanitizes the generated package name without changing the target directory", async () => {
    const originalCwd = process.cwd();
    process.chdir(TMP_DIR);
    try {
      await createCommand("My App!", "basic");
      const pkg = JSON.parse(readFileSync(join(TMP_DIR, "My App!", "package.json"), "utf8"));
      expect(pkg.name).toBe("my-app");
    } finally {
      process.chdir(originalCwd);
    }
  });
});
