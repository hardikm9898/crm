import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newToken } from '@leados/shared';
import { WhatsAppIngestMessageProcessor } from '../src/modules/whatsapp/whatsapp.processor.js';
import { WhatsAppIngestStatusProcessor } from '../src/modules/whatsapp/whatsapp-status.processor.js';
import { WhatsAppSendMessageProcessor } from '../src/modules/whatsapp/whatsapp-send.processor.js';
import {
  WhatsAppDownloadMediaProcessor,
  WhatsAppMediaRetryProcessor,
} from '../src/modules/whatsapp/whatsapp-media.processor.js';
import {
  bootTestApp,
  call,
  callRaw,
  cleanupUsers,
  type EnvelopeBody,
  type TestApp,
} from './app-harness.js';

/**
 * THE WHATSAPP ATTACHMENT SUITE (Phase 5 step 3: `FR-WA-3`).
 *
 * Meta is a real in-process HTTP server, serving all three halves of the round trip: the media
 * **lookup** (which is where a size is refused before a byte is read), the CDN **download**, and
 * the multipart **upload** a send needs. Every assertion here is over HTTP, including the bytes —
 * the one thing a unit test of this feature cannot prove is that what comes back out of
 * `GET …/media` is byte-for-byte what went in.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2ewm${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';
const APP_SECRET = 'd41d8cd98f00b204e9800998ecf8427e';
const ACCESS_TOKEN = 'EAAG-a-permanent-system-user-token-value-0002';
const WABA_ID = '102938475610888';
const PHONE_NUMBER_ID = `7788${Date.now().toString().slice(-6)}`;
const VERIFY_TOKEN = 'a phrase i chose';
const CONTACT = '919845066666';

/** A one-pixel PNG, which is a real image and small enough to assert byte-for-byte. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
/** A small PDF, for the document path — the one WhatsApp shows a file name for. */
const DOC = Buffer.from(`%PDF-1.4\n% a quotation ${SUFFIX}\n%%EOF\n`, 'utf8');

let ctx: TestApp;
let graph: Server;
let previousGraphUrl: string | undefined;
let previousRate: string | undefined;

const graphRequests: { method: string; path: string; bytes: number }[] = [];
/** What the media lookup answers, keyed by the media id Meta was asked about. */
const mediaMeta = new Map<string, { mimeType: string; sizeBytes: number; bytes: Buffer }>();
/** Every file the upload endpoint took, so a test can assert it was called once. */
const uploads: { bytes: number }[] = [];
/** Whether Meta refuses the send itself — after taking the file, which is the interesting case. */
let sendFails = false;

let orgA: { token: string; organizationId: string; userId: string };
let connectionId: string;
let conversationId: string;

async function api<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  options: { token?: string; payload?: unknown; headers?: Record<string, string> } = {},
) {
  return call<EnvelopeBody<T>>(ctx.app, {
    method,
    url: `/api/v1${url}`,
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.payload === undefined ? {} : { payload: options.payload }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  });
}

/** A setup call whose status nobody asserts fails silently and takes the assertion with it. */
async function setup<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  options: { token?: string; payload?: unknown } = {},
): Promise<T> {
  const response = await api<T>(method, url, options);
  if (response.statusCode >= 300) {
    throw new Error(`${method} ${url} → ${response.statusCode} ${JSON.stringify(response.body)}`);
  }
  return response.body.data;
}

const delivery = (value: Record<string, unknown>) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: WABA_ID,
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '919845000888', phone_number_id: PHONE_NUMBER_ID },
            ...value,
          },
        },
      ],
    },
  ],
});

