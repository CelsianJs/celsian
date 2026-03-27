// @celsian/core — Server-Sent Events (SSE) support

export interface SSEEvent {
  /** Event type (maps to `event:` field) */
  event?: string;
  /** Event data (maps to `data:` field). Objects are JSON-stringified. */
  data: unknown;
  /** Event ID (maps to `id:` field) */
  id?: string;
  /** Retry interval in ms (maps to `retry:` field) */
  retry?: number;
}

export interface SSEStreamOptions {
  /** Ping interval in ms to keep connection alive (default: 30000) */
  pingInterval?: number;
  /** Custom headers to include */
  headers?: Record<string, string>;
  /** Called when the client disconnects */
  onClose?: () => void;
}

// Module-level singleton — avoids per-channel allocation
const encoder = new TextEncoder();

/**
 * Format an SSE event into the wire format.
 */
function formatSSEEvent(event: SSEEvent): string {
  let result = '';

  if (event.event) {
    result += `event: ${event.event}\n`;
  }

  if (event.id !== undefined) {
    result += `id: ${event.id}\n`;
  }

  if (event.retry !== undefined) {
    result += `retry: ${event.retry}\n`;
  }

  // Data can be multi-line — each line needs its own `data:` prefix
  const data = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
  const lines = data.split('\n');
  for (const line of lines) {
    result += `data: ${line}\n`;
  }

  result += '\n'; // Empty line terminates the event
  return result;
}

/**
 * SSE channel — a controller for sending events to a client.
 *
 * Usage in route handlers:
 * ```ts
 * app.get('/events', (req, reply) => {
 *   const channel = createSSEStream(req);
 *   channel.send({ event: 'greeting', data: { message: 'Hello!' } });
 *   // Keep sending events...
 *   return channel.response;
 * });
 * ```
 */
export interface SSEChannel {
  /** Send an SSE event to the client */
  send(event: SSEEvent): void;
  /** Send raw data (shorthand for `send({ data })`) */
  sendData(data: unknown): void;
  /** Close the SSE stream */
  close(): void;
  /** The Response to return from the route handler */
  readonly response: Response;
  /** Whether the stream is still open */
  readonly open: boolean;
}

/**
 * Create an SSE stream for a request.
 */
export function createSSEStream(
  request: Request,
  options?: SSEStreamOptions,
): SSEChannel {
  const pingInterval = options?.pingInterval ?? 30_000;
  const onClose = options?.onClose;
  let isOpen = true;
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();

  // Keep-alive ping
  if (pingInterval > 0) {
    pingTimer = setInterval(() => {
      if (isOpen) {
        writer.write(encoder.encode(': ping\n\n')).catch(() => {
          close();
        });
      }
    }, pingInterval);
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;

    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }

    writer.close().catch(() => {});
    onClose?.();
  }

  // Detect client disconnect via abort signal
  request.signal?.addEventListener('abort', close);

  const headers: Record<string, string> = {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...options?.headers,
  };

  const response = new Response(stream.readable as ReadableStream<Uint8Array>, {
    status: 200,
    headers,
  });

  const channel: SSEChannel = {
    send(event: SSEEvent) {
      if (!isOpen) return;
      const formatted = formatSSEEvent(event);
      writer.write(encoder.encode(formatted)).catch(() => {
        close();
      });
    },
    sendData(data: unknown) {
      this.send({ data });
    },
    close,
    get response() {
      return response;
    },
    get open() {
      return isOpen;
    },
  };

  return channel;
}

/**
 * SSE broadcast hub — fan-out events to multiple connected clients.
 *
 * Usage:
 * ```ts
 * const hub = createSSEHub();
 *
 * app.get('/events', (req, reply) => {
 *   const channel = hub.subscribe(req);
 *   return channel.response;
 * });
 *
 * // Broadcast to all connected clients
 * hub.broadcast({ event: 'update', data: { count: 42 } });
 * ```
 */
export interface SSEHub {
  /** Subscribe a new client — returns the SSEChannel for that client */
  subscribe(request: Request, options?: SSEStreamOptions): SSEChannel;
  /** Broadcast an event to all connected clients */
  broadcast(event: SSEEvent): void;
  /** Broadcast raw data to all clients */
  broadcastData(data: unknown): void;
  /** Number of connected clients */
  readonly size: number;
  /** Close all connections */
  closeAll(): void;
}

export function createSSEHub(): SSEHub {
  const channels = new Set<SSEChannel>();

  return {
    subscribe(request: Request, options?: SSEStreamOptions): SSEChannel {
      const channel = createSSEStream(request, {
        ...options,
        onClose: () => {
          channels.delete(channel);
          options?.onClose?.();
        },
      });
      channels.add(channel);
      return channel;
    },

    broadcast(event: SSEEvent) {
      for (const channel of channels) {
        channel.send(event);
      }
    },

    broadcastData(data: unknown) {
      this.broadcast({ data });
    },

    get size() {
      return channels.size;
    },

    closeAll() {
      for (const channel of channels) {
        channel.close();
      }
      channels.clear();
    },
  };
}
