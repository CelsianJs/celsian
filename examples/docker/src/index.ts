import { createApp, serve, cors, security } from '@celsian/core';

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
app.get('/hello/:name', (req, reply) => {
  return reply.json({ message: `Hello, ${req.params.name}!` });
});

app.post('/echo', (req, reply) => {
  return reply.json({ echo: req.parsedBody });
});

// Start server
const port = parseInt(process.env.PORT ?? '3000', 10);
const { close } = serve(app, { port });

console.log(`Server running on http://0.0.0.0:${port}`);
