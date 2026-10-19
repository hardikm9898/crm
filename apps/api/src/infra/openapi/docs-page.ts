import { errorCatalogueEntries } from '@leados/shared';

/**
 * The published documentation, rendered on the server from the document itself (`FR-API-3`).
 *
 * **No CDN, no client-side JavaScript.** Scalar and Redoc are better-looking, and both mean the
 * docs page is blank on a deployment that cannot reach a CDN — which is exactly the deployment
 * whose operator most needs to read it — and that a developer's first impression of our API is a
 * spinner. A server-rendered page from the same document costs one function, works offline, is
 * readable in a terminal browser, and can be diffed.
 *
 * The page is generated from `/openapi.json`, so there is nothing to keep in step: the endpoint
 * list, the permissions, the schemas and the `curl` examples are the document's own.
 */

type JsonObject = Record<string, unknown>;

export function renderDocsPage(document: JsonObject, specUrl: string): string {
  const info = (document['info'] ?? {}) as JsonObject;
  const paths = (document['paths'] ?? {}) as JsonObject;
  const grouped = groupByTag(paths);
  const total = [...grouped.values()].reduce((count, operations) => count + operations.length, 0);

  const nav = [...grouped.keys()]
    .map((tag) => `<li><a href="#${slug(tag)}">${escapeHtml(tag)}</a></li>`)
    .join('');

  const sections = [...grouped.entries()]
    .map(([tag, operations]) => renderTag(tag, operations))
    .join('');

  return layout(
    'Lead OS API',
    `
    <header>
      <h1>${escapeHtml(String(info['title'] ?? 'API'))}</h1>
      <p class="lede">${escapeHtml(String(info['summary'] ?? ''))}</p>
      <p class="meta">
        Version ${escapeHtml(String(info['version'] ?? '—'))} ·
        ${total} endpoints ·
        <a href="${escapeHtml(specUrl)}">OpenAPI 3.1 document</a> ·
        <a href="/docs/errors">Errors</a>
      </p>
      <div class="intro">${renderMarkdownish(String(info['description'] ?? ''))}</div>
    </header>
    <nav aria-label="Sections"><ul>${nav}</ul></nav>
    <main>${sections}</main>
  `,
  );
}

export function renderErrorsPage(): string {
  const rows = errorCatalogueEntries()
    .map(
      (entry) => `
      <tr id="${escapeHtml(entry.code)}">
        <td><code>${escapeHtml(entry.code)}</code></td>
        <td class="status">${entry.status}</td>
        <td>${escapeHtml(entry.meaning)}</td>
        <td>${escapeHtml(entry.whatToDo)}</td>
        <td class="retry">${escapeHtml(retryLabel(entry.retry))}</td>
      </tr>`,
    )
    .join('');

  return layout(
    'Lead OS API — errors',
    `
    <header>
      <h1>Every error this API answers</h1>
      <p class="lede">
        A refusal carries a stable <code>code</code> a client branches on, a message written for a
        person, and the request id to quote. Branch on the code; show the message.
      </p>
      <p class="meta"><a href="/docs">Back to the endpoints</a></p>
    </header>
    <main>
      <div class="scroll">
        <table>
          <thead>
            <tr><th>Code</th><th>Status</th><th>What it means</th><th>What to do</th><th>Retry</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </main>
  `,
  );
}

function renderTag(tag: string, operations: readonly Operation[]): string {
  const rendered = operations
    .map(
      (operation) => `
      <article class="endpoint" id="${slug(`${operation.method} ${operation.path}`)}">
        <h3>
          <span class="verb verb-${operation.method.toLowerCase()}">${operation.method}</span>
          <code>${escapeHtml(operation.path)}</code>
        </h3>
        <p class="summary">${escapeHtml(operation.summary)}</p>
        ${renderAuthorization(operation)}
        ${renderParameters(operation)}
        ${renderBody(operation)}
        ${renderCurl(operation)}
      </article>`,
    )
    .join('');
  return `<section id="${slug(tag)}"><h2>${escapeHtml(tag)}</h2>${rendered}</section>`;
}

function renderAuthorization(operation: Operation): string {
  const parts: string[] = [];
  if (operation.permission)
    parts.push(`permission <code>${escapeHtml(operation.permission)}</code>`);
  if (operation.feature) parts.push(`plan feature <code>${escapeHtml(operation.feature)}</code>`);
  if (operation.sessionOnly) parts.push('a signed-in person only — not an API key');
  if (parts.length === 0) parts.push(operation.public ? 'public' : 'any authenticated caller');
  return `<p class="authz">Needs: ${parts.join(' · ')}</p>`;
}

