import { lookup } from 'node:dns/promises';
import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  URL_REFUSAL_MESSAGES,
  classifyWebhookUrl,
  isBlockedAddress,
  type UrlRefusal,
} from '@leados/shared';
import { APP_CONFIG } from '../../infra/config/config.module.js';
import type { AppConfig } from '../../infra/config/config.schema.js';

/**
 * Whether we may post to a URL a **tenant** chose (`FR-API-4`, `docs/security.md`).
 *
 * Two halves, because they fail at different times:
 *
 *  * The **static** half (`classifyWebhookUrl` in `@leados/shared`) reads the URL text: scheme,
 *    credentials, port, and a literal address inside a private range. That is what the create and
 *    update endpoints refuse with, so a mistake is a 400 naming the field rather than a delivery
 *    that silently never works.
 *  * The **resolved** half is here, and runs again before every attempt. A hostname is not a
 *    promise: `internal.example.com` can resolve to 127.0.0.1 today and 10.0.0.5 tomorrow, and a
 *    check done only at save time is one an attacker controls the other side of (DNS rebinding).
 *    Resolving per attempt costs a lookup the HTTP client was going to make anyway.
 *
 * `allowInsecure` is a **deployment** setting, not a per-endpoint field: a tenant who could tick it
 * could ask us to post a signed payload over the open internet in clear, or at our own database.
 * It is on in development so an endpoint under test can be `http://localhost:4010`.
 */
@Injectable()
export class WebhookUrlService {
  private readonly allowInsecure: boolean;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.allowInsecure = config.NODE_ENV !== 'production';
  }

  /** Refuses with a 400 naming the field, which is what a person typing a URL needs. */
  assertStorable(url: string): void {
    const verdict = classifyWebhookUrl(url, { allowInsecure: this.allowInsecure });
    if (verdict.ok) return;
    const reason = (verdict.reason ?? 'not_a_url') as UrlRefusal;
    throw AppError.validation('Some details need correcting', [
      { field: 'url', code: 'UNREACHABLE_URL', message: URL_REFUSAL_MESSAGES[reason] },
    ]);
  }

  /**
   * The send-time check. Answers a refusal **reason** rather than throwing, because a delivery's
   * failure is a row in the log and not an exception a caller handles: "that hostname now resolves
   * to a private address" is exactly the sentence the attempt should record.
   */
  async refusalFor(url: string): Promise<string | null> {
    const verdict = classifyWebhookUrl(url, { allowInsecure: this.allowInsecure });
    if (!verdict.ok) return URL_REFUSAL_MESSAGES[(verdict.reason ?? 'not_a_url') as UrlRefusal];

    const hostname = verdict.hostname ?? '';
    // A literal address has already been classified; resolving it would be a no-op lookup.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) return null;
    // In development the allowlist deliberately includes localhost, which has nothing to resolve.
    if (this.allowInsecure) return null;

    let addresses: readonly { address: string }[];
    try {
      addresses = await lookup(hostname, { all: true });
    } catch {
      return 'That hostname does not resolve.';
    }
    if (addresses.length === 0) return 'That hostname does not resolve.';
    // **Every** address, not the first: a name that resolves to one public and one private address
    // is one the HTTP client may reach either way, and the private one is the whole attack.
    if (addresses.some((entry) => isBlockedAddress(entry.address))) {
      return URL_REFUSAL_MESSAGES.blocked_address;
    }
    return null;
  }
}
