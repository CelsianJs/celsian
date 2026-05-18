// @celsian/platform — Cloudflare Workers deployment provider

import { execSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PlatformError } from "../errors.js";

export interface CfDeployOptions {
  /** Working directory (default: process.cwd()) */
  cwd?: string;
  /** App entry point (default: src/index.ts) */
  entry?: string;
  /** Worker name */
  workerName?: string;
}

const WRANGLER_TOML = `name = "my-celsian-api"
main = "dist/worker.js"
compatibility_date = "2024-01-01"

# Uncomment to add KV namespaces, D1 databases, etc.
# [[kv_namespaces]]
# binding = "MY_KV"
# id = ""
`;

/**
 * Deploy a CelsianJS app to Cloudflare Workers.
 *
 * 1. Generates wrangler.toml if not present
 * 2. Builds the app
 * 3. Runs `npx wrangler deploy`
 */
export async function deployCfWorker(opts: CfDeployOptions = {}): Promise<{ url: string }> {
  const cwd = opts.cwd ?? process.cwd();

  // Check if wrangler is available
  try {
    execSync("npx wrangler --version", { cwd, stdio: "pipe" });
  } catch {
    throw new PlatformError(
      "wrangler CLI not found. Install it with: npm install -D wrangler",
    );
  }

  // Generate wrangler.toml if not present
  const wranglerPath = resolve(cwd, "wrangler.toml");
  if (!existsSync(wranglerPath)) {
    const toml = opts.workerName
      ? WRANGLER_TOML.replace("my-celsian-api", opts.workerName)
      : WRANGLER_TOML;
    writeFileSync(wranglerPath, toml, "utf-8");
    console.log("[celsian:deploy] Generated wrangler.toml");
  }

  // Build the app
  console.log("[celsian:deploy] Building app...");
  try {
    execSync("npx celsian build --platform browser", { cwd, stdio: "inherit" });
  } catch {
    throw new PlatformError("Build failed. Fix build errors and try again.");
  }

  // Deploy via wrangler
  console.log("[celsian:deploy] Deploying to Cloudflare Workers...");
  try {
    const output = execSync("npx wrangler deploy", { cwd, encoding: "utf-8", stdio: "pipe" });
    // Try to extract the URL from wrangler output
    const urlMatch = output.match(/https:\/\/[^\s]+\.workers\.dev/);
    const url = urlMatch?.[0] ?? "https://<worker-name>.workers.dev";
    console.log(`[celsian:deploy] Deployed to ${url}`);
    return { url };
  } catch (error) {
    throw new PlatformError(
      `Cloudflare deployment failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
