import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '@leados/shared';
import { APP_CONFIG } from '../../../infra/config/config.module.js';
import type { AppConfig } from '../../../infra/config/config.schema.js';
import type { AdapterContext, IntegrationAdapter, ProbeResult } from '../integration.port.js';

/** How long a probe waits before calling the provider unreachable. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Postmark, the service that delivers this workspace's email.
 *
 * The probe is `GET /server` with the stored token — the cheapest authenticated call Postmark
 * offers, and the one whose answer distinguishes the three outcomes:
 *
 *  * **401 or 403 ⇒ `unauthorized`**, which `nextStatus` turns into `revoked` with no grace period.
 *    A token somebody deleted in Postmark's dashboard is not going to start working again, and a
 *    week of `degraded` would be a week of email silently not sending.
 *  * **Any other status ⇒ `degraded`**: they answered, we timed them, and they refused to do the
 *    work. The second one in a row is `error`.
 *  * **Nothing at all ⇒ `unreachable`**, with a null latency, because there is no measurement to
 *    report and a number there would read as "the provider took five seconds".
 *
 * It reads `POSTMARK_API_URL` rather than hard-coding the host, which is what makes this testable:
 * the suite points it at an in-process server and gets a real probe over real HTTP, the same trick
 * the outbound webhook suite uses. A probe that could only be tested with a mock would be a probe
 * nothing proves.
 */
@Injectable()
export class PostmarkAdapter implements IntegrationAdapter {
  readonly provider = 'postmark';

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  validate(input: { credential: string; settings: Record<string, unknown> }): void {
    // Shape only, and said in the words of somebody pasting a token: whether the token *works* is
    // what the probe is for, and it runs immediately after the connection is stored.
    if (input.credential.trim().length < 20) {
      throw AppError.validation('That does not look like a Postmark server token', [
        {
          field: 'credential',
          code: 'INVALID_CREDENTIAL',
          message:
            'Paste the Server API token from Postmark → your server → API Tokens. It is a long identifier, not your account password.',
        },
      ]);
    }
    const from = input.settings['fromAddress'];
    if (typeof from !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(from)) {
      throw AppError.validation('That sender address is not an email address', [
        {
          field: 'settings.fromAddress',
          code: 'INVALID_SENDER',
          message: 'Give the verified sender address Postmark will accept, like hello@yourdomain.com.',
        },
      ]);
    }
  }

  async probe(context: AdapterContext): Promise<ProbeResult> {
    const started = Date.now();
    try {
      const response = await fetch(`${this.config.POSTMARK_API_URL}/server`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'X-Postmark-Server-Token': context.credential,
        },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      const latencyMs = Date.now() - started;
      // Read as text and parsed defensively: a provider's error page is HTML often enough that
      // `response.json()` throwing would turn an informative 502 into "unreachable" with no detail.
      const body = (await response.text()).slice(0, 500);

      if (response.ok) {
        return {
          outcome: 'ok',
          latencyMs,
          detail: { status: response.status, server: serverName(body) },
        };
      }
      if (response.status === 401 || response.status === 403) {
        return {
          outcome: 'unauthorized',
          latencyMs,
          // Postmark's own sentence, kept rather than paraphrased: a refusal the provider wrote
          // for a person is the one thing not to rewrite.
          detail: { status: response.status, message: messageFrom(body) },
        };
      }
      return {
        outcome: 'degraded',
        latencyMs,
        detail: { status: response.status, message: messageFrom(body) },
      };
    } catch (error) {
      return {
        outcome: 'unreachable',
        // Null rather than the elapsed time: nothing was reached, so there is no latency to report
        // and a number here would read as "the provider took five seconds".
        latencyMs: null,
        detail: { error: error instanceof Error ? error.message.slice(0, 200) : 'request failed' },
      };
    }
  }
}

function serverName(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { Name?: unknown };
    return typeof parsed.Name === 'string' ? parsed.Name : null;
  } catch {
    return null;
  }
}

function messageFrom(body: string): string {
  try {
    const parsed = JSON.parse(body) as { Message?: unknown };
    if (typeof parsed.Message === 'string') return parsed.Message.slice(0, 300);
  } catch {
    /* not JSON; the raw text is the best answer we have */
  }
  return body.slice(0, 300);
}
