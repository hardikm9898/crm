import { Injectable } from '@nestjs/common';
import { AppError, newId, tenantContext } from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { AuditService } from '../../infra/audit/audit.service.js';
import { fullPage } from '../organizations/organizations.service.js';
import type { CreateSlaPolicyInput, UpdateSlaPolicyInput } from './sla.dto.js';

/**
 * The promises a workspace makes, as rows (`FR-TSK-8`, rule 4).
 *
 * Written with `settings:manage` rather than an `sla:manage` of its own: a policy is workspace
 * configuration like a status or a pipeline, and a separate write permission would be one more
 * thing to grant for no separation anybody asked for. `sla:read` exists precisely because the
 * *other* half is worth separating — a manager who sees the breach board without being able to move
 * the targets.
 *
 * **A policy in use is never destroyed.** Clocks reference it with `Restrict`, so deleting one that
 * has ever governed a lead is refused with the count; deactivating it stops new clocks and leaves
 * every past breach explainable. An SLA report whose policy row has vanished is a report that
 * cannot say what the promise was.
 */
@Injectable()
export class SlaPoliciesService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async list(includeInactive = false) {
    const policies = await this.db.client.slaPolicy.findMany({
      where: { deletedAt: null, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: [{ priority: 'asc' }, { name: 'asc' }],
    });
    const counts = await this.db.client.slaClock.groupBy({
      by: ['policyId'],
      _count: { _all: true },
    });
    const byPolicy = new Map(counts.map((row) => [row.policyId, row._count._all]));
    const items = policies.map((policy) => ({
      id: policy.id,
      name: policy.name,
      appliesTo: policy.appliesTo,
      firstResponseMinutes: policy.firstResponseMinutes,
      nextResponseMinutes: policy.nextResponseMinutes,
      resolutionMinutes: policy.resolutionMinutes,
      businessHoursOnly: policy.businessHoursOnly,
      warnAtPercent: policy.warnAtPercent,
      escalateTo: policy.escalateTo,
      priority: policy.priority,
      isActive: policy.isActive,
      /** How many clocks it has governed — which is how a manager knows it is the one that bites. */
      clockCount: byPolicy.get(policy.id) ?? 0,
    }));
    return { items, pagination: fullPage(items.length) };
  }

  async create(input: CreateSlaPolicyInput) {
    const organizationId = tenantContext.organizationId('sla.createPolicy');
    const id = newId();
    await this.db.client.slaPolicy.create({
      data: {
        id,
        organizationId,
        name: input.name,
        appliesTo: input.appliesTo as never,
        firstResponseMinutes: input.firstResponseMinutes,
        nextResponseMinutes: input.nextResponseMinutes ?? null,
        resolutionMinutes: input.resolutionMinutes ?? null,
        businessHoursOnly: input.businessHoursOnly,
        warnAtPercent: input.warnAtPercent,
        escalateTo: input.escalateTo as never,
        priority: input.priority,
      },
    });
    await this.audit.record({
      action: 'sla_policy.created',
      resourceType: 'sla_policy',
      resourceId: id,
      after: { name: input.name, firstResponseMinutes: input.firstResponseMinutes },
    });
    return { id, name: input.name };
  }

  async update(id: string, input: UpdateSlaPolicyInput) {
    const policy = await this.db.client.slaPolicy.findFirst({ where: { id, deletedAt: null } });
    if (!policy) throw AppError.notFound('SLA policy');

    await this.db.client.slaPolicy.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.appliesTo !== undefined ? { appliesTo: input.appliesTo as never } : {}),
        ...(input.firstResponseMinutes !== undefined
          ? { firstResponseMinutes: input.firstResponseMinutes }
          : {}),
        ...(input.nextResponseMinutes !== undefined
          ? { nextResponseMinutes: input.nextResponseMinutes }
          : {}),
        ...(input.resolutionMinutes !== undefined
          ? { resolutionMinutes: input.resolutionMinutes }
          : {}),
        ...(input.businessHoursOnly !== undefined
          ? { businessHoursOnly: input.businessHoursOnly }
          : {}),
        ...(input.warnAtPercent !== undefined ? { warnAtPercent: input.warnAtPercent } : {}),
        ...(input.escalateTo !== undefined ? { escalateTo: input.escalateTo as never } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    await this.audit.record({
      action: 'sla_policy.updated',
      resourceType: 'sla_policy',
      resourceId: id,
      before: {
        name: policy.name,
        firstResponseMinutes: policy.firstResponseMinutes,
        isActive: policy.isActive,
      },
      after: input as Record<string, unknown>,
    });
    /**
     * Editing a target does **not** move the clocks already running against it.
     *
     * Said out loud because the opposite is a plausible reading and it is wrong: a promise that was
     * made at 09:00 under a 60-minute policy was made, and retargeting it at 09:30 would rewrite
     * history — a breach that un-breached itself because somebody relaxed the policy afterwards.
     * New clocks get the new target; `sla_clocks.target_minutes` is why a report can still say what
     * each old one promised.
     */
    return { id, affectsNewClocksOnly: true };
  }

  async remove(id: string) {
    const policy = await this.db.client.slaPolicy.findFirst({ where: { id, deletedAt: null } });
    if (!policy) throw AppError.notFound('SLA policy');

    const inUse = await this.db.client.slaClock.count({ where: { policyId: id } });
    if (inUse > 0) {
      throw AppError.businessRule(
        `${inUse === 1 ? '1 clock has run' : `${inUse} clocks have run`} against this policy. Deactivate it instead — a breach report has to be able to say what the promise was`,
        { clocks: inUse },
      );
    }
    await this.db.client.slaPolicy.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    await this.audit.record({
      action: 'sla_policy.deleted',
      resourceType: 'sla_policy',
      resourceId: id,
      before: { name: policy.name },
    });
    return { id, deleted: true };
  }
}
