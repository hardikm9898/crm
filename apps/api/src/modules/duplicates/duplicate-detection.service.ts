import { Injectable } from '@nestjs/common';
import {
  confidenceFor,
  matchKey,
  matchRule,
  newId,
  tenantContext,
  type MatchOn,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import type { TransactionClient } from '../../infra/outbox/outbox.service.js';

/**
 * Deciding whether a capture is somebody we already know (`FR-DUP-1`, `FR-DUP-2`).
 *
 * The shape of the problem: a lead arrives, and before it is created we must ask "is this the same
 * person as one of the last 365 days' leads?" — cheaply, on the write path, without scanning the
 * table. So detection is two stages:
 *
 *  1. **A narrow candidate query.** Only the indexed identifier columns (`phone_e164`,
 *     `whatsapp_e164`, `lower(email)`) plus the lookback window. Every valid rule must include one of
 *     those in each of its field sets — `validateMatchOn` refuses a rule without one — which is what
 *     makes this stage possible at all.
 *  2. **Exact comparison in memory**, using the same pure matcher the rule tester uses, so the
 *     answer a manager sees in the tester is the answer the write path gave.
 *
 * Rules are evaluated in priority order and **the first that matches decides**. That is a deliberate
 * choice over "strongest match wins": a business that puts `reject` above `attach_to_existing` is
 * saying something, and picking the higher-confidence rule instead would quietly overrule them.
 */

export interface DuplicateCandidate {
  readonly leadId: string;
  readonly fullName: string;
  readonly phoneE164: string | null;
  readonly email: string | null;
  readonly createdAt: Date;
  readonly assignedUserId: string | null;
  readonly matchedFields: readonly string[];
  readonly confidence: number;
  readonly ruleId: string;
  readonly ruleName: string;
  readonly action: string;
}

/** The comparable fields of an incoming capture. */
export interface DuplicateSubject {
  readonly phoneE164?: string | null;
  readonly whatsappE164?: string | null;
  readonly email?: string | null;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly fullName?: string | null;
  readonly company?: string | null;
  readonly city?: string | null;
  readonly postalCode?: string | null;
}

@Injectable()
export class DuplicateDetectionService {
  constructor(private readonly db: DbService) {}

  /**
   * The first rule that matches, or null.
   *
   * Returns *all* matches for the deciding rule so a `create_and_link` outcome can record every pair
   * a manager should look at, not just the first one found.
   */
  async detect(subject: DuplicateSubject): Promise<readonly DuplicateCandidate[]> {
    const rules = await this.db.client.duplicateRule.findMany({
      where: { isActive: true, deletedAt: null },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    });
    if (rules.length === 0) return [];

    // One candidate query for the widest lookback across all rules, reused by each rule. A separate
    // query per rule would be the obvious implementation and would cost a table round-trip per rule
    // on every lead creation.
    const widestLookback = Math.max(...rules.map((rule) => rule.lookbackDays));
    const candidates = await this.candidatesFor(subject, widestLookback);
    if (candidates.length === 0) return [];

    const now = Date.now();
    for (const rule of rules) {
      const cutoff = now - rule.lookbackDays * 86_400_000;
      const matched: DuplicateCandidate[] = [];

      for (const candidate of candidates) {
        if (candidate.createdAt.getTime() < cutoff) continue;
        const fields = matchRule(
          rule.matchOn as MatchOn,
          subject as Record<string, unknown>,
          candidate,
        );
        if (!fields) continue;
        matched.push({
          leadId: candidate.id,
          fullName: candidate.fullName,
          phoneE164: candidate.phoneE164,
          email: candidate.email,
          createdAt: candidate.createdAt,
          assignedUserId: candidate.assignedUserId,
          matchedFields: fields,
          confidence: confidenceFor(fields),
          ruleId: rule.id,
          ruleName: rule.name,
          action: rule.action,
        });
      }

      if (matched.length > 0) {
        // Highest confidence first: `attach_to_existing` attaches to the best match, and a triage
        // queue is only useful in that order.
        return matched.sort((left, right) => right.confidence - left.confidence);
      }
    }

    return [];
  }

  /**
   * Candidate rows, fetched by identifier only.
   *
   * Deliberately narrow. Fetching by name or city would be a scan; every rule is guaranteed to carry
   * an identifier in each field set, so a lead that shares no identifier with the capture cannot be
   * a match under any valid rule.
   */
  private async candidatesFor(subject: DuplicateSubject, lookbackDays: number) {
    const phone = matchKey('phoneE164', subject.phoneE164);
    const whatsapp = matchKey('whatsappE164', subject.whatsappE164);
    const email = matchKey('email', subject.email);

    const identifiers: Record<string, unknown>[] = [];
    // A capture's phone may be somebody else's WhatsApp number and vice versa, so both columns are
    // checked against both values — otherwise "same person, different channel" slips through.
    if (phone) identifiers.push({ phoneE164: phone }, { whatsappE164: phone });
    if (whatsapp) identifiers.push({ whatsappE164: whatsapp }, { phoneE164: whatsapp });
    if (email) identifiers.push({ email: { equals: email, mode: 'insensitive' as const } });
    if (identifiers.length === 0) return [];

    const since = new Date(Date.now() - lookbackDays * 86_400_000);
    return this.db.client.lead.findMany({
      where: {
        deletedAt: null,
        // A lead already absorbed by a merge is not a candidate: attaching to it would put the
        // touchpoint on a record nobody looks at.
        mergedIntoId: null,
        createdAt: { gte: since },
        OR: identifiers,
      },
      select: {
        id: true,
        fullName: true,
        firstName: true,
        lastName: true,
        company: true,
        city: true,
        postalCode: true,
        phoneE164: true,
        whatsappE164: true,
        email: true,
        assignedUserId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      // A capture matching hundreds of existing leads means the rule is wrong, not that we should
      // compare them all. The cap keeps a misconfiguration from becoming a slow write path.
      take: 50,
    });
  }

  /**
   * Records the detected pairs. Idempotent on the pair, so re-detection updates rather than piles up.
   *
   * `leadId` is the existing lead and `duplicateLeadId` the newer one, which is why the arguments are
   * in that order even though the caller has just created the second.
   */
  async recordPairs(
    tx: TransactionClient,
    newLeadId: string,
    candidates: readonly DuplicateCandidate[],
  ): Promise<void> {
    if (candidates.length === 0) return;
    const organizationId = tenantContext.organizationId('duplicates.recordPairs');

    for (const candidate of candidates) {
      await tx.leadDuplicate.upsert({
        where: {
          organizationId_leadId_duplicateLeadId: {
            organizationId,
            leadId: candidate.leadId,
            duplicateLeadId: newLeadId,
          },
        },
        create: {
          id: newId(),
          organizationId,
          leadId: candidate.leadId,
          duplicateLeadId: newLeadId,
          ruleId: candidate.ruleId,
          matchFields: { fields: candidate.matchedFields } as never,
          confidence: candidate.confidence,
          status: 'open',
        },
        // A pair already dismissed stays dismissed: re-detecting it must not reopen a decision a
        // person has already made.
        update: {
          ruleId: candidate.ruleId,
          matchFields: { fields: candidate.matchedFields } as never,
          confidence: candidate.confidence,
        },
      });
    }
  }
}
