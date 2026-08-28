#!/usr/bin/env node

// create-celsian: Project scaffolder (bin entry)
// Zero external dependencies. Interactive prompts via raw stdin.
// All scaffolding logic lives in scaffold.ts so @celsian/cli can reuse it.

import { createInterface } from "node:readline";
import { ArgsError, parseArgs, USAGE_LINE } from "./args.js";
import { detectPackageManager, nextStepsLines, ScaffoldError, scaffold, templateDescriptions } from "./scaffold.js";

// ─── CLI Argument Parsing ───

let parsed: ReturnType<typeof parseArgs>;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (err) {
  if (!(err instanceof ArgsError)) throw err;
  console.error(`\n${err.message}\n`);
  process.exit(1);
}

if (parsed.help) {
  printUsage();
  process.exit(0);
}

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

function run(name: string, template: string, pm: string, force: boolean): void {
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
  // A project name on the command line means non-interactive.
  if (parsed.name) {
    run(parsed.name, parsed.template ?? "full", detectPackageManager(), parsed.force);
    return;
  }

  // No project name: enter interactive mode
  // But only if stdin is a TTY (not piped)
  if (process.stdin.isTTY) {
    const { name, template, pm } = await interactiveMode();
    run(name, template, pm, parsed.force);
  } else {
    printUsage();
    process.exit(1);
  }
}

function printUsage(): void {
  console.log("");
  console.log(`  Usage: ${USAGE_LINE}`);
  console.log("");
  console.log("  Templates:");
  for (const [key, desc] of Object.entries(templateDescriptions)) {
    const defaultMarker = key === "full" ? " (default)" : "";
    console.log(`    ${key.padEnd(12)} ${desc}${defaultMarker}`);
  }
  console.log("");
  console.log("  Options:");
  console.log("    --template   Template to scaffold (also -t, or --template=<id>)");
  console.log("    --force      Scaffold into an existing non-empty directory");
  console.log("");
  console.log("  Run without arguments for interactive mode.");
  console.log("");
  console.log("  With `npm create`, flags need a `--` separator or npm eats them:");
  console.log("    npm create celsian@latest my-api -- --template basic");
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