function renderParameters(operation: Operation): string {
  if (operation.parameters.length === 0) return '';
  const rows = operation.parameters
    .map(
      (parameter) => `
      <tr>
        <td><code>${escapeHtml(parameter.name)}</code></td>
        <td>${escapeHtml(parameter.in)}</td>
        <td>${escapeHtml(parameter.type)}</td>
        <td>${parameter.required ? 'required' : 'optional'}</td>
      </tr>`,
    )
    .join('');
  return `<div class="scroll"><table class="params"><thead><tr><th>Name</th><th>In</th><th>Type</th><th/></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderBody(operation: Operation): string {
  if (!operation.bodyFields) return '';
  if (operation.bodyFields.length === 0) {
    return '<p class="body-note">Takes a JSON body; see the document for its schema.</p>';
  }
  const rows = operation.bodyFields
    .map(
      (field) => `
      <tr>
        <td><code>${escapeHtml(field.name)}</code></td>
        <td>${escapeHtml(field.type)}</td>
        <td>${field.required ? 'required' : 'optional'}</td>
      </tr>`,
    )
    .join('');
  return `<div class="scroll"><table class="params"><thead><tr><th>Body field</th><th>Type</th><th/></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderCurl(operation: Operation): string {
  if (!operation.curl) return '';
  return `<pre class="curl"><code>${escapeHtml(operation.curl)}</code></pre>`;
}

interface Operation {
  readonly method: string;
  readonly path: string;
  readonly summary: string;
  readonly permission?: string;
  readonly feature?: string;
  readonly sessionOnly: boolean;
  readonly public: boolean;
  readonly parameters: readonly { name: string; in: string; type: string; required: boolean }[];
  readonly bodyFields?: readonly { name: string; type: string; required: boolean }[];
  readonly curl?: string;
}

function groupByTag(paths: JsonObject): Map<string, Operation[]> {
  const grouped = new Map<string, Operation[]>();
  for (const [path, operations] of Object.entries(paths)) {
    for (const [method, raw] of Object.entries(operations as JsonObject)) {
      const operation = raw as JsonObject;
      const tag = ((operation['tags'] ?? []) as string[])[0] ?? 'Other';
      const list = grouped.get(tag) ?? [];
      list.push(toOperation(method, path, operation));
      grouped.set(tag, list);
    }
  }
  return new Map(
    [...grouped.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tag, operations]) => [
        tag,
        operations.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)),
      ]),
  );
}

function toOperation(method: string, path: string, operation: JsonObject): Operation {
  const security = (operation['security'] ?? []) as JsonObject[];
  const parameters = ((operation['parameters'] ?? []) as JsonObject[]).map((parameter) => ({
    name: String(parameter['name']),
    in: String(parameter['in']),
    type: typeOf((parameter['schema'] ?? {}) as JsonObject),
    required: parameter['required'] === true,
  }));

  const body = operation['requestBody'] as JsonObject | undefined;
  const schema = body
    ? ((((body['content'] ?? {}) as JsonObject)['application/json'] as JsonObject | undefined)?.[
        'schema'
      ] as JsonObject | undefined)
    : undefined;

  return {
    method: method.toUpperCase(),
    path,
    summary: String(operation['summary'] ?? ''),
    ...(operation['x-leados-permission']
      ? { permission: String(operation['x-leados-permission']) }
      : {}),
    ...(operation['x-leados-feature'] ? { feature: String(operation['x-leados-feature']) } : {}),
    sessionOnly: operation['x-leados-session-only'] === true,
    public: security.length === 0,
    parameters,
    ...(schema ? { bodyFields: fieldsOf(schema) } : {}),
    ...(curlOf(operation) ? { curl: curlOf(operation) } : {}),
  };
}

function fieldsOf(schema: JsonObject): { name: string; type: string; required: boolean }[] {
  const properties = (schema['properties'] ?? {}) as Record<string, JsonObject>;
  const required = new Set((schema['required'] ?? []) as string[]);
  return Object.entries(properties).map(([name, property]) => ({
    name,
    type: typeOf(property),
    required: required.has(name),
  }));
}

