import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  isTemplateVariableSource,
  newId,
  renderTemplate,
  templateBlockedReason,
  templateProblems,
  tenantContext,
  type TemplateComponents,
  type WhatsAppTemplateStatus,
} from '@leados/shared';
import type { Logger } from 'pino';
import { AuditService } from '../../infra/audit/audit.service.js';
import { DbService } from '../../infra/db/db.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { WhatsAppCloudAdapter } from '../integrations/adapters/whatsapp-cloud.adapter.js';
import { IntegrationsService } from '../integrations/integrations.service.js';
import type { CreateTemplateInput, UpdateTemplateInput } from './whatsapp.dto.js';

/**
 * WhatsApp message templates (`FR-WA-5`).
 *
 * Four decisions:
 *
 *  * **Meta's word is the one that counts.** A template's status is reconciled by a sweep and by
 *    the sync button, never remembered from our own last action: Meta approves, rejects, pauses and
 *    disables on its own schedule, and a product that trusted its own copy would offer a button
 *    that fails in front of a customer.
 *  * **A draft is editable; anything Meta has seen is not.** Meta has no "edit" for a submitted
 *    template — the way to change one is to submit it again — so an edit after submission would be
 *    a local change that silently disagrees with what is actually sent.
 *  * **The variable map is validated when it is saved, not when it is used.** A map naming a field
 *    nothing can fill is a template that looks complete and refuses at send time, in front of
 *    somebody who is mid-conversation.
 *  * **The preview resolves against a real lead.** A preview filled with `{{1}}` proves nothing;
 *    the point is to see the sentence this person will read.
 */
@Injectable()
export class WhatsAppTemplatesService {
  constructor(
    private readonly db: DbService,
    private readonly integrations: IntegrationsService,
    private readonly adapter: WhatsAppCloudAdapter,
    private readonly audit: AuditService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async list(query: { status?: string; accountId?: string; limit: number }) {
    const where: Record<string, unknown> = {
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.accountId ? { accountId: query.accountId } : {}),
    };
    const [rows, total, approved] = await Promise.all([
      this.db.client.whatsAppTemplate.findMany({
        where,
        orderBy: [{ status: 'asc' }, { name: 'asc' }],
        take: query.limit,
      }),
      this.db.client.whatsAppTemplate.count({ where }),
      // Over the whole set rather than the page: "how many can I actually send" is the figure a
      // composer's picker is about.
      this.db.client.whatsAppTemplate.count({ where: { deletedAt: null, status: 'approved' } }),
    ]);
    return {
      items: rows.map((row) => this.present(row)),
      pagination: { limit: query.limit, nextCursor: null, hasMore: false, total },
      meta: { approved },
    };
  }

  async findOne(id: string) {
    const row = await this.db.client.whatsAppTemplate.findFirst({ where: { id, deletedAt: null } });
    if (!row) throw AppError.notFound('Template');
    return this.present(row);
  }

  /** A draft, validated against Meta's own rules before anybody waits a day to be refused. */
  async create(input: CreateTemplateInput) {
    const principal = tenantContext.require('whatsapp.templates.create');
    const account = await this.db.client.whatsAppAccount.findFirst({
      where: { id: input.accountId },
      select: { id: true },
    });
    if (!account) throw AppError.notFound('Account');

    this.refuseProblems(input);
    const existing = await this.db.client.whatsAppTemplate.findFirst({
      where: { accountId: input.accountId, name: input.name, language: input.language },
      select: { id: true, deletedAt: true },
    });
    if (existing && existing.deletedAt === null) {
      throw AppError.businessRule(
        `A template called ${input.name} in ${input.language} already exists on this account.`,
      );
    }

    const id = newId();
    await this.db.client.whatsAppTemplate.create({
      data: {
        id,
        organizationId: principal.organizationId,
        accountId: input.accountId,
        name: input.name,
        language: input.language,
        category: input.category,
        status: 'draft',
        components: input.components as never,
        variableMap: (input.variableMap ?? {}) as never,
        createdById: principal.actorId,
      },
    });
    await this.audit.record({
      action: 'whatsapp_template.created',
      resourceType: 'whatsapp_template',
      resourceId: id,
      after: { name: input.name, language: input.language, category: input.category },
    });
    return this.findOne(id);
  }

