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

## Options

| Option | Default | Description |
| --- | --- | --- |
| `threshold` | `1024` | Minimum response size in **bytes** before compressing. |
| `encodings` | `['gzip', 'deflate']` | Encodings this server will produce, in preference order. |
| `filter` | textual allow-list | `(request, reply, contentType) => boolean`. Return `false` to send uncompressed. |

## What gets compressed

By default only textual content types are compressed: `text/*`,
`application/json`, `application/xml`, `application/javascript`, any `+json` or
`+xml` suffix, and `image/svg+xml`. Images, video, archives, and other
already-compressed payloads are passed through untouched.

Compression is also skipped when the response already carries a
`Content-Encoding`, when the payload is binary (`Uint8Array` / `ArrayBuffer`),
and when the handler returns a raw `Response`.

An explicitly set `Content-Type` is never overwritten.

## BREACH

Compressing a response is not free of risk. **BREACH** recovers a secret from a
compressed response when that response contains BOTH a secret (a CSRF token, an
API key, part of a session identifier) AND attacker-influenced content that is
reflected back, compression ratio then leaks the secret a byte at a time.

Use `filter` to exclude any route whose response mixes a secret with reflected
input:

```typescript
await app.register(compress({
  filter: (request) => !new URL(request.url).pathname.startsWith('/api/csrf'),
}));
```

The safer structural fix is to not return a secret in the same response as
reflected user input.

## Content negotiation

`Accept-Encoding` is parsed as `(coding, q)` pairs per RFC 9110. A `q=0` is an
explicit refusal and is honored, so `Accept-Encoding: gzip;q=0, deflate` never
yields gzip. Among the codings the client accepts, the highest `q` wins; ties
fall back to the server's `encodings` order. `*` is supported.

## Vary

`Vary: Accept-Encoding` is set on **every** response the plugin handles, not
just compressed ones, and it is merged with any `Vary` the handler already set.
Without this a shared cache or CDN can serve a stored uncompressed body to a
gzip client (or the reverse).

## Cookies

Compressed responses preserve every `Set-Cookie`, including repeated ones. The
plugin builds the real response through the reply's own builder and then wraps
it, rather than re-deriving headers, cookies do not live in `reply.headers`, so
re-deriving silently dropped them (a compressed `clearCookie()` logout never
logged anyone out).

## Documentation

See the [main repository](https://github.com/CelsianJs/celsian) for full docs, examples, and API reference.

## License

MIT
