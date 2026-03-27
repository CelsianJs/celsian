// @celsian/platform — Platform-specific error class

/**
 * Error thrown by platform deployment providers.
 * Used for unimplemented features and deployment failures.
 */
export class PlatformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformError";
  }
}
