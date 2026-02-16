import { createApp, serve } from 'celsian';

const app = createApp();

app.get('/health', (req, reply) => {
  return reply.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/hello/:name', (req, reply) => {
  return reply.json({ message: `Hello, ${req.params.name}!` });
});

serve(app, { port: 3000 });
