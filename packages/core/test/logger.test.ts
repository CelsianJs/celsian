import { describe, it, expect } from 'vitest';
import { createLogger } from '../src/logger.js';

describe('Logger', () => {
  it('should output JSON-structured log lines', () => {
    const lines: string[] = [];
    const logger = createLogger({
      destination: (line) => lines.push(line),
    });

    logger.info('hello world');

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('hello world');
    expect(typeof parsed.time).toBe('number');
  });

  it('should include extra data in log line', () => {
    const lines: string[] = [];
    const logger = createLogger({
      destination: (line) => lines.push(line),
    });

    logger.info('request', { method: 'GET', url: '/test' });

    const parsed = JSON.parse(lines[0]);
    expect(parsed.method).toBe('GET');
    expect(parsed.url).toBe('/test');
  });

  it('should respect log level filtering', () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'warn',
      destination: (line) => lines.push(line),
    });

    logger.debug('should not appear');
    logger.info('should not appear');
    logger.warn('should appear');
    logger.error('should appear');

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).level).toBe('warn');
    expect(JSON.parse(lines[1]).level).toBe('error');
  });

  it('should create child loggers with merged bindings', () => {
    const lines: string[] = [];
    const logger = createLogger({
      destination: (line) => lines.push(line),
    });

    const child = logger.child({ requestId: 'abc123' });
    child.info('child log');

    const parsed = JSON.parse(lines[0]);
    expect(parsed.requestId).toBe('abc123');
    expect(parsed.msg).toBe('child log');
  });

  it('should support all log levels', () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'trace',
      destination: (line) => lines.push(line),
    });

    logger.trace('t');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    logger.fatal('f');

    expect(lines).toHaveLength(6);
    const levels = lines.map(l => JSON.parse(l).level);
    expect(levels).toEqual(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
  });

  it('should support nested child loggers', () => {
    const lines: string[] = [];
    const logger = createLogger({
      destination: (line) => lines.push(line),
      bindings: { service: 'api' },
    });

    const child = logger.child({ requestId: '123' });
    const grandchild = child.child({ userId: '456' });
    grandchild.info('deep');

    const parsed = JSON.parse(lines[0]);
    expect(parsed.service).toBe('api');
    expect(parsed.requestId).toBe('123');
    expect(parsed.userId).toBe('456');
  });

  it('should integrate with app via logger option', async () => {
    const { createApp } = await import('../src/app.js');
    const lines: string[] = [];
    const logger = createLogger({
      destination: (line) => lines.push(line),
    });

    const app = createApp({ logger });
    app.get('/test', (_req, reply) => reply.json({ ok: true }));

    await app.handle(new Request('http://localhost/test'));

    // Should have request logging
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const msgs = lines.map(l => JSON.parse(l).msg);
    expect(msgs).toContain('incoming request');
    expect(msgs).toContain('request completed');
  });
});
