# ADR-0008 — Official Meta WhatsApp Cloud API only

**Status:** Accepted · **Date:** 2026-09-27 · Relates to `FR-WA-1`, `FR-WA-10`

## Context
Unofficial WhatsApp automation (web-session scraping, unofficial libraries) is cheaper per message and
avoids template approval. It is also a terms-of-service violation that gets numbers banned, and it
would make our tenants' primary communication channel a liability.

## Decision
Only the official Meta WhatsApp Business Platform (Cloud API). Templates for out-of-window messaging,
the 24-hour service window enforced in code, consent checked at send time, opt-out keywords honoured
immediately, per-number rate limiting aligned to the messaging tier. No unofficial path is built,
documented or supported.

## Consequences
**Positive:** tenants' numbers stay safe; message status and delivery are reliable; the feature is
sellable to serious businesses; policy compliance is enforceable in code.
**Negative:** per-message cost; template approval latency; free-form replies restricted to the 24-hour
window; some prospects who want mass unsolicited messaging will not buy — an acceptable and deliberate
trade.

## Alternatives rejected
- **Unofficial automation:** ban risk transferred to customers, reputational and legal exposure.
- **Hybrid (official + unofficial fallback):** the worst of both; a single unofficial send can ban the
  number the official integration depends on.

## Note
The `MessagingProvider` abstraction allows an additional *official* BSP later without touching domain
code; it is not a seam for unofficial providers.
