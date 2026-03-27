// @celsian/core — Security headers plugin (Helmet-style)

import type { CelsianReply, CelsianRequest, HookHandler, PluginFunction } from "../types.js";

export interface SecurityOptions {
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
  /** Content-Security-Policy (default: none — too app-specific) */
  contentSecurityPolicy?: string | false;
}

export function security(options: SecurityOptions = {}): PluginFunction {
  return function securityPlugin(app) {
    const hook: HookHandler = (_request: CelsianRequest, reply: CelsianReply) => {
      // X-Content-Type-Options
      if (options.contentTypeOptions !== false) {
        reply.header("x-content-type-options", "nosniff");
      }

      // X-Frame-Options
      const frame = options.frameOptions ?? "DENY";
      if (frame !== false) {
        reply.header("x-frame-options", frame);
      }

      // X-XSS-Protection: send 0 to disable broken legacy filter
      if (options.xssProtection !== false) {
        reply.header("x-xss-protection", "0");
      }

      // Strict-Transport-Security
      const hsts = options.hsts ?? { maxAge: 31536000, includeSubDomains: true };
      if (hsts !== false) {
        let value = `max-age=${hsts.maxAge ?? 31536000}`;
        if (hsts.includeSubDomains !== false) value += "; includeSubDomains";
        if (hsts.preload) value += "; preload";
        reply.header("strict-transport-security", value);
      }

      // Referrer-Policy
      const referrer = options.referrerPolicy ?? "strict-origin-when-cross-origin";
      if (referrer !== false) {
        reply.header("referrer-policy", referrer);
      }

      // X-Permitted-Cross-Domain-Policies
      const crossDomain = options.crossDomainPolicy ?? "none";
      if (crossDomain !== false) {
        reply.header("x-permitted-cross-domain-policies", crossDomain);
      }

      // X-DNS-Prefetch-Control
      const dns = options.dnsPrefetchControl ?? "off";
      if (dns !== false) {
        reply.header("x-dns-prefetch-control", dns);
      }

      // X-Download-Options
      const download = options.downloadOptions ?? "noopen";
      if (download !== false) {
        reply.header("x-download-options", download);
      }

      // Content-Security-Policy (opt-in only)
      if (options.contentSecurityPolicy) {
        reply.header("content-security-policy", options.contentSecurityPolicy);
      }
    };

    app.addHook("onRequest", hook);
  };
}
