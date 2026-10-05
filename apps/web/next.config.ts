import type { NextConfig } from 'next';

/**
 * The web app never talks to PostgreSQL or Redis: it calls the API over HTTP with the user's token.
 * That keeps exactly one implementation of authorization, in the API (docs/frontend-architecture.md §2).
 */
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Next writes its own `AGENTS.md` and `CLAUDE.md` into this package on every dev boot. This
  // repository's instructions live in the root `CLAUDE.md`, and a generated file of the same name
  // inside `apps/web` shadows it for anything working in that directory — a second, machine-written
  // source of truth about how to work here is exactly what the root file exists to prevent.
  agentRules: false,
  // Server Components call the API from inside the container; the browser uses the public URL.
  env: {
    NEXT_PUBLIC_API_URL: process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:4000',
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default config;
