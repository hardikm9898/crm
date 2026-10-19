import { Body, Controller, Headers, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '@leados/shared';
import { Public } from '../auth/guards/public.decorator.js';
import type { WithRawBody } from '../../infra/http/empty-json-body.js';
import { zodBody } from '../../infra/http/zod-validation.pipe.js';
import { markApiRequest } from '../api-keys/api-log.hook.js';
import { IngestAuthService } from './ingest-auth.service.js';
import { IngestionService } from './ingestion.service.js';
import { publicLeadSchema, type PublicLeadInput } from './ingestion.dto.js';

/**
 * The public lead API (`FR-CAP-1`, `FR-CAP-6`, `FR-API-5`).
 *
 * `@Public()` because the caller is somebody else's server with no session — and declared rather
 * than defaulted, which is why a route that forgets to say so fails at boot. The authentication is
 * the key pair: the workspace's public key in the path, the API key in `X-Api-Key`, and an HMAC
 * over the raw body in `X-Signature` (ADR-0030).
 *
 * Two things about the shape of this endpoint:
 *
 *  * **It answers 201 for a new lead and 200 for a duplicate or a replay**, as
 *    `docs/api-architecture.md` §6 promises, so a client can tell "I created something" from "that
 *    already existed" without parsing a message.
 *  * **The raw body is read from the request**, not re-serialised. `{"a":1}` and `{ "a": 1 }` are
 *    the same object and different bytes, and a signature verified against bytes we produced would
 *    reject every client whose JSON writer disagrees with ours.
 */
@Public()
@Controller('public/leads')
export class PublicIngestController {
  constructor(
    private readonly auth: IngestAuthService,
    private readonly ingestion: IngestionService,
  ) {}

  @Post(':organizationPublicKey')
  @HttpCode(201)
  async capture(
    @Param('organizationPublicKey') organizationPublicKey: string,
    @Headers('x-api-key') presentedKeyId: string | undefined,
    @Headers('x-signature') signature: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(zodBody(publicLeadSchema)) body: unknown,
    @Req() request: FastifyRequest & WithRawBody,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const rawBody = request.rawBody;
    if (rawBody === undefined) {
      // Nothing can be verified without the bytes, and guessing would mean accepting an unsigned
      // request. A 400 rather than a 500: the body is the caller's.
      throw AppError.validation('The request body could not be read', [
        {
          field: 'body',
          code: 'UNREADABLE_BODY',
          message: 'Send a JSON body with content-type: application/json.',
        },
      ]);
    }

    const caller = await this.auth.authenticate({
      organizationPublicKey,
      presentedKeyId,
      signatureHeader: signature,
      rawBody,
      ip: request.ip,
    });

    // Both surfaces write to one request log, so an integrator reads "my capture was refused and
    // then my dashboard poll was rate limited" as one story rather than in two places. Marked
    // after authentication because that is when the workspace is known; a refusal before it has no
    // workspace to file a row under (`api_logs` keeps `organization_id` NOT NULL, ADR-0030).
    markApiRequest(request, {
      organizationId: caller.organizationId,
      apiKeyId: caller.apiKeyRowId,
      surface: 'public_ingest',
      ip: request.ip ?? null,
    });

    const result = await this.ingestion.capture(caller, body as PublicLeadInput, {
      rawBody,
      idempotencyKey,
      headers: redactHeaders(request.headers),
    });

    // 200 for something that already existed, 201 for something that did not. The decorator sets
    // the default; this narrows it, which is the only way an envelope-wrapped handler can.
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

/**
 * The headers worth keeping, with the credential removed.
 *
 * `x-api-key` and `x-signature` are deliberately dropped: storing a credential beside the payload
 * it authorised turns the never-lose store into a place to steal keys from. What is kept is what
 * helps somebody debug an integration — the content type, the user agent, the forwarding chain.
 */
function redactHeaders(headers: Record<string, unknown>): Record<string, string> {
  const keep = [
    'content-type',
    'user-agent',
    'idempotency-key',
    'x-forwarded-for',
    'origin',
    'referer',
  ];
  const kept: Record<string, string> = {};
  for (const name of keep) {
    const value = headers[name];
    if (typeof value === 'string') kept[name] = value.slice(0, 500);
  }
  return kept;
}
