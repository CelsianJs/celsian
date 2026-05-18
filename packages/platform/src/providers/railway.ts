// @celsian/platform — Railway deployment provider

import { execSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PlatformError } from "../errors.js";

export interface RailwayDeployOptions {
  /** Working directory (default: process.cwd()) */
  cwd?: string;
}

const RAILWAY_JSON = `{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS"
  },
  "deploy": {
    "startCommand": "node dist/index.js",
    "healthcheckPath": "/health",
    "healthcheckTimeout": 10,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3
  }
}
`;

const PROCFILE = `web: node dist/index.js
`;

/**
 * Deploy a CelsianJS app to Railway.
 *
 * 1. Generates railway.json + Procfile if not present
 * 2. Runs `railway up`
 */
export async function deployRailway(opts: RailwayDeployOptions = {}): Promise<{ url: string }> {
  const cwd = opts.cwd ?? process.cwd();

  // Check if railway CLI is available
  try {
    execSync("railway version", { cwd, stdio: "pipe" });
  } catch {
    throw new PlatformError("Railway CLI not found. Install it with: npm install -g @railway/cli");
  }

  // Generate railway.json if not present
  const railwayJsonPath = resolve(cwd, "railway.json");
  if (!existsSync(railwayJsonPath)) {
    writeFileSync(railwayJsonPath, RAILWAY_JSON, "utf-8");
    console.log("[celsian:deploy] Generated railway.json");
  }

  // Generate Procfile if not present
  const procfilePath = resolve(cwd, "Procfile");
  if (!existsSync(procfilePath)) {
    writeFileSync(procfilePath, PROCFILE, "utf-8");
    console.log("[celsian:deploy] Generated Procfile");
  }

  // Deploy via railway
  console.log("[celsian:deploy] Deploying to Railway...");
  try {
    const output = execSync("railway up", { cwd, encoding: "utf-8", stdio: "pipe" });
    // Try to extract URL from railway output
    const urlMatch = output.match(/https:\/\/[^\s]+\.up\.railway\.app/);
    const url = urlMatch?.[0] ?? "https://<project>.up.railway.app";
    console.log(`[celsian:deploy] Deployed to ${url}`);
    return { url };
  } catch (error) {
    throw new PlatformError(`Railway deployment failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
