import { Injectable } from '@nestjs/common';
import { AppError, verifySignature } from '@leados/shared';
import { IngestAuthService } from '../../ingestion/ingest-auth.service.js';
import { SHARED_SECRET_KEY } from './secret-names.js';
import type {
  IntegrationAdapter,
  ProviderDelivery,
  VerificationResult,
} from '../integration.port.js';


/**
 * Any other system, posting leads here with its own field names.
 *
 * **It has no `probe`**, and that absence is the design. The credential is a secret *we* generated;
 * the sender holds it and signs with it, so there is no endpoint of theirs to call and no question
 * to ask — "is this connection healthy" for an inbound webhook means "has anything arrived", which
 * is `last_success_at` and not a request. A `probe` that returned `ok` without doing anything would
 * be a green tick this product had not earned, and one that threw would be the lie in the contract
 * `mailer.port.ts` warns about.
 *
 * `validate` is almost empty for the same reason: nothing about a secret we minted ourselves needs
 * checking. What *does* get checked — the field mapping — is checked by the service for every
 * mappable provider, because a mapping is not this provider's private business and `mappingProblems`
 * is the one definition of what is wrong with one.
 */
@Injectable()
export class GenericWebhookAdapter implements IntegrationAdapter {
  readonly provider = 'generic_webhook';

  validate(input: { secrets: Readonly<Record<string, string>> }): void {
    // The secret is ours, so a caller supplying one is either confused or trying to choose it.
    // Refused rather than ignored: a connection whose secret is not the one we told the sender
    // about fails every signature check, and "it ignored what I sent" is the worse surprise.
    if (Object.keys(input.secrets).length > 0) {
      throw AppError.validation('This connection’s secret is generated here', [
        {
          field: 'credentials',
          code: 'CREDENTIAL_NOT_ACCEPTED',
          message:
            'Leave the secret blank — we generate it and show it to you once, and the sending system signs its requests with it.',
        },
      ]);
    }
  }

  /**
   * The public lead API's own check, over the raw bytes.
   *
   * Same `verifySignature`, same five-minute window, and the **same sentences** through
   * `IngestAuthService.signatureMessage`: an integrator debugging a signature should not have to
   * work out which of our doors they are at.
   */
  verifyInbound(input: {
    rawBody: string;
    headers: Readonly<Record<string, string | undefined>>;
    secrets: Readonly<Record<string, string>>;
  }): VerificationResult {
    const check = verifySignature(
      input.secrets[SHARED_SECRET_KEY] ?? '',
      input.headers['x-signature'],
      input.rawBody,
    );
    if (check.ok) return { ok: true };
    return { ok: false, message: IngestAuthService.signatureMessage(check.failure ?? 'mismatch') };
  }

  /**
   * One request, one event.
   *
   * The external id is **ours**, derived from the body, because a generic sender has no event id of
   * its own to give us — which is exactly what `Idempotency-Key` is for on this door, and why this
   * provider's deduplication stays in `idempotency_keys` rather than in the ledger. Returning no
   * events here says "there is nothing for the ledger to deduplicate", and the service reads that
   * rather than inventing a key that would make every distinct lead look like a replay.
   */
  parseDelivery(): readonly ProviderDelivery[] {
    return [];
  }
}
