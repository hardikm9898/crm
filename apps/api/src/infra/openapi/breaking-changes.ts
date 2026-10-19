/**
 * What changed between two published documents, and whether it breaks a client (`FR-API-3`).
 *
 * Pure, and the reason the committed artifact is worth having: a diff that a human reads is a
 * diff a human skims, so the build has to say which changes are **breaking** rather than which
 * bytes moved. The classification is deliberately conservative — a change this cannot reason
 * about is reported as breaking, because the cost of the two mistakes is not symmetrical: a false
 * alarm is a sentence in a commit message, and a missed one is somebody's integration failing in
 * production on a release that was green.
 */

export type ChangeKind = 'breaking' | 'additive' | 'cosmetic';

export interface SpecChange {
  readonly kind: ChangeKind;
  /** `GET /api/v1/leads`, or `components.schemas.Lead`. */
  readonly where: string;
  readonly what: string;
}

type JsonObject = Record<string, unknown>;

export function diffDocuments(before: JsonObject, after: JsonObject): SpecChange[] {
  const changes: SpecChange[] = [];
  const beforePaths = (before['paths'] ?? {}) as JsonObject;
  const afterPaths = (after['paths'] ?? {}) as JsonObject;

  for (const [path, operations] of Object.entries(beforePaths)) {
    const afterOperations = afterPaths[path] as JsonObject | undefined;
    if (!afterOperations) {
      changes.push({ kind: 'breaking', where: path, what: 'the path was removed' });
      continue;
    }
    for (const [method, operation] of Object.entries(operations as JsonObject)) {
      const where = `${method.toUpperCase()} ${path}`;
      const afterOperation = afterOperations[method] as JsonObject | undefined;
      if (!afterOperation) {
        changes.push({ kind: 'breaking', where, what: 'the operation was removed' });
        continue;
      }
      changes.push(...diffOperation(where, operation as JsonObject, afterOperation));
    }
  }

  for (const [path, operations] of Object.entries(afterPaths)) {
    const beforeOperations = beforePaths[path] as JsonObject | undefined;
    if (!beforeOperations) {
      changes.push({ kind: 'additive', where: path, what: 'a new path' });
      continue;
    }
    for (const method of Object.keys(operations as JsonObject)) {
      if (!beforeOperations[method]) {
        changes.push({
          kind: 'additive',
          where: `${method.toUpperCase()} ${path}`,
          what: 'a new operation',
        });
      }
    }
  }

  return changes;
}

function diffOperation(where: string, before: JsonObject, after: JsonObject): SpecChange[] {
  const changes: SpecChange[] = [];

  // A permission that changed is breaking for whoever held the old one — including every API key
  // whose scopes name it.
  const beforePermission = before['x-leados-permission'];
  const afterPermission = after['x-leados-permission'];
  if (beforePermission !== afterPermission) {
    changes.push({
      kind: 'breaking',
      where,
      what: `the permission changed from ${String(beforePermission ?? 'none')} to ${String(afterPermission ?? 'none')}`,
    });
  }

  // Requiring a plan feature that was not required is a 403 for every workspace without it.
  if (!before['x-leados-feature'] && after['x-leados-feature']) {
    changes.push({
      kind: 'breaking',
      where,
      what: `it now needs the ${String(after['x-leados-feature'])} plan feature`,
    });
  }

  // Closing a route to API keys breaks every integration using one.
  if (!before['x-leados-session-only'] && after['x-leados-session-only']) {
    changes.push({ kind: 'breaking', where, what: 'an API key can no longer use it' });
  }

  changes.push(...diffRequired(where, before, after));
  changes.push(...diffParameters(where, before, after));

  const beforeStatuses = Object.keys((before['responses'] ?? {}) as JsonObject);
  const afterStatuses = new Set(Object.keys((after['responses'] ?? {}) as JsonObject));
  const removedSuccess = beforeStatuses.filter(
    (status) => Number(status) < 400 && !afterStatuses.has(status),
  );
  for (const status of removedSuccess) {
    changes.push({ kind: 'breaking', where, what: `it no longer answers ${status}` });
  }

  return changes;
}

/** A newly required body field refuses every request a client was sending yesterday. */
function diffRequired(where: string, before: JsonObject, after: JsonObject): SpecChange[] {
  const beforeRequired = new Set(requiredOf(before));
  const afterRequired = requiredOf(after);
  return afterRequired
    .filter((field) => !beforeRequired.has(field))
    .map((field) => ({
      kind: 'breaking' as const,
      where,
      what: `the body field \`${field}\` is now required`,
    }));
}

function requiredOf(operation: JsonObject): string[] {
  const body = operation['requestBody'] as JsonObject | undefined;
  const content = (body?.['content'] ?? {}) as JsonObject;
  const json = (content['application/json'] ?? {}) as JsonObject;
  const schema = (json['schema'] ?? {}) as JsonObject;
  return (schema['required'] ?? []) as string[];
}

function diffParameters(where: string, before: JsonObject, after: JsonObject): SpecChange[] {
  const changes: SpecChange[] = [];
  const beforeParameters = parametersOf(before);
  const afterParameters = parametersOf(after);

  for (const [name, parameter] of afterParameters) {
    const previous = beforeParameters.get(name);
    if (!previous && parameter.required) {
      changes.push({ kind: 'breaking', where, what: `the \`${name}\` parameter is now required` });
    } else if (!previous) {
      changes.push({ kind: 'additive', where, what: `a new \`${name}\` parameter` });
    } else if (!previous.required && parameter.required) {
      changes.push({ kind: 'breaking', where, what: `\`${name}\` became required` });
    }
  }
  for (const [name] of beforeParameters) {
    if (!afterParameters.has(name)) {
      // Removing a parameter is not an error for a client that stops sending it, but it is for one
      // that depends on the filtering it did.
      changes.push({ kind: 'breaking', where, what: `the \`${name}\` parameter was removed` });
    }
  }
  return changes;
}

function parametersOf(operation: JsonObject): Map<string, { required: boolean }> {
  const list = (operation['parameters'] ?? []) as JsonObject[];
  return new Map(
    list.map((parameter) => [
      `${String(parameter['in'])}:${String(parameter['name'])}`,
      { required: parameter['required'] === true },
    ]),
  );
}

export function breakingOnly(changes: readonly SpecChange[]): SpecChange[] {
  return changes.filter((change) => change.kind === 'breaking');
}

/** The message the build prints. One line per change, breaking ones first. */
export function describeChanges(changes: readonly SpecChange[]): string {
  if (changes.length === 0) return 'The published API document is unchanged.';
  const order: ChangeKind[] = ['breaking', 'additive', 'cosmetic'];
  return [...changes]
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.where.localeCompare(b.where))
    .map((change) => `  ${change.kind === 'breaking' ? '✗' : '+'} ${change.where}: ${change.what}`)
    .join('\n');
}
