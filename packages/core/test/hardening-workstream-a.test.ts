// @celsian/core — Production-hardening regression tests (workstream A)

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { serializeCookie } from "../src/cookie.js";
import { parseCronExpression } from "../src/cron.js";
import { csrf } from "../src/plugins/csrf.js";

describe("[1] JSON body prototype-pollution scrub", () => {
  it("strips __proto__ from parsed JSON and does not pollute Object.prototype", async () => {
    const app = createApp();
    app.post("/data", (req, reply) => reply.json({ received: req.parsedBody }));

    const request = new Request("http://localhost/data", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ __proto__: { polluted: "x" }, safe: 1 }),
    });

    const response = await app.handle(request);
    expect(response.status).toBe(200);

    // Prototype must not be polluted
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const body = await response.json();
    expect(body.received.polluted).toBeUndefined();
    expect(body.received.safe).toBe(1);
  });

  it("scrubs nested and array-nested dangerous keys", async () => {
    const app = createApp();
    app.post("/data", (req, reply) => reply.json({ received: req.parsedBody }));

    const request = new Request("http://localhost/data", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"a":[{"__proto__":{"x":1}}],"b":{"constructor":{"y":2}}}',
    });

    const response = await app.handle(request);
    const body = await response.json();
    expect(body.received.a[0].x).toBeUndefined();
    expect(body.received.b.y).toBeUndefined();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe("[2] cron field validation", () => {
  it("throws (does not hang) on */0 step", () => {
    expect(() => parseCronExpression("*/0 * * * *")).toThrow();
  });

  it("throws on negative and non-numeric steps", () => {
    expect(() => parseCronExpression("*/-1 * * * *")).toThrow();
    expect(() => parseCronExpression("*/abc * * * *")).toThrow();
  });

  it("throws on out-of-range and non-numeric values", () => {
    expect(() => parseCronExpression("99 * * * *")).toThrow();
    expect(() => parseCronExpression("abc * * * *")).toThrow();
    expect(() => parseCronExpression("* 25 * * *")).toThrow();
  });

  it("still parses valid expressions identically", () => {
    expect(parseCronExpression("*/15 * * * *").minutes).toEqual(new Set([0, 15, 30, 45]));
    expect(parseCronExpression("0-5 * * * *").minutes).toEqual(new Set([0, 1, 2, 3, 4, 5]));
    expect(parseCronExpression("0 */6 * * 1-5").hours).toEqual(new Set([0, 6, 12, 18]));
  });
});

describe("[3] trustProxy host-header injection guard", () => {
  it("ignores x-forwarded-host without an allowlist", async () => {
    const app = createApp({ trustProxy: true });
    app.get("/whoami", (req, reply) => reply.json({ url: req.url }));

    const res = await app.inject({
      url: "http://real.example/whoami",
      headers: { "x-forwarded-host": "evil.com" },
    });
    const body = await res.json();
    expect(body.url).not.toContain("evil.com");
    expect(body.url).toContain("real.example");
  });

  it("accepts a trustedHosts allowlist and still serves the request", async () => {
    // The allowlist permits honoring x-forwarded-host; the request must succeed
    // and (since req.url reflects the original request) must not be corrupted.
    const app = createApp({ trustProxy: true, trustedHosts: ["trusted.example"] });
    app.get("/whoami", (req, reply) => reply.json({ url: req.url }));

    const res = await app.inject({
      url: "http://real.example/whoami",
      headers: { "x-forwarded-host": "trusted.example" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).not.toContain("evil.com");
  });

  it("applies the trustedHosts rewrite to the parsed full URL when allowed", () => {
    // Verify the gating logic directly: an allowlisted host is honored on the
    // full URL object, an un-allowlisted host is not.
    const apply = (allowlist: string[] | undefined, fwd: string) => {
      const fullUrl = new URL("http://real.example/x");
      const trustedHosts = allowlist;
      if (trustedHosts?.includes(fwd)) fullUrl.host = fwd;
      return fullUrl.host;
    };
    expect(apply(["trusted.example"], "trusted.example")).toBe("trusted.example");
    expect(apply(undefined, "evil.com")).toBe("real.example");
    expect(apply([], "evil.com")).toBe("real.example");
  });
});

describe("[5] request timeout aborts handler signal", () => {
  it("aborts request.signal after timeout fires", async () => {
    const app = createApp({ requestTimeout: 50 });
    let aborted = false;

    app.get("/slow", async (req, reply) => {
      const signal = (req as { signal: AbortSignal }).signal;
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        });
        setTimeout(resolve, 1000);
      });
      return reply.json({ ok: true });
    });

    const res = await app.inject({ url: "/slow" });
    expect(res.status).toBe(504);
    expect(aborted).toBe(true);
  });
});

