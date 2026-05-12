// @celsian/cli — celsian routes command

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { logger } from "../utils/logger.js";

export async function routesCommand(entry?: string): Promise<void> {
  const entryPath = entry ?? "src/index.ts";
  const cwd = process.cwd();
  const fullEntry = resolve(cwd, entryPath);

  // Inline script that tsx will execute: imports the user's app entry,
  // extracts routes, and prints them as JSON to stdout.
  const loaderScript = `
    const mod = await import(${JSON.stringify("file://" + fullEntry)});
    const app = mod.default ?? mod.app;
    if (!app || typeof app.getRoutes !== 'function') {
      console.error('__CELSIAN_NO_APP__');
      process.exit(1);
    }
    const routes = app.getRoutes();
    console.log(JSON.stringify(routes));
  `;

  try {
    const result = execFileSync("npx", ["tsx", "--eval", loaderScript], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15_000,
    });

    let routes: Array<{ method: string; url: string; kind: string }>;
    try {
      // The last non-empty line is our JSON output; earlier lines may be
      // console output from the user's app initialization.
      const lines = result.trim().split("\n");
      const jsonLine = lines[lines.length - 1];
      routes = JSON.parse(jsonLine);
    } catch {
      logger.error("Failed to parse route data from app. Make sure your app exports routes via getRoutes().");
      return;
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
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("__CELSIAN_NO_APP__")) {
      logger.error('Could not find a CelsianApp export. Export your app as default or named "app".');
    } else {
      logger.error(`Failed to load app: ${msg}`);
    }
  }
}
