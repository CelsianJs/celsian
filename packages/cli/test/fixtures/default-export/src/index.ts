// Fixture app for `celsian routes` — default export, no serve().

import { createApp } from "@celsian/core";

const app = createApp();

app.get("/ping", (_req, reply) => reply.json({ pong: true }));
app.delete("/items/:id", (_req, reply) => reply.status(204).json({ deleted: true }));

export default app;
