// @celsian/core -- Raw TCP request failures stay inside an isolated Node server

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

/** Probe the OS independently of Celsian; unknown failures must fail the test. */
async function unavailableIPv6(server = createServer()): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      server.close();
      if (error.code === "EAFNOSUPPORT" || error.code === "EADDRNOTAVAIL" || error.code === "EPROTONOSUPPORT") {
        resolve(error.code);
      } else reject(error);
    });
    server.listen(0, "::1", () => server.close((error) => (error ? reject(error) : resolve(undefined))));
  });
}

interface Result {
  first: string;
  healthy: string;
  bound: string;
  port: number;
  closeMs: number;
  connections: number;
}

async function run(target: string, mode = "http", host = "127.0.0.1"): Promise<Result> {
  const fixture = fileURLToPath(new URL("./fixtures/serve-request-boundary.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", fixture, target, mode, host], { stdio: "pipe" });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 6_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    expect(code, stderr).toBe(0);
    expect(stderr).not.toContain("unhandledRejection");
    expect(stderr).not.toContain("uncaughtException");
    const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as Result;
    expect(result.healthy).toContain("HTTP/1.1 200");
    expect(result.closeMs).toBeLessThan(750);
    expect(result.connections).toBe(0);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function payload(response: string): { url: string; host: string | null; query: unknown } {
  return JSON.parse(response.split("\r\n\r\n")[1]);
}

describe("serve() Node request boundary", () => {
  it.each([
    "OPTIONS * HTTP/1.1",
    "GET ftp://example.test/ok HTTP/1.1",
    "GET http:///ok HTTP/1.1",
    "GET http://user@example.test/ok HTTP/1.1",
    "GET http://@example.test/ok HTTP/1.1",
    "GET http://example.test/ok#fragment HTTP/1.1",
    "GET http://example.test\\bad/ok HTTP/1.1",
    "GET http://[broken/ok HTTP/1.1",
    "GET http://example.test:99999/ok HTTP/1.1",
  ])("returns 400 and stays live for %s", async (target) => {
    expect((await run(target)).first).toContain("HTTP/1.1 400");
  });

  it.each(["http", "https", "HTTP"])("routes %s absolute-form using its own authority and query", async (scheme) => {
    const result = await run(`GET ${scheme}://example.test:8081/ok?x=1&x=2&escaped=%2F+%20 HTTP/1.1`);
    expect(result.first).toContain("HTTP/1.1 200");
    expect(payload(result.first)).toEqual({
      url: `${scheme.toLowerCase()}://example.test:8081/ok?x=1&x=2&escaped=%2F+%20`,
      host: "example.test:8081",
      query: { x: ["1", "2"], escaped: "/  " },
    });
  });
  it("routes an absolute authority with no path to root", async () => {
    const result = await run("GET http://example.test HTTP/1.1");
    expect(payload(result.first).url).toBe("http://example.test/");
  });
  it("preserves ordinary origin-form Host handling", async () => {
    const result = await run("GET /ok?x=1&x=2 HTTP/1.1");
    expect(payload(result.first)).toEqual({
      url: "http://conflicting.test/ok?x=1&x=2",
      host: "conflicting.test",
      query: { x: ["1", "2"] },
    });
  });
  it("accepts a bracketed absolute-form authority", async () => {
    const result = await run("GET http://[::1]:8081/ok HTTP/1.1");
    expect(payload(result.first).url).toBe("http://[::1]:8081/ok");
    expect(payload(result.first).host).toBe("[::1]:8081");
  });
  it("preserves escaped path and query text", async () => {
    const result = await run("GET https://example.test/encoded/a%2Fb?x=%2f&x=two HTTP/1.1");
    expect(payload(result.first).url).toBe("https://example.test/encoded/a%2Fb?x=%2f&x=two");
  });
  it("keeps double-slash origin-form as a path, not an authority", async () => {
    expect((await run("GET //example.test/ok HTTP/1.1")).first).toContain("HTTP/1.1 404");
  });
  it("uses the real bound port when Host is absent", async () => {
    const result = await run("GET /ok HTTP/1.1");
    expect(payload(result.bound).url).toBe(`http://127.0.0.1:${result.port}/ok`);
  });
  it("handles an IPv6 listener with a bracketed authority", async (context) => {
    const unavailable = await unavailableIPv6();
    if (unavailable)
      context.skip(`Independent Node bind to ::1 reports ${unavailable}; IPv6 is unavailable on this OS`);
    const result = await run("GET /ok HTTP/1.1", "http", "::1");
    expect(payload(result.bound).url).toBe(`http://[::1]:${result.port}/ok`);
  });
  it("contains conversion failures and cleans up their abort listener", async () => {
    expect((await run("GET /ok HTTP/1.1", "conversion")).first).toContain("HTTP/1.1 400");
  });
  it("contains static response failures before writing headers", async () => {
    expect((await run("GET /serve-request-boundary.ts HTTP/1.1", "static-write")).first).toContain("HTTP/1.1 500");
  });
  it("rejects malformed static decoding and drains immediately", async () => {
    expect((await run("GET /%ZZ HTTP/1.1", "static")).first).toContain("HTTP/1.1 400");
  });
  it("contains response failures before headers", async () => {
    expect((await run("GET /failure HTTP/1.1", "response-before")).first).toContain("HTTP/1.1 500");
  });
  it("destroys a partially written response without a second response", async () => {
    const result = await run("GET /failure HTTP/1.1", "response-after");
    expect(result.first).toContain("HTTP/1.1 200");
    expect(result.first).toContain("partial");
    expect(result.first).not.toContain("Internal Server Error");
  });
  it("contains unsupported upgrade targets", async () => {
    expect((await run("GET * HTTP/1.1", "upgrade")).first).toContain("HTTP/1.1 400");
  });
  it("contains malformed absolute upgrade targets", async () => {
    expect((await run("GET http://[::1/ok HTTP/1.1", "upgrade")).first).toContain("HTTP/1.1 400");
  });
  it("destroys an accepted upgrade when a synchronous open handler fails", async () => {
    const result = await run("GET /ok HTTP/1.1", "upgrade-open");
    expect(result.first).toContain("HTTP/1.1 101");
    expect(result.first).not.toContain("HTTP/1.1 400");
    expect(result.first).not.toContain("HTTP/1.1 500");
  });
  it("cleans the accepted upgrade registry if effective URL conversion fails", async () => {
    const result = await run("GET /ok HTTP/1.1", "upgrade-invalid-host");
    expect(result.first).toContain("HTTP/1.1 101");
    expect(result.first.match(/HTTP\/1\.1/g)).toHaveLength(1);
    expect(result.connections).toBe(0);
  });
});

describe("IPv6 listener capability probe", () => {
  it.each(["EAFNOSUPPORT", "EADDRNOTAVAIL", "EPROTONOSUPPORT"])(
    "identifies only the known OS limitation %s",
    async (code) => {
      const server = createServer();
      const listen = vi.spyOn(server, "listen").mockImplementation(() => {
        queueMicrotask(() => server.emit("error", Object.assign(new Error("simulated bind failure"), { code })));
        return server;
      });
      try {
        await expect(unavailableIPv6(server)).resolves.toBe(code);
      } finally {
        listen.mockRestore();
      }
    },
  );
  it("does not hide unknown bind failures", async () => {
    const server = createServer();
    const error = Object.assign(new Error("unexpected bind failure"), { code: "EACCES" });
    const listen = vi.spyOn(server, "listen").mockImplementation(() => {
      queueMicrotask(() => server.emit("error", error));
      return server;
    });
    try {
      await expect(unavailableIPv6(server)).rejects.toBe(error);
    } finally {
      listen.mockRestore();
    }
  });
});
