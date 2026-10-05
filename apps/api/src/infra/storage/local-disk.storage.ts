import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import {
  assertSafeKey,
  StorageKeyError,
  type PutObjectInput,
  type StoragePort,
  type StoredObject,
} from './storage.port.js';

/**
 * The development driver: objects are files under `STORAGE_LOCAL_ROOT`.
 *
 * It exists so the whole import/export feature is usable — and testable — without MinIO or an AWS
 * account, which is the same reasoning as `LoggingMailer`. Unlike that one it is *not* refused in
 * production: a single-node deployment with a mounted volume is a legitimate way to run this, and
 * `docs/deployment-architecture.md` §3 says so. What it cannot do is serve more than one node, so
 * the production checklist calls for the S3 driver as soon as the API is replicated.
 *
 * Two details that are not decoration:
 *
 *  * **Writes go to a temporary file and are renamed.** A reader fetching a document while an
 *    export is being written must never see half a CSV, and `rename` within a filesystem is atomic.
 *  * **Every resolved path is re-checked against the root.** `assertSafeKey` already rejects `..`,
 *    but a storage driver is exactly the place where a second, cheap check is worth having: the
 *    cost of being wrong once is reading `/etc/passwd`.
 */
@Injectable()
export class LocalDiskStorage implements StoragePort {
  readonly driver = 'local';
  private readonly root: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.root = resolve(config.STORAGE_LOCAL_ROOT);
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    const path = this.pathFor(input.key);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.partial`;
    await writeFile(temporary, input.body);
    await rename(temporary, path);
    return {
      key: input.key,
      sizeBytes: input.body.byteLength,
      checksum: createHash('sha256').update(input.body).digest('hex'),
    };
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathFor(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  private pathFor(key: string): string {
    assertSafeKey(key);
    const path = resolve(join(this.root, key));
    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new StorageKeyError(key, 'resolves outside the storage root');
    }
    return path;
  }
}
