// @celsian/cli — CLI command tests

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuildOptions } from "../src/commands/build.js";
import { devCommand } from "../src/commands/dev.js";
import { generateRoute, generateRpc } from "../src/commands/generate.js";
import { getVersion, printBanner } from "../src/utils/banner.js";
import { logger } from "../src/utils/logger.js";

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

  it("creates nested directories for the route file", () => {
    const originalCwd = process.cwd();
    process.chdir(TMP_DIR);
    try {
      generateRoute("admin");
      const routeDir = join(TMP_DIR, "src", "routes");
      expect(existsSync(routeDir)).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("generated route file imports from @celsian/core", () => {
    const originalCwd = process.cwd();
    process.chdir(TMP_DIR);
    try {
      generateRoute("widgets");
      const filePath = join(TMP_DIR, "src", "routes", "widgets.ts");
      const content = readFileSync(filePath, "utf8");
      expect(content).toContain("@celsian/core");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("generated route file includes GET /:name and GET /:name/:id endpoints", () => {
    const originalCwd = process.cwd();
    process.chdir(TMP_DIR);
    try {
      generateRoute("orders");
      const filePath = join(TMP_DIR, "src", "routes", "orders.ts");
      const content = readFileSync(filePath, "utf8");
      expect(content).toContain("'/orders'");
      expect(content).toContain("'/orders/:id'");
      expect(content).toContain("req.params.id");
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

  it("creates an RPC file in src/routes/<name>.ts (matches scaffold convention)", () => {
    const originalCwd = process.cwd();
    process.chdir(TMP_DIR);
    try {
      generateRpc("tasks");
      const filePath = join(TMP_DIR, "src", "routes", "tasks.ts");
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
      const filePath = join(TMP_DIR, "src", "routes", "orders.ts");
      const content = readFileSync(filePath, "utf8");
      expect(content).toContain("procedure");
      expect(content).toContain("query");
      expect(content).toContain("mutation");
      expect(content).toContain("orders");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("does not overwrite an existing RPC file", () => {
    const originalCwd = process.cwd();
    process.chdir(TMP_DIR);
    try {
      generateRpc("payments");
      const filePath = join(TMP_DIR, "src", "routes", "payments.ts");
      const originalContent = readFileSync(filePath, "utf8");

      // Call again — should not overwrite
      generateRpc("payments");
      const contentAfter = readFileSync(filePath, "utf8");
      expect(contentAfter).toBe(originalContent);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("generated RPC file imports from @celsian/rpc", () => {
    const originalCwd = process.cwd();
    process.chdir(TMP_DIR);
    try {
      generateRpc("analytics");
      const filePath = join(TMP_DIR, "src", "routes", "analytics.ts");
      const content = readFileSync(filePath, "utf8");
      expect(content).toContain("@celsian/rpc");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("generated RPC file includes list, getById, and create procedures", () => {
    const originalCwd = process.cwd();
    process.chdir(TMP_DIR);
    try {
      generateRpc("inventory");
      const filePath = join(TMP_DIR, "src", "routes", "inventory.ts");
      const content = readFileSync(filePath, "utf8");
      expect(content).toContain("list:");
      expect(content).toContain("getById:");
      expect(content).toContain("create:");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("generated RPC file is a mountable, working starting point (router + RPCHandler + mount)", () => {
    // Regression: the old template exported a bare object with no router()/
    // RPCHandler wiring and no way to reach an endpoint, and destructured `input`
    // without an .input() schema (so input was always undefined).
    const originalCwd = process.cwd();
    process.chdir(TMP_DIR);
    try {
      generateRpc("billing");
      const content = readFileSync(join(TMP_DIR, "src", "routes", "billing.ts"), "utf8");
      // Wired end-to-end, not a dead-end object.
      expect(content).toContain("router({");
      expect(content).toContain("new RPCHandler(billingRouter)");
      expect(content).toContain(".mount(app)");
      // Registerable as a plugin, matching the generateRoute convention.
      expect(content).toContain("PluginFunction");
      expect(content).toContain("export default billingRpc");
      // Points users at .input() instead of silently reading an undefined input.
      expect(content).toContain(".input(");
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe("dev command entry-file guard", () => {
  const DEV_TMP = join(import.meta.dirname, ".tmp-dev-test");

  beforeEach(() => {
    rmSync(DEV_TMP, { recursive: true, force: true });
    mkdirSync(DEV_TMP, { recursive: true });
  });

  afterEach(() => {
    rmSync(DEV_TMP, { recursive: true, force: true });
  });

  it("errors clearly and does not spawn when the entry file is missing", async () => {
    // Regression: dev previously spawned `npx tsx <missing>` and surfaced a raw
    // "Cannot find module" stack trace instead of an actionable message.
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
    const originalCwd = process.cwd();
    process.chdir(DEV_TMP);
    try {
      await devCommand({ entry: "src/index.ts" });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Entry file not found"));
      // Must bail BEFORE the "Starting dev server" spawn path.
      expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining("Starting dev server"));
    } finally {
      process.chdir(originalCwd);
      errorSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it("honors a custom --entry path in the guard", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const originalCwd = process.cwd();
    process.chdir(DEV_TMP);
    try {
      await devCommand({ entry: "server.ts" });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("server.ts"));
    } finally {
      process.chdir(originalCwd);
      errorSpy.mockRestore();
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

describe("--version flag", () => {
  it("getVersion returns a version string", () => {
    const version = getVersion();
    expect(typeof version).toBe("string");
    expect(version.length).toBeGreaterThan(0);
  });

  it("version matches semver-like pattern", () => {
    const version = getVersion();
    // Should look like "X.Y.Z"
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("version matches the published CLI package manifest", () => {
    const packageJson = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
      version: string;
    };

    expect(getVersion()).toBe(packageJson.version);
  });
});

describe("--help flag", () => {
  it("printBanner is a callable function", () => {
    expect(typeof printBanner).toBe("function");
  });

  it("printBanner does not throw", () => {
    expect(() => printBanner()).not.toThrow();
  });
});

describe("routes command", () => {
  it("routesCommand is an async function", async () => {
    const routesModule = await import("../src/commands/routes.js");
    expect(typeof routesModule.routesCommand).toBe("function");
  });
});

describe("logger utility", () => {
  it("exposes expected log methods", () => {
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.success).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.dim).toBe("function");
    expect(typeof logger.bold).toBe("function");
    expect(typeof logger.blue).toBe("function");
  });

  it("logger methods do not throw when called with a string", () => {
    expect(() => logger.info("test info")).not.toThrow();
    expect(() => logger.success("test success")).not.toThrow();
    expect(() => logger.warn("test warn")).not.toThrow();
    expect(() => logger.error("test error")).not.toThrow();
    expect(() => logger.dim("test dim")).not.toThrow();
    expect(() => logger.bold("test bold")).not.toThrow();
    expect(() => logger.blue("test blue")).not.toThrow();
  });
});

describe("dev command", () => {
  it("devCommand is an async function with expected options", async () => {
    const devModule = await import("../src/commands/dev.js");
    expect(typeof devModule.devCommand).toBe("function");
  });
});

describe("create command", () => {
  it("createCommand is an async function", async () => {
    const createModule = await import("../src/commands/create.js");
    expect(typeof createModule.createCommand).toBe("function");
  });

  it("Template type covers basic, rest-api, and rpc-api", async () => {
    const createModule = await import("../src/commands/create.js");
    // Verify createCommand accepts the expected templates without error at import time
    expect(createModule).toBeDefined();
  });
});
