import { describe, it, expect } from 'vitest';
import { buildWSApp, createMockWS, WSRegistry } from './ws-test.js';

describe('WebSocket Support', () => {
  // ─── Registry ───

  it('registers WebSocket handlers', () => {
    const app = buildWSApp();
    expect(app.wsRegistry.hasPath('/echo')).toBe(true);
    expect(app.wsRegistry.hasPath('/chat')).toBe(true);
    expect(app.wsRegistry.hasPath('/unknown')).toBe(false);
  });

  it('reports having handlers', () => {
    const app = buildWSApp();
    expect(app.wsRegistry.hasAnyHandlers()).toBe(true);
  });

  // ─── Echo Handler ───

  it('echo handler sends welcome on open', () => {
    const app = buildWSApp();
    const handler = app.wsRegistry.getHandler('/echo')!;
    const { ws, sent } = createMockWS();

    handler.open?.(ws, {} as any);
    expect(sent).toEqual(['connected']);
  });

  it('echo handler echoes messages', () => {
    const app = buildWSApp();
    const handler = app.wsRegistry.getHandler('/echo')!;
    const { ws, sent } = createMockWS();

    handler.message?.(ws, 'hello');
    expect(sent).toEqual(['echo: hello']);
  });

  // ─── Broadcast ───

  it('broadcast sends to all connections except sender', () => {
    const registry = new WSRegistry();
    registry.register('/chat', {});

    const { ws: ws1, sent: sent1 } = createMockWS();
    const { ws: ws2, sent: sent2 } = createMockWS();
    const { ws: ws3, sent: sent3 } = createMockWS();

    registry.addConnection('/chat', ws1);
    registry.addConnection('/chat', ws2);
    registry.addConnection('/chat', ws3);

    // Broadcast from ws1 — should reach ws2 and ws3 but not ws1
    registry.broadcast('/chat', 'Hello all', ws1.id);
    expect(sent1).toEqual([]);
    expect(sent2).toEqual(['Hello all']);
    expect(sent3).toEqual(['Hello all']);
  });

  it('broadcast without exclude sends to everyone', () => {
    const registry = new WSRegistry();
    registry.register('/room', {});

    const { ws: ws1, sent: sent1 } = createMockWS();
    const { ws: ws2, sent: sent2 } = createMockWS();

    registry.addConnection('/room', ws1);
    registry.addConnection('/room', ws2);

    registry.broadcast('/room', 'ping');
    expect(sent1).toEqual(['ping']);
    expect(sent2).toEqual(['ping']);
  });

  // ─── Connection Management ───

  it('tracks connection count', () => {
    const registry = new WSRegistry();
    registry.register('/test', {});

    expect(registry.getConnectionCount('/test')).toBe(0);

    const { ws: ws1 } = createMockWS();
    const { ws: ws2 } = createMockWS();
    registry.addConnection('/test', ws1);
    registry.addConnection('/test', ws2);

    expect(registry.getConnectionCount('/test')).toBe(2);
    expect(registry.getConnectionCount()).toBe(2);

    registry.removeConnection('/test', ws1);
    expect(registry.getConnectionCount('/test')).toBe(1);
  });

  it('broadcastAll sends to all paths', () => {
    const registry = new WSRegistry();
    registry.register('/a', {});
    registry.register('/b', {});

    const { ws: ws1, sent: sent1 } = createMockWS();
    const { ws: ws2, sent: sent2 } = createMockWS();

    registry.addConnection('/a', ws1);
    registry.addConnection('/b', ws2);

    registry.broadcastAll('global message');
    expect(sent1).toEqual(['global message']);
    expect(sent2).toEqual(['global message']);
  });

  // ─── Metadata ───

  it('connections have metadata object', () => {
    const { ws } = createMockWS();
    expect(ws.metadata).toBeDefined();
    ws.metadata.role = 'admin';
    expect(ws.metadata.role).toBe('admin');
  });

  it('connections have unique IDs', () => {
    const { ws: ws1 } = createMockWS();
    const { ws: ws2 } = createMockWS();
    expect(ws1.id).not.toBe(ws2.id);
    expect(ws1.id).toMatch(/^ws-/);
  });
});
