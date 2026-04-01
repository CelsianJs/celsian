#!/usr/bin/env node

// create-celsian — Project scaffolder
// Zero external dependencies. Interactive prompts via raw stdin.

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { basicTemplate } from "./templates/basic.js";
import { fullTemplate } from "./templates/full.js";
import { restApiTemplate } from "./templates/rest-api.js";
import { rpcApiTemplate } from "./templates/rpc-api.js";

// ─── Template Registry ───

const templates: Record<string, Record<string, string>> = {
  full: fullTemplate,
  basic: basicTemplate,
  "rest-api": restApiTemplate,
  "rpc-api": rpcApiTemplate,
};

const templateDescriptions: Record<string, string> = {
  full: "Full-stack API with auth, CRUD, RPC, tasks, cron, OpenAPI, Docker",
  basic: "Minimal API server",
  "rest-api": "REST API with TypeBox schemas",
  "rpc-api": "RPC-first with typed client",
};

// ─── CLI Argument Parsing ───

const args = process.argv.slice(2);

// Handle --help
if (args.includes("--help") || args.includes("-h")) {
  printUsage();
  process.exit(0);
}

// Extract flags
const templateFlag = args.indexOf("--template");
const templateArg = templateFlag !== -1 ? args[templateFlag + 1] : undefined;
const nameArg = args.find((a) => !a.startsWith("--") && (templateFlag === -1 || args.indexOf(a) !== templateFlag + 1));

// ─── Interactive Mode ───

async function prompt(question: string, defaultValue: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`  ${question} (${defaultValue}): `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue);
    });
  });
}

function detectPackageManager(): string {
  const userAgent = process.env.npm_config_user_agent ?? "";
  if (userAgent.startsWith("pnpm")) return "pnpm";
  if (userAgent.startsWith("bun")) return "bun";
  return "npm";
}

async function interactiveMode(): Promise<{ name: string; template: string; pm: string }> {
  console.log("");
  console.log("  Create a new Celsian project");
  console.log("  ────────────────────────────");
  console.log("");

  const name = await prompt("Project name", "my-celsian-app");

  console.log("");
  console.log("  Available templates:");
  for (const [key, desc] of Object.entries(templateDescriptions)) {
    const marker = key === "full" ? " (recommended)" : "";
    console.log(`    ${key.padEnd(12)} ${desc}${marker}`);
  }
  console.log("");

  const template = await prompt("Template", "full");

  const detected = detectPackageManager();
  const pm = await prompt("Package manager", detected);

  return { name, template, pm };
}

// ─── Scaffold ───

function scaffold(name: string, template: string, pm: string): void {
  const files = templates[template];
  if (!files) {
    console.error(`\n  Unknown template: ${template}`);
    console.error(`  Available: ${Object.keys(templates).join(", ")}\n`);
    process.exit(1);
  }

  // Sanitize: reject names containing path traversal
  if (name.includes("..")) {
    console.error("\n  Invalid project name: must not contain '..'.\n");
    process.exit(1);
  }

  const cwd = process.cwd();
  const dir = isAbsolute(name) ? name : join(cwd, name);
  const resolved = resolve(dir);

  // Ensure the resolved path is a child of cwd
  if (!resolved.startsWith(cwd + "/") && resolved !== cwd) {
    console.error("\n  Invalid project name: resolved path must be inside the current directory.\n");
    process.exit(1);
  }

  const projectName = basename(dir);

  console.log(`\n  Creating Celsian project: ${projectName}`);
  console.log(`  Template: ${template}`);
  console.log("");

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = join(dir, filePath);
    const fileDir = dirname(fullPath);
    mkdirSync(fileDir, { recursive: true });
    writeFileSync(fullPath, content.replace(/\{\{name\}\}/g, projectName));
    console.log(`  + ${filePath}`);
  }

  const install = pm === "npm" ? "npm install" : `${pm} install`;
  const dev = pm === "npm" ? "npm run dev" : `${pm} run dev`;

  console.log(`\n  Done! Next steps:\n`);
  console.log(`  cd ${projectName}`);
  console.log(`  ${install}`);
  if (template === "full") {
    console.log("  cp .env.example .env");
  }
  console.log(`  ${dev}`);
  if (template === "full") {
    console.log("");
    console.log("  Open http://localhost:3000/docs for API documentation");
  }
  console.log("");
}

// ─── Main ───

async function main(): Promise<void> {
  // If both name and template are provided via CLI args, skip interactive mode
  if (nameArg) {
    const template = templateArg ?? "full";
    const pm = detectPackageManager();
    scaffold(nameArg, template, pm);
    return;
  }

  // No project name — enter interactive mode
  // But only if stdin is a TTY (not piped)
  if (process.stdin.isTTY) {
    const { name, template, pm } = await interactiveMode();
    scaffold(name, template, pm);
  } else {
    printUsage();
    process.exit(1);
  }
}

function printUsage(): void {
  console.log("");
  console.log("  Usage: create-celsian <project-name> [--template full|basic|rest-api|rpc-api]");
  console.log("");
  console.log("  Templates:");
  for (const [key, desc] of Object.entries(templateDescriptions)) {
    const defaultMarker = key === "full" ? " (default)" : "";
    console.log(`    ${key.padEnd(12)} ${desc}${defaultMarker}`);
  }
  console.log("");
  console.log("  Run without arguments for interactive mode.");
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
