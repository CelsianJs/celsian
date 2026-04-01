# @celsian/rate-limit

Sliding-window rate limiter plugin for CelsianJS with pluggable store.

## Install

```bash
npm install @celsian/rate-limit
```

## Usage

```typescript
import { rateLimit } from '@celsian/rate-limit';

await app.register(rateLimit({ max: 100, window: 60_000, trustProxy: true }));
```

## Documentation

See the [main repository](https://github.com/CelsianJs/celsian) for full docs, examples, and API reference.

## License

MIT
