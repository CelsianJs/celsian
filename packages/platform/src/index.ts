/**
 * @celsian/platform — Deployment orchestration for the Celsian platform.
 *
 * Provides provider-agnostic deployment logic extracted from the ThenJS CLI.
 * Supported providers: Cloudflare Workers, AWS Lambda, Fly.io.
 */

export { deployCfWorker } from './providers/cloudflare.js';
export { deployLambda } from './providers/lambda.js';
export { deployFly } from './providers/fly.js';
export { REQ_REPLY_SHIM } from './shim.js';
