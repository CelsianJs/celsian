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
