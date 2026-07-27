# @celsian/cache

KV store, response caching, and session management for CelsianJS.

## Install

```bash
npm install @celsian/cache
```

## Usage

`createResponseCache()` is not a plugin: it wraps a fetch handler (or a single
route handler), because it has to intercept the whole `Response`. Use
**separate stores** for sessions and the response cache.

```typescript
import { createApp } from 'celsian';
import { MemoryKVStore, createResponseCache, createSessionManager } from '@celsian/cache';

const cacheStore = new MemoryKVStore({ maxEntries: 10_000 });
const sessionStore = new MemoryKVStore({ maxEntries: 50_000 });

const cache = createResponseCache({ store: cacheStore, ttlMs: 60_000 });
const sessions = createSessionManager({ store: sessionStore });

const app = createApp();

// Per route: wrap the work you want cached.
app.get('/products', async (req, reply) =>
  cache.cached(req, async () => reply.json({ products: await listProducts() })),
);

// Or wrap the whole app handler at the adapter boundary INSTEAD.
// const handler = cache.wrap(app.handle.bind(app));

// Purge after a write. A key without a query string purges every query variant.
app.post('/products', async (req, reply) => {
  await createProduct(req.parsedBody);
  await cache.invalidate('GET:/products');
  return reply.json({ ok: true });
});
```

> **Cache at ONE level.** Wrapping the app handler with `wrap()` *and* calling
> `cached()` inside a route means the inner call waits on the outer call's own
> in-flight execution for the same key, and the request hangs until your server
> times it out. Pick the route form or the adapter form.

> **Do not share one store between sessions and the response cache.** They
> compete for the same LRU budget, so ordinary cache churn evicts live sessions
> and logs users out. Give each its own store with its own `maxEntries`.

## Response cache

### What is in the key

The readable part of the key is
`${method}:${scheme}//${host}:${pathname}${normalizedQuery}`, e.g.
`GET:https//app.example:/data`, followed by a SHA-256 digest of that plus every
partitioned header.

- **Scheme and host** are part of the key. One process serving several domains
  shares a store, so keying on the path alone served one tenant's body to
  another, and omitting the scheme let `http://x.app/data` and
  `https://x.app/data` share one entry.
- **The `Host` header is partitioned separately** from the URL authority. On a
  server bound to `0.0.0.0` the URL authority is the BIND address, identical for
  every tenant, so keying on it alone collapsed all domains into one bucket
  again. Both are in the key, so tenants stay separate however the adapter
  builds `request.url`.
- **Query parameters are sorted**, so `?a=1&b=2` and `?b=2&a=1` share one entry.
- **`Origin`** is partitioned eagerly, so a `Vary: Origin` response cannot
  replay one origin's body or CORS headers to another.
- **`Accept-Encoding`** is partitioned eagerly, so a compressed response is
  storable and a gzip body is never served to a client that did not ask for one.
- **Host-rewriting headers** are partitioned eagerly too: `Forwarded`,
  `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Forwarded-Scheme`,
  `X-Forwarded-Port`, `X-Forwarded-Server`, `X-Forwarded-Prefix`,
  `X-Forwarded-Uri`, `X-Forwarded-Ssl`, `X-Host`, `X-Http-Host-Override`,
  `X-Original-Host`, `X-Original-URL`, `X-Original-Uri`, `X-Rewrite-URL`.

Keys are **hashed**, so their stored length is bounded by construction.
`maxKeyLength` (default 512) only decides how much of the readable part is kept
in front of the digest. No request can make its own key too long to be cached,
which used to switch off the cache, and the stampede protection with it.

### Cache poisoning and varyHeaders

> **A denylist of host-rewrite headers cannot be complete, and this one is not.**
> Reverse proxies, CDNs, and frameworks invent new host/scheme override headers
> continually (`X-Forwarded-*`, `X-Original-*`, vendor-specific spellings), and
> the cache cannot know which header your handler reads. The list above closes
> the vectors we know about, it is a mitigation, not a boundary.
>
> **Any request header your handler reflects into a response MUST be listed in
> `varyHeaders`.** That is the only complete defence, because only you know what
> your handler reads. Otherwise the header is an unkeyed input: one
> unauthenticated request can plant an attacker-chosen value (say a
> `<script src>` built from `X-Forwarded-Host`) in a response that is then served
> to every anonymous visitor for the whole TTL. This is the canonical
> web-cache-poisoning attack.
>
> If your handler builds absolute URLs at all, prefer deriving them from
> configuration rather than from request headers. A handler that never reflects a
> request header cannot be poisoned through one.

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

### Credentials and privacy

This is a SHARED cache: one stored response is replayed to everyone whose
request produces the same key. The rule is therefore **fail closed**, following
RFC 9111 section 3.5:

> A request that carries anything that might be a credential is only cached, and
> only served from cache, when the response says `Cache-Control: public` or
> `s-maxage=N` (N > 0).

