// @celsian/core — Configuration

import { CelsianError } from "./errors.js";

/**
 * Thrown when a `celsian.config.*` file exists but fails to load (syntax error,
 * a missing import it depends on, or a runtime throw during module evaluation).
 * A genuinely absent config file is NOT an error — it falls back to defaults.
 */
export class ConfigLoadError extends CelsianError {
  constructor(file: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to load config file "${file}": ${detail}`);
    this.name = "ConfigLoadError";
    if (cause instanceof Error) this.cause = cause;
  }
}

export interface CelsianConfig {
  server?: {
    port?: number;
    host?: string;
    trustProxy?: boolean;
    prefix?: string;
  };
  schema?: {
    provider?: "typebox" | "zod" | "valibot" | "auto";
  };
  rpc?: {
    basePath?: string;
    openapi?: {
      title?: string;
      version?: string;
      description?: string;
    };
  };
}

export function defineConfig(config: CelsianConfig): CelsianConfig {
  return config;
}

/**
 * Resolve the default bind host.
 *
 * Honors `process.env.HOST` first. Otherwise binds `0.0.0.0` in production
 * (containers — Docker/Fly/Railway — must accept external connections) and
 * `localhost` in development (avoid exposing the dev server on the LAN).
 */
export function defaultHost(): string {
  const envHost = typeof process !== "undefined" ? process.env?.HOST : undefined;
  if (envHost) return envHost;
  const nodeEnv = typeof process !== "undefined" ? process.env?.NODE_ENV : undefined;
  return nodeEnv === "production" ? "0.0.0.0" : "localhost";
}

function buildDefaultConfig(): CelsianConfig {
  return {
    server: {
      port: 3000,
      host: defaultHost(),
      trustProxy: false,
    },
    schema: {
      provider: "auto",
    },
  };
}

export async function loadConfig(root: string = process.cwd()): Promise<CelsianConfig> {
  const configFiles = ["celsian.config.ts", "celsian.config.js", "celsian.config.mjs"];
  const defaults = buildDefaultConfig();

  for (const file of configFiles) {
    const configPath = `${root}/${file}`;
    try {
      const mod = await import(configPath);
      const userConfig = mod.default || mod;
      return mergeConfig(defaults, userConfig);
    } catch (err) {
      if (isConfigFileAbsent(err, configPath, file)) {
        // No config file with this name here — try the next candidate.
        continue;
      }
      // The config file exists but blew up while loading (syntax/runtime error
      // or a missing import it depends on). Surface it instead of silently
      // falling back to defaults, which hides the user's settings.
      throw new ConfigLoadError(file, err);
    }
  }

  return defaults;
}

/**
 * Distinguish "this config file does not exist" (skip, use defaults) from
 * "this config file exists but failed to load" (surface the error). Only a
 * module-not-found whose missing specifier IS the config file itself counts as
 * absent — a missing *transitive* import inside a real config must surface.
 */
function isConfigFileAbsent(err: unknown, configPath: string, file: string): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string }).code;
  const message = (err as { message?: string }).message ?? "";
  const notFound =
    code === "ERR_MODULE_NOT_FOUND" ||
    code === "ENOENT" ||
    code === "ERR_LOAD_URL" || // Deno
    /module not found|cannot find module|no such file/i.test(message);
  if (!notFound) return false;
  // Only treat as absent when the *missing specifier itself* is our config file
  // — NOT when a transitive import the config depends on is missing (whose error
  // message also names the config file as the importer, e.g.
  // "Cannot find module '<dep>' imported from '<configPath>'").
  const missingSpecifier = message.match(/['"]([^'"]+)['"]/)?.[1] ?? "";
  const errPath = (err as { path?: string }).path ?? ""; // ENOENT carries fs path
  return (
    missingSpecifier === configPath ||
    missingSpecifier.endsWith(`/${file}`) ||
    missingSpecifier.endsWith(`\\${file}`) ||
    errPath.endsWith(file)
  );
}

function mergeConfig(base: CelsianConfig, override: CelsianConfig): CelsianConfig {
  const result: CelsianConfig = { ...base };

  if (override.server) {
    result.server = { ...base.server, ...override.server };
  }
  if (override.schema) {
    result.schema = { ...base.schema, ...override.schema };
  }
  if (override.rpc) {
    result.rpc = {
      ...base.rpc,
      ...override.rpc,
      openapi: { ...base.rpc?.openapi, ...override.rpc?.openapi },
    };
  }

  return result;
}
