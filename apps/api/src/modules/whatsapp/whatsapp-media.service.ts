import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  MEDIA_LIMITS,
  MEDIA_MESSAGE_TYPES,
  describeBytes,
  mediaProblem,
  newId,
  systemPrincipal,
  tenantContext,
  type InboundWhatsAppMedia,
  type MessageType,
} from '@leados/shared';
import type { Logger } from 'pino';
import { DataScopeService, applyScopeFilter } from '../../infra/authz/data-scope.service.js';
import { DbService } from '../../infra/db/db.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { JOBS, QUEUES } from '../../infra/queue/queue.constants.js';
import { QueueService } from '../../infra/queue/queue.service.js';
import { STORAGE, documentKey, type StoragePort } from '../../infra/storage/storage.port.js';
import { WhatsAppCloudAdapter } from '../integrations/adapters/whatsapp-cloud.adapter.js';
import { IntegrationsService } from '../integrations/integrations.service.js';

/** What an accepted upload leaves behind, for the send path to attach to a message. */
export interface StoredUpload {
  readonly mediaId: string;
  readonly type: MessageType;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly fileKey: string;
  readonly sha256: string;
  readonly caption: string | null;
}

/** How many times a download is attempted before it is left alone. */
const MAX_DOWNLOAD_ATTEMPTS = 4;

/**
 * The files a conversation carries (`FR-WA-3`).
 *
 * Four decisions:
 *
 *  * **A message is stored before its file.** A delivery carries a media **id**, not the bytes, so
 *    an inbound photo is two steps: the message lands immediately — the conversation reads
 *    correctly, the lead gets its timeline entry — and a job fetches the file. The
 *    `message_media` row exists from the first step as `pending`, which is what makes "they sent a
 *    photo and we have not got it yet" a state the screen can show rather than a gap.
 *  * **The size is checked twice, and the second one is the real one.** Meta's media lookup answers
 *    a `file_size`, which is the only moment this product can refuse a file **before** reading it;
 *    the download then enforces the same limit while reading, because a header is a claim.
 *  * **A refusal is a state, not an error.** Too large, or a kind this product does not store, is
 *    `refused` with the sentence somebody reads — on the row, beside the message. Throwing would
 *    lose both the message and the explanation.
 *  * **The bytes are served by this product, not by a link.** `GET …/media` is behind
 *    `conversation:read`, because a signed URL needs a driver that can sign one and the local disk
 *    cannot — the export download made the same choice for the same reason.
 */
