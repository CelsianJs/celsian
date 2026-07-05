// @celsian/core -- live-route e2e coverage against the real npm packages for
// every supported schema library (zod, TypeBox, valibot), not hand-rolled
// "-like" fakes.
//
// PR #48 fixed `fromValibot()` being silently broken for all modern valibot
// (>=0.31) because the suite only ever validated schema.body against
// hand-rolled fakes. This file closes that gap at the framework boundary:
// a real CelsianApp route is registered with a real schema object, a request
// is actually routed through app.inject() (onRequest -> validateRequest ->
// handler, same pipeline a deployed app uses), and both the 200 success path
// (parsed data reaches the handler) and the 400 failure path (per-field
// validation detail reaches the client) are asserted.

import { Type } from "@sinclair/typebox";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../src/app.js";

interface Person {
  name: string;
  age: number;
}

const cases: Array<{ label: string; schema: unknown }> = [
  { label: "zod", schema: z.object({ name: z.string(), age: z.number().int().min(0) }) },
  { label: "TypeBox", schema: Type.Object({ name: Type.String(), age: Type.Integer({ minimum: 0 }) }) },
  {
    label: "valibot",
    schema: v.object({ name: v.string(), age: v.pipe(v.number(), v.integer(), v.minValue(0)) }),
  },
];

describe.each(cases)("live route validation with real $label schemas", ({ schema }) => {
  it("returns 200 with the parsed body for a valid request", async () => {
    const app = createApp();
    app.post("/people", { schema: { body: schema } }, (req, reply) => {
      return reply.json({ received: req.parsedBody });
    });

    const response = await app.inject({
      method: "POST",
      url: "/people",
      payload: { name: "Alice", age: 30 },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { received: Person };
    expect(body.received).toEqual({ name: "Alice", age: 30 });
  });

  it("returns 400 with per-field issue detail for an invalid request", async () => {
    const app = createApp();
    app.post("/people", { schema: { body: schema } }, (req, reply) => {
      return reply.json({ received: req.parsedBody });
    });

    const response = await app.inject({
      method: "POST",
      url: "/people",
      // name should be a string, age should be a non-negative number — both wrong.
      payload: { name: 5, age: -1 },
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      code: string;
      issues: Array<{ message: string; path?: (string | number)[] }>;
    };
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);

    const fields = body.issues.map((issue) => issue.path?.join("."));
    expect(fields.some((f) => f === "name" || f === "age")).toBe(true);
  });
});
