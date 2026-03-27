import { createVercelEdgeHandler } from "@celsian/adapter-vercel";
import { cors, createApp } from "@celsian/core";

const app = createApp({ logger: true });

// Register CORS (deferred — no top-level await)
const initPromise = app.register(cors({ origin: "*" }), { encapsulate: false });

// Health check
app.get("/api/health", (_req, reply) => {
  return reply.json({
    status: "ok",
    framework: "celsian",
    runtime: "vercel-edge",
    timestamp: new Date().toISOString(),
  });
});

// Hello endpoint with params
app.get("/api/hello/:name", (req, reply) => {
  return reply.json({ message: `Hello, ${req.params.name}!` });
});

// Echo POST body
app.post("/api/echo", (req, reply) => {
  return reply.json({ received: req.parsedBody });
});

// List all registered routes
app.get("/api/routes", (_req, reply) => {
  const routes = app.getRoutes().map((r) => ({ method: r.method, url: r.url }));
  return reply.json({ routes });
});

const edgeHandler = createVercelEdgeHandler(app);

export const config = { runtime: "edge" };

export default async function handler(request: Request): Promise<Response> {
  await initPromise;
  return edgeHandler(request);
}
