// @celsian/cli — celsian routes command

import { logger } from "../utils/logger.js";

export async function routesCommand(entry?: string): Promise<void> {
  const entryPath = entry ?? "src/index.ts";

  try {
    const mod = await import(`${process.cwd()}/${entryPath}`);
    const app = mod.default ?? mod.app;

    if (!app || typeof app.getRoutes !== "function") {
      logger.error('Could not find a CelsianApp export. Export your app as default or named "app".');
      return;
    }

    const routes = app.getRoutes();

    if (routes.length === 0) {
      logger.info("No routes registered.");
      return;
    }

    // Print as table
    const methodWidth = 7;
    const urlWidth = Math.max(4, ...routes.map((r: { url: string }) => r.url.length));

    console.log("");
    console.log(`  ${"METHOD".padEnd(methodWidth)}  ${"URL".padEnd(urlWidth)}  KIND`);
    console.log(`  ${"─".repeat(methodWidth)}  ${"─".repeat(urlWidth)}  ${"─".repeat(10)}`);

    for (const route of routes) {
      console.log(`  ${route.method.padEnd(methodWidth)}  ${route.url.padEnd(urlWidth)}  ${route.kind}`);
    }

    console.log("");
    logger.dim(`  ${routes.length} route${routes.length === 1 ? "" : "s"} registered`);
  } catch (error) {
    logger.error(`Failed to load app: ${error instanceof Error ? error.message : error}`);
  }
}
