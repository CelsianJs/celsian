import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
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
  it("streams static files without buffering before invoking the app", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "celsian-adapter-node-static-"));
    writeFileSync(join(tmpDir, "asset.txt"), "stream me");
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
    const chunks: Buffer[] = [];
    const res = new (class extends Writable {
      statusCode = 200;
      setHeader = vi.fn();
      _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
        chunks.push(Buffer.from(chunk));
        callback();
      }
    })();

    serve(app as never, { port: 0, host: "127.0.0.1", staticDir: tmpDir });
    expect(handler).toBeDefined();

    await handler?.({ url: "/asset.txt", headers: { host: "127.0.0.1" }, method: "GET" }, res);

    expect(res.statusCode).toBe(200);
    expect(res.setHeader).toHaveBeenCalledWith("content-type", "application/octet-stream");
    expect(Buffer.concat(chunks).toString()).toBe("stream me");
    expect(app.handle).not.toHaveBeenCalled();
  });
});
