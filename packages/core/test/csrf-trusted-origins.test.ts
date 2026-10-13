// @celsian/core, CSRF `trustedOrigins` against real browser Fetch Metadata
//
// A browser labels every request with `Sec-Fetch-Site`. A POST from a separate
// dashboard origin (`https://app.example.com` calling `https://api.example.com`)
// always arrives as `same-site` or `cross-site`, so `trustedOrigins` is only
// meaningful if those labels are checked against it. The matrix below pins both
// directions: a trusted origin is admitted with a valid token, and every other
// combination (untrusted origin, missing Origin, opaque Origin, bad token,
// unknown label) is still refused.

import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { type CSRFOptions, csrf } from "../src/plugins/csrf.js";
import { json } from "./helpers/json.js";
import { startServer, type TestServer } from "./helpers/raw-http.js";

const TRUSTED = "https://app.example.com";

async function setupApp(options: CSRFOptions = { trustedOrigins: [TRUSTED] }) {
  const app = createApp();
  await app.register(csrf(options));
  app.get("/form", (_req, reply) => reply.json({ ok: true }));
  app.post("/transfer", (_req, reply) => reply.json({ transferred: true }));
  return app;
}

/** Mint a signed token through the plugin's own GET path. */
async function mintToken(app: Awaited<ReturnType<typeof setupApp>>): Promise<string> {
  const res = await app.inject({ url: "/form" });
  const token = res.headers.get("set-cookie")?.match(/_csrf=([^;]+)/)?.[1];
  if (token === undefined) throw new Error("no _csrf cookie issued");
  return token;
}

function post(
  app: Awaited<ReturnType<typeof setupApp>>,
  headers: Record<string, string>,
  token: string | null,
): Promise<Response> {
  const tokenHeaders: Record<string, string> =
    token === null ? {} : { cookie: `_csrf=${token}`, "x-csrf-token": token };
  return app.inject({
    method: "POST",
    url: "/transfer",
    headers: { "content-type": "application/json", ...tokenHeaders, ...headers },
    payload: "{}",
  });
}

