// @celsian/rpc -- only intentional HttpErrors may choose the response status
//
// handleError() used to read `statusCode` off whatever was thrown. Database
// drivers and HTTP clients attach that field to their own errors, so an
// ordinary failure carrying `statusCode: 400` was (a) answered with a 400
// instead of a 500 and (b) exempt from production sanitization, which only
// covered 5xx. The raw message went to the client; the review's repro leaked a
// connection string. An out-of-range value (`statusCode: 99`) made
// `new Response()` throw a RangeError, so handle() rejected instead of
// answering.
//
// @celsian/core's error handler already had the right rule: only HttpError and
// ValidationError are intentional. These tests pin the same rule here.

import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError, ValidationError } from "../../core/src/errors.js";
import { json } from "../../core/test/helpers/json.js";
import { procedure } from "../src/procedure.js";
import { RPCHandler, type RPCLogger, router } from "../src/router.js";

type RpcError = { error: { message: string; code: string } };

const SECRET = "connect ECONNREFUSED postgres://admin:hunter2@10.0.0.5:5432/prod";

/** A handler whose single procedure throws `thrown`, plus what it logged. */
function throwing(thrown: unknown): { handler: RPCHandler; logged: Array<Record<string, unknown> | undefined> } {
  const logged: Array<Record<string, unknown> | undefined> = [];
  const logger: RPCLogger = {
    error(_msg, data) {
      logged.push(data);
    },
  };
  const routes = router({
    pay: procedure.query(async () => {
      throw thrown;
    }),
  });
  return { handler: new RPCHandler(routes, { logger }), logged };
}

// Stand-ins for @celsian/core 0.6.7's classes: same names, same chain, no
// brand. Declared through object keys so the classes are really NAMED
// CelsianError and HttpError at runtime; a `class HttpError` declaration in
// this file would be renamed by the transform, because it shadows the import.
const { CelsianError: LegacyCelsianError } = { CelsianError: class extends Error {} };
const { HttpError: LegacyHttpError } = {
  HttpError: class extends LegacyCelsianError {
    readonly statusCode = 401;
    readonly code = "UNAUTHORIZED";
  },
};

const call = (handler: RPCHandler) => handler.handle(new Request("http://localhost/_rpc/pay"));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("errors that merely carry a statusCode are not intentional", () => {
  it("answers 500 and hides the message in production (driver error with statusCode: 400)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { handler, logged } = throwing(Object.assign(new Error(SECRET), { statusCode: 400, code: "ECONNREFUSED" }));

    const res = await call(handler);
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("ECONNREFUSED");
    expect(JSON.parse(text)).toEqual({ error: { message: "Internal error", code: "INTERNAL_ERROR" } });
    // The operator still gets the full detail.
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged[0])).toContain("hunter2");
  });

  it("answers 500, not the carried status, outside production too", async () => {
    const { handler, logged } = throwing(Object.assign(new Error("upstream said no"), { statusCode: 404 }));

    const res = await call(handler);

    expect(res.status).toBe(500);
    // Development keeps the message, as it does for any unexpected error.
    expect((await json<RpcError>(res)).error.message).toBe("upstream said no");
    expect(logged).toHaveLength(1);
  });

  it.each([
    ["99", 99],
    ["0", 0],
    ["600", 600],
    ["NaN", Number.NaN],
    ["a string", "400"],
  ])("answers 500 instead of rejecting for an out-of-range statusCode (%s)", async (_label, statusCode) => {
    vi.stubEnv("NODE_ENV", "production");
    const { handler } = throwing(Object.assign(new Error("x"), { statusCode }));

    const res = await call(handler);

    expect(res.status).toBe(500);
  });

  it("answers 500 for a third-party error class that is merely NAMED HttpError", async () => {
    // e.g. an API client's own HttpError, carrying the upstream body in its message.
    const { HttpError: ThirdPartyHttpError } = {
      HttpError: class extends Error {
        statusCode = 401;
        code = "UPSTREAM";
      },
    };
    expect(ThirdPartyHttpError.name).toBe("HttpError");
    vi.stubEnv("NODE_ENV", "production");
    const { handler } = throwing(new ThirdPartyHttpError(SECRET));

    const res = await call(handler);
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(text).not.toContain("hunter2");
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "boom"],
    ["a plain object with statusCode", { statusCode: 403, message: SECRET }],
  ])("answers 500 instead of rejecting when %s is thrown", async (_label, thrown) => {
    vi.stubEnv("NODE_ENV", "production");
    const { handler } = throwing(thrown);

    const res = await call(handler);
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(text).not.toContain("hunter2");
  });
});

