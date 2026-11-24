// @celsian/adapter-lambda -- a response with a Content-Encoding must go out base64
//
// The adapter chose between a text body and a base64 body from Content-Type
// alone. With @celsian/compress the response is `application/json` plus
// `content-encoding: gzip`: a "text" type, so the gzip bytes were decoded as
// UTF-8 and returned with `isBase64Encoded: false`. API Gateway forwarded that
// string and the `content-encoding: gzip` header, and the client could not
// gunzip it.

import { brotliCompressSync, brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { createApp } from "@celsian/core";
import { describe, expect, it } from "vitest";
import { compress } from "../../compress/src/index.js";
import {
  type ALBEvent,
  type APIGatewayProxyEventV1,
  type APIGatewayProxyEventV2,
  createLambdaHandler,
} from "../src/index.js";

const payload = { items: Array.from({ length: 300 }, (_, i) => ({ id: i, name: `item ${i}` })) };

function v2Event(path: string, acceptEncoding?: string): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: `GET ${path}`,
    rawPath: path,
    rawQueryString: "",
    headers: { host: "api.example.com", ...(acceptEncoding ? { "accept-encoding": acceptEncoding } : {}) },
    isBase64Encoded: false,
    requestContext: {
      http: { method: "GET", path, protocol: "HTTP/1.1", sourceIp: "198.51.100.23", userAgent: "test" },
      requestId: "r1",
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
    },
  };
}

function v1Event(path: string, acceptEncoding: string): APIGatewayProxyEventV1 {
  return {
    httpMethod: "GET",
    path,
    headers: { host: "api.example.com", "accept-encoding": acceptEncoding },
    requestContext: { requestId: "r2", identity: { sourceIp: "198.51.100.24" } },
  };
}

function albEvent(path: string, acceptEncoding: string): ALBEvent {
  return {
    httpMethod: "GET",
    path,
    headers: { host: "api.example.com", "accept-encoding": acceptEncoding },
    requestContext: { elb: { targetGroupArn: "arn:aws:elasticloadbalancing:::targetgroup/x" } },
  };
}

async function compressedApp() {
  const app = createApp();
  await app.register(compress());
  app.get("/data", (_req, reply) => reply.json(payload));
  return app;
}

/** What a client does: undo the transport encoding, then the content encoding. */
function bodyBytes(result: { body?: string; isBase64Encoded?: boolean }): Buffer {
  return Buffer.from(result.body ?? "", result.isBase64Encoded ? "base64" : "utf8");
}

describe("@celsian/adapter-lambda with a Content-Encoding", () => {
  it("returns a gzip response from compress() as base64 that gunzips (HTTP API v2)", async () => {
    const handler = createLambdaHandler(await compressedApp());

    const result = await handler(v2Event("/data", "gzip"));

    expect(result.statusCode).toBe(200);
    expect(result.headers?.["content-encoding"]).toBe("gzip");
    expect(result.headers?.["content-type"]).toContain("application/json");
    expect(result.isBase64Encoded).toBe(true);
    expect(JSON.parse(gunzipSync(bodyBytes(result)).toString("utf8"))).toEqual(payload);
  });

  it("does the same for deflate", async () => {
    const handler = createLambdaHandler(await compressedApp());

    const result = await handler(v2Event("/data", "deflate"));

    expect(result.headers?.["content-encoding"]).toBe("deflate");
    expect(result.isBase64Encoded).toBe(true);
    expect(JSON.parse(inflateSync(bodyBytes(result)).toString("utf8"))).toEqual(payload);
  });

  it("does the same for REST API (v1) and ALB events", async () => {
    const handler = createLambdaHandler(await compressedApp());

    for (const event of [v1Event("/data", "gzip"), albEvent("/data", "gzip")]) {
      const result = await handler(event);
      expect(result.isBase64Encoded).toBe(true);
      expect(JSON.parse(gunzipSync(bodyBytes(result)).toString("utf8"))).toEqual(payload);
    }
  });

  it("base64-encodes a body the handler compressed itself, whatever its content-type", async () => {
    const app = createApp();
    const compressed = brotliCompressSync(Buffer.from("hello ".repeat(200)));
    app.get(
      "/pre",
      () => new Response(compressed, { headers: { "content-type": "text/plain", "content-encoding": "br" } }),
    );
    app.get("/untyped", () => new Response(compressed, { headers: { "content-encoding": "br" } }));
    const handler = createLambdaHandler(app);

    for (const path of ["/pre", "/untyped"]) {
      const result = await handler(v2Event(path));
      expect(result.headers?.["content-encoding"]).toBe("br");
      expect(result.isBase64Encoded).toBe(true);
      expect(brotliDecompressSync(bodyBytes(result)).toString("utf8")).toBe("hello ".repeat(200));
    }
  });

  it("still returns an unencoded text response as plain text", async () => {
    const handler = createLambdaHandler(await compressedApp());

    // No accept-encoding, so compress() leaves the response alone.
    const result = await handler(v2Event("/data"));

    expect(result.headers?.["content-encoding"]).toBeUndefined();
    expect(result.isBase64Encoded).toBe(false);
    expect(JSON.parse(result.body ?? "")).toEqual(payload);
  });
});
