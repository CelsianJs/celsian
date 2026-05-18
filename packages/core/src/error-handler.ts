// @celsian/core -- Default error handling and response building

import { HttpError, ValidationError } from "./errors.js";
import type { CelsianReply, CelsianRequest, OnErrorHandler } from "./types.js";

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
): Promise<Response> {
  if (customHandler) {
    try {
      const result = await customHandler(error, request, reply);
      if (result instanceof Response) return result;
    } catch (handlerError) {
      console.error("[celsian]", handlerError);
    }
  }

  for (const handler of onErrorHooks) {
    try {
      const result = await handler(error, request, reply);
      if (result instanceof Response) {
        return result;
      }
    } catch (hookError) {
      console.error("[celsian]", hookError);
    }
  }

  if (error instanceof ValidationError) {
    return new Response(JSON.stringify(error.toJSON()), {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  if (error instanceof HttpError) {
    return new Response(JSON.stringify(error.toJSON()), {
      status: error.statusCode,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  const status = (error as { statusCode?: number }).statusCode ?? 500;
  const isProduction =
    typeof process !== "undefined" &&
    (process.env.NODE_ENV === "production" || process.env.CELSIAN_ENV === "production");

  const body: Record<string, unknown> = {
    error: status >= 500 && isProduction ? "Internal Server Error" : error.message || "Internal Server Error",
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
