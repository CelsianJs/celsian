import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "examples/*/test/**/*.test.ts",
      "test-real-world/**/*.test.ts",
      "realism-audit/**/*.test.ts",
    ],
    globals: true,
    env: {
      NODE_ENV: "development",
    },
  },
});
