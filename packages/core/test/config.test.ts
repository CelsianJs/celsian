import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigLoadError, defaultHost, defineConfig, loadConfig } from "../src/config.js";

describe("defineConfig", () => {
  it("should return the config as-is", () => {
    const config = defineConfig({
      server: { port: 8080, host: "0.0.0.0" },
    });
    expect(config.server?.port).toBe(8080);
    expect(config.server?.host).toBe("0.0.0.0");
  });

  it("should accept empty config", () => {
    const config = defineConfig({});
    expect(config).toEqual({});
  });

  it("should accept full config", () => {
    const config = defineConfig({
      server: { port: 3000, host: "localhost", trustProxy: true, prefix: "/api" },
      schema: { provider: "typebox" },
      rpc: { basePath: "/_rpc", openapi: { title: "My API", version: "1.0.0" } },
    });
    expect(config.server?.trustProxy).toBe(true);
    expect(config.schema?.provider).toBe("typebox");
    expect(config.rpc?.openapi?.title).toBe("My API");
  });
});

describe("loadConfig host defaults (CORE-01)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults host to localhost outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("HOST", "");
    const config = await loadConfig("/nonexistent-config-root");
    expect(config.server?.host).toBe("localhost");
  });

  it("defaults host to 0.0.0.0 in production (container reachability)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("HOST", "");
    const config = await loadConfig("/nonexistent-config-root");
    expect(config.server?.host).toBe("0.0.0.0");
  });

  it("honors process.env.HOST over the NODE_ENV-based default", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("HOST", "10.1.2.3");
    const config = await loadConfig("/nonexistent-config-root");
    expect(config.server?.host).toBe("10.1.2.3");
  });

  it("defaultHost mirrors the same policy", () => {
    vi.stubEnv("HOST", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(defaultHost()).toBe("0.0.0.0");
    vi.stubEnv("NODE_ENV", "test");
    expect(defaultHost()).toBe("localhost");
    vi.stubEnv("HOST", "192.168.1.10");
    expect(defaultHost()).toBe("192.168.1.10");
  });
});

describe("loadConfig surfaces broken config files (CORE-config-fail-loud)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("returns defaults when no config file exists (missing file is not an error)", async () => {
    dir = mkdtempSync(join(tmpdir(), "celsian-cfg-none-"));
    const config = await loadConfig(dir);
    expect(config.server?.port).toBe(3000);
  });

  it("loads and merges a valid config file", async () => {
    dir = mkdtempSync(join(tmpdir(), "celsian-cfg-ok-"));
    writeFileSync(join(dir, "celsian.config.mjs"), "export default { server: { port: 8080 } };\n");
    const config = await loadConfig(dir);
    expect(config.server?.port).toBe(8080);
  });

  it("throws ConfigLoadError when the config file exists but throws at load time", async () => {
    // Regression: a bare `catch {}` used to swallow a real config error and
    // silently fall back to defaults (port 3000), so a typo in celsian.config.*
    // meant the user's settings were silently ignored with no diagnostic.
    dir = mkdtempSync(join(tmpdir(), "celsian-cfg-boom-"));
    writeFileSync(join(dir, "celsian.config.mjs"), "throw new Error('boom in user config');\n");

    await expect(loadConfig(dir)).rejects.toBeInstanceOf(ConfigLoadError);
    await expect(loadConfig(dir)).rejects.toThrow(/celsian\.config\.mjs/);
    await expect(loadConfig(dir)).rejects.toThrow(/boom in user config/);
  });

  it("surfaces a missing transitive import inside an existing config (not treated as absent)", async () => {
    dir = mkdtempSync(join(tmpdir(), "celsian-cfg-badimport-"));
    writeFileSync(join(dir, "celsian.config.mjs"), "import './does-not-exist-anywhere.mjs';\nexport default {};\n");
    await expect(loadConfig(dir)).rejects.toBeInstanceOf(ConfigLoadError);
  });
});
