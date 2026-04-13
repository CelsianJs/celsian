// CelsianJS on Vercel — Cron Job Handler
//
// This endpoint is called by Vercel Cron Jobs on a schedule.
// The CRON_SECRET validation ensures only Vercel's scheduler
// can trigger this endpoint.
//
// Configure the schedule in vercel.json:
//   "crons": [{ "path": "/api/cron", "schedule": "0 * * * *" }]

import { createVercelCronHandler } from "@celsian/adapter-vercel";
import { createApp } from "@celsian/core";

const app = createApp({ logger: true });

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

export default createVercelCronHandler(app);
