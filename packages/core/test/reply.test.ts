import { describe, expect, it } from "vitest";
import { createReply } from "../src/reply.js";

describe("createReply", () => {
  it("should default to status 200", () => {
    const reply = createReply();
    expect(reply.statusCode).toBe(200);
  });

  it("should chain status", () => {
    const reply = createReply();
    const result = reply.status(404);
    expect(result).toBe(reply);
    expect(reply.statusCode).toBe(404);
  });

  it("should chain header", () => {
    const reply = createReply();
    const result = reply.header("X-Custom", "value");
    expect(result).toBe(reply);
    expect(reply.headers["x-custom"]).toBe("value");
  });

  it("should send JSON", async () => {
    const reply = createReply();
    const response = reply.json({ hello: "world" });
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");

    const body = await response.json();
    expect(body).toEqual({ hello: "world" });
    expect(reply.sent).toBe(true);
  });

  it("should send HTML", async () => {
    const reply = createReply();
    const response = reply.html("<h1>Hello</h1>");
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");

    const body = await response.text();
    expect(body).toBe("<h1>Hello</h1>");
  });

  it("should send text", async () => {
    const reply = createReply();
    const response = reply.send("hello");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");

    const body = await response.text();
    expect(body).toBe("hello");
  });

  it("should send objects as JSON", async () => {
    const reply = createReply();
    const response = reply.send({ data: 123 });
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");

    const body = await response.json();
    expect(body).toEqual({ data: 123 });
  });

  it("should pass through Response objects", () => {
    const reply = createReply();
    const original = new Response("custom");
    const response = reply.send(original);
    expect(response).toBe(original);
  });

  it("should redirect", () => {
    const reply = createReply();
    const response = reply.redirect("/login");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login");
  });

  it("should redirect with custom code", () => {
    const reply = createReply();
    const response = reply.redirect("/new-url", 301);
    expect(response.status).toBe(301);
  });

  it("should include custom headers in all responses", async () => {
    const reply = createReply();
    reply.header("x-request-id", "123");
    const response = reply.json({ ok: true });
    expect(response.headers.get("x-request-id")).toBe("123");
  });

  it("should respect status set before send", async () => {
    const reply = createReply();
    reply.statusCode = 201;
    const response = reply.json({ created: true });
    expect(response.status).toBe(201);
  });
});

describe("binary send (CORE-09)", () => {
  it("sends Uint8Array as raw bytes with application/octet-stream", async () => {
    const reply = createReply();
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const response = reply.send(bytes);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    const body = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(body)).toEqual([137, 80, 78, 71]);
  });

  it("sends Node Buffer (a Uint8Array subclass) as raw bytes", async () => {
    const reply = createReply();
    const buf = Buffer.from([1, 2, 3]);
    const response = reply.send(buf);

    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    const body = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(body)).toEqual([1, 2, 3]);
  });

  it("sends ArrayBuffer as raw bytes", async () => {
    const reply = createReply();
    const ab = new Uint8Array([9, 8, 7]).buffer;
    const response = reply.send(ab);

    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    const body = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(body)).toEqual([9, 8, 7]);
  });

  it("respects an explicitly set content-type for binary sends", async () => {
    const reply = createReply();
    const response = reply.header("content-type", "image/png").send(new Uint8Array([137, 80]));

    expect(response.headers.get("content-type")).toBe("image/png");
    const body = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(body)).toEqual([137, 80]);
  });

  it("still JSON-stringifies plain objects", async () => {
    const reply = createReply();
    const response = reply.send({ a: 1 });
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await response.json()).toEqual({ a: 1 });
  });
});
