import { errorCatalogueEntries, type ErrorCode } from '@leados/shared';
import { z, type ZodType } from 'zod';
import type { RouteDeclaration } from '../authz/route-audit.service.js';

/**
 * The OpenAPI 3.1 document, built from the routing table (`FR-API-3`).
 *
 * Pure: it takes the declarations the route collector already produces and returns an object, so
 * the shape of the published contract is unit-testable without booting an application.
 *
 * Two properties are the whole point of generating rather than writing it.
 *
 *  * **Every route is in it**, because the source is the same enumeration the authorization audit
 *    fails startup over. A document assembled from decorators is a document that silently omits
 *    whatever nobody decorated — and the endpoints nobody documents are the ones nobody tests.
 *  * **The schemas are the validators.** They are read off each route's own `ZodBody` pipes, so
 *    "documented" and "accepted" cannot drift apart.
 */

export interface OpenApiOptions {
  readonly version: string;
  readonly serverUrl: string;
  /** The versioned prefix the paths are published under (`/api/v1`). */
  readonly prefix: string;
}

type JsonObject = Record<string, unknown>;

/** The envelope every answer carries (§2 of `docs/api-architecture.md`), as a schema. */
const ENVELOPE_META: JsonObject = {
  type: 'object',
  properties: {
    requestId: { type: 'string', description: 'Quote this in a bug report; it is in our logs.' },
    pagination: { $ref: '#/components/schemas/Pagination' },
  },
  additionalProperties: true,
};

export function buildDocument(
  routes: readonly RouteDeclaration[],
  options: OpenApiOptions,
): JsonObject {
  const paths: JsonObject = {};
  const schemas: JsonObject = baseSchemas();

  for (const route of [...routes].sort(compareRoutes)) {
    // A route with no authorization declaration cannot start the app, so it cannot be documented
    // either; this keeps the generator honest if the audit is ever relaxed.
    if (route.declaration === 'missing') continue;

    const templated = templatePath(route.path, options.prefix);
    const entry = (paths[templated.path] ??= {}) as JsonObject;
    entry[route.httpMethod.toLowerCase()] = operation(route, templated.parameters, options);
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Lead OS API',
      version: options.version,
      summary: 'The API the product itself uses, reachable with an API key.',
      description: [
        'Every answer carries the same envelope: `{ success, data, meta }` on success and',
        '`{ success: false, error: { code, message, details?, requestId } }` on a refusal.',
        '',
        'Two credentials reach this API. A session token, which the web app uses, and an API key:',
        '`Authorization: Bearer <key id>.<secret>`. A key may only do what the member who created',
        'it can do, narrowed to the scopes it was given — so the permission named on each endpoint',
        'has to be in the key’s scopes **and** held by that member.',
        '',
        'Errors are listed with their meaning and what to do about them at `/docs/errors`.',
      ].join('\n'),
    },
    servers: [{ url: options.serverUrl, description: 'This deployment' }],
    tags: tagsOf(routes),
    paths,
    components: {
      schemas,
      // The operations reference these rather than repeating the error shape 600 times; each one
      // lists the codes that status can carry, from the same catalogue the errors page renders.
      responses: errorResponses(),
      securitySchemes: {
        sessionToken: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'A signed-in person’s access token, from `POST /auth/login`.',
        },
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          description:
            'An API key, as `<key id>.<secret>` — the two halves shown once when the key is created.',
        },
      },
    },
    security: [{ sessionToken: [] }, { apiKey: [] }],
  };
}

function operation(
  route: RouteDeclaration,
  pathParameters: readonly JsonObject[],
  options: OpenApiOptions,
): JsonObject {
  const parameters = [...pathParameters, ...queryParameters(route)];
  const operationId = `${route.controller.replace(/Controller$/, '')}_${route.method}`;

  const responses: JsonObject = {
    [String(route.successStatus)]: {
      description: 'The envelope, with this endpoint’s payload in `data`.',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } },
    },
  };
  for (const status of errorStatusesFor(route)) {
    responses[String(status)] = { $ref: `#/components/responses/Error${status}` };
  }

  return {
    operationId,
    tags: [tagOf(route)],
    summary: summaryOf(route),
    description: describe(route, options),
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(route.bodySchema ? { requestBody: requestBody(route.bodySchema) } : {}),
    responses,
    // The extensions carry what this product's authorization model needs and OpenAPI has no field
    // for. A generated client can read them; a person reads them on the docs page.
    ...(route.permission ? { 'x-leados-permission': route.permission } : {}),
    ...(route.feature ? { 'x-leados-feature': route.feature } : {}),
    ...(route.sessionOnly ? { 'x-leados-session-only': true } : {}),
    security: securityFor(route),
  };
}

