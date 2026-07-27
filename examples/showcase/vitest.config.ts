// Without this file, `npm test` inside the example fails with "No test files
// found, exiting with code 1". Vitest walks up to the repo-root config, whose
// `include` patterns are written relative to the repo root
// ("examples/*/test/**/*.test.ts") and so match nothing from in here.
//
// The example is meant to be copied out and run standalone, so it carries its
// own config. Running the suite from the repo root still picks these tests up
// through the root config; nested configs are ignored in that direction.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
  },
});
