// @celsian/adapter-cloudflare — Cloudflare Workers adapter

import type { CelsianApp } from "@celsian/core";
import { CelsianError } from "@celsian/core";

/**
 * Cloudflare Workers environment bindings (KV, D1, R2, etc.)
 * Users extend this interface for their specific bindings.
 */
export interface CloudflareEnv {
  [key: string]: unknown;
}

/**
 * Cloudflare Workers execution context.
 * Provides waitUntil() for background work after response.
 */
export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

/**
 * Cloudflare Cron Trigger controller passed to the `scheduled` handler.
 */
export interface ScheduledController {
  /** The cron expression (from wrangler.toml `triggers.crons`) that fired. */
  cron: string;
  /** Scheduled fire time (ms since epoch). */
  scheduledTime: number;
  noRetry(): void;
}

/**
 * Cloudflare Workers module export format.
 */
export interface CloudflareWorkerExport {
  fetch: (request: Request, env: CloudflareEnv, ctx: ExecutionContext) => Promise<Response>;
  scheduled: (controller: ScheduledController, env: CloudflareEnv, ctx: ExecutionContext) => Promise<void>;
}

/** Normalize a cron expression for comparison (collapse whitespace). */
function normalizeCron(expr: string): string {
  return expr.trim().replace(/\s+/g, " ");
}

/**
 * Create a Cloudflare Workers handler.
 * Cloudflare Workers already uses Web Standard APIs (Request/Response),
 * so this adapter mainly passes through env bindings and execution context.
 *
 * The returned object includes a `scheduled` handler that bridges
 * Cloudflare Cron Triggers to `app.cron()` jobs: jobs whose schedule matches
 * the firing trigger's cron expression run; if no job matches (e.g. a single
 * trigger drives all jobs), every registered job runs.
 *
 * @example
 * ```ts
 * app.cron("cleanup", "0 3 * * *", async () => { ... });
 * export default createCloudflareHandler(app);
 * // wrangler.toml: [triggers] crons = ["0 3 * * *"]
 * ```
 */
export function createCloudflareHandler(app: CelsianApp): CloudflareWorkerExport {
  return {
    async fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext): Promise<Response> {
      try {
        // Attach Cloudflare env and ctx to request for handler access
        (request as unknown as Record<string, unknown>).env = env;
        (request as unknown as Record<string, unknown>).ctx = ctx;
        return await app.handle(request);
      } catch (error) {
        console.error("[celsian] Unhandled error in Cloudflare handler:", error);
        return new Response(JSON.stringify({ error: "Internal Server Error", statusCode: 500 }), {
          status: 500,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
    },

    async scheduled(controller: ScheduledController, _env: CloudflareEnv, _ctx: ExecutionContext): Promise<void> {
      const jobs = app.getCronJobs();
      if (jobs.length === 0) {
        console.warn("[celsian] Cron Trigger fired but no cron jobs are registered via app.cron()");
        return;
      }

      const trigger = controller?.cron ? normalizeCron(controller.cron) : "";
      const matching = trigger ? jobs.filter((job) => normalizeCron(job.schedule) === trigger) : [];
      // No exact match (or no trigger expression): run all registered jobs
      const toRun = matching.length > 0 ? matching : jobs;

      // async wrapper so synchronously-throwing handlers are captured too
      const results = await Promise.allSettled(toRun.map(async (job) => job.handler()));

      const failures: string[] = [];
      results.forEach((result, i) => {
        if (result.status === "rejected") {
          const jobName = toRun[i]?.name ?? "unknown";
          failures.push(jobName);
          console.error(`[celsian] Cron job "${jobName}" failed:`, result.reason);
        }
      });

      // Surface failures so Cloudflare marks the invocation as failed
      if (failures.length > 0) {
        throw new CelsianError(`${failures.length} cron job(s) failed: ${failures.join(", ")}`);
      }
    },
  };
}
