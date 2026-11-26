// CI workerd smoke fixture (INF-03): minimal Cloudflare Worker entry that
// exercises the real built dist of @celsian/core + @celsian/adapter-cloudflare.
// Imported by relative path so wrangler's esbuild bundles the actual build
// output (run `pnpm build` first). Used by scripts/workerd-smoke.mjs.
import { createCloudflareHandler } from "../packages/adapter-cloudflare/dist/index.js";
import { createApp } from "../packages/core/dist/index.js";

const app = createApp({ logger: false });
app.get("/health", () => ({ ok: true, runtime: "workerd" }));

// request.signal under workerd (packages/core/README.md, "request.signal"),
// checked here and reported for scripts/workerd-smoke.mjs to assert.
app.get("/signal", async () => {
  const inner = createApp({ logger: false });
  let signal;
  inner.get("/", (req) => {
    signal = req.signal;
    return "ok";
  });
  const stopped = new AbortController();
  const stoppedInput = new Request("http://localhost/", { signal: stopped.signal });
  stoppedInput.signal.addEventListener("abort", (event) => event.stopImmediatePropagation());
  await inner.handle(stoppedInput);
  stopped.abort("cancelled");
  const stoppedResult = [signal.aborted, signal.reason];

  const dispatched = new AbortController();
  const dispatchedInput = new Request("http://localhost/", { signal: dispatched.signal });
  await inner.handle(dispatchedInput);
  dispatchedInput.signal.dispatchEvent(new Event("abort"));
  const afterDispatch = signal.aborted;
  dispatched.abort("real");
  const realReason = signal.reason;

  const ordered = new AbortController();
  const orderedInput = new Request("http://localhost/", { signal: ordered.signal });
  const during = [];
  orderedInput.signal.addEventListener("abort", () => during.push(signal.aborted));
  await inner.handle(orderedInput);
  ordered.abort();
  return { stopped: stoppedResult, afterDispatch, realReason, during };
});

export default createCloudflareHandler(app);
