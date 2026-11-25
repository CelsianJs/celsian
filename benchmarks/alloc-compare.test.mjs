// The allocation gate's `--compare` like-for-like check, against the
// differences it exists to catch. These are the review's negative controls,
// which used to be run by hand by editing alloc-server.mjs: Hono answering
// with `application/json` where the others send `application/json;
// charset=utf-8` (same header names, same body length), and a body of the
// same length with one byte changed. A check that compared the status alone,
// or header names and body lengths, passed both.

import { describe, expect, it } from "vitest";
import { LIKE_FOR_LIKE, notLikeForLike } from "./alloc-compare.mjs";

/** A response as alloc-gate.mjs's describeResponse() records it. */
function wire(overrides = {}) {
  const body = Buffer.from(JSON.stringify({ message: "Hello, World!" }));
  return {
    status: 200,
    headerNames: "content-length, content-type",
    headers: `content-length: ${body.length}\ncontent-type: application/json; charset=utf-8`,
    body: body.toString("base64"),
    bodyBytes: body.length,
    ...overrides,
  };
}

describe("the --compare like-for-like check", () => {
  it("compares the status, every header with its value, and the body's bytes", () => {
    expect(LIKE_FOR_LIKE).toEqual(["status", "headers", "body"]);
  });

  it("accepts a response that matches on all three", () => {
    expect(notLikeForLike("json", "hono", wire(), wire())).toBeUndefined();
  });

  it("stops at a header value that differs, with the same names and the same body length", () => {
    const hono = wire({ headers: wire().headers.replace("application/json; charset=utf-8", "application/json") });
    expect(hono.headerNames).toBe(wire().headerNames);
    const message = notLikeForLike("json", "hono", hono, wire());
    expect(message).toMatch(/^json: not like for like\. hono answered with headers /);
    expect(message).toContain(`content-type: application/json", celsian with`);
  });

  it("stops at a body of the same length with different bytes", () => {
    const changed = Buffer.from(JSON.stringify({ message: "Hello, world!" }));
    const hono = wire({ body: changed.toString("base64"), bodyBytes: changed.length });
    expect(hono.bodyBytes).toBe(wire().bodyBytes);
    expect(notLikeForLike("json", "hono", hono, wire())).toMatch(/^json: not like for like\. hono answered with body /);
  });

  it("stops at a status that differs", () => {
    expect(notLikeForLike("notFound", "express", wire({ status: 404 }), wire())).toMatch(
      /^notFound: not like for like\. express answered with status 404, celsian with 200\./,
    );
  });
});