describe("intentional errors still choose the response", () => {
  it("passes an HttpError through in production: status, code and message", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { handler, logged } = throwing(new HttpError(409, "Email already registered", { code: "EMAIL_TAKEN" }));

    const res = await call(handler);

    expect(res.status).toBe(409);
    expect(await json<RpcError>(res)).toEqual({ error: { message: "Email already registered", code: "EMAIL_TAKEN" } });
    // An expected 4xx is not an operator event.
    expect(logged).toHaveLength(0);
  });

  it("passes a ValidationError through as a 400", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { handler } = throwing(new ValidationError([{ message: "Required", path: ["email"] }]));

    const res = await call(handler);

    expect(res.status).toBe(400);
    expect((await json<RpcError>(res)).error.code).toBe("VALIDATION_FAILED");
  });

  it("keeps the status of an intentional 5xx but sanitizes and logs it in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { handler, logged } = throwing(new HttpError(503, "replica lag on db-7"));

    const res = await call(handler);

    expect(res.status).toBe(503);
    expect(await json<RpcError>(res)).toEqual({ error: { message: "Internal error", code: "INTERNAL_ERROR" } });
    expect(logged).toHaveLength(1);
  });

  it("answers 500 for an HttpError constructed with an unusable status", async () => {
    const { handler } = throwing(new HttpError(99, "nonsense"));

    const res = await call(handler);

    expect(res.status).toBe(500);
  });

  it("recognises an HttpError from a second copy of @celsian/core by its brand", async () => {
    // A duplicate install or a separately bundled copy: `instanceof` against
    // one copy's class is false for the other's instances. The brand is a
    // registered symbol, so both copies share it.
    class OtherCopyHttpError extends Error {
      readonly statusCode = 403;
      readonly code = "FORBIDDEN";
    }
    Object.defineProperty(OtherCopyHttpError.prototype, Symbol.for("celsian.httpError"), { value: true });
    vi.stubEnv("NODE_ENV", "production");
    const { handler } = throwing(new OtherCopyHttpError("Admins only"));

    const res = await call(handler);

    expect(res.status).toBe(403);
    expect((await json<RpcError>(res)).error.message).toBe("Admins only");
  });

  it("recognises the unbranded HttpError of @celsian/core before 0.6.8 by its class chain", async () => {
    // Nothing ties @celsian/rpc's version to core's. An app that upgrades rpc
    // first must not see every 401 and 403 turn into a 500.
    const legacy = new LegacyHttpError("Sign in first");
    expect(LegacyHttpError.name).toBe("HttpError");
    expect(Object.getPrototypeOf(LegacyHttpError).name).toBe("CelsianError");
    expect((legacy as unknown as Record<symbol, unknown>)[Symbol.for("celsian.httpError")]).toBeUndefined();
    vi.stubEnv("NODE_ENV", "production");
    const { handler } = throwing(legacy);

    const res = await call(handler);

    expect(res.status).toBe(401);
    expect(await json<RpcError>(res)).toEqual({ error: { message: "Sign in first", code: "UNAUTHORIZED" } });
  });

  it("brands core's HttpError and ValidationError without adding an enumerable field", () => {
    const brand = Symbol.for("celsian.httpError");
    const http = new HttpError(404);
    const validation = new ValidationError([]);

    expect((http as unknown as Record<symbol, unknown>)[brand]).toBe(true);
    expect((validation as unknown as Record<symbol, unknown>)[brand]).toBe(true);
    expect(Object.getOwnPropertySymbols(http)).toEqual([]);
    expect(Object.keys(http)).not.toContain(String(brand));
    expect((new Error("plain") as unknown as Record<symbol, unknown>)[brand]).toBeUndefined();
  });
});
