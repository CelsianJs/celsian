// @celsian/core — Test injection utility (no server needed)

import type { CelsianApp } from './app.js';
import type { RouteMethod } from './types.js';

export interface InjectOptions {
  method?: RouteMethod;
  url: string;
  headers?: Record<string, string>;
  payload?: unknown;
  query?: Record<string, string>;
}

export function createInject(app: CelsianApp) {
  return async function inject(options: InjectOptions): Promise<Response> {
    let url = options.url;

    // Append query params
    if (options.query) {
      const params = new URLSearchParams(options.query);
      const separator = url.includes('?') ? '&' : '?';
      url = url + separator + params.toString();
    }

    // Ensure absolute URL
    if (!url.startsWith('http')) {
      url = 'http://localhost' + (url.startsWith('/') ? '' : '/') + url;
    }

    const method = options.method ?? 'GET';
    const headers = new Headers(options.headers);

    let body: string | undefined;
    if (options.payload !== undefined) {
      body = JSON.stringify(options.payload);
      if (!headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }
    }

    const request = new Request(url, {
      method,
      headers,
      body,
    });

    return app.handle(request);
  };
}
