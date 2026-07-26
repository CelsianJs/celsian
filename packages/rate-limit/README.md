# @celsian/rate-limit

**Fixed-window** rate limiter plugin for CelsianJS with a pluggable store.

## Install

```bash
npm install @celsian/rate-limit
```

## Usage

Key on something the client cannot forge. An authenticated user id or API-key id
is the only identifier that is genuinely under your control:

```typescript
import { rateLimit } from '@celsian/rate-limit';

await app.register(rateLimit({
  max: 100,
  window: 60_000,
  keyGenerator: (req) => req.user?.sub ?? 'anonymous',
}));
```

Registration **throws** if you provide neither a `keyGenerator` nor a declared
proxy trust boundary, a limiter that cannot identify clients is a limiter that
does nothing, and it fails closed at startup rather than in production.

## Keying on the client IP

An IP is only trustworthy if you can say which part of `X-Forwarded-For` your
own infrastructure appended. Declare it:

```typescript
await app.register(rateLimit({
  max: 100,
  window: 60_000,
  trustedProxies: ['10.0.0.0/8', '172.16.0.0/12'],
}));
```

The client IP is the **rightmost `X-Forwarded-For` entry that is not one of your
proxies**. Everything to the left of that is client-supplied and ignored, so
rotating a forged prefix cannot mint a fresh bucket. IPv4 and IPv6 CIDR blocks
are both supported, as are bare addresses.

If no untrusted entry exists (or the header is absent), all such requests share
one bucket rather than each getting their own.

### `trustProxy` (advanced)

`trustProxy: true` with `trustedProxyHops: N` takes the IP N entries from the
right **without verifying that a proxy appended it**.

> **Deployment warning.** This is correct only when the hop count is fixed and
> every request genuinely traverses your proxies. If a request can reach the app
> directly, a misrouted health check, a leaked origin address, an internal
> caller, the attacker controls the entry at that position and rate limiting is
> bypassed. Prefer `trustedProxies` or a `keyGenerator`.

### `X-Real-IP`

Not consulted unless you set `trustXRealIp: true`. It is a single unhopped value
that the client fully controls unless a proxy overwrites it, so as a silent
fallback it let an attacker both bypass their own limit and burn a victim's
bucket by claiming the victim's IP (a targeted lockout, e.g. on `/login`).

## Fixed window, not sliding

A fixed window resets all at once. A client can therefore send `max` requests at
the end of one window and `max` more immediately at the start of the next, 
**up to 2x `max` across a boundary**. Size the window with that in mind.

## Multi-instance deployments

The default in-memory store is per-process, so N instances multiply the
effective limit by N. Use the Redis store, which increments a shared counter
inside a single Lua script (atomic across instances):

```typescript
import Redis from 'ioredis';
import { rateLimit, createRedisRateLimitStore } from '@celsian/rate-limit';

await app.register(rateLimit({
  max: 100,
  window: 60_000,
  store: createRedisRateLimitStore({ client: new Redis(process.env.REDIS_URL!) }),
  keyGenerator: (req) => req.user?.sub ?? 'anonymous',
}));
```

The client is injected rather than imported so this package keeps zero
third-party runtime dependencies. Any client exposing
`eval(script, numKeys, ...args)` works; an `ioredis` instance satisfies it as-is.

## Memory bounds

| Option | Default | Description |
| --- | --- | --- |
| `maxKeys` | `100_000` | Distinct keys the in-memory store holds before evicting. |
| `maxKeyLength` | `256` | Longer keys collapse into one shared oversized bucket. |

Eviction prefers expired entries, then the **least-established** live entry
(lowest count, tie-broken by soonest reset). Insertion-order eviction was the
bug: a flood is always the newest traffic, so it evicted the very clients being
throttled and reset their counters. The store warns once when the cap is first
hit, that almost always means the limiter is keyed on an attacker-controlled
value.

## Documentation

See the [main repository](https://github.com/CelsianJs/celsian) for full docs, examples, and API reference.

## License

MIT
