# @celsian/jwt

JWT authentication plugin for CelsianJS. Sign and verify tokens, plus a route guard hook.
Supports HMAC secrets, asymmetric key pairs, and remote JWKS endpoints.

## Install

```bash
npm install @celsian/jwt
```

## Usage

```typescript
import { jwt, createJWTGuard } from '@celsian/jwt';

await app.register(jwt({
  secret: process.env.JWT_SECRET!,
  issuer: 'https://api.example.com',
  audience: 'api',
}));

const token = await app.jwt.sign({ sub: 'user-1' });   // expires in 15m by default
const payload = await app.jwt.verify(token);

app.addHook('preHandler', createJWTGuard());
```

## Claim verification

Verification is not just a signature check. Configure the claims your API
actually requires, otherwise any token signed with the same key authenticates,
including one minted by a different service that happens to share the secret
(a monolith split or a prod/staging pair reusing one `JWT_SECRET`).

| Option | Effect |
| --- | --- |
| `issuer` | Required `iss`. Also set on tokens produced by `sign()`. |
| `audience` | Required `aud`. Also set on tokens produced by `sign()`. |
| `subject` | Required `sub`. |
| `clockTolerance` | Skew allowance, e.g. `'30s'`. |
| `maxTokenAge` | Maximum age since `iat`, e.g. `'1h'`. |
| `algorithms` | Allowed signature algorithms. Always pinned; never inferred from the token header. |

## Expiration

`sign()` applies a **15 minute** default expiry, and verification **rejects a
token with no `exp` claim**. A token without an expiry is a permanent bearer
credential and this package has no revocation mechanism.

To mint a non-expiring token you must opt out of both halves explicitly:

```typescript
jwt({ secret, expiresIn: false, requireExpiration: false });
```

Configuring only `expiresIn: false` throws, because that realm would mint tokens
it would then reject.

## Multiple realms on one app

**A no-argument `createJWTGuard()` is only unambiguous while an app runs a single
realm.** With two or more realms (multi-tenant auth, a public API alongside an
admin API), bind each guard to its realm explicitly. `jwt()` returns the plugin
with a `.guard()` bound to that realm's key material:

```typescript
const tenantA = jwt({ secret: process.env.TENANT_A_SECRET!, issuer: 'tenant-a' });
const tenantB = jwt({ secret: process.env.TENANT_B_SECRET!, issuer: 'tenant-b' });

await app.register(async (t) => {
  await t.register(tenantA, { encapsulate: false });
  t.addHook('preHandler', tenantA.guard());          // bound to tenant A
  t.get('/me', handler);
}, { prefix: '/tenant-a' });

await app.register(async (t) => {
  await t.register(tenantB, { encapsulate: false });
  t.addHook('preHandler', tenantB.guard());          // bound to tenant B
  t.get('/me', handler);
}, { prefix: '/tenant-b' });
```

Passing an explicit config works too: `createJWTGuard({ secret: TENANT_A_SECRET })`.

A no-argument guard resolves the realm from the request and there is no
process-global fallback, so an undecorated request fails closed rather than
inheriting another app's secret.

Note the `prefix` on each registration. **A realm registered without a prefix is
app-wide**, because Celsian treats an un-prefixed plugin as transparent: its
hooks and request decorations apply to the whole surrounding scope, siblings
included. Two un-prefixed realms therefore both cover every route in that scope,
and no ambient guard can tell them apart.

### The ambient guard fails closed with two or more realms

A no-argument guard resolves the realm from the matched route: it uses the realm
whose scope covers the route, which is why the prefixed pattern above keeps
working. It refuses, at request time, in the two cases where that answer is a
guess.

**Case 1, the route lies inside several realms at once.** This is what
un-prefixed realms produce:

```typescript
await app.register(tenantA);                       // no prefix: app-wide
await app.register(tenantB);                       // no prefix: app-wide

// Throws: /a lies inside BOTH realms. Before this fix it authenticated against
// whichever realm registered LAST, so tenant B's token was accepted here and
// tenant A's own users were rejected.
app.get('/a', { preHandler: createJWTGuard() }, handler);
```

**Case 2, the route lies inside no realm at all.**

```typescript
await app.register(tenantA, { prefix: '/tenant-a' });
await app.register(tenantB, { prefix: '/tenant-b' });

// Throws: this route belongs to no realm and there are two to choose from.
app.get('/root', { preHandler: createJWTGuard() }, handler);
```

Either way, say which realm you mean:

```typescript
app.get('/root', { preHandler: tenantA.guard() }, handler);
app.get('/root', { preHandler: createJWTGuard({ secret: TENANT_A_SECRET }) }, handler);
```

Or give each realm its own prefix so exactly one realm covers each route.

The refusal happens **when the route is served, not when the realm is
registered**: whether an ambiguity exists depends on which routes each realm's
scope ends up covering, and the plugin cannot see that from inside a
registration. It fails closed, so no request is ever authenticated against a
guessed realm, but a misconfiguration surfaces as a 500 on the affected route
rather than at boot.

With exactly one realm registered, the no-argument guard still resolves it
anywhere on the app, inside its scope or outside it.

### `app.jwt` with more than one realm

`app.jwt` is a single app-wide property, and Celsian hoists decorations
first-writer-wins, so with several realms it used to bind to whichever realm
registered FIRST for the entire app. A second tenant's login route calling
`app.jwt.sign()` got back a credential signed with the FIRST tenant's secret.

`app.jwt.sign()` and `app.jwt.verify()` now reject with an actionable error as
soon as a second realm registers. Go through the realm handle instead, which is
always bound to its own key material:

```typescript
const tenantB = jwt({ secret: process.env.TENANT_B_SECRET! });
await app.register(tenantB, { prefix: '/tenant-b' });

await tenantB.sign({ sub: userId });     // correct: tenant B's secret
await tenantB.verify(token);
```

Single-realm apps are unaffected: `app.jwt.sign()` and `app.jwt.verify()` work
exactly as before and use that realm.

## Asymmetric keys

Pass PEM (SPKI / PKCS#8) strings or JWK objects. `publicKey` alone gives a
verify-only realm; `sign()` on it throws.

```typescript
jwt({
  publicKey: process.env.JWT_PUBLIC_KEY!,   // PEM SPKI
  privateKey: process.env.JWT_PRIVATE_KEY!, // PEM PKCS#8
  algorithms: ['RS256'],
});
```

## JWKS (Auth0, Clerk, Cognito, ...)

```typescript
jwt({
  jwksUri: 'https://your-tenant.auth0.com/.well-known/jwks.json',
  algorithms: ['RS256'],
  issuer: 'https://your-tenant.auth0.com/',
  audience: 'https://api.example.com',
  jwks: { cacheMaxAgeMs: 600_000, cooldownDurationMs: 30_000, timeoutMs: 5_000 },
});
```

The key set is cached, refreshed on rotation, and selected by the token's `kid`.
The URL **must** be `https:`, a plaintext or `file:`/other-scheme key source
would let whoever controls that channel choose the key that validates tokens.
The key set is fetched lazily on first verification, not at registration.

## Documentation

See the [main repository](https://github.com/CelsianJs/celsian) for full docs, examples, and API reference.

## License

MIT
