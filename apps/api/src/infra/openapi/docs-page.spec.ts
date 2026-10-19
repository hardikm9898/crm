import { describe, expect, it } from 'vitest';
import { renderDocsPage, renderErrorsPage, escapeHtml } from './docs-page.js';

const document = {
  info: {
    title: 'Lead OS API',
    version: '1.0.0',
    summary: 'The API the product uses.',
    description: 'Two credentials reach this API.\n\nErrors are at `/docs/errors`.',
  },
  paths: {
    '/api/v1/leads': {
      get: {
        tags: ['Leads'],
        summary: 'List',
        'x-leados-permission': 'lead:read',
        security: [{ sessionToken: [] }, { apiKey: [] }],
        parameters: [
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
          { name: 'search', in: 'query', required: false, schema: { type: 'string' } },
        ],
        description:
          'Needs the `lead:read` permission.\n\n```bash\ncurl -X GET "http://api.test/api/v1/leads"\n```',
      },
      post: {
        tags: ['Leads'],
        summary: 'Create',
        'x-leados-permission': 'lead:create',
        'x-leados-feature': 'lead_capture',
        security: [{ sessionToken: [] }, { apiKey: [] }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['phone'],
                properties: { phone: { type: 'string' }, firstName: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    '/api/v1/auth/me': {
      get: {
        tags: ['Auth'],
        summary: 'Me',
        'x-leados-session-only': true,
        security: [{ sessionToken: [] }],
      },
    },
    '/api/v1/public/leads/{organizationPublicKey}': {
      post: { tags: ['Public Ingest'], summary: 'Capture', security: [] },
    },
  },
} as Record<string, unknown>;

describe('the docs page', () => {
  const html = renderDocsPage(document, '/openapi.json');

  it('is a whole page with no script tag and no external request', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    // The decision this page exists to make: no CDN, so it renders on a machine that can reach
    // this API and nothing else.
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\/(cdn|unpkg|jsdelivr)/i);
  });

  it('groups endpoints by tag, in alphabetical order, and links to each group', () => {
    const order = ['>Auth<', '>Leads<', '>Public Ingest<'].map((needle) => html.indexOf(needle));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order]).toEqual([...order].sort((a, b) => a - b));
    expect(html).toContain('href="#leads"');
  });

  it('says what each endpoint needs, in words', () => {
    expect(html).toMatch(/permission <code>lead:read<\/code>/);
    expect(html).toMatch(/plan feature <code>lead_capture<\/code>/);
    expect(html).toMatch(/a signed-in person only — not an API key/);
    // A public endpoint has to say so, or a reader assumes a credential they do not need.
    expect(html).toMatch(/Needs: public/);
  });

  it('lists query parameters and body fields with their types and whether they are required', () => {
    expect(html).toMatch(/<code>limit<\/code>[\s\S]*?integer/);
    expect(html).toMatch(/<code>phone<\/code>[\s\S]*?required/);
    expect(html).toMatch(/<code>firstName<\/code>[\s\S]*?optional/);
  });

  it('shows the copy-paste curl the document carries', () => {
    expect(html).toMatch(/curl -X GET &quot;http:\/\/api.test\/api\/v1\/leads&quot;/);
  });

  it('escapes everything that comes from the document', () => {
    const hostile = renderDocsPage(
      { info: { title: '</title><script>alert(1)</script>' }, paths: {} },
      '/openapi.json',
    );
    expect(hostile).not.toMatch(/<script>alert/);
    expect(escapeHtml('<a href="x">&\'')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });
});

describe('the errors page', () => {
  const html = renderErrorsPage();

  it('lists every code with its status, meaning and next step', () => {
    for (const code of ['VALIDATION_FAILED', 'INVALID_API_KEY', 'LIMIT_EXCEEDED', 'RATE_LIMITED']) {
      expect(html, code).toContain(code);
    }
    expect(html).toMatch(/Do not retry/);
    expect(html).toMatch(/With backoff/);
  });

  it('is linkable per code, because a client library quotes one', () => {
    expect(html).toMatch(/id="RATE_LIMITED"/);
  });

  it('distinguishes the quota from the burst limit, which is the pair clients get wrong', () => {
    expect(html).toMatch(/LIMIT_EXCEEDED[\s\S]{0,400}403/);
    expect(html).toMatch(/RATE_LIMITED[\s\S]{0,400}429/);
  });
});

describe('the page on a phone, and in a browser with no network', () => {
  const html = renderDocsPage(document, '/openapi.json');

  it('asks for no favicon, so the API does not answer 404 in a reader’s console', () => {
    // Found by a browser check: a page with no `<link rel="icon">` makes the browser fetch
    // /favicon.ico, which this API does not have — a 404 in the console of the one page a
    // developer reads first, and a 404 in our own request log.
    expect(html).toMatch(/<link rel="icon" href="data:,">/);
  });

  it('lets a table scroll inside its own box rather than widening the page', () => {
    // A table cannot reflow. Without the wrapper the page took 91px of sideways scroll at 375px.
    expect(html).toMatch(/<div class="scroll"><table/);
    expect(html).toMatch(/\.scroll \{ overflow-x: auto/);
    expect(html).toMatch(/overflow-wrap: anywhere/);
  });
});
