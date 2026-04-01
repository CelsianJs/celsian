// @celsian/jwt — JWT authentication plugin

import type { CelsianReply, CelsianRequest, HookHandler, PluginFunction } from "@celsian/core";
import * as jose from "jose";

/** Options for the JWT plugin: shared secret and allowed algorithms. */
export interface JWTOptions {
  secret: string;
  algorithms?: string[];
}

/** JWT payload with standard claims (iss, sub, exp, etc.) plus custom fields. */
export interface JWTPayload {
  [key: string]: unknown;
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
}

// Module-level secret stash — set by the jwt() plugin so createJWTGuard() can read it without args.
let _jwtSecret: string | null = null;

/** Sign and verify methods exposed on `app.jwt` after registering the plugin. */
export interface JWTNamespace {
  sign(payload: JWTPayload, options?: { expiresIn?: string | number }): Promise<string>;
  verify(token: string): Promise<JWTPayload>;
}

/**
 * JWT authentication plugin. Decorates `app.jwt` with `sign()` and `verify()`.
 *
 * @example
 * ```ts
 * await app.register(jwt({ secret: process.env.JWT_SECRET! }));
 * const token = await app.jwt.sign({ sub: userId });
 * ```
 */
export function jwt(options: JWTOptions): PluginFunction {
  const algorithms = options.algorithms ?? ["HS256"];
  const secretKey = new TextEncoder().encode(options.secret);

  return function jwtPlugin(app) {
    // Stash the secret so createJWTGuard() can read it without explicit options
    _jwtSecret = options.secret;

    const jwtInstance: JWTNamespace = {
      async sign(payload: JWTPayload, signOptions?: { expiresIn?: string | number }): Promise<string> {
        let builder = new jose.SignJWT(payload as jose.JWTPayload)
          .setProtectedHeader({ alg: algorithms[0]! })
          .setIssuedAt();

        if (signOptions?.expiresIn) {
          if (typeof signOptions.expiresIn === "number") {
            builder = builder.setExpirationTime(Math.floor(Date.now() / 1000) + signOptions.expiresIn);
          } else {
            builder = builder.setExpirationTime(signOptions.expiresIn);
          }
        }

        return builder.sign(secretKey);
      },

      async verify(token: string): Promise<JWTPayload> {
        const { payload } = await jose.jwtVerify(token, secretKey, {
          algorithms,
        });
        return payload as JWTPayload;
      },
    };

    app.decorate("jwt", jwtInstance);
  };
}

/**
 * Create a preHandler hook that verifies Bearer tokens and populates `request.user`.
 *
 * When called without arguments, reads the secret from the JWT plugin decoration (`app.jwt`).
 * This requires the JWT plugin to be registered first via `app.register(jwt({ secret }))`.
 *
 * @example
 * ```ts
 * // Option 1: No args — reads secret from the registered JWT plugin
 * await app.register(jwt({ secret: process.env.JWT_SECRET! }));
 * app.addHook('preHandler', createJWTGuard());
 *
 * // Option 2: Explicit secret
 * app.addHook('preHandler', createJWTGuard({ secret: process.env.JWT_SECRET! }));
 * ```
 */
export function createJWTGuard(options?: JWTOptions): HookHandler {
  // If options are provided, use them directly (eager init)
  if (options) {
    const algorithms = options.algorithms ?? ["HS256"];
    const secretKey = new TextEncoder().encode(options.secret);

    const guard: HookHandler<void | Response> = async (request: CelsianRequest, reply: CelsianReply) => {
      const auth = request.headers.get("authorization");
      if (!auth?.startsWith("Bearer ")) {
        return reply.status(401).json({ error: "Missing or invalid authorization header" });
      }

      const token = auth.slice(7);

      try {
        const { payload } = await jose.jwtVerify(token, secretKey, { algorithms });
        (request as Record<string, unknown>).user = payload;
      } catch {
        return reply.status(401).json({ error: "Invalid or expired token" });
      }
    };

    return guard as HookHandler;
  }

  // No options — lazy guard that reads from _jwtSecret stashed during plugin registration
  const lazyGuard: HookHandler<void | Response> = async (request: CelsianRequest, reply: CelsianReply) => {
    const secret = _jwtSecret;
    if (!secret) {
      throw new Error(
        "createJWTGuard() called without options, but the JWT plugin has not been registered. " +
        "Either pass { secret } to createJWTGuard() or register the JWT plugin first with app.register(jwt({ secret }))."
      );
    }

    const auth = request.headers.get("authorization");
    if (!auth?.startsWith("Bearer ")) {
      return reply.status(401).json({ error: "Missing or invalid authorization header" });
    }

    const token = auth.slice(7);

    try {
      const { payload } = await jose.jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ["HS256"] });
      (request as Record<string, unknown>).user = payload;
    } catch {
      return reply.status(401).json({ error: "Invalid or expired token" });
    }
  };

  return lazyGuard as HookHandler;
}

// ─── Declaration Merging ───
// Augment CelsianApp so `app.jwt` is typed after registering the JWT plugin.

declare module "@celsian/core" {
  interface CelsianApp {
    /** JWT sign/verify methods. Available after `app.register(jwt({ secret }))`. */
    jwt: JWTNamespace;
  }
}

declare module "@celsian/core" {
  interface CelsianRequest {
    /** JWT payload populated by `createJWTGuard()`. */
    user?: JWTPayload;
  }
}