  /**
   * Edits a draft.
   *
   * Refused once Meta has seen it, which is not laxity: Meta has no edit, so the honest options are
   * "submit it again as a new version" or "a local copy that disagrees with what is sent", and the
   * second is the kind of quiet divergence this codebase keeps paying for.
   */
  async update(id: string, input: UpdateTemplateInput) {
    const row = await this.db.client.whatsAppTemplate.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        name: true,
        language: true,
        category: true,
        status: true,
        components: true,
        variableMap: true,
      },
    });
    if (!row) throw AppError.notFound('Template');
    if (row.status !== 'draft' && row.status !== 'rejected') {
      throw AppError.businessRule(
        'WhatsApp has this template already, and it cannot be edited there. Create a new one with the wording you want.',
      );
    }

    const merged = {
      name: input.name ?? row.name,
      language: input.language ?? row.language,
      category: input.category ?? row.category,
      components: (input.components ?? row.components) as unknown as TemplateComponents,
      variableMap: (input.variableMap ?? row.variableMap) as Record<string, string>,
    };
    this.refuseProblems(merged);

    await this.db.client.whatsAppTemplate.update({
      where: { id },
      data: {
        name: merged.name,
        language: merged.language,
        category: merged.category as never,
        components: merged.components as never,
        variableMap: merged.variableMap as never,
      },
    });
    return this.findOne(id);
  }

  /** Archives a template. Soft, because its messages reference it and their history has to read. */
  async remove(id: string) {
    const row = await this.db.client.whatsAppTemplate.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!row) throw AppError.notFound('Template');
    await this.db.client.whatsAppTemplate.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.audit.record({
      action: 'whatsapp_template.archived',
      resourceType: 'whatsapp_template',
      resourceId: id,
    });
    return { id, archived: true };
  }

  /**
   * Submits a draft to Meta for review.
   *
   * The examples Meta requires come from the variable map's own labels rather than from a lead: a
   * reviewer is reading the wording, and sending them a real customer's name would put somebody's
   * personal data in front of a stranger for no reason at all.
   */
  async submit(id: string) {
    const row = await this.db.client.whatsAppTemplate.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        accountId: true,
        name: true,
        language: true,
        category: true,
        status: true,
        components: true,
        variableMap: true,
        account: { select: { integrationConnectionId: true } },
      },
    });
    if (!row) throw AppError.notFound('Template');
    if (row.status === 'pending' || row.status === 'approved') {
      throw AppError.businessRule(
        row.status === 'pending'
          ? 'WhatsApp is already reviewing this template.'
          : 'WhatsApp has already approved this template.',
      );
    }

    const components = row.components as unknown as TemplateComponents;
    const variableMap = row.variableMap as Record<string, string>;
    this.refuseProblems({
      name: row.name,
      language: row.language,
      category: row.category,
      components,
      variableMap,
    });

    const context = await this.contextFor(row.account.integrationConnectionId);
    const submitted = await this.adapter.submitTemplate(context, {
      name: row.name,
      language: row.language,
      category: row.category,
      components,
      examples: exampleValues(components, variableMap),
    });

    await this.db.client.whatsAppTemplate.update({
      where: { id },
      data: {
        providerTemplateId: submitted.providerTemplateId,
        // Meta answers `PENDING` for a new template and occasionally `APPROVED` straight away for
        // a utility one it recognises. Its word, not ours.
        status: mapStatus(submitted.status),
        submittedAt: new Date(),
        syncedAt: new Date(),
        // A resubmission clears the reason the last one was refused for; the new verdict is what
        // matters now, and a stale rejection beside a pending template reads as a refusal.
        rejectionReason: null,
      },
    });
    await this.audit.record({
      action: 'whatsapp_template.submitted',
      resourceType: 'whatsapp_template',
      resourceId: id,
      after: { providerTemplateId: submitted.providerTemplateId, status: submitted.status },
    });
    return this.findOne(id);
  }

  /**
   * Reconciles every template on an account against Meta (`FR-WA-5`).
   *
   * Also **adopts** templates that exist at Meta and not here, which is the common case for a
   * workspace that was using WhatsApp before this product: a template they can send is one the
   * picker should offer, and refusing to show it because we did not create it would be a product
   * pretending the account is empty.
   */
  async sync(accountId: string) {
    const account = await this.db.client.whatsAppAccount.findFirst({
      where: { id: accountId },
      select: { id: true, integrationConnectionId: true },
    });
    if (!account) throw AppError.notFound('Account');
    const context = await this.contextFor(account.integrationConnectionId);
    const remote = await this.adapter.listTemplates(context);

    const local = await this.db.client.whatsAppTemplate.findMany({
      where: { accountId, deletedAt: null },
      select: { id: true, name: true, language: true, status: true, providerTemplateId: true },
    });
    const byKey = new Map(local.map((row) => [`${row.name}:${row.language}`, row]));
    let updated = 0;
    let adopted = 0;

    const organizationId = tenantContext.organizationId('whatsapp.templates.sync');
    for (const entry of remote) {
      const key = `${entry.name}:${entry.language}`;
      const known = byKey.get(key);
      const status = mapStatus(entry.status);
      if (known) {
        if (known.status !== status || known.providerTemplateId !== entry.providerTemplateId) {
          updated += 1;
        }
        await this.db.client.whatsAppTemplate.update({
          where: { id: known.id },
          data: {
            status,
            providerTemplateId: entry.providerTemplateId,
            rejectionReason: status === 'rejected' ? (entry.rejectedReason ?? 'WhatsApp did not say why.') : null,
            syncedAt: new Date(),
          },
        });
        continue;
      }
      // Adopted: its wording lives at Meta, so the body is unknown until somebody opens it there.
      // Stored as a template with an empty body and no variables, which is honest — the picker can
      // send it, and nothing here pretends to know what it says.
      await this.db.client.whatsAppTemplate.create({
        data: {
          id: newId(),
          organizationId,
          accountId,
          name: entry.name,
          language: entry.language,
          category: (entry.category === 'marketing' || entry.category === 'authentication'
            ? entry.category
            : 'utility') as never,
          status,
          providerTemplateId: entry.providerTemplateId,
          rejectionReason: status === 'rejected' ? (entry.rejectedReason ?? 'WhatsApp did not say why.') : null,
          components: { body: '' } as never,
          variableMap: {} as never,
          syncedAt: new Date(),
        },
      });
      adopted += 1;
    }

    this.logger.info({ accountId, remote: remote.length, updated, adopted }, 'whatsapp templates synced');
    return { checked: remote.length, updated, adopted };
  }

  /**
   * What this template will say to this person.
   *
   * The whole point of `FR-WA-5`'s "live preview": a template reading "Hi {{1}}" proves nothing,
   * and the variable nobody can fill is only visible once a real record is behind it.
   */
  async preview(id: string, leadId: string | null) {
    const row = await this.db.client.whatsAppTemplate.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, components: true, variableMap: true, status: true },
    });
    if (!row) throw AppError.notFound('Template');
    const resolved = await this.resolveVariables(row.variableMap as Record<string, string>, leadId, {});
    const rendered = renderTemplate(row.components as unknown as TemplateComponents, resolved);
    return {
      text: rendered.text,
      values: rendered.values,
      missing: rendered.missing,
      blockedReason: templateBlockedReason(row.status as WhatsAppTemplateStatus),
    };
  }

  /**
   * The values each variable resolves to, for one lead.
   *
   * `overrides` wins, because the composer lets an agent type a value for something the record does
   * not have — which is the difference between a template that can be sent and one that is stuck.
   */
  async resolveVariables(
    variableMap: Record<string, string>,
    leadId: string | null,
    overrides: Readonly<Record<string, string>>,
  ): Promise<Record<string, string | null>> {
    const needsLead = Object.values(variableMap).some((source) => source.startsWith('lead.') || source.startsWith('custom.'));
    const lead =
      needsLead && leadId !== null
        ? await this.db.client.lead.findFirst({
            where: { id: leadId },
            select: {
              fullName: true,
              firstName: true,
              phoneE164: true,
              email: true,
              city: true,
              customValues: true,
              status: { select: { name: true } },
              assignee: { select: { user: { select: { name: true } } } },
            },
          })
        : null;
    const organization = Object.values(variableMap).includes('organization.name')
      ? await this.db.client.organization.findFirst({
          where: { id: tenantContext.organizationId('whatsapp.templates.resolve') },
          select: { name: true },
        })
      : null;

    const resolved: Record<string, string | null> = {};
    for (const [index, source] of Object.entries(variableMap)) {
      const override = overrides[index];
      if (override !== undefined && override.trim() !== '') {
        resolved[index] = override.trim();
        continue;
      }
      resolved[index] = readSource(source, lead, organization?.name ?? null);
    }
    // A variable with no map entry at all can still be typed in by the agent.
    for (const [index, value] of Object.entries(overrides)) {
      if (resolved[index] === undefined && value.trim() !== '') resolved[index] = value.trim();
    }
    return resolved;
  }

  /** Every problem at once, as field errors against the form's own boxes. */
  private refuseProblems(input: {
    name: string;
    language: string;
    category: string;
    components: TemplateComponents;
    variableMap?: Record<string, string>;
  }): void {
    const problems = templateProblems(input);
    if (problems.length > 0) {
      throw AppError.validation('That template cannot be saved as it is', problems);
    }
    for (const [index, source] of Object.entries(input.variableMap ?? {})) {
      if (!isTemplateVariableSource(source)) {
        throw AppError.validation('That template cannot be saved as it is', [
          {
            field: `variableMap.${index}`,
            code: 'VARIABLE_SOURCE_UNKNOWN',
            message: `Nothing in this workspace is called "${source}".`,
          },
        ]);
      }
    }
  }

  /**
   * The credential, opened inside this workspace's own context.
   *
   * Not `openForInbound`: that reads across tenants because an inbound request has no principal.
   * This one has one, so the scoped read is both correct and the stronger guarantee.
   */
  private async contextFor(connectionId: string) {
    const connection = await this.integrations.openForSending('whatsapp_cloud', connectionId);
    return {
      connectionId: connection.connectionId,
      organizationId: connection.organizationId,
      secrets: connection.secrets,
      settings: connection.settings,
      externalAccountId: connection.externalAccountId,
    };
  }

  private present(row: {
    id: string;
    accountId: string;
    name: string;
    language: string;
    category: string;
    status: string;
    rejectionReason: string | null;
    components: unknown;
    variableMap: unknown;
    providerTemplateId: string | null;
    submittedAt: Date | null;
    syncedAt: Date | null;
    createdAt: Date;
  }) {
    const components = row.components as TemplateComponents;
    return {
      id: row.id,
      accountId: row.accountId,
      name: row.name,
      language: row.language,
      category: row.category,
      status: row.status,
      rejectionReason: row.rejectionReason,
      components,
      variableMap: row.variableMap as Record<string, string>,
      providerTemplateId: row.providerTemplateId,
      submittedAt: row.submittedAt,
      syncedAt: row.syncedAt,
      createdAt: row.createdAt,
      // Both, for the same reason the window is: one greys a button, the other is read.
      sendable: row.status === 'approved',
      blockedReason: templateBlockedReason(row.status as WhatsAppTemplateStatus),
      preview: renderTemplate(components, {}).text,
    };
  }
}

