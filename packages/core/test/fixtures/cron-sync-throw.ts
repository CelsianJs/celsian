// @celsian/core -- isolated process for the cron synchronous-throw regression
//
// Runs a real serve() with a real one-second cron timer. The test asserts on
// this process's exit code, which is the thing that went wrong: the throw
// became an uncaughtException and serve()'s fatal handler exited with 1.

import { createApp } from "../../src/app.js";
import { serve } from "../../src/serve.js";

const app = createApp();
let goodRuns = 0;

app.get("/health", () => ({ ok: true }));
app.cron("bad", "* * * * *", () => {
  throw new Error("sync boom");
});
app.cron("good", "* * * * *", () => {
  goodRuns++;
});

let port = 0;
const server = await serve(app, {
  port: 0,
  host: "127.0.0.1",
  onReady: (info) => {
    port = info.port;
  },
});

// The scheduler fires on its first tick, one second after start. Poll rather
// than sleep a fixed time, so a loaded machine only makes this slower.
const deadline = Date.now() + 15_000;
while (goodRuns === 0 && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

const health = await fetch(`http://127.0.0.1:${port}/health`);
process.stdout.write(JSON.stringify({ goodRuns, health: health.status }));
await server.close();
process.exit(0);