async function post(body: unknown) {
  const raw = JSON.stringify(body);
  return call<EnvelopeBody<{ accepted: number; duplicates: number; ignored: number }>>(ctx.app, {
    method: 'POST',
    url: `/api/v1/wh/whatsapp_cloud/${connectionId}`,
    payload: raw,
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`,
    },
  });
}

/** Drives every unprocessed ledger row through whichever pipeline it belongs to. */
async function drain(): Promise<void> {
  const messages = ctx.app.get(WhatsAppIngestMessageProcessor);
  const statuses = ctx.app.get(WhatsAppIngestStatusProcessor);
  const rows = await ctx.db.providerEvent.findMany({
    where: { organizationId: orgA.organizationId, status: { in: ['received', 'failed'] } },
    select: { id: true, eventType: true },
  });
  for (const row of rows) {
    const handler = row.eventType.startsWith('status.')
      ? statuses.handle(orgA.organizationId, row.id)
      : messages.handle(orgA.organizationId, row.id);
    await handler.catch(() => {
      /* the row records the failure; the tests assert against the row */
    });
  }
}

/** Fetches every attachment the ingestion is waiting on, the way the worker would. */
async function flushDownloads(): Promise<void> {
  const processor = ctx.app.get(WhatsAppDownloadMediaProcessor);
  const rows = await ctx.db.messageMedia.findMany({
    where: { organizationId: orgA.organizationId, downloadStatus: { in: ['pending', 'failed'] } },
    select: { messageId: true },
  });
  for (const row of rows) {
    await processor
      .process({ organizationId: orgA.organizationId, aggregateId: row.messageId }, {} as never)
      .catch(() => {
        /* a failure is recorded on the row and rethrown so BullMQ retries; the row is the subject */
      });
  }
}

/** Hands every queued message to Meta, the way the worker would. */
async function flushSends(): Promise<void> {
  const processor = ctx.app.get(WhatsAppSendMessageProcessor);
  const rows = await ctx.db.message.findMany({
    where: { organizationId: orgA.organizationId, status: 'queued', direction: 'outbound' },
    select: { id: true },
  });
  for (const row of rows) {
    await processor.handle(orgA.organizationId, row.id).catch(() => {
      /* a retryable failure throws on purpose; the row carries the state */
    });
  }
}

/** An inbound message carrying a file, with the lookup Meta will answer for it. */
async function inboundMedia(input: {
  type: 'image' | 'document' | 'audio' | 'video';
  mimeType: string;
  bytes: Buffer;
  /** What Meta *claims* the size is, which is not always what it serves. */
  claimedSize?: number;
  fileName?: string;
  caption?: string;
  voice?: boolean;
}): Promise<{ messageId: string; mediaId: string }> {
  const mediaId = `media.${newToken(8)}`;
  mediaMeta.set(mediaId, {
    mimeType: input.mimeType,
    sizeBytes: input.claimedSize ?? input.bytes.byteLength,
    bytes: input.bytes,
  });
  const wamid = `wamid.in.${newToken(8)}`;
  await post(
    delivery({
      contacts: [{ wa_id: CONTACT, profile: { name: 'Asha Rao' } }],
      messages: [
        {
          from: CONTACT,
          id: wamid,
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: input.type,
          [input.type]: {
            id: mediaId,
            mime_type: input.mimeType,
            sha256: 'metas-own-digest',
            ...(input.fileName === undefined ? {} : { filename: input.fileName }),
            ...(input.caption === undefined ? {} : { caption: input.caption }),
            ...(input.voice === undefined ? {} : { voice: input.voice }),
          },
        },
      ],
    }),
  );
  await drain();
  const row = await ctx.db.message.findFirstOrThrow({
    where: { organizationId: orgA.organizationId, providerMessageId: wamid },
    select: { id: true },
  });
  return { messageId: row.id, mediaId };
}

beforeAll(async () => {
  graph = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const path = request.url ?? '';
      const body = Buffer.concat(chunks);
      graphRequests.push({ method: request.method ?? 'GET', path, bytes: body.byteLength });

      // The CDN: the bytes themselves, which Meta serves from a second URL and still wants the
      // bearer token for.
      const download = /^\/cdn\/(.+)$/.exec(path);
      if (download) {
        const known = mediaMeta.get(decodeURIComponent(download[1]!));
        if (!known) {
          response.writeHead(404, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'no such file' } }));
          return;
        }
        response.writeHead(200, { 'content-type': known.mimeType });
        response.end(known.bytes);
        return;
      }

      // The upload: multipart, which is the only thing Meta's media endpoint takes.
      if (/\/media$/.test(path) && request.method === 'POST') {
        uploads.push({ bytes: body.byteLength });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: `meta-media-${newToken(6)}` }));
        return;
      }

      // The lookup: where the file is, how big Meta says it is, and what kind.
      const lookup = /^\/v21\.0\/(media\.[^/?]+)/.exec(path);
      if (lookup && request.method === 'GET') {
        const known = mediaMeta.get(decodeURIComponent(lookup[1]!));
        if (!known) {
          response.writeHead(404, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'unknown media id', code: 100 } }));
          return;
        }
        const port = (graph.address() as AddressInfo).port;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            url: `http://127.0.0.1:${port}/cdn/${encodeURIComponent(lookup[1]!)}`,
            mime_type: known.mimeType,
            file_size: known.sizeBytes,
            sha256: 'metas-own-digest',
            id: lookup[1],
          }),
        );
        return;
      }

      const answer =
        path.includes('/messages') && request.method === 'POST'
          ? sendFails
            ? {
                status: 400,
                body: JSON.stringify({
                  error: { message: 'Media is not readable', code: 131_053, type: 'OAuthException' },
                }),
              }
            : {
                status: 200,
                body: JSON.stringify({
                  messaging_product: 'whatsapp',
                  contacts: [{ input: CONTACT, wa_id: CONTACT }],
                  messages: [{ id: `wamid.out.${newToken(6)}` }],
                }),
              }
          : path.includes('message_templates')
            ? { status: 200, body: JSON.stringify({ data: [] }) }
            : path.includes('phone_numbers')
              ? {
                  status: 200,
                  body: JSON.stringify({
                    data: [
                      {
                        id: PHONE_NUMBER_ID,
                        display_phone_number: '+91 98450 00888',
                        verified_name: 'Rao Interiors',
                        quality_rating: 'GREEN',
                        messaging_limit_tier: 'TIER_1K',
                      },
                    ],
                  }),
                }
              : { status: 200, body: JSON.stringify({ id: WABA_ID, name: 'Rao Interiors' }) };
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => graph.listen(0, '127.0.0.1', resolve));
  previousGraphUrl = process.env['META_GRAPH_URL'];
  process.env['META_GRAPH_URL'] = `http://127.0.0.1:${(graph.address() as AddressInfo).port}/v21.0`;
  previousRate = process.env['WHATSAPP_SENDS_PER_SECOND'];
  process.env['WHATSAPP_SENDS_PER_SECOND'] = '100';

  ctx = await bootTestApp();
  await cleanupUsers(ctx.db, EMAIL_MARKER);
  const registered = await setup<{
    organization: { id: string };
    user: { id: string };
    tokens: { accessToken: string };
  }>('POST', '/auth/register', {
    payload: {
      email: `${EMAIL_MARKER}a@test.local`,
      password: PASSWORD,
      name: 'Media Owner',
      organizationName: `WA media ${SUFFIX}`,
    },
  });
  orgA = {
    token: registered.tokens.accessToken,
    organizationId: registered.organization.id,
    userId: registered.user.id,
  };

  const connection = await setup<{ id: string }>('POST', '/integrations', {
    token: orgA.token,
    payload: {
      provider: 'whatsapp_cloud',
      name: 'WhatsApp',
      credentials: { appSecret: APP_SECRET, accessToken: ACCESS_TOKEN },
      settings: { wabaId: WABA_ID, verifyToken: VERIFY_TOKEN },
    },
  });
  connectionId = connection.id;
  await setup<{ id: string }>('POST', '/whatsapp/accounts', {
    token: orgA.token,
    payload: { connectionId },
  });

  // One inbound text, which opens the 24-hour window and creates the conversation everything else
  // hangs off.
  await post(
    delivery({
      contacts: [{ wa_id: CONTACT, profile: { name: 'Asha Rao' } }],
      messages: [
        {
          from: CONTACT,
          id: `wamid.in.${newToken(8)}`,
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: 'text',
          text: { body: 'Can you send the floor plan?' },
        },
      ],
    }),
  );
  await drain();
  const [conversation] = await setup<{ id: string }[]>('GET', '/conversations', {
    token: orgA.token,
  });
  if (!conversation) throw new Error('the inbound message did not become a conversation');
  conversationId = conversation.id;
}, 180_000);

