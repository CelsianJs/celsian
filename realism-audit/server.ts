// Live CelsianJS server — run with: npx tsx realism-audit/server.ts
import { buildApp } from "./app.js";
import { serve } from "../packages/core/src/serve.js";

const { app } = buildApp();

const { close } = await serve(app, {
  port: parseInt(process.env.PORT || "3000", 10),
  host: "0.0.0.0",
  onReady: ({ port, host }) => {
    console.log(`CelsianJS Realism Audit server running at http://${host}:${port}`);
    console.log(`  Health: http://${host}:${port}/api/health`);
    console.log(`  Docs:   http://${host}:${port}/api/docs/openapi.json`);
  },
  onShutdown: async () => {
    console.log("Server shutting down...");
  },
});

process.on("SIGINT", async () => {
  await close();
  process.exit(0);
});
