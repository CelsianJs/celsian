// @celsian/adapter-node -- raw HTTP process-safety regression coverage

import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

interface Probe {
  port: number;
  startupLine: string;
  results: Array<{ response: string; healthy: string }>;
}

async function ipv6UnavailableReason(server = createServer()): Promise<string | null> {
  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (["EAFNOSUPPORT", "EADDRNOTAVAIL", "EPROTONOSUPPORT"].includes(error.code ?? "")) {
        resolve(`IPv6 loopback unavailable: ${error.code}`);
      } else reject(error);
    });
    server.listen(0, "::1", () => {
      server.close((error) => {
        if (error) reject(error);
        else resolve(null);
      });
    });
  });
}

function probe(targets: string[], host = "127.0.0.1"): Probe {
  const child = spawnSync(
    process.execPath,
    [
      "--unhandled-rejections=strict",
      "--import",
      "tsx",
      fileURLToPath(new URL("./fixtures/request-boundary.ts", import.meta.url)),
      host,
      JSON.stringify(targets),
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(child.error, child.stderr).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout) as Probe;
}

describe("adapter serve request boundary", () => {
  it("rejects unroutable targets and conversion failures without terminating the process", () => {
    const targets = [
      "GET http://[::1/ HTTP/1.1",
      "OPTIONS * HTTP/1.1",
      "GET http:///healthy HTTP/1.1",
      "GET http:// HTTP/1.1",
      "GET http://@example.test/healthy HTTP/1.1",
      "GET http://user:pass@example.test/healthy HTTP/1.1",
      "GET http://example.test/healthy#fragment HTTP/1.1",
      "GET http://example.test\\healthy HTTP/1.1",
      "TRACE /healthy HTTP/1.1",
      "GET /healthy HTTP/1.1\r\nBad-Header: \u0000",
    ];
    const result = probe(targets);
    for (const item of result.results) {
      expect(item.response).toMatch(/^HTTP\/1\.1 400/);
      expect(item.healthy).toMatch(/^HTTP\/1\.1 200/);
    }
  });

  it("uses absolute target authority and preserves escaped query order", () => {
    const result = probe([
      "GET https://example.test:8443/healthy?b=%2F&a=1&a=2&x=%23 HTTP/1.1",
      "GET http://example.test HTTP/1.1",
      "GET //healthy?q=%2F HTTP/1.1",
      "GET http://[::1]:8443/healthy?x=%2F HTTP/1.1",
    ]);
    expect(result.results[0].response).toContain('"host":"example.test:8443"');
    expect(result.results[0].response).toContain("https://example.test:8443/healthy?b=%2F&a=1&a=2&x=%23");
    expect(result.results[1].response).toContain('"host":"example.test"');
    expect(result.results[1].response).toContain("http://example.test/");
    expect(result.results[2].response).toContain(`http://127.0.0.1:${result.port}//healthy?q=%2F`);
    expect(result.results[2].response).toContain('"host":"conflicting.test"');
    expect(result.startupLine).toContain(`http://127.0.0.1:${result.port}`);
    expect(result.results[3].response).toContain("http://[::1]:8443/healthy?x=%2F");
    expect(result.results[3].response).toContain('"host":"[::1]:8443"');
  });

  it("contains handler, response conversion and partial-stream failures", () => {
    const result = probe([
      "GET /handler-failure HTTP/1.1",
      "GET /response-failure HTTP/1.1",
      "GET /stream-failure HTTP/1.1",
    ]);
    expect(result.results[0].response).toMatch(/^HTTP\/1\.1 500/);
    expect(result.results[1].response).toMatch(/^HTTP\/1\.1 500/);
    expect(result.results[2].response).toMatch(/^HTTP\/1\.1 200/);
    expect(result.results[2].response).toContain("partial");
    for (const item of result.results) expect(item.healthy).toMatch(/^HTTP\/1\.1 200/);
  });

  it("uses the actual ephemeral IPv6 port and bracketed address", async ({ skip }) => {
    const unavailable = await ipv6UnavailableReason();
    if (unavailable) skip(unavailable);
    const result = probe(["GET /healthy HTTP/1.1"], "::1");
    expect(result.results[0].response).toContain(`http://[::1]:${result.port}/healthy`);
    expect(result.startupLine).toContain(`http://[::1]:${result.port}`);
  });

  it.each(["EAFNOSUPPORT", "EADDRNOTAVAIL", "EPROTONOSUPPORT"])(
    "recognizes an independently probed %s IPv6 capability failure",
    async (code) => {
      const server = createServer();
      const error = Object.assign(new Error("IPv6 unavailable"), { code });
      vi.spyOn(server, "listen").mockImplementation(() => {
        queueMicrotask(() => server.emit("error", error));
        return server;
      });
      await expect(ipv6UnavailableReason(server)).resolves.toBe(`IPv6 loopback unavailable: ${code}`);
    },
  );

  it("fails rather than skipping unknown IPv6 bind errors", async () => {
    const server = createServer();
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(server, "listen").mockImplementation(() => {
      queueMicrotask(() => server.emit("error", error));
      return server;
    });
    await expect(ipv6UnavailableReason(server)).rejects.toBe(error);
  });
});
