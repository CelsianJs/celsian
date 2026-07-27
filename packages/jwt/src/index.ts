// @celsian/jwt, JWT authentication plugin

import {
  CelsianError,
  type CelsianReply,
  type CelsianRequest,
  type HookHandler,
  type PluginFunction,
} from "@celsian/core";
import * as jose from "jose";

/**
 * Request key for the per-app realm registry.
 *
 * Decorated with `scope: "app"` so it reaches EVERY request on the app, and the
 * unbound guard can enumerate the realms this app runs. The registry lives on
 * the app root (not in a module global) so separate `CelsianApp` instances in
 * one process cannot contaminate each other.
 */
const REQUEST_REGISTRY_KEY = Symbol("@celsian/jwt/realm-registry");

/**
 * One registered realm.
 *
 * `presenceKey` is decorated at the realm's own PLUGIN scope, so core's
 * context-chain resolution attaches it to exactly the requests whose matched
 * route lies inside that realm's encapsulation scope. Counting how many
 * presence keys are on a request is what tells "this route belongs to one
 * realm" apart from "this route sits inside several at once".
 *
 * A single shared key cannot answer that question: a Map holds one value per
 * key, so two realms in the same scope silently collapse into whichever
 * registered last. That collapse WAS the bypass, an un-prefixed realm creates a
 * transparent context whose decorations propagate into the parent scope, so
 * tenant B's config overwrote tenant A's on every route in that scope.
 */
interface RealmEntry {
  readonly presenceKey: symbol;
  readonly config: ResolvedJWTConfig;
  readonly instance: JWTNamespace;
}

/** Mutable per-app record of every registered JWT realm. */
interface RealmRegistry {
  /** In registration order. */
  readonly realms: RealmEntry[];
  /** The one object decorated as `app.jwt`, shared by every realm on this app. */
  readonly namespace: JWTNamespace;
}

/** Default lifetime applied by `sign()` when no `expiresIn` is given. */
const DEFAULT_EXPIRES_IN = "15m";

/** Options for the JWT plugin. */
export interface JWTOptions {
  /** HMAC shared secret (HS256/HS384/HS512). Mutually exclusive with `publicKey`/`jwksUri`. */
  secret?: string;
  /**
   * Public key for asymmetric verification (RS*, PS*, ES*, EdDSA), as a PEM
   * SPKI string or a JWK object. Verification only unless `privateKey` is set.
   */
  publicKey?: string | jose.JWK;
  /** Private key for asymmetric signing, as a PEM PKCS#8 string or a JWK object. */
  privateKey?: string | jose.JWK;
  /**
   * HTTPS URL of a JWKS endpoint (Auth0, Clerk, Cognito, ...). The key set is
   * cached, rotated, and selected by the token's `kid` header. Must be `https:`.
   */
  jwksUri?: string;
  /** Tuning for the remote JWKS fetch. */
  jwks?: JWKSOptions;
  /** Allowed signature algorithms. Always pinned on every verify. */
  algorithms?: string[];
  /** Required `iss` claim. Set on tokens produced by `sign()`. */
  issuer?: string | string[];
  /** Required `aud` claim. Set on tokens produced by `sign()`. */
  audience?: string | string[];
  /** Required `sub` claim. */
  subject?: string;
  /** Clock skew tolerance, e.g. `'30s'` or seconds as a number. Default: none. */
  clockTolerance?: string | number;
  /** Maximum age since `iat`, e.g. `'1h'`. */
  maxTokenAge?: string | number;
  /**
   * Reject tokens that carry no `exp` claim. Default: `true`. A token without
   * `exp` is a permanent bearer credential and this package has no revocation
   * mechanism, so it fails closed unless you opt out explicitly.
   */
  requireExpiration?: boolean;
  /**
   * Default lifetime applied by `sign()` when the call site does not pass one.
   * Default: `'15m'`. Pass `false` to mint non-expiring tokens, which also
   * requires `requireExpiration: false`.
   */
  expiresIn?: string | number | false;
}

