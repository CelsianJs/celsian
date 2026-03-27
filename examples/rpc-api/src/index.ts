import { procedure, RPCHandler, router } from "@celsian/rpc";
import { Type } from "@sinclair/typebox";
import { createApp, serve } from "celsian";

const app = createApp();

const appRouter = router({
  greeting: {
    hello: procedure.input(Type.Object({ name: Type.String() })).query(({ input }) => {
      return { message: `Hello, ${input.name}!` };
    }),
  },
  math: {
    add: procedure.input(Type.Object({ a: Type.Number(), b: Type.Number() })).query(({ input }) => {
      return { result: input.a + input.b };
    }),
  },
});

const rpcHandler = new RPCHandler(appRouter);

app.route({
  method: ["GET", "POST"],
  url: "/_rpc/*path",
  handler(req) {
    return rpcHandler.handle(req);
  },
});

serve(app, { port: 3000 });

export type AppRouter = typeof appRouter;
