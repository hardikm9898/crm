import { Inject, Injectable } from '@nestjs/common';
import { AppError, parseWhatsAppMessages, parseWhatsAppStatuses } from '@leados/shared';
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

/**
 * What came of asking Meta to send a message.
 *
 * A failure says whether asking again could work, because the two outcomes are different things to
 * an agent: a message Meta is too busy for is still on its way, and one Meta has refused is one
 * somebody has to do something about.
 */
export type SendOutcome =
  | { readonly ok: true; readonly providerMessageId: string }
  | {
      readonly ok: false;
      readonly retryable: boolean;
      readonly code: string;
      readonly message: string;
    };

/** One template as Meta holds it, for the sync to reconcile against. */
export interface ProviderTemplate {
  readonly providerTemplateId: string;
  readonly name: string;
  readonly language: string;
  readonly status: string;
  readonly category: string | null;
  readonly rejectedReason: string | null;
}

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
 *  * **`parseDelivery` returns one event per message and one per status receipt.** A delivery can
 *    carry several messages from several numbers, and `statuses` for messages we sent. A message is
 *    keyed on Meta's own `wamid`; a receipt on `<wamid>:<status>`, because one message produces four
 *    of them and the ledger's unique would otherwise call the second a duplicate of the first.
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
    const messages = parseWhatsAppMessages(body).map((message) => ({
      externalId: message.providerMessageId,
      eventType: `message.${message.type}`,
      // The whole message, flattened by nothing: a WhatsApp message is not a lead capture, so no
      // field mapping reads this — the conversation pipeline does, and it wants Meta's own shape.
      payload: message.raw,
    }));
    // A status receipt is an event in its own right, keyed `<wamid>:<status>` — **not** on the
    // `wamid` alone, because one message produces four of them and the ledger's unique would make
    // the second one a duplicate of the first. Step 1 dropped these, acknowledged; step 2 is what
    // they are for.
    const statuses = parseWhatsAppStatuses(body).map((status) => ({
      externalId: `${status.providerMessageId}:${status.status}`,
      eventType: `status.${status.status}`,
      payload: status.raw,
    }));
    return [...messages, ...statuses];
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

  /**
   * Sends a message, and answers with the `wamid` Meta gives it (`FR-WA-9`).
   *
   * One method for both kinds, because the difference between them is the body Meta is sent and
   * nothing else — and a second method would be a second place for the error handling, which is the
   * part that matters here. What a caller gets back is either the provider id or a **typed
   * failure**: `retryable` is the difference between "Meta is busy" and "this message will never
   * send", and only the second is worth showing an agent as failed.
   */
  async sendMessage(
    context: AdapterContext,
    input: {
      readonly phoneNumberId: string;
      readonly toE164: string;
      readonly body:
        | { readonly kind: 'text'; readonly text: string }
        | {
            readonly kind: 'template';
            readonly name: string;
            readonly language: string;
            readonly parameters: readonly string[];
          };
    },
  ): Promise<SendOutcome> {
    // Meta wants the recipient without the `+`, which is also how it sends `wa_id`.
    const to = input.toE164.replace(/^\+/, '');
    const payload =
      input.body.kind === 'text'
        ? {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'text',
            // Previews off: a link preview on a reply an agent typed is Meta fetching somebody
            // else's page on our behalf, and the agent did not ask for it.
            text: { body: input.body.text, preview_url: false },
          }
        : {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'template',
            template: {
              name: input.body.name,
              language: { code: input.body.language },
              ...(input.body.parameters.length === 0
                ? {}
                : {
                    components: [
                      {
                        type: 'body',
                        parameters: input.body.parameters.map((text) => ({ type: 'text', text })),
                      },
                    ],
                  }),
            },
          };

    let response: Response;
    try {
      response = await this.post(`/${encodeURIComponent(input.phoneNumberId)}/messages`, context, payload);
    } catch (error) {
      // Nothing answered: the message may or may not have been accepted, which is exactly what a
      // retry is for — and the ledger's `wamid` is what stops a double send if it was.
      return {
        ok: false,
        retryable: true,
        code: 'UNREACHABLE',
        message: error instanceof Error ? error.message.slice(0, 300) : 'Meta could not be reached.',
      };
    }
    const text = (await response.text()).slice(0, 20_000);
    if (!response.ok) {
      const code = metaErrorCode(text);
      return {
        ok: false,
        // 429 and 5xx are Meta asking us to come back; 4xx with a credential code is a person's
        // job; anything else 4xx is this message's own fault and will fail again identically.
        retryable: response.status === 429 || response.status >= 500,
        code: code === null ? String(response.status) : String(code),
        message: metaMessage(text),
      };
    }
    let parsed: { messages?: { id?: unknown }[] };
    try {
      parsed = JSON.parse(text) as { messages?: { id?: unknown }[] };
    } catch {
      return { ok: false, retryable: true, code: 'BAD_RESPONSE', message: 'Meta answered something that is not JSON.' };
    }
    const id = parsed.messages?.[0]?.id;
    if (typeof id !== 'string' || id === '') {
      // Accepted with no id is not a success we can track: the status receipts are keyed on the
      // `wamid`, so a message with none would be stuck at `accepted` for ever.
      return { ok: false, retryable: true, code: 'NO_MESSAGE_ID', message: 'Meta accepted the message without giving it an id.' };
    }
    return { ok: true, providerMessageId: id };
  }

  /**
   * Submits a template for review, and answers with Meta's id for it (`FR-WA-5`).
   *
   * The components are assembled here rather than stored in Meta's shape, because Meta's shape is
   * an array of typed objects whose order matters and whose `example` block is required — three
   * things a person editing a template in our screen should not have to know.
   */
  async submitTemplate(
    context: AdapterContext,
    input: {
      readonly name: string;
      readonly language: string;
      readonly category: string;
      readonly components: {
        readonly header?: string;
        readonly body: string;
        readonly footer?: string;
        readonly buttons?: readonly string[];
      };
      /** One sample value per `{{n}}`, which Meta requires in order to review the wording. */
      readonly examples: readonly string[];
    },
  ): Promise<{ providerTemplateId: string; status: string }> {
    const wabaId = typeof context.settings['wabaId'] === 'string' ? context.settings['wabaId'] : '';
    if (wabaId === '') {
      throw AppError.businessRule('That connection has no WhatsApp Business Account id.');
    }
    const components: Record<string, unknown>[] = [];
    if (input.components.header !== undefined && input.components.header.trim() !== '') {
      components.push({ type: 'HEADER', format: 'TEXT', text: input.components.header });
    }
    components.push({
      type: 'BODY',
      text: input.components.body,
      ...(input.examples.length === 0
        ? {}
        : { example: { body_text: [[...input.examples]] } }),
    });
    if (input.components.footer !== undefined && input.components.footer.trim() !== '') {
      components.push({ type: 'FOOTER', text: input.components.footer });
    }
    if (input.components.buttons !== undefined && input.components.buttons.length > 0) {
      components.push({
        type: 'BUTTONS',
        buttons: input.components.buttons.map((text) => ({ type: 'QUICK_REPLY', text })),
      });
    }

    const response = await this.post(`/${encodeURIComponent(wabaId)}/message_templates`, context, {
      name: input.name,
      language: input.language,
      category: input.category.toUpperCase(),
      components,
    });
    const text = (await response.text()).slice(0, 20_000);
    if (!response.ok) {
      throw new AppError(
        isCredentialFailure(response.status, metaErrorCode(text)) ? 'INVALID_API_KEY' : 'BUSINESS_RULE_VIOLATION',
        `WhatsApp refused the template: ${metaMessage(text)}`,
        isCredentialFailure(response.status, metaErrorCode(text)) ? 401 : 422,
      );
    }
    const parsed = JSON.parse(text) as { id?: unknown; status?: unknown };
    if (typeof parsed.id !== 'string' || parsed.id === '') {
      throw new AppError('INTERNAL_ERROR', 'WhatsApp accepted the template without giving it an id.', 502);
    }
    return {
      providerTemplateId: parsed.id,
      status: typeof parsed.status === 'string' ? parsed.status.toLowerCase() : 'pending',
    };
  }

  /**
   * Every template Meta holds for this account, which is what the sync reconciles against.
   *
   * Read rather than trusted: Meta approves, rejects, pauses and disables on its own schedule, and
   * a product that remembered its own last word would offer a button that fails.
   */
  async listTemplates(context: AdapterContext): Promise<ProviderTemplate[]> {
    const wabaId = typeof context.settings['wabaId'] === 'string' ? context.settings['wabaId'] : '';
    if (wabaId === '') return [];
    const response = await this.graph(
      `/${encodeURIComponent(wabaId)}/message_templates?fields=id,name,language,status,category,rejected_reason&limit=200`,
      context,
    );
    const text = (await response.text()).slice(0, 200_000);
    if (!response.ok) {
      throw new AppError(
        isCredentialFailure(response.status, metaErrorCode(text)) ? 'INVALID_API_KEY' : 'INTERNAL_ERROR',
        `Meta refused the template list (${response.status}): ${metaMessage(text)}`,
        isCredentialFailure(response.status, metaErrorCode(text)) ? 401 : 502,
      );
    }
    let parsed: { data?: unknown };
    try {
      parsed = JSON.parse(text) as { data?: unknown };
    } catch {
      throw new AppError('INTERNAL_ERROR', 'Meta answered something that is not JSON.', 502);
    }
    if (!Array.isArray(parsed.data)) return [];
    return parsed.data.flatMap((row) => {
      const entry = row as Record<string, unknown>;
      const id = entry['id'];
      const name = entry['name'];
      const language = entry['language'];
      if (typeof id !== 'string' || typeof name !== 'string' || typeof language !== 'string') return [];
      const reason = entry['rejected_reason'];
      return [
        {
          providerTemplateId: id,
          name,
          language,
          status: typeof entry['status'] === 'string' ? entry['status'].toLowerCase() : 'pending',
          category: typeof entry['category'] === 'string' ? entry['category'].toLowerCase() : null,
          // Meta answers `NONE` rather than null when it has not rejected anything.
          rejectedReason:
            typeof reason === 'string' && reason !== '' && reason.toUpperCase() !== 'NONE'
              ? reason
              : null,
        },
      ];
    });
  }

  private post(path: string, context: AdapterContext, payload: unknown): Promise<Response> {
    return fetch(`${this.config.META_GRAPH_URL}${path}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${context.secrets[WHATSAPP_ACCESS_TOKEN] ?? ''}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
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
