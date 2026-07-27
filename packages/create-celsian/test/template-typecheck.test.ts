// create-celsian -- compiles every scaffolded template with the real tsc
//
// Why this file exists: the templates are TypeScript source held inside string
// literals, so the repo's own typecheck gate never sees them. Every other test
// in this package asserts on template TEXT (does tsconfig.json have `strict`,
// does src/index.ts mention `createApp`), which cannot notice that the emitted
// program does not compile. That is exactly what happened once: an undeclared
// breaking change to `@celsian/rpc`'s `procedure.input<T>()` flipped `T` from
// "the parsed type" to "the schema type", and the templates kept emitting the
// old 0.5.x spelling. Every test here stayed green while `npm run build`, the
// second command the generated README gives you, failed with TS2345/TS18046.
//
// This test scaffolds each template to disk exactly as a user would and then
// runs the real compiler over it. Only two deviations from a user's project are
// made, and both are dependency-resolution shims so the test does not need a
// network install:
//   1. `paths` maps `celsian` / `@celsian/*` onto this repo's built `dist`.
//   2. `types: ["node"]` / `lib` are pinned, because the generated project
//      would get those from its own @types/node install.
// The template's own source files are compiled verbatim, under the template's
// own compilerOptions (strict, target, moduleResolution).

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scaffold, templates } from "../src/scaffold.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const TSC = join(REPO_ROOT, "node_modules/.bin/tsc");

// Compiling four real projects takes appreciably longer than a unit test.
const TIMEOUT_MS = 180_000;

const TEMPLATE_NAMES = Object.keys(templates);

let workRoot: string;
let originalCwd: string;

beforeAll(() => {
  originalCwd = process.cwd();
  // scaffold() refuses to write outside process.cwd(), so the scratch root has
  // to live under it. Keep it inside the repo anyway: the relative `paths`
  // below are written against a known depth.
  workRoot = mkdtempSync(join(REPO_ROOT, ".tmp-template-typecheck-"));
  process.chdir(workRoot);
});

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(workRoot, { recursive: true, force: true });
});

describe("scaffolded templates compile", () => {
  it("has the tsc binary this test depends on", () => {
    expect(existsSync(TSC), `expected a built tsc at ${TSC}; run pnpm install`).toBe(true);
  });

  it.each(TEMPLATE_NAMES)(
    "%s compiles with tsc",
    (name) => {
      const projectDir = join(workRoot, `typecheck-${name}`);
      scaffold(projectDir, name, { log: () => {} });

      const tsconfigPath = join(projectDir, "tsconfig.json");
      const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
      tsconfig.compilerOptions = {
        ...tsconfig.compilerOptions,
        noEmit: true,
        types: ["node"],
        lib: tsconfig.compilerOptions.lib ?? ["ES2022"],
        paths: {
          celsian: [join(REPO_ROOT, "packages/celsian/dist/index.d.ts")],
          "@celsian/*": [join(REPO_ROOT, "packages/*/dist/index.d.ts")],
        },
      };
      // noEmit and these are mutually exclusive.
      tsconfig.compilerOptions.outDir = undefined;
      tsconfig.compilerOptions.declaration = undefined;
      writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));

      let output = "";
      let failed = false;
      try {
        execFileSync(TSC, ["-p", projectDir, "--noEmit"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        failed = true;
        const err = error as { stdout?: string; stderr?: string };
        output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
      }

      expect(failed, `the "${name}" template does not compile. tsc reported:\n${output}`).toBe(false);
    },
    TIMEOUT_MS,
  );
});
