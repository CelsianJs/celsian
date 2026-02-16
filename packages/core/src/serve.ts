// @celsian/core — Built-in server (Node.js / Bun / Deno runtime detection)

import type { CelsianApp } from './app.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface ServeOptions {
  port?: number;
  host?: string;
  staticDir?: string;
  signal?: AbortSignal;
  onReady?: (info: { port: number; host: string }) => void;
  /** Graceful shutdown timeout in ms (default: 10_000) */
  shutdownTimeout?: number;
  /** Cleanup hook called during graceful shutdown */
  onShutdown?: () => Promise<void> | void;
}

export interface ServeResult {
  close: () => Promise<void>;
}

export async function serve(app: CelsianApp, options: ServeOptions = {}): Promise<ServeResult> {
  // Wait for all plugins to load
  await app.ready();

  // Load config file if present (options override config)
  let configPort = 3000;
  let configHost = '0.0.0.0';
  try {
    const { loadConfig } = await import('./config.js');
    const config = await loadConfig();
    configPort = config.server?.port ?? configPort;
    configHost = config.server?.host ?? configHost;
  } catch {
    // Config loading failed — use defaults
  }

  // Start task worker and cron scheduler
  app.startWorker();
  app.startCron();

  const port = options.port ?? parseInt(process.env.PORT || String(configPort), 10);
  const host = options.host ?? configHost;

  // Bun runtime detection
  if (typeof (globalThis as any).Bun !== 'undefined') {
    return serveBun(app, port, host, options);
  }

  // Deno runtime detection
  if (typeof (globalThis as any).Deno !== 'undefined') {
    return serveDeno(app, port, host, options);
  }

  // Default: Node.js
  return serveNode(app, port, host, options);
}

async function serveNode(app: CelsianApp, port: number, host: string, options: ServeOptions): Promise<ServeResult> {
  const http = await import('node:http');
  const { readFile, stat } = await import('node:fs/promises');
  const { join, extname } = await import('node:path');

  const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };

  let inFlight = 0;
  let shuttingDown = false;
  const shutdownTimeout = options.shutdownTimeout ?? 10_000;

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (shuttingDown) {
      res.statusCode = 503;
      res.end('Service Unavailable');
      return;
    }

    inFlight++;

    const url = new URL(req.url ?? '/', `http://${host}:${port}`);

    // Static files
    if (options.staticDir) {
      const filePath = join(options.staticDir, url.pathname);
      try {
        const s = await stat(filePath);
        if (s.isFile()) {
          const content = await readFile(filePath);
          const ext = extname(filePath);
          res.setHeader('content-type', MIME_TYPES[ext] ?? 'application/octet-stream');
          res.setHeader('cache-control', 'public, max-age=31536000, immutable');
          res.end(content);
          inFlight--;
          return;
        }
      } catch {
        // Not a static file
      }
    }

    const webRequest = nodeToWebRequest(req, url);

    try {
      const response = await app.handle(webRequest);
      await writeWebResponse(res, response);
    } catch (error) {
      console.error('[celsian] Unhandled error:', error);
      res.statusCode = 500;
      res.end('Internal Server Error');
    } finally {
      inFlight--;
    }
  });

  // Graceful shutdown
  const handleShutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    app.log.info('shutting down gracefully');

    // Stop accepting new connections
    server.close();

    // Wait for in-flight requests to drain
    const deadline = Date.now() + shutdownTimeout;
    while (inFlight > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
    }

    // Stop task worker and cron
    await app.stopWorker();
    app.stopCron();

    // Run user cleanup hook
    if (options.onShutdown) {
      await options.onShutdown();
    }
  };

  process.on('SIGTERM', () => handleShutdown());
  process.on('SIGINT', () => handleShutdown());

  if (options.signal) {
    options.signal.addEventListener('abort', () => handleShutdown());
  }

  server.listen(port, host, () => {
    app.log.info(`Server running at http://${host}:${port}`);
    console.log(`[celsian] Server running at http://${host}:${port}`);
    options.onReady?.({ port, host });
  });

  return {
    close: () => handleShutdown(),
  };
}

function serveBun(app: CelsianApp, port: number, host: string, options: ServeOptions): ServeResult {
  const server = (globalThis as any).Bun.serve({
    port,
    hostname: host,
    fetch: app.fetch,
  });

  console.log(`[celsian] Server running at http://${host}:${port}`);
  options.onReady?.({ port, host });

  return {
    close: async () => {
      server.stop();
      if (options.onShutdown) await options.onShutdown();
    },
  };
}

function serveDeno(app: CelsianApp, port: number, host: string, options: ServeOptions): ServeResult {
  const controller = new AbortController();

  (globalThis as any).Deno.serve({
    port,
    hostname: host,
    signal: options.signal ?? controller.signal,
    onListen() {
      console.log(`[celsian] Server running at http://${host}:${port}`);
      options.onReady?.({ port, host });
    },
  }, app.fetch);

  return {
    close: async () => {
      controller.abort();
      if (options.onShutdown) await options.onShutdown();
    },
  };
}

// ─── Conversion Helpers ───

export function nodeToWebRequest(req: IncomingMessage, url: URL): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') {
      headers.set(key, value);
    } else if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    }
  }

  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';

  return new Request(url.toString(), {
    method,
    headers,
    body: hasBody ? (req as unknown as ReadableStream) : undefined,
    duplex: hasBody ? 'half' : undefined,
  });
}

export async function writeWebResponse(
  res: ServerResponse,
  response: Response,
): Promise<void> {
  res.statusCode = response.status;

  for (const [key, value] of response.headers.entries()) {
    if (key.toLowerCase() === 'set-cookie') continue; // handled below
    res.setHeader(key, value);
  }

  // BUG-3 fix: preserve multiple Set-Cookie headers (entries() collapses them)
  const cookies = (response.headers as any).getSetCookie?.() ?? [];
  if (cookies.length > 0) {
    res.setHeader('set-cookie', cookies);
  }

  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  res.end();
}
