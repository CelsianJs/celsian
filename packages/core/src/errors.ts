// @celsian/core — Structured error classes

const isDev =
  typeof process !== "undefined"
    ? process.env.NODE_ENV === "development" || process.env.CELSIAN_ENV === "development"
    : false;

export class CelsianError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CelsianError";
  }
}

export class HttpError extends CelsianError {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, message?: string, options?: { code?: string; cause?: Error }) {
    super(message ?? HttpError.defaultMessage(statusCode));
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = options?.code ?? HttpError.defaultCode(statusCode);
    if (options?.cause) this.cause = options.cause;
  }

  private static defaultMessage(statusCode: number): string {
    const messages: Record<number, string> = {
      400: "Bad Request",
      401: "Unauthorized",
      403: "Forbidden",
      404: "Not Found",
      405: "Method Not Allowed",
      408: "Request Timeout",
      409: "Conflict",
      413: "Payload Too Large",
      422: "Unprocessable Entity",
      429: "Too Many Requests",
      500: "Internal Server Error",
      502: "Bad Gateway",
      503: "Service Unavailable",
      504: "Gateway Timeout",
    };
    return messages[statusCode] ?? "Unknown Error";
  }

  private static defaultCode(statusCode: number): string {
    const codes: Record<number, string> = {
      400: "BAD_REQUEST",
      401: "UNAUTHORIZED",
      403: "FORBIDDEN",
      404: "NOT_FOUND",
      405: "METHOD_NOT_ALLOWED",
      408: "REQUEST_TIMEOUT",
      409: "CONFLICT",
      413: "PAYLOAD_TOO_LARGE",
      422: "UNPROCESSABLE_ENTITY",
      429: "TOO_MANY_REQUESTS",
      500: "INTERNAL_SERVER_ERROR",
      502: "BAD_GATEWAY",
      503: "SERVICE_UNAVAILABLE",
      504: "GATEWAY_TIMEOUT",
    };
    return codes[statusCode] ?? "UNKNOWN_ERROR";
  }

  toJSON() {
    const base: Record<string, unknown> = {
      error: this.statusCode >= 500 && !isDev ? HttpError.defaultMessage(this.statusCode) : this.message,
      statusCode: this.statusCode,
      code: this.code,
    };

    if (isDev && this.stack) {
      base.stack = this.stack;
    }
    if (isDev && this.cause) {
      base.cause = this.cause instanceof Error ? { message: this.cause.message, stack: this.cause.stack } : this.cause;
    }

    return base;
  }
}

export class ValidationError extends CelsianError {
  readonly statusCode = 400;
  readonly code = "VALIDATION_FAILED";
  readonly issues: Array<{ message: string; path?: (string | number)[] }>;

  constructor(issues: Array<{ message: string; path?: (string | number)[] }>) {
    super(ValidationError.formatMessage(issues));
    this.name = "ValidationError";
    this.issues = issues;
  }

  /** Build a human-readable bulleted message from validation issues. */
  private static formatMessage(issues: Array<{ message: string; path?: (string | number)[] }>): string {
    if (issues.length === 0) return "Validation failed";

    const bullets = issues.map((issue) => {
      const pathStr = issue.path?.length ? `${issue.path.join(".")}: ` : "";
      return `\u2022 ${pathStr}${issue.message}`;
    });
    return `Validation failed: ${bullets.join(" ")}`;
  }

  toJSON() {
    const base: Record<string, unknown> = {
      error: "Validation failed",
      message: this.message,
      statusCode: this.statusCode,
      code: this.code,
      issues: this.issues,
    };

    if (isDev && this.stack) {
      base.stack = this.stack;
    }

    return base;
  }
}

// ─── Plugin assertion ───

/**
 * Assert that a plugin value passed to `app.register()` is a function.
 * Throws a descriptive CelsianError if it is not.
 */
export function assertPlugin(value: unknown): asserts value is Function {
  if (typeof value === "function") return;

  const received =
    value === null
      ? "null"
      : Array.isArray(value)
        ? "an Array"
        : typeof value === "object"
          ? `an Object (${JSON.stringify(value).slice(0, 80)})`
          : `${typeof value} (${String(value)})`;

  throw new CelsianError(
    `app.register() expects a plugin function, but received ${received}. ` +
      `Usage: app.register(async (app, opts) => { /* ... */ })`,
  );
}

// ─── Decoration conflict ───

/**
 * Throw when a plugin tries to decorate with a name that already exists.
 */
export function assertDecorationUnique(name: string, existingValue: unknown, newValue: unknown): void {
  const fmt = (v: unknown): string => {
    if (typeof v === "function") return `[Function: ${(v as Function).name || "anonymous"}]`;
    if (typeof v === "object" && v !== null) return JSON.stringify(v).slice(0, 80);
    return String(v);
  };

  throw new CelsianError(
    `Decoration "${name}" already exists. ` +
      `Existing value: ${fmt(existingValue)}, new value: ${fmt(newValue)}. ` +
      `Use a unique name or remove the conflicting plugin.`,
  );
}

// ─── Non-Error throw wrapping ───

/**
 * Wrap a non-Error thrown value into a CelsianError with a helpful message.
 * If the value is already an Error, return it unchanged.
 */
export function wrapNonError(thrown: unknown): Error {
  if (thrown instanceof Error) return thrown;

  const type = thrown === null ? "null" : typeof thrown;
  const preview =
    typeof thrown === "string" ? `"${thrown.length > 80 ? `${thrown.slice(0, 80)}...` : thrown}"` : String(thrown);

  return new CelsianError(
    `A route handler threw a non-Error value (${type}: ${preview}). ` +
      `Consider using: throw new HttpError(500, "your message") instead.`,
  );
}
