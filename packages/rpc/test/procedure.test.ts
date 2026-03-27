import { describe, expect, it } from "vitest";
import { createProcedure, procedure } from "../src/procedure.js";

describe("ProcedureBuilder", () => {
  it("should build a query procedure", () => {
    const proc = procedure.query(async ({ input }) => {
      return { echo: input };
    });

    expect(proc.type).toBe("query");
    expect(proc.handler).toBeTypeOf("function");
    expect(proc.middlewares).toEqual([]);
  });

  it("should build a mutation procedure", () => {
    const proc = procedure.mutation(async ({ input }) => {
      return { created: input };
    });

    expect(proc.type).toBe("mutation");
  });

  it("should add input schema via auto-detect", () => {
    const zodLike = {
      safeParse(input: unknown) {
        return { success: true, data: input };
      },
      parse(input: unknown) {
        return input;
      },
    };

    const proc = procedure.input(zodLike).query(async ({ input }) => input);
    expect(proc.inputSchema).toBeDefined();
    expect(proc.inputSchema?.validate("test").success).toBe(true);
  });

  it("should add output schema", () => {
    const zodLike = {
      safeParse(input: unknown) {
        return { success: true, data: input };
      },
      parse(input: unknown) {
        return input;
      },
    };

    const proc = procedure.output(zodLike).query(async () => "test");
    expect(proc.outputSchema).toBeDefined();
  });

  it("should add middleware", () => {
    const mw = async ({ next }: { ctx: any; next: () => Promise<unknown> }) => next();

    const proc = procedure.use(mw).query(async () => "test");
    expect(proc.middlewares).toHaveLength(1);
  });

  it("should chain multiple middlewares", () => {
    const mw1 = async ({ next }: { ctx: any; next: () => Promise<unknown> }) => next();
    const mw2 = async ({ next }: { ctx: any; next: () => Promise<unknown> }) => next();

    const proc = procedure
      .use(mw1)
      .use(mw2)
      .query(async () => "test");
    expect(proc.middlewares).toHaveLength(2);
  });

  it("should execute handler", async () => {
    const proc = procedure.query(async ({ input }) => {
      return { result: (input as any)?.value * 2 };
    });

    const result = await proc.handler({ input: { value: 21 } as any, ctx: { request: null as any } });
    expect(result).toEqual({ result: 42 });
  });

  it("should create procedure with shared middlewares", () => {
    const mw = async ({ next }: { ctx: any; next: () => Promise<unknown> }) => next();
    const builder = createProcedure(mw);

    const proc1 = builder.query(async () => "a");
    const proc2 = builder.mutation(async () => "b");

    expect(proc1.middlewares).toHaveLength(1);
    expect(proc2.middlewares).toHaveLength(1);
  });
});
