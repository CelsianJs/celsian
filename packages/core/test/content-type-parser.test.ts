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
});