"Might be a credential" is decided by an ALLOW-list, not a denylist. A request
header that is not a well-known public header (`Accept*`, `User-Agent`,
`Referer`, `Sec-*`, `If-*`, `Range`, `Origin`, `X-Forwarded-For`, ...), not one
of the eagerly-partitioned host headers, and not in your `varyHeaders` or
`publicHeaders`, counts as a possible credential. A denylist of
`authorization`/`cookie`/`proxy-authorization` failed open for `X-API-Key`,
`X-Auth-Token`, `X-Session-Id` and every other auth transport, and a
per-user JSON response typically carries no `Set-Cookie`, no `Vary` and no
`Cache-Control` to catch it downstream, so one user's token was stored and
handed to the next.

```typescript
const cache = createResponseCache({
  store,
  // Definitely credentials, even if they look public.
  credentialHeaders: ['x-api-key'],
  // Definitely NOT credentials: infrastructure noise that should stay cacheable.
  publicHeaders: ['cf-ray', 'x-request-id'],
});
```

If a route is genuinely public, say so on the response and it is cached for
everyone, credentialed or not:

```typescript
reply.header('cache-control', 'public, max-age=300').json(publicData);
```

Responses marked `private`, `no-store`, `no-cache`, `max-age=0`, `s-maxage=0`,
`Pragma: no-cache`, `Vary: *`, an expired or unparseable `Expires`, or carrying
`Set-Cookie`, are never stored.

### Response freshness

The response's own lifetime wins whenever it is shorter than the configured
`ttlMs`: `s-maxage` first, then `max-age`, then `Expires`. A `max-age=1`
response is stored for one second, not for the configured default.

### Compression

`compress()` and `createResponseCache()` compose. Compressed responses carry
`Vary: Accept-Encoding`, which is represented in the key, and bodies are stored
as BYTES, so a gzip (or Brotli, image, font, PDF, protobuf) body round-trips
exactly. There is no need for `varyHeaders: ['accept-encoding']`, it is already
partitioned.

### Stampede protection

Concurrent requests for the same cold key execute the origin **once**; the rest
wait and are served the stored entry. If the result turns out not to be
storable (e.g. `Cache-Control: private`), the waiters execute the handler
themselves rather than being served a response that was never eligible for
sharing.

A client cannot opt out of this. `Cache-Control: no-cache`, `max-age=0`,
`no-store` and `Pragma: no-cache` still bypass the STORED entry (the request is
never served something older than it asked for), but they do not skip the
single flight and do not suppress the write. Honouring them there let one header
turn N concurrent requests into N origin executions, which is precisely the
amplification a shared cache exists to prevent. For request `no-store` this is a
deliberate deviation from RFC 9111 section 5.2.1.5: nothing private can leak
through it, because only a response that already passed the rules above is ever
written.

## Sessions

A session is persisted **only once it holds data**. Creating a session (or
`fromRequest` on a cookie-less request) writes nothing, so a crawler cannot fill
the store with empty 24h entries and evict every logged-in user. Call `save()`
after putting something in the session; `save()` on an emptied session removes
the entry.

### Rotate the id at every privilege boundary

`fromRequest()` never adopts an id the server did not issue, but an attacker can
obtain a real id and plant it in a victim's browser. Unless the id changes when
the victim logs in, the attacker's cookie is a valid handle on the logged-in
session. That is session fixation, and `regenerate()` is the fix:

```typescript
app.post('/login', async (req, reply) => {
  const user = await authenticate(req.parsedBody);
  const session = await sessions.fromRequest(req);

  // Rotate FIRST: the id in the incoming cookie must never survive a login.
  await session.regenerate();

  session.set('user', { id: user.id });
  await session.save();
  return reply.header('set-cookie', sessions.cookie(session.id)).json({ ok: true });
});
```

`regenerate()` rotates **in place**: `session.id` becomes the new id, the old
store entry is deleted, and a later `save()` writes the new id. It also returns
the session, so `const s = await session.regenerate()` reads naturally. Call it
on any privilege change (login, logout, role change, step-up auth).

Session ids come from `crypto.getRandomValues` (192 bits). A custom
`generateId` is percent-encoded into the cookie when it contains characters
outside the RFC 6265 cookie-octet set, and decoded on read, so it round-trips.

## KV store

`MemoryKVStore` is single-process. `maxEntries` (default 10 000) bounds it with
LRU eviction; reads and writes both count as use. `incr`/`decr` perform the
whole read-modify-write synchronously, so concurrent increments cannot lose
updates, a distributed implementation must use a native atomic primitive
(Redis `INCRBY`), never a GET followed by a SET.

`keys(pattern)` accepts globs (`*` within one `:`-delimited segment, `**`
across segments, `?` for one character) and matches without backtracking, so a
user-supplied pattern cannot burn the event loop.

## Documentation

See the [main repository](https://github.com/CelsianJs/celsian) for full docs, examples, and API reference.

## License

MIT
