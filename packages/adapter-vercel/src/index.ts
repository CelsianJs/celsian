// @celsian/adapter-vercel -- Vercel deployment adapter

import type { IncomingMessage, ServerResponse } from "node:http";
import type { CelsianApp } from "@celsian/core";
import { nodeToWebRequest, writeWebResponse } from "@celsian/core";

/**
 * Create a Vercel Serverless Function handler (Node.js runtime).
 * Converts Node.js IncomingMessage to Web Request, processes via app.handle(),
 * and writes the Web Response back to ServerResponse.
 */
export function createVercelHandler(app: CelsianApp) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const proto = req.headers["x-forwarded-proto"] ?? "https";
      const host = req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost";
      const url = new URL(req.url ?? "/", `${proto}://${host}`);

      const webRequest = nodeToWebRequest(req, url);
      const response = await app.handle(webRequest);
      await writeWebResponse(res, response);
    } catch (error) {
      console.error("[celsian] Unhandled error in Vercel handler:", error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "Internal Server Error", statusCode: 500 }));
      }
    }
  };
}

/**
 * Create a Vercel Edge Function handler.
 * Vercel Edge uses Web Standard Request/Response, so this is a direct passthrough.
 */
export function createVercelEdgeHandler(app: CelsianApp) {
  return async (request: Request): Promise<Response> => {
    try {
      return await app.handle(request);
    } catch (error) {
      console.error("[celsian] Unhandled error in Vercel Edge handler:", error);
      return new Response(JSON.stringify({ error: "Internal Server Error", statusCode: 500 }), {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
  };
}

/**
 * Timing-safe string comparison using Web Crypto (works on Node, Edge, Workers).
 * Hashes both inputs to fixed-length digests, then compares in constant time.
 * No `node:crypto` import -- keeps the module bundleable for edge runtimes.
 */
async function timingSafeEqualWeb(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    globalThis.crypto.subtle.digest("SHA-256", encoder.encode(a)),
    globalThis.crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const bytesA = new Uint8Array(digestA);
  const bytesB = new Uint8Array(digestB);
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) {
    diff |= (bytesA[i] as number) ^ (bytesB[i] as number);
  }
  return diff === 0;
}

/** Normalize a cron expression for comparison (collapse whitespace). */
function normalizeCron(expr: string): string {
  return expr.trim().replace(/\s+/g, " ");
}

/** Options for {@link createVercelCronHandler}. */
export interface VercelCronOptions {
  /**
   * The cron expression this endpoint is wired to in `vercel.json`. When set,
   * only `app.cron()` jobs registered with the same expression run. Leave it
   * unset to have one endpoint drive every registered job.
   *
   * A `?schedule=` query parameter on the request takes precedence, which is
   * how one deployed handler can serve several `vercel.json` entries.
   */
  schedule?: string;
}

/**
 * Create a Vercel Cron Job handler with CRON_SECRET validation.
 *
 * Vercel Cron Jobs call an HTTP endpoint on a schedule, they do not invoke a
 * platform-level scheduled hook the way Cloudflare Cron Triggers do. This
 * handler authenticates the caller and then RUNS the matching `app.cron()`
 * jobs, which is what the README always claimed it did. Previously it validated
 * the secret and then called `app.handle(request)`, so no cron job ever ran and
 * the caller got a 404 from the router: scheduled work silently never executed
 * on Vercel.
 *
 * Job selection mirrors the Cloudflare `scheduled` handler: run the jobs whose
 * schedule matches this invocation, and if nothing matches (or no schedule is
 * known), run every registered job, since a single endpoint commonly drives all
 * of them.
 *
 * Failures return 500 with the failing job names so Vercel marks the invocation
 * as failed and retries per project settings. A silent 200 on a failed job is
 * the same class of bug as the original defect.
 *
 * @example
 * ```ts
 * // api/cron.ts
 * app.cron('cleanup', '0 3 * * *', async () => { await db.deleteExpired(); });
 * export default createVercelCronHandler(app, undefined, { schedule: '0 3 * * *' });
 * // vercel.json: { "crons": [{ "path": "/api/cron", "schedule": "0 3 * * *" }] }
 * ```
 *
 * @param app - CelsianApp instance
 * @param cronSecret - Optional secret override (defaults to process.env.CRON_SECRET)
 * @param options - Optional schedule binding, see {@link VercelCronOptions}
 */
export function createVercelCronHandler(app: CelsianApp, cronSecret?: string, options: VercelCronOptions = {}) {
  return async (request: Request): Promise<Response> => {
    const secret = (cronSecret ?? process.env.CRON_SECRET ?? "").trim();
    if (!secret) {
      console.error("[celsian] CRON_SECRET not set -- rejecting all cron requests");
      return new Response(JSON.stringify({ error: "Service Unavailable", statusCode: 503 }), {
        status: 503,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const authHeader = request.headers.get("authorization") ?? "";
    const expected = `Bearer ${secret}`;
    // Timing-safe comparison: hash both to normalize length, then compare digests
    if (!(await timingSafeEqualWeb(authHeader, expected))) {
      return new Response(JSON.stringify({ error: "Unauthorized", statusCode: 401 }), {
        status: 401,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const jobs = app.getCronJobs();
    if (jobs.length === 0) {
      // No `app.cron()` jobs to run, so fall through to the router. That is
      // the pre-existing behavior and it is a legitimate setup: plenty of
      // Vercel cron endpoints are plain routes that happen to need the
      // CRON_SECRET check. It is only the DEFAULT that was wrong, and the
      // warning says so rather than leaving the miss silent.
      console.warn(
        "[celsian] Vercel cron endpoint hit but no cron jobs are registered via app.cron(); " +
          "falling through to the router. Register jobs with app.cron(name, schedule, handler) " +
          "for this handler to run them.",
      );
      try {
        return await app.handle(request);
      } catch (error) {
        console.error("[celsian] Unhandled error in Vercel Cron handler:", error);
        return jsonResponse({ error: "Internal Server Error", statusCode: 500 }, 500);
      }
    }

    let schedule = options.schedule;
    try {
      const requested = new URL(request.url).searchParams.get("schedule");
      if (requested) schedule = requested;
    } catch {
      // Unparseable URL, fall back to the configured schedule (or all jobs).
    }

    const trigger = schedule ? normalizeCron(schedule) : "";
    const matching = trigger ? jobs.filter((job) => normalizeCron(job.schedule) === trigger) : [];
    // No exact match (or no schedule given): run every registered job.
    const toRun = matching.length > 0 ? matching : jobs;

    // async wrapper so synchronously-throwing handlers are captured too
    const results = await Promise.allSettled(toRun.map(async (job) => job.handler()));

    const ran: string[] = [];
    const failed: string[] = [];
    results.forEach((result, i) => {
      const jobName = toRun[i]?.name ?? "unknown";
      if (result.status === "rejected") {
        failed.push(jobName);
        console.error(`[celsian] Cron job "${jobName}" failed:`, result.reason);
      } else {
        ran.push(jobName);
      }
    });

    if (failed.length > 0) {
      return jsonResponse({ error: "Internal Server Error", statusCode: 500, ran, failed }, 500);
    }
    return jsonResponse({ ran, failed }, 200);
  };
}

/** Build a JSON response with the adapter's standard content type. */
function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
