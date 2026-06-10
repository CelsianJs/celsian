// Fixture app for `celsian routes` — named `app` export, calls serve() like
// the scaffolded templates do (the loader must still exit cleanly).

import { createApp, serve } from "@celsian/core";

export const app = createApp();

app.get("/health", (_req, reply) => reply.json({ status: "ok" }));
app.get("/hello/:name", (req, reply) => reply.json({ message: `Hello, ${req.params.name}!` }));
app.post("/items", (_req, reply) => reply.status(201).json({ created: true }));

serve(app);
