# @celsian/jwt

JWT authentication plugin for CelsianJS. Sign and verify tokens, plus a route guard hook.

## Install

```bash
npm install @celsian/jwt
```

## Usage

```typescript
import { jwt, createJWTGuard } from '@celsian/jwt';

await app.register(jwt({ secret: process.env.JWT_SECRET! }));
const token = await app.jwt.sign({ sub: 'user-1' }, { expiresIn: '1h' });
const payload = await app.jwt.verify(token);
```

`createJWTGuard()` without arguments resolves the JWT secret and allowed
algorithms from the current app's request decoration. Register `jwt()` on every
app that uses a no-argument guard. There is no process-global fallback, so an
undecorated request fails closed instead of inheriting another app's secret.

## Documentation

See the [main repository](https://github.com/CelsianJs/celsian) for full docs, examples, and API reference.

## License

MIT
