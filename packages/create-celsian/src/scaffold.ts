// create-celsian — Scaffolding engine
// Shared between the create-celsian bin and `celsian create` in @celsian/cli.
// Zero external dependencies.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { basicTemplate } from "./templates/basic.js";
import { fullTemplate } from "./templates/full.js";
import { restApiTemplate } from "./templates/rest-api.js";
import { rpcApiTemplate } from "./templates/rpc-api.js";

// ─── Template Registry ───

export const templates: Record<string, Record<string, string>> = {
  full: fullTemplate,
  basic: basicTemplate,
  "rest-api": restApiTemplate,
  "rpc-api": rpcApiTemplate,
};

export const templateDescriptions: Record<string, string> = {
  full: "Full-stack API with auth, CRUD, RPC, tasks, cron, OpenAPI, Docker",
  basic: "Minimal API server",
  "rest-api": "REST API with TypeBox schemas",
  "rpc-api": "RPC-first with typed client",
};

/** Error thrown for user-facing scaffolding failures (bad name, bad template, non-empty dir). */
export class ScaffoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScaffoldError";
  }
}

// ─── Project Name Validation ───

// npm package name rules (new packages): lowercase, no spaces, URL-safe,
// must not start with "." or "_", max 214 chars.
const NPM_NAME_PATTERN = /^[a-z0-9~][a-z0-9-._~]*$/;

/**
 * Validate a project name against npm package name rules.
 * Returns an error message, or null when the name is valid.
 */
export function validateProjectName(name: string): string | null {
  if (!name || name.trim().length === 0) {
    return "Project name must not be empty.";
  }
  if (name.length > 214) {
    return "Project name must be at most 214 characters.";
  }
  if (name !== name.toLowerCase()) {
    return `Invalid project name "${name}": npm package names must be lowercase.`;
  }
  if (!NPM_NAME_PATTERN.test(name)) {
    return (
      `Invalid project name "${name}": npm package names may only contain ` +
      "lowercase letters, digits, '-', '.', '_' and '~', and must not start with '.' or '_'."
    );
  }
  return null;
}

// ─── Scaffold ───

export interface ScaffoldOptions {
  /** Overwrite into an existing non-empty directory (default: false). */
  force?: boolean;
  /** Line logger for progress output (default: console.log). */
  log?: (msg: string) => void;
}

export interface ScaffoldResult {
  /** Absolute path of the created project. */
  dir: string;
  /** Final project name (directory basename), substituted into the templates. */
  projectName: string;
  /** Relative paths of the files written. */
  files: string[];
}

/**
 * Scaffold a new project into `<cwd>/<name>`.
 * Throws {@link ScaffoldError} on invalid input instead of exiting, so both
 * CLI entry points (and tests) can handle failures themselves.
 */
export function scaffold(name: string, template: string, options: ScaffoldOptions = {}): ScaffoldResult {
  const log = options.log ?? ((msg: string) => console.log(msg));

  const files = templates[template];
  if (!files) {
    throw new ScaffoldError(`Unknown template: ${template}. Available: ${Object.keys(templates).join(", ")}`);
  }

  // Sanitize: reject names containing path traversal
  if (name.includes("..")) {
    throw new ScaffoldError("Invalid project name: must not contain '..'.");
  }

  const cwd = process.cwd();
  const dir = isAbsolute(name) ? name : join(cwd, name);
  const resolved = resolve(dir);

  // Ensure the resolved path is a child of cwd
  if (!resolved.startsWith(`${cwd}/`) && resolved !== cwd) {
    throw new ScaffoldError("Invalid project name: resolved path must be inside the current directory.");
  }

  const projectName = basename(dir);

  // The directory basename becomes the npm package name — enforce npm rules.
  const nameError = validateProjectName(projectName);
  if (nameError) {
    throw new ScaffoldError(nameError);
  }

  // Refuse to write into an existing non-empty directory unless --force is given.
  if (!options.force && existsSync(resolved) && readdirSync(resolved).length > 0) {
    throw new ScaffoldError(
      `Target directory "${projectName}" already exists and is not empty. ` +
        "Choose another name, or pass --force to scaffold into it anyway.",
    );
  }

  log(`\n  Creating Celsian project: ${projectName}`);
  log(`  Template: ${template}`);
  log("");

  const written: string[] = [];
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = join(dir, filePath);
    const fileDir = dirname(fullPath);
    mkdirSync(fileDir, { recursive: true });
    writeFileSync(fullPath, content.replace(/\{\{name\}\}/g, projectName));
    written.push(filePath);
    log(`  + ${filePath}`);
  }

  return { dir: resolved, projectName, files: written };
}

// ─── Shared Output Helpers ───

export function detectPackageManager(): string {
  const userAgent = process.env.npm_config_user_agent ?? "";
  if (userAgent.startsWith("pnpm")) return "pnpm";
  if (userAgent.startsWith("bun")) return "bun";
  return "npm";
}

/**
 * The "Done! Next steps" block printed after scaffolding — shared so
 * create-celsian and `celsian create` give identical guidance.
 */
export function nextStepsLines(projectName: string, template: string, pm: string): string[] {
  const install = pm === "npm" ? "npm install" : `${pm} install`;
  const dev = pm === "npm" ? "npm run dev" : `${pm} run dev`;

  const lines = [`\n  Done! Next steps:\n`, `  cd ${projectName}`, `  ${install}`];
  if (template === "full") {
    lines.push("  # Review .env (PORT, JWT_SECRET) — it was created from .env.example");
  }
  lines.push(`  ${dev}`);
  if (template === "full") {
    lines.push("");
    lines.push("  Open http://localhost:3000/docs for API documentation");
  }
  lines.push("");
  return lines;
}
