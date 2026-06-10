// CI workerd smoke fixture (INF-03): minimal Cloudflare Worker entry that
// exercises the real built dist of @celsian/core + @celsian/adapter-cloudflare.
// Imported by relative path so wrangler's esbuild bundles the actual build
// output (run `pnpm build` first). Used by scripts/workerd-smoke.mjs.
import { createCloudflareHandler } from "../packages/adapter-cloudflare/dist/index.js";
import { createApp } from "../packages/core/dist/index.js";

const app = createApp({ logger: false });
app.get("/health", () => ({ ok: true, runtime: "workerd" }));

export default createCloudflareHandler(app);
