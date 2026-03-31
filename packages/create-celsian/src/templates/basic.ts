export const basicTemplate = {
  "package.json": JSON.stringify(
    {
      name: "{{name}}",
      version: "0.0.1",
      type: "module",
      scripts: {
        dev: "npx celsian dev",
        build: "tsc",
        start: "node dist/index.js",
      },
      dependencies: {
        celsian: "^0.1.0",
      },
      devDependencies: {
        typescript: "^5.7.0",
        tsx: "^4.0.0",
      },
    },
    null,
    2,
  ),
  "tsconfig.json": JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        outDir: "dist",
        rootDir: "src",
      },
      include: ["src"],
    },
    null,
    2,
  ),
  "src/index.ts": `import { createApp, serve, cors, security } from 'celsian';

const app = createApp();

// ─── Security (CORS + security headers) ───

const CORS_ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:3000';

await app.register(cors({
  origin: CORS_ORIGIN,
  credentials: true,
  maxAge: 86400,
}));

await app.register(security({
  hsts: { maxAge: 31536000, includeSubDomains: true },
  referrerPolicy: 'strict-origin-when-cross-origin',
}));

// ─── Routes ───

app.get('/health', (req, reply) => {
  return reply.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/hello/:name', (req, reply) => {
  return reply.json({ message: \`Hello, \${req.params.name}!\` });
});

serve(app, { port: 3000 });
`,
};
