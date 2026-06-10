import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultHost, defineConfig, loadConfig } from "../src/config.js";

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
