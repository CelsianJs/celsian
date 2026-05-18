/**
 * @celsian/platform — Deployment orchestration for the Celsian platform.
 *
 * Provides provider-agnostic deployment logic.
 * Supported providers: Cloudflare Workers, AWS Lambda, Fly.io, Vercel, Railway.
 */

export { PlatformError } from "./errors.js";
export { deployCfWorker } from "./providers/cloudflare.js";
export { deployFly } from "./providers/fly.js";
export { deployLambda } from "./providers/lambda.js";
export { deployRailway } from "./providers/railway.js";
export { deployVercel } from "./providers/vercel.js";
export { REQ_REPLY_SHIM } from "./shim.js";
