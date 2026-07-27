// @celsian/core, request.url must carry the host the CLIENT addressed
//
// Root cause: adapters build `request.url` from the address the process bound
// to (`serve()` uses `http://${host}:${port}`). `CelsianApp.handle` computed a
// corrected `fullUrl` -- applying `x-forwarded-proto` and the `trustedHosts`-
// gated `x-forwarded-host` rewrite -- then passed it to `buildRequestFast` as a
// parameter named `_fullUrl` that was never read. Every host-sensitive control
// downstream (CSRF same-origin, response-cache keys, absolute redirects) saw
// the bind address.
//
// These tests boot a REAL server and send a `Host` that differs from the bind
// address. `app.inject()` cannot catch this: it never sends a `Host` header, so
// the authority always agrees with itself. `fetch` cannot either: `Host` is a
// forbidden header name and is dropped silently.

import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { CelsianAppOptions } from "../src/types.js";
import { startServer, type TestServer } from "./helpers/raw-http.js";

const servers: TestServer[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
});

async function boot(app: ReturnType<typeof createApp>): Promise<TestServer> {
  const server = await startServer(app);
  servers.push(server);
  return server;
}

/** An app that echoes back what it believes the request URL is. */
function echoApp(options?: CelsianAppOptions): ReturnType<typeof createApp> {
  const app = createApp(options);
  app.get("/u", (req, reply) => reply.json({ reqUrl: req.url }));
  return app;
}

describe("request.url reflects the client's host, not the bind address", () => {
  it("uses the Host header the client sent", async () => {
    const server = await boot(echoApp());

    const res = await server.send({ path: "/u", host: "shop.example.com" });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ reqUrl: "http://shop.example.com/u" });
  });

  it("keeps the query string when rewriting the authority", async () => {
    const server = await boot(echoApp());

    const res = await server.send({ path: "/u?a=1&b=2", host: "shop.example.com" });

    expect(JSON.parse(res.body)).toEqual({ reqUrl: "http://shop.example.com/u?a=1&b=2" });
  });

  it("honors x-forwarded-proto when trustProxy is enabled", async () => {
    const server = await boot(echoApp({ trustProxy: true }));

    const res = await server.send({
      path: "/u",
      host: "shop.example.com",
      headers: { "x-forwarded-proto": "https" },
    });

    expect(JSON.parse(res.body)).toEqual({ reqUrl: "https://shop.example.com/u" });
  });

  it("honors an allowlisted x-forwarded-host", async () => {
    const server = await boot(echoApp({ trustProxy: true, trustedHosts: ["public.example.com"] }));

    const res = await server.send({
      path: "/u",
      host: "internal.lb",
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "public.example.com" },
    });

    expect(JSON.parse(res.body)).toEqual({ reqUrl: "https://public.example.com/u" });
  });

  it("ignores an un-allowlisted x-forwarded-host (host-header injection guard)", async () => {
    const server = await boot(echoApp({ trustProxy: true, trustedHosts: ["public.example.com"] }));

    const res = await server.send({
      path: "/u",
      host: "shop.example.com",
      headers: { "x-forwarded-host": "evil.example.com" },
    });

    // The real Host wins; the attacker-supplied forwarded host is discarded.
    expect(JSON.parse(res.body)).toEqual({ reqUrl: "http://shop.example.com/u" });
  });

  it("ignores x-forwarded-host entirely when trustProxy is off", async () => {
    const server = await boot(echoApp());

    const res = await server.send({
      path: "/u",
      host: "shop.example.com",
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "evil.example.com" },
    });

    expect(JSON.parse(res.body)).toEqual({ reqUrl: "http://shop.example.com/u" });
  });

  it("ignores a syntactically invalid Host rather than splicing it into the URL", async () => {
    const server = await boot(echoApp());

    // `evil.com/x` would re-point the path if spliced in unchecked.
    const res = await server.send({ path: "/u", host: "evil.com/x" });

    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as { reqUrl: string };
    expect(parsed.reqUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/u$/);
  });

  it("still reports the client's host on a 404, where no route matched", async () => {
    const app = createApp();
    let seen = "";
    app.addHook("onRequest", (req) => {
      seen = req.url;
    });
    const server = await boot(app);

    await server.send({ path: "/nope", host: "shop.example.com" });

    expect(seen).toBe("http://shop.example.com/nope");
  });
});
