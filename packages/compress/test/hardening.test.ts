// @celsian/compress, cookie preservation, Vary, content negotiation, filters, thresholds

import { createApp } from "@celsian/core";
import { describe, expect, it } from "vitest";
import { compress, isCompressibleContentType } from "../src/index.js";

/** A body comfortably over the 1 KB default threshold. */
const BIG = "x".repeat(4096);

async function gunzip(response: Response): Promise<string> {
  const stream = response.body?.pipeThrough(new DecompressionStream("gzip"));
  if (!stream) return "";
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

describe("Set-Cookie survives compression (H-6)", () => {
  it("keeps the session cookie on a compressed logout response", async () => {
    // The exploit: POST /logout calls reply.clearCookie('session') with a body
    // over the threshold. Building headers from `reply.headers` dropped every
    // Set-Cookie, so no gzip-capable client (i.e. every browser) was ever
    // logged out, the session stayed live.
    const app = createApp();
    await app.register(compress({ threshold: 100 }), { encapsulate: false });

    app.post("/logout", (_req, reply) => reply.clearCookie("session").json({ ok: true, padding: BIG }));

    const response = await app.inject({
      method: "POST",
      url: "/logout",
      headers: { "accept-encoding": "gzip" },
    });

    expect(response.headers.get("content-encoding")).toBe("gzip");
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toContain("session=");
    expect(cookies[0]).toMatch(/Max-Age=0/i);
  });

  it("preserves several Set-Cookie headers individually, not comma-joined", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 100 }), { encapsulate: false });

    app.get("/login", (_req, reply) => reply.cookie("session", "abc").cookie("csrf", "def").html(`<p>${BIG}</p>`));

    const response = await app.inject({ url: "/login", headers: { "accept-encoding": "gzip" } });
    expect(response.headers.get("content-encoding")).toBe("gzip");

    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies.some((c) => c.startsWith("session=abc"))).toBe(true);
    expect(cookies.some((c) => c.startsWith("csrf=def"))).toBe(true);
  });

  it("keeps cookies on the uncompressed path too (below-threshold parity)", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 1024 }), { encapsulate: false });

    app.post("/logout", (_req, reply) => reply.clearCookie("session").json({ ok: true }));

    const response = await app.inject({
      method: "POST",
      url: "/logout",
      headers: { "accept-encoding": "gzip" },
    });
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.getSetCookie()).toHaveLength(1);
  });

  it("preserves custom headers set by the handler on a compressed response", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 100 }), { encapsulate: false });

    app.get("/data", (_req, reply) =>
      reply.header("x-request-id", "req-1").header("cache-control", "no-store").json({ padding: BIG }),
    );

    const response = await app.inject({ url: "/data", headers: { "accept-encoding": "gzip" } });
    expect(response.headers.get("x-request-id")).toBe("req-1");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(await gunzip(response))).toEqual({ padding: BIG });
  });
});

describe("Vary: Accept-Encoding is unconditional", () => {
  it("sets Vary on an UNCOMPRESSED response (below threshold)", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 1024 }), { encapsulate: false });
    app.get("/small", (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({ url: "/small", headers: { "accept-encoding": "gzip" } });
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("vary")?.toLowerCase()).toContain("accept-encoding");
  });

  it("sets Vary when the client sent no Accept-Encoding at all", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 10 }), { encapsulate: false });
    app.get("/data", (_req, reply) => reply.json({ padding: BIG }));

    const response = await app.inject({ url: "/data" });
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("vary")?.toLowerCase()).toContain("accept-encoding");
  });

  it("merges with a Vary the handler already set instead of replacing it", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 1024 }), { encapsulate: false });
    app.get("/cors", (_req, reply) => reply.header("vary", "origin").json({ ok: true }));

    const vary = (await app.inject({ url: "/cors", headers: { "accept-encoding": "gzip" } })).headers
      .get("vary")
      ?.toLowerCase();
    expect(vary).toContain("origin");
    expect(vary).toContain("accept-encoding");
  });

  it("does not duplicate accept-encoding when it is already present", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 1024 }), { encapsulate: false });
    app.get("/x", (_req, reply) => reply.header("vary", "Accept-Encoding").json({ ok: true }));

    const vary = (await app.inject({ url: "/x", headers: { "accept-encoding": "gzip" } })).headers.get("vary") ?? "";
    expect(
      vary
        .toLowerCase()
        .split(",")
        .filter((f) => f.trim() === "accept-encoding"),
    ).toHaveLength(1);
  });
});

describe("Accept-Encoding negotiation honors q-values", () => {
  it("does NOT gzip when the client explicitly refused it with q=0", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 10, encodings: ["gzip"] }), { encapsulate: false });
    app.get("/data", (_req, reply) => reply.json({ padding: BIG }));

    const response = await app.inject({ url: "/data", headers: { "accept-encoding": "gzip;q=0, deflate" } });
    expect(response.headers.get("content-encoding")).toBeNull();
  });

  it("picks the highest-q encoding, not the server's first preference", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 10, encodings: ["gzip", "deflate"] }), { encapsulate: false });
    app.get("/data", (_req, reply) => reply.json({ padding: BIG }));

    const response = await app.inject({ url: "/data", headers: { "accept-encoding": "gzip;q=0.3, deflate;q=0.9" } });
    expect(response.headers.get("content-encoding")).toBe("deflate");
  });

  it("honors a wildcard", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 10, encodings: ["gzip"] }), { encapsulate: false });
    app.get("/data", (_req, reply) => reply.json({ padding: BIG }));

    expect(
      (await app.inject({ url: "/data", headers: { "accept-encoding": "*" } })).headers.get("content-encoding"),
    ).toBe("gzip");
    expect(
      (await app.inject({ url: "/data", headers: { "accept-encoding": "*;q=0" } })).headers.get("content-encoding"),
    ).toBeNull();
  });

  it("is not fooled by an encoding name appearing inside another token", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 10, encodings: ["gzip"] }), { encapsulate: false });
    app.get("/data", (_req, reply) => reply.json({ padding: BIG }));

    // "x-gzip" is a distinct coding; a substring match would wrongly select gzip.
    const response = await app.inject({ url: "/data", headers: { "accept-encoding": "x-gzip" } });
    expect(response.headers.get("content-encoding")).toBeNull();
  });
});

