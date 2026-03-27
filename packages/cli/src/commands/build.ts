// @celsian/cli — celsian build command

import { relative, resolve } from "node:path";
import { logger } from "../utils/logger.js";

export interface BuildOptions {
  entry: string;
  outdir: string;
  format: string;
  target: string;
  minify: boolean;
  platform: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export async function buildCommand(options: BuildOptions): Promise<void> {
  const cwd = process.cwd();
  const entryPath = resolve(cwd, options.entry);
  const outdir = resolve(cwd, options.outdir);

  logger.info(`Building ${relative(cwd, entryPath)}`);
  logger.dim(
    `  format: ${options.format}  target: ${options.target}  platform: ${options.platform}${options.minify ? "  minify: on" : ""}`,
  );

  let esbuild: typeof import("esbuild");
  try {
    esbuild = await import("esbuild");
  } catch {
    logger.error("esbuild is required but not installed. Run: pnpm add -D esbuild");
    process.exit(1);
  }

  const startTime = performance.now();

  try {
    const result = await esbuild.build({
      entryPoints: [entryPath],
      outdir,
      bundle: true,
      format: options.format as "esm" | "cjs" | "iife",
      target: options.target,
      platform: options.platform as "node" | "browser" | "neutral",
      minify: options.minify,
      external: ["node:*"],
      metafile: true,
      logLevel: "silent",
    });

    const elapsed = performance.now() - startTime;

    // Gather output file info
    const outputs = Object.entries(result.metafile?.outputs);
    if (outputs.length === 0) {
      logger.warn("Build produced no output files.");
      return;
    }

    console.log("");
    for (const [file, meta] of outputs) {
      const relPath = relative(cwd, resolve(cwd, file));
      const size = formatBytes(meta.bytes);
      logger.success(`${relPath}  ${size}`);
    }

    console.log("");
    logger.dim(`  Done in ${elapsed.toFixed(0)}ms`);

    if (result.warnings.length > 0) {
      console.log("");
      for (const warning of result.warnings) {
        logger.warn(`${warning.text}`);
      }
    }
  } catch (error) {
    if (error && typeof error === "object" && "errors" in error) {
      const buildError = error as { errors: Array<{ text: string; location?: { file?: string; line?: number } }> };
      for (const err of buildError.errors) {
        const loc = err.location ? ` (${err.location.file}:${err.location.line})` : "";
        logger.error(`${err.text}${loc}`);
      }
    } else {
      logger.error(`Build failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(1);
  }
}
