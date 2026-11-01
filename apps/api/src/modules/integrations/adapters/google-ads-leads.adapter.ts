import { Injectable } from '@nestjs/common';
import { AppError, flattenGoogleColumnData } from '@leados/shared';
import { EncryptionService } from '../../../infra/crypto/encryption.service.js';
import { GOOGLE_WEBHOOK_KEY } from './secret-names.js';
import type {
  IntegrationAdapter,
  ProviderDelivery,
  VerificationResult,
} from '../integration.port.js';

/**
 * Google Ads lead form extensions.
 *
 * The verification is the shape that justified `inboundVerification` being a provider property:
 * Google does **not** sign anything. It asks you for a "webhook key" when you configure the lead
 * form, and then sends that key back in the body of every delivery as `google_key`. So this adapter
 * compares a value **inside** the payload, in constant time, against the secret we generated — and
 * a framework that had assumed an HMAC header would have had to be reopened for it.
 *
 * Two consequences of that shape, both stated because neither is a choice we made:
 *
 *  * **A delivery is replayable by anybody who has ever seen one.** There is no timestamp to bound
 *    and no signature over the bytes, so the only thing stopping a captured payload being posted
 *    again is `provider_events`' unique on Google's own `lead_id` — which is exactly why that
 *    ledger exists and why this provider could not be built before it.
 *  * **There is nothing to probe.** The key is ours and Google holds it; the connection is healthy
 *    when something arrives. `probe` is therefore absent rather than fabricated.
 *
 * Google also sends a test delivery with `is_test: true` and the literal lead id `lead_id_123`
 * when somebody presses "Send test data". It is verified and acknowledged like any other — a
 * provider that gets a 4xx from a test disables the endpoint — but the service does not capture it,
 * because a test lead in somebody's pipeline is worse than no test at all.
 */
@Injectable()
export class GoogleAdsLeadsAdapter implements IntegrationAdapter {
  readonly provider = 'google_ads_leads';

  validate(input: { secrets: Readonly<Record<string, string>> }): void {
    if (Object.keys(input.secrets).length > 0) {
      throw AppError.validation('This connection’s key is generated here', [
        {
          field: 'credentials',
          code: 'CREDENTIAL_NOT_ACCEPTED',
          message:
            'Leave it blank — we generate the webhook key and show it to you once. Paste it into Google Ads when you set the lead form up.',
        },
      ]);
    }
  }

  verifyInbound(input: {
    body: Record<string, unknown>;
    secrets: Readonly<Record<string, string>>;
  }): VerificationResult {
    const presented = input.body['google_key'];
    if (typeof presented !== 'string' || presented === '') {
      return {
        ok: false,
        message:
          'This endpoint requires the webhook key in the payload. Set it on the lead form in Google Ads, as google_key.',
      };
    }
    // Constant-time, like every other secret comparison in this product: a key compared with `===`
    // leaks its prefix to anybody willing to send a few thousand deliveries.
    if (!EncryptionService.safeEqual(presented, input.secrets[GOOGLE_WEBHOOK_KEY] ?? '')) {
      return {
        ok: false,
        message:
          'That webhook key does not match this connection. Copy the key from the connection in Lead OS into the lead form in Google Ads.',
      };
    }
    return { ok: true };
  }

  /**
   * One request, one lead.
   *
   * The external id is Google's `lead_id`, which is what makes the ledger's unique meaningful: a
   * retried delivery carries the same one. A payload without it is refused as a validation failure
   * rather than deduplicated under a key we invented — an id we made up would make every retry a
   * new lead, which is the opposite of the guarantee.
   */
  parseDelivery(body: Record<string, unknown>): readonly ProviderDelivery[] {
    const leadId = body['lead_id'];
    if (typeof leadId !== 'string' || leadId.trim() === '') {
      throw AppError.validation('That delivery carries no lead id', [
        {
          field: 'lead_id',
          code: 'MISSING_EXTERNAL_ID',
          message:
            'Google Ads sends lead_id with every lead. Without it a retried delivery cannot be told from a new lead.',
        },
      ]);
    }
    return [
      {
        externalId: leadId.trim(),
        // Google's own word for it, when it says. `is_test` deliveries carry no `form_id`.
        eventType: body['is_test'] === true ? 'test_lead' : 'lead',
        // Flattened by `column_id`, which is the stable key: `column_name` is the question's
        // wording and changes the moment somebody edits the form.
        payload: flattenGoogleColumnData(body),
      },
    ];
  }
}
