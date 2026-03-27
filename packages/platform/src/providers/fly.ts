import { PlatformError } from "../errors.js";

/**
 * Fly.io deployment provider.
 *
 * Handles deploying CelsianJS apps to Fly.io via the Fly Machines API.
 *
 * TODO: Implement Fly.io deployment.
 */

export interface FlyDeployOptions {
  /** Fly.io API token */
  apiToken: string;
  /** App name on Fly.io */
  appName: string;
  /** Docker image or build context */
  image?: string;
  /** Fly.io region(s) */
  regions?: string[];
}

/**
 * Deploy to Fly.io.
 */
export async function deployFly(_opts: FlyDeployOptions): Promise<{ url: string }> {
  // TODO: Implement — Fly Machines API deployment
  throw new PlatformError("@celsian/platform: Fly.io deployment not yet implemented");
}
