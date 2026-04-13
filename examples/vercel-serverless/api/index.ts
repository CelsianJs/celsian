// CelsianJS on Vercel — Serverless Function (Fluid Compute)
//
// This is the recommended way to deploy CelsianJS on Vercel.
// Uses Node.js runtime with Fluid Compute for optimal cold-start
// performance and full Node.js API compatibility.

import { createVercelHandler } from "@celsian/adapter-vercel";
import { cors, createApp } from "@celsian/core";

const app = createApp({ logger: true, trustProxy: true });

// Register plugins
await app.register(cors({ origin: "*" }), { encapsulate: false });

// Health check
app.get("/api/health", (_req, reply) => {
  return reply.json({
    status: "ok",
    framework: "celsian",
    runtime: "vercel-serverless",
    timestamp: new Date().toISOString(),
  });
});

// API routes
app.get("/api/hello/:name", (req, reply) => {
  return reply.json({ message: `Hello, ${req.params.name}!` });
});

app.post("/api/echo", (req, reply) => {
  return reply.json({ received: req.parsedBody });
});

// List registered routes
app.get("/api/routes", (_req, reply) => {
  const routes = app.getRoutes().map((r) => ({ method: r.method, url: r.url }));
  return reply.json({ routes });
});

// Ensure all plugins are loaded before handling requests
await app.ready();

export default createVercelHandler(app);