/** Tuning for remote JWKS fetching. */
export interface JWKSOptions {
  /** Minimum time between refetches after a `kid` miss, in ms. Default: 30_000. */
  cooldownDurationMs?: number;
  /** Maximum age of the cached key set before a background refresh, in ms. Default: 600_000. */
  cacheMaxAgeMs?: number;
  /** Fetch timeout in ms. Default: 5_000. */
  timeoutMs?: number;
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

/** Key material accepted by `jose.jwtVerify` (a static key or a JWKS resolver function). */
type VerifyKey = Uint8Array | CryptoKey | jose.JWK | jose.JWTVerifyGetKey;
type SignKey = Parameters<jose.SignJWT["sign"]>[0];

/** Resolved per-realm JWT config. */
interface ResolvedJWTConfig {
  getVerifyKey(): Promise<VerifyKey>;
  getSignKey(): Promise<SignKey>;
  algorithms: string[];
  verifyOptions: jose.JWTVerifyOptions;
  requireExpiration: boolean;
  defaultExpiresIn: string | number | false;
  issuer?: string | string[];
  audience?: string | string[];
}

/** Minimum recommended HMAC secret length in bytes (RFC 7518 §3.2: HS256 keys must be >= 256 bits). */
const MIN_HMAC_SECRET_BYTES = 32;

const DEFAULT_JWKS_COOLDOWN_MS = 30_000;
const DEFAULT_JWKS_CACHE_MAX_AGE_MS = 600_000;
const DEFAULT_JWKS_TIMEOUT_MS = 5_000;

/**
 * Warn (without throwing, non-breaking) when an HS* secret is shorter than
 * 32 bytes. Short HMAC secrets can be brute-forced offline from any captured
 * token. Deliberately uses console.warn rather than the app logger: the
 * default Celsian logger is a silent no-op, and a security warning must not
 * be swallowed.
 */
function warnIfWeakHmacSecret(secretKey: Uint8Array, algorithms: string[]): void {
  if (secretKey.byteLength < MIN_HMAC_SECRET_BYTES && algorithms.some((alg) => alg.startsWith("HS"))) {
    console.warn(
      `[@celsian/jwt] The configured HS* secret is only ${secretKey.byteLength} bytes. ` +
        `HMAC secrets should be at least ${MIN_HMAC_SECRET_BYTES} bytes (256 bits) of random data, ` +
        "short secrets can be brute-forced offline from a captured token. Generate one with: " +
        `node -e "console.log(crypto.randomBytes(${MIN_HMAC_SECRET_BYTES}).toString('hex'))"`,
    );
  }
}

/** Memoize an async factory so key import / JWKS set creation happens at most once. */
function once<T>(factory: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined;
  return () => {
    promise ??= factory();
    return promise;
  };
}

/**
 * Build the remote JWKS resolver.
 *
 * The URL is restricted to `https:` so a misconfigured or attacker-influenced
 * value cannot be used to reach plaintext internal endpoints. `jose` handles
 * `kid` selection, caching, and rotation; we only bound the fetch and refresh
 * behaviour so a slow or flapping IdP cannot hang request handling.
 */
function createJWKSResolver(jwksUri: string, options: JWKSOptions | undefined): () => Promise<VerifyKey> {
  let url: URL;
  try {
    url = new URL(jwksUri);
  } catch {
    throw new CelsianError(`[@celsian/jwt] \`jwksUri\` is not a valid URL: ${jwksUri}`);
  }
  if (url.protocol !== "https:") {
    throw new CelsianError(
      `[@celsian/jwt] \`jwksUri\` must use https: (got ${url.protocol}). ` +
        "Fetching signing keys over plaintext would let a network attacker choose the key that validates tokens.",
    );
  }

  return once(async () =>
    jose.createRemoteJWKSet(url, {
      cooldownDuration: options?.cooldownDurationMs ?? DEFAULT_JWKS_COOLDOWN_MS,
      cacheMaxAge: options?.cacheMaxAgeMs ?? DEFAULT_JWKS_CACHE_MAX_AGE_MS,
      timeoutDuration: options?.timeoutMs ?? DEFAULT_JWKS_TIMEOUT_MS,
    }),
  );
}

/** Default algorithm set inferred from the configured key material. */
function defaultAlgorithms(options: JWTOptions): string[] {
  if (options.secret !== undefined) return ["HS256"];
  return ["RS256"];
}

function isPem(key: string | jose.JWK): key is string {
  return typeof key === "string";
}

/**
 * Resolve user options into the config every verify/sign path shares. Throws at
 * registration time on a configuration that could not verify anything, so a
 * misconfigured realm fails loudly instead of at the first request.
 */
function resolveConfig(options: JWTOptions): ResolvedJWTConfig {
  const sources = [options.secret !== undefined, options.publicKey !== undefined, options.jwksUri !== undefined].filter(
    Boolean,
  ).length;

  if (sources === 0) {
    throw new CelsianError(
      "[@celsian/jwt] No key material configured. Pass exactly one of `secret` (HMAC), " +
        "`publicKey` (asymmetric), or `jwksUri` (remote JWKS).",
    );
  }
  if (sources > 1) {
    throw new CelsianError(
      "[@celsian/jwt] `secret`, `publicKey`, and `jwksUri` are mutually exclusive, configure exactly one.",
    );
  }

  const algorithms = options.algorithms ?? defaultAlgorithms(options);
  if (!Array.isArray(algorithms) || algorithms.length === 0) {
    throw new CelsianError(
      "[@celsian/jwt] `algorithms` must be a non-empty array. Never leave the algorithm unpinned.",
    );
  }

  const requireExpiration = options.requireExpiration ?? true;
  const defaultExpiresIn = options.expiresIn ?? DEFAULT_EXPIRES_IN;
  if (defaultExpiresIn === false && requireExpiration) {
    throw new CelsianError(
      "[@celsian/jwt] `expiresIn: false` mints non-expiring tokens that this realm would then reject. " +
        "Set `requireExpiration: false` as well if you really want permanent bearer credentials.",
    );
  }

  let getVerifyKey: () => Promise<VerifyKey>;
  let getSignKey: () => Promise<SignKey>;

  if (options.secret !== undefined) {
    const secretKey = new TextEncoder().encode(options.secret);
    warnIfWeakHmacSecret(secretKey, algorithms);
    getVerifyKey = () => Promise.resolve(secretKey as VerifyKey);
    getSignKey = () => Promise.resolve(secretKey as SignKey);
  } else if (options.publicKey !== undefined) {
    const publicKey = options.publicKey;
    const alg = algorithms[0]!;
    getVerifyKey = once(async () =>
      isPem(publicKey)
        ? ((await jose.importSPKI(publicKey, alg)) as VerifyKey)
        : ((await jose.importJWK(publicKey, alg)) as VerifyKey),
    );
    getSignKey = signKeyFromPrivate(options.privateKey, alg, "publicKey");
  } else {
    getVerifyKey = createJWKSResolver(options.jwksUri!, options.jwks);
    getSignKey = signKeyFromPrivate(options.privateKey, algorithms[0]!, "jwksUri");
  }

  const verifyOptions: jose.JWTVerifyOptions = { algorithms };
  if (options.issuer !== undefined) verifyOptions.issuer = options.issuer;
  if (options.audience !== undefined) verifyOptions.audience = options.audience;
  if (options.subject !== undefined) verifyOptions.subject = options.subject;
  if (options.clockTolerance !== undefined) verifyOptions.clockTolerance = options.clockTolerance;
  if (options.maxTokenAge !== undefined) verifyOptions.maxTokenAge = options.maxTokenAge;

  return {
    getVerifyKey,
    getSignKey,
    algorithms,
    verifyOptions,
    requireExpiration,
    defaultExpiresIn,
    issuer: options.issuer,
    audience: options.audience,
  };
}

function signKeyFromPrivate(
  privateKey: string | jose.JWK | undefined,
  alg: string,
  mode: "publicKey" | "jwksUri",
): () => Promise<SignKey> {
  if (privateKey === undefined) {
    return () =>
      Promise.reject(
        new CelsianError(
          `[@celsian/jwt] This realm is configured with \`${mode}\` only and cannot sign. ` +
            "Pass `privateKey` (PEM PKCS#8 or JWK) to enable `sign()`.",
        ),
      );
  }
  return once(async () =>
    isPem(privateKey)
      ? ((await jose.importPKCS8(privateKey, alg)) as SignKey)
      : ((await jose.importJWK(privateKey, alg)) as SignKey),
  );
}

/**
 * Verify a token against a resolved realm. Every path in this package funnels
 * through here so algorithms stay pinned and issuer/audience/expiry policy is
 * applied identically wherever verification happens.
 */
async function verifyWithConfig(config: ResolvedJWTConfig, token: string): Promise<JWTPayload> {
  const key = await config.getVerifyKey();
  // `key` is a static key or a JWKS resolver function; jose accepts both.
  const { payload } = await jose.jwtVerify(token, key as never, config.verifyOptions);

  if (config.requireExpiration && typeof payload.exp !== "number") {
    throw new CelsianError(
      "[@celsian/jwt] Token has no `exp` claim. A token without an expiry is a permanent bearer " +
        "credential and this realm requires expiration (set `requireExpiration: false` to allow it).",
    );
  }

  return payload as JWTPayload;
}

/** Apply the realm's expiry / issuer / audience policy when minting a token. */
async function signWithConfig(
  config: ResolvedJWTConfig,
  payload: JWTPayload,
  signOptions?: { expiresIn?: string | number | false },
): Promise<string> {
  let builder = new jose.SignJWT(payload as jose.JWTPayload)
    .setProtectedHeader({ alg: config.algorithms[0]! })
    .setIssuedAt();

  if (config.issuer !== undefined && payload.iss === undefined) {
    builder = builder.setIssuer(Array.isArray(config.issuer) ? config.issuer[0]! : config.issuer);
  }
  if (config.audience !== undefined && payload.aud === undefined) {
    builder = builder.setAudience(config.audience);
  }

  const expiresIn = signOptions?.expiresIn ?? config.defaultExpiresIn;
  if (expiresIn !== false) {
    builder =
      typeof expiresIn === "number"
        ? builder.setExpirationTime(Math.floor(Date.now() / 1000) + expiresIn)
        : builder.setExpirationTime(expiresIn);
  }

  return builder.sign(await config.getSignKey());
}

/** Sign and verify methods exposed on `app.jwt` after registering the plugin. */
export interface JWTNamespace {
  sign(payload: JWTPayload, options?: { expiresIn?: string | number | false }): Promise<string>;
  verify(token: string): Promise<JWTPayload>;
}

/**
 * The shared `app.jwt` namespace for one app.
 *
 * `app.jwt` is a single app-wide property, but core hoists decorations
 * first-writer-wins, so with several realms it silently bound to realm #1 for
 * the whole app: tenant B's login route called the documented `app.jwt.sign()`
 * and got back a credential signed with TENANT A's secret. There is no correct
 * answer to "which realm is `app.jwt`" once a second realm registers, so it
 * stops answering and says how to ask unambiguously.
 *
 * Every realm on the app decorates this SAME object, so the hoisted value is
 * the same one no matter which realm registered first.
 */
function createSharedNamespace(getRegistry: () => RealmRegistry): JWTNamespace {
  const soleRealm = (method: "sign" | "verify"): RealmEntry => {
    const { realms } = getRegistry();
    if (realms.length === 1) return realms[0]!;
    throw new CelsianError(
      `[@celsian/jwt] app.jwt.${method}() is ambiguous: this app has ${realms.length} JWT realms registered ` +
        "and app.jwt is a single app-wide property, so it cannot know which realm's key material you mean. " +
        "Signing here would mint one tenant's credential with another tenant's secret. Go through the realm " +
        "itself instead: keep the handle returned by jwt({ secret }) and call realm.sign() / realm.verify() " +
        "on it, which is always bound to that realm's key material.",
    );
  };

  return {
    async sign(payload, signOptions) {
      return soleRealm("sign").instance.sign(payload, signOptions);
    },
    async verify(token) {
      return soleRealm("verify").instance.verify(token);
    },
  };
}

/**
 * Fetch this app's realm registry, creating it on the first realm to register.
 *
 * The registry is stored as an app-scoped request decoration purely because
 * that is the only per-app storage a plugin can reach: `getRequestDecoration`
 * reads back what a previous registration wrote on the same app root.
 */
function getOrCreateRegistry(app: Parameters<PluginFunction>[0]): RealmRegistry {
  const existing = app.getRequestDecoration(REQUEST_REGISTRY_KEY, { scope: "app" }) as RealmRegistry | undefined;
  if (existing) return existing;

  const realms: RealmEntry[] = [];
  const registry: RealmRegistry = {
    realms,
    // Resolved lazily: the namespace must see realms added AFTER it was built.
    namespace: createSharedNamespace(() => registry),
  };
  app.decorateRequest(REQUEST_REGISTRY_KEY, registry, { scope: "app" });
  return registry;
}

/**
 * A registered JWT realm: a plugin function that also exposes a guard bound to
 * this exact realm. Use `.guard()` whenever an app runs more than one realm,
 * it never depends on ambient request state, so it cannot resolve to a
 * neighbouring realm's key material.
 */
export interface JWTPlugin extends PluginFunction {
  /** Guard bound to THIS realm's key material and claim policy. */
  guard(): HookHandler;
  /** Sign a token with this realm's key material (usable before registration). */
  sign(payload: JWTPayload, options?: { expiresIn?: string | number | false }): Promise<string>;
  /** Verify a token against this realm. */
  verify(token: string): Promise<JWTPayload>;
}

/**
 * JWT authentication plugin. Decorates `app.jwt` with `sign()` and `verify()`.
 *
 * With a SECOND realm on the same app, `app.jwt` becomes ambiguous (it is one
 * app-wide property) and starts rejecting: sign and verify through the realm
 * handle instead. Give each realm a prefix as well, an un-prefixed realm is
 * app-wide and two of them cover the same routes, which no ambient guard can
 * resolve.
 *
 * @example
 * ```ts
 * // Single realm
 * await app.register(jwt({ secret: process.env.JWT_SECRET! }));
 * const token = await app.jwt.sign({ sub: userId });
 * app.addHook('preHandler', createJWTGuard());
 *
 * // Multiple realms on one app: one prefix each, and a guard bound to its realm
 * const tenantA = jwt({ secret: process.env.TENANT_A_SECRET!, issuer: 'tenant-a' });
 * await app.register(tenantA, { prefix: '/tenant-a' });
 * app.addHook('preHandler', tenantA.guard());
 * const token = await tenantA.sign({ sub: userId });  // NOT app.jwt.sign()
 * ```
 */
export function jwt(options: JWTOptions): JWTPlugin {
  const config = resolveConfig(options);

  const jwtInstance: JWTNamespace = {
    sign(payload, signOptions) {
      return signWithConfig(config, payload, signOptions);
    },
    verify(token) {
      return verifyWithConfig(config, token);
    },
  };

  function jwtPlugin(app: Parameters<PluginFunction>[0]): void {
    const registry = getOrCreateRegistry(app);
    const entry: RealmEntry = {
      presenceKey: Symbol(`@celsian/jwt/realm#${registry.realms.length + 1}`),
      config,
      instance: jwtInstance,
    };
    registry.realms.push(entry);

    // Plugin scope, NOT `scope: "app"`: core resolves this through the matched
    // route's context chain, so the key is present exactly on the requests
    // whose route lies inside this realm's scope. One key per realm, so two
    // realms covering the same route are both visible instead of one silently
    // overwriting the other.
    app.decorateRequest(entry.presenceKey, entry);

    // The same shared namespace object for every realm on this app, so the
    // first-writer-wins hoist onto `app.jwt` cannot bind the app to realm #1.
    app.decorate("jwt", registry.namespace);
  }

  return Object.assign(jwtPlugin as PluginFunction, {
    guard: () => createGuardForConfig(() => config),
    sign: jwtInstance.sign,
    verify: jwtInstance.verify,
  });
}

/**
 * Shared guard body. `resolve` returns the realm config for this request, or
 * throws when none can be determined, the guard never falls back to "some"
 * realm, because guessing is how one tenant's token authenticates another's.
 */
function createGuardForConfig(resolve: (request: CelsianRequest) => ResolvedJWTConfig): HookHandler {
  const guard: HookHandler<void | Response> = async (request: CelsianRequest, reply: CelsianReply) => {
    const config = resolve(request);

    const auth = request.headers.get("authorization");
    if (!auth?.startsWith("Bearer ")) {
      return reply.status(401).json({ error: "Missing or invalid authorization header" });
    }

    const token = auth.slice(7);

    try {
      (request as Record<string, unknown>).user = await verifyWithConfig(config, token);
    } catch {
      return reply.status(401).json({ error: "Invalid or expired token" });
    }
  };

  return guard as HookHandler;
}

/**
 * Create a preHandler hook that verifies Bearer tokens and populates `request.user`.
 *
 * When called without arguments, the realm is resolved from the request at
 * request time: the realm whose scope covers the matched route. It THROWS
 * rather than guessing whenever that answer is not exactly one realm, either
 * because the route lies inside SEVERAL realms (what two un-prefixed realms
 * produce, since an un-prefixed plugin is app-wide) or because it lies inside
 * NONE while the app runs more than one. Pass an explicit `{ secret }` here, or
 * use the realm-bound `jwt(...).guard()`, for those routes.
 *
 * A single-realm app is never ambiguous and resolves everywhere, inside that
 * realm's scope or outside it.
 *
 * @example
 * ```ts
 * // Option 1: No args, single-realm apps
 * await app.register(jwt({ secret: process.env.JWT_SECRET! }));
 * app.addHook('preHandler', createJWTGuard());
 *
 * // Option 2: Explicit config, required when several realms share one app
 * app.addHook('preHandler', createJWTGuard({ secret: process.env.JWT_SECRET!, issuer: 'api' }));
 * ```
 */
export function createJWTGuard(options?: JWTOptions): HookHandler {
  if (options) {
    const config = resolveConfig(options);
    return createGuardForConfig(() => config);
  }

  // No options: resolve the realm from the REQUEST. The realms whose presence
  // key reached this request are exactly the realms whose scope covers the
  // matched route. Exactly one is an answer, more than one is a guess, and a
  // guess is how one tenant's token authenticates another's. There is
  // deliberately no module-global fallback: an undecorated request must fail
  // closed rather than inherit another app's secret.
  return createGuardForConfig((request) => {
    const bag = request as unknown as Record<PropertyKey, unknown>;
    const registry = bag[REQUEST_REGISTRY_KEY] as RealmRegistry | undefined;

    if (!registry || registry.realms.length === 0) {
      throw new CelsianError(
        "createJWTGuard() called without options, but the JWT plugin has not been registered. " +
          "Either pass { secret } to createJWTGuard() or register the JWT plugin first with app.register(jwt({ secret })).",
      );
    }

    const inScope = registry.realms.filter((realm) => bag[realm.presenceKey] !== undefined);

    if (inScope.length === 1) return inScope[0]!.config;

    // The route lies inside several realms at once. This is what an un-prefixed
    // realm produces: it registers a transparent context, so its decorations
    // and hooks apply to the whole surrounding scope, and a second one lands on
    // the very same routes. Picking either would authenticate one tenant on the
    // other's route.
    if (inScope.length > 1) {
      throw new CelsianError(
        `createJWTGuard() was called without options on a route that lies inside ${inScope.length} JWT realms ` +
          `at once (this app has ${registry.realms.length} JWT realms registered). Refusing to guess which one ` +
          "applies, since picking one would authenticate one realm's token on another realm's route. " +
          "Bind the guard explicitly: use the realm-bound jwt(...).guard(), or pass the realm's config as " +
          "createJWTGuard({ secret }). A realm registered without a prefix is app-wide, so to give each realm " +
          "its own routes, register it under a prefix: app.register(realm, { prefix: '/tenant-a' }).",
      );
    }

    // No realm covers this route. With exactly one realm on the app that is
    // still unambiguous, so the single-realm convenience keeps working.
    if (registry.realms.length === 1) return registry.realms[0]!.config;

    throw new CelsianError(
      `createJWTGuard() was called without options on a route that is outside every JWT realm's scope, ` +
        `but this app has ${registry.realms.length} JWT realms registered. Refusing to guess which one applies. ` +
        "Bind the guard explicitly: use the realm-bound jwt(...).guard(), or pass the realm's config as " +
        "createJWTGuard({ secret }). To guard a route inside a realm, register that realm on the same " +
        "prefix/scope as the route.",
    );
  });
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