describe("content-type handling", () => {
  it("never overwrites an explicitly set content-type", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 10 }), { encapsulate: false });
    app.get("/img", (_req, reply) => reply.header("content-type", "image/png").send(BIG));

    const response = await app.inject({ url: "/img", headers: { "accept-encoding": "gzip" } });
    expect(response.headers.get("content-type")).toBe("image/png");
  });

  it("skips non-compressible content types by default", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 10 }), { encapsulate: false });
    app.get("/img", (_req, reply) => reply.header("content-type", "image/png").send(BIG));

    const response = await app.inject({ url: "/img", headers: { "accept-encoding": "gzip" } });
    expect(response.headers.get("content-encoding")).toBeNull();
  });

  it("compresses the textual types in the default allow-list", () => {
    for (const type of [
      "text/plain; charset=utf-8",
      "text/html; charset=utf-8",
      "text/css",
      "application/json; charset=utf-8",
      "application/xml",
      "application/javascript",
      "application/ld+json",
      "application/vnd.api+json",
      "application/atom+xml",
      "image/svg+xml",
    ]) {
      expect(isCompressibleContentType(type)).toBe(true);
    }
    for (const type of ["image/png", "video/mp4", "application/zip", "font/woff2", "application/octet-stream"]) {
      expect(isCompressibleContentType(type)).toBe(false);
    }
  });

  it("never double-encodes a body the handler already compressed", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 10 }), { encapsulate: false });
    app.get("/pre", (_req, reply) => reply.header("content-encoding", "br").send(BIG));

    const response = await app.inject({ url: "/pre", headers: { "accept-encoding": "gzip" } });
    expect(response.headers.get("content-encoding")).toBe("br");
  });
});

describe("custom filter (BREACH opt-out)", () => {
  it("lets a route opt out of compression", async () => {
    const app = createApp();
    await app.register(
      compress({ threshold: 10, filter: (request) => !new URL(request.url).pathname.startsWith("/secret") }),
      { encapsulate: false },
    );
    app.get("/secret/token", (_req, reply) => reply.json({ csrf: "s3cret", padding: BIG }));
    app.get("/public/data", (_req, reply) => reply.json({ padding: BIG }));

    expect(
      (await app.inject({ url: "/secret/token", headers: { "accept-encoding": "gzip" } })).headers.get(
        "content-encoding",
      ),
    ).toBeNull();
    expect(
      (await app.inject({ url: "/public/data", headers: { "accept-encoding": "gzip" } })).headers.get(
        "content-encoding",
      ),
    ).toBe("gzip");
  });

  it("receives the resolved content-type", async () => {
    const seen: string[] = [];
    const app = createApp();
    const filter = (_req: unknown, _reply: unknown, contentType: string): boolean => {
      seen.push(contentType);
      return true;
    };
    await app.register(compress({ threshold: 10, filter: filter as never }), { encapsulate: false });
    app.get("/html", (_req, reply) => reply.html(`<p>${BIG}</p>`));

    await app.inject({ url: "/html", headers: { "accept-encoding": "gzip" } });
    expect(seen).toEqual(["text/html; charset=utf-8"]);
  });
});

describe("threshold is measured in bytes", () => {
  it("does not compress a multi-byte body whose UTF-16 length exceeds the byte threshold", async () => {
    // 300 ASCII chars = 300 bytes. Under a 512-byte threshold either way.
    const app = createApp();
    await app.register(compress({ threshold: 512 }), { encapsulate: false });
    app.get("/ascii", (_req, reply) => reply.send("a".repeat(300)));

    expect(
      (await app.inject({ url: "/ascii", headers: { "accept-encoding": "gzip" } })).headers.get("content-encoding"),
    ).toBeNull();
  });

  it("DOES compress a body whose byte length crosses the threshold even though its .length does not", async () => {
    // 300 CJK chars = 300 UTF-16 units but 900 UTF-8 bytes. The old
    // `body.length < threshold` check left this uncompressed.
    const app = createApp();
    await app.register(compress({ threshold: 512 }), { encapsulate: false });
    app.get("/cjk", (_req, reply) => reply.send("漢".repeat(300)));

    const response = await app.inject({ url: "/cjk", headers: { "accept-encoding": "gzip" } });
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(await gunzip(response)).toBe("漢".repeat(300));
  });
});

describe("pass-through payloads", () => {
  it("leaves binary send() payloads alone", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 10 }), { encapsulate: false });
    app.get("/bin", (_req, reply) => reply.send(new Uint8Array(4096)));

    const response = await app.inject({ url: "/bin", headers: { "accept-encoding": "gzip" } });
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("vary")?.toLowerCase()).toContain("accept-encoding");
  });

  it("leaves a Response returned straight from a handler alone", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 10 }), { encapsulate: false });
    app.get("/raw", (_req, reply) => reply.send(new Response(BIG, { headers: { "content-type": "text/plain" } })));

    const response = await app.inject({ url: "/raw", headers: { "accept-encoding": "gzip" } });
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.text()).toBe(BIG);
  });
});
