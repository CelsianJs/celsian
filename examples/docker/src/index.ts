import { cors, createApp, security, serve } from "@celsian/core";

const app = createApp({
  logger: true,
  trustProxy: true,
});

// Plugins
await app.register(cors(), { encapsulate: false });
await app.register(security(), { encapsulate: false });

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
const { close: _close } = await serve(app, { port, host: "0.0.0.0" });

console.log(`Server running on http://0.0.0.0:${port}`);

// Exported so tooling that loads this file (for example `celsian routes`)
// can find the app. Running the file directly still starts the server above.
export default app;
