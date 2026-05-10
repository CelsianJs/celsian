import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "examples/*/test/**/*.test.ts",
      "test-real-world/**/*.test.ts",
      "test/**/*.test.ts",
    ],
    exclude: process.env.CELSIAN_INCLUDE_BENCH === "1" ? [] : ["packages/cache/test/bench.test.ts"],
    globals: true,
    env: {
      NODE_ENV: "development",
    },
  },
});
