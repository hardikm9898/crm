import { Injectable } from '@nestjs/common';
import {
  ACTIVITY_TYPES,
  AppError,
  PERMISSIONS,
  buildDisplayName,
  newId,
  normalizeContactNumbers,
  searchTextFor,
  tenantContext,
  validateCustomValues,
  type CountryCode,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { AuditService } from '../../infra/audit/audit.service.js';
import { OutboxService, type DomainEventInput } from '../../infra/outbox/outbox.service.js';
import { TimelineService } from '../../infra/timeline/timeline.service.js';
import { TimelineReadService } from '../../infra/timeline/timeline-read.service.js';
import { DataScopeService, applyScopeFilter } from '../../infra/authz/data-scope.service.js';
import { FieldRegistryService } from '../custom-fields/field-registry.service.js';
import type {
  ConvertLeadInput,
  CreateCustomerInput,
  CustomerTimelineQuery,
  ListCustomersQuery,
  UpdateCustomerInput,
} from './customers.dto.js';

/**
 * Customers, and the conversion that creates most of them (`FR-DEAL-4`).
 *
 * The requirement is one sentence — "lead → customer, preserving the full timeline and all
 * touchpoints (never a fresh record)" — and everything here follows from taking it literally:
 *
 *  * **The lead is not consumed.** It keeps its row, its touchpoints, its score, its history and
 *    its timeline, and gains a `converted_at`. The customer points back at it. Nothing is copied,
 *    re-parented or renumbered, so there is no step at which a touchpoint can be lost.
 *  * **A customer's timeline is a union, computed at read time** — `activities.lead_id` of the lead
 *    it came from, plus `activities.customer_id` of the customer. A business owner opening a
 *    customer sees the Facebook ad, the form, the three follow-up calls and the invoice in one
 *    list, because they are one list.
 *  * **A lead converts at most once, and the database enforces it.** `customers_lead_unique` is a
 *    partial unique index, so two clicks on Convert or a retried request cannot produce two
 *    customers. The service's check exists to give a sentence instead of a constraint name.
 *  * **Consent travels with the person.** The flags are copied at conversion and authoritative from
 *    then on, and the copy is written to the timeline so it is evidenced rather than assumed.
 */
@Injectable()
export class CustomersService {
  constructor(
    private readonly db: DbService,
    private readonly scopes: DataScopeService,
    private readonly fields: FieldRegistryService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly timeline: TimelineService,
    private readonly reader: TimelineReadService,
  ) {}

  // ── Conversion ────────────────────────────────────────────────────────────

  /**
   * Turns a lead into a customer.
   *
   * Authority is checked on **both** sides: `customer:manage` is the route's permission, and the
   * lead itself has to be inside the caller's `lead:update` scope — converting somebody else's
   * branch's lead is not something a customer permission should grant.
   */
  async convert(leadId: string, input: ConvertLeadInput) {
    const principal = tenantContext.require('customers.convert');
    const lead = await this.db.client.lead.findFirst({ where: { id: leadId, deletedAt: null } });
    if (!lead) throw AppError.notFound('Lead');
    // The list predicate is not enough on a single row, and the answer is 404 rather than 403:
    // knowing an id must never be authority, nor confirm that the row exists.
    const mayConvert = this.scopes.canAct(PERMISSIONS.LEAD_UPDATE, {
      userId: lead.assignedUserId,
      teamId: lead.teamId,
      branchId: lead.branchId,
    });
    if (!mayConvert) throw AppError.notFound('Lead');

    const existing = await this.db.client.customer.findFirst({
      where: { leadId, deletedAt: null },
      select: { id: true, fullName: true },
    });
    if (existing) {
      throw AppError.conflict(
        `${lead.fullName} is already a customer. Open ${existing.fullName} instead of converting again.`,
      );
    }

    // No contact normalization here: every number comes from the lead, where it was normalized on
    // write. Re-normalizing somebody's phone during a conversion could only change it.
    if (input.ownerUserId) await this.assertOwnable(input.ownerUserId);
    const wonStatus = await this.resolveWonStatus(input.statusId);

    const id = newId();
    const now = new Date();
    const fullName =
      lead.fullName ||
      buildDisplayName({
        firstName: lead.firstName,
        lastName: lead.lastName,
        company: lead.company,
        email: lead.email,
        phoneE164: lead.phoneE164,
        whatsappE164: lead.whatsappE164,
      });

    await this.db.client.$transaction(async (tx) => {
      await tx.customer.create({
        data: {
          id,
          organizationId: principal.organizationId,
          leadId: lead.id,
          convertedAt: now,
          branchId: lead.branchId,
          teamId: lead.teamId,
          // The account manager defaults to whoever was working the lead: somebody who has just
          // closed a sale is the person the customer expects to hear from.
          ownerUserId: input.ownerUserId ?? lead.assignedUserId,
          firstName: lead.firstName,
          lastName: lead.lastName,
          fullName,
          company: lead.company,
          jobTitle: lead.jobTitle,
          phoneE164: lead.phoneE164,
          phoneRaw: lead.phoneRaw,
          whatsappE164: lead.whatsappE164,
          email: lead.email,
          timezone: lead.timezone,
          billingLine1: input.billingLine1 ?? null,
          billingLine2: input.billingLine2 ?? null,
          // The lead's city is where they enquired from; it is the best guess for an invoice and a
          // far better one than blank, and the caller can override it in the same request.
          city: input.city ?? lead.city,
          state: input.state ?? lead.state,
          country: input.country ?? lead.country,
          postalCode: input.postalCode ?? lead.postalCode,
          taxId: input.taxId ?? null,
          consentWhatsapp: lead.consentWhatsapp,
          consentEmail: lead.consentEmail,
          consentCalls: lead.consentCalls,
          lastActivityAt: now,
          createdById: principal.actorId ?? null,
        },
      });

      // The lead moves to a won status in the same transaction. A conversion that left the lead in
      // "Negotiating" would make every pipeline report and every ageing view wrong.
      if (wonStatus && lead.statusId !== wonStatus.id) {
        await tx.leadStatusHistory.create({
          data: {
            id: newId(),
            organizationId: principal.organizationId,
            leadId: lead.id,
            fromStatusId: lead.statusId,
            toStatusId: wonStatus.id,
            changedById: principal.actorId ?? null,
            durationSeconds: Math.max(
              0,
              Math.floor((now.getTime() - lead.updatedAt.getTime()) / 1000),
            ),
          },
        });
      }
      await tx.lead.update({
        where: { id: lead.id },
        data: {
          convertedAt: now,
          lastActivityAt: now,
          ...(wonStatus ? { statusId: wonStatus.id } : {}),
        },
      });

      await this.timeline.recordManyInTransaction(tx, [
        {
          type: ACTIVITY_TYPES.LEAD_CONVERTED,
          leadId: lead.id,
          occurredAt: now,
          payload: {
            customerId: id,
            customerName: fullName,
            ...(wonStatus ? { statusId: wonStatus.id, statusName: wonStatus.name } : {}),
            ...(input.note ? { note: input.note } : {}),
          },
          actorType: principal.actorType,
          actorId: principal.actorId ?? null,
        },
        {
          // The customer's own first entry, so their timeline opens with how they began rather than
          // with whatever happens next. A *different* type from the lead's, because both appear in
          // the same union and two identical sentences at the same instant read as a bug.
          type: ACTIVITY_TYPES.CUSTOMER_CREATED,
          customerId: id,
          occurredAt: now,
          payload: {
            leadId: lead.id,
            leadName: lead.fullName,
            consentCarriedOver: {
              whatsapp: lead.consentWhatsapp,
              email: lead.consentEmail,
              calls: lead.consentCalls,
            },
            ...(input.note ? { note: input.note } : {}),
          },
          actorType: principal.actorType,
          actorId: principal.actorId ?? null,
        },
      ]);

      await this.audit.recordInTransaction(tx, {
        action: 'lead.converted',
        resourceType: 'customer',
        resourceId: id,
        after: { leadId: lead.id, fullName, ownerUserId: input.ownerUserId ?? lead.assignedUserId },
      });

      const events: DomainEventInput[] = [
        {
          name: 'lead.converted',
          aggregateType: 'lead',
          aggregateId: lead.id,
          payload: { customerId: id, convertedAt: now.toISOString() },
        },
        {
          name: 'customer.created',
          aggregateType: 'customer',
          aggregateId: id,
          payload: { leadId: lead.id, fullName },
        },
      ];
      await this.outbox.emit(tx, events);
    });

    return this.findOne(id);
  }

  // ── Creating one directly ─────────────────────────────────────────────────

  /**
   * A customer who was never a lead: a walk-in who paid on the spot, or an existing book of
   * business being migrated. `leadId` stays null — inventing a lead to convert would put a capture
   * that never happened at the top of their timeline.
   */
  async create(input: CreateCustomerInput) {
    const principal = tenantContext.require('customers.create');
    const organization = await this.db.client.organization.findUniqueOrThrow({
      where: { id: principal.organizationId },
      select: { defaultPhoneCountry: true, defaultCurrency: true },
    });

    const contact = normalizeContactNumbers(input, organization.defaultPhoneCountry as CountryCode);
    const fullName = buildDisplayName({ ...input, ...contact });
    if (!fullName) {
      throw AppError.validation('Some details need correcting', [
        {
          field: 'firstName',
          code: 'IDENTITY_REQUIRED',
          message: 'Give at least a name, a company, a phone number or an email address.',
        },
      ]);
    }
    if (input.ownerUserId) await this.assertOwnable(input.ownerUserId);
    const custom = await this.resolveCustomValues(input.customValues ?? {}, 'create', organization);

    const id = newId();
    const now = new Date();
    await this.db.client.$transaction(async (tx) => {
      await tx.customer.create({
        data: {
          id,
          organizationId: principal.organizationId,
          fullName,
          firstName: input.firstName ?? null,
          lastName: input.lastName ?? null,
          company: input.company ?? null,
          jobTitle: input.jobTitle ?? null,
          phoneE164: contact.phoneE164,
          phoneRaw: contact.phoneRaw,
          whatsappE164: contact.whatsappE164,
          email: input.email ?? null,
          timezone: input.timezone ?? null,
          billingLine1: input.billingLine1 ?? null,
          billingLine2: input.billingLine2 ?? null,
          city: input.city ?? null,
          state: input.state ?? null,
          country: input.country ?? null,
          postalCode: input.postalCode ?? null,
          taxId: input.taxId ?? null,
          ownerUserId: input.ownerUserId ?? null,
          branchId: input.branchId ?? null,
          teamId: input.teamId ?? null,
          consentWhatsapp: input.consent?.whatsapp ?? false,
          consentEmail: input.consent?.email ?? false,
          consentCalls: input.consent?.calls ?? false,
          customValues: custom.values as never,
          customSearchText: custom.searchText,
          lastActivityAt: now,
          createdById: principal.actorId ?? null,
        },
      });

      await this.timeline.recordInTransaction(tx, {
        // Not `lead.converted`: somebody who was never a lead did not convert, and a timeline that
        // says they did is a timeline that invents a capture.
        type: ACTIVITY_TYPES.CUSTOMER_CREATED,
        customerId: id,
        occurredAt: now,
        payload: { createdDirectly: true, fullName },
        actorType: principal.actorType,
        actorId: principal.actorId ?? null,
      });
      await this.audit.recordInTransaction(tx, {
        action: 'customer.created',
        resourceType: 'customer',
        resourceId: id,
        after: { fullName },
      });
      await this.outbox.emit(tx, [
        {
          name: 'customer.created',
          aggregateType: 'customer',
          aggregateId: id,
          payload: { fullName, leadId: null },
        },
      ]);
    });

    return this.findOne(id);
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  async list(query: ListCustomersQuery) {
    const filter = this.scopes.filterFor(PERMISSIONS.CUSTOMER_READ, {
      userColumn: 'ownerUserId',
      teamColumn: 'teamId',
      branchColumn: 'branchId',
    });

    const baseWhere: Record<string, unknown> = {
      deletedAt: query.deleted === true ? { not: null } : null,
      ...(query.ownerUserId ? { ownerUserId: query.ownerUserId } : {}),
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.teamId ? { teamId: query.teamId } : {}),
      ...(query.converted === true ? { leadId: { not: null } } : {}),
      ...(query.converted === false ? { leadId: null } : {}),
    };
    const where = applyScopeFilter(baseWhere, filter);
    if (where === null) return this.emptyPage(query.limit);

    if (query.search) {
      const matched = await this.searchIds(query.search, query.limit * 4);
      if (matched.length === 0) return this.emptyPage(query.limit);
      where['id'] = { in: matched };
    }

    const orderBy = {
      [query.sort === 'full_name'
        ? 'fullName'
        : query.sort === 'updated_at'
          ? 'updatedAt'
          : query.sort === 'last_activity_at'
            ? 'lastActivityAt'
            : 'createdAt']: query.direction,
    };

    const [total, rows] = await Promise.all([
      this.db.client.customer.count({ where }),
      this.db.client.customer.findMany({
        where,
        orderBy,
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        include: this.listInclude(),
      }),
    ]);

    const page = rows.slice(0, query.limit);
    const hasMore = rows.length > query.limit;
    return {
      items: page.map((customer) => this.presentSummary(customer)),
      pagination: {
        limit: query.limit,
        nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
        hasMore,
        total,
      },
    };
  }

  async findOne(id: string) {
    const customer = await this.db.client.customer.findFirst({
      where: { id },
      include: {
        ...this.listInclude(),
        lead: {
          select: {
            id: true,
            fullName: true,
            createdAt: true,
            score: true,
            scoreBand: true,
            leadSourceId: true,
            source: { select: { name: true } },
            createdVia: true,
          },
        },
      },
    });
    if (!customer) throw AppError.notFound('Customer');
    this.assertCanSee(customer);

    const definitions = await this.fields.definitionsFor('customer');
    return {
      ...this.presentSummary(customer),
      billing: {
        line1: customer.billingLine1,
        line2: customer.billingLine2,
        city: customer.city,
        state: customer.state,
        country: customer.country,
        postalCode: customer.postalCode,
        taxId: customer.taxId,
      },
      consent: {
        whatsapp: customer.consentWhatsapp,
        email: customer.consentEmail,
        calls: customer.consentCalls,
      },
      customValues: customer.customValues as Record<string, unknown>,
      customFields: definitions.map((definition) => ({
        key: definition.key,
        label: definition.label,
        type: definition.type,
        isRequired: definition.isRequired,
        isPii: definition.isPii,
      })),
      /** Where they came from, so a customer screen can link back to the capture. */
      origin: customer.lead
        ? {
            leadId: customer.lead.id,
            leadName: customer.lead.fullName,
            capturedAt: customer.lead.createdAt,
            capturedVia: customer.lead.createdVia,
            source: customer.lead.source?.name ?? null,
            scoreAtConversion: customer.lead.score,
            scoreBand: customer.lead.scoreBand,
          }
        : null,
      createdAt: customer.createdAt,
      updatedAt: customer.updatedAt,
      deletedAt: customer.deletedAt,
    };
  }

  /**
   * The whole journey, in one list (`FR-DEAL-4`, `FR-TL-1`).
   *
   * The union is the requirement: activity recorded against the lead *before* conversion and
   * against the customer *after* it are the same person's history, and a customer screen that
   * started at the conversion would be the "fresh record" the requirement forbids.
   *
   * The cursor carries both halves of `activities`' key — `occurred_at` is the partition key, so an
   * id alone selects the wrong page.
   */
  async journey(id: string, query: CustomerTimelineQuery) {
    const customer = await this.db.client.customer.findFirst({
      where: { id },
      select: { id: true, leadId: true, ownerUserId: true, teamId: true, branchId: true },
    });
    if (!customer) throw AppError.notFound('Customer');
    this.assertCanSee(customer);

    // The union is the requirement. Both halves go to the shared reader, which owns the
    // presentation and the cursor that has to carry both halves of the partition key.
    const subject = customer.leadId
      ? { OR: [{ customerId: customer.id }, { leadId: customer.leadId }] }
      : { customerId: customer.id };

    return this.reader.page(subject, {
      limit: query.limit,
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
  }

  // ── Writing ───────────────────────────────────────────────────────────────

  async update(id: string, input: UpdateCustomerInput) {
    const principal = tenantContext.require('customers.update');
    const customer = await this.loadForWrite(id);
    const organization = await this.db.client.organization.findUniqueOrThrow({
      where: { id: principal.organizationId },
      select: { defaultPhoneCountry: true, defaultCurrency: true },
    });

    const contact =
      input.phone === undefined && input.whatsapp === undefined
        ? null
        : normalizeContactNumbers(input, organization.defaultPhoneCountry as CountryCode);
    const custom =
      input.customValues === undefined
        ? null
        : await this.resolveCustomValues(
            input.customValues,
            'patch',
            organization,
            customer.customValues,
          );
    if (input.ownerUserId) await this.assertOwnable(input.ownerUserId);

    const data: Record<string, unknown> = {};
    const assign = <T>(key: string, value: T | undefined) => {
      if (value !== undefined) data[key] = value;
    };
    assign('firstName', input.firstName);
    assign('lastName', input.lastName);
    assign('company', input.company);
    assign('jobTitle', input.jobTitle);
    assign('email', input.email);
    assign('timezone', input.timezone);
    assign('billingLine1', input.billingLine1);
    assign('billingLine2', input.billingLine2);
    assign('city', input.city);
    assign('state', input.state);
    assign('country', input.country);
    assign('postalCode', input.postalCode);
    assign('taxId', input.taxId);
    assign('ownerUserId', input.ownerUserId);
    assign('branchId', input.branchId);
    assign('teamId', input.teamId);
    if (contact) {
      data['phoneE164'] = contact.phoneE164;
      data['phoneRaw'] = contact.phoneRaw;
      data['whatsappE164'] = contact.whatsappE164;
    }
    if (input.consent?.whatsapp !== undefined) data['consentWhatsapp'] = input.consent.whatsapp;
    if (input.consent?.email !== undefined) data['consentEmail'] = input.consent.email;
    if (input.consent?.calls !== undefined) data['consentCalls'] = input.consent.calls;
    if (custom) {
      data['customValues'] = custom.values as never;
      data['customSearchText'] = custom.searchText;
    }

    // The display name is derived, never sent: a caller who changes the surname must not be able to
    // leave the name saying something else.
    const next = { ...customer, ...data } as Record<string, unknown>;
    data['fullName'] =
      buildDisplayName({
        firstName: next['firstName'] as string | null,
        lastName: next['lastName'] as string | null,
        company: next['company'] as string | null,
        email: next['email'] as string | null,
        phoneE164: next['phoneE164'] as string | null,
        whatsappE164: next['whatsappE164'] as string | null,
      }) || customer.fullName;

    const changed = Object.keys(data).filter(
      (key) => (customer as Record<string, unknown>)[key] !== data[key],
    );
    const now = new Date();

    await this.db.client.$transaction(async (tx) => {
      await tx.customer.update({ where: { id }, data: { ...data, lastActivityAt: now } });
      if (changed.length > 0) {
        await this.timeline.recordInTransaction(tx, {
          type: ACTIVITY_TYPES.CUSTOMER_UPDATED,
          customerId: id,
          occurredAt: now,
          payload: { fields: changed },
          actorType: principal.actorType,
          actorId: principal.actorId ?? null,
        });
      }
      await this.audit.recordInTransaction(tx, {
        action: 'customer.updated',
        resourceType: 'customer',
        resourceId: id,
        before: pick(customer as Record<string, unknown>, changed),
        after: pick(data, changed),
      });
      await this.outbox.emit(tx, [
        {
          name: 'customer.updated',
          aggregateType: 'customer',
          aggregateId: id,
          payload: { fields: changed },
        },
      ]);
    });

    return this.findOne(id);
  }

  /** Soft delete, like a lead's: reversible, and nothing about the history goes. */
  async remove(id: string) {
    const principal = tenantContext.require('customers.remove');
    const customer = await this.loadForWrite(id);
    if (customer.deletedAt) return { id, deleted: true };
    const now = new Date();

    await this.db.client.$transaction(async (tx) => {
      await tx.customer.update({
        where: { id },
        data: { deletedAt: now, deletedById: principal.actorId ?? null },
      });
      await this.timeline.recordInTransaction(tx, {
        type: ACTIVITY_TYPES.CUSTOMER_DELETED,
        customerId: id,
        occurredAt: now,
        payload: { fullName: customer.fullName },
        actorType: principal.actorType,
        actorId: principal.actorId ?? null,
      });
      await this.audit.recordInTransaction(tx, {
        action: 'customer.deleted',
        resourceType: 'customer',
        resourceId: id,
        before: { fullName: customer.fullName },
      });
      await this.outbox.emit(tx, [
        {
          name: 'customer.deleted',
          aggregateType: 'customer',
          aggregateId: id,
          payload: { fullName: customer.fullName },
        },
      ]);
    });

    return { id, deleted: true };
  }

  async restore(id: string) {
    const principal = tenantContext.require('customers.restore');
    const customer = await this.loadForWrite(id);
    if (!customer.deletedAt) return this.findOne(id);
    const now = new Date();

    await this.db.client.$transaction(async (tx) => {
      await tx.customer.update({ where: { id }, data: { deletedAt: null, deletedById: null } });
      await this.timeline.recordInTransaction(tx, {
        type: ACTIVITY_TYPES.CUSTOMER_RESTORED,
        customerId: id,
        occurredAt: now,
        payload: { fullName: customer.fullName },
        actorType: principal.actorType,
        actorId: principal.actorId ?? null,
      });
      await this.audit.recordInTransaction(tx, {
        action: 'customer.restored',
        resourceType: 'customer',
        resourceId: id,
        after: { fullName: customer.fullName },
      });
    });

    return this.findOne(id);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private assertCanSee(customer: {
    ownerUserId: string | null;
    teamId: string | null;
    branchId: string | null;
  }): void {
    const allowed = this.scopes.canAct(PERMISSIONS.CUSTOMER_READ, {
      userId: customer.ownerUserId,
      teamId: customer.teamId,
      branchId: customer.branchId,
    });
    if (!allowed) throw AppError.notFound('Customer');
  }

  private async loadForWrite(id: string) {
    const customer = await this.db.client.customer.findFirst({ where: { id } });
    if (!customer) throw AppError.notFound('Customer');
    const allowed = this.scopes.canAct(PERMISSIONS.CUSTOMER_MANAGE, {
      userId: customer.ownerUserId,
      teamId: customer.teamId,
      branchId: customer.branchId,
    });
    if (!allowed) throw AppError.notFound('Customer');
    return customer;
  }

  /**
   * The status a conversion moves the lead to.
   *
   * Chosen from the tenant's own statuses by `category = 'won'`, never by name (rule 4). A workspace
   * with no won status gets a conversion that does not touch the status, rather than a refusal: the
   * customer is the point, and a missing configuration row should not block a sale.
   */
  private async resolveWonStatus(statusId?: string) {
    if (statusId) {
      const named = await this.db.client.leadStatus.findFirst({
        where: { id: statusId, deletedAt: null, isActive: true },
        select: { id: true, name: true, category: true },
      });
      if (!named) throw AppError.notFound('Status');
      return named;
    }
    return this.db.client.leadStatus.findFirst({
      where: { category: 'won', deletedAt: null, isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, name: true, category: true },
    });
  }

  private async assertOwnable(userId: string): Promise<void> {
    const membership = await this.db.client.membership.findFirst({
      where: { userId, status: 'active', deletedAt: null },
    });
    // Tenant scoping means a user id from another organization simply is not found — which is the
    // point of owning through Membership rather than User.
    if (!membership) throw AppError.notFound('Member');
  }

  private async resolveCustomValues(
    input: Record<string, unknown>,
    mode: 'create' | 'patch',
    organization: { defaultPhoneCountry: string; defaultCurrency: string },
    existing?: unknown,
  ) {
    const definitions = await this.fields.definitionsFor('customer');
    const result = validateCustomValues(definitions, input, {
      mode,
      defaultPhoneCountry: organization.defaultPhoneCountry as CountryCode,
      defaultCurrency: organization.defaultCurrency,
    });
    if (mode === 'create') return result;

    const merged = { ...((existing ?? {}) as Record<string, unknown>), ...result.values };
    for (const key of result.cleared) delete merged[key];
    return { ...result, searchText: searchTextFor(definitions, merged) };
  }

  /**
   * Full-text first, then trigram, exactly as leads search does — so "the last four digits" and a
   * misspelt name both work, and the two tables rank consistently.
   */
  private async searchIds(term: string, limit: number): Promise<string[]> {
    const principal = tenantContext.require('customers.search');
    const digits = term.replace(/\D/g, '');
    const rows = await this.db.client.$queryRaw<{ id: string }[]>`
      SELECT id FROM customers
       WHERE organization_id = ${principal.organizationId}::uuid
         AND deleted_at IS NULL
         AND (
           search_vector @@ plainto_tsquery('simple', ${term})
           OR full_name ILIKE ${'%' + term + '%'}
           OR (${digits} <> '' AND phone_e164 ILIKE ${'%' + digits + '%'})
           OR lower(email) LIKE ${'%' + term.toLowerCase() + '%'}
         )
       LIMIT ${limit}`;
    return rows.map((row) => row.id);
  }

  private listInclude() {
    return {
      owner: { select: { userId: true, user: { select: { name: true, email: true } } } },
      branch: { select: { id: true, name: true } },
      team: { select: { id: true, name: true } },
    };
  }

  private presentSummary(customer: {
    id: string;
    fullName: string;
    firstName: string | null;
    lastName: string | null;
    company: string | null;
    jobTitle: string | null;
    phoneE164: string | null;
    whatsappE164: string | null;
    email: string | null;
    city: string | null;
    leadId: string | null;
    convertedAt: Date | null;
    lastActivityAt: Date | null;
    createdAt: Date;
    deletedAt: Date | null;
    owner?: { userId: string; user: { name: string; email: string } } | null;
    branch?: { id: string; name: string } | null;
    team?: { id: string; name: string } | null;
  }) {
    return {
      id: customer.id,
      fullName: customer.fullName,
      firstName: customer.firstName,
      lastName: customer.lastName,
      company: customer.company,
      jobTitle: customer.jobTitle,
      phone: customer.phoneE164,
      whatsapp: customer.whatsappE164,
      email: customer.email,
      city: customer.city,
      /** True when this customer came from a lead, which is what makes the origin panel meaningful. */
      converted: customer.leadId !== null,
      convertedAt: customer.convertedAt,
      owner: customer.owner
        ? {
            userId: customer.owner.userId,
            name: customer.owner.user.name,
            email: customer.owner.user.email,
          }
        : null,
      branch: customer.branch ?? null,
      team: customer.team ?? null,
      lastActivityAt: customer.lastActivityAt,
      createdAt: customer.createdAt,
      deletedAt: customer.deletedAt,
    };
  }

  private emptyPage(limit: number) {
    return {
      items: [],
      pagination: { limit, nextCursor: null, hasMore: false, total: 0 },
    };
  }
}

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) picked[key] = source[key];
  return picked;
}
