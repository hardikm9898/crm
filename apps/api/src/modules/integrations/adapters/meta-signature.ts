import { createHmac, timingSafeEqual } from 'node:crypto';
import type { VerificationResult } from '../integration.port.js';

/**
 * Meta's two inbound conventions, shared by every Meta product.
 *
 * `meta_lead_ads` and `whatsapp_cloud` verify identically — an HMAC over the raw body with the
 * **app** secret, in `X-Hub-Signature-256` — and shake hands identically. Two copies would be two
 * places for the constant-time comparison to stop being constant-time, and the second copy is
 * always the one somebody simplifies.
 */
export function verifyHubSignature(input: {
  readonly rawBody: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly appSecret: string;
  /** What to call the credential in the refusal, since the two providers paste it from one place. */
  readonly productHint: string;
}): VerificationResult {
  const header = input.headers['x-hub-signature-256'];
  if (typeof header !== 'string' || header.trim() === '') {
    return {
      ok: false,
      message: `This endpoint requires Meta’s signature. Deliveries must carry X-Hub-Signature-256; check the app ${input.productHint} is subscribed through.`,
    };
  }
  if (!header.startsWith('sha256=')) {
    return {
      ok: false,
      message: 'The X-Hub-Signature-256 header is not in Meta’s form: sha256=<hex digest>.',
    };
  }
  const expected = createHmac('sha256', input.appSecret).update(input.rawBody).digest('hex');
  if (!safeEqual(header.slice('sha256='.length), expected)) {
    return {
      ok: false,
      // The likeliest cause, named: an app secret from a different app signs perfectly and matches
      // nothing, and "signature mismatch" alone sends somebody hunting the wrong thing.
      message: `That signature does not match the body. The app secret on this connection must belong to the app ${input.productHint} is subscribed through.`,
    };
  }
  return { ok: true };
}

/**
 * Meta's one-time handshake.
 *
 * Answered **only** when the mode is `subscribe` and the token matches, in constant time. A
 * callback that echoed any challenge it was sent would let anybody who guesses a connection id
 * confirm that it exists, which is the oracle `UuidParamPipe` exists to close elsewhere. A
 * workspace that set no verify token has nothing to match, so the handshake is refused rather than
 * waved through — the honest refusal, and the screen says to set one.
 */
export function answerHubChallenge(input: {
  readonly query: Readonly<Record<string, string | undefined>>;
  readonly settings: Record<string, unknown>;
}): string | null {
  if (input.query['hub.mode'] !== 'subscribe') return null;
  const expected = input.settings['verifyToken'];
  const presented = input.query['hub.verify_token'];
  if (typeof expected !== 'string' || expected === '' || typeof presented !== 'string') return null;
  if (!safeEqual(presented, expected)) return null;
  const challenge = input.query['hub.challenge'];
  return typeof challenge === 'string' && challenge !== '' ? challenge : null;
}

/** Meta's `error.code`, which says more than the HTTP status does. */
export function metaErrorCode(body: string): number | null {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown } };
    return typeof parsed.error?.code === 'number' ? parsed.error.code : null;
  } catch {
    return null;
  }
}

/** Meta's own sentence, kept rather than paraphrased. */
export function metaMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === 'string') return parsed.error.message.slice(0, 300);
  } catch {
    /* not JSON; the raw text is the best answer we have */
  }
  return body.slice(0, 300);
}

/**
 * Whether a Graph failure is the credential's.
 *
 * Meta answers **200 with an `error` body** for some failures and 400 for an expired token rather
 * than 401, so the code inside the body is read as well as the status: `190` is "access token
 * invalid or revoked", `102` a session error, `10` and the 200-series missing permissions — all of
 * them things a person has to act on rather than wait out.
 */
export function isCredentialFailure(status: number, code: number | null): boolean {
  return status === 401 || status === 403 || code === 190 || code === 102 || code === 10;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
