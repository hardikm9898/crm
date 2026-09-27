// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/generated/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/node_modules/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
    },
  },
  // ── Architecture guardrails (docs/README.md §Non-negotiables) ─────────────────
  // Rule 3: only the db package and repositories may touch the Prisma client directly.
  {
    files: ['apps/**/src/**/*.ts'],
    ignores: ['apps/**/src/**/*.repository.ts', 'apps/**/src/infra/db/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/generated/prisma*', '@prisma/client'],
              message:
                'Import the Prisma client only via @leados/db (tenant-scoped). See docs/security.md §3 layer 2.',
            },
          ],
        },
      ],
    },
  },
  // NestJS resolves dependencies from decorator metadata, which needs the injected class
  // to be a RUNTIME import. `consistent-type-imports` rewrites those to `import type`,
  // erasing them and breaking dependency injection at boot with no compile-time signal.
  // It stays on in packages/ (no DI there) and off in the Nest application.
  {
    files: ['apps/api/**/*.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
  // Tests may reach for anything, including the unscoped client, in order to prove isolation.
  {
    files: ['**/*.spec.ts', '**/*.int-spec.ts', '**/test/**/*.ts'],
    rules: { 'no-restricted-imports': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  },
);
