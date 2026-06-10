import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "examples/*/test/**/*.test.ts",
      "docs/internal/test-real-world/**/*.test.ts",
      "docs/internal/realism-audit/**/*.test.ts",
    ],
    globals: true,
    env: {
      NODE_ENV: "development",
    },
  },
});
