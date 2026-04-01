# @celsian/compress

Response compression plugin for CelsianJS using Web Standard CompressionStream (gzip/deflate).

## Install

```bash
npm install @celsian/compress
```

## Usage

```typescript
import { compress } from '@celsian/compress';

await app.register(compress({ threshold: 1024 }));
```

## Documentation

See the [main repository](https://github.com/CelsianJs/celsian) for full docs, examples, and API reference.

## License

MIT
