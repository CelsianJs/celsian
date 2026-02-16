// CelsianJS — Cloudflare Workers example
//
// Demonstrates:
//  - createCloudflareHandler() adapter
//  - KV namespace read/write (CACHE binding)
//  - CORS and security plugins
//  - Health check, JSON API, and KV routes

import { createApp, cors, security } from '@celsian/core';
import { createCloudflareHandler } from '@celsian/adapter-cloudflare';
import type { CloudflareEnv } from '@celsian/adapter-cloudflare';

// ─── Env Bindings ───────────────────────────────────────────────

interface Env extends CloudflareEnv {
  CACHE: KVNamespace;
  ENVIRONMENT: string;
}

// ─── App Setup ──────────────────────────────────────────────────

const app = createApp();

// Plugins
app.register(cors({
  origin: '*',
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
  maxAge: 86400,
}));

app.register(security({
  hsts: { maxAge: 31536000, includeSubDomains: true },
  contentSecurityPolicy: "default-src 'none'",
}));

// ─── Health Check ───────────────────────────────────────────────

app.get('/health', (_req, reply) => {
  return reply.json({
    status: 'ok',
    runtime: 'cloudflare-workers',
    timestamp: new Date().toISOString(),
  });
});

// ─── JSON API ───────────────────────────────────────────────────

app.get('/api/info', (req, reply) => {
  const env = (req as unknown as Record<string, unknown>).env as Env;

  return reply.json({
    name: 'celsian-worker',
    version: '1.0.0',
    environment: env.ENVIRONMENT ?? 'unknown',
    region: (req.headers.get('cf-ipcountry') ?? 'unknown'),
  });
});

// ─── KV Read / Write ────────────────────────────────────────────

// GET /kv/:key — read a value from CACHE KV
app.get('/kv/:key', async (req, reply) => {
  const env = (req as unknown as Record<string, unknown>).env as Env;
  const { key } = req.params as { key: string };

  const value = await env.CACHE.get(key);
  if (value === null) {
    return reply.status(404).json({
      error: 'Not Found',
      message: `Key "${key}" does not exist in CACHE`,
    });
  }

  // Try parsing as JSON, fall back to plain string
  try {
    return reply.json({ key, value: JSON.parse(value) });
  } catch {
    return reply.json({ key, value });
  }
});

// PUT /kv/:key — write a value to CACHE KV
app.put('/kv/:key', async (req, reply) => {
  const env = (req as unknown as Record<string, unknown>).env as Env;
  const ctx = (req as unknown as Record<string, unknown>).ctx as {
    waitUntil(p: Promise<unknown>): void;
  };
  const { key } = req.params as { key: string };
  const body = req.parsedBody as { value: unknown; ttl?: number } | undefined;

  if (!body || body.value === undefined) {
    return reply.status(400).json({
      error: 'Bad Request',
      message: 'Request body must include a "value" field',
    });
  }

  const serialized = typeof body.value === 'string'
    ? body.value
    : JSON.stringify(body.value);

  const kvOptions: KVNamespacePutOptions = {};
  if (body.ttl && body.ttl > 0) {
    kvOptions.expirationTtl = body.ttl;
  }

  // Use waitUntil so the write doesn't block the response
  ctx.waitUntil(env.CACHE.put(key, serialized, kvOptions));

  return reply.status(201).json({
    key,
    stored: true,
    ttl: body.ttl ?? null,
  });
});

// DELETE /kv/:key — delete a value from CACHE KV
app.delete('/kv/:key', async (req, reply) => {
  const env = (req as unknown as Record<string, unknown>).env as Env;
  const ctx = (req as unknown as Record<string, unknown>).ctx as {
    waitUntil(p: Promise<unknown>): void;
  };
  const { key } = req.params as { key: string };

  ctx.waitUntil(env.CACHE.delete(key));

  return reply.json({ key, deleted: true });
});

// ─── Export Worker Handler ──────────────────────────────────────

export default createCloudflareHandler(app);
