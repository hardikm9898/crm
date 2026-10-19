/**
 * The names each provider's secrets are filed under in the vault.
 *
 * In their own module, and not in the adapters that read them or the service that writes them, for
 * two reasons. The first is a cycle: the health service needs `sharedSecretField` and the main
 * service needs the health service, which under ESM is a `ReferenceError` at boot rather than a
 * type error — one this step actually hit. The second is the bug that cycle was hiding: the service
 * mints a `shared_secret` provider's secret and the adapter verifies with it, so two literals in
 * two files is the shape where rotating works, verifying does not, and neither file looks wrong.
 */

/** `generic_webhook` — the HMAC signing secret we generate. */
export const SHARED_SECRET_KEY = 'signingSecret';

/** `google_ads_leads` — the key Google echoes inside every payload. */
export const GOOGLE_WEBHOOK_KEY = 'webhookKey';

/** `postmark` — the server token, as its `credentialFields` names it. */
export const SERVER_TOKEN_KEY = 'serverToken';

/** `meta_lead_ads` — the app secret that signs a delivery, and the token that fetches the lead. */
export const META_APP_SECRET = 'appSecret';
export const META_PAGE_TOKEN = 'pageAccessToken';

/**
 * The name a `shared_secret` provider's own generated secret is filed under.
 *
 * One function, because the service mints it and the adapter reads it. A provider that generates
 * nothing never reaches this.
 */
export function sharedSecretField(provider: string): string {
  return provider === 'google_ads_leads' ? GOOGLE_WEBHOOK_KEY : SHARED_SECRET_KEY;
}
