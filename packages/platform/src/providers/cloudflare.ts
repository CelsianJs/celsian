import { PlatformError } from "../errors.js";

/**
 * Cloudflare Workers deployment provider.
 *
 * Handles bundling route handlers into a single CF Worker script and
 * uploading via the Cloudflare API.
 *
 * TODO: Extract full implementation from ThenJS CLI deploy command.
 */

export interface CfDeployOptions {
  /** Cloudflare account ID */
  accountId: string;
  /** Cloudflare API token with Workers Scripts:Edit permission */
  apiToken: string;
  /** Worker name (derived from project name) */
  workerName: string;
  /** Bundled worker script content */
  workerScript: string;
}

/**
 * Deploy a bundled worker script to Cloudflare Workers.
 */
export async function deployCfWorker(_opts: CfDeployOptions): Promise<{ url: string }> {
  // TODO: Implement — upload via CF API, enable workers.dev subdomain
  throw new PlatformError("@celsian/platform: Cloudflare deployment not yet implemented");
}
