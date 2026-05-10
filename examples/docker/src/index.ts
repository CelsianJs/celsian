import { cors, createApp, serve } from "@celsian/core";

const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:3000";

const app = createApp({
  logger: true,
  trustProxy: true,
});

// Plugins (security headers are enabled by default)
await app.register(cors({ origin: CORS_ORIGIN }), { encapsulate: false });

// Health probes (for Docker HEALTHCHECK + orchestrators)
app.health();

// Routes
app.get("/hello/:name", (req, reply) => {
  return reply.json({ message: `Hello, ${req.params.name}!` });
});

app.post("/echo", (req, reply) => {
  return reply.json({ echo: req.parsedBody });
});

// Start server
const port = parseInt(process.env.PORT ?? "3000", 10);
const { close: _close } = serve(app, { port });

console.log(`Server running on http://0.0.0.0:${port}`);
