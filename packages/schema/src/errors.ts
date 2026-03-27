// @celsian/schema — Schema-specific error class

/**
 * Error thrown by schema detection and adapter operations.
 * Provides descriptive messages for misconfiguration and missing dependencies.
 */
export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaError";
  }
}