/** Meta's vocabulary, mapped onto ours. Anything unrecognised is `pending`, never `approved`. */
function mapStatus(status: string): WhatsAppTemplateStatus {
  switch (status.toLowerCase()) {
    case 'approved':
      return 'approved';
    case 'rejected':
      return 'rejected';
    case 'paused':
      return 'paused';
    case 'disabled':
    case 'deleted':
      return 'disabled';
    default:
      // `in_appeal`, `pending_deletion`, a word Meta adds next year: pending is the safe reading,
      // because the only status that lets a message be sent is `approved`.
      return 'pending';
  }
}

/** The sample values Meta's reviewer sees. The variable's own label, never a customer's data. */
function exampleValues(
  components: TemplateComponents,
  variableMap: Record<string, string>,
): string[] {
  const indexes = [...components.body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((match) => Number(match[1]));
  const unique = [...new Set(indexes)].sort((left, right) => left - right);
  return unique.map((index) => {
    const source = variableMap[String(index)] ?? '';
    if (source.startsWith('literal:')) return source.slice('literal:'.length).trim();
    if (source.startsWith('custom.')) return source.slice('custom.'.length);
    return source.split('.').pop() ?? 'example';
  });
}

/** One variable's value, from the lead, the workspace, or the literal somebody typed. */
function readSource(
  source: string,
  lead: {
    fullName: string;
    firstName: string | null;
    phoneE164: string | null;
    email: string | null;
    city: string | null;
    customValues: unknown;
    status: { name: string } | null;
    assignee: { user: { name: string } } | null;
  } | null,
  organizationName: string | null,
): string | null {
  if (source.startsWith('literal:')) {
    const text = source.slice('literal:'.length).trim();
    return text === '' ? null : text;
  }
  if (source === 'organization.name') return organizationName;
  if (lead === null) return null;
  if (source.startsWith('custom.')) {
    const values = (lead.customValues ?? {}) as Record<string, unknown>;
    const value = values[source.slice('custom.'.length)];
    if (value === null || value === undefined) return null;
    // A currency custom field is `{ currency, amountMinor }`, not a number — so an object is not a
    // value a template can print, and pretending otherwise would send "[object Object]".
    if (typeof value === 'object') return null;
    return String(value);
  }
  switch (source) {
    case 'lead.fullName':
      return lead.fullName;
    case 'lead.firstName':
      return lead.firstName ?? lead.fullName.split(' ')[0] ?? null;
    case 'lead.phone':
      return lead.phoneE164;
    case 'lead.email':
      return lead.email;
    case 'lead.city':
      return lead.city;
    case 'lead.status':
      return lead.status?.name ?? null;
    case 'lead.owner':
      return lead.assignee?.user.name ?? null;
    default:
      return null;
  }
}
