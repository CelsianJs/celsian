// @celsian/core — Security headers plugin (Helmet-style)

import type { CelsianReply, CelsianRequest, HookHandler, PluginFunction } from "../types.js";

export interface SecurityOptions {
  /** Disable all security headers (default: false). When true, the plugin is a no-op. */
  enabled?: boolean;
  /** X-Content-Type-Options: nosniff (default: true) */
  contentTypeOptions?: boolean;
  /** X-Frame-Options (default: 'DENY') */
  frameOptions?: "DENY" | "SAMEORIGIN" | false;
  /** X-XSS-Protection: 0 (default: true — disables broken legacy filter) */
  xssProtection?: boolean;
  /** Strict-Transport-Security (default: max-age=31536000; includeSubDomains) */
  hsts?: { maxAge?: number; includeSubDomains?: boolean; preload?: boolean } | false;
  /** Referrer-Policy (default: 'strict-origin-when-cross-origin') */
  referrerPolicy?: string | false;
  /** X-Permitted-Cross-Domain-Policies (default: 'none') */
  crossDomainPolicy?: string | false;
  /** X-DNS-Prefetch-Control (default: 'off') */
  dnsPrefetchControl?: "on" | "off" | false;
  /** X-Download-Options (default: 'noopen') */
  downloadOptions?: string | false;
  /** Content-Security-Policy (default: "default-src 'self'") */
  contentSecurityPolicy?: string | false;
}

/**
 * Pre-compute security headers from options into a plain object.
 * Used by both the onRequest hook and the app's pre-route error responses (404/405).
 */
export function buildSecurityHeaders(options: SecurityOptions = {}): Record<string, string> {
  if (options.enabled === false) return {};

  const headers: Record<string, string> = {};

  if (options.contentTypeOptions !== false) {
    headers["x-content-type-options"] = "nosniff";
  }

  const frame = options.frameOptions ?? "DENY";
  if (frame !== false) {
    headers["x-frame-options"] = frame;
  }

  if (options.xssProtection !== false) {
    headers["x-xss-protection"] = "0";
  }

  const hsts = options.hsts ?? { maxAge: 31536000, includeSubDomains: true };
  if (hsts !== false) {
    let value = `max-age=${hsts.maxAge ?? 31536000}`;
    if (hsts.includeSubDomains !== false) value += "; includeSubDomains";
    if (hsts.preload) value += "; preload";
    headers["strict-transport-security"] = value;
  }

  const referrer = options.referrerPolicy ?? "strict-origin-when-cross-origin";
  if (referrer !== false) {
    headers["referrer-policy"] = referrer;
  }

  const crossDomain = options.crossDomainPolicy ?? "none";
  if (crossDomain !== false) {
    headers["x-permitted-cross-domain-policies"] = crossDomain;
  }

  const dns = options.dnsPrefetchControl ?? "off";
  if (dns !== false) {
    headers["x-dns-prefetch-control"] = dns;
  }

  const download = options.downloadOptions ?? "noopen";
  if (download !== false) {
    headers["x-download-options"] = download;
  }

  const csp = options.contentSecurityPolicy ?? "default-src 'self'";
  if (csp !== false) {
    headers["content-security-policy"] = csp;
  }

  return headers;
}

export function security(options: SecurityOptions = {}): PluginFunction {
  return function securityPlugin(app) {
    // Allow disabling the entire plugin
    if (options.enabled === false) return;

    // Pre-compute headers once at registration time
    const securityHeaders = buildSecurityHeaders(options);

    const hook: HookHandler = (_request: CelsianRequest, reply: CelsianReply) => {
      for (const [key, value] of Object.entries(securityHeaders)) {
        reply.header(key, value);
      }
    };

    app.addHook("onRequest", hook);
  };
}
