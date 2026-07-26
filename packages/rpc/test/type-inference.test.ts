// @celsian/rpc, compile-time inference assertions for procedures and clients
//
// These are `expectTypeOf` assertions, which are COMPILE-time checks. They only
// run because this file is listed in `test.typecheck.include` (vitest.config.ts)
// and in `tsconfig.typecheck.vitest.json`. If you add a file of type assertions,
// add it to both or the assertions silently erase to no-ops.
//
// What they guard: the RPC package's headline promise, "end-to-end type safety".
// Two independent defects broke it at the library level.
//
//   1. `ProcedureBuilder.input<T>(schema: unknown)` mentioned `T` nowhere in its
//      parameter list, so there was no inference site and `T` always collapsed
//      to `unknown`. `({ input }) => input.name` did not typecheck.
//   2. `RPCClientProxy` matched handlers against `ctx: unknown` while
//      `ProcedureDefinition` declares `ctx: RPCContext`. Under
//      `strictFunctionTypes` the contravariant parameter check failed, so every
//      procedure fell to the `never` branch and a typed client had no callable
//      members.

import { Type } from "@sinclair/typebox";
import * as v from "valibot";
import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { createRPCClient } from "../src/client.js";
import { procedure } from "../src/procedure.js";
import { router } from "../src/router.js";

describe("procedure.input() inference", () => {
  it("types the handler's `input` from a Zod schema", () => {
    procedure.input(z.object({ name: z.string(), age: z.number() })).query(({ input }) => {
      expectTypeOf(input).toEqualTypeOf<{ name: string; age: number }>();
      return input.name;
    });
  });

  it("types the handler's `input` from a TypeBox schema", () => {
    procedure.input(Type.Object({ id: Type.String() })).query(({ input }) => {
      expectTypeOf(input).toEqualTypeOf<{ id: string }>();
      return input.id;
    });
  });

  it("types the handler's `input` from a Valibot schema", () => {
    procedure.input(v.object({ slug: v.string() })).query(({ input }) => {
      expectTypeOf(input).toEqualTypeOf<{ slug: string }>();
      return input.slug;
    });
  });

  it("keeps `input` typed across .use() and .output() chain hops", () => {
    procedure
      .input(z.object({ q: z.string() }))
      .output(z.object({ hits: z.number() }))
      .use(async ({ next }) => next())
      .query(({ input }) => {
        expectTypeOf(input).toEqualTypeOf<{ q: string }>();
        return { hits: input.q.length };
      });
  });

  it("leaves `input` as unknown when no schema is declared", () => {
    procedure.query(({ input }) => {
      expectTypeOf(input).toEqualTypeOf<unknown>();
      return null;
    });
  });
});

describe("createRPCClient() resolves to the procedure map, not never", () => {
  const appRouter = router({
    greet: procedure.input(z.object({ name: z.string() })).query(({ input }) => `Hello, ${input.name}!`),
    users: {
      create: procedure.input(z.object({ email: z.string() })).mutation(({ input }) => ({ id: "1", ...input })),
    },
  });

  type AppRouter = typeof appRouter;

  it("gives a query procedure a typed .query() with typed input and output", () => {
    const client = createRPCClient<AppRouter>();
    expectTypeOf(client.greet).not.toBeNever();
    expectTypeOf(client.greet.query).parameter(0).toEqualTypeOf<{ name: string }>();
    expectTypeOf(client.greet.query).returns.resolves.toEqualTypeOf<string>();
  });

  it("gives a mutation procedure a typed .mutate() and reaches nested routers", () => {
    const client = createRPCClient<AppRouter>();
    expectTypeOf(client.users.create).not.toBeNever();
    expectTypeOf(client.users.create.mutate).parameter(0).toEqualTypeOf<{ email: string }>();
    expectTypeOf(client.users.create.mutate).returns.resolves.toEqualTypeOf<{ id: string; email: string }>();
  });

  it("keeps createRPCClient<any>() usable as the documented escape hatch", () => {
    // biome-ignore lint/suspicious/noExplicitAny: the untyped-client escape hatch is the thing under test
    const client = createRPCClient<any>();
    expectTypeOf(client.anything.nested.query).toBeCallableWith({ x: 1 });
  });
});
