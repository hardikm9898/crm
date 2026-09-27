# ADR-0013 — HS256 access tokens now, RS256 when a second verifier exists

**Status:** Accepted · **Date:** 2026-09-27 · Amends `security.md` §2 · Phase 1 step 2

## Context

`security.md` §2 specified `RS256` for access tokens. Implementing authentication forced the
question of what that asymmetry actually buys today.

RS256's value is that a party can **verify** tokens without being able to **mint** them. That
matters when a separate service, a third party, or an edge component validates tokens. In the
current architecture the API is the only verifier: the web client treats tokens as opaque, and
the collector and workers do not verify user tokens at all.

Against that, RS256 costs real key management: generation, storage, distribution, a JWKS
endpoint or embedded public keys, `kid` handling, and a rotation procedure with overlap. Every
one of those is a place to leak or misconfigure a key.

## Decision

**HS256 with separate secrets for access and refresh tokens**, plus a boot-time check that
refuses to start in production if the two secrets are equal or still hold development
placeholders.

Access tokens carry identity only — `sub`, `org`, `sid`, `jti`, `iss`, `aud`, `exp` — and no
permissions, so the payload is not sensitive beyond the identifiers it names.

Switch to RS256 when the first of these becomes true:

1. a process other than the API needs to verify user tokens (an extracted service, an edge
   authorizer, a gateway);
2. a customer or partner must verify our tokens;
3. compliance requires asymmetric signing.

The `TokenService` interface does not change when that happens: only the key material and the
`alg` header do.

## Consequences

**Positive:** no key-distribution surface; simpler rotation (rotate a secret, not a keypair);
fewer moving parts in an area where a mistake is severe; the separate-secrets rule means a
refresh token can never be replayed as an access token (there is a test for this).

**Negative:** the signing secret must be present wherever verification happens, so any future
verifier would gain minting ability — which is exactly the trigger to migrate. The MFA
challenge token is signed with the refresh secret and is therefore also minting-capable by the
API alone; acceptable for a 5-minute single-purpose token.

## Alternatives rejected

- **RS256 immediately.** Pays full key-management cost for a capability nothing uses yet.
- **One secret for both token types.** Removes the type-confusion defence for no gain.
- **Opaque access tokens with a session lookup.** We already verify the session on every
  request, so this would mainly add a second database read per request; the JWT gives cheap
  integrity plus explicit expiry. Reconsider if token size ever matters.
