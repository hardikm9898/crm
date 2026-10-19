import 'reflect-metadata';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { config as loadDotenv } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module.js';
import { OpenApiService } from '../src/infra/openapi/openapi.service.js';
import { openApiArtifactPath, serialiseDocument } from '../src/infra/openapi/artifact.js';

loadDotenv({ path: resolve(import.meta.dirname, '../../../.env'), quiet: true });

/**
 * Writes `docs/openapi.json` from the running application's routing table.
 *
 * `pnpm --filter @leados/api openapi:write`, and the only way the committed artifact is meant to
 * change: hand-editing it would make the diff check pass while the API did something else.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  try {
    const document = app.get(OpenApiService).document();
    const path = openApiArtifactPath();
    await writeFile(path, serialiseDocument(document), 'utf8');
    const paths = Object.keys((document['paths'] ?? {}) as Record<string, unknown>).length;
    console.log(`wrote ${path} — ${paths} paths`);
  } finally {
    await app.close();
  }
}

await main();
