# @celsian/cache

KV store, response caching, and session management for CelsianJS.

## Install

```bash
npm install @celsian/cache
```

## Usage

```typescript
import { MemoryKVStore, createResponseCache, createSessionManager } from '@celsian/cache';

const store = new MemoryKVStore();
const cache = createResponseCache({ store, ttlMs: 60_000 });
const sessions = createSessionManager({ store });
```

`createResponseCache()` is a shared response cache. Origin-bearing requests are
partitioned automatically, so a response with `Vary: Origin` cannot replay one
origin's body or CORS headers to another. Requests carrying
`Authorization`, `Cookie`, or `Proxy-Authorization` bypass cache reads and
writes. Responses marked `private`, `no-store`, `no-cache`, `max-age=0`, or
`s-maxage=0`, `Vary: *`, or `Set-Cookie` are also never stored. Request
`Cache-Control: no-cache` or `max-age=0` bypasses an existing entry because this
cache does not perform validator revalidation.
When a handler emits another `Vary` field, list it in `varyHeaders`; the cache
will not store the response unless every `Vary` field is represented in its key.
Configured fields are merged with the handler's existing `Vary` value.
Add non-standard authentication headers such as API keys with
`credentialHeaders`:

```typescript
const cache = createResponseCache({
  store,
  credentialHeaders: ['x-api-key'],
});
```

Authenticated responses are intentionally not supported by this shared cache,
even when a custom key generator is configured.

## Documentation

See the [main repository](https://github.com/CelsianJs/celsian) for full docs, examples, and API reference.

## License

MIT
