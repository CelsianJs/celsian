// @celsian/server — Structured request logging middleware

import type { PluginFunction, HookHandler } from '../types.js';
import { fp } from '../types.js';

export interface LoggerOptions {
  /** Log level: 'debug' | 'info' | 'warn' | 'error' | 'silent' */
  level?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  /** Custom log function (default: console.log with JSON) */
  log?: (entry: LogEntry) => void;
  /** Include request headers in log */
  includeHeaders?: boolean;
  /** Include response time */
  includeResponseTime?: boolean;
  /** Paths to skip logging */
  skip?: string[];
}

export interface LogEntry {
  timestamp: string;
  level: string;
  method: string;
  url: string;
  status?: number;
  responseTimeMs?: number;
  headers?: Record<string, string>;
  userAgent?: string;
  ip?: string;
}

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

/**
 * Structured request logging middleware.
 *
 * Usage:
 * ```ts
 * app.register(logger, { level: 'info', includeResponseTime: true });
 * ```
 */
export const logger: PluginFunction = fp(async (app, options) => {
  const opts = options as LoggerOptions;
  const level = opts.level ?? 'info';
  const logFn = opts.log ?? defaultLog;
  const includeHeaders = opts.includeHeaders ?? false;
  const includeResponseTime = opts.includeResponseTime ?? true;
  const skip = opts.skip ?? [];

  if (level === 'silent') return;

  // Track request start time
  const requestTimes = new WeakMap<Request, number>();

  const onRequestHook: HookHandler = async (request) => {
    const url = new URL(request.url);
    if (skip.some(p => url.pathname.startsWith(p))) return;

    requestTimes.set(request, performance.now());

    if (LOG_LEVELS[level] <= LOG_LEVELS.debug) {
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level: 'debug',
        method: request.method,
        url: url.pathname + url.search,
        ip: request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip') ?? undefined,
        userAgent: request.headers.get('user-agent') ?? undefined,
      };
      if (includeHeaders) {
        entry.headers = Object.fromEntries(request.headers.entries());
      }
      logFn(entry);
    }
  };

  const onResponseHook: HookHandler = async (request) => {
    const url = new URL(request.url);
    if (skip.some(p => url.pathname.startsWith(p))) return;

    const startTime = requestTimes.get(request);
    const responseTimeMs = startTime ? Math.round((performance.now() - startTime) * 100) / 100 : undefined;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: 'info',
      method: request.method,
      url: url.pathname + url.search,
      responseTimeMs: includeResponseTime ? responseTimeMs : undefined,
      ip: request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip') ?? undefined,
    };

    logFn(entry);
  };

  app.addHook('onRequest', onRequestHook);
  app.addHook('onResponse', onResponseHook);
});

function defaultLog(entry: LogEntry): void {
  const time = entry.responseTimeMs !== undefined ? ` ${entry.responseTimeMs}ms` : '';
  const status = entry.status ? ` ${entry.status}` : '';
  console.log(`[${entry.timestamp}] ${entry.method} ${entry.url}${status}${time}`);
}
