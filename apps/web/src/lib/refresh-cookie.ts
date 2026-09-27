/**
 * Relaying the API's refresh cookie to the browser.
 *
 * The API sets its refresh cookie with `Path=/api/v1/auth`, which is the right scope for a browser
 * talking to the API directly. Relayed through this app the path is wrong in a way that fails
 * silently: no route here lives under `/api/v1/auth`, so the browser would store a cookie it could
 * never send back, and every session would die the moment the fifteen-minute access token expired.
 *
 * The path is therefore rewritten to `/`. Path is not a security boundary — the cookie stays
 * httpOnly (JavaScript cannot read it even from the same path) and SameSite=Lax — and `/` is what
 * lets the middleware renew an expired access token during an ordinary page navigation, which is
 * the whole point of having a refresh token. Nothing else about the cookie is changed; its lifetime
 * remains the API's decision.
 */
export const REFRESH_COOKIE_NAME = 'leados_rt';
export const REFRESH_COOKIE_PATH = '/';

export function rewriteRefreshCookiePath(setCookie: string): string {
  return /;\s*path=/i.test(setCookie)
    ? setCookie.replace(/;\s*path=[^;]*/i, `; Path=${REFRESH_COOKIE_PATH}`)
    : `${setCookie}; Path=${REFRESH_COOKIE_PATH}`;
}

/** Reads the refresh token out of a raw `Cookie` header. */
export function readRefreshToken(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === REFRESH_COOKIE_NAME) return decodeURIComponent(rest.join('='));
  }
  return null;
}
