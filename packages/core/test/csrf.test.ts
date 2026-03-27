// @celsian/core — CSRF middleware tests

import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { csrf } from "../src/plugins/csrf.js";

describe("CSRF middleware", () => {
  async function setupApp(options = {}) {
    const app = createApp();
    await app.register(csrf(options), { encapsulate: false });

    app.get("/page", (_req, reply) => reply.json({ ok: true }));
    app.post("/submit", (_req, reply) => reply.json({ submitted: true }));
    app.put("/update", (_req, reply) => reply.json({ updated: true }));
    app.delete("/remove", (_req, reply) => reply.json({ removed: true }));

    return app;
  }

  it("sets CSRF cookie on GET requests", async () => {
    const app = await setupApp();

    const res = await app.inject({ url: "/page" });
    expect(res.status).toBe(200);

    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain("_csrf=");
  });

  it("does not set cookie if already present", async () => {
    const app = await setupApp();

    const res = await app.inject({
      url: "/page",
      headers: { cookie: "_csrf=existing-token" },
    });
    expect(res.status).toBe(200);

    const setCookie = res.headers.get("set-cookie");
    // Should NOT re-set the cookie
    expect(setCookie).toBeNull();
  });

  it("rejects POST without CSRF token", async () => {
    const app = await setupApp();

    const res = await app.inject({
      method: "POST",
      url: "/submit",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("CSRF token mismatch");
  });

  it("rejects POST with mismatched CSRF token", async () => {
    const app = await setupApp();

    const res = await app.inject({
      method: "POST",
      url: "/submit",
      headers: {
        "content-type": "application/json",
        cookie: "_csrf=real-token-abc",
        "x-csrf-token": "different-token-xyz",
      },
    });
    expect(res.status).toBe(403);
  });

  it("accepts POST with matching CSRF token", async () => {
    const app = await setupApp();

    // First, get the CSRF token from a GET request
    const getRes = await app.inject({ url: "/page" });
    const setCookie = getRes.headers.get("set-cookie") ?? "";
    // Extract the token value from the cookie
    const tokenMatch = setCookie.match(/_csrf=([^;]+)/);
    expect(tokenMatch).toBeTruthy();
    const token = decodeURIComponent(tokenMatch![1]);

    // Now POST with matching token
    const postRes = await app.inject({
      method: "POST",
      url: "/submit",
      headers: {
        "content-type": "application/json",
        cookie: `_csrf=${encodeURIComponent(token)}`,
        "x-csrf-token": token,
      },
    });
    expect(postRes.status).toBe(200);
    const body = await postRes.json();
    expect(body.submitted).toBe(true);
  });

  it("rejects PUT without CSRF token", async () => {
    const app = await setupApp();

    const res = await app.inject({
      method: "PUT",
      url: "/update",
    });
    expect(res.status).toBe(403);
  });

  it("rejects DELETE without CSRF token", async () => {
    const app = await setupApp();

    const res = await app.inject({
      method: "DELETE",
      url: "/remove",
    });
    expect(res.status).toBe(403);
  });

  it("respects excludePaths option", async () => {
    const app = await setupApp({ excludePaths: ["/submit"] });

    const res = await app.inject({
      method: "POST",
      url: "/submit",
      headers: { "content-type": "application/json" },
    });
    // Should NOT be blocked since /submit is excluded
    expect(res.status).toBe(200);
  });

  it("respects custom cookieName and headerName", async () => {
    const app = await setupApp({
      cookieName: "my-csrf",
      headerName: "x-my-csrf",
    });

    // GET should set the custom cookie name
    const getRes = await app.inject({ url: "/page" });
    const setCookie = getRes.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("my-csrf=");

    const tokenMatch = setCookie.match(/my-csrf=([^;]+)/);
    const token = decodeURIComponent(tokenMatch![1]);

    // POST with custom header name should succeed
    const postRes = await app.inject({
      method: "POST",
      url: "/submit",
      headers: {
        "content-type": "application/json",
        cookie: `my-csrf=${encodeURIComponent(token)}`,
        "x-my-csrf": token,
      },
    });
    expect(postRes.status).toBe(200);
  });

  it("generates cryptographically random tokens", async () => {
    const app = await setupApp();

    const res1 = await app.inject({ url: "/page" });
    const res2 = await app.inject({ url: "/page" });

    const cookie1 = res1.headers.get("set-cookie") ?? "";
    const cookie2 = res2.headers.get("set-cookie") ?? "";

    const token1 = cookie1.match(/_csrf=([^;]+)/)?.[1];
    const token2 = cookie2.match(/_csrf=([^;]+)/)?.[1];

    // Tokens should be unique (not Math.random)
    expect(token1).toBeTruthy();
    expect(token2).toBeTruthy();
    expect(token1).not.toBe(token2);

    // Token should be 64 hex chars (32 bytes)
    expect(token1?.length).toBe(64);
  });
});
