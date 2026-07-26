// benchmarks/server-hono.ts - Hono benchmark target (Node.js adapter)
//
// Routes mirror the other benchmark servers exactly (same paths, same payloads)
// so the numbers are comparable.

import { serve } from "@hono/node-server";
import { Hono } from "hono";

export async function startHonoServer(port: number): Promise<{ close: () => Promise<void> }> {
  const app = new Hono();

  // Scenario 1: JSON hello
  app.get("/json", (c) => c.json({ message: "Hello, World!" }));

  // Scenario 2: Route params
  app.get("/user/:id", (c) => {
    const id = c.req.param("id");
    return c.json({ id, name: `User ${id}`, email: `user${id}@test.com` });
  });

  // Scenario 3: Middleware chain (5 layers)
  for (const n of [1, 2, 3, 4, 5]) {
    app.use("/middleware", async (c, next) => {
      c.header(`x-mw-${n}`, "true");
      await next();
    });
  }
  app.get("/middleware", (c) => c.json({ middleware: "ok" }));

  // Scenario 4: Body parse
  app.post("/echo", async (c) => c.json(await c.req.json()));

  // Scenario 5: Error handling
  app.get("/error", () => {
    throw new Error("Intentional benchmark error");
  });

  app.onError((err, c) => c.json({ error: err.message }, 500));

  return new Promise<{ close: () => Promise<void> }>((resolve) => {
    const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
      resolve({
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}
