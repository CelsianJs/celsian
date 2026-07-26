import { createApp, serve } from "celsian";

const app = createApp();

app.get("/health", (_req, reply) => {
  return reply.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/hello/:name", (req, reply) => {
  return reply.json({ message: `Hello, ${req.params.name}!` });
});

serve(app, { port: parseInt(process.env.PORT ?? "3000", 10) });

// Exported so tooling that loads this file (for example `celsian routes`)
// can find the app. Running the file directly still starts the server above.
export default app;
