import { Inject, Injectable } from '@nestjs/common';
import { AppError, parseWhatsAppMessages } from '@leados/shared';
import { APP_CONFIG } from '../../../infra/config/config.module.js';
import type { AppConfig } from '../../../infra/config/config.schema.js';
import type {
  AdapterContext,
  IntegrationAdapter,
  ProbeResult,
  ProviderDelivery,
  VerificationResult,
} from '../integration.port.js';
import {
  answerHubChallenge,
  isCredentialFailure,
  metaErrorCode,
  metaMessage,
  verifyHubSignature,
} from './meta-signature.js';
import { WHATSAPP_ACCESS_TOKEN, WHATSAPP_APP_SECRET } from './secret-names.js';

/** How long a probe or a numbers lookup waits before giving up. */
const TIMEOUT_MS = 8_000;

/** One business number, as Meta's `/phone_numbers` answers it. */
export interface DiscoveredNumber {
  readonly phoneNumberId: string;
  readonly displayPhoneE164: string;
  readonly verifiedName: string | null;
  readonly qualityRating: string | null;
  readonly messagingLimitTier: string | null;
}

/**
 * WhatsApp Cloud API (`FR-WA-1`, `FR-WA-2`, `FR-WA-6`).
 *
 * The reference implementation §4 of `integration-architecture.md` calls for, and the third Meta
 * product on this framework — so its handshake and its signature come from `meta-signature.ts`
 * rather than being written a third time. What is its own:
 *
 *  * **`probe` reads the WABA and its numbers.** Meta's quality rating and send tier live on the
 *    number and change without telling anybody, so the probe that asks "is this credential good"
 *    is also the cheapest moment to refresh them. The numbers themselves are **discovered**, not
 *    typed: a workspace that had to copy a `phone_number_id` by hand would get it wrong, and the
 *    id is the only thing that resolves an inbound delivery to a workspace.
 *  * **`parseDelivery` returns one event per message**, each on Meta's own `wamid`. A delivery can
 *    carry several messages from several numbers, and `statuses` for messages we sent — the last of
 *    which this step has nothing to do with and therefore drops, acknowledged.
 *
 * There is no `fetchLead`: a WhatsApp delivery carries the message. `META_GRAPH_URL` is read from
 * the configuration, which is what makes this testable against a real in-process Graph API.
 */
@Injectable()
export class WhatsAppCloudAdapter implements IntegrationAdapter {
  readonly provider = 'whatsapp_cloud';

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  validate(input: {
    secrets: Readonly<Record<string, string>>;
    settings: Record<string, unknown>;
  }): void {
    if ((input.secrets[WHATSAPP_APP_SECRET] ?? '').trim().length < 16) {
      throw AppError.validation('That does not look like a Meta app secret', [
        {
          field: `credentials.${WHATSAPP_APP_SECRET}`,
          code: 'INVALID_CREDENTIAL',
          message:
            'Meta for Developers → your app → Settings → Basic → App Secret. A 32-character hexadecimal string.',
        },
      ]);
    }
    if ((input.secrets[WHATSAPP_ACCESS_TOKEN] ?? '').trim().length < 32) {
      throw AppError.validation('That does not look like an access token', [
        {
          field: `credentials.${WHATSAPP_ACCESS_TOKEN}`,
          code: 'INVALID_CREDENTIAL',
          message:
            'A permanent system-user token with whatsapp_business_messaging and whatsapp_business_management. A temporary one expires in 24 hours and the connection will read as revoked tomorrow.',
        },
      ]);
    }
    const wabaId = input.settings['wabaId'];
    if (typeof wabaId !== 'string' || !/^\d{5,}$/.test(wabaId)) {
      throw AppError.validation('That is not a WhatsApp Business Account id', [
        {
          field: 'settings.wabaId',
          code: 'INVALID_SETTING',
          message: 'The numeric id from Meta Business Suite → WhatsApp Accounts — digits only.',
        },
      ]);
    }
  }

  challenge(input: {
    query: Readonly<Record<string, string | undefined>>;
    settings: Record<string, unknown>;
  }): string | null {
    return answerHubChallenge(input);
  }

  verifyInbound(input: {
    rawBody: string;
    headers: Readonly<Record<string, string | undefined>>;
    secrets: Readonly<Record<string, string>>;
  }): VerificationResult {
    return verifyHubSignature({
      rawBody: input.rawBody,
      headers: input.headers,
      appSecret: input.secrets[WHATSAPP_APP_SECRET] ?? '',
      productHint: 'this number',
    });
  }

  /**
   * One event per inbound message, on Meta's own id.
   *
   * `statuses` — the delivery receipts for messages we sent — are **dropped and acknowledged**:
   * this step sends nothing, so there is no message of ours for them to be about, and a 4xx would
   * teach Meta to disable the endpoint and stop delivering the messages we do want.
   */
  parseDelivery(body: Record<string, unknown>): readonly ProviderDelivery[] {
    return parseWhatsAppMessages(body).map((message) => ({
      externalId: message.providerMessageId,
      eventType: `message.${message.type}`,
      // The whole message, flattened by nothing: a WhatsApp message is not a lead capture, so no
      // field mapping reads this — the conversation pipeline does, and it wants Meta's own shape.
      payload: message.raw,
    }));
  }

