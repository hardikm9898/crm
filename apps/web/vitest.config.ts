import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the web app's pure logic — navigation filtering, onboarding progress, cookie
 * relaying, error copy. Component and browser-level behaviour is covered by the Playwright checks
 * documented in this app's README; duplicating them in jsdom would test a different renderer than
 * the one that ships.
 */
export default defineConfig({
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