@Injectable()
export class WhatsAppMediaService {
  constructor(
    private readonly db: DbService,
    private readonly scopes: DataScopeService,
    private readonly integrations: IntegrationsService,
    private readonly adapter: WhatsAppCloudAdapter,
    private readonly queues: QueueService,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Records that an inbound message has a file, and queues the fetch.
   *
   * Called from inside the ingestion's tenant context, in the same breath as the message: a row
   * that appears later would make the screen flicker between "no attachment" and "a photo".
   */
  async expect(input: {
    organizationId: string;
    messageId: string;
    messageCreatedAt: Date;
    type: MessageType;
    media: InboundWhatsAppMedia;
  }): Promise<void> {
    const problem = mediaProblem({
      type: input.type,
      mimeType: input.media.mimeType,
      // Unknown until Meta is asked, which the job does.
      sizeBytes: null,
    });
    const id = newId();
    await this.db.client.messageMedia.createMany({
      data: [
        {
          id,
          organizationId: input.organizationId,
          messageId: input.messageId,
          messageCreatedAt: input.messageCreatedAt,
          providerMediaId: input.media.providerMediaId,
          fileName: input.media.fileName,
          mimeType: input.media.mimeType,
          sha256: input.media.sha256,
          voice: input.media.voice,
          downloadStatus: problem === null ? 'pending' : 'refused',
          reason: problem?.message ?? null,
        },
      ],
      // The unique on `(organization, message)` makes a replayed ingestion a no-op rather than a
      // second row — the same reasoning as the status receipts.
      skipDuplicates: true,
    });
    if (problem !== null) {
      this.logger.info(
        { messageId: input.messageId, code: problem.code },
        'a whatsapp attachment was refused before it was fetched',
      );
      return;
    }
    await this.queues.enqueue(
      QUEUES.MAINTENANCE,
      JOBS.WHATSAPP_DOWNLOAD_MEDIA,
      { organizationId: input.organizationId, aggregateId: input.messageId },
      { jobId: `whatsapp-media-${input.messageId}` },
    );
  }

  /**
   * Fetches one inbound file and stores it.
   *
   * Idempotent on the row's own status: a job delivered twice finds it `stored` and does nothing,
   * which matters because the alternative is paying Meta's bandwidth twice and writing two objects.
   */
  async download(organizationId: string, messageId: string): Promise<'stored' | 'refused' | 'skipped'> {
    return tenantContext.run(systemPrincipal(organizationId, newId()), async () => {
      const row = await this.db.client.messageMedia.findFirst({
        where: { messageId },
        select: {
          id: true,
          providerMediaId: true,
          downloadStatus: true,
          attempts: true,
          fileName: true,
          mimeType: true,
          message: {
            select: {
              type: true,
              conversation: {
                select: { number: { select: { accountId: true, phoneNumberId: true } } },
              },
            },
          },
        },
      });
      if (!row) {
        this.logger.warn({ messageId }, 'a media job names a message with no attachment row');
        return 'skipped';
      }
      if (row.downloadStatus === 'stored' || row.downloadStatus === 'refused') return 'skipped';
      if (row.providerMediaId === null) return 'skipped';
      const accountId = row.message.conversation.number?.accountId ?? null;
      if (accountId === null) {
        await this.refuse(row.id, 'The number this message arrived at is no longer connected.');
        return 'refused';
      }

      const context = await this.contextFor(accountId);
      const meta = await this.adapter.fetchMediaMeta(context, row.providerMediaId);
      const type = row.message.type as MessageType;
      const limit = MEDIA_LIMITS[type] ?? MEDIA_LIMITS['document']!;
      const problem = mediaProblem({
        type,
        mimeType: meta.mimeType ?? row.mimeType,
        sizeBytes: meta.sizeBytes,
      });
      if (problem !== null) {
        // Refused **before** the bytes are read, which is the whole point of asking Meta first.
        await this.refuse(row.id, problem.message);
        return 'refused';
      }

      const downloaded = await this.adapter.downloadMedia(context, meta.url, limit.maxBytes);
      const mimeType = meta.mimeType ?? downloaded.mimeType ?? row.mimeType ?? 'application/octet-stream';
      const fileName = row.fileName ?? defaultFileName(type, mimeType, row.id);
      const key = documentKey({
        organizationId,
        subject: 'whatsapp-media',
        documentId: row.id,
        fileName,
      });
      const stored = await this.storage.put({ key, body: downloaded.bytes, contentType: mimeType });

      await this.db.client.messageMedia.update({
        where: { id: row.id },
        data: {
          downloadStatus: 'stored',
          fileKey: stored.key,
          fileName,
          mimeType,
          sizeBytes: downloaded.bytes.byteLength,
          // Ours, not Meta's: the hash of what we actually hold is the one worth comparing bytes
          // against. Meta's own is kept on the row as it sent it.
          sha256: createHash('sha256').update(downloaded.bytes).digest('hex'),
          reason: null,
          attempts: row.attempts + 1,
        },
      });
      this.logger.info(
        { messageId, bytes: downloaded.bytes.byteLength, mimeType },
        'a whatsapp attachment was stored',
      );
      return 'stored';
    });
  }

  /** Records a failure on the row so the sweep can try again, and the screen can say what happened. */
  async recordFailure(organizationId: string, messageId: string, reason: string): Promise<void> {
    await tenantContext.run(systemPrincipal(organizationId, newId()), async () => {
      const row = await this.db.client.messageMedia.findFirst({
        where: { messageId },
        select: { id: true, attempts: true },
      });
      if (!row) return;
      await this.db.client.messageMedia.update({
        where: { id: row.id },
        data: {
          // `failed` rather than `refused`: a refusal is ours and final, a failure is Meta's or the
          // network's and is tried again.
          downloadStatus: 'failed',
          reason: reason.slice(0, 500),
          attempts: row.attempts + 1,
        },
      });
    });
  }

  /**
   * Takes an agent's file, stores it, and queues the message that will carry it.
   *
   * The bytes are ours **before** Meta has them, which is what makes the send retryable: the upload
   * to Meta happens in the send job, so a provider refusal does not lose the file the agent chose.
   */
  async attach(
    conversationId: string,
    upload: {
      bytes: Buffer | null;
      mimeType: string;
      fileName: string;
      caption: string | null;
    },
  ): Promise<StoredUpload> {
    const principal = tenantContext.require('whatsapp.media.attach');
    const filter = this.scopes.filterFor('conversation:reply', { userColumn: 'assignedUserId' });
    const scoped = applyScopeFilter({ id: conversationId }, filter);
    if (scoped === null) throw AppError.notFound('Conversation');
    const conversation = await this.db.client.conversation.findFirst({
      where: scoped,
      select: { id: true },
    });
    if (!conversation) throw AppError.notFound('Conversation');

    // After the conversation, deliberately: a missing body refused first would answer 400 for
    // another workspace's conversation and 404 for a real one, which is the shape of an id
    // becoming an oracle.
    if (upload.bytes === null || upload.bytes.byteLength === 0) {
      throw AppError.validation('There is no file in that request', [
        { field: 'file', code: 'FILE_REQUIRED', message: 'Attach a file to send.' },
      ]);
    }
    const bytes = upload.bytes;

    const type = typeForMime(upload.mimeType);
    const problem = mediaProblem({
      type,
      mimeType: upload.mimeType,
      sizeBytes: bytes.byteLength,
    });
    if (problem !== null) {
      throw AppError.validation('That file cannot be sent', [
        { field: 'file', code: problem.code, message: problem.message },
      ]);
    }

    const mediaId = newId();
    const key = documentKey({
      organizationId: principal.organizationId,
      subject: 'whatsapp-media',
      documentId: mediaId,
      fileName: upload.fileName,
    });
    const stored = await this.storage.put({
      key,
      body: bytes,
      contentType: upload.mimeType,
    });
    // The row itself is written by the send service, in the same breath as the message: a media row
    // with no message would be a file nothing can ever reach.
    return {
      mediaId,
      type,
      fileName: upload.fileName,
      mimeType: upload.mimeType,
      sizeBytes: bytes.byteLength,
      fileKey: stored.key,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      caption: upload.caption,
    };
  }

  /**
   * The bytes of one message's file, for the screen.
   *
   * Through the conversation's own scope, so somebody who cannot read the conversation cannot read
   * its attachments either — and a 404 for both, because the shape of an id must not become an
   * oracle.
   */
  async read(conversationId: string, messageId: string): Promise<{
    bytes: Buffer;
    mimeType: string;
    fileName: string;
    inline: boolean;
  }> {
    const filter = this.scopes.filterFor('conversation:read', { userColumn: 'assignedUserId' });
    const scoped = applyScopeFilter({ id: conversationId }, filter);
    if (scoped === null) throw AppError.notFound('Conversation');
    const conversation = await this.db.client.conversation.findFirst({
      where: scoped,
      select: { id: true },
    });
    if (!conversation) throw AppError.notFound('Conversation');

    const row = await this.db.client.messageMedia.findFirst({
      where: { messageId, message: { conversationId } },
      select: {
        fileKey: true,
        fileName: true,
        mimeType: true,
        downloadStatus: true,
        reason: true,
        message: { select: { type: true } },
      },
    });
    if (!row) throw AppError.notFound('Attachment');
    if (row.downloadStatus !== 'stored' || row.fileKey === null) {
      throw AppError.businessRule(
        row.reason ??
          (row.downloadStatus === 'pending'
            ? 'That file has not arrived from WhatsApp yet.'
            : 'That file is not available.'),
      );
    }
    const bytes = await this.storage.get(row.fileKey);
    if (bytes === null) {
      // The row says stored and the object is gone: an honest 404 rather than an empty body, which
      // a browser would render as a broken image with no explanation.
      throw AppError.notFound('Attachment');
    }
    const mimeType = row.mimeType ?? 'application/octet-stream';
    return {
      bytes,
      mimeType,
      fileName: row.fileName ?? 'attachment',
      // An image or a video is shown where it is; anything else is a download, because a browser
      // rendering a stranger's HTML inline on our origin is the one thing `nosniff` exists for.
      inline: mimeType.startsWith('image/') || mimeType.startsWith('video/') || mimeType.startsWith('audio/'),
    };
  }

  /** Every attachment still waiting, for the sweep. */
  async pending(limit: number): Promise<{ messageId: string; organizationId: string }[]> {
    const rows = await this.db.client.messageMedia.findMany({
      where: {
        downloadStatus: { in: ['pending', 'failed'] },
        attempts: { lt: MAX_DOWNLOAD_ATTEMPTS },
        createdAt: { lt: new Date(Date.now() - 60_000) },
      },
      select: { messageId: true, organizationId: true },
      take: limit,
      orderBy: { createdAt: 'asc' },
    });
    return rows;
  }

  private async refuse(id: string, reason: string): Promise<void> {
    await this.db.client.messageMedia.update({
      where: { id },
      data: { downloadStatus: 'refused', reason: reason.slice(0, 500), attempts: { increment: 1 } },
    });
  }

  private async contextFor(accountId: string) {
    const account = await this.db.client.whatsAppAccount.findFirst({
      where: { id: accountId },
      select: { integrationConnectionId: true },
    });
    if (!account) throw AppError.notFound('Account');
    const connection = await this.integrations.openForSending(
      'whatsapp_cloud',
      account.integrationConnectionId,
    );
    return {
      connectionId: connection.connectionId,
      organizationId: connection.organizationId,
      secrets: connection.secrets,
      settings: connection.settings,
      externalAccountId: connection.externalAccountId,
    };
  }
}

/** Which WhatsApp type a file is, from its own mime type. */
export function typeForMime(mimeType: string): MessageType {
  if (mimeType.startsWith('image/')) return mimeType === 'image/webp' ? 'sticker' : 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'document';
}

/** A name for a file Meta sent without one, so a download is not called `attachment`. */
function defaultFileName(type: MessageType, mimeType: string, id: string): string {
  const extension = mimeType.split('/')[1]?.replace(/[^a-z0-9]+/gi, '') ?? 'bin';
  return `${type}-${id.slice(-8)}.${extension}`;
}

/** The types this service will ever be asked about, for a screen that wants to say so. */
export const SENDABLE_MEDIA_TYPES = MEDIA_MESSAGE_TYPES;

/** The largest attachment this product accepts, for the upload route's body limit. */
export const MEDIA_MAX_BYTES = Math.max(
  ...Object.values(MEDIA_LIMITS).map((limit) => limit.maxBytes),
);

/** The sentence a screen shows about what it will take. */
export function describeMediaLimits(): string {
  return `Up to ${describeBytes(MEDIA_LIMITS['image']!.maxBytes)} for a photo and ${describeBytes(
    MEDIA_LIMITS['document']!.maxBytes,
  )} for anything else.`;
}
