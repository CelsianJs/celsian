// @celsian/cli — celsian dev command

import { type ChildProcess, spawn } from "node:child_process";
import { watch } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../utils/logger.js";

export interface DevOptions {
  entry?: string;
  port?: number;
  host?: string;
}

export async function devCommand(options: DevOptions = {}): Promise<void> {
  const entry = options.entry ?? "src/index.ts";
  const cwd = process.cwd();
  const entryPath = resolve(cwd, entry);

  logger.info(`Starting dev server: ${entry}`);

  let child: ChildProcess | null = null;
  let restarting = false;

  function start(): void {
    const env = {
      ...process.env,
      ...(options.port ? { PORT: String(options.port) } : {}),
      ...(options.host ? { HOST: options.host } : {}),
    };

    // Use tsx for TypeScript execution
    child = spawn("npx", ["tsx", entryPath], {
      cwd,
      stdio: "inherit",
      env,
    });

    child.on("exit", (code) => {
      if (!restarting) {
        if (code !== 0 && code !== null) {
          logger.error(`Process exited with code ${code}`);
        }
      }
    });
  }

  function restart(): void {
    if (restarting) return;
    restarting = true;

    logger.dim("Restarting...");

    if (child) {
      child.kill("SIGTERM");
      child.on("exit", () => {
        restarting = false;
        start();
      });
    } else {
      restarting = false;
      start();
    }
  }

  // Watch for file changes
  const srcDir = resolve(cwd, "src");
  try {
    const watcher = watch(srcDir, { recursive: true }, (_event, filename) => {
      if (filename && (filename.endsWith(".ts") || filename.endsWith(".js"))) {
        restart();
      }
    });

    process.on("SIGINT", () => {
      watcher.close();
      child?.kill("SIGTERM");
      process.exit(0);
    });
  } catch {
    logger.warn("File watching not available, running without auto-restart");
  }

  start();
}
