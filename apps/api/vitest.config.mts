import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // NestJS dependency injection relies on decorator metadata, which esbuild does not
  // emit — so SWC does the transform for tests exactly as it does for the build.
  plugins: [swc.vite()],
  test: {
    include: ['src/**/*.spec.ts', 'src/**/*.int-spec.ts', 'test/**/*.e2e-spec.ts'],
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
