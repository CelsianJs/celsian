#!/usr/bin/env node

// create-celsian — Project scaffolder (bin entry)
// Zero external dependencies. Interactive prompts via raw stdin.
// All scaffolding logic lives in scaffold.ts so @celsian/cli can reuse it.

import { createInterface } from "node:readline";
import { detectPackageManager, nextStepsLines, ScaffoldError, scaffold, templateDescriptions } from "./scaffold.js";

// ─── CLI Argument Parsing ───

const args = process.argv.slice(2);

// Handle --help
if (args.includes("--help") || args.includes("-h")) {
  printUsage();
  process.exit(0);
}

// Extract flags
const force = args.includes("--force");
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

// ─── Main ───

function run(name: string, template: string, pm: string): void {
  try {
    const result = scaffold(name, template, { force });
    for (const line of nextStepsLines(result.projectName, template, pm)) {
      console.log(line);
    }
  } catch (err) {
    if (err instanceof ScaffoldError) {
      console.error(`\n  ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

async function main(): Promise<void> {
  // If both name and template are provided via CLI args, skip interactive mode
  if (nameArg) {
    const template = templateArg ?? "full";
    const pm = detectPackageManager();
    run(nameArg, template, pm);
    return;
  }

  // No project name — enter interactive mode
  // But only if stdin is a TTY (not piped)
  if (process.stdin.isTTY) {
    const { name, template, pm } = await interactiveMode();
    run(name, template, pm);
  } else {
    printUsage();
    process.exit(1);
  }
}

function printUsage(): void {
  console.log("");
  console.log("  Usage: create-celsian <project-name> [--template full|basic|rest-api|rpc-api] [--force]");
  console.log("");
  console.log("  Templates:");
  for (const [key, desc] of Object.entries(templateDescriptions)) {
    const defaultMarker = key === "full" ? " (default)" : "";
    console.log(`    ${key.padEnd(12)} ${desc}${defaultMarker}`);
  }
  console.log("");
  console.log("  Options:");
  console.log("    --force      Scaffold into an existing non-empty directory");
  console.log("");
  console.log("  Run without arguments for interactive mode.");
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
