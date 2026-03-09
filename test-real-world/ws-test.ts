// Real-world test: WebSocket registration and broadcasting
// Note: Actual WS connections require a real server (Bun/Node),
// so we test the registry + handler setup API surface here.
import { createApp } from '../packages/core/src/app.js';
import { WSRegistry, createWSConnection } from '../packages/core/src/websocket.js';
import type { CelsianApp } from '../packages/core/src/app.js';
import type { WSHandler, WSConnection } from '../packages/core/src/websocket.js';

export function buildWSApp(): CelsianApp {
  const app = createApp();

  // Echo handler
  app.ws('/echo', {
    open(ws) {
      ws.send('connected');
    },
    message(ws, data) {
      // Echo back whatever was sent
      ws.send(typeof data === 'string' ? `echo: ${data}` : data);
    },
    close(_ws, code, reason) {
      // Clean up
    },
  });

  // Chat/broadcast handler
  app.ws('/chat', {
    open(ws) {
      ws.metadata.joinedAt = Date.now();
    },
    message(ws, data) {
      // Broadcast to all other connected clients on /chat
      if (typeof data === 'string') {
        app.wsBroadcast('/chat', data, ws.id);
      }
    },
  });

  return app;
}

// Helper: create a mock WS connection for testing
export function createMockWS(): { ws: WSConnection; sent: (string | ArrayBuffer)[] } {
  const sent: (string | ArrayBuffer)[] = [];
  const rawWs = {
    send(data: string | ArrayBuffer) {
      sent.push(data);
    },
    close(_code?: number, _reason?: string) {
      // no-op
    },
  };
  return { ws: createWSConnection(rawWs), sent };
}

export { WSRegistry };