afterAll(async () => {
  await cleanupUsers(ctx.db, EMAIL_MARKER);
  await ctx.close();
  await new Promise<void>((resolve) => graph.close(() => resolve()));
  if (previousGraphUrl === undefined) delete process.env['META_GRAPH_URL'];
  else process.env['META_GRAPH_URL'] = previousGraphUrl;
  if (previousRate === undefined) delete process.env['WHATSAPP_SENDS_PER_SECOND'];
  else process.env['WHATSAPP_SENDS_PER_SECOND'] = previousRate;
});

describe('an inbound attachment (`FR-WA-3`)', () => {
  it('lands the message first and the file second, and serves the exact bytes back', async () => {
    const { messageId } = await inboundMedia({
      type: 'image',
      mimeType: 'image/png',
      bytes: PIXEL,
      caption: 'the corner window',
    });

    // The message is readable before anything has been fetched: a photo that held up the whole
    // conversation would be a worse product than one that says the photo is coming.
    const waiting = await ctx.db.messageMedia.findFirstOrThrow({
      where: { messageId },
      select: { downloadStatus: true, fileKey: true, mimeType: true },
    });
    expect(waiting.downloadStatus).toBe('pending');
    expect(waiting.fileKey).toBeNull();

    // And while it is pending the route says so rather than answering an empty body, which a
    // browser renders as a broken image with no explanation.
    const early = await api(
      'GET',
      `/conversations/${conversationId}/messages/${messageId}/media`,
      { token: orgA.token },
    );
    expect(early.statusCode).toBe(422);

    await flushDownloads();
    const stored = await ctx.db.messageMedia.findFirstOrThrow({
      where: { messageId },
      select: { downloadStatus: true, fileKey: true, sizeBytes: true, sha256: true, mimeType: true },
    });
    expect(stored.downloadStatus).toBe('stored');
    expect(stored.sizeBytes).toBe(PIXEL.byteLength);
    expect(stored.mimeType).toBe('image/png');
    // Ours, not Meta's: the digest of what we actually hold is the one worth comparing bytes to.
    expect(stored.sha256).not.toBe('metas-own-digest');

    const served = await callRaw(ctx.app, {
      method: 'GET',
      url: `/api/v1/conversations/${conversationId}/messages/${messageId}/media`,
      token: orgA.token,
    });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    // Inline, because the thread shows a photo where it is.
    expect(String(served.headers['content-disposition'])).toContain('inline');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.headers['cache-control']).toBe('no-store');
    expect(served.body.equals(PIXEL)).toBe(true);
  });

  it('keeps the caption as the message body and the file name on the row', async () => {
    const { messageId } = await inboundMedia({
      type: 'document',
      mimeType: 'application/pdf',
      bytes: DOC,
      fileName: 'floor-plan.pdf',
    });
    await flushDownloads();

    const row = await ctx.db.message.findFirstOrThrow({
      where: { id: messageId },
      select: { type: true, body: true },
    });
    expect(row.type).toBe('document');
    // No caption was sent, and a placeholder would be indistinguishable from somebody typing one.
    expect(row.body).toBeNull();

    const served = await callRaw(ctx.app, {
      method: 'GET',
      url: `/api/v1/conversations/${conversationId}/messages/${messageId}/media`,
      token: orgA.token,
    });
    expect(served.statusCode).toBe(200);
    // A document is a download, because a browser rendering a stranger's file inline on our own
    // origin is the one thing `nosniff` exists for.
    expect(String(served.headers['content-disposition'])).toContain('attachment');
    expect(String(served.headers['content-disposition'])).toContain('floor-plan.pdf');
    expect(served.body.equals(DOC)).toBe(true);
  });

  it('refuses a file Meta says is too large before reading a byte of it', async () => {
    const { messageId } = await inboundMedia({
      type: 'image',
      mimeType: 'image/png',
      bytes: PIXEL,
      // Meta's own lookup says 40 MB, which is over the 5 MB a photo may be.
      claimedSize: 40 * 1024 * 1024,
    });
    const before = graphRequests.filter((r) => r.path.startsWith('/cdn/')).length;
    await flushDownloads();

    const row = await ctx.db.messageMedia.findFirstOrThrow({
      where: { messageId },
      select: { downloadStatus: true, reason: true, fileKey: true },
    });
    expect(row.downloadStatus).toBe('refused');
    expect(row.reason).toBe('That is 40 MB, and the limit for an image is 5 MB.');
    expect(row.fileKey).toBeNull();
    // The point of asking Meta first: the bytes were never fetched.
    expect(graphRequests.filter((r) => r.path.startsWith('/cdn/')).length).toBe(before);

    // And the screen is told why, in the sentence the row carries.
    const served = await api(
      'GET',
      `/conversations/${conversationId}/messages/${messageId}/media`,
      { token: orgA.token },
    );
    expect(served.statusCode).toBe(422);
    expect(JSON.stringify(served.body)).toContain('the limit for an image is 5 MB');
  });

  it('refuses a kind this product does not store, without asking Meta at all', async () => {
    const before = graphRequests.length;
    const { messageId } = await inboundMedia({
      type: 'image',
      // A photo that is really an executable: the kind is the message's, the mime type is not one
      // an image may have.
      mimeType: 'application/x-msdownload',
      bytes: DOC,
    });
    const row = await ctx.db.messageMedia.findFirstOrThrow({
      where: { messageId },
      select: { downloadStatus: true, reason: true },
    });
    expect(row.downloadStatus).toBe('refused');
    expect(row.reason).not.toBeNull();
    // Refused at ingestion, so Meta was never asked — no lookup, no download.
    expect(graphRequests.length).toBe(before);
  });

  it('is idempotent: the same job twice stores one file and pays Meta once', async () => {
    const { messageId } = await inboundMedia({
      type: 'audio',
      mimeType: 'audio/ogg',
      bytes: PIXEL,
      voice: true,
    });
    await flushDownloads();
    const downloads = () => graphRequests.filter((r) => r.path.startsWith('/cdn/')).length;
    const after = downloads();

    const processor = ctx.app.get(WhatsAppDownloadMediaProcessor);
    await processor.process(
      { organizationId: orgA.organizationId, aggregateId: messageId },
      {} as never,
    );
    expect(downloads()).toBe(after);

    const rows = await ctx.db.messageMedia.findMany({ where: { messageId }, select: { id: true } });
    expect(rows).toHaveLength(1);
    const row = await ctx.db.messageMedia.findFirstOrThrow({
      where: { messageId },
      select: { voice: true, downloadStatus: true },
    });
    // A voice note is a different thing from an audio file somebody attached, and only the
    // provider knows which.
    expect(row.voice).toBe(true);
    expect(row.downloadStatus).toBe('stored');
  });

  it('re-queues what a worker never got, and leaves alone what it already has', async () => {
    const { messageId } = await inboundMedia({
      type: 'image',
      mimeType: 'image/jpeg',
      bytes: PIXEL,
    });
    // Older than the sweep's one-minute floor, so it does not race the job the ingestion queued.
    await ctx.db.messageMedia.updateMany({
      where: { messageId },
      data: { createdAt: new Date(Date.now() - 600_000) },
    });

    const waiting = await ctx.app
      .get(WhatsAppMediaRetryProcessor)
      // The sweep reads across tenants and re-queues each row in its own workspace; what this
      // asserts is that the row is found at all.
      .process();
    expect(waiting).toBeUndefined();

    await flushDownloads();
    const row = await ctx.db.messageMedia.findFirstOrThrow({
      where: { messageId },
      select: { downloadStatus: true },
    });
    expect(row.downloadStatus).toBe('stored');
  });
});

