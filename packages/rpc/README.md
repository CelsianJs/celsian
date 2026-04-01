# @celsian/rpc

Type-safe RPC procedures with middleware, schema validation, and OpenAPI generation for CelsianJS.

## Install

```bash
npm install @celsian/rpc
```

## Usage

```typescript
import { procedure, router, RPCHandler } from '@celsian/rpc';

const appRouter = router({
  greet: procedure.input(z.object({ name: z.string() })).query(({ input }) => `Hello, ${input.name}!`),
});
const rpc = new RPCHandler(appRouter);
app.all('/_rpc/*path', (req) => rpc.handle(req));
```

## Documentation

See the [main repository](https://github.com/CelsianJs/celsian) for full docs, examples, and API reference.

## License

MIT
