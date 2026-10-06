import { Injectable } from '@nestjs/common';
import {
  AppError,
  findIndustryTemplate,
  summariseIndustryTemplate,
  tenantContext,
  withPlatformScope,
} from '@leados/shared';
import { applyIndustryTemplate } from '@leados/db';
import { DbService } from '../../infra/db/db.service.js';
import { AuditService } from '../../infra/audit/audit.service.js';
import { OutboxService } from '../../infra/outbox/outbox.service.js';
import { PrincipalService } from '../auth/application/principal.service.js';
import { FieldRegistryService } from '../custom-fields/field-registry.service.js';

/**
 * Choosing an industry during onboarding (`FR-ONB-2`).
 *
 * The template catalogue is platform reference data, so reading it opts into platform scope
 * explicitly — a tenant route may not read an unscoped table by accident, and this one says why.
 * Applying a template writes only into the caller's own workspace.
 *
 * **The refusal is the design.** A template *replaces* a workspace's statuses, stages, sources, lost
 * reasons, tags and custom fields; merging would leave twelve statuses, two of which mean the same
 * thing. Replacing is only safe while the workspace has no records to lose, so this service refuses
 * once there is a lead, a customer, a deal or a quotation — and says what to do instead. That window
 * is exactly onboarding, which is when somebody picks an industry.
 */
@Injectable()
export class IndustryTemplatesService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly principals: PrincipalService,
    private readonly fields: FieldRegistryService,
  ) {}

  /**
   * The catalogue, with the counts a picker needs to show what changes.
   *
   * Returned as `{ items, pagination }` because that is the shape the response envelope unwraps
   * into `data` plus `meta.pagination`. A bare `{ items }` is passed through as the whole `data`
   * object, which looks right in a test that only checks the status code and wrong in every client.
   */
  async list() {
    const organizationId = tenantContext.organizationId('industryTemplates.list');
    const [rows, organization] = await Promise.all([
      withPlatformScope('onboarding: read the industry template catalogue', async () =>
        this.db.client.industryTemplate.findMany({
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' },
          select: { key: true },
        }),
      ),
      this.db.client.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { industryTemplateKey: true },
      }),
    ]);

    // The summary comes from the code catalogue rather than from the row's JSON: the row exists so
    // an organization can reference a template, not as a second definition of one.
    const items = rows
      .map((row) => findIndustryTemplate(row.key))
      .filter((template): template is NonNullable<typeof template> => template !== undefined)
      .map((template) => ({
        ...summariseIndustryTemplate(template),
        applied: organization.industryTemplateKey === template.key,
      }));

    return {
      items,
      pagination: { limit: items.length, nextCursor: null, hasMore: false, total: items.length },
    };
  }

  async apply(key: string) {
    const principal = tenantContext.require('industryTemplates.apply');
    const organizationId = principal.organizationId;

    const exists = await withPlatformScope('onboarding: check the template exists', async () =>
      this.db.client.industryTemplate.findFirst({ where: { key, isActive: true } }),
    );
    if (!exists) throw AppError.notFound('Industry template');

    await this.assertWorkspaceIsUntouched();

    const applied = await this.db.client.$transaction(async (tx) => {
      const result = await applyIndustryTemplate(tx, organizationId, key);
      await this.audit.recordInTransaction(tx, {
        action: 'organization.industry_template_applied',
        resourceType: 'organization',
        resourceId: organizationId,
        after: { ...result },
      });
      await this.outbox.emit(tx, [
        {
          name: 'onboarding.industry_template_applied',
          aggregateType: 'organization',
          aggregateId: organizationId,
          payload: { key: result.key, name: result.name },
        },
      ]);
      return result;
    });

    /**
     * The custom-field registry and the principal's grants are both cached, and a template rewrites
     * the first of them wholesale. Without this the lead form keeps offering the previous industry's
     * questions for five minutes — which looks exactly like the template not having been applied.
     */
    await this.fields.invalidateForOrganization(organizationId);
    await this.principals.invalidateOrganization(organizationId);

    return applied;
  }

  /**
   * Refuses once the workspace has anything to lose, naming what it found.
   *
   * Counting four tables rather than one, because each is a different way a workspace stops being
   * empty — and a refusal that says "you already have 3 leads" is one somebody can act on, where
   * "cannot apply template" is not.
   */
  private async assertWorkspaceIsUntouched(): Promise<void> {
    const [leads, customers, deals, quotations] = await Promise.all([
      this.db.client.lead.count(),
      this.db.client.customer.count(),
      this.db.client.deal.count(),
      this.db.client.quotation.count(),
    ]);
    const found = [
      leads > 0 ? `${leads} lead${leads === 1 ? '' : 's'}` : null,
      customers > 0 ? `${customers} customer${customers === 1 ? '' : 's'}` : null,
      deals > 0 ? `${deals} deal${deals === 1 ? '' : 's'}` : null,
      quotations > 0 ? `${quotations} quotation${quotations === 1 ? '' : 's'}` : null,
    ].filter((part): part is string => part !== null);

    if (found.length > 0) {
      throw AppError.businessRule(
        `This workspace already has ${found.join(', ')}. An industry template replaces your statuses, stages, sources and fields, so it can only be applied to a workspace with no records yet — add what you need in Settings instead.`,
      );
    }
  }
}