/** `public` → no credential; `session-only` → a token only; otherwise either credential. */
function securityFor(route: RouteDeclaration): JsonObject[] {
  if (route.declaration === 'public') return [];
  if (route.sessionOnly) return [{ sessionToken: [] }];
  return [{ sessionToken: [] }, { apiKey: [] }];
}

function requestBody(schema: ZodType): JsonObject {
  return {
    required: true,
    content: { 'application/json': { schema: toJsonSchema(schema) } },
  };
}

/**
 * A query schema becomes one parameter per property, which is what a query string is.
 *
 * Every value in a query string is a string, which the DTOs already know — this is why they use
 * `z.enum(['true','false'])` rather than `z.boolean()` — so the rendered types are the ones a
 * client actually sends.
 */
function queryParameters(route: RouteDeclaration): JsonObject[] {
  if (!route.querySchema) return [];
  const json = toJsonSchema(route.querySchema);
  const properties = (json['properties'] ?? {}) as Record<string, JsonObject>;
  const required = new Set((json['required'] ?? []) as string[]);
  return Object.entries(properties).map(([name, propertySchema]) => ({
    name,
    in: 'query',
    required: required.has(name),
    schema: propertySchema,
    ...(propertySchema['description'] ? { description: propertySchema['description'] } : {}),
  }));
}

/** `:id` in Nest's path is `{id}` in OpenAPI, and each one is a required parameter. */
export function templatePath(
  path: string,
  prefix: string,
): { path: string; parameters: JsonObject[] } {
  const parameters: JsonObject[] = [];
  const templated = path.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    parameters.push({
      name,
      in: 'path',
      required: true,
      schema: { type: 'string', ...(name.toLowerCase().endsWith('id') ? { format: 'uuid' } : {}) },
      description:
        name === 'id'
          ? 'The resource’s id. A malformed id answers 404, exactly as another workspace’s id does.'
          : undefined,
    });
    return `{${name}}`;
  });
  return { path: `${prefix}/${templated}`.replace(/\/+/g, '/'), parameters };
}

/**
 * Zod 4 renders JSON Schema itself, which is why there is no translation layer here to get wrong.
 *
 * `io: 'input'` matters: several DTOs transform on the way in (a `'true'`/`'false'` enum becoming
 * a boolean, a coerced date), and what a client sends is the input side.
 */
export function toJsonSchema(schema: ZodType): JsonObject {
  try {
    return z.toJSONSchema(schema, {
      target: 'draft-2020-12',
      io: 'input',
      // A schema Zod cannot render (a transform with no declared input type) becomes `{}` rather
      // than failing the whole document: a missing field description is a smaller problem than no
      // document at all.
      unrepresentable: 'any',
    }) as JsonObject;
  } catch {
    return { type: 'object', description: 'This endpoint’s schema could not be rendered.' };
  }
}

function errorStatusesFor(route: RouteDeclaration): number[] {
  const statuses = new Set<number>([400, 429, 500]);
  if (route.declaration !== 'public') {
    statuses.add(401);
    statuses.add(403);
  }
  if (route.path.includes(':')) statuses.add(404);
  if (route.httpMethod !== 'GET') statuses.add(422);
  return [...statuses].sort((a, b) => a - b);
}

