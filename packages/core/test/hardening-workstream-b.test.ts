// @celsian/core -- Regression tests for the 0.6.0 HTTP-surface hardening.
// Every case here reproduces a proven exploit against the pre-0.6.0 behavior.

import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { readBodyText } from "../src/body-parser.js";
import { handleError } from "../src/error-handler.js";
import { CelsianError, HttpError } from "../src/errors.js";
import { withETag } from "../src/plugins/etag.js";
import { openapi } from "../src/plugins/openapi.js";
import { type UploadedFile, upload } from "../src/plugins/upload.js";
import { createReply } from "../src/reply.js";
import { Router } from "../src/router.js";
import { createSSEStream } from "../src/sse.js";
import type { CelsianRequest } from "../src/types.js";
import { json } from "./helpers/json.js";

const TMP_DIR = join(import.meta.dirname ?? ".", "__tmp_hardening_b__");
const PUBLIC_DIR = join(TMP_DIR, "public");

beforeAll(async () => {
  await mkdir(PUBLIC_DIR, { recursive: true });
  await writeFile(join(TMP_DIR, "secret.txt"), "TOP SECRET");
  await writeFile(join(PUBLIC_DIR, "ok.txt"), "public file");
  await symlink(join(TMP_DIR, "secret.txt"), join(PUBLIC_DIR, "link.txt"));
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

// ─── H-1 / H-2: file serving is confined ───

describe("reply.sendFile / reply.download confinement", () => {
  it("download() rejects traversal out of the root (H-1)", async () => {
    const app = createApp();
    app.get("/d/:name", async (req, reply) => reply.download(req.params.name!, { root: PUBLIC_DIR }));

    const res = await app.handle(new Request("http://localhost/d/..%2Fsecret.txt"));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("TOP SECRET");
  });

  it("download() confines to the CWD when no root is given (H-1)", async () => {
    const app = createApp();
    app.get("/d", async (_req, reply) => reply.download("/etc/passwd"));

    const res = await app.handle(new Request("http://localhost/d"));
    expect(res.status).toBe(403);
  });

  it("download() still serves a file inside the root", async () => {
    const app = createApp();
    app.get("/d/:name", async (req, reply) => reply.download(req.params.name!, { root: PUBLIC_DIR }));

    const res = await app.handle(new Request("http://localhost/d/ok.txt"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="ok.txt"');
    expect(await res.text()).toBe("public file");
  });

  it("download() keeps the legacy string filename argument working", async () => {
    const app = createApp();
    app.get("/d", async (_req, reply) => reply.download(join(PUBLIC_DIR, "ok.txt"), "renamed.txt"));

    const res = await app.handle(new Request("http://localhost/d"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="renamed.txt"');
  });

  it("sendFile() without root rejects traversal out of the CWD (H-2)", async () => {
    const app = createApp();
    app.get("/g/:name", async (req, reply) => reply.sendFile(req.params.name!));

    const res = await app.handle(new Request("http://localhost/g/..%2F..%2F..%2Fetc%2Fpasswd"));
    expect(res.status).toBe(403);
  });

  it("sendFile() with root refuses a symlink that escapes the root (H-3)", async () => {
    const app = createApp();
    app.get("/f/:name", async (req, reply) => reply.sendFile(req.params.name!, { root: PUBLIC_DIR }));

    const res = await app.handle(new Request("http://localhost/f/link.txt"));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("TOP SECRET");
  });

  it("sendFile() follows an escaping symlink only when allowSymlinks is set", async () => {
    const app = createApp();
    app.get("/f/:name", async (req, reply) =>
      reply.sendFile(req.params.name!, { root: PUBLIC_DIR, allowSymlinks: true }),
    );

    const res = await app.handle(new Request("http://localhost/f/link.txt"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("TOP SECRET");
  });

  it("sendFile() returns 404 (not 500) for a missing file", async () => {
    const app = createApp();
    app.get("/f", async (_req, reply) => reply.sendFile("nope.txt", { root: PUBLIC_DIR }));

    const res = await app.handle(new Request("http://localhost/f"));
    expect(res.status).toBe(404);
  });
});

// ─── M-2: open redirect ───

describe("reply.redirect open-redirect defenses", () => {
  it("rejects an absolute URL to a host that is not allow-listed", () => {
    const reply = createReply();
    expect(() => reply.redirect("https://evil.com")).toThrow(HttpError);
  });

  it("rejects the backslash protocol-relative form", () => {
    const reply = createReply();
    expect(() => reply.redirect("/\\evil.com")).toThrow(HttpError);
  });

  it("turns a malformed scheme into a 4xx, not a 500", () => {
    const reply = createReply();
    let status = 0;
    try {
      reply.redirect("https:/\\evil.com");
    } catch (err) {
      status = (err as HttpError).statusCode;
    }
    expect(status).toBe(400);
  });

  it("allows an explicitly allow-listed host", () => {
    const reply = createReply();
    const res = reply.redirect("https://checkout.example.com/pay", 302, {
      allowedHosts: ["checkout.example.com"],
    });
    expect(res.headers.get("location")).toBe("https://checkout.example.com/pay");
  });
});

// ─── M-1: path aliasing ───

describe("router path canonicalization", () => {
  function adminRouter(): Router {
    const router = new Router();
    router.addRoute("GET", "/admin", () => new Response("ok"));
    return router;
  }

  it("serves only the canonical spelling of a path", () => {
    const router = adminRouter();
    expect(router.match("GET", "/admin")).not.toBeNull();
    // Trailing slash stays an accepted alias by default (documented, opt-out).
    expect(router.match("GET", "/admin/")).not.toBeNull();
    for (const aliased of ["//admin", "///admin", "/admin//", "/./admin", "/admin/./"]) {
      expect(router.match("GET", aliased), aliased).toBeNull();
    }
  });

  it("returns 404 for aliased paths end to end", async () => {
    const app = createApp();
    app.get("/admin", (_req, reply) => reply.json({ admin: true }));

    expect((await app.handle(new Request("http://localhost/admin"))).status).toBe(200);
    expect((await app.handle(new Request("http://localhost//admin"))).status).toBe(404);
    expect((await app.handle(new Request("http://localhost/admin//"))).status).toBe(404);
    // Note: the WHATWG URL parser already collapses "/./admin" to "/admin"
    // before the router sees it, so that form is covered at the router level.
  });

  it("can reject the trailing slash too", () => {
    const router = new Router({ ignoreTrailingSlash: false });
    router.addRoute("GET", "/admin", () => new Response("ok"));
    expect(router.match("GET", "/admin")).not.toBeNull();
    expect(router.match("GET", "/admin/")).toBeNull();
  });

  it("does not report aliased paths as existing (405 detection)", () => {
    expect(adminRouter().hasPath("//admin")).toBe(false);
    expect(adminRouter().hasPath("/admin")).toBe(true);
  });
});

// ─── M-3: encoded slashes in params ───

describe("route params and encoded separators", () => {
  it("exposes the undecoded value as rawParams", () => {
    const router = new Router();
    router.addRoute("GET", "/files/:name", () => new Response("ok"));

    const match = router.match("GET", "/files/..%2F..%2Fetc%2Fpasswd");
    expect(match?.params.name).toBe("../../etc/passwd");
    expect(match?.rawParams.name).toBe("..%2F..%2Fetc%2Fpasswd");
  });

  it("rejects separators in params when strictParams is on", () => {
    const router = new Router({ strictParams: true });
    router.addRoute("GET", "/files/:name", () => new Response("ok"));

    expect(() => router.match("GET", "/files/..%2Fetc")).toThrow(HttpError);
    expect(router.match("GET", "/files/report.pdf")?.params.name).toBe("report.pdf");
  });
});

// ─── Router registration mistakes ───

describe("router registration conflicts", () => {
  it("throws on a duplicate route instead of silently overwriting", () => {
    const router = new Router();
    router.addRoute("GET", "/dup", () => new Response("first"));
    expect(() => router.addRoute("GET", "/dup", () => new Response("second"))).toThrow(CelsianError);
  });

  it("allows the same path under a different method", () => {
    const router = new Router();
    router.addRoute("GET", "/thing", () => new Response("get"));
    expect(() => router.addRoute("POST", "/thing", () => new Response("post"))).not.toThrow();
  });

  it("throws on sibling routes that name the same param position differently", () => {
    const router = new Router();
    router.addRoute("GET", "/x/:id/one", () => new Response("one"));
    expect(() => router.addRoute("GET", "/x/:slug/two", () => new Response("two"))).toThrow(/:slug/);
  });

  it("surfaces duplicate registration through createApp", () => {
    const app = createApp();
    app.get("/dup", (_req, reply) => reply.json({ n: 1 }));
    expect(() => app.get("/dup", (_req, reply) => reply.json({ n: 2 }))).toThrow(CelsianError);
  });
});

// ─── M-13: SSE injection ───

describe("SSE field sanitization", () => {
  async function firstFrame(event: { event?: string; id?: string; data: unknown }): Promise<string> {
    const request = new Request("http://localhost/events");
    const channel = createSSEStream(request, { pingInterval: 0 });
    channel.send(event);
    const reader = (channel.response.body as ReadableStream<Uint8Array>).getReader();
    const { value } = await reader.read();
    channel.close();
    return new TextDecoder().decode(value);
  }

  it("does not let the event name forge extra frames", async () => {
    const frame = await firstFrame({
      event: 'ping\ndata: {"role":"admin"}\n\nevent: msg',
      data: "hello",
    });
    // One event line, one data line, one terminator: the injected payload stays
    // inert inside the event name instead of becoming frames of its own.
    expect(frame.match(/^event: /gm)?.length).toBe(1);
    expect(frame.match(/^data: /gm)?.length).toBe(1);
    expect(frame).toContain("data: hello");
    expect(frame.endsWith("\n\n")).toBe(true);
    expect(frame.slice(0, -2)).not.toContain("\n\n");
  });

  it("does not let the id field forge extra frames", async () => {
    const frame = await firstFrame({ id: "1\ndata: injected", data: "hello" });
    expect(frame.match(/^id: /gm)?.length).toBe(1);
    expect(frame.match(/^data: /gm)?.length).toBe(1);
    expect(frame).toContain("data: hello");
  });
});

// ─── M-14: upload limits and file names ───

function multipartRequest(
  url: string,
  parts: {
    files?: { field: string; name: string; type: string; content: string | Uint8Array<ArrayBuffer> }[];
    fields?: Record<string, string>;
  },
): Request {
  const formData = new FormData();
  for (const [key, value] of Object.entries(parts.fields ?? {})) {
    formData.append(key, value);
  }
  for (const f of parts.files ?? []) {
    const data = typeof f.content === "string" ? new TextEncoder().encode(f.content) : f.content;
    formData.append(f.field, new File([new Blob([data], { type: f.type })], f.name, { type: f.type }));
  }
  return new Request(`http://localhost${url}`, { method: "POST", body: formData });
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

describe("upload plugin hardening", () => {
  async function uploadApp(options: Parameters<typeof upload>[0] = {}) {
    const app = createApp();
    await app.register(upload(options), { encapsulate: false });
    app.post("/upload", (req, reply) => {
      const files = (req as Record<string, unknown>).files as UploadedFile[];
      const fields = (req as Record<string, unknown>).fields as Record<string, string>;
      return reply.json({
        names: files.map((f) => f.fileName),
        raw: files.map((f) => f.rawFileName),
        fields: Object.keys(fields),
        polluted: ({} as Record<string, unknown>).polluted ?? null,
      });
    });
    return app;
  }

  it("sanitizes the client-supplied file name and keeps the raw one", async () => {
    const app = await uploadApp();
    const res = await app.handle(
      multipartRequest("/upload", {
        files: [{ field: "f", name: "../../etc/passwd", type: "text/plain", content: "x" }],
      }),
    );
    const body = await json<{ names: string[]; raw: string[] }>(res);
    expect(body.names[0]).toBe("passwd");
    expect(body.names[0]).not.toContain("/");
    expect(body.raw[0]).toBe("../../etc/passwd");
  });

  it("rejects a file over maxFileSize before buffering it", async () => {
    const app = await uploadApp({ maxFileSize: 8 });
    const res = await app.handle(
      multipartRequest("/upload", {
        files: [{ field: "f", name: "big.txt", type: "text/plain", content: "0123456789" }],
      }),
    );
    expect(res.status).toBe(413);
  });

  it("rejects too many files before buffering any of them", async () => {
    const app = await uploadApp({ maxFiles: 1 });
    const res = await app.handle(
      multipartRequest("/upload", {
        files: [
          { field: "a", name: "a.txt", type: "text/plain", content: "a" },
          { field: "b", name: "b.txt", type: "text/plain", content: "b" },
        ],
      }),
    );
    expect(res.status).toBe(413);
  });

  it("rejects bytes that do not match the declared, allow-listed MIME type", async () => {
    const app = await uploadApp({ allowedMimeTypes: ["image/png"] });
    const res = await app.handle(
      multipartRequest("/upload", {
        files: [{ field: "f", name: "evil.png", type: "image/png", content: "<?php echo 1; ?>" }],
      }),
    );
    expect(res.status).toBe(415);
  });

  it("accepts a real PNG under the same allow-list", async () => {
    const app = await uploadApp({ allowedMimeTypes: ["image/png"] });
    const res = await app.handle(
      multipartRequest("/upload", {
        files: [{ field: "f", name: "real.png", type: "image/png", content: PNG_BYTES }],
      }),
    );
    expect(res.status).toBe(200);
  });

  it("does not let a form field pollute Object.prototype", async () => {
    const app = await uploadApp();
    const res = await app.handle(
      multipartRequest("/upload", {
        fields: { __proto__: "polluted", safe: "ok" },
        files: [{ field: "f", name: "a.txt", type: "text/plain", content: "a" }],
      }),
    );
    const body = await json<{ fields: string[]; polluted: string | null }>(res);
    expect(body.fields).toEqual(["safe"]);
    expect(body.polluted).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

// ─── M-4: CSRF binding ───

describe("CSRF token binding", () => {
  it("rejects a token the attacker planted in the cookie jar", async () => {
    const { csrf } = await import("../src/plugins/csrf.js");
    const app = createApp();
    await app.register(csrf(), { encapsulate: false });
    app.post("/submit", (_req, reply) => reply.json({ ok: true }));

    // Same value in cookie and header: passes a plain double-submit check.
    const res = await app.inject({
      method: "POST",
      url: "/submit",
      headers: {
        "content-type": "application/json",
        cookie: "_csrf=attacker-planted-value",
        "x-csrf-token": "attacker-planted-value",
      },
    });
    expect(res.status).toBe(403);
  });

  it("stops honoring a token minted for a different session", async () => {
    const { csrf } = await import("../src/plugins/csrf.js");
    let session = "anonymous";
    const app = createApp();
    await app.register(csrf({ secret: "test-secret", getSessionId: () => session }), { encapsulate: false });
    app.get("/page", (_req, reply) => reply.json({ ok: true }));
    app.post("/submit", (_req, reply) => reply.json({ ok: true }));

    const pre = await app.inject({ url: "/page" });
    const token = (pre.headers.get("set-cookie") ?? "").match(/_csrf=([^;]+)/)?.[1] ?? "";

    const before = await app.inject({
      method: "POST",
      url: "/submit",
      headers: { "content-type": "application/json", cookie: `_csrf=${token}`, "x-csrf-token": token },
    });
    expect(before.status).toBe(200);

    // Session id changes at login: the pre-login token must stop working.
    session = "user-42";
    const after = await app.inject({
      method: "POST",
      url: "/submit",
      headers: { "content-type": "application/json", cookie: `_csrf=${token}`, "x-csrf-token": token },
    });
    expect(after.status).toBe(403);
  });

  it("rejects a cross-site submission on Origin alone", async () => {
    const { csrf } = await import("../src/plugins/csrf.js");
    const app = createApp();
    await app.register(csrf({ secret: "test-secret" }), { encapsulate: false });
    app.get("/page", (_req, reply) => reply.json({ ok: true }));
    app.post("/submit", (_req, reply) => reply.json({ ok: true }));

    const pre = await app.inject({ url: "/page" });
    const token = (pre.headers.get("set-cookie") ?? "").match(/_csrf=([^;]+)/)?.[1] ?? "";

    const res = await app.inject({
      method: "POST",
      url: "/submit",
      headers: {
        "content-type": "application/json",
        cookie: `_csrf=${token}`,
        "x-csrf-token": token,
        origin: "https://evil.example",
      },
    });
    expect(res.status).toBe(403);
  });
});

// ─── M-15: Swagger UI supply chain ───

describe("Swagger UI page", () => {
  it("pins the CDN bundle by version and covers it with SRI", async () => {
    const app = createApp();
    await app.register(openapi(), { encapsulate: false });

    const html = await (await app.handle(new Request("http://localhost/docs"))).text();
    expect(html).toMatch(/swagger-ui-dist@\d+\.\d+\.\d+\/swagger-ui-bundle\.js/);
    expect(html).toContain('integrity="sha384-');
    expect(html).toContain('crossorigin="anonymous"');
    // The inline bootstrap runs off a nonce, so script-src never needs 'unsafe-inline'.
    expect(html).toMatch(/script-src 'nonce-[0-9a-f]+' cdn\.jsdelivr\.net;/);
    expect(html.slice(0, html.indexOf("style-src"))).not.toContain("'unsafe-inline'");
  });

  it("can serve the spec without the UI page", async () => {
    const app = createApp();
    await app.register(openapi({ ui: false }), { encapsulate: false });

    expect((await app.handle(new Request("http://localhost/docs"))).status).toBe(404);
    expect((await app.handle(new Request("http://localhost/docs/openapi.json"))).status).toBe(200);
  });
});

// ─── LOW batch ───

describe("etag hashing", () => {
  it("uses a 128-bit SHA-256 prefix, not a 32-bit hash", async () => {
    const res = await withETag(new Request("http://localhost/d"), { a: 1 });
    expect(res.headers.get("etag")).toMatch(/^W\/"[0-9a-f]{32}"$/);
  });

  it("gives different bodies different etags", async () => {
    const a = await withETag(new Request("http://localhost/d"), { a: 1 });
    const b = await withETag(new Request("http://localhost/d"), { a: 2 });
    expect(a.headers.get("etag")).not.toBe(b.headers.get("etag"));
  });
});

describe("error handler status trust", () => {
  it("does not let a non-HttpError statusCode leak its message in production", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const error = Object.assign(new Error("connection string postgres://user:pw@host"), { statusCode: 400 });
      const response = await handleError(error, {} as unknown as CelsianRequest, createReply(), null, [], null);
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("postgres://");
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});

describe("body limit errors", () => {
  it("names the limit and the config key", async () => {
    const request = new Request("http://localhost/", { method: "POST", body: "0123456789" });
    await expect(readBodyText(request, 4)).rejects.toThrow(/4 byte limit/);
    const second = new Request("http://localhost/", { method: "POST", body: "0123456789" });
    await expect(readBodyText(second, 4)).rejects.toThrow(/bodyLimit/);
  });
});
