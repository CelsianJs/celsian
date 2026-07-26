// @celsian/cli: Deploy command: generates config files and deploys to platform CLIs

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { AppProbeError, findDefaultEntry, probeApp } from "../utils/app-entry.js";
import { logger } from "../utils/logger.js";

export type DeployTarget = "vercel" | "lambda" | "cloudflare" | "fly" | "railway" | "docker";

const VALID_TARGETS: DeployTarget[] = ["vercel", "lambda", "cloudflare", "fly", "railway", "docker"];

// -- Auto-detection from existing config files ----------------------------------

const CONFIG_DETECTION: Array<[string, DeployTarget]> = [
  ["wrangler.toml", "cloudflare"],
  ["fly.toml", "fly"],
  ["vercel.json", "vercel"],
  ["railway.json", "railway"],
  ["template.yaml", "lambda"],
];

function autoDetectPlatform(): DeployTarget | null {
  const cwd = process.cwd();
  for (const [file, target] of CONFIG_DETECTION) {
    if (existsSync(resolve(cwd, file))) {
      return target;
    }
  }
  return null;
}

// -- CLI tool availability check -----------------------------------------------

function isCliAvailable(command: string): boolean {
  try {
    execSync(command, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// -- Discovering the user's app ---------------------------------------------------

/**
 * How the generated entrypoint should import the user's app. Discovered by
 * loading the entry the same way `celsian routes` does, so the generated file
 * wires up the real app instead of an empty placeholder.
 */
export interface AppImport {
  /** Module specifier to import from, relative to the generated file. */
  specifier: string;
  /** Whether the app is the default export or the named `app` export. */
  exportName: "default" | "app";
}

/** Fallback used when the app could not be loaded (see `resolveAppImport`). */
const FALLBACK_APP_IMPORT: AppImport = { specifier: "../src/index.js", exportName: "app" };

/**
 * Build the import statement for the user's app.
 * `generatedDir` is the directory the generated file lives in, relative to cwd.
 */
export function renderAppImport(app: AppImport): string {
  const binding = app.exportName === "default" ? "app" : "{ app }";
  return `import ${binding} from ${JSON.stringify(app.specifier)};`;
}

/**
 * Turn an absolute entry path into a specifier relative to the generated file,
 * rewritten to the `.js` extension that ESM/NodeNext resolution expects.
 */
function toSpecifier(entryPath: string, generatedFileDir: string): string {
  let rel = relative(generatedFileDir, entryPath).split("\\").join("/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel.replace(/\.(ts|mts|tsx)$/, ".js");
}

/**
 * Locate the user's app entry and determine how to import it. Falls back to a
 * conventional `../src/index.js` named-`app` import (with a warning) when the
 * entry cannot be found or loaded, so `celsian deploy` still produces a file
 * the user can fix by hand.
 */
function resolveAppImport(cwd: string, generatedRelPath: string): AppImport {
  const generatedFileDir = dirname(resolve(cwd, generatedRelPath));

  const entryPath = findDefaultEntry(cwd);
  if (!entryPath) {
    logger.warn("Could not find an app entry (looked for src/index.ts, src/app.ts, src/server.ts, index.ts).");
    logger.dim("  The generated handler imports ../src/index.js -- adjust it to your entry point.");
    return FALLBACK_APP_IMPORT;
  }

  const specifier = toSpecifier(entryPath, generatedFileDir);

  try {
    const { exportName } = probeApp(entryPath, cwd);
    return { specifier, exportName };
  } catch (error) {
    if (!(error instanceof AppProbeError)) throw error;
    if (error.failure.reason === "no-app") {
      logger.warn(`No CelsianApp export found in ${relative(cwd, entryPath)}.`);
      logger.dim('  Export your app as default or named "app". Assuming a named "app" export for now.');
    } else {
      logger.warn(`Could not load ${relative(cwd, entryPath)} to detect its app export.`);
      logger.dim('  Assuming a named "app" export -- check the generated handler before deploying.');
    }
    return { specifier, exportName: "app" };
  }
}

/**
 * Warn when the discovered entry calls `serve()` at module scope: importing it
 * from a serverless handler would start a listening HTTP server on every cold
 * start (and fails outright on Cloudflare Workers).
 */
function warnIfEntryServes(cwd: string): void {
  const entryPath = findDefaultEntry(cwd);
  if (!entryPath) return;
  let source: string;
  try {
    source = readFileSync(entryPath, "utf-8");
  } catch {
    return;
  }
  // Unindented `serve(` means a top-level call. An indented one is inside some
  // guard (e.g. an entry-point check), which is exactly what we are asking for.
  if (!/^serve\s*\(/m.test(source)) return;
  console.log("");
  logger.warn(`${relative(cwd, entryPath)} calls serve() at module scope.`);
  logger.dim("  Serverless handlers import your entry, so serve() would start a server on every cold start.");
  logger.dim("  Guard it, e.g.: if (!process.env.VERCEL && !process.env.AWS_LAMBDA_FUNCTION_NAME) serve(app);");
}

// -- File templates per target --------------------------------------------------

const vercelIndex = (app: AppImport): string => `// Generated by: celsian deploy --platform vercel
// Imports the app exported from your entry file.

import { createVercelHandler } from "@celsian/adapter-vercel";
${renderAppImport(app)}

await app.ready();

export default createVercelHandler(app);
`;

const VERCEL_JSON = `{
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/api" }
  ]
}
`;

const lambdaHandler = (app: AppImport): string => `// Generated by: celsian deploy --platform lambda
// Imports the app exported from your entry file.

import { createLambdaHandler } from "@celsian/adapter-lambda";
${renderAppImport(app)}

await app.ready();

export const handler = createLambdaHandler(app);
`;

const LAMBDA_TEMPLATE_YAML = `AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Description: CelsianJS API deployed via AWS SAM

Globals:
  Function:
    Runtime: nodejs20.x
    MemorySize: 256
    Timeout: 30

Resources:
  ApiFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: dist/lambda.handler
      Events:
        ApiGateway:
          Type: HttpApi
          Properties:
            Path: /{proxy+}
            Method: ANY
`;

const cloudflareWorker = (app: AppImport): string => `// Generated by: celsian deploy --platform cloudflare
// Imports the app exported from your entry file.

import { createCloudflareHandler } from "@celsian/adapter-cloudflare";
${renderAppImport(app)}

export default createCloudflareHandler(app);
`;

const WRANGLER_TOML = `name = "my-celsian-api"
main = "worker.ts"
compatibility_date = "2026-01-01"
compatibility_flags = ["nodejs_compat"]

# Uncomment to add KV namespaces, D1 databases, etc.
# [[kv_namespaces]]
# binding = "MY_KV"
# id = ""
`;

const FLY_TOML = `app = "my-celsian-api"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

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
RUN addgroup -g 1001 -S celsian && adduser -S celsian -u 1001
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
USER celsian
EXPOSE 3000
CMD ["node", "dist/index.js"]
`;

const DOCKERIGNORE = `node_modules
dist
.git
*.md
.env*
`;

const RAILWAY_JSON = `{
  "$schema": "https://railway.com/railway.schema.json",
  "build": {
    "builder": "NIXPACKS"
  },
  "deploy": {
    "startCommand": "node dist/index.js",
    "healthcheckPath": "/health",
    "healthcheckTimeout": 300,
    "restartPolicyType": "ON_FAILURE"
  }
}
`;

const PROCFILE = `web: node dist/index.js
`;

// -- Target -> files mapping ----------------------------------------------------

/**
 * Files generated for a target. `resolveApp` is called only for targets whose
 * entrypoint imports the user's app, and receives the generated file's path so
 * the import specifier is relative to it.
 */
export function getFilesForTarget(
  target: DeployTarget,
  resolveApp: (generatedRelPath: string) => AppImport = () => FALLBACK_APP_IMPORT,
): Array<[string, string]> {
  switch (target) {
    case "vercel":
      return [
        ["api/index.ts", vercelIndex(resolveApp("api/index.ts"))],
        ["vercel.json", VERCEL_JSON],
      ];
    case "lambda":
      return [
        ["lambda.ts", lambdaHandler(resolveApp("lambda.ts"))],
        ["template.yaml", LAMBDA_TEMPLATE_YAML],
      ];
    case "cloudflare":
      return [
        ["worker.ts", cloudflareWorker(resolveApp("worker.ts"))],
        ["wrangler.toml", WRANGLER_TOML],
      ];
    case "fly":
      return [
        ["Dockerfile", DOCKERFILE],
        ["fly.toml", FLY_TOML],
        [".dockerignore", DOCKERIGNORE],
      ];
    case "railway":
      return [
        ["Dockerfile", DOCKERFILE],
        ["railway.json", RAILWAY_JSON],
        ["Procfile", PROCFILE],
      ];
    case "docker":
      return [
        ["Dockerfile", DOCKERFILE],
        [".dockerignore", DOCKERIGNORE],
      ];
  }
}

// -- Platform adapter packages ----------------------------------------------------

/** Celsian adapter package imported by the generated handler file, per target. */
export const ADAPTER_PACKAGES: Partial<Record<DeployTarget, string>> = {
  vercel: "@celsian/adapter-vercel",
  lambda: "@celsian/adapter-lambda",
  cloudflare: "@celsian/adapter-cloudflare",
};

// -- Platform CLI commands -------------------------------------------------------

interface PlatformCli {
  checkCmd: string;
  installHint: string;
  deployCmd: string;
}

const PLATFORM_CLIS: Partial<Record<DeployTarget, PlatformCli>> = {
  cloudflare: {
    checkCmd: "npx wrangler --version",
    installHint: "npm install -D wrangler",
    deployCmd: "npx wrangler deploy",
  },
  fly: {
    checkCmd: "flyctl version",
    installHint: "https://fly.io/docs/hands-on/install-flyctl/",
    deployCmd: "flyctl deploy",
  },
  lambda: {
    checkCmd: "sam --version",
    installHint: "https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html",
    deployCmd: "sam build && sam deploy --guided",
  },
  vercel: {
    checkCmd: "npx vercel --version",
    installHint: "npm install -g vercel",
    deployCmd: "npx vercel deploy",
  },
  railway: {
    checkCmd: "railway version",
    installHint: "npm install -g @railway/cli",
    deployCmd: "railway up",
  },
};

// -- Next-steps output ----------------------------------------------------------

const SERVERLESS_NOTE =
  "Note: Background tasks (app.task/app.enqueue) and cron jobs (app.cron) require a long-running server.\n      For serverless, use platform-native scheduling instead.";

function printNextSteps(target: DeployTarget, willDeploy: boolean): void {
  if (willDeploy) return; // Already deploying, no need for next-steps hints

  switch (target) {
    case "vercel":
      logger.info("Run `vercel deploy` to deploy. api/index.ts already imports your app.");
      console.log("");
      logger.dim(SERVERLESS_NOTE);
      break;
    case "lambda":
      logger.info("Run `sam build && sam deploy --guided`. lambda.ts already imports your app.");
      console.log("");
      logger.dim(SERVERLESS_NOTE);
      break;
    case "cloudflare":
      logger.info("Run `npx wrangler deploy`. worker.ts already imports your app.");
      console.log("");
      logger.dim(SERVERLESS_NOTE);
      break;
    case "fly":
      logger.info("Run `flyctl launch` then `flyctl deploy`.");
      break;
    case "railway":
      logger.info("Push to git, Railway auto-deploys. Or run `railway up`.");
      break;
    case "docker":
      logger.info("Run `docker build -t my-api .` then `docker run -p 3000:3000 my-api`.");
      break;
  }
}

// -- Main command ---------------------------------------------------------------

export async function deployCommand(targetOrNull: string | null, options?: { deploy?: boolean }): Promise<void> {
  let target = targetOrNull;

  // Auto-detect platform if not specified
  if (!target) {
    const detected = autoDetectPlatform();
    if (detected) {
      logger.info(`Auto-detected platform: ${detected}`);
      target = detected;
    } else {
      logger.error("No platform specified and none could be auto-detected.");
      logger.dim("Usage: celsian deploy --platform <vercel|lambda|cloudflare|fly|railway|docker>");
      logger.dim("Or create a config file (wrangler.toml, fly.toml, vercel.json, etc.) for auto-detection.");
      process.exit(1);
    }
  }

  if (!VALID_TARGETS.includes(target as DeployTarget)) {
    logger.error(`Unknown deploy target: "${target}". Valid targets: ${VALID_TARGETS.join(", ")}`);
    process.exit(1);
  }

  const cwd = process.cwd();
  const generated: string[] = [];
  const skipped: string[] = [];

  // Only probe the user's app for targets whose entrypoint imports it, and
  // only once per run (loading the entry spawns tsx).
  const needsApp = target === "vercel" || target === "lambda" || target === "cloudflare";
  let cachedAppImport: AppImport | null = null;
  const resolveApp = (generatedRelPath: string): AppImport => {
    if (!cachedAppImport) {
      logger.info("Locating your app entry...");
      cachedAppImport = resolveAppImport(cwd, generatedRelPath);
    }
    return cachedAppImport;
  };

  const files = getFilesForTarget(target as DeployTarget, needsApp ? resolveApp : undefined);

  for (const [relPath, content] of files) {
    const absPath = resolve(cwd, relPath);
    if (existsSync(absPath)) {
      skipped.push(relPath);
      continue;
    }
    const dir = dirname(absPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(absPath, content, "utf-8");
    generated.push(relPath);
  }

  // Print results
  if (generated.length > 0) {
    logger.success(`Generated ${generated.length} file(s) for ${target}:`);
    for (const f of generated) {
      logger.dim(`  + ${f}`);
    }
  }
  if (skipped.length > 0) {
    logger.warn(`Skipped ${skipped.length} file(s) (already exist):`);
    for (const f of skipped) {
      logger.dim(`  ~ ${f}`);
    }
  }

  // The generated handler imports the platform adapter: tell the user the
  // exact install command so the next step never fails on a missing package.
  const adapterPkg = ADAPTER_PACKAGES[target as DeployTarget];
  if (adapterPkg) {
    console.log("");
    logger.info(`Install the platform adapter (required by the generated handler):`);
    logger.bold(`  npm install ${adapterPkg}`);
  }

  if (needsApp) {
    warnIfEntryServes(cwd);
  }

  // If --deploy flag is set, also run the platform CLI
  const shouldDeploy = options?.deploy ?? false;
  const platformCli = PLATFORM_CLIS[target as DeployTarget];

  if (shouldDeploy && platformCli) {
    // Check CLI availability
    if (!isCliAvailable(platformCli.checkCmd)) {
      logger.error(`Platform CLI not found for ${target}.`);
      logger.dim(`Install it: ${platformCli.installHint}`);
      process.exit(1);
    }

    // Build first
    logger.info("Building app...");
    try {
      execSync("npx celsian build", { cwd, stdio: "inherit" });
    } catch {
      logger.error("Build failed. Fix build errors and try again.");
      process.exit(1);
    }

    // Deploy
    logger.info(`Deploying to ${target}...`);
    try {
      execSync(platformCli.deployCmd, { cwd, stdio: "inherit" });
      logger.success(`Deployed to ${target} successfully!`);
    } catch {
      logger.error(`Deployment to ${target} failed. Check the output above for details.`);
      process.exit(1);
    }
  } else {
    // Print next steps
    console.log("");
    printNextSteps(target as DeployTarget, false);
  }
}
