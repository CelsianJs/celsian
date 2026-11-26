// @celsian/core -- Default error handling and response building

import { HttpError, ValidationError } from "./errors.js";
import type { Logger } from "./logger.js";
import type { CelsianReply, CelsianRequest, OnErrorHandler } from "./types.js";

/** Log an error through the structured logger when available, else console. */
function logHandlerError(logger: Logger | null | undefined, message: string, err: unknown): void {
  if (logger) {
    logger.error(message, { error: err instanceof Error ? err.message : String(err) });
  } else {
    console.error("[celsian]", err);
  }
}

/** `GET /users/7` for a log line: no origin, and no query string (it can hold tokens). */
function describeRequest(request: CelsianRequest): string {
  const method = typeof request?.method === "string" ? request.method : "";
  const url = typeof request?.url === "string" ? request.url : "";
  const path = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "").replace(/[?#].*$/, "") || "/";
  return method ? `${method} ${path}` : path;
}

/**
 * Make sure a server fault is recorded somewhere.
 *
 * `createApp()` with no `logger` option has a silent no-op logger, and in
 * production the 500 response is sanitized as well, so a thrown error left no
 * trace at all: not in the response, not on stderr. Three of the four
 * create-celsian templates start from a bare `createApp()`.
 *
 * With a logger, the app's request logger already records every failed request
 * ("request error"), so this stays quiet and nothing is logged twice. Only
 * 5xx gets here: a 4xx is the client's mistake, answered in full, and would
 * turn stderr into an access log.
 */
function reportServerError(
  logger: Logger | null | undefined,
  error: Error,
  request: CelsianRequest,
  status: number,
): void {
  if (logger) return;
  console.error(`[celsian] ${describeRequest(request)} failed with ${status}:`, error);
}

/**
 * Process an error through custom handlers, onError hooks, and default formatting.
 * Returns a well-formed JSON Response with appropriate status code.
 */
export async function handleError(
  error: Error,
  request: CelsianRequest,
  reply: CelsianReply,
  customHandler: ((error: Error, request: CelsianRequest, reply: CelsianReply) => Response | Promise<Response>) | null,
  onErrorHooks: OnErrorHandler[],
  logger?: Logger | null,
): Promise<Response> {
  if (customHandler) {
    try {
      const result = await customHandler(error, request, reply);
      if (result instanceof Response) return result;
    } catch (handlerError) {
      logHandlerError(logger, "custom error handler failed", handlerError);
    }
  }

  for (const handler of onErrorHooks) {
    try {
      const result = await handler(error, request, reply);
      if (result instanceof Response) {
        return result;
      }
    } catch (hookError) {
      logHandlerError(logger, "onError hook failed", hookError);
    }
  }

  if (error instanceof ValidationError) {
    return new Response(JSON.stringify(error.toJSON()), {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  if (error instanceof HttpError) {
    // An intentional 5xx still has its message stripped from the production
    // response (HttpError.toJSON), so it needs the same trace as an unknown one.
    if (error.statusCode >= 500) reportServerError(logger, error, request, error.statusCode);
    return new Response(JSON.stringify(error.toJSON()), {
      status: error.statusCode,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  // Anything that reaches here is not an HttpError, so its `statusCode` is
  // untrusted: a driver/library error carrying `statusCode: 400` would
  // otherwise both downgrade the status AND skip production sanitization,
  // leaking the raw message. Unknown errors are 500s, always sanitized in prod.
  const status = 500;
  reportServerError(logger, error, request, status);
  const isProduction =
    typeof process !== "undefined" &&
    (process.env.NODE_ENV === "production" || process.env.CELSIAN_ENV === "production");

  const body: Record<string, unknown> = {
    error: isProduction ? "Internal Server Error" : error.message || "Internal Server Error",
    statusCode: status,
    code: (error as { code?: string }).code ?? "INTERNAL_SERVER_ERROR",
  };

  if (!isProduction && error.stack) {
    body.stack = error.stack;
  }

  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
