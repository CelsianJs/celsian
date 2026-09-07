import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scripts/verify-registry-install.test.mjs'],
    environment: 'node',
  },
});
