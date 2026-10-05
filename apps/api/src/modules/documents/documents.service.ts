import { Inject, Injectable } from '@nestjs/common';
import { AppError, newId, tenantContext, withPlatformScope } from '@leados/shared';
import type { Logger } from 'pino';
import { DbService } from '../../infra/db/db.service.js';
import { EntitlementService } from '../../infra/entitlements/entitlement.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { STORAGE, documentKey, type StoragePort } from '../../infra/storage/storage.port.js';

/**
 * The `documents` table is the index of everything in object storage, and this service is the only
 * thing that writes to both.
 *
 * Why a row per object at all, when the bucket already holds the file: because the row is
 * tenant-scoped and the bucket is not. Every read above this service names a document id, which the
 * scoped client refuses to return for another tenant — so a storage key never has to be trusted,
 * and nothing above the port can enumerate what a bucket holds (`docs/security.md` §3).
 *
 * The order of operations is deliberate and the same in both directions:
 *
 *  * **Writing:** bytes first, then the row. A row pointing at bytes that are not there is a
 *    download that fails; bytes with no row are an orphan the sweep can find by prefix. The first
 *    is visible to a user, the second is not.
 *  * **Deleting:** row first (soft), then the bytes. A document that is still listed but whose
 *    bytes are gone is the worse of the two, so the listing stops showing it before the file goes.
 */
export interface StoreDocumentInput {
  /** `import`, `import-errors`, `export` — the same vocabulary the database CHECK constraint holds. */
  readonly subject: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly body: Buffer;
  /** When set, the sweep drops the bytes after this instant (`FR-IO-3`). */
  readonly expiresAt?: Date | null;
}

export interface StoredDocument {
  readonly id: string;
  readonly fileKey: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly checksum: string;
  readonly expiresAt: Date | null;
}

@Injectable()
export class DocumentsService {
  constructor(
    private readonly db: DbService,
    private readonly entitlements: EntitlementService,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async store(input: StoreDocumentInput): Promise<StoredDocument> {
    const principal = tenantContext.require('documents.store');
    if (input.body.byteLength === 0) {
      // The database refuses this too (`documents_size_positive`); refusing here gives the person a
      // sentence instead of a constraint name.
      throw AppError.validation('That file is empty', [
        { field: 'file', code: 'EMPTY_FILE', message: 'The file has no contents.' },
      ]);
    }
    await this.assertWithinStorageLimit(input.body.byteLength);

    const id = newId();
    const key = documentKey({
      organizationId: principal.organizationId,
      subject: input.subject,
      documentId: id,
      fileName: input.fileName,
    });
    const object = await this.storage.put({
      key,
      body: input.body,
      contentType: input.mimeType,
    });

    const row = await this.db.client.document.create({
      data: {
        id,
        organizationId: principal.organizationId,
        subject: input.subject,
        fileKey: object.key,
        fileName: input.fileName.slice(0, 255),
        mimeType: input.mimeType,
        sizeBytes: object.sizeBytes,
        checksum: object.checksum,
        uploadedById: principal.actorId ?? null,
        expiresAt: input.expiresAt ?? null,
      },
    });

    return {
      id: row.id,
      fileKey: row.fileKey,
      fileName: row.fileName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      checksum: row.checksum,
      expiresAt: row.expiresAt,
    };
  }

  /**
   * The bytes of a document this tenant owns.
   *
   * Authorization is the caller's: a document is only ever reached through the thing that owns it
   * (an import job, an export job), and that route declares the permission. This method's job is
   * the tenant check, which it gets from the scoped client for free, plus the expiry check — an
   * expired export must stop being downloadable the moment it expires, not when the sweep next
   * runs.
   */
  async read(id: string): Promise<{ document: StoredDocument; body: Buffer }> {
    const row = await this.db.client.document.findFirst({ where: { id, deletedAt: null } });
    if (!row) throw AppError.notFound('File');
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      // 410 rather than 404: the file did exist, and "expired" is the one thing the person needs to
      // know — a 404 would send them looking for a link they typed wrong.
      throw new AppError(
        'NOT_FOUND',
        'That download has expired. Generate it again to get a fresh copy.',
        410,
      );
    }

    const body = await this.storage.get(row.fileKey);
    if (!body) {
      // The row says the file exists and the bucket disagrees. That is an operational fault, not a
      // 404 — a 404 would send the user to look for their own mistake.
      this.logger.error({ documentId: row.id, fileKey: row.fileKey }, 'document bytes missing');
      throw AppError.internal('That file could not be read. Please try generating it again.');
    }

    return {
      document: {
        id: row.id,
        fileKey: row.fileKey,
        fileName: row.fileName,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        checksum: row.checksum,
        expiresAt: row.expiresAt,
      },
      body,
    };
  }

  /** Soft-deletes the row, then drops the bytes. Safe to call twice. */
  async discard(id: string): Promise<void> {
    const row = await this.db.client.document.findFirst({ where: { id } });
    if (!row) return;
    if (!row.deletedAt) {
      await this.db.client.document.update({
        where: { id: row.id },
        data: { deletedAt: new Date() },
      });
    }
    await this.storage.remove(row.fileKey);
  }

  /**
   * The expiry sweep (`maintenance.document-expiry`).
   *
   * Cross-tenant by nature — it is housekeeping over every workspace's expired exports — so it
   * opts into platform scope explicitly and then does the per-document work through this service's
   * own tenant-scoped path. The row is kept: who exported what, and when, is audit history. Only
   * the bytes go.
   */
  async sweepExpired(limit = 500): Promise<{ examined: number; discarded: number }> {
    const due = await withPlatformScope('documents: expiry sweep', async () =>
      this.db.client.document.findMany({
        where: { expiresAt: { lte: new Date() }, deletedAt: null },
        select: { id: true, organizationId: true, fileKey: true },
        orderBy: { expiresAt: 'asc' },
        take: limit,
      }),
    );

    let discarded = 0;
    for (const document of due) {
      await withPlatformScope('documents: expiry sweep write', async () => {
        await this.db.client.document.update({
          where: { id: document.id },
          data: { deletedAt: new Date() },
        });
      });
      await this.storage.remove(document.fileKey);
      discarded += 1;
    }
    if (discarded > 0) this.logger.info({ discarded }, 'expired documents swept');
    return { examined: due.length, discarded };
  }

  /**
   * Storage is a metered feature (`storage_bytes`), so an import or export has to fit inside the
   * plan. Counted from the `documents` table rather than from the bucket: the table is the
   * tenant-scoped truth, and a bucket-wide sum would be a cross-tenant read.
   */
  private async assertWithinStorageLimit(incomingBytes: number): Promise<void> {
    const used = await this.db.client.document.aggregate({
      where: { deletedAt: null },
      _sum: { sizeBytes: true },
    });
    // `increment` is the file's own size, so the message a person sees reports what they already
    // store and what they tried to add — not an off-by-one byte.
    await this.entitlements.assertWithinLimit(
      'storage_bytes',
      used._sum.sizeBytes ?? 0,
      incomingBytes,
    );
  }
}