describe("CSRF trustedOrigins with Sec-Fetch-Site", () => {
  it("admits a trusted origin labelled same-site when the token is valid", async () => {
    const app = await setupApp();
    const token = await mintToken(app);

    const res = await post(app, { origin: TRUSTED, "sec-fetch-site": "same-site" }, token);

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ transferred: true });
  });

  it("admits a trusted origin labelled cross-site when the token is valid", async () => {
    const app = await setupApp();
    const token = await mintToken(app);

    const res = await post(app, { origin: TRUSTED, "sec-fetch-site": "cross-site" }, token);

    expect(res.status).toBe(200);
  });

  it("admits a trusted host-only entry labelled cross-site", async () => {
    const app = await setupApp({ trustedOrigins: ["app.example.com"] });
    const token = await mintToken(app);

    const res = await post(app, { origin: TRUSTED, "sec-fetch-site": "cross-site" }, token);

    expect(res.status).toBe(200);
  });

  it("still requires a valid token from a trusted cross-site origin", async () => {
    const app = await setupApp();
    const token = await mintToken(app);

    const missing = await post(app, { origin: TRUSTED, "sec-fetch-site": "cross-site" }, null);
    expect(missing.status).toBe(403);
    expect(await json(missing)).toMatchObject({ error: "CSRF token mismatch" });

    const forged = await app.inject({
      method: "POST",
      url: "/transfer",
      headers: {
        origin: TRUSTED,
        "sec-fetch-site": "cross-site",
        cookie: "_csrf=forged.token",
        "x-csrf-token": "forged.token",
      },
    });
    expect(forged.status).toBe(403);
    expect(await json(forged)).toMatchObject({ error: "CSRF token mismatch" });

    // The token itself is fine: the same request with it goes through.
    expect((await post(app, { origin: TRUSTED, "sec-fetch-site": "cross-site" }, token)).status).toBe(200);
  });

  it("rejects an untrusted origin labelled cross-site, even with a valid token", async () => {
    const app = await setupApp();
    const token = await mintToken(app);

    const res = await post(app, { origin: "https://evil.example.net", "sec-fetch-site": "cross-site" }, token);

    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ error: "CSRF origin mismatch" });
  });

  it("rejects an untrusted sibling origin labelled same-site, even with a valid token", async () => {
    const app = await setupApp();
    const token = await mintToken(app);

    const res = await post(app, { origin: "https://evil.example.com", "sec-fetch-site": "same-site" }, token);

    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ error: "CSRF origin mismatch" });
  });

  it("rejects a cross-site request that carries no Origin", async () => {
    const app = await setupApp();
    const token = await mintToken(app);

    for (const site of ["cross-site", "same-site"]) {
      const res = await post(app, { "sec-fetch-site": site }, token);
      expect(res.status, site).toBe(403);
      expect(await json(res)).toMatchObject({ error: "CSRF origin mismatch" });
    }
  });

  it("rejects a cross-site request whose Origin is opaque", async () => {
    const app = await setupApp({ trustedOrigins: [TRUSTED, "null"] });
    const token = await mintToken(app);

    const res = await post(app, { origin: "null", "sec-fetch-site": "cross-site" }, token);

    expect(res.status).toBe(403);
  });

  it("rejects a cross-site request whose Origin matches this host but is not trusted", async () => {
    // inject() addresses the app as http://localhost, so this Origin names the
    // app's own host. The browser still says the initiator is another site
    // (a different scheme, say), and only an explicit trust entry may admit it.
    const app = await setupApp();
    const token = await mintToken(app);

    const res = await post(app, { origin: "https://localhost", "sec-fetch-site": "cross-site" }, token);

    expect(res.status).toBe(403);
  });

  it("rejects an unknown Sec-Fetch-Site value even from a trusted origin", async () => {
    const app = await setupApp();
    const token = await mintToken(app);

    const res = await post(app, { origin: TRUSTED, "sec-fetch-site": "bogus" }, token);

    expect(res.status).toBe(403);
  });

  it("keeps accepting same-origin requests and trusted origins without Fetch Metadata", async () => {
    const app = await setupApp();
    const token = await mintToken(app);

    expect((await post(app, { origin: "http://localhost", "sec-fetch-site": "same-origin" }, token)).status).toBe(200);
    expect((await post(app, { "sec-fetch-site": "none" }, token)).status).toBe(200);
    expect((await post(app, { origin: TRUSTED }, token)).status).toBe(200);
    expect((await post(app, { origin: "https://evil.example.net" }, token)).status).toBe(403);
  });

  it("skips the origin check entirely when checkOrigin is false", async () => {
    const app = await setupApp({ checkOrigin: false });
    const token = await mintToken(app);

    const res = await post(app, { origin: "https://evil.example.net", "sec-fetch-site": "cross-site" }, token);

    expect(res.status).toBe(200);
  });
});

describe("CSRF trustedOrigins over a real socket", () => {
  const servers: TestServer[] = [];
  const API = "api.example.com";

  afterEach(async () => {
    while (servers.length > 0) await servers.pop()?.close();
  });

  async function boot(): Promise<{ server: TestServer; token: string }> {
    const server = await startServer(await setupApp());
    servers.push(server);
    const form = await server.send({ path: "/form", host: API });
    const setCookie = form.headers["set-cookie"];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const token = raw?.split(";")[0]?.split("=")[1];
    if (token === undefined) throw new Error(`no _csrf cookie issued: ${String(raw)}`);
    return { server, token };
  }

  function send(server: TestServer, token: string, origin: string, site: string) {
    return server.send({
      method: "POST",
      path: "/transfer",
      host: API,
      headers: {
        origin,
        "sec-fetch-site": site,
        cookie: `_csrf=${token}`,
        "x-csrf-token": token,
        "content-type": "application/json",
      },
      body: "{}",
    });
  }

  it("admits the dashboard origin's same-site POST", async () => {
    const { server, token } = await boot();

    const res = await send(server, token, TRUSTED, "same-site");

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ transferred: true });
  });

  it("refuses an untrusted cross-site POST carrying the same valid token", async () => {
    const { server, token } = await boot();

    const res = await send(server, token, "https://evil.example.net", "cross-site");

    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ error: "CSRF origin mismatch" });
  });
});
