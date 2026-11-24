// @celsian/core -- the built-in error, 404 and 405 answers take the single Node write
//
// A thrown error, a validation failure, an unknown path and a wrong method are
// answered with a JSON body core builds itself. Those were plain Responses, so
// the Node server drained each from a stream and sent it chunked, while the
// same JSON from reply.json() went out in one write. They are fast responses
// now. The bodies, statuses and headers are the ones they always were.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CelsianApp, createApp } from "../src/app.js";
import { HttpError, ValidationError } from "../src/errors.js";
import { getFastPayload } from "../src/fast-response.js";
import { cors } from "../src/plugins/cors.js";
import { security } from "../src/plugins/security.js";
import { type ServeResult, serve } from "../src/serve.js";

let server: ServeResult | undefined;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.restoreAllMocks();
});

async function listen(app: CelsianApp): Promise<string> {
  let port = 0;
  server = await serve(app, {
    port: 0,
    host: "127.0.0.1",
    onReady: (info) => {
      port = info.port;
    },
  });
  return `http://127.0.0.1:${port}`;
}

function routes(app: CelsianApp): void {
  app.get("/boom", () => {
    throw new Error("boom");
  });
  app.get("/teapot", () => {
    throw new HttpError(418, "I'm a teapot", { code: "TEAPOT" });
  });
  app.get("/unavailable", () => {
    throw new HttpError(503, "down for maintenance");
  });
  app.get("/invalid", () => {
    throw new ValidationError([{ path: ["name"], message: "Required" }]);
  });
  app.get("/async-boom", async () => {
    await Promise.resolve();
    throw new Error("async boom");
  });
  app.get("/only-get", (_req, reply) => reply.json({ ok: true }));
}

const CASES: { name: string; method?: string; path: string; status: number; body: Record<string, unknown> }[] = [
  {
    name: "a thrown Error",
    path: "/boom",
    status: 500,
    body: { error: "boom", statusCode: 500, code: "INTERNAL_SERVER_ERROR" },
  },
  {
    name: "an Error from an async handler",
    path: "/async-boom",
    status: 500,
    body: { error: "async boom", statusCode: 500 },
  },
  {
    name: "an HttpError",
    path: "/teapot",
    status: 418,
    body: { error: "I'm a teapot", statusCode: 418, code: "TEAPOT" },
  },
  { name: "a 5xx HttpError", path: "/unavailable", status: 503, body: { statusCode: 503 } },
  { name: "a ValidationError", path: "/invalid", status: 400, body: { error: "Validation failed", statusCode: 400 } },
  {
    name: "an unknown path",
    path: "/nope",
    status: 404,
    body: { error: "Not Found", statusCode: 404, code: "NOT_FOUND" },
  },
  {
    name: "a wrong method",
    method: "DELETE",
    path: "/only-get",
    status: 405,
    body: { error: "Method Not Allowed", statusCode: 405, code: "METHOD_NOT_ALLOWED" },
  },
];

describe.each([
  ["a bare app", false],
  ["cors() and security() registered", true],
] as const)("built-in error answers over a real socket, %s", (_label, withPlugins) => {
  it.each(CASES)("$name is one sized write with its usual body", async ({ method, path, status, body }) => {
    const app = createApp();
    if (withPlugins) {
      await app.register(cors(), { encapsulate: false });
      await app.register(security(), { encapsulate: false });
    }
    routes(app);
    const base = await listen(app);

    const viaNode = await fetch(`${base}${path}`, { method });
    const viaInject = await app.inject({ method: method as "DELETE" | undefined, url: path });
    const nodeText = await viaNode.text();
    const injectText = await viaInject.text();

    for (const [res, text] of [
      [viaNode, nodeText],
      [viaInject, injectText],
    ] as const) {
      expect(res.status).toBe(status);
      expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(JSON.parse(text)).toMatchObject(body);
      if (status === 405) expect(res.headers.get("allow")).toBe("GET, HEAD");
      if (withPlugins) {
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
        expect(res.headers.get("x-frame-options")).toBe("DENY");
      }
    }
    // The stack differs between the two requests; everything else is the same body.
    const strip = (text: string) => ({ ...JSON.parse(text), stack: undefined });
    expect(strip(nodeText)).toEqual(strip(injectText));

    // One writeHead()+end(): sized, not chunked.
    expect(viaNode.headers.get("content-length")).toBe(String(Buffer.byteLength(nodeText)));
    expect(viaNode.headers.get("transfer-encoding")).toBeNull();
  });
});

describe("built-in error answers", () => {
  it("carry a fast payload out of handle()", async () => {
    const app = createApp();
    routes(app);

    for (const [method, path] of [
      ["GET", "/boom"],
      ["GET", "/teapot"],
      ["GET", "/invalid"],
      ["GET", "/nope"],
      ["DELETE", "/only-get"],
    ] as const) {
      const res = await app.handle(new Request(`http://localhost${path}`, { method }));
      const payload = getFastPayload(res);
      expect(payload, path).toBeDefined();
      expect(payload?.status, path).toBe(res.status);
      expect(payload?.body, path).toBe(await res.text());
    }
  });

  it("keep the stack out of the body in production, and in it otherwise", async () => {
    const app = createApp();
    routes(app);

    const dev = (await (await app.inject({ url: "/boom" })).json()) as { error: string; stack?: string };
    expect(dev.error).toBe("boom");
    expect(String(dev.stack)).toContain("Error: boom");

    vi.stubEnv("NODE_ENV", "production");
    try {
      const prod = await (await app.inject({ url: "/boom" })).json();
      expect(prod).toEqual({ error: "Internal Server Error", statusCode: 500, code: "INTERNAL_SERVER_ERROR" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("answer a HEAD with the same status and headers and no body", async () => {
    const app = createApp();
    routes(app);
    const base = await listen(app);

    for (const path of ["/boom", "/nope"]) {
      const res = await fetch(`${base}${path}`, { method: "HEAD" });
      expect(res.status, path).toBe(path === "/boom" ? 500 : 404);
      expect(res.headers.get("content-type"), path).toBe("application/json; charset=utf-8");
      expect(await res.text(), path).toBe("");
    }
  });

  it("are not shared between requests: an onSend header on one 404 does not reach the next", async () => {
    const app = createApp();
    let n = 0;
    app.addHook("onSend", (_req, reply) => {
      if (++n === 1) reply.header("x-first-only", "1");
    });
    const base = await listen(app);

    expect((await fetch(`${base}/nope`)).headers.get("x-first-only")).toBe("1");
    expect((await fetch(`${base}/nope`)).headers.get("x-first-only")).toBeNull();
  });
});
