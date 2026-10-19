import { Injectable } from '@nestjs/common';
import { AppError } from '@leados/shared';
import type { IntegrationAdapter } from '../integration.port.js';

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

  validate(input: { credential: string; settings: Record<string, unknown> }): void {
    // The secret is ours, so a caller supplying one is either confused or trying to choose it.
    // Refused rather than ignored: a connection whose secret is not the one we told the sender
    // about fails every signature check, and "it ignored what I sent" is the worse surprise.
    if (input.credential.trim().length > 0) {
      throw AppError.validation('This connection’s secret is generated here', [
        {
          field: 'credential',
          code: 'CREDENTIAL_NOT_ACCEPTED',
          message:
            'Leave the secret blank — we generate it and show it to you once, and the sending system signs its requests with it.',
        },
      ]);
    }
  }
}
