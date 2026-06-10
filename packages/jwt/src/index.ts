// @celsian/jwt — JWT authentication plugin

import {
  CelsianError,
  type CelsianReply,
  type CelsianRequest,
  type HookHandler,
  type PluginFunction,
} from "@celsian/core";
import * as jose from "jose";

/** Request property key under which each app's resolved JWT config is decorated. */
const REQUEST_CONFIG_KEY = "_celsianJwtConfig";

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

/** Resolved per-app JWT config (secret bytes + allowed algorithms). */
interface ResolvedJWTConfig {
  secretKey: Uint8Array;
  algorithms: string[];
}

/** Minimum recommended HMAC secret length in bytes (RFC 7518 §3.2: HS256 keys must be >= 256 bits). */
const MIN_HMAC_SECRET_BYTES = 32;

/**
 * Warn (without throwing — non-breaking) when an HS* secret is shorter than
 * 32 bytes. Short HMAC secrets can be brute-forced offline from any captured
 * token. Deliberately uses console.warn rather than the app logger: the
 * default Celsian logger is a silent no-op, and a security warning must not
 * be swallowed.
 */
function warnIfWeakHmacSecret(secretKey: Uint8Array, algorithms: string[]): void {
  if (secretKey.byteLength < MIN_HMAC_SECRET_BYTES && algorithms.some((alg) => alg.startsWith("HS"))) {
    console.warn(
      `[@celsian/jwt] The configured HS* secret is only ${secretKey.byteLength} bytes. ` +
        `HMAC secrets should be at least ${MIN_HMAC_SECRET_BYTES} bytes (256 bits) of random data — ` +
        "short secrets can be brute-forced offline from a captured token. Generate one with: " +
        `node -e "console.log(crypto.randomBytes(${MIN_HMAC_SECRET_BYTES}).toString('hex'))"`,
    );
  }
}

// Per-app config storage — avoids module-scope leakage while supporting createJWTGuard() without args.
// Keyed by the PluginContext (app) the JWT plugin was registered on, so each app's secret/algorithms
// stay isolated even when multiple CelsianApp instances exist in the same process.
const _appConfigs = new WeakMap<object, ResolvedJWTConfig>();
// Tracks the most-recently-registered app so a no-arg createJWTGuard() can bind to it at CALL time
// (i.e. when the guard is created and added as a hook), not at request time.
let _lastRegisteredApp: WeakRef<object> | null = null;

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
  warnIfWeakHmacSecret(secretKey, algorithms);

  return function jwtPlugin(app) {
    const resolved: ResolvedJWTConfig = { secretKey, algorithms };
    _appConfigs.set(app, resolved);
    _lastRegisteredApp = new WeakRef(app);

    // Decorate every request handled by THIS app with its own JWT config. A no-arg
    // createJWTGuard() then resolves the config from the request at request time —
    // so the guard is always bound to the app actually handling the request,
    // regardless of plugin-registration vs guard-creation order. This is what makes
    // multi-app isolation correct (app A's requests carry A's secret, B's carry B's).
    app.decorateRequest(REQUEST_CONFIG_KEY, resolved);

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
    warnIfWeakHmacSecret(secretKey, algorithms);

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

  // No options — resolve the JWT config from the REQUEST at request time. The jwt()
  // plugin decorates each of its app's requests with that app's config (see above), so
  // the guard always uses the secret/algorithms of the app actually handling the request.
  // This is correct regardless of register-vs-createJWTGuard ordering and prevents
  // cross-app secret bleed when multiple CelsianApp instances share a process. We fall
  // back to the most-recently-registered app's config only when the request carries no
  // decoration (e.g. the guard is invoked outside a normal request flow).
  const lazyGuard: HookHandler<void | Response> = async (request: CelsianRequest, reply: CelsianReply) => {
    const fromRequest = (request as Record<string, unknown>)[REQUEST_CONFIG_KEY] as ResolvedJWTConfig | undefined;
    const fallback = _lastRegisteredApp ? _appConfigs.get(_lastRegisteredApp.deref() ?? {}) : undefined;
    const config = fromRequest ?? fallback;

    if (!config) {
      throw new CelsianError(
        "createJWTGuard() called without options, but the JWT plugin has not been registered. " +
          "Either pass { secret } to createJWTGuard() or register the JWT plugin first with app.register(jwt({ secret })).",
      );
    }

    const auth = request.headers.get("authorization");
    if (!auth?.startsWith("Bearer ")) {
      return reply.status(401).json({ error: "Missing or invalid authorization header" });
    }

    const token = auth.slice(7);

    try {
      const { payload } = await jose.jwtVerify(token, config.secretKey, {
        algorithms: config.algorithms,
      });
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
