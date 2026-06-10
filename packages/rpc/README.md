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
rpc.mount(app); // serves /_rpc/* (pass a prefix to mount elsewhere: rpc.mount(app, '/api/rpc'))
```

`mount()` registers both `GET` and `POST` wildcard routes — the RPC client uses
GET for queries and POST for mutations. (Note: `CelsianApp` has no `.all()`
method.) If you prefer to register the routes yourself:

```typescript
app.get('/_rpc/*path', (req) => rpc.handle(req));
app.post('/_rpc/*path', (req) => rpc.handle(req));
```

## Documentation

See the [main repository](https://github.com/CelsianJs/celsian) for full docs, examples, and API reference.

## License

MIT