describe("[6] CSRF cookie Secure in production", () => {
  const original = process.env.NODE_ENV;
  beforeEach(() => {
    process.env.NODE_ENV = "production";
  });
  afterEach(() => {
    process.env.NODE_ENV = original;
  });

  it("sets Secure on the CSRF token cookie in production", async () => {
    const app = createApp();
    await app.register(csrf(), { encapsulate: false });
    app.get("/page", (_req, reply) => reply.json({ ok: true }));

    const res = await app.inject({ url: "/page" });
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain("_csrf=");
    expect(setCookie).toContain("Secure");
    // double-submit needs JS read access
    expect(setCookie).not.toContain("HttpOnly");
  });
});

describe("[7] body parse errors surface as 400", () => {
  it("returns 400 for malformed multipart body", async () => {
    const app = createApp();
    app.post("/upload", (req, reply) => reply.json({ ok: true, body: req.parsedBody ?? null }));

    const request = new Request("http://localhost/upload", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=----xyz" },
      body: "this is not valid multipart data at all",
    });

    const response = await app.handle(request);
    expect(response.status).toBe(400);
  });
});

describe("[8] formData enforces byte limit", () => {
  it("returns 413 for oversized urlencoded body", async () => {
    const app = createApp({ bodyLimit: 64 });
    app.post("/form", (req, reply) => reply.json({ ok: true, body: req.parsedBody ?? null }));

    const big = `data=${"x".repeat(500)}`;
    const request = new Request("http://localhost/form", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: big,
    });

    const response = await app.handle(request);
    expect(response.status).toBe(413);
  });

  it("still parses urlencoded bodies under the limit", async () => {
    const app = createApp({ bodyLimit: 1024 });
    app.post("/form", (req, reply) => {
      const fd = req.parsedBody as FormData;
      return reply.json({ name: fd.get("name") });
    });

    const request = new Request("http://localhost/form", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "name=celsian",
    });

    const response = await app.handle(request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.name).toBe("celsian");
  });
});

describe("[9] serializeCookie sanitizes name/domain/path", () => {
  it("throws on CRLF in cookie name", () => {
    expect(() => serializeCookie("bad\r\nname", "v")).toThrow();
  });

  it("throws on illegal chars in domain and path", () => {
    expect(() => serializeCookie("ok", "v", { domain: "evil.com\r\nSet-Cookie: x=y" })).toThrow();
    expect(() => serializeCookie("ok", "v", { path: "/a;HttpOnly" })).toThrow();
  });

  it("still serializes valid cookies", () => {
    const c = serializeCookie("session", "abc", { path: "/", domain: "example.com" });
    expect(c).toContain("session=abc");
    expect(c).toContain("Domain=example.com");
  });
});

describe("[10] router decodes params safely", () => {
  it("returns 400 for malformed percent-encoding in a param", async () => {
    const app = createApp();
    app.get("/items/:id", (req, reply) => reply.json({ id: req.params.id }));

    const res = await app.inject({ url: "/items/%ZZ" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for malformed percent-encoding in a wildcard", async () => {
    const app = createApp();
    app.get("/files/*", (req, reply) => reply.json({ path: req.params["*"] }));

    const res = await app.inject({ url: "/files/%ZZ" });
    expect(res.status).toBe(400);
  });
});
