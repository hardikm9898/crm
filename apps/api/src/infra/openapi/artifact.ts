import { resolve } from 'node:path';

/**
 * Where the committed document lives, and how it is written.
 *
 * One function so the writer script, the diff check and the docs page cannot disagree about the
 * path or about the formatting — a document serialised two ways produces a diff on every run and
 * a check nobody believes.
 */
export function openApiArtifactPath(): string {
  // `apps/api/src/infra/openapi` → the repository root.
  return resolve(import.meta.dirname, '../../../../../docs/openapi.json');
}

/** Two-space JSON with a trailing newline: a diff a reviewer can read line by line. */
export function serialiseDocument(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
