// @celsian/cli — celsian create command
// Delegates to create-celsian's scaffolder so `celsian create` and
// `npm create celsian` produce identical projects (all 4 templates).

import { detectPackageManager, nextStepsLines, ScaffoldError, scaffold, templates } from "create-celsian";
import { logger } from "../utils/logger.js";

export type Template = "full" | "basic" | "rest-api" | "rpc-api";

export interface CreateOptions {
  /** Scaffold into an existing non-empty directory. */
  force?: boolean;
}

export async function createCommand(
  name: string,
  template: Template = "full",
  options: CreateOptions = {},
): Promise<void> {
  if (!(template in templates)) {
    logger.error(`Unknown template: ${template}. Available: ${Object.keys(templates).join(", ")}`);
    process.exit(1);
  }

  try {
    const result = scaffold(name, template, { force: options.force, log: (msg) => console.log(msg) });
    const pm = detectPackageManager();
    logger.success(`Project created at ./${result.projectName}`);
    for (const line of nextStepsLines(result.projectName, template, pm)) {
      console.log(line);
    }
  } catch (error) {
    if (error instanceof ScaffoldError) {
      logger.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
