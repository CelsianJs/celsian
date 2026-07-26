// @celsian/cli -- celsian routes command

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { AppProbeError, probeApp } from "../utils/app-entry.js";
import { logger } from "../utils/logger.js";

export async function routesCommand(entry?: string): Promise<void> {
  const entryPath = entry ?? "src/index.ts";
  const cwd = process.cwd();
  const fullEntry = resolve(cwd, entryPath);

  if (!existsSync(fullEntry)) {
    logger.error(`Entry file not found: ${entryPath}`);
    logger.dim("Usage: celsian routes [entry] (default: src/index.ts)");
    return;
  }

  let routes: Array<{ method: string; url: string; kind: string }>;
  try {
    routes = probeApp(fullEntry, cwd).routes;
  } catch (error) {
    if (!(error instanceof AppProbeError)) throw error;
    switch (error.failure.reason) {
      case "no-app":
        logger.error('Could not find a CelsianApp export. Export your app as default or named "app".');
        return;
      case "bad-output":
        logger.error("Failed to parse route data from app. Make sure your app exports routes via getRoutes().");
        return;
      default:
        logger.error(`Failed to load app from ${entryPath}:`);
        console.error(error.failure.detail);
        return;
    }
  }

  if (routes.length === 0) {
    logger.info("No routes registered.");
    return;
  }

  // Print as table
  const methodWidth = 7;
  const urlWidth = Math.max(4, ...routes.map((r) => r.url.length));

  console.log("");
  console.log(`  ${"METHOD".padEnd(methodWidth)}  ${"URL".padEnd(urlWidth)}  KIND`);
  console.log(`  ${"─".repeat(methodWidth)}  ${"─".repeat(urlWidth)}  ${"─".repeat(10)}`);

  for (const route of routes) {
    console.log(`  ${route.method.padEnd(methodWidth)}  ${route.url.padEnd(urlWidth)}  ${route.kind}`);
  }

  console.log("");
  logger.dim(`  ${routes.length} route${routes.length === 1 ? "" : "s"} registered`);
}
