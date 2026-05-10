# @celsian/compress

Response compression plugin for CelsianJS. Supports Brotli (via `node:zlib`), gzip, and deflate (via Web Standard `CompressionStream`).

Brotli is preferred by default when the client accepts it, providing ~15-25% better compression ratios than gzip for text content.

## Install

```bash
npm install @celsian/compress
```

## Usage

```typescript
import { compress } from '@celsian/compress';

// Default: Brotli > gzip > deflate, threshold 1024 bytes
await app.register(compress());

// Custom quality and threshold
await app.register(compress({
  threshold: 512,
  brotliQuality: 6,   // 0-11 (default: 4)
  gzipLevel: 9,       // 1-9 (default: 6)
}));

// Disable Brotli (gzip/deflate only)
await app.register(compress({
  encodings: ['gzip', 'deflate'],
}));
```

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `threshold` | `number` | `1024` | Minimum response size in bytes to trigger compression |
| `encodings` | `CompressionEncoding[]` | `["br", "gzip", "deflate"]` | Allowed encodings in preference order |
| `brotliQuality` | `number` | `4` | Brotli quality level (0-11) |
| `gzipLevel` | `number` | `6` | Gzip compression level (1-9) |

## Documentation

See the [main repository](https://github.com/CelsianJs/celsian) for full docs, examples, and API reference.

## License

MIT
