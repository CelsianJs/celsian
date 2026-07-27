// @celsian/core -- test helper: boot a real server and send a raw request with
// an arbitrary `Host` header.
//
// Why not `app.inject()`: inject synthesizes `http://localhost/<url>` and sends
// no `Host` header at all, so the request's authority is whatever inject chose.
// Every host-sensitive bug in the framework (bind address leaking into
// `request.url`, CSRF comparing Origin against `0.0.0.0`, cache keys that ignore
// the tenant) is invisible through it, because the host trivially agrees with
// itself.
//
// Why not `fetch`: `Host` is a forbidden header name, so `fetch` drops it
// silently and the request arrives with the bind address again. `node:http` is
// the only client here that can actually put a different host on the wire.

import { request as httpRequest } from "node:http";
import { type ServeOptions, type ServeResult, serve } from "../../src/serve.js";

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface RawRequestOptions {
  method?: string;
  path: string;
  /** The `Host` header to send. Deliberately allowed to differ from the bind address. */
  host?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface TestServer {
  port: number;
  close: () => Promise<void>;
  send: (options: RawRequestOptions) => Promise<RawResponse>;
  /** `ws://127.0.0.1:<port><path>`, for handshake tests. */
  wsUrl: (path: string) => string;
}

/** Boot `app` on an ephemeral loopback port with test-safe serve() options. */
export async function startServer(
  app: Parameters<typeof serve>[0],
  options: Partial<ServeOptions> = {},
): Promise<TestServer> {
  let boundPort = 0;
  const result: ServeResult = await serve(app, {
    port: 0,
    host: "127.0.0.1",
    // Vitest owns the process; a test-scoped server must not install exit-on-fatal handlers.
    handleFatalErrors: false,
    onReady: ({ port }) => {
      boundPort = port;
    },
    ...options,
  });

  return {
    port: boundPort,
    close: () => result.close(),
    wsUrl: (path: string) => `ws://127.0.0.1:${boundPort}${path}`,
    send: (opts: RawRequestOptions) => sendRaw(boundPort, opts),
  };
}

/** One request over a real socket, with `Host` set to whatever the caller asked for. */
export function sendRaw(port: number, options: RawRequestOptions): Promise<RawResponse> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.host !== undefined) headers.host = options.host;
  if (options.body !== undefined) headers["content-length"] = String(Buffer.byteLength(options.body));

  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: options.path, method: options.method ?? "GET", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}
