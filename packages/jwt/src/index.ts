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
 * Always pass explicit options so the guard is bound to the intended app secret.
 *
 * @example
 * ```ts
 * await app.register(jwt({ secret: process.env.JWT_SECRET! }));
 * app.addHook('preHandler', createJWTGuard({ secret: process.env.JWT_SECRET! }));
 * ```
 */
export function createJWTGuard(options: JWTOptions): HookHandler {
  if (!options?.secret) {
    throw new Error(
      "createJWTGuard() requires an explicit { secret }. This prevents process-global JWT state from leaking across apps.",
    );
  }

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