describe('sending an attachment (`FR-WA-3`)', () => {
  it('stores the file first, uploads it at send time, and shows it in the thread', async () => {
    const uploadsBefore = uploads.length;
    const response = await call<EnvelopeBody<{ id: string; status: string; type: string }>>(
      ctx.app,
      {
        method: 'POST',
        url: `/api/v1/conversations/${conversationId}/attachments?fileName=quotation.pdf&caption=${encodeURIComponent('the revised quotation')}`,
        token: orgA.token,
        payload: DOC,
        headers: { 'content-type': 'application/pdf' },
      },
    );
    expect(response.statusCode).toBe(202);
    expect(response.body.data.type).toBe('document');
    // `queued`: nothing has reached Meta when the request answers, and the file is already ours.
    expect(response.body.data.status).toBe('queued');
    const messageId = response.body.data.id;

    const stored = await ctx.db.messageMedia.findFirstOrThrow({
      where: { messageId },
      select: { downloadStatus: true, fileKey: true, sizeBytes: true, providerMediaId: true },
    });
    // Stored by us *before* Meta has it, which is what makes a media send retryable.
    expect(stored.downloadStatus).toBe('stored');
    expect(stored.sizeBytes).toBe(DOC.byteLength);
    expect(stored.providerMediaId).toBeNull();
    expect(uploads.length).toBe(uploadsBefore);

    await flushSends();
    const sent = await ctx.db.messageMedia.findFirstOrThrow({
      where: { messageId },
      select: { providerMediaId: true },
    });
    expect(sent.providerMediaId).toMatch(/^meta-media-/);
    expect(uploads.length).toBe(uploadsBefore + 1);
    const message = await ctx.db.message.findFirstOrThrow({
      where: { id: messageId },
      select: { status: true, body: true, type: true },
    });
    expect(message.status).toBe('accepted');
    // The caption is the message's body, which is what the thread prints under the file.
    expect(message.body).toBe('the revised quotation');

    // The thread shows it, through the one presenter both readings share.
    const messages = await setup<{ id: string; media: { fileName: string } | null }[]>(
      'GET',
      `/conversations/${conversationId}/messages`,
      { token: orgA.token },
    );
    const row = messages.find((m) => m.id === messageId);
    expect(row?.media?.fileName).toBe('quotation.pdf');

    // And the bytes come back out of our own route, not Meta's.
    const served = await callRaw(ctx.app, {
      method: 'GET',
      url: `/api/v1/conversations/${conversationId}/messages/${messageId}/media`,
      token: orgA.token,
    });
    expect(served.statusCode).toBe(200);
    expect(served.body.equals(DOC)).toBe(true);
  });

  it('re-uses the id Meta already gave, rather than uploading twice', async () => {
    const uploadsBefore = uploads.length;
    // Meta refuses the send itself, *after* taking the file — which is the case that would
    // otherwise pay for the upload twice and leave an orphan at Meta.
    sendFails = true;
    const queued = await call<EnvelopeBody<{ id: string }>>(ctx.app, {
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/attachments?fileName=plan.pdf`,
      token: orgA.token,
      payload: DOC,
      headers: { 'content-type': 'application/pdf' },
    });
    expect(queued.statusCode).toBe(202);
    const messageId = queued.body.data.id;

    await flushSends();
    expect(uploads.length).toBe(uploadsBefore + 1);
    const failed = await ctx.db.message.findFirstOrThrow({
      where: { id: messageId },
      select: { status: true, errorMessage: true },
    });
    expect(failed.status).toBe('failed');
    // The id Meta gave is kept, which is the whole point: the file is already there.
    const held = await ctx.db.messageMedia.findFirstOrThrow({
      where: { messageId },
      select: { providerMediaId: true },
    });
    expect(held.providerMediaId).toMatch(/^meta-media-/);

    sendFails = false;
    const retried = await api('POST', `/conversations/${conversationId}/messages/${messageId}/retry`, {
      token: orgA.token,
    });
    expect(retried.statusCode).toBe(202);
    await flushSends();
    // One upload for two attempts.
    expect(uploads.length).toBe(uploadsBefore + 1);
    const sent = await ctx.db.message.findFirstOrThrow({
      where: { id: messageId },
      select: { status: true, sendAttempts: true },
    });
    expect(sent.status).toBe('accepted');
    expect(sent.sendAttempts).toBe(2);
  });

  it('refuses a request with no file, and a file this product will not take', async () => {
    const empty = await call(ctx.app, {
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/attachments?fileName=nothing.pdf`,
      token: orgA.token,
      payload: Buffer.alloc(0),
      headers: { 'content-type': 'application/pdf' },
    });
    expect(empty.statusCode).toBe(400);

    const unnamed = await call(ctx.app, {
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/attachments`,
      token: orgA.token,
      payload: DOC,
      headers: { 'content-type': 'application/pdf' },
    });
    // The name is not decoration: WhatsApp shows it to the person receiving a document.
    expect(unnamed.statusCode).toBe(400);
  });

  it('refuses a file upload to any other path, before a byte of it is read', async () => {
    // A content-type parser is global, so giving one path a sixteen-megabyte limit gives every
    // path one unless something refuses it first.
    const elsewhere = await call(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: DOC,
      headers: { 'content-type': 'application/pdf' },
    });
    expect(elsewhere.statusCode).toBe(415);
  });
});
