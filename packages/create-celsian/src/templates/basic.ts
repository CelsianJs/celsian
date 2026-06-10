import { CELSIAN_VERSION, DEV_DEPS } from "../versions.js";

export const basicTemplate = {
  "package.json": JSON.stringify(
    {
      name: "{{name}}",
      version: "0.0.1",
      type: "module",
      scripts: {
        dev: "npx tsx --watch src/index.ts",
        build: "tsc",
        start: "node dist/index.js",
      },
      dependencies: {
        celsian: CELSIAN_VERSION,
      },
      devDependencies: {
        typescript: DEV_DEPS.typescript,
        tsx: DEV_DEPS.tsx,
        "@types/node": DEV_DEPS.typesNode,
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

// Exported so tooling like \`celsian routes\` can discover the app.
export const app = createApp();

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

serve(app);
`,
  ".gitignore": `node_modules/
dist/
*.tsbuildinfo
.env
`,
  "README.md": `# {{name}}

A minimal API server built with [CelsianJS](https://github.com/CelsianJs/celsian).

## Quick Start

\`\`\`bash
npm install
npm run dev
\`\`\`

The server starts at http://localhost:3000.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | \`/health\` | Server health check |
| GET | \`/hello/:name\` | Greeting by name |

## Scripts

- \`npm run dev\` — start the dev server with hot reload
- \`npm run build\` — compile TypeScript to \`dist/\`
- \`npm start\` — run the compiled server
`,
};
