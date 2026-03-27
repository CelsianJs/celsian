import { PlatformError } from "../errors.js";

/**
 * AWS Lambda deployment provider.
 *
 * Handles bundling per-route Lambda functions and deploying via AWS SDK.
 *
 * TODO: Extract full implementation from ThenJS CLI deploy command.
 */

export interface LambdaDeployOptions {
  /** AWS region (default: us-east-1) */
  region?: string;
  /** Function name prefix */
  stackPrefix: string;
  /** Bundled function code per route */
  bundles: LambdaBundle[];
}

export interface LambdaBundle {
  name: string;
  code: string;
  methods: string[];
  urlPattern: string;
}

/**
 * Deploy bundled Lambda functions to AWS.
 */
export async function deployLambda(_opts: LambdaDeployOptions): Promise<{ apiUrl: string }> {
  // TODO: Implement — create/update Lambda functions, configure API Gateway
  throw new PlatformError("@celsian/platform: Lambda deployment not yet implemented");
}
