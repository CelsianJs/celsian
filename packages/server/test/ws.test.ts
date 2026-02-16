// @celsian/server — WebSocket tests

import { describe, it, expect, vi } from 'vitest';
import { WSRegistry, createRoom, wrapWebSocket, parseWSMessage } from '../src/ws.js';
import type { WSSocket } from '../src/ws.js';

describe('WSRegistry', () => {
  it('registers and matches routes', () => {
    const registry = new WSRegistry();

    const handler = {
      open: vi.fn(),
      message: vi.fn(),
    };

    registry.route('/ws/chat', handler);

    const matched = registry.match('/ws/chat');
    expect(matched).toBe(handler);

    const notMatched = registry.match('/ws/other');
    expect(notMatched).toBeNull();
  });

  it('supports multiple routes', () => {
    const registry = new WSRegistry();
    const chatHandler = { message: vi.fn() };
    const feedHandler = { message: vi.fn() };

    registry.route('/ws/chat', chatHandler);
    registry.route('/ws/feed', feedHandler);

    expect(registry.match('/ws/chat')).toBe(chatHandler);
    expect(registry.match('/ws/feed')).toBe(feedHandler);
  });

  it('getRoutes returns all registered routes', () => {
    const registry = new WSRegistry();
    registry.route('/ws/a', { message: vi.fn() });
    registry.route('/ws/b', { message: vi.fn() });

    const routes = registry.getRoutes();
    expect(routes).toHaveLength(2);
    expect(routes[0]!.path).toBe('/ws/a');
    expect(routes[1]!.path).toBe('/ws/b');
  });
});

describe('createRoom', () => {
  function mockSocket(readyState = 1): WSSocket {
    return {
      send: vi.fn(),
      sendJSON: vi.fn(),
      close: vi.fn(),
      readyState,
      data: {},
    };
  }

  it('manages membership', () => {
    const room = createRoom();
    const ws1 = mockSocket();
    const ws2 = mockSocket();

    expect(room.size).toBe(0);

    room.join(ws1);
    expect(room.size).toBe(1);

    room.join(ws2);
    expect(room.size).toBe(2);

    room.leave(ws1);
    expect(room.size).toBe(1);
  });

  it('broadcasts to all members', () => {
    const room = createRoom();
    const ws1 = mockSocket();
    const ws2 = mockSocket();

    room.join(ws1);
    room.join(ws2);

    room.broadcast('hello');

    expect(ws1.send).toHaveBeenCalledWith('hello');
    expect(ws2.send).toHaveBeenCalledWith('hello');
  });

  it('broadcastJSON sends stringified JSON', () => {
    const room = createRoom();
    const ws = mockSocket();
    room.join(ws);

    room.broadcastJSON({ type: 'update', value: 42 });

    expect(ws.send).toHaveBeenCalledWith('{"type":"update","value":42}');
  });

  it('skips closed sockets during broadcast', () => {
    const room = createRoom();
    const open = mockSocket(1);
    const closed = mockSocket(3); // CLOSED

    room.join(open);
    room.join(closed);

    room.broadcast('test');

    expect(open.send).toHaveBeenCalled();
    expect(closed.send).not.toHaveBeenCalled();
  });

  it('closeAll closes all sockets and clears room', () => {
    const room = createRoom();
    const ws1 = mockSocket();
    const ws2 = mockSocket();

    room.join(ws1);
    room.join(ws2);

    room.closeAll(1000, 'normal');

    expect(ws1.close).toHaveBeenCalledWith(1000, 'normal');
    expect(ws2.close).toHaveBeenCalledWith(1000, 'normal');
    expect(room.size).toBe(0);
  });
});

describe('wrapWebSocket', () => {
  it('wraps a raw WebSocket interface', () => {
    const rawWs = {
      send: vi.fn(),
      close: vi.fn(),
      readyState: 1,
    };

    const ws = wrapWebSocket(rawWs);

    ws.send('hello');
    expect(rawWs.send).toHaveBeenCalledWith('hello');

    ws.sendJSON({ type: 'test' });
    expect(rawWs.send).toHaveBeenCalledWith('{"type":"test"}');

    ws.close(1000, 'bye');
    expect(rawWs.close).toHaveBeenCalledWith(1000, 'bye');

    expect(ws.readyState).toBe(1);
  });

  it('provides a user data object', () => {
    const ws = wrapWebSocket({ send: vi.fn(), close: vi.fn(), readyState: 1 });

    ws.data.userId = 'user-123';
    expect(ws.data.userId).toBe('user-123');
  });
});

describe('parseWSMessage', () => {
  it('parses string messages', () => {
    const msg = parseWSMessage('hello world');
    expect(msg.data).toBe('hello world');
    expect(msg.json).toBeUndefined();
  });

  it('parses JSON string messages', () => {
    const msg = parseWSMessage('{"type":"ping","data":42}');
    expect(msg.data).toBe('{"type":"ping","data":42}');
    expect(msg.json).toEqual({ type: 'ping', data: 42 });
  });

  it('handles ArrayBuffer messages', () => {
    const buffer = new ArrayBuffer(4);
    const msg = parseWSMessage(buffer);
    expect(msg.data).toBeInstanceOf(ArrayBuffer);
    expect(msg.json).toBeUndefined();
  });

  it('handles Uint8Array messages', () => {
    const arr = new Uint8Array([72, 101, 108, 108, 111]);
    const msg = parseWSMessage(arr);
    expect(msg.data).toBeInstanceOf(ArrayBuffer);
  });

  it('handles invalid JSON gracefully', () => {
    const msg = parseWSMessage('{invalid json}');
    expect(msg.data).toBe('{invalid json}');
    expect(msg.json).toBeUndefined();
  });
});
