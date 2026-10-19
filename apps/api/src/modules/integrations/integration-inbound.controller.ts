import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError, findProvider } from '@leados/shared';
import { Public } from '../auth/guards/public.decorator.js';
import type { WithRawBody } from '../../infra/http/empty-json-body.js';
import { requestStore } from '../../infra/http/request-store.js';
import { markApiRequest } from '../api-keys/api-log.hook.js';
import { IntegrationInboundService } from './integration-inbound.service.js';

/**
 * The door a provider posts leads through (`api-architecture.md` §7).
 *
 * `POST /wh/{provider}/{connectionId}` — the path §7 has specified since Phase 0 — plus the `GET`
 * Meta makes before it will deliver anything. Three decisions:
 *
 *  * **The signature is the authentication**, in whichever of the three shapes the provider uses:
 *    an HMAC over the raw body in a header (ours and Meta's), or a key inside the body (Google
 *    Ads). Which one is a property of the provider, so this controller has no idea and does not
 *    branch. The connection id in the path is **not** a credential: an unverified request is a 401
 *    whatever id it carries, and a wrong id is a 404 indistinguishable from a disconnected
 *    connection.
 *  * **The payload is in the provider's own field names.** There is no body schema here, because
 *    having one would be the whole feature's opposite — the field mapping is what turns `full_name`
 *    into `firstName`, and it is applied inside the capture pipeline so the stored payload stays as
 *    it arrived.
 *  * **A provider that sends its own event id is acknowledged and queued; one that does not is
 *    captured in the request.** Meta retries anything it did not get a 200 for, so §7's "enqueue →
 *    200 in under a second" is what keeps a slow capture from becoming a duplicate delivery; the
 *    generic webhook has no id to deduplicate on, so it answers the lead id synchronously and
 *    deduplicates on `Idempotency-Key` instead.
 *
 * `@Public()` because the caller is somebody else's server with no session — declared, because a
 * route that forgets to declare its authorization fails at boot.
 */
@Public()
@Controller('wh')
export class IntegrationInboundController {
  constructor(private readonly inbound: IntegrationInboundService) {}

  /**
   * Meta's one-time handshake.
   *
   * Answers the challenge **as plain text**, which is what Meta's verifier expects: the envelope
   * would make it `{"success":true,"data":"1158201444"}` and the subscription would never be
   * confirmed. `@Res({ passthrough: false })` is how a handler opts out of the interceptor.
   */
  @Get(':provider/:connectionId')
  async verify(
    @Param('provider') provider: string,
    @Param('connectionId') connectionId: string,
    @Query() query: Record<string, string | undefined>,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const answer = await this.inbound.challenge({ provider, connectionId, query });
    await reply.status(200).type('text/plain').send(answer);
  }

  @Post(':provider/:connectionId')
  @HttpCode(201)
  async receive(
    @Param('provider') provider: string,
    @Param('connectionId') connectionId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Req() request: FastifyRequest & WithRawBody,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const rawBody = request.rawBody;
    if (rawBody === undefined) {
      throw AppError.validation('The request body could not be read', [
        {
          field: 'body',
          code: 'UNREADABLE_BODY',
          message: 'Send a JSON body with content-type: application/json.',
        },
      ]);
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw AppError.validation('The request body is not a JSON object', [
        {
          field: 'body',
          code: 'NOT_AN_OBJECT',
          message: 'Send the delivery as a JSON object, as the provider documents it.',
        },
      ]);
    }
    const payload = body as Record<string, unknown>;

    const connection = await this.inbound.authenticate({
      provider,
      connectionId,
      rawBody,
      body: payload,
      headers: request.headers as Record<string, string | undefined>,
    });

    // Every inbound door writes to one request log, so "my integration posted and nothing
    // happened" is one story in one place. No key id: this request was authenticated by a
    // connection, not by a credential a person made.
    markApiRequest(request, {
      organizationId: connection.organizationId,
      apiKeyId: null,
      surface: 'public_ingest',
      ip: requestStore.get()?.ip ?? request.ip ?? null,
    });

    // The provider is known by now: `authenticate` resolved it through the registry, which refuses
    // anything it has no adapter for before a byte of this body is read.
    const registered = findProvider(provider);
    const events = this.inbound.parse(provider, payload);

    // ── The provider sends its own event ids: ledger, queue, acknowledge ────
    if (events.length > 0) {
      const outcome = await this.inbound.record(connection, events, payload);
      // 200 always, including for a retry: a provider that gets anything else from a duplicate
      // learns to keep retrying, and one that gets a 4xx learns to disable the endpoint.
      reply.status(200);
      // The sentence travels **in** the payload rather than in the envelope's `message`, which is
      // the public lead API's own arrangement next door: both doors of this family answer one
      // shape, and the provider reads neither.
      return {
        ...outcome,
        message:
          outcome.duplicates > 0 && outcome.accepted === 0
            ? 'Already received — nothing was created again'
            : outcome.ignored > 0 && outcome.accepted === 0
              ? 'Test delivery received. Nothing was added to your leads.'
              : 'Received',
      };
    }

    // ── A provider whose deliveries name their own events, and this one names none ──
    if (registered?.deliveryShape === 'events') {
      // Acknowledged rather than refused: Meta sends `page` changes nobody subscribed to, and
      // WhatsApp sends status receipts about messages we sent. A 4xx teaches a provider to disable
      // the endpoint, which stops the deliveries we do want — so the one honest answer to "nothing
      // here concerns us" is 200 and a sentence saying so.
      reply.status(200);
      return {
        accepted: 0,
        duplicates: 0,
        ignored: 1,
        message: 'Received. Nothing in that delivery was for us.',
      };
    }

    // ── No event id of its own: the body is one lead, captured in the request ──

    const result = await this.inbound.captureInline(connection, payload, {
      rawBody,
      idempotencyKey,
      headers: keptHeaders(request.headers),
    });
    if (result.status !== 'created') reply.status(200);
    return {
      ...result,
      message:
        result.status === 'created'
          ? 'Lead received'
          : result.status === 'duplicate_attached'
            ? 'That person was already in this workspace, so this was added to their record'
            : 'Already received — here is the original answer',
    };
  }

}

/** The headers worth keeping, with the proof removed. The payload is stored; the signature is not. */
function keptHeaders(headers: Record<string, unknown>): Record<string, string> {
  const keep = ['content-type', 'user-agent', 'idempotency-key', 'x-forwarded-for', 'origin', 'referer'];
  const kept: Record<string, string> = {};
  for (const name of keep) {
    const value = headers[name];
    if (typeof value === 'string') kept[name] = value.slice(0, 500);
  }
  return kept;
}
