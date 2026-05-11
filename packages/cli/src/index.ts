#!/usr/bin/env node

// @celsian/cli — Developer CLI

import { buildCommand } from "./commands/build.js";
import { createCommand, type Template } from "./commands/create.js";
import { devCommand } from "./commands/dev.js";
import { generateRoute, generateRpc } from "./commands/generate.js";
import { routesCommand } from "./commands/routes.js";
import { getVersion, printBanner } from "./utils/banner.js";
import { logger } from "./utils/logger.js";

const args = process.argv.slice(2);
const command = args[0];

async function main(): Promise<void> {
  switch (command) {
    case "dev": {
      printBanner();
      const port = getFlag(args, "--port", "-p");
      const host = getFlag(args, "--host", "-h");
      const entry = getFlag(args, "--entry", "-e");
      await devCommand({
        entry: entry ?? undefined,
        port: port ? parseInt(port, 10) : undefined,
        host: host ?? undefined,
      });
      break;
    }

    case "create": {
      const name = args[1];
      if (!name) {
        logger.error("Usage: celsian create <name> [--template full|basic|rest-api|rpc-api]");
        process.exit(1);
      }
      const template = (getFlag(args, "--template", "-t") ?? "full") as Template;
      await createCommand(name, template);
      break;
    }

    case "generate":
    case "g": {
      const type = args[1];
      const name = args[2];
      if (!type || !name) {
        logger.error("Usage: celsian generate <route|rpc> <name>");
        process.exit(1);
      }
      if (type === "route") {
        generateRoute(name);
      } else if (type === "rpc") {
        generateRpc(name);
      } else {
        logger.error(`Unknown generator: ${type}. Use "route" or "rpc".`);
        process.exit(1);
      }
      break;
    }

    case "routes": {
      const entry = args[1];
      await routesCommand(entry);
      break;
    }

    case "build": {
      printBanner();
      const entry = getFlag(args, "--entry", "-e") ?? "src/index.ts";
      const outdir = getFlag(args, "--outdir", "-o") ?? "dist/";
      const format = getFlag(args, "--format", "-f") ?? "esm";
      const target = getFlag(args, "--target") ?? "es2022";
      const minify = args.includes("--minify");
      const platform = getFlag(args, "--platform") ?? "node";
      await buildCommand({ entry, outdir, format, target, minify, platform });
      break;
    }

    case "--version":
    case "-v": {
      console.log(getVersion());
      break;
    }

    case "--help":
    case "help":
    case undefined: {
      printBanner();
      console.log("  Commands:");
      console.log("");
      console.log("    dev                      Start dev server with file watching");
      console.log("    create <name>            Scaffold a new Celsian project");
      console.log("    generate route <name>    Generate a route file");
      console.log("    generate rpc <name>      Generate an RPC procedure");
      console.log("    routes                   Print registered routes");
      console.log("    build                    Bundle app for production");
      console.log("");
      console.log("  Build options:");
      console.log("");
      console.log("    --entry, -e <path>       Entry point (default: src/index.ts)");
      console.log("    --outdir, -o <path>      Output directory (default: dist/)");
      console.log("    --format, -f esm|cjs     Module format (default: esm)");
      console.log("    --target <target>        Build target (default: es2022)");
      console.log("    --platform node|browser  Target platform (default: node)");
      console.log("    --minify                 Minify output");
      console.log("");
      console.log("  Options:");
      console.log("");
      console.log("    --version, -v            Show version");
      console.log("    --help                   Show this help");
      console.log("");
      break;
    }

    default: {
      logger.error(`Unknown command: ${command}`);
      logger.dim('Run "celsian --help" for usage.');
      process.exit(1);
    }
  }
}

function getFlag(args: string[], long: string, short?: string): string | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === long || (short && args[i] === short)) {
      return args[i + 1] ?? null;
    }
  }
  return null;
}

main().catch((error) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
