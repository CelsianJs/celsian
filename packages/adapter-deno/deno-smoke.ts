// @celsian/adapter-deno — Deno runtime smoke (CI). Proves the adapter loads and
// serves a real Request->Response under Deno. Run after `pnpm build`:
//   deno run -A packages/adapter-deno/deno-smoke.ts
import { createApp } from "../core/dist/index.js";
import { createDenoHandler } from "./dist/index.js";

const app = createApp();
app.get("/hello", () => ({ ok: true }));
await app.ready();

const handler = createDenoHandler(app);
const res = await handler(new Request("http://localhost/hello"));
if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
const body = await res.json();
if (body?.ok !== true) throw new Error(`unexpected body: ${JSON.stringify(body)}`);
console.log("[adapter-deno] Deno runtime smoke OK");
