import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "examples/*/test/**/*.test.ts",
      // Moved out of docs/ on 2026-07-26: these are internal harnesses, and
      // docs/ is a published path (the site's Docs link points at it).
      "internal/test-real-world/**/*.test.ts",
      "internal/realism-audit/**/*.test.ts",
      "scripts/**/*.test.mjs",
    ],
    globals: true,
    env: {
      NODE_ENV: "development",
    },
    // `expectTypeOf` is a COMPILE-time assertion. Without this block it erases
    // to a no-op at runtime, so a wrong assertion still reports as a passing
    // test. Turning it on makes vitest run tsc over the type-test files and
    // report compiler errors as test failures. `pnpm typecheck` covers the
    // same ground repo-wide; this makes the failures show up in the suite too,
    // attributed to the test that made the bad claim.
    typecheck: {
      enabled: true,
      tsconfig: "./tsconfig.typecheck.vitest.json",
      include: [
        "packages/core/test/type-inference.test.ts",
        "packages/core/test/response-schema.test.ts",
        "packages/rpc/test/procedure.test.ts",
        "packages/rpc/test/type-inference.test.ts",
      ],
    },
    coverage: {
      provider: "v8",
      // Scope the denominator to shipped source. Previously unset, so the
      // default include swept in `examples/` and `benchmarks/`, which diluted
      // the percentage and made the 55% gate meaningless.
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/*/src/**/*.d.ts", "packages/create-celsian/src/templates/**"],
      reporter: ["text", "json-summary"],
    },
  },
});
