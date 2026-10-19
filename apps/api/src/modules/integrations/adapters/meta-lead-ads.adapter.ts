import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AppError, flattenMetaFieldData } from '@leados/shared';
import { APP_CONFIG } from '../../../infra/config/config.module.js';
import type { AppConfig } from '../../../infra/config/config.schema.js';
import type {
  AdapterContext,
  IntegrationAdapter,
  ProbeResult,
  ProviderDelivery,
  VerificationResult,
} from '../integration.port.js';
import { META_APP_SECRET, META_PAGE_TOKEN } from './secret-names.js';


/** How long a probe or a lead fetch waits before giving up. */
const TIMEOUT_MS = 8_000;

/**
 * Meta Lead Ads (`FR-CAP-1`, and Phase 4's fifth exit criterion).
 *
 * This is the first adapter that **reads from** a provider rather than only being read by one, and
 * every one of its four methods exists because Meta works a particular way:
 *
 *  * **`challenge`** — Meta will not deliver anything until the callback URL answers its
 *    `hub.challenge` echo, once, with the verify token the workspace chose. A provider-specific
 *    handshake is exactly the kind of thing a registry exists to keep out of the HTTP layer.
 *  * **`verifyInbound`** — `X-Hub-Signature-256: sha256=<hex>`, an HMAC over the **raw** body with
 *    the **app** secret. Not the page token: Meta signs with the app secret and fetches with the
 *    token, which is the whole reason a connection holds two secrets rather than one.
 *  * **`parseDelivery`** — one request carries `entry[].changes[]`, so a delivery is zero or more
 *    events. Each is deduplicated on its own `leadgen_id`, because a retry of a batch of three must
 *    not turn on whether all three were new.
 *  * **`fetchLead`** — Meta sends an **id**, not the answers. `GET /{leadgen_id}` with the page
 *    token returns `field_data`, which is flattened by question name so a mapping can be written
 *    against `full_name` rather than against an array index that moves when the form is edited.
 *
 * `META_GRAPH_URL` is read from the configuration rather than hard-coded, which is what makes this
 * testable: the suite points it at an in-process server and gets a real fetch and a real signature
 * check over real HTTP. An adapter that could only be tested with a mock would be an adapter
 * nothing proves.
 */
@Injectable()
export class MetaLeadAdsAdapter implements IntegrationAdapter {
  readonly provider = 'meta_lead_ads';

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  validate(input: {
    secrets: Readonly<Record<string, string>>;
    settings: Record<string, unknown>;
  }): void {
    // Shape only, in the words of somebody pasting them. Whether they *work* is the probe's
    // question, and it runs immediately after the connection is stored.
    const appSecret = (input.secrets[META_APP_SECRET] ?? '').trim();
    if (appSecret.length < 16) {
      throw AppError.validation('That does not look like a Meta app secret', [
        {
          field: `credentials.${META_APP_SECRET}`,
          code: 'INVALID_CREDENTIAL',
          message:
            'Meta for Developers → your app → Settings → Basic → App Secret. A 32-character hexadecimal string.',
        },
      ]);
    }
    if ((input.secrets[META_PAGE_TOKEN] ?? '').trim().length < 32) {
      throw AppError.validation('That does not look like a page access token', [
        {
          field: `credentials.${META_PAGE_TOKEN}`,
          code: 'INVALID_CREDENTIAL',
          message:
            'A long-lived Page access token with the leads_retrieval permission. Without it we receive an id and cannot read the answers.',
        },
      ]);
    }
    const pageId = input.settings['pageId'];
    if (typeof pageId !== 'string' || !/^\d{5,}$/.test(pageId)) {
      throw AppError.validation('That is not a page id', [
        {
          field: 'settings.pageId',
          code: 'INVALID_SETTING',
          message: 'The numeric id of the Facebook Page — digits only, as Meta shows it.',
        },
      ]);
    }
  }

  /**
   * Meta's one-time handshake.
   *
   * Answered **only** when the mode is `subscribe` and the token matches, in constant time. A
   * callback that echoed any challenge it was sent would let anybody who guesses a connection id
   * confirm that it exists, which is the oracle `UuidParamPipe` exists to close elsewhere. A
   * workspace that set no verify token has nothing to match, so the handshake is refused rather
   * than waved through — the honest refusal, and the screen says to set one.
   */
  challenge(input: {
    query: Readonly<Record<string, string | undefined>>;
    settings: Record<string, unknown>;
  }): string | null {
    if (input.query['hub.mode'] !== 'subscribe') return null;
    const expected = input.settings['verifyToken'];
    const presented = input.query['hub.verify_token'];
    if (typeof expected !== 'string' || expected === '' || typeof presented !== 'string') {
      return null;
    }
    if (!safeEqual(presented, expected)) return null;
    const challenge = input.query['hub.challenge'];
    return typeof challenge === 'string' && challenge !== '' ? challenge : null;
  }

  verifyInbound(input: {
    rawBody: string;
    headers: Readonly<Record<string, string | undefined>>;
    secrets: Readonly<Record<string, string>>;
  }): VerificationResult {
    const header = input.headers['x-hub-signature-256'];
    if (typeof header !== 'string' || header.trim() === '') {
      return {
        ok: false,
        message:
          'This endpoint requires Meta’s signature. Deliveries must carry X-Hub-Signature-256; check the app this Page is subscribed through.',
      };
    }
    if (!header.startsWith('sha256=')) {
      return {
        ok: false,
        message: 'The X-Hub-Signature-256 header is not in Meta’s form: sha256=<hex digest>.',
      };
    }
    const expected = createHmac('sha256', input.secrets[META_APP_SECRET] ?? '')
      .update(input.rawBody)
      .digest('hex');
    if (!safeEqual(header.slice('sha256='.length), expected)) {
      return {
        ok: false,
        // The likeliest cause, named: an app secret from a different app signs perfectly and
        // matches nothing, and "signature mismatch" alone sends somebody hunting the wrong thing.
        message:
          'That signature does not match the body. The app secret on this connection must belong to the app the Page is subscribed through.',
      };
    }
    return { ok: true };
  }

