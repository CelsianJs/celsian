// @celsian/cli — celsian routes command

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { logger } from "../utils/logger.js";

const NO_APP_MARKER = "__CELSIAN_NO_APP__";
const ROUTES_MARKER = "__CELSIAN_ROUTES__:";

export async function routesCommand(entry?: string): Promise<void> {
  const entryPath = entry ?? "src/index.ts";
  const cwd = process.cwd();
  const fullEntry = resolve(cwd, entryPath);

  if (!existsSync(fullEntry)) {
    logger.error(`Entry file not found: ${entryPath}`);
    logger.dim("Usage: celsian routes [entry] (default: src/index.ts)");
    return;
  }

  // Loader script that tsx executes: imports the user's app entry, extracts
  // routes, and prints them as a marked JSON line on stdout.
  //
  // Written to a temp .mts file rather than passed via `tsx --eval`, because
  // --eval compiles to CJS, which rejects the top-level await needed here
  // ("Top-level await is currently not supported with the cjs output format").
  const loaderScript = `const mod = await import(${JSON.stringify(`file://${fullEntry}`)});
const app = mod.default ?? mod.app;
if (!app || typeof app.getRoutes !== 'function') {
  console.error(${JSON.stringify(NO_APP_MARKER)});
  process.exit(1);
}
console.log(${JSON.stringify(ROUTES_MARKER)} + JSON.stringify(app.getRoutes()));
// The entry may have called serve(app), leaving a listening server that keeps
// the event loop alive — exit explicitly now that the route data is printed.
process.exit(0);
`;

  const tmpDir = mkdtempSync(join(tmpdir(), "celsian-routes-"));
  const loaderPath = join(tmpDir, "load-routes.mts");

  let output: string;
  try {
    writeFileSync(loaderPath, loaderScript, "utf-8");
    output = execFileSync("npx", ["tsx", loaderPath], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30_000,
      // If the entry calls serve(), bind an ephemeral port so route listing
      // never fails with EADDRINUSE while the real dev server is running.
      env: { ...process.env, PORT: "0" },
    });
  } catch (error) {
    const err = error as Error & { stderr?: string; stdout?: string };
    const stderr = err.stderr ?? "";
    if (stderr.includes(NO_APP_MARKER)) {
      logger.error('Could not find a CelsianApp export. Export your app as default or named "app".');
    } else {
      logger.error(`Failed to load app from ${entryPath}:`);
      const detail = stderr.trim() || err.message;
      console.error(detail);
    }
    return;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  // Find our marked JSON line; other lines may be console output from the
  // user's app initialization.
  const jsonLine = output
    .split("\n")
    .reverse()
    .find((line) => line.startsWith(ROUTES_MARKER));

  let routes: Array<{ method: string; url: string; kind: string }>;
  try {
    if (!jsonLine) throw new Error("no route data in output");
    routes = JSON.parse(jsonLine.slice(ROUTES_MARKER.length));
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
}
