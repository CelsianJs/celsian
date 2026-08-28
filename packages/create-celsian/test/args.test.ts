// create-celsian, argv parsing for the `create-celsian` bin
//
// Why this file exists: `npm create celsian@latest my-api --template basic`
// never delivers the flag. npm swallows everything after the package name
// unless a `--` separates it, and drops the flag's VALUE in as a bare
// positional, so the bin is handed `my-api basic`. That positional used to be
// discarded and the default `full` template was scaffolded instead, with no
// warning: the user asked for a minimal server and got JWT, CSRF and a
// Dockerfile. These tests pin the rule that no invocation we do not fully
// understand is allowed to write files.

import { describe, expect, it } from "vitest";
import { ArgsError, parseArgs } from "../src/args.js";

function parseError(argv: string[]): ArgsError {
  try {
    parseArgs(argv);
  } catch (err) {
    if (err instanceof ArgsError) return err;
    throw err;
  }
  throw new Error(`parseArgs(${JSON.stringify(argv)}) was expected to throw, but returned normally`);
}

describe("parseArgs", () => {
  it("reads a name on its own", () => {
    expect(parseArgs(["my-api"])).toEqual({ help: false, force: false, name: "my-api", template: undefined });
  });

  it("reads --template and --force", () => {
    expect(parseArgs(["my-api", "--template", "basic", "--force"])).toEqual({
      help: false,
      force: true,
      name: "my-api",
      template: "basic",
    });
  });

  it("accepts the flag before the name", () => {
    expect(parseArgs(["--template", "basic", "my-api"]).name).toBe("my-api");
  });

  it("accepts a name that is also a template name", () => {
    // `create-celsian --template basic basic` names the project "basic".
    // The old parser matched positionals with indexOf(), which found the
    // FIRST "basic" (the flag's value) and threw the project name away.
    expect(parseArgs(["--template", "basic", "basic"])).toEqual({
      help: false,
      force: false,
      name: "basic",
      template: "basic",
    });
  });

  it("supports -t, which the README documents", () => {
    expect(parseArgs(["my-api", "-t", "rest-api"]).template).toBe("rest-api");
  });

  it("supports the --template=value form", () => {
    expect(parseArgs(["my-api", "--template=rpc-api"]).template).toBe("rpc-api");
    expect(parseArgs(["my-api", "-t=basic"]).template).toBe("basic");
  });

  it("reports --help", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("returns no name when given nothing, so the caller can go interactive", () => {
    expect(parseArgs([]).name).toBeUndefined();
  });
});

describe("parseArgs refuses invocations it cannot understand", () => {
  it("rejects the argv `npm create ... --template basic` actually produces", () => {
    // npm hands the bin: create-celsian my-api basic
    const err = parseError(["my-api", "basic"]);
    expect(err.message).toContain('"basic"');
    // Names the real cause and both invocations that survive npm's parsing.
    expect(err.message).toContain("npm create celsian@latest my-api -- --template basic");
    expect(err.message).toContain("npx create-celsian@latest my-api --template basic");
    // The whole point: refusing means nothing was written.
    expect(err.message).toContain("Nothing was created");
  });

  it("rejects an extra positional that is not a template name", () => {
    const err = parseError(["my-api", "wat"]);
    expect(err.message).toContain('"wat"');
    expect(err.message).toContain("Usage:");
    // Still teaches the separator, because npm eats --force the same way.
    expect(err.message).toContain("--");
  });

  it("rejects an unknown flag instead of ignoring it", () => {
    const err = parseError(["my-api", "--tempalte", "basic"]);
    expect(err.message).toContain("--tempalte");
  });

  it("rejects --template with no value", () => {
    expect(parseError(["my-api", "--template"]).message).toMatch(/--template/);
    expect(parseError(["my-api", "--template", "--force"]).message).toMatch(/--template/);
    expect(parseError(["my-api", "--template="]).message).toMatch(/--template/);
  });
});
