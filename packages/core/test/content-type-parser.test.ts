import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("addContentTypeParser", () => {
  it("should use custom parser for exact content-type match", async () => {
    const app = createApp();

    app.addContentTypeParser("application/xml", async (request) => {
      const text = await request.text();
      return { xml: text };
    });

    app.post("/data", (req, reply) => reply.json({ body: req.parsedBody }));

    const response = await app.handle(
      new Request("http://localhost/data", {
        method: "POST",
        headers: { "content-type": "application/xml" },
        body: "<root><item>hello</item></root>",
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.body).toEqual({ xml: "<root><item>hello</item></root>" });
  });

  it("should use custom parser for prefix match (with charset)", async () => {
    const app = createApp();

    app.addContentTypeParser("application/xml", async (request) => {
      const text = await request.text();
      return { xml: text };
    });

    app.post("/data", (req, reply) => reply.json({ body: req.parsedBody }));

    const response = await app.handle(
      new Request("http://localhost/data", {
        method: "POST",
        headers: { "content-type": "application/xml; charset=utf-8" },
        body: "<data/>",
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.body).toEqual({ xml: "<data/>" });
  });

  it("should not override built-in parsers when no custom parser matches", async () => {
    const app = createApp();

    app.addContentTypeParser("application/xml", async (request) => {
      const text = await request.text();
      return { xml: text };
    });

    app.post("/data", (req, reply) => reply.json({ body: req.parsedBody }));

    const response = await app.handle(
      new Request("http://localhost/data", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "value" }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.body).toEqual({ key: "value" });
  });

  it("should support multiple custom parsers", async () => {
    const app = createApp();

    app.addContentTypeParser("application/xml", async (request) => {
      return { type: "xml", text: await request.text() };
    });

    app.addContentTypeParser("application/yaml", async (request) => {
      return { type: "yaml", text: await request.text() };
    });

    app.post("/data", (req, reply) => reply.json({ body: req.parsedBody }));

    const xmlResponse = await app.handle(
      new Request("http://localhost/data", {
        method: "POST",
        headers: { "content-type": "application/yaml" },
        body: "key: value",
      }),
    );

    const body = await xmlResponse.json();
    expect(body.body).toEqual({ type: "yaml", text: "key: value" });
  });

  it("should override built-in JSON parser when registered", async () => {
    const app = createApp();

    app.addContentTypeParser("application/json", async (request) => {
      const text = await request.text();
      return { customParsed: true, data: JSON.parse(text) };
    });

    app.post("/data", (req, reply) => reply.json({ body: req.parsedBody }));

    const response = await app.handle(
      new Request("http://localhost/data", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "value" }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.body).toEqual({ customParsed: true, data: { key: "value" } });
  });

  it("should handle binary content types with arrayBuffer", async () => {
    const app = createApp();

    app.addContentTypeParser("application/x-protobuf", async (request) => {
      const buffer = await request.arrayBuffer();
      return { format: "protobuf", byteLength: buffer.byteLength };
    });

    app.post("/binary", (req, reply) => reply.json({ body: req.parsedBody }));

    const binaryData = new Uint8Array([0x08, 0x96, 0x01]);
    const response = await app.handle(
      new Request("http://localhost/binary", {
        method: "POST",
        headers: { "content-type": "application/x-protobuf" },
        body: binaryData,
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.body).toEqual({ format: "protobuf", byteLength: 3 });
  });

  it("should handle msgpack content type", async () => {
    const app = createApp();

    app.addContentTypeParser("application/msgpack", async (request) => {
      const buffer = await request.arrayBuffer();
      return { format: "msgpack", size: buffer.byteLength };
    });

    app.post("/msgpack", (req, reply) => reply.json({ body: req.parsedBody }));

    const response = await app.handle(
      new Request("http://localhost/msgpack", {
        method: "POST",
        headers: { "content-type": "application/msgpack" },
        body: new Uint8Array([0x82, 0xa1, 0x61, 0x01]),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.body.format).toBe("msgpack");
  });
});

describe("removeContentTypeParser", () => {
  it("should remove a registered parser", async () => {
    const app = createApp();

    app.addContentTypeParser("application/xml", async (request) => {
      return { xml: await request.text() };
    });

    expect(app.hasContentTypeParser("application/xml")).toBe(true);
    expect(app.removeContentTypeParser("application/xml")).toBe(true);
    expect(app.hasContentTypeParser("application/xml")).toBe(false);
  });

  it("should return false when removing non-existent parser", () => {
    const app = createApp();
    expect(app.removeContentTypeParser("application/xml")).toBe(false);
  });
});

describe("hasContentTypeParser", () => {
  it("should return true for registered parser", () => {
    const app = createApp();
    app.addContentTypeParser("application/xml", async (request) => {
      return await request.text();
    });
    expect(app.hasContentTypeParser("application/xml")).toBe(true);
  });

  it("should return false for unregistered parser", () => {
    const app = createApp();
    expect(app.hasContentTypeParser("application/xml")).toBe(false);
  });
});
