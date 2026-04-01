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

## Documentation

See the [main repository](https://github.com/CelsianJs/celsian) for full docs, examples, and API reference.

## License

MIT
