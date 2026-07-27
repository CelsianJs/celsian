// @celsian/adapter-bun -- Bun runtime smoke (CI). Proves the adapter loads and
// serves a real Request->Response under Bun. Run after `pnpm build`:
//   bun run packages/adapter-bun/bun-smoke.ts
//
// This deliberately does NOT run the vitest suite under `bun test`. That was the
// previous shape of this check, and it tested Bun's vitest-compatibility layer
// rather than the adapter: it reported failures for APIs Bun's runner does not
// implement (vi.setSystemTime) and hung on tests that hold a real server open.
// It had to be marked advisory to stay green, which meant it gated nothing while
// still costing its full timeout. Mirrors packages/adapter-deno/deno-smoke.ts.
import { createApp } from "../core/dist/index.js";
import { createBunHandler, createBunServeOptions } from "./dist/index.js";

const app = createApp();
app.get("/hello", () => ({ ok: true }));
app.post("/echo", (req) => ({ got: req.parsedBody }));
await app.ready();

// Bun hands the fetch handler a `server`; only `upgrade`/`requestIP` are used,
// and neither is reached on a plain GET, so a minimal stub is enough here.
const server = { upgrade: () => false } as never;
const handler = createBunHandler(app);

const res = await handler(new Request("http://localhost/hello"), server);
if (!res) throw new Error("expected a Response, got undefined");
if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
const body = await res.json();
if (body?.ok !== true) throw new Error(`unexpected body: ${JSON.stringify(body)}`);

// Body parsing crosses the Request boundary, which is where a runtime that
// implements the web streams differently would break. A GET alone would not
// catch that.
const echo = await handler(
  new Request("http://localhost/echo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ n: 1 }),
  }),
  server,
);
if (!echo) throw new Error("expected a Response from POST /echo");
const echoed = await echo.json();
if (echoed?.got?.n !== 1) throw new Error(`body did not round-trip: ${JSON.stringify(echoed)}`);

// createBunServeOptions is what users actually pass to Bun.serve, so a shape
// change there breaks every consumer even when the handler above still works.
const opts = createBunServeOptions(app);
if (typeof opts.fetch !== "function") throw new Error("createBunServeOptions did not return a fetch handler");

console.log("[adapter-bun] Bun runtime smoke OK");
