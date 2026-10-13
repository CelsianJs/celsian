// @celsian/core, request.ip: the client address a handler can key on
//
// By default `request.ip` is the peer that opened the connection, as the runtime
// reports it, and client-supplied headers are ignored: an X-Forwarded-For sent
// straight to the app is text the caller chose. Behind a proxy, `clientIp` names
// the one header that proxy sets, and `hops` picks an entry of a list header
// counting from the right, the end the proxies append to.

import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { CelsianError } from "../src/errors.js";
import { setRemoteAddress } from "../src/request.js";
import type { CelsianAppOptions } from "../src/types.js";
import { authorizeWSUpgrade } from "../src/websocket.js";
import { json } from "./helpers/json.js";
import { startServer, type TestServer } from "./helpers/raw-http.js";

function ipApp(options: CelsianAppOptions = {}) {
  const app = createApp(options);
  app.get("/ip", (req) => ({ ip: req.ip ?? null }));
  return app;
}

async function ipOf(res: Response): Promise<string | null> {
  return (await json<{ ip: string | null }>(res)).ip;
}

describe("request.ip over a real socket", () => {
  const servers: TestServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) await servers.pop()?.close();
  });

  async function boot(options: CelsianAppOptions = {}) {
    const server = await startServer(ipApp(options));
    servers.push(server);
    return server;
  }

  it("is the peer address of the connection", async () => {
    const server = await boot();

    const res = await server.send({ path: "/ip" });

    expect(JSON.parse(res.body)).toEqual({ ip: "127.0.0.1" });
  });

  it("ignores client-supplied forwarding headers by default", async () => {
    const server = await boot();

    const res = await server.send({
      path: "/ip",
      headers: {
        "x-forwarded-for": "6.6.6.6",
        "x-real-ip": "6.6.6.6",
        "fly-client-ip": "6.6.6.6",
        "cf-connecting-ip": "6.6.6.6",
      },
    });

    expect(JSON.parse(res.body)).toEqual({ ip: "127.0.0.1" });
  });

  it("is not changed by trustProxy, which only covers the forwarded host and scheme", async () => {
    const server = await boot({ trustProxy: true });

    const res = await server.send({ path: "/ip", headers: { "x-forwarded-for": "6.6.6.6" } });

    expect(JSON.parse(res.body)).toEqual({ ip: "127.0.0.1" });
  });

  it("reads the configured proxy header, and falls back to the peer without it", async () => {
    const server = await boot({ clientIp: { header: "Fly-Client-IP" } });

    const viaProxy = await server.send({ path: "/ip", headers: { "fly-client-ip": "203.0.113.7" } });
    const direct = await server.send({ path: "/ip" });

    expect(JSON.parse(viaProxy.body)).toEqual({ ip: "203.0.113.7" });
    expect(JSON.parse(direct.body)).toEqual({ ip: "127.0.0.1" });
  });

  it("is visible to hooks on a 404", async () => {
    const app = createApp();
    const seen: Array<string | undefined> = [];
    app.addHook("onRequest", (req) => {
      seen.push(req.ip);
    });
    const server = await startServer(app);
    servers.push(server);

    const res = await server.send({ path: "/missing" });

    expect(res.status).toBe(404);
    expect(seen).toEqual(["127.0.0.1"]);
  });
});

describe("clientIp option", () => {
  const xff = (value: string, hops?: number) =>
    ipApp({ clientIp: { header: "x-forwarded-for", hops } }).inject({
      url: "/ip",
      headers: { "x-forwarded-for": value },
      remoteAddress: "10.0.0.2",
    });

  it("takes the right-most entry of a list header by default", async () => {
    expect(await ipOf(await xff("1.1.1.1, 2.2.2.2, 3.3.3.3"))).toBe("3.3.3.3");
  });

  it("counts hops from the right", async () => {
    expect(await ipOf(await xff("1.1.1.1, 2.2.2.2, 3.3.3.3", 2))).toBe("2.2.2.2");
    expect(await ipOf(await xff("1.1.1.1, 2.2.2.2, 3.3.3.3", 3))).toBe("1.1.1.1");
  });

  it("falls back to the peer when the chain is shorter than the hop count", async () => {
    // A request that did not pass through every declared proxy: the left-most
    // entry would be whatever the caller wrote, so it is not used.
    expect(await ipOf(await xff("6.6.6.6", 2))).toBe("10.0.0.2");
  });

  it("falls back to the peer when the header entry is not an address", async () => {
    expect(await ipOf(await xff("not-an-ip"))).toBe("10.0.0.2");
    expect(await ipOf(await xff("1.1.1.1, <script>"))).toBe("10.0.0.2");
    expect(await ipOf(await xff(`1.1.1.1, ${"1".repeat(200)}`))).toBe("10.0.0.2");
  });

  it("accepts IPv6 entries", async () => {
    expect(await ipOf(await xff("2001:db8::1"))).toBe("2001:db8::1");
  });

  it("rejects a configuration that could never identify anyone", () => {
    expect(() => createApp({ clientIp: { header: "" } })).toThrow(CelsianError);
    expect(() => createApp({ clientIp: { header: "x-forwarded-for", hops: 0 } })).toThrow(CelsianError);
    expect(() => createApp({ clientIp: { header: "x-forwarded-for", hops: 1.5 } })).toThrow(CelsianError);
  });
});

describe("request.ip without a socket", () => {
  it("is undefined when the runtime reported no peer", async () => {
    expect(await ipOf(await ipApp().inject({ url: "/ip" }))).toBeNull();
  });

  it("takes inject's remoteAddress", async () => {
    expect(await ipOf(await ipApp().inject({ url: "/ip", remoteAddress: "198.51.100.4" }))).toBe("198.51.100.4");
  });

  it("takes the peer an adapter recorded on the Request", async () => {
    const res = await ipApp().handle(setRemoteAddress(new Request("http://localhost/ip"), "198.51.100.5"));
    expect(await ipOf(res)).toBe("198.51.100.5");
  });

  it("reads Bun's server.requestIP() through app.fetch", async () => {
    const bunServer = { requestIP: () => ({ address: "198.51.100.6", port: 5000 }) };
    const res = await ipApp().fetch(new Request("http://localhost/ip"), bunServer);
    expect(await ipOf(res)).toBe("198.51.100.6");
  });

  it("reads Deno's info.remoteAddr through app.fetch", async () => {
    const denoInfo = { remoteAddr: { transport: "tcp", hostname: "198.51.100.7", port: 5000 } };
    const res = await ipApp().fetch(new Request("http://localhost/ip"), denoInfo);
    expect(await ipOf(res)).toBe("198.51.100.7");
  });

  it("ignores a second fetch argument that is neither, such as Workers bindings", async () => {
    const env = { KV: {}, SECRET: "x" };
    const res = await ipApp().fetch(new Request("http://localhost/ip", { headers: { "x-real-ip": "6.6.6.6" } }), env);
    expect(await ipOf(res)).toBeNull();
  });

  it("is set on the request WebSocket upgrade hooks see", async () => {
    const app = createApp();
    const seen: Array<string | undefined> = [];
    app.addHook("onRequest", (req) => {
      seen.push(req.ip);
    });
    app.ws("/chat", {});

    const request = setRemoteAddress(
      new Request("http://localhost/chat", { headers: { upgrade: "websocket" } }),
      "198.51.100.8",
    );
    const decision = await authorizeWSUpgrade(app, request, "/chat", { allowMissingOrigin: true });

    expect(decision.allowed).toBe(true);
    expect(seen).toEqual(["198.51.100.8"]);
  });
});
