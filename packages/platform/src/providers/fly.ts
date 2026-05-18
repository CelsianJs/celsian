// @celsian/platform — Fly.io deployment provider

import { execSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PlatformError } from "../errors.js";

export interface FlyDeployOptions {
  /** Working directory (default: process.cwd()) */
  cwd?: string;
  /** Fly.io app name */
  appName?: string;
  /** Primary region (default: 'iad') */
  primaryRegion?: string;
}

const FLY_TOML = `app = "my-celsian-api"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  PORT = "3000"
  HOST = "0.0.0.0"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = true
  auto_start_machines = true
  min_machines_running = 0

[[http_service.checks]]
  grace_period = "10s"
  interval = "30s"
  method = "GET"
  path = "/health"
  timeout = "5s"
`;

const DOCKERFILE = `FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* pnpm-lock.yaml* ./
RUN \\
  if [ -f pnpm-lock.yaml ]; then corepack enable && pnpm install --frozen-lockfile; \\
  elif [ -f package-lock.json ]; then npm ci; \\
  else npm install; fi
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
RUN addgroup --system --gid 1001 celsian && \\
    adduser --system --uid 1001 celsian
USER celsian
COPY --from=builder --chown=celsian:celsian /app/dist ./dist
COPY --from=builder --chown=celsian:celsian /app/package.json ./
COPY --from=builder --chown=celsian:celsian /app/node_modules ./node_modules
EXPOSE 3000
CMD ["node", "dist/index.js"]
`;

const DOCKERIGNORE = `node_modules
dist
.git
*.md
.env*
`;

/**
 * Deploy a CelsianJS app to Fly.io.
 *
 * 1. Generates fly.toml + Dockerfile if not present
 * 2. Runs `flyctl deploy`
 */
export async function deployFly(opts: FlyDeployOptions = {}): Promise<{ url: string }> {
  const cwd = opts.cwd ?? process.cwd();

  // Check if flyctl is available
  try {
    execSync("flyctl version", { cwd, stdio: "pipe" });
  } catch {
    throw new PlatformError("flyctl CLI not found. Install it from: https://fly.io/docs/hands-on/install-flyctl/");
  }

  // Generate fly.toml if not present
  const flyTomlPath = resolve(cwd, "fly.toml");
  if (!existsSync(flyTomlPath)) {
    let toml = FLY_TOML;
    if (opts.appName) {
      toml = toml.replace("my-celsian-api", opts.appName);
    }
    if (opts.primaryRegion) {
      toml = toml.replace('"iad"', `"${opts.primaryRegion}"`);
    }
    writeFileSync(flyTomlPath, toml, "utf-8");
    console.log("[celsian:deploy] Generated fly.toml");
  }

  // Generate Dockerfile if not present
  const dockerfilePath = resolve(cwd, "Dockerfile");
  if (!existsSync(dockerfilePath)) {
    writeFileSync(dockerfilePath, DOCKERFILE, "utf-8");
    console.log("[celsian:deploy] Generated Dockerfile");
  }

  // Generate .dockerignore if not present
  const dockerignorePath = resolve(cwd, ".dockerignore");
  if (!existsSync(dockerignorePath)) {
    writeFileSync(dockerignorePath, DOCKERIGNORE, "utf-8");
    console.log("[celsian:deploy] Generated .dockerignore");
  }

  // Deploy via flyctl
  console.log("[celsian:deploy] Deploying to Fly.io...");
  try {
    execSync("flyctl deploy", { cwd, stdio: "inherit" });
    // Try to get the app URL
    try {
      const info = execSync("flyctl info --json", { cwd, encoding: "utf-8", stdio: "pipe" });
      const parsed = JSON.parse(info);
      const hostname = parsed?.App?.Hostname ?? parsed?.Hostname;
      if (hostname) {
        const url = `https://${hostname}`;
        console.log(`[celsian:deploy] Deployed to ${url}`);
        return { url };
      }
    } catch {
      // Couldn't parse info, return generic URL
    }
    const appName = opts.appName ?? "my-celsian-api";
    const url = `https://${appName}.fly.dev`;
    console.log(`[celsian:deploy] Deployed to ${url}`);
    return { url };
  } catch (error) {
    throw new PlatformError(`Fly.io deployment failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
