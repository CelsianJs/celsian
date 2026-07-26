// CelsianJS on Vercel -- Cron Job Handler
//
// This endpoint is called by Vercel Cron Jobs on a schedule.
// The CRON_SECRET validation ensures only Vercel's scheduler
// can trigger this endpoint.
//
// Configure the schedule in vercel.json:
//   "crons": [{ "path": "/api/cron", "schedule": "0 * * * *" }]

import type { IncomingMessage, ServerResponse } from "node:http";
import { createVercelCronHandler } from "@celsian/adapter-vercel";
import { createApp, nodeToWebRequest, writeWebResponse } from "@celsian/core";

// Exported as `app` so tooling that loads this file (for example
// `celsian routes api/cron.ts`) can find it.
export const app = createApp({ logger: true });

app.get("/api/cron", (_req, reply) => {
  // This runs on the schedule defined in vercel.json
  const now = new Date().toISOString();
  console.log(`[cron] Running scheduled task at ${now}`);

  // TODO: Add your scheduled task logic here
  // Examples: cleanup expired sessions, send digest emails,
  // sync external data, generate reports

  return reply.json({ status: "ok", executedAt: now });
});

await app.ready();

// createVercelCronHandler() is Web-standard (Request in, Response out), but a
// function in this example runs on the Node.js runtime, where Vercel invokes
// the default export with (req, res). Bridge the two with core's converters.
const cronHandler = createVercelCronHandler(app);

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const proto = req.headers["x-forwarded-proto"] ?? "https";
  const host = req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `${proto}://${host}`);
  const response = await cronHandler(nodeToWebRequest(req, url));
  await writeWebResponse(res, response);
}