function summaryOf(route: RouteDeclaration): string {
  // The handler's name, said as a sentence: `findOne` → "Find one", `rotateSecret` → "Rotate
  // secret". Better than nothing and never out of date, which a hand-written summary is not.
  const words = route.method
    .replace(/([A-Z])/g, ' $1')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function describe(route: RouteDeclaration, options: OpenApiOptions): string {
  const lines: string[] = [];
  if (route.declaration === 'public') {
    lines.push('**Public** — no credential needed.');
  } else if (route.permission) {
    lines.push(`Needs the \`${route.permission}\` permission.`);
  } else if (route.exemptReason) {
    lines.push(`Authenticated, no specific permission: ${route.exemptReason}.`);
  }
  if (route.feature) lines.push(`Needs the \`${route.feature}\` plan feature.`);
  if (route.sessionOnly) {
    lines.push('About the signed-in person, so an API key cannot use it.');
  }
  lines.push('', '```bash', curlFor(route, options), '```');
  return lines.join('\n');
}

/** The copy-paste `curl` the brief asks for, per endpoint — with no secret in it. */
export function curlFor(route: RouteDeclaration, options: OpenApiOptions): string {
  const { path } = templatePath(route.path, options.prefix);
  const url = `${options.serverUrl.replace(/\/+$/, '')}${path}`;
  const lines = [`curl -X ${route.httpMethod} "${url}" \\`];
  if (route.declaration !== 'public') {
    lines.push(
      route.sessionOnly
        ? `  -H "Authorization: Bearer $LEADOS_TOKEN" \\`
        : `  -H "Authorization: Bearer $LEADOS_KEY_ID.$LEADOS_SECRET" \\`,
    );
  }
  if (route.bodySchema) {
    lines.push(
      `  -H "Content-Type: application/json" \\`,
      `  -d '${exampleFor(route.bodySchema)}'`,
    );
  } else {
    lines[lines.length - 1] = (lines[lines.length - 1] ?? '').replace(/ \\$/, '');
  }
  return lines.join('\n');
}

/**
 * A body example, from the schema's own required fields.
 *
 * Only the required ones, and only their types: a fabricated example with plausible names in it
 * reads as real data and gets copied into production.
 */
export function exampleFor(schema: ZodType): string {
  const json = toJsonSchema(schema);
  const properties = (json['properties'] ?? {}) as Record<string, JsonObject>;
  const required = (json['required'] ?? []) as string[];
  const body: Record<string, unknown> = {};
  for (const name of required) {
    body[name] = placeholderFor(properties[name] ?? {});
  }
  // A schema with nothing required still needs a body for the example to be runnable.
  if (required.length === 0 && Object.keys(properties).length > 0) {
    const [first] = Object.keys(properties);
    if (first) body[first] = placeholderFor(properties[first] ?? {});
  }
  return JSON.stringify(body);
}

function placeholderFor(property: JsonObject): unknown {
  const type = property['type'];
  const enumValues = property['enum'] as unknown[] | undefined;
  if (enumValues && enumValues.length > 0) return enumValues[0];
  if (type === 'number' || type === 'integer') return 0;
  if (type === 'boolean') return true;
  if (type === 'array') return [];
  if (type === 'object') return {};
  if (property['format'] === 'uuid') return '00000000-0000-0000-0000-000000000000';
  return '…';
}

/** One tag per controller, named after the resource rather than the class. */
function tagOf(route: RouteDeclaration): string {
  return route.controller
    .replace(/Controller$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
}

function tagsOf(routes: readonly RouteDeclaration[]): JsonObject[] {
  const names = [...new Set(routes.map(tagOf))].sort((a, b) => a.localeCompare(b));
  return names.map((name) => ({ name }));
}

function compareRoutes(a: RouteDeclaration, b: RouteDeclaration): number {
  return a.path.localeCompare(b.path) || a.httpMethod.localeCompare(b.httpMethod);
}

function baseSchemas(): JsonObject {
  const errorCodes = errorCatalogueEntries().map((entry) => entry.code satisfies ErrorCode);
  return {
    Envelope: {
      type: 'object',
      required: ['success', 'data', 'meta'],
      properties: {
        success: { const: true },
        data: { description: 'The endpoint’s payload. A list endpoint answers an array.' },
        message: { type: 'string', description: 'Shown to a person when one is sent.' },
        meta: ENVELOPE_META,
      },
    },
    Pagination: {
      type: 'object',
      description: 'Present on every list. Cursors are opaque; do not construct one.',
      properties: {
        limit: { type: 'integer' },
        nextCursor: { type: ['string', 'null'] },
        prevCursor: { type: ['string', 'null'] },
        hasMore: { type: 'boolean' },
        total: { type: 'integer' },
        totalIsEstimate: { type: 'boolean' },
      },
    },
    Error: {
      type: 'object',
      required: ['success', 'error'],
      properties: {
        success: { const: false },
        error: {
          type: 'object',
          required: ['code', 'message'],
          properties: {
            code: { type: 'string', enum: errorCodes },
            message: {
              type: 'string',
              description:
                'Written for a person. Show it rather than paraphrasing it — a refusal we worded is the one thing not to replace with "that is not allowed".',
            },
            details: { description: 'Field errors on a 400, or context on a refusal.' },
            requestId: { type: 'string' },
          },
        },
      },
    },
  };
}

/** The reusable error responses the operations reference. */
export function errorResponses(): JsonObject {
  const responses: JsonObject = {};
  for (const status of [400, 401, 403, 404, 409, 422, 429, 500]) {
    const codes = errorCatalogueEntries().filter((entry) => entry.status === status);
    responses[`Error${status}`] = {
      description:
        codes.length > 0
          ? codes.map((entry) => `\`${entry.code}\` — ${entry.meaning}`).join('\n\n')
          : 'A refusal in the standard error shape.',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    };
  }
  return responses;
}
