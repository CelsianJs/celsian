// @celsian/cli: celsian dev command

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../utils/logger.js";

export interface DevOptions {
  entry?: string;
  port?: number;
  host?: string;
  /** Env file to load into the child process. Default: ".env". */
  envFile?: string;
}

export async function devCommand(options: DevOptions = {}): Promise<void> {
  const entry = options.entry ?? "src/index.ts";
  const cwd = process.cwd();
  const entryPath = resolve(cwd, entry);
  const envFile = options.envFile ?? ".env";
  const envFilePath = resolve(cwd, envFile);
  // Load .env exactly the way the scaffold's own `npm run dev` does, via Node's
  // --env-file (tsx forwards it). Without this, `celsian dev` and `npm run dev`
  // behave differently and a scaffolded project silently falls back to its
  // placeholder JWT_SECRET. Real environment variables still win: Node's
  // --env-file never overwrites a variable that is already set.
  const hasEnvFile = existsSync(envFilePath);
  // An explicitly requested env file that does not exist is a user error, not
  // something to silently ignore.
  if (!hasEnvFile && options.envFile) {
    logger.error(`Env file not found: ${envFile}`);
    return;
  }

  // Fail with a clear, actionable message before spawning tsx: otherwise a
  // missing entry (wrong directory, or a project using `server.ts`) surfaces as
  // a raw "Cannot find module" stack trace from tsx. Mirrors `celsian routes`.
  if (!existsSync(entryPath)) {
    logger.error(`Entry file not found: ${entry}`);
    logger.dim("Usage: celsian dev [--entry <file>] (default: src/index.ts)");
    return;
  }

  logger.info(`Starting dev server: ${entry}`);
  if (hasEnvFile) {
    logger.dim(`  Loading environment from ${envFile}`);
  }

  let child: ChildProcess | null = null;
  let restarting = false;

  function start(): void {
    const env = {
      ...process.env,
      ...(options.port ? { PORT: String(options.port) } : {}),
      ...(options.host ? { HOST: options.host } : {}),
    };

    // Use tsx for TypeScript execution
    const tsxArgs = hasEnvFile ? ["tsx", `--env-file=${envFilePath}`, entryPath] : ["tsx", entryPath];
    child = spawn("npx", tsxArgs, {
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
