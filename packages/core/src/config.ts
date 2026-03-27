// @celsian/core — Configuration

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

const DEFAULT_CONFIG: CelsianConfig = {
  server: {
    port: 3000,
    host: "localhost",
    trustProxy: false,
  },
  schema: {
    provider: "auto",
  },
};

export async function loadConfig(root: string = process.cwd()): Promise<CelsianConfig> {
  const configFiles = ["celsian.config.ts", "celsian.config.js", "celsian.config.mjs"];

  for (const file of configFiles) {
    const configPath = `${root}/${file}`;
    try {
      const mod = await import(configPath);
      const userConfig = mod.default || mod;
      return mergeConfig(DEFAULT_CONFIG, userConfig);
    } catch {
      // File doesn't exist, try next
    }
  }

  return { ...DEFAULT_CONFIG };
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
