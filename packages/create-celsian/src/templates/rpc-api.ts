export const rpcApiTemplate = {
  'package.json': JSON.stringify(
    {
      name: '{{name}}',
      version: '0.0.1',
      type: 'module',
      scripts: {
        dev: 'npx celsian dev',
        build: 'tsc',
        start: 'node dist/index.js',
      },
      dependencies: {
        celsian: '^0.1.0',
        '@celsian/rpc': '^0.1.0',
        '@sinclair/typebox': '^0.34.0',
      },
      devDependencies: {
        typescript: '^5.7.0',
        tsx: '^4.0.0',
      },
    },
    null,
    2,
  ),
  'tsconfig.json': JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        outDir: 'dist',
        rootDir: 'src',
      },
      include: ['src'],
    },
    null,
    2,
  ),
  'src/index.ts': `import { createApp, serve } from 'celsian';
import { procedure, router, RPCHandler } from '@celsian/rpc';
import { Type } from '@sinclair/typebox';

const app = createApp();

const appRouter = router({
  greeting: {
    hello: procedure
      .input(Type.Object({ name: Type.String() }))
      .query(({ input }) => {
        return { message: \\\`Hello, \\\${input.name}!\\\` };
      }),
  },
  math: {
    add: procedure
      .input(Type.Object({ a: Type.Number(), b: Type.Number() }))
      .query(({ input }) => {
        return { result: input.a + input.b };
      }),
  },
});

const rpcHandler = new RPCHandler(appRouter);

app.route({
  method: ['GET', 'POST'],
  url: '/_rpc/*path',
  handler(req) {
    return rpcHandler.handle(req);
  },
});

serve(app, { port: 3000 });

export type AppRouter = typeof appRouter;
`,
};
