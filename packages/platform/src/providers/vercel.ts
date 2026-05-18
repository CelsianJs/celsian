// @celsian/platform — Vercel deployment provider

import { execSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PlatformError } from "../errors.js";

export interface VercelDeployOptions {
  /** Working directory (default: process.cwd()) */
  cwd?: string;
  /** Deploy to production (default: false — deploys to preview) */
  production?: boolean;
}

const VERCEL_JSON = `{
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/api" }
  ]
}
`;

/**
 * Deploy a CelsianJS app to Vercel.
 *
 * 1. Generates vercel.json if not present
 * 2. Runs `npx vercel deploy`
 */
export async function deployVercel(opts: VercelDeployOptions = {}): Promise<{ url: string }> {
  const cwd = opts.cwd ?? process.cwd();

  // Check if vercel CLI is available
  try {
    execSync("npx vercel --version", { cwd, stdio: "pipe" });
  } catch {
    throw new PlatformError(
      "Vercel CLI not found. Install it with: npm install -g vercel",
    );
  }

  // Generate vercel.json if not present
  const vercelJsonPath = resolve(cwd, "vercel.json");
  if (!existsSync(vercelJsonPath)) {
    writeFileSync(vercelJsonPath, VERCEL_JSON, "utf-8");
    console.log("[celsian:deploy] Generated vercel.json");
  }

  // Deploy via vercel
  const prodFlag = opts.production ? " --prod" : "";
  console.log(`[celsian:deploy] Deploying to Vercel${opts.production ? " (production)" : " (preview)"}...`);
  try {
    const output = execSync(`npx vercel deploy${prodFlag}`, {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
    });
    // Vercel CLI outputs the deployment URL as the last line
    const lines = output.trim().split("\n");
    const url = lines[lines.length - 1]?.trim() ?? "https://<project>.vercel.app";
    console.log(`[celsian:deploy] Deployed to ${url}`);
    return { url };
  } catch (error) {
    throw new PlatformError(
      `Vercel deployment failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
