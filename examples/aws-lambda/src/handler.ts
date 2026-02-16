import { createApp } from '@celsian/core';
import { createLambdaHandler } from '@celsian/adapter-lambda';

// ─── App Setup ───

const app = createApp({
  trustProxy: true,
});

// ─── Routes ───

app.get('/health', (_req, reply) => {
  return reply.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    region: process.env.AWS_REGION ?? 'unknown',
  });
});

app.get('/users', (_req, reply) => {
  return reply.json({
    users: [
      { id: 1, name: 'Alice', email: 'alice@example.com' },
      { id: 2, name: 'Bob', email: 'bob@example.com' },
      { id: 3, name: 'Charlie', email: 'charlie@example.com' },
    ],
  });
});

app.get('/users/:id', (req, reply) => {
  const id = parseInt(req.params.id, 10);

  if (isNaN(id) || id < 1) {
    return reply.status(400).json({
      error: 'Invalid user ID',
      statusCode: 400,
    });
  }

  return reply.json({
    id,
    name: `User ${id}`,
    email: `user${id}@example.com`,
    createdAt: new Date().toISOString(),
  });
});

app.post('/users', (req, reply) => {
  const body = req.parsedBody as { name?: string; email?: string } | undefined;

  if (!body?.name || !body?.email) {
    return reply.status(400).json({
      error: 'Missing required fields: name, email',
      statusCode: 400,
    });
  }

  return reply.status(201).json({
    id: Math.floor(Math.random() * 10000),
    name: body.name,
    email: body.email,
    createdAt: new Date().toISOString(),
  });
});

app.post('/echo', (req, reply) => {
  return reply.json({
    received: req.parsedBody,
    method: req.method,
    path: req.url,
    headers: Object.fromEntries(req.headers.entries()),
  });
});

// ─── Lambda Handler ───

await app.ready();

export const handler = createLambdaHandler(app);