function typeOf(schema: JsonObject): string {
  const enumValues = schema['enum'] as unknown[] | undefined;
  if (enumValues) return enumValues.map((value) => JSON.stringify(value)).join(' | ');
  const anyOf = schema['anyOf'] as JsonObject[] | undefined;
  if (anyOf) return anyOf.map(typeOf).join(' | ');
  const type = schema['type'];
  if (Array.isArray(type)) return type.join(' | ');
  if (type === 'array') return `${typeOf((schema['items'] ?? {}) as JsonObject)}[]`;
  if (schema['format']) return `${String(type ?? 'string')} (${String(schema['format'])})`;
  return String(type ?? 'any');
}

/** The `curl` block the generator put in the description. */
function curlOf(operation: JsonObject): string | undefined {
  const description = String(operation['description'] ?? '');
  const match = /```bash\n([\s\S]*?)```/.exec(description);
  return match?.[1]?.trim();
}

/**
 * Enough Markdown for the document's own description: paragraphs, `code` and **bold**.
 *
 * A Markdown library would be a dependency for one block of prose we wrote ourselves, and
 * everything that reaches it is escaped first, so there is no path from the document to HTML.
 */
function renderMarkdownish(text: string): string {
  return text
    .split('\n\n')
    .map(
      (paragraph) =>
        `<p>${escapeHtml(paragraph)
          .replace(/`([^`]+)`/g, '<code>$1</code>')
          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
          .replace(/\n/g, ' ')}</p>`,
    )
    .join('');
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function retryLabel(retry: 'never' | 'after-fixing' | 'with-backoff'): string {
  switch (retry) {
    case 'never':
      return 'Do not retry';
    case 'after-fixing':
      return 'After fixing the request';
    default:
      return 'With backoff';
  }
}

function layout(title: string, body: string): string {
  // One stylesheet, inline, with a dark scheme: the page has to render on a machine that can
  // reach this API and nothing else.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- An empty data URI, so a browser does not ask this API for a /favicon.ico it does not have:
     the 404 would appear in the reader's console and in our own request log. -->
<link rel="icon" href="data:,">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --ink: #111827; --muted: #6b7280; --line: #e5e7eb; --bg: #ffffff; --code: #f3f4f6; }
  @media (prefers-color-scheme: dark) {
    :root { --ink: #e5e7eb; --muted: #9ca3af; --line: #374151; --bg: #111827; --code: #1f2937; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
         font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  header, nav, main { max-width: 56rem; margin: 0 auto; padding: 0 16px; }
  header { padding-top: 2.5rem; }
  h1 { font-size: 1.9rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.3rem; margin: 2.5rem 0 .75rem; padding-bottom: .35rem; border-bottom: 1px solid var(--line); }
  h3 { font-size: 1rem; margin: 0 0 .35rem; display: flex; gap: .5rem; align-items: baseline; flex-wrap: wrap; }
  .lede { font-size: 1.05rem; color: var(--muted); margin: 0 0 .5rem; }
  .meta, .authz, .summary, .body-note { color: var(--muted); font-size: .9rem; }
  .meta { margin: 0 0 1rem; }
  nav ul { list-style: none; display: flex; flex-wrap: wrap; gap: .5rem 1rem; padding: 0; margin: 1rem 0 0; }
  a { color: inherit; }
  .endpoint { border: 1px solid var(--line); border-radius: 8px; padding: 1rem; margin: 0 0 1rem; }
  .verb { font: 600 .75rem/1 ui-monospace, monospace; letter-spacing: .04em;
          padding: .3rem .45rem; border-radius: 4px; background: var(--code); }
  .verb-get { color: #166534; } .verb-post { color: #1d4ed8; }
  .verb-patch, .verb-put { color: #92400e; } .verb-delete { color: #991b1b; }
  code { background: var(--code); padding: .1rem .3rem; border-radius: 4px;
         font: .85em ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre { background: var(--code); padding: .75rem; border-radius: 6px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  /* A table cannot reflow, so it scrolls inside its own box. Without this the page took 91px of
     sideways scroll at 375px — found by a browser check at phone width, not by reading the CSS. */
  .scroll { overflow-x: auto; margin: .75rem 0; }
  table { width: 100%; border-collapse: collapse; font-size: .9rem; }
  /* A long path or a curl line wraps rather than widening the page. A backtick in this
     comment would end the template literal the stylesheet lives in. */
  code, pre code { overflow-wrap: anywhere; }
  pre { white-space: pre-wrap; }
  h3 code { overflow-wrap: anywhere; }
  th, td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: .8rem; text-transform: uppercase; letter-spacing: .03em; }
  td.status, td.retry { white-space: nowrap; }
  main { padding-bottom: 4rem; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}