  /**
   * The WABA, asked whether the token still reads it — and its numbers, refreshed.
   *
   * `GET /{wabaId}?fields=id,name` is the cheapest authenticated call that fails the way a revoked
   * token fails. The numbers are a second request, and a failure of *that* alone is `degraded`
   * rather than `unauthorized`: the credential plainly works, and a connection that read as revoked
   * because a secondary lookup hiccuped would send somebody to reconnect something that is fine.
   */
  async probe(context: AdapterContext): Promise<ProbeResult> {
    const wabaId = typeof context.settings['wabaId'] === 'string' ? context.settings['wabaId'] : '';
    if (wabaId === '') {
      return {
        outcome: 'degraded',
        latencyMs: 0,
        detail: { message: 'This connection has no WhatsApp Business Account id to check.' },
      };
    }
    const started = Date.now();
    try {
      const response = await this.graph(`/${encodeURIComponent(wabaId)}?fields=id,name`, context);
      const latencyMs = Date.now() - started;
      const body = (await response.text()).slice(0, 1_000);
      const code = metaErrorCode(body);
      if (!response.ok || code !== null) {
        return {
          outcome: isCredentialFailure(response.status, code) ? 'unauthorized' : 'degraded',
          latencyMs,
          detail: { status: response.status, code, message: metaMessage(body) },
        };
      }
      return {
        outcome: 'ok',
        latencyMs,
        detail: { status: response.status, businessName: readName(body) },
      };
    } catch (error) {
      return {
        outcome: 'unreachable',
        latencyMs: null,
        detail: { error: error instanceof Error ? error.message.slice(0, 200) : 'request failed' },
      };
    }
  }

  /**
   * The numbers on a WABA (`FR-WA-2`'s "manage phone numbers").
   *
   * Discovered rather than typed, because `phone_number_id` is what resolves an inbound delivery to
   * a workspace: a number somebody mistyped would silently receive nothing, and a number somebody
   * typed from another business's account would be refused by the global unique — which is the
   * right refusal and a baffling one to read on a form.
   */
  async listNumbers(context: AdapterContext): Promise<DiscoveredNumber[]> {
    const wabaId = typeof context.settings['wabaId'] === 'string' ? context.settings['wabaId'] : '';
    if (wabaId === '') return [];
    const response = await this.graph(
      `/${encodeURIComponent(wabaId)}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,messaging_limit_tier`,
      context,
    );
    const body = (await response.text()).slice(0, 20_000);
    if (!response.ok) {
      throw new AppError(
        isCredentialFailure(response.status, metaErrorCode(body)) ? 'INVALID_API_KEY' : 'INTERNAL_ERROR',
        `Meta refused the numbers lookup (${response.status}): ${metaMessage(body)}`,
        isCredentialFailure(response.status, metaErrorCode(body)) ? 401 : 502,
      );
    }
    let parsed: { data?: unknown };
    try {
      parsed = JSON.parse(body) as { data?: unknown };
    } catch {
      throw new AppError('INTERNAL_ERROR', 'Meta answered something that is not JSON.', 502);
    }
    if (!Array.isArray(parsed.data)) return [];
    return parsed.data.flatMap((row) => {
      const entry = row as Record<string, unknown>;
      const id = entry['id'];
      const display = entry['display_phone_number'];
      if (typeof id !== 'string' || id === '' || typeof display !== 'string') return [];
      return [
        {
          phoneNumberId: id,
          // Meta sends it with spaces and a leading `+` sometimes and without it others; the
          // column's CHECK is E.164, so this is the one place the shape is settled.
          displayPhoneE164: toE164(display),
          verifiedName: typeof entry['verified_name'] === 'string' ? entry['verified_name'] : null,
          qualityRating: typeof entry['quality_rating'] === 'string' ? entry['quality_rating'] : null,
          messagingLimitTier:
            typeof entry['messaging_limit_tier'] === 'string' ? entry['messaging_limit_tier'] : null,
        },
      ];
    });
  }

  private graph(path: string, context: AdapterContext): Promise<Response> {
    return fetch(`${this.config.META_GRAPH_URL}${path}`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${context.secrets[WHATSAPP_ACCESS_TOKEN] ?? ''}`,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }
}

function readName(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { name?: unknown };
    return typeof parsed.name === 'string' ? parsed.name : null;
  } catch {
    return null;
  }
}

/** Meta's display number as E.164. Digits and a plus, because that is what the column accepts. */
function toE164(display: string): string {
  const digits = display.replace(/\D+/g, '');
  return `+${digits}`;
}
