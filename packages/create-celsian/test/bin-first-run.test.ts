// create-celsian, the bin end to end
//
// Why this file exists on top of args.test.ts: a correct parser is worthless if
// the bin does not consult it before scaffolding. This runs the real entry
// point in a real process and asserts on the exit code, the message the user
// reads, and whether a directory appeared on disk.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const TSX = join(REPO_ROOT, "node_modules/.bin/tsx");
const BIN = resolve(HERE, "../src/index.ts");

// Spawning tsx twice costs real process startup, well past a unit test.
const TIMEOUT_MS = 120_000;

let workRoot: string;

beforeAll(() => {
  // scaffold() refuses to write outside its cwd, so the scratch root is the cwd.
  workRoot = mkdtempSync(join(REPO_ROOT, ".tmp-bin-first-run-"));
});

afterAll(() => {
  if (workRoot) rmSync(workRoot, { recursive: true, force: true });
});

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runBin(args: string[]): RunResult {
  try {
    const stdout = execFileSync(TSX, [BIN, ...args], { cwd: workRoot, encoding: "utf8", stdio: "pipe" });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("create-celsian bin", () => {
  it(
    "scaffolds the template that was asked for when the flag survives",
    () => {
      const result = runBin(["ok-basic", "--template", "basic"]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Template: basic");
      expect(existsSync(join(workRoot, "ok-basic/src/index.ts"))).toBe(true);
      // `basic` is the minimal template: no Dockerfile, no auth plugin.
      expect(existsSync(join(workRoot, "ok-basic/Dockerfile"))).toBe(false);
    },
    TIMEOUT_MS,
  );

  it(
    "refuses the argv `npm create celsian@latest x --template basic` produces, and writes nothing",
    () => {
      // npm swallows --template and hands the bin a bare `basic` positional.
      const result = runBin(["flag-basic", "basic"]);

      expect(result.status).toBe(1);
      // Never the old behaviour: silently scaffolding `full`.
      expect(result.stdout).not.toContain("Template: full");
      expect(result.stderr).toContain("npm create celsian@latest flag-basic -- --template basic");
      // The previous test proves this harness CAN create a directory here.
      expect(existsSync(join(workRoot, "flag-basic"))).toBe(false);
    },
    TIMEOUT_MS,
  );
});
