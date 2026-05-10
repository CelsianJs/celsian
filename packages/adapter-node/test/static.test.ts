import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let tmpDir: string | undefined;

describe("adapter-node static serving hardening", () => {
  afterEach(() => {
    vi.doUnmock("node:http");
    vi.resetModules();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it("returns 400 for malformed static URL encodings before invoking the app", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "celsian-adapter-node-static-"));
    let handler: ((req: unknown, res: unknown) => Promise<void>) | undefined;

    vi.doMock("node:http", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:http")>();
      return {
        ...actual,
        createServer: vi.fn((nextHandler) => {
          handler = nextHandler as typeof handler;
          return { listen: vi.fn((_port: number, _host: string, callback?: () => void) => callback?.()) };
        }),
      };
    });

    const { serve } = await import("../src/index.js");
    const app = { handle: vi.fn(async () => new Response("ok")) };

    serve(app as never, { port: 0, host: "127.0.0.1", staticDir: tmpDir });
    expect(handler).toBeDefined();

    const res = {
      statusCode: 200,
      body: "",
      setHeader: vi.fn(),
      end: vi.fn(function (this: typeof res, body?: string) {
        this.body = body ?? "";
      }),
    };

    await handler?.({ url: "/%E0%A4%A", headers: { host: "127.0.0.1" }, method: "GET" }, res);

    expect(res.statusCode).toBe(400);
    expect(res.end).toHaveBeenCalledWith("Bad Request");
    expect(app.handle).not.toHaveBeenCalled();
  });
});
