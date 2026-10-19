import { Body, Controller, Headers, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError, verifySignature } from '@leados/shared';
import { Public } from '../auth/guards/public.decorator.js';
import type { WithRawBody } from '../../infra/http/empty-json-body.js';
import { requestStore } from '../../infra/http/request-store.js';
import { markApiRequest } from '../api-keys/api-log.hook.js';
import { IngestAuthService } from '../ingestion/ingest-auth.service.js';
import { IngestionService } from '../ingestion/ingestion.service.js';
import { IntegrationsService } from './integrations.service.js';

/**
 * The inbound door an integration posts leads through (Phase 4's "generic mapping templates").
 *
 * `POST /wh/{provider}/{connectionId}` — the path the webhooks module's note has promised since
 * step 3, and short because it goes into somebody else's configuration box. Three decisions:
 *
 *  * **The signature is the authentication**, over the raw bytes, with the secret this workspace
 *    generated — the same `verifySignature` and the same five-minute window as the public lead API,
 *    so an integrator who has wired one has wired the other. The connection id in the path is not a
 *    credential and is not treated as one: a request with the right id and no valid signature is a
 *    401, and a request with a wrong id is a 404 indistinguishable from a disconnected connection.
 *  * **The payload is in the sender's own field names.** There is no body schema here, because
 *    having one would be the whole feature's opposite: the mapping is what turns `Full Name` into
 *    `firstName`, and it is applied inside the capture pipeline so the stored payload stays as it
 *    arrived.
 *  * **201 for a new lead, 200 for a duplicate or a replay**, exactly as the public endpoint
 *    answers, so a sender can tell "I created something" from "that already existed".
 *
 * `@Public()` because the caller is somebody else's server with no session — declared, because a
 * route that forgets to declare its authorization fails at boot.
 */
@Public()
@Controller('wh')
export class IntegrationInboundController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly ingestion: IngestionService,
  ) {}

  @Post(':provider/:connectionId')
  @HttpCode(201)
  async receive(
    @Param('provider') provider: string,
    @Param('connectionId') connectionId: string,
    @Headers('x-signature') signature: string | undefined,
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
          message: 'Send one lead as a JSON object. A list of leads is not accepted here.',
        },
      ]);
    }

    const connection = await this.integrations.openForInbound(provider, connectionId);
    const check = verifySignature(connection.secret, signature, rawBody);
    if (!check.ok) {
      // The same sentences the public lead API uses, from the same place: an integrator debugging
      // a signature should not have to work out which of our two doors they are at.
      throw new AppError(
        'INVALID_API_KEY',
        IngestAuthService.signatureMessage(check.failure ?? 'mismatch'),
        401,
      );
    }

    // Both inbound doors write to one request log, so "my integration posted and nothing happened"
    // is one story in one place. No key id: this request was authenticated by a connection.
    markApiRequest(request, {
      organizationId: connection.organizationId,
      apiKeyId: null,
      surface: 'public_ingest',
      ip: requestStore.get()?.ip ?? request.ip ?? null,
    });

    const result = await this.ingestion.capture(
      { organizationId: connection.organizationId, apiKeyRowId: null },
      body as Record<string, unknown>,
      {
        rawBody,
        idempotencyKey,
        headers: keptHeaders(request.headers),
        channel: 'webhook',
        // Its own key space: the same `Idempotency-Key` sent to the public endpoint and to a
        // connection is two different requests, and sharing one would make the second a replay of
        // the first.
        endpoint: 'POST /wh/{provider}/{connectionId}',
        integrationConnectionId: connection.connectionId,
        mapping: connection.mapping,
        // What the workspace decided to call these leads, when the payload does not say.
        ...(connection.sourceName ? { defaults: { source: connection.sourceName } } : {}),
      },
    );

    // Only once the lead is in: `last_success_at` is the only evidence an inbound connection is
    // working, since there is nothing to probe, so it must mean "something arrived and became a
    // lead" rather than "a request was signed correctly".
    await this.integrations.recordInboundSuccess(
      connection.organizationId,
      connection.connectionId,
    );

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

/** The headers worth keeping, with the signature removed. The payload is stored; the proof is not. */
function keptHeaders(headers: Record<string, unknown>): Record<string, string> {
  const keep = ['content-type', 'user-agent', 'idempotency-key', 'x-forwarded-for', 'origin', 'referer'];
  const kept: Record<string, string> = {};
  for (const name of keep) {
    const value = headers[name];
    if (typeof value === 'string') kept[name] = value.slice(0, 500);
  }
  return kept;
}
