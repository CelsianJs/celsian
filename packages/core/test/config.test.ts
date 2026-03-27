import { describe, expect, it } from "vitest";
import { defineConfig } from "../src/config.js";

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
