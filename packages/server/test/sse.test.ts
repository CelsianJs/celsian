// @celsian/server — SSE tests

import { describe, it, expect, vi } from 'vitest';
import { createSSEStream, createSSEHub } from '../src/sse.js';
import type { SSEEvent } from '../src/sse.js';

function makeRequest(url: string, headers?: Record<string, string>): Request {
  return new Request(`http://localhost${url}`, { headers });
}

async function readSSEStream(response: Response, maxEvents = 10): Promise<string[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: string[] = [];

  for (let i = 0; i < maxEvents; i++) {
    const { done, value } = await reader.read();
    if (done) break;
    events.push(decoder.decode(value));
  }

  reader.cancel();
  return events;
}

describe('SSE Stream', () => {
  it('creates a stream with correct headers', () => {
    const channel = createSSEStream(makeRequest('/events'), { pingInterval: 0 });
    const response = channel.response;

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('connection')).toBe('keep-alive');

    channel.close();
  });

  it('sends formatted SSE events', async () => {
    const channel = createSSEStream(makeRequest('/events'), { pingInterval: 0 });

    channel.send({ event: 'greeting', data: { message: 'hello' }, id: '1' });
    channel.close();

    const events = await readSSEStream(channel.response);
    const eventStr = events.join('');

    expect(eventStr).toContain('event: greeting');
    expect(eventStr).toContain('id: 1');
    expect(eventStr).toContain('data: {"message":"hello"}');
  });

  it('sends string data without JSON serialization', async () => {
    const channel = createSSEStream(makeRequest('/events'), { pingInterval: 0 });

    channel.send({ data: 'plain text message' });
    channel.close();

    const events = await readSSEStream(channel.response);
    expect(events.join('')).toContain('data: plain text message');
  });

  it('handles multi-line data', async () => {
    const channel = createSSEStream(makeRequest('/events'), { pingInterval: 0 });

    channel.send({ data: 'line1\nline2\nline3' });
    channel.close();

    const events = await readSSEStream(channel.response);
    const text = events.join('');
    expect(text).toContain('data: line1\n');
    expect(text).toContain('data: line2\n');
    expect(text).toContain('data: line3\n');
  });

  it('includes retry field', async () => {
    const channel = createSSEStream(makeRequest('/events'), { pingInterval: 0 });

    channel.send({ data: 'reconnect', retry: 5000 });
    channel.close();

    const events = await readSSEStream(channel.response);
    expect(events.join('')).toContain('retry: 5000');
  });

  it('sendData is shorthand for send({ data })', async () => {
    const channel = createSSEStream(makeRequest('/events'), { pingInterval: 0 });

    channel.sendData({ count: 42 });
    channel.close();

    const events = await readSSEStream(channel.response);
    expect(events.join('')).toContain('data: {"count":42}');
  });

  it('reports open state correctly', () => {
    const channel = createSSEStream(makeRequest('/events'), { pingInterval: 0 });

    expect(channel.open).toBe(true);
    channel.close();
    expect(channel.open).toBe(false);
  });

  it('calls onClose callback when closed', () => {
    const onClose = vi.fn();
    const channel = createSSEStream(makeRequest('/events'), {
      pingInterval: 0,
      onClose,
    });

    channel.close();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('close is idempotent', () => {
    const onClose = vi.fn();
    const channel = createSSEStream(makeRequest('/events'), {
      pingInterval: 0,
      onClose,
    });

    channel.close();
    channel.close();
    channel.close();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('allows custom headers', () => {
    const channel = createSSEStream(makeRequest('/events'), {
      pingInterval: 0,
      headers: { 'x-custom': 'value' },
    });

    expect(channel.response.headers.get('x-custom')).toBe('value');
    channel.close();
  });
});

describe('SSE Hub', () => {
  it('tracks connected clients', () => {
    const hub = createSSEHub();

    const ch1 = hub.subscribe(makeRequest('/events'), { pingInterval: 0 });
    expect(hub.size).toBe(1);

    const ch2 = hub.subscribe(makeRequest('/events'), { pingInterval: 0 });
    expect(hub.size).toBe(2);

    ch1.close();
    expect(hub.size).toBe(1);

    ch2.close();
    expect(hub.size).toBe(0);
  });

  it('broadcasts to all connected clients', async () => {
    const hub = createSSEHub();

    const ch1 = hub.subscribe(makeRequest('/events'), { pingInterval: 0 });
    const ch2 = hub.subscribe(makeRequest('/events'), { pingInterval: 0 });

    hub.broadcast({ event: 'update', data: { value: 1 } });

    ch1.close();
    ch2.close();

    const events1 = await readSSEStream(ch1.response);
    const events2 = await readSSEStream(ch2.response);

    expect(events1.join('')).toContain('event: update');
    expect(events2.join('')).toContain('event: update');
  });

  it('broadcastData is shorthand for broadcast({ data })', async () => {
    const hub = createSSEHub();
    const ch = hub.subscribe(makeRequest('/events'), { pingInterval: 0 });

    hub.broadcastData('hello');
    ch.close();

    const events = await readSSEStream(ch.response);
    expect(events.join('')).toContain('data: hello');
  });

  it('closeAll closes all connections', () => {
    const hub = createSSEHub();

    const ch1 = hub.subscribe(makeRequest('/events'), { pingInterval: 0 });
    const ch2 = hub.subscribe(makeRequest('/events'), { pingInterval: 0 });

    expect(hub.size).toBe(2);

    hub.closeAll();
    expect(hub.size).toBe(0);
    expect(ch1.open).toBe(false);
    expect(ch2.open).toBe(false);
  });

  it('calls per-channel onClose when hub closes all', () => {
    const onClose1 = vi.fn();
    const onClose2 = vi.fn();
    const hub = createSSEHub();

    hub.subscribe(makeRequest('/events'), { pingInterval: 0, onClose: onClose1 });
    hub.subscribe(makeRequest('/events'), { pingInterval: 0, onClose: onClose2 });

    hub.closeAll();
    expect(onClose1).toHaveBeenCalledOnce();
    expect(onClose2).toHaveBeenCalledOnce();
  });
});
