// @celsian/cache, response cache against a REAL socket (Host header, binary bodies, compression)

import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createResponseCache } from "../src/response-cache.js";
import { MemoryKVStore } from "../src/store.js";

/**
 * These tests need a BOOTED server because `app.inject()` synthesizes a request
 * whose URL authority already matches its `Host` header. The bugs they cover
 * only appear when the two differ, which is the normal case: a server bound to
 * `0.0.0.0` builds `request.url` from the BIND address while the browser sends
 * the tenant's domain in `Host`.
 *
 * The request conversion below deliberately keeps that split (URL from the bind
 * address, real `Host` in the headers) so the cache is proven robust on its own,
 * whatever the adapter puts in `request.url`.
 */

interface ClientResponse {
  status: number;
  headers: NodeJS.Dict<string | string[]>;
  body: Buffer;
}

function toWebRequest(req: IncomingMessage, port: number): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  }
  return new Request(`http://0.0.0.0:${port}${req.url ?? "/"}`, { method: req.method, headers });
}

async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

function get(port: number, path: string, headers: Record<string, string>): Promise<ClientResponse> {
  return new Promise((resolve, reject) => {
    // node:http, not fetch: fetch refuses to set the forbidden `Host` header.
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

let server: Server;
let port: number;
let store: MemoryKVStore;

/** Bytes that are NOT valid UTF-8, so any `.text()` round trip mangles them. */
const BINARY_BODY = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0xff, 0xfe, 0xfd,
  0xfc, 0x80, 0x81, 0x82, 0x83,
]);
const GZIP_BODY = gzipSync(Buffer.from(JSON.stringify({ message: "compressed payload" })));

beforeAll(async () => {
  store = new MemoryKVStore({ cleanupIntervalMs: 0 });
  const cache = createResponseCache({ store });

  const handler = (request: Request): Response => {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/tenant-data":
        return new Response(JSON.stringify({ secretFor: request.headers.get("host") }), {
          headers: { "content-type": "application/json" },
        });
      case "/me":
        return new Response(JSON.stringify({ secret: `token-for-${request.headers.get("x-api-key")}` }), {
          headers: { "content-type": "application/json" },
        });
      case "/logo.png":
        return new Response(BINARY_BODY, { headers: { "content-type": "image/png" } });
      case "/compressed":
        return new Response(GZIP_BODY, {
          headers: {
            "content-type": "application/json",
            "content-encoding": "gzip",
            vary: "accept-encoding",
          },
        });
      default:
        return new Response("not found", { status: 404 });
    }
  };

  const wrapped = cache.wrap(handler);
  server = createServer((req, res) => {
    void wrapped(toWebRequest(req, port)).then((response) => writeWebResponse(res, response));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      port = typeof address === "object" && address !== null ? address.port : 0;
      resolve();
    });
  });
});

afterAll(async () => {
  store.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("cross-tenant cache leak (HIGH-1)", () => {
  it("does not serve tenant-a's body to tenant-b when both share a bind address", async () => {
    const a = await get(port, "/tenant-data", { host: "tenant-a.example.com" });
    const b = await get(port, "/tenant-data", { host: "tenant-b.example.com" });

    expect(JSON.parse(a.body.toString())).toEqual({ secretFor: "tenant-a.example.com" });
    expect(a.headers["x-cache"]).toBe("MISS");

    // Before the fix: `{"secretFor":"tenant-a.example.com"}` with x-cache HIT.
    expect(JSON.parse(b.body.toString())).toEqual({ secretFor: "tenant-b.example.com" });
    expect(b.headers["x-cache"]).toBe("MISS");
  });

  it("still caches repeat requests for the same tenant", async () => {
    const first = await get(port, "/tenant-data", { host: "tenant-c.example.com" });
    const second = await get(port, "/tenant-data", { host: "tenant-c.example.com" });

    expect(first.headers["x-cache"]).toBe("MISS");
    expect(second.headers["x-cache"]).toBe("HIT");
    expect(JSON.parse(second.body.toString())).toEqual({ secretFor: "tenant-c.example.com" });
  });
});

describe("credential detection failing open (HIGH-2)", () => {
  it("does not serve alice's API-key response to bob", async () => {
    const alice = await get(port, "/me", { host: "api.example.com", "x-api-key": "alice-key" });
    const bob = await get(port, "/me", { host: "api.example.com", "x-api-key": "bob-key" });

    expect(JSON.parse(alice.body.toString())).toEqual({ secret: "token-for-alice-key" });
    // Before the fix: bob received `token-for-alice-key` with x-cache HIT.
    expect(JSON.parse(bob.body.toString())).toEqual({ secret: "token-for-bob-key" });
    expect(bob.headers["x-cache"]).toBeUndefined();
  });
});

describe("binary bodies (HIGH-4)", () => {
  it("keeps an image intact on the MISS and on the HIT", async () => {
    const miss = await get(port, "/logo.png", { host: "cdn.example.com" });
    const hit = await get(port, "/logo.png", { host: "cdn.example.com" });

    expect(miss.headers["x-cache"]).toBe("MISS");
    expect(hit.headers["x-cache"]).toBe("HIT");
    // Before the fix both were 42 bytes of U+FFFD soup instead of these 24.
    expect(miss.body.equals(BINARY_BODY)).toBe(true);
    expect(hit.body.equals(BINARY_BODY)).toBe(true);
  });
});

describe("compression composes with the cache (M8)", () => {
  it("stores a gzip body and both responses still gunzip", async () => {
    const miss = await get(port, "/compressed", { host: "app.example.com", "accept-encoding": "gzip" });
    const hit = await get(port, "/compressed", { host: "app.example.com", "accept-encoding": "gzip" });

    // Before the fix `Vary: accept-encoding` was refused by the storability
    // check, so the cache silently did nothing, and the README's workaround
    // (varyHeaders: ['accept-encoding']) then hit the text round trip and the
    // MISS failed to gunzip with "incorrect header check".
    expect(miss.headers["x-cache"]).toBe("MISS");
    expect(hit.headers["x-cache"]).toBe("HIT");
    expect(JSON.parse(gunzipSync(miss.body).toString())).toEqual({ message: "compressed payload" });
    expect(JSON.parse(gunzipSync(hit.body).toString())).toEqual({ message: "compressed payload" });
  });
});
