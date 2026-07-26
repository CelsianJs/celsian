# @celsian/cache

KV store, response caching, and session management for CelsianJS.

## Install

```bash
npm install @celsian/cache
```

## Usage

Use **separate stores** for sessions and the response cache:

```typescript
import { MemoryKVStore, createResponseCache, createSessionManager } from '@celsian/cache';

const cacheStore = new MemoryKVStore({ maxEntries: 10_000 });
const sessionStore = new MemoryKVStore({ maxEntries: 50_000 });

const cache = createResponseCache({ store: cacheStore, ttlMs: 60_000 });
const sessions = createSessionManager({ store: sessionStore });
```

> **Do not share one store between sessions and the response cache.** They
> compete for the same LRU budget, so ordinary cache churn evicts live sessions
> and logs users out. Give each its own store with its own `maxEntries`.

## Response cache

### What is in the key

The default key is `${method}:${host}:${pathname}${normalizedQuery}`.

- **Host** is part of the key. One process serving several domains shares a
  store, so keying on the path alone served one tenant's body to another.
- **Query parameters are sorted**, so `?a=1&b=2` and `?b=2&a=1` share one entry.
- **`Origin`** is partitioned eagerly, so a `Vary: Origin` response cannot
  replay one origin's body or CORS headers to another.
- **Host-rewriting headers** are partitioned eagerly too: `X-Forwarded-Host`,
  `X-Forwarded-Proto`, `X-Forwarded-Server`, `X-Host`, `X-Original-URL`,
  `X-Rewrite-URL`.

### Unkeyed request headers are the poisoning surface

> **Any request header your handler reflects into a response MUST be listed in
> `varyHeaders`.** Otherwise it is an unkeyed input: one unauthenticated request
> can plant an attacker-chosen value in a response that is then served to every
> anonymous visitor for the whole TTL. This is the canonical web-cache-poisoning
> attack, and the eagerly-partitioned list above is not exhaustive.

> **A shared cache is unsafe in front of a handler that personalizes on an
> unkeyed header.** A response personalized on `X-Forwarded-For`, for example,
> is stored and replayed to a different IP. That is correct shared-cache
> semantics, not a bug — do not put such a handler behind this cache.

```typescript
const cache = createResponseCache({
  store,
  varyHeaders: ['accept-language', 'x-country'],
});
```

The cache will not store a response unless every field in its `Vary` is
represented in the key. Configured fields are merged with the handler's `Vary`.

### Cache-busting floods

Query strings enter the key verbatim, so an unauthenticated `?cachebust=N`
flood mints unlimited keys and LRU-evicts the entries you wanted cached.
Restrict the key to the parameters your handler actually reads:

```typescript
const cache = createResponseCache({ store, queryParams: ['page', 'sort'] });
```

`maxKeyLength` (default 512) bounds each individual key; a longer key bypasses
the cache entirely rather than being stored.

### Credentials and privacy

Requests carrying `Authorization`, `Cookie`, or `Proxy-Authorization` bypass
cache reads and writes. Responses marked `private`, `no-store`, `no-cache`,
`max-age=0`, `s-maxage=0`, `Vary: *`, or carrying `Set-Cookie` are never stored.
Request `Cache-Control: no-cache` or `max-age=0` bypasses an existing entry,
because this cache performs no validator revalidation.

Add non-standard authentication headers with `credentialHeaders`:

```typescript
const cache = createResponseCache({ store, credentialHeaders: ['x-api-key'] });
```

Authenticated responses are intentionally not supported by this shared cache,
even with a custom key generator.

### Stampede protection

Concurrent requests for the same cold key execute the origin **once**; the rest
wait and are served the stored entry. If the result turns out not to be
storable (e.g. `Cache-Control: private`), the waiters execute the handler
themselves rather than being served a response that was never eligible for
sharing. A `Cache-Control: no-cache` request never waits on another request's
in-flight execution.

## Sessions

A session is persisted **only once it holds data**. Creating a session (or
`fromRequest` on a cookie-less request) writes nothing, so a crawler cannot fill
the store with empty 24h entries and evict every logged-in user. Call `save()`
after putting something in the session; `save()` on an emptied session removes
the entry.

```typescript
app.post('/login', async (req, reply) => {
  const session = await sessions.create();
  session.set('user', { id: 1 });
  await session.save();
  return reply.header('set-cookie', sessions.cookie(session.id)).json({ ok: true });
});
```

Session ids come from `crypto.getRandomValues` (192 bits). A custom
`generateId` is percent-encoded into the cookie when it contains characters
outside the RFC 6265 cookie-octet set, and decoded on read, so it round-trips.

## KV store

`MemoryKVStore` is single-process. `maxEntries` (default 10 000) bounds it with
LRU eviction; reads and writes both count as use. `incr`/`decr` perform the
whole read-modify-write synchronously, so concurrent increments cannot lose
updates — a distributed implementation must use a native atomic primitive
(Redis `INCRBY`), never a GET followed by a SET.

## Documentation

See the [main repository](https://github.com/CelsianJs/celsian) for full docs, examples, and API reference.

## License

MIT
