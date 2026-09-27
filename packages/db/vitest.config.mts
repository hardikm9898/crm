import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'src/**/*.int-spec.ts'],
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    // Integration tests share one database; run them sequentially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
