// @celsian/adapter-deno -- Deno runtime smoke (CI). Proves the adapter loads and
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
// request.signal on this runtime (packages/core/README.md, "request.signal"):
// it aborts with the input's reason past an earlier listener that stops the
// input's abort event; an abort event merely dispatched on the input does not
// abort it; and inside the input's own abort listeners it is already aborted (Deno combines it with AbortSignal.any()).
{
  const signalApp = createApp();
  let signal: AbortSignal | undefined;
  signalApp.get("/signal", (req) => {
    signal = req.signal;
    return "ok";
  });
  await signalApp.ready();

  const stopped = new AbortController();
  const stoppedInput = new Request("http://localhost/signal", { signal: stopped.signal });
  stoppedInput.signal.addEventListener("abort", (event) => event.stopImmediatePropagation());
  await signalApp.handle(stoppedInput);
  stopped.abort("cancelled");
  if (signal?.aborted !== true || signal.reason !== "cancelled") {
    throw new Error(`request.signal did not abort past a stopped event: ${signal?.aborted} ${String(signal?.reason)}`);
  }

  const dispatched = new AbortController();
  const dispatchedInput = new Request("http://localhost/signal", { signal: dispatched.signal });
  await signalApp.handle(dispatchedInput);
  dispatchedInput.signal.dispatchEvent(new Event("abort"));
  if (signal?.aborted !== false) throw new Error("an abort event dispatched on the input aborted request.signal");
  dispatched.abort("real");
  if (signal?.reason !== "real") throw new Error(`request.signal did not abort with the real reason: ${String(signal?.reason)}`);

  const ordered = new AbortController();
  const orderedInput = new Request("http://localhost/signal", { signal: ordered.signal });
  const during: boolean[] = [];
  orderedInput.signal.addEventListener("abort", () => during.push(signal?.aborted === true));
  await signalApp.handle(orderedInput);
  ordered.abort();
  if (during.join() !== "true") {
    throw new Error(`inside the input's abort listener, request.signal.aborted was ${during.join()}, expected true`);
  }
}

console.log("[adapter-deno] Deno runtime smoke OK");
