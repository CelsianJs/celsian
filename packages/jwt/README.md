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
const requireAuth = createJWTGuard({ secret: process.env.JWT_SECRET! });
const token = await app.jwt.sign({ sub: 'user-1' }, { expiresIn: '1h' });
const payload = await app.jwt.verify(token);
```

## Documentation

See the [main repository](https://github.com/CelsianJs/celsian) for full docs, examples, and API reference.

## License

MIT