  /**
   * `entry[].changes[]` as events.
   *
   * Only `leadgen` changes are returned. An unknown field — Meta adds them — is **dropped here
   * rather than refused**, because a 4xx teaches a provider to disable the endpoint, and an
   * endpoint Meta has disabled stops delivering leads silently. The caller acknowledges with 200
   * either way, which is what §7 of `api-architecture.md` requires.
   */
  parseDelivery(body: Record<string, unknown>): readonly ProviderDelivery[] {
    const entries = body['entry'];
    if (!Array.isArray(entries)) return [];
    const events: ProviderDelivery[] = [];
    for (const entry of entries) {
      const changes = (entry as { changes?: unknown })?.changes;
      if (!Array.isArray(changes)) continue;
      for (const change of changes) {
        const field = (change as { field?: unknown })?.field;
        const value = (change as { value?: unknown })?.value;
        if (field !== 'leadgen' || value === null || typeof value !== 'object') continue;
        const leadgenId = (value as { leadgen_id?: unknown }).leadgen_id;
        if (typeof leadgenId !== 'string' && typeof leadgenId !== 'number') continue;
        events.push({
          externalId: String(leadgenId),
          eventType: 'leadgen',
          // Empty: the delivery is a reference, and the answers are a second request. What is in
          // the value — the form id, the page id, the created time — is kept on the ledger row's
          // `raw`, which is the whole delivery.
          payload: {},
        });
      }
    }
    return events;
  }

  /**
   * The lead itself, by the id Meta sent.
   *
   * Flattened by question name, and the raw `field_data` kept beside it: a workspace whose form
   * asks a custom question maps `what_is_your_budget` by name, and the array is still there for
   * somebody reading the stored payload to see what arrived.
   */
  async fetchLead(input: {
    externalId: string;
    context: AdapterContext;
  }): Promise<Record<string, unknown>> {
    const token = input.context.secrets[META_PAGE_TOKEN] ?? '';
    const url = `${this.config.META_GRAPH_URL}/${encodeURIComponent(input.externalId)}?fields=id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,field_data`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = (await response.text()).slice(0, 4_000);
    if (!response.ok) {
      // A refusal from Meta is the caller's answer to "why is this lead not here", so the
      // provider's own message is carried rather than paraphrased — and whether it is replayable
      // is the difference between a token somebody has to replace and a bad minute.
      const message = metaMessage(text);
      throw new AppError(
        response.status === 401 || response.status === 403 ? 'INVALID_API_KEY' : 'INTERNAL_ERROR',
        `Meta refused the lead fetch (${response.status}): ${message}`,
        response.status === 401 || response.status === 403 ? 401 : 502,
      );
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new AppError('INTERNAL_ERROR', 'Meta answered something that is not JSON.', 502);
    }
    return flattenMetaFieldData(parsed);
  }

  /**
   * The Page, asked whether the token still reads it.
   *
   * `GET /{pageId}?fields=id,name` — the cheapest authenticated call that fails the way a revoked
   * token fails. Meta answers **200 with an `error` body** for some failures and 400 for an expired
   * token rather than 401, so the code inside the body is read as well as the status: `190` is
   * "access token invalid or revoked", which is the one outcome a person has to act on.
   */
  async probe(context: AdapterContext): Promise<ProbeResult> {
    const pageId = typeof context.settings['pageId'] === 'string' ? context.settings['pageId'] : '';
    if (pageId === '') {
      return {
        outcome: 'degraded',
        latencyMs: 0,
        detail: { message: 'This connection has no page id, so there is nothing to check.' },
      };
    }
    const started = Date.now();
    try {
      const response = await fetch(
        `${this.config.META_GRAPH_URL}/${encodeURIComponent(pageId)}?fields=id,name`,
        {
          method: 'GET',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${context.secrets[META_PAGE_TOKEN] ?? ''}`,
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
      const latencyMs = Date.now() - started;
      const body = (await response.text()).slice(0, 1_000);
      const code = metaErrorCode(body);

      if (response.ok && code === null) {
        return { outcome: 'ok', latencyMs, detail: { status: response.status, page: metaName(body) } };
      }
      // 190 is a token that has been revoked, expired or invalidated; 102 is a session error; 10
      // and 200-series are missing permissions, which a person also has to fix.
      const unauthorized =
        response.status === 401 ||
        response.status === 403 ||
        code === 190 ||
        code === 102 ||
        code === 10;
      return {
        outcome: unauthorized ? 'unauthorized' : 'degraded',
        latencyMs,
        detail: { status: response.status, code, message: metaMessage(body) },
      };
    } catch (error) {
      return {
        outcome: 'unreachable',
        latencyMs: null,
        detail: { error: error instanceof Error ? error.message.slice(0, 200) : 'request failed' },
      };
    }
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function metaErrorCode(body: string): number | null {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown } };
    return typeof parsed.error?.code === 'number' ? parsed.error.code : null;
  } catch {
    return null;
  }
}

function metaName(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { name?: unknown };
    return typeof parsed.name === 'string' ? parsed.name : null;
  } catch {
    return null;
  }
}

function metaMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === 'string') return parsed.error.message.slice(0, 300);
  } catch {
    /* not JSON; the raw text is the best answer we have */
  }
  return body.slice(0, 300);
}
