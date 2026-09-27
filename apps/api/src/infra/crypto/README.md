# infra/crypto

AES-256-GCM for the secrets a tenant entrusts to us — integration credentials, TOTP secrets — with
the key supplied by the environment and never written anywhere.

**Every ciphertext is bound to what it is for.** `encrypt(plaintext, aad)` requires additional
authenticated data, and decryption with different AAD fails rather than returning plaintext. That is
what stops a TOTP secret lifted from one row decrypting as another's, or an integration credential
being replayed against a different organization: the AAD carries the organization id and the purpose,
so a moved ciphertext is a decryption failure, not a silent success.

The stored form carries a format version (`v1`), so a key rotation or a move to envelope encryption
with per-organization data keys (the Phase 4 extension) is a background re-encrypt rather than a
breaking change. A decryption failure reports a deliberately vague reason: which part failed is
information an attacker would use.

**Never log a decrypted value, and never return one to a client.** The routes that use this service
return "configured"/"not configured", never the credential (rule 10, `docs/security.md` §7).
