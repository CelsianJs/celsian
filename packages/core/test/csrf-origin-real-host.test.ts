// @celsian/core, CSRF's Origin check must compare against the client's host
//
// The check compares `Origin` to the request URL's authority. While `request.url`
// carried the *bind* address, that authority was `0.0.0.0:3000` on a production
// deployment, and the control inverted:
//
//   legit same-origin POST -> 403 {"error":"CSRF origin mismatch"}
//   POST with NO Origin    -> 200 OK
//
// Honest browsers, which always send `Origin` on a cross-site-capable request,
// were blocked. Origin-less clients (curl, scripts, anything not a browser)
// sailed through, which is exactly backwards.
//
// `checkWSOrigin` in websocket.ts already got this right by reading the `Host`
// header; these tests pin CSRF to the same behaviour. They need a real server
// with a differing `Host`, because `inject()` never sends one.

import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { csrf } from "../src/plugins/csrf.js";
import { startServer, type TestServer } from "./helpers/raw-http.js";

const servers: TestServer[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
});

const SITE = "shop.example.com";

/** A CSRF-protected app, bound to loopback but addressed as `shop.example.com`. */
async function bootProtected(options?: Parameters<typeof csrf>[0]): Promise<TestServer> {
  const app = createApp();
  await app.register(csrf(options));
  app.get("/form", (_req, reply) => reply.json({ ok: true }));
  app.post("/transfer", (_req, reply) => reply.json({ transferred: true }));
  const server = await startServer(app);
  servers.push(server);
  return server;
}

/** Fetch `/form` and return the `_csrf` cookie the plugin minted. */
async function mintToken(server: TestServer): Promise<string> {
  const res = await server.send({ path: "/form", host: SITE });
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const value = raw?.split(";")[0]?.split("=")[1];
  if (value === undefined) throw new Error(`no _csrf cookie issued: ${String(raw)}`);
  return value;
}

describe("CSRF origin check against the client's host", () => {
  it("accepts a same-origin POST from a browser", async () => {
    const server = await bootProtected();
    const token = await mintToken(server);

    const res = await server.send({
      method: "POST",
      path: "/transfer",
      host: SITE,
      headers: {
        origin: `https://${SITE}`,
        cookie: `_csrf=${token}`,
        "x-csrf-token": token,
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ transferred: true });
  });

  it("rejects a cross-origin POST even with a matching double-submit token", async () => {
    const server = await bootProtected();
    const token = await mintToken(server);

    const res = await server.send({
      method: "POST",
      path: "/transfer",
      host: SITE,
      headers: {
        origin: "https://evil.example.com",
        cookie: `_csrf=${token}`,
        "x-csrf-token": token,
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ error: "CSRF origin mismatch" });
  });

  it("does not treat an Origin-less request as more trusted than a browser's", async () => {
    const server = await bootProtected();

    // No Origin, no token: must still be rejected. This is the inversion's other
    // half -- the Origin-less client used to be the one that got through.
    const res = await server.send({
      method: "POST",
      path: "/transfer",
      host: SITE,
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ error: "CSRF token mismatch" });
  });

  it("accepts a same-origin POST behind a trusted proxy that rewrites the host", async () => {
    const app = createApp({ trustProxy: true, trustedHosts: [SITE] });
    await app.register(csrf());
    app.get("/form", (_req, reply) => reply.json({ ok: true }));
    app.post("/transfer", (_req, reply) => reply.json({ transferred: true }));
    const server = await startServer(app);
    servers.push(server);

    const proxyHeaders = { "x-forwarded-proto": "https", "x-forwarded-host": SITE };
    const formRes = await server.send({ path: "/form", host: "internal.lb", headers: proxyHeaders });
    const setCookie = formRes.headers["set-cookie"];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const token = raw?.split(";")[0]?.split("=")[1] ?? "";

    const res = await server.send({
      method: "POST",
      path: "/transfer",
      host: "internal.lb",
      headers: {
        ...proxyHeaders,
        origin: `https://${SITE}`,
        cookie: `_csrf=${token}`,
        "x-csrf-token": token,
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(res.status).toBe(200);
  });
});
