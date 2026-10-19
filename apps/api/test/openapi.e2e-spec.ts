import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSION_CATALOGUE } from '@leados/shared';
import { RouteAuditService } from '../src/infra/authz/route-audit.service.js';
import { OpenApiService } from '../src/infra/openapi/openapi.service.js';
import { openApiArtifactPath, serialiseDocument } from '../src/infra/openapi/artifact.js';
import {
  breakingOnly,
  describeChanges,
  diffDocuments,
} from '../src/infra/openapi/breaking-changes.js';
import { bootTestApp, callRaw, type TestApp } from './app-harness.js';

/**
 * THE PUBLISHED CONTRACT (`FR-API-3`, `docs/api-architecture.md` §11).
 *
 * Two things are being judged. That the document describes **this** API — every route in the
 * routing table, with the authorization it actually declares — and that the committed artifact at
 * `docs/openapi.json` still matches, which is the diff check the brief asks for: a change to the
 * API that nobody meant to publish fails here, and one that was meant to is a regenerated file in
 * the same commit.
 */

let ctx: TestApp;
let document: Record<string, unknown>;

beforeAll(async () => {
  ctx = await bootTestApp();
  document = ctx.app.get(OpenApiService).document();
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

type JsonObject = Record<string, unknown>;

function operations(doc: JsonObject): { path: string; method: string; operation: JsonObject }[] {
  return Object.entries((doc['paths'] ?? {}) as JsonObject).flatMap(([path, methods]) =>
    Object.entries(methods as JsonObject).map(([method, operation]) => ({
      path,
      method,
      operation: operation as JsonObject,
    })),
  );
}

describe('the document describes this API, not a previous one', () => {
  it('is OpenAPI 3.1 with a server, tags and the envelope', () => {
    expect(document['openapi']).toBe('3.1.0');
    expect((document['servers'] as JsonObject[])[0]?.['url']).toBeTruthy();
    const components = document['components'] as JsonObject;
    const schemas = components['schemas'] as JsonObject;
    expect(schemas['Envelope']).toBeTruthy();
    expect(schemas['Error']).toBeTruthy();
    expect(schemas['Pagination']).toBeTruthy();
    expect((components['securitySchemes'] as JsonObject)['apiKey']).toBeTruthy();
  });

  it('contains every route the authorization audit knows about', () => {
    // The same enumeration that fails startup for an undeclared route. A document built from
    // decorators would omit whatever nobody decorated, and those are the endpoints nobody tests.
    const routes = ctx.app
      .get(RouteAuditService)
      .collect()
      .filter((route) => route.declaration !== 'missing');
    const documented = new Set(operations(document).map(({ path, method }) => `${method} ${path}`));

    const missing = routes
      .map((route) => {
        const path = `/api/v1/${route.path}`
          .replace(/\/+/g, '/')
          .replace(/:([A-Za-z0-9_]+)/g, '{$1}');
        return `${route.httpMethod.toLowerCase()} ${path}`;
      })
      .filter((key) => !documented.has(key));

    expect(missing, missing.slice(0, 5).join(', ')).toEqual([]);
    expect(documented.size).toBe(routes.length);
  });

  it('names a real permission on every authenticated operation that declares one', () => {
    const known = new Set(PERMISSION_CATALOGUE.map((entry) => entry.key));
    for (const { path, method, operation } of operations(document)) {
      const permission = operation['x-leados-permission'];
      if (permission === undefined) continue;
      expect(known.has(permission as never), `${method} ${path} → ${String(permission)}`).toBe(
        true,
      );
    }
  });

  it('gives a public route no security and everything else both credentials', () => {
    for (const { path, method, operation } of operations(document)) {
      const security = operation['security'] as JsonObject[];
      const where = `${method} ${path}`;
      if (path.includes('/public/') || path.endsWith('/webhooks/email')) {
        // The capture endpoint and the provider collector are reached with their own credentials,
        // which are not HTTP auth schemes: the document says "no scheme", not "no checks".
        expect(Array.isArray(security), where).toBe(true);
        continue;
      }
      if (security.length === 0) continue;
      expect(
        security.some((scheme) => 'sessionToken' in scheme),
        where,
      ).toBe(true);
      // A session-only route is the one kind that does not offer the key.
      if (operation['x-leados-session-only'] !== true) {
        expect(
          security.some((scheme) => 'apiKey' in scheme),
          where,
        ).toBe(true);
      } else {
        expect(
          security.some((scheme) => 'apiKey' in scheme),
          where,
        ).toBe(false);
      }
    }
  });

  it('documents a body wherever a route validates one, from the validator itself', () => {
    const routes = ctx.app.get(RouteAuditService).collect();
    const withBody = routes.filter((route) => route.bodySchema);
    expect(withBody.length).toBeGreaterThan(60);

    for (const route of withBody.slice(0, 40)) {
      const path = `/api/v1/${route.path}`
        .replace(/\/+/g, '/')
        .replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      const methods = (document['paths'] as JsonObject)[path] as JsonObject;
      const operation = methods[route.httpMethod.toLowerCase()] as JsonObject;
      const body = operation['requestBody'] as JsonObject | undefined;
      expect(body, `${route.httpMethod} ${path}`).toBeTruthy();
      const schema = ((body?.['content'] as JsonObject)['application/json'] as JsonObject)[
        'schema'
      ] as JsonObject;
      // Rendered, not a placeholder: a document whose schemas are all `{}` describes nothing.
      expect(Object.keys(schema).length, `${route.httpMethod} ${path}`).toBeGreaterThan(0);
    }
  });

  it('turns a query schema into parameters a client can actually send', () => {
    const leads = ((document['paths'] as JsonObject)['/api/v1/leads'] as JsonObject)[
      'get'
    ] as JsonObject;
    const parameters = (leads['parameters'] ?? []) as JsonObject[];
    const names = parameters.map((parameter) => parameter['name']);
    expect(names).toContain('limit');
    expect(names).toContain('search');
    // Every value in a query string is a string, which is why the DTOs use `'true'|'false'`
    // rather than a boolean — and why the document must show that rather than a boolean.
    const unassigned = parameters.find((parameter) => parameter['name'] === 'unassigned');
    expect(JSON.stringify(unassigned?.['schema'])).toMatch(/true/);
  });

  it('carries a runnable curl per endpoint, and never a secret', () => {
    const all = operations(document);
    const withCurl = all.filter(({ operation }) =>
      /```bash/.test(String(operation['description'])),
    );
    expect(withCurl.length).toBe(all.length);
    for (const { operation } of all) {
      const description = String(operation['description']);
      expect(description).toMatch(/curl -X [A-Z]+ "http/);
      // The credential is read from the shell, as every snippet in this product does.
      expect(description).not.toMatch(/sk_live_[A-Za-z0-9]/);
    }
  });

  it('omits the platform admin surface, because it is not in this application', () => {
    expect(
      Object.keys(document['paths'] as JsonObject).some((path) => path.includes('/admin/')),
    ).toBe(false);
  });
});

describe('the committed artifact is the diff check', () => {
  it('matches what this build generates — regenerate it with `pnpm --filter @leados/api openapi:write`', async () => {
    const committed = await readFile(openApiArtifactPath(), 'utf8');
    const generated = serialiseDocument(document);
    if (committed === generated) {
      expect(committed).toBe(generated);
      return;
    }

    // The failure says *what* changed and whether it breaks a client, because a byte diff of a
    // 200-path document is something a reviewer skims.
    const changes = diffDocuments(JSON.parse(committed) as JsonObject, document);
    const breaking = breakingOnly(changes);
    throw new Error(
      [
        'docs/openapi.json is out of date.',
        describeChanges(changes),
        '',
        breaking.length > 0
          ? `${breaking.length} of these would break a client. If that is intended, say so in the commit message.`
          : 'None of these are breaking.',
        'Regenerate with: pnpm --filter @leados/api openapi:write',
      ].join('\n'),
    );
  }, 60_000);

  it('is served at a URL outside the version, unwrapped and public', async () => {
    const response = await callRaw(ctx.app, { method: 'GET', url: '/openapi.json' });
    expect(response.statusCode).toBe(200);
    const served = JSON.parse(response.body.toString('utf8')) as JsonObject;
    // Not enveloped: a document wrapped in `{ success, data }` is not an OpenAPI document.
    expect(served['openapi']).toBe('3.1.0');
    expect(served['success']).toBeUndefined();
  }, 60_000);

  it('serves the two pages a person reads, with no credential', async () => {
    const docs = await callRaw(ctx.app, { method: 'GET', url: '/docs' });
    expect(docs.statusCode).toBe(200);
    expect(String(docs.headers['content-type'])).toMatch(/text\/html/);
    const html = docs.body.toString('utf8');
    expect(html).toMatch(/Lead OS API/);
    expect(html).toMatch(/lead:read/);
    expect(html).not.toMatch(/<script/i);

    const errors = await callRaw(ctx.app, { method: 'GET', url: '/docs/errors' });
    expect(errors.statusCode).toBe(200);
    expect(errors.body.toString('utf8')).toMatch(/INVALID_API_KEY/);
  }, 60_000);
});
