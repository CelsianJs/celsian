// benchmarks/server-hono.ts — Hono benchmark target (Node.js adapter)

import { serve } from "@hono/node-server";
import { Hono } from "hono";

export async function startHonoServer(port: number): Promise<{ close: () => Promise<void> }> {
  const app = new Hono();

  app.get("/json", (c) => c.json({ message: "Hello, World!" }));

  app.get("/users/:id", (c) => c.json({ id: c.req.param("id") }));

  app.post("/echo", async (c) => {
    const body = await c.req.json();
    return c.json(body);
  });

  // Use middleware (equivalent to onRequest hooks in CelsianJS/Fastify)
  app.use("/hooks", async (c, next) => {
    c.header("x-hook-1", "true");
    await next();
  });
  app.use("/hooks", async (c, next) => {
    c.header("x-hook-2", "true");
    await next();
  });
  app.use("/hooks", async (c, next) => {
    c.header("x-hook-3", "true");
    await next();
  });
  app.get("/hooks", (c) => c.json({ hooks: "ok" }));

  return new Promise<{ close: () => Promise<void> }>((resolve) => {
    const server = serve({ fetch: app.fetch, port }, () => {
      resolve({
        close: async () => {
          server.close();
        },
      });
    });
  });
}
