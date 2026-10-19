import { Inject, Injectable } from '@nestjs/common';
import { AppError, newId, tenantContext, withPlatformScope } from '@leados/shared';
import type { Logger } from 'pino';
import { AuditService } from '../../infra/audit/audit.service.js';
import { DbService } from '../../infra/db/db.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { WhatsAppCloudAdapter } from '../integrations/adapters/whatsapp-cloud.adapter.js';
import { IntegrationsService } from '../integrations/integrations.service.js';

/**
 * Connecting a WABA, and the numbers on it (`FR-WA-2`).
 *
 * The connection — the credential, the health, the reconnect prompt — is the integration
 * framework's, and this is the shape WhatsApp adds to it: a business account, and the numbers a
 * conversation can belong to.
 *
 * **The numbers are discovered, never typed.** `phone_number_id` is what resolves an inbound
 * delivery to a workspace, so a number somebody mistyped would silently receive nothing, and one
 * copied from another business's account would be refused by the global unique — the right refusal
 * and a baffling one to read on a form. Asking Meta is also the only way to get the quality rating
 * and the send tier, which are the two things `FR-WA-2` means by "connection health".
 */
@Injectable()
export class WhatsAppAccountsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly integrations: IntegrationsService,
    private readonly adapter: WhatsAppCloudAdapter,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** The accounts this workspace has, with their numbers. */
  async list() {
    const rows = await this.db.client.whatsAppAccount.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        numbers: {
          orderBy: { displayPhoneE164: 'asc' },
          select: {
            id: true,
            phoneNumberId: true,
            displayPhoneE164: true,
            verifiedName: true,
            qualityRating: true,
            messagingLimitTier: true,
            isActive: true,
            defaultAgentUserId: true,
          },
        },
      },
    });
    const items = rows.map((row) => ({
      id: row.id,
      connectionId: row.integrationConnectionId,
      wabaId: row.wabaId,
      businessName: row.businessName,
      status: row.status,
      verifiedAt: row.verifiedAt,
      lastError: row.lastError,
      numbers: row.numbers,
    }));
    return {
      items,
      pagination: { limit: items.length, nextCursor: null, hasMore: false, total: items.length },
      meta: { numbers: items.reduce((total, account) => total + account.numbers.length, 0) },
    };
  }

  /**
   * Verifies a connection's WABA and stores it with its numbers.
   *
   * Idempotent on `(organization_id, waba_id)`, so pressing it again after adding a number in Meta
   * is how a workspace refreshes the list — which is also what makes it the honest answer to
   * "where did my new number go". A number that has disappeared from Meta is marked **inactive**
   * rather than deleted: a conversation references it, and the history of what arrived at a number
   * the business no longer has is still the history.
   */
  async connect(connectionId: string) {
    const principal = tenantContext.require('whatsapp.connect');
    const connection = await this.integrations.openForInbound('whatsapp_cloud', connectionId);
    const wabaId = typeof connection.settings['wabaId'] === 'string' ? connection.settings['wabaId'] : '';
    if (wabaId === '') {
      throw AppError.businessRule(
        'That connection has no WhatsApp Business Account id. Edit it and add one, then connect again.',
      );
    }

    const context = {
      connectionId: connection.connectionId,
      organizationId: connection.organizationId,
      secrets: connection.secrets,
      settings: connection.settings,
      externalAccountId: connection.externalAccountId,
    };
    // Asked before anything is written: a token that cannot read the account is a connection that
    // would receive nothing, and storing it would put a green row on the screen for it.
    const probe = await this.adapter.probe(context);
    if (probe.outcome === 'unauthorized') {
      throw new AppError(
        'INVALID_API_KEY',
        `Meta refused that token: ${String(probe.detail['message'] ?? 'the credential was rejected')}`,
        401,
      );
    }
    const numbers = await this.adapter.listNumbers(context);
    if (numbers.length === 0) {
      throw AppError.businessRule(
        'That WhatsApp Business Account has no phone numbers yet. Add one in Meta Business Suite, then connect again.',
      );
    }

    // Who owns each of these numbers already, read **across tenants** — because that is the only
    // way to see the row that would collide. `phone_number_id` is globally unique by design (it is
    // the only thing an inbound delivery carries), so a number another workspace has connected is
    // invisible to the scoped client and the insert below would come back as a raw unique
    // violation: a 500 on a mistake that has a sentence somebody can act on.
    const owners = await withPlatformScope(
      'whatsapp: a phone number can only receive into one workspace',
      async () =>
        this.db.client.whatsAppNumber.findMany({
          where: { phoneNumberId: { in: numbers.map((number) => number.phoneNumberId) } },
          select: { id: true, phoneNumberId: true, organizationId: true },
        }),
    );
    const taken = owners.find((owner) => owner.organizationId !== connection.organizationId);
    if (taken) {
      const number = numbers.find((entry) => entry.phoneNumberId === taken.phoneNumberId);
      throw AppError.businessRule(
        `The number ${number?.displayPhoneE164 ?? taken.phoneNumberId} is already connected to another workspace. A WhatsApp number can only receive into one.`,
      );
    }

    const existing = await this.db.client.whatsAppAccount.findFirst({ where: { wabaId } });
    const accountId = existing?.id ?? newId();
    const businessName =
      typeof probe.detail['businessName'] === 'string' ? probe.detail['businessName'] : null;

    await this.db.client.$transaction(async (tx) => {
      if (existing) {
        await tx.whatsAppAccount.update({
          where: { id: accountId },
          data: {
            integrationConnectionId: connection.connectionId,
            businessName,
            status: 'connected',
            verifiedAt: new Date(),
            lastError: null,
          },
        });
      } else {
        await tx.whatsAppAccount.create({
          data: {
            id: accountId,
            organizationId: connection.organizationId,
            integrationConnectionId: connection.connectionId,
            wabaId,
            businessName,
            status: 'connected',
            verifiedAt: new Date(),
          },
        });
      }

      for (const number of numbers) {
        // From the platform-scoped read above: this workspace's own row, if it has one.
        const known = owners.find((owner) => owner.phoneNumberId === number.phoneNumberId);
        if (known) {
          await tx.whatsAppNumber.update({
            where: { id: known.id },
            data: {
              accountId,
              displayPhoneE164: number.displayPhoneE164,
              verifiedName: number.verifiedName,
              qualityRating: number.qualityRating,
              messagingLimitTier: number.messagingLimitTier,
              isActive: true,
            },
          });
          continue;
        }
        await tx.whatsAppNumber.create({
          data: {
            id: newId(),
            organizationId: connection.organizationId,
            accountId,
            phoneNumberId: number.phoneNumberId,
            displayPhoneE164: number.displayPhoneE164,
            verifiedName: number.verifiedName,
            qualityRating: number.qualityRating,
            messagingLimitTier: number.messagingLimitTier,
          },
        });
      }

      // A number Meta no longer lists is switched off, not deleted: a conversation references it.
      const live = numbers.map((number) => number.phoneNumberId);
      await tx.whatsAppNumber.updateMany({
        where: { accountId, phoneNumberId: { notIn: live } },
        data: { isActive: false },
      });

      await this.audit.recordInTransaction(tx, {
        action: 'whatsapp_account.connected',
        resourceType: 'whatsapp_account',
        resourceId: accountId,
        // The account and the numbers, never the token: an audit log is read by more people.
        after: { wabaId, businessName, numbers: live },
      });
    });

    this.logger.info(
      { organizationId: principal.organizationId, wabaId, numbers: numbers.length },
      'a whatsapp business account was connected',
    );
    return this.findOne(accountId);
  }

  async findOne(id: string) {
    const row = (await this.list()).items.find((account) => account.id === id);
    if (!row) throw AppError.notFound('WhatsApp account');
    return row;
  }

  /** Who picks up a conversation on this number when nothing else decides. */
  async setDefaultAgent(numberId: string, userId: string | null) {
    const row = await this.db.client.whatsAppNumber.findFirst({ where: { id: numberId } });
    if (!row) throw AppError.notFound('Number');
    if (userId !== null) {
      // The composite FK would refuse a stranger anyway; this says who it was.
      const member = await this.db.client.membership.findFirst({
        where: { userId, deletedAt: null, status: 'active' },
        select: { userId: true },
      });
      if (!member) {
        throw AppError.businessRule('That person is not an active member of this workspace.');
      }
    }
    await this.db.client.whatsAppNumber.update({
      where: { id: numberId },
      data: { defaultAgentUserId: userId },
    });
    return this.findOne(row.accountId);
  }
}
