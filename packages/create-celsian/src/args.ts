// create-celsian: argv parsing for the bin
//
// Kept out of index.ts because index.ts runs the CLI as a side effect of being
// imported, which would make these rules untestable.

import { templates } from "./scaffold.js";

export const USAGE_LINE = "create-celsian <project-name> [--template full|basic|rest-api|rpc-api] [--force]";

/** A user-facing argv problem: the caller prints it and exits non-zero. */
export class ArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgsError";
  }
}

export interface ParsedArgs {
  /** Print usage and exit 0. */
  help: boolean;
  force: boolean;
  /** Absent when no project name was given, which means interactive mode. */
  name?: string;
  /** Absent when no template flag was given, so the caller applies the default. */
  template?: string;
}

const TEMPLATE_FLAGS = ["--template", "-t"];
const INLINE_TEMPLATE = /^(--template|-t)=(.*)$/;

function templateNames(): string[] {
  return Object.keys(templates);
}

function missingTemplateValue(flag: string): ArgsError {
  return new ArgsError(`  ${flag} needs a template name.\n\n  Available: ${templateNames().join(", ")}`);
}

function unknownFlag(flag: string): ArgsError {
  return new ArgsError(
    [`  Unknown option: "${flag}".`, "", `  Usage: ${USAGE_LINE}`, "", "  Nothing was created."].join("\n"),
  );
}

/**
 * `npm create celsian@latest my-api --template basic` never reaches the bin
 * intact. npm treats every flag after the package name as its own config
 * unless a bare `--` separates them, so it eats `--template` and passes the
 * VALUE through as a second positional: `create-celsian my-api basic`.
 *
 * That positional used to be discarded, and `full` was scaffolded instead with
 * no signal at all. Inferring the template from it would just move the guess
 * one level up, and a wrong guess is invisible again, so refuse instead: a
 * scaffold has not written anything yet, which makes an error the cheapest
 * possible outcome, and the message can teach the separator once for every
 * flag rather than only rescuing this one.
 */
function extraPositional(extra: string, name: string): ArgsError {
  const lines = [`  Unexpected extra argument: "${extra}".`, ""];

  if (templateNames().includes(extra)) {
    lines.push(
      `  "${extra}" is a template name, so npm almost certainly swallowed your --template flag:`,
      "  `npm create` only forwards flags that come after a `--` separator.",
      "",
      "  Run one of these instead:",
      `    npm create celsian@latest ${name} -- --template ${extra}`,
      `    npx create-celsian@latest ${name} --template ${extra}`,
    );
  } else {
    lines.push(
      `  Usage: ${USAGE_LINE}`,
      "",
      "  If you passed flags through `npm create`, separate them with `--`:",
      `    npm create celsian@latest ${name} -- --template basic`,
    );
  }

  lines.push("", "  Nothing was created.");
  return new ArgsError(lines.join("\n"));
}

/** Parse `process.argv.slice(2)`. Throws {@link ArgsError} for anything ambiguous. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let force = false;
  let template: string | undefined;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      return { help: true, force: false };
    }

    if (arg === "--force") {
      force = true;
      continue;
    }

    if (TEMPLATE_FLAGS.includes(arg)) {
      const value = argv[i + 1];
      // A following flag means the value is missing, not that the flag is named "--force".
      if (value === undefined || value.startsWith("-")) throw missingTemplateValue(arg);
      template = value;
      i++;
      continue;
    }

    const inline = INLINE_TEMPLATE.exec(arg);
    if (inline) {
      if (inline[2] === "") throw missingTemplateValue(inline[1]);
      template = inline[2];
      continue;
    }

    if (arg.startsWith("-")) throw unknownFlag(arg);

    positionals.push(arg);
  }

  if (positionals.length > 1) throw extraPositional(positionals[1], positionals[0]);

  return { help: false, force, name: positionals[0], template };
}
