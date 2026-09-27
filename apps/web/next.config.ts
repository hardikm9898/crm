import type { NextConfig } from 'next';

/**
 * The web app never talks to PostgreSQL or Redis: it calls the API over HTTP with the user's token.
 * That keeps exactly one implementation of authorization, in the API (docs/frontend-architecture.md §2).
 */
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
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
