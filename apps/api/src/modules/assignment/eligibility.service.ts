import { Injectable } from '@nestjs/common';
import { dateKeyInZone, tenantContext, zonedParts } from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';

/**
 * Who can take a lead right now (`FR-ASG-4`).
 *
 * Four independent reasons somebody is not eligible, and the service reports **which** rather than
 * just excluding them — because "why did this lead go to the unassigned pool at 9pm" is a question a
 * business owner asks, and "nobody was eligible" is not an answer.
 *
 *  * they are not an active member;
 *  * it is outside their working hours, or a holiday for their branch;
 *  * they are on leave or marked away;
 *  * they already hold the rule's capacity cap in open leads.
 *
 * Working hours are evaluated in the **organization's** timezone, because that is the clock the
 * business runs on: a rule that says "until 6:30pm" means the shop's 6:30pm, not the server's.
 */

export interface EligibilityInput {
  readonly userIds: readonly string[];
  readonly at: Date;
  readonly respectWorkingHours: boolean;
  readonly capacityCap: number | null;
}

export interface MemberEligibility {
  readonly userId: string;
  readonly eligible: boolean;
  /** Present when not eligible: a sentence naming the reason. */
  readonly reason?: string;
  /** Open leads currently held, for the load-balancing strategies. */
  readonly openLeads: number;
  /** Converted leads in the last 90 days, for `top_performer`. */
  readonly recentConversions: number;
}

const PERFORMANCE_WINDOW_DAYS = 90;

@Injectable()
export class EligibilityService {
  constructor(private readonly db: DbService) {}

  async assess(input: EligibilityInput): Promise<readonly MemberEligibility[]> {
    if (input.userIds.length === 0) return [];
    const organizationId = tenantContext.organizationId('assignment.eligibility');
    const userIds = [...new Set(input.userIds)];

    const organization = await this.db.client.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { timezone: true },
    });
    const zone = organization.timezone;
    const parts = zonedParts(input.at, zone);
    const minuteOfDay = parts.hour * 60 + parts.minute;
    const dayOfWeek = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
    const todayKey = dateKeyInZone(input.at, zone);

    const [memberships, workingHours, holidays, availability, openCounts, conversions] =
      await Promise.all([
        this.db.client.membership.findMany({
          where: { userId: { in: userIds }, deletedAt: null },
          select: { userId: true, status: true, defaultBranchId: true },
        }),
        this.db.client.workingHours.findMany({ where: { userId: { in: userIds }, dayOfWeek } }),
        this.db.client.holiday.findMany({ where: { date: new Date(`${todayKey}T00:00:00Z`) } }),
        this.db.client.userAvailability.findMany({
          where: {
            userId: { in: userIds },
            state: { not: 'available' },
            OR: [
              { fromAt: null, toAt: null },
              { fromAt: { lte: input.at }, toAt: null },
              { fromAt: null, toAt: { gte: input.at } },
              { fromAt: { lte: input.at }, toAt: { gte: input.at } },
            ],
          },
          select: { userId: true, state: true, reason: true },
        }),
        this.db.client.lead.groupBy({
          by: ['assignedUserId'],
          where: {
            assignedUserId: { in: userIds },
            deletedAt: null,
            status: { category: 'open' },
          },
          _count: { _all: true },
        }),
        this.db.client.lead.groupBy({
          by: ['assignedUserId'],
          where: {
            assignedUserId: { in: userIds },
            deletedAt: null,
            convertedAt: {
              gte: new Date(input.at.getTime() - PERFORMANCE_WINDOW_DAYS * 86_400_000),
            },
          },
          _count: { _all: true },
        }),
      ]);

    const membershipByUser = new Map(memberships.map((row) => [row.userId, row]));
    const openByUser = new Map(openCounts.map((row) => [row.assignedUserId, row._count._all]));
    const conversionsByUser = new Map(
      conversions.map((row) => [row.assignedUserId, row._count._all]),
    );
    const awayByUser = new Map(availability.map((row) => [row.userId, row]));

    // An organization-wide holiday has a null branch; a branch holiday names one.
    const organizationHoliday = holidays.find((row) => row.branchId === null && !row.isWorking);
    const holidayByBranch = new Map(
      holidays
        .filter((row) => row.branchId !== null && !row.isWorking)
        .map((row) => [row.branchId, row]),
    );

    return userIds.map((userId) => {
      const openLeads = openByUser.get(userId) ?? 0;
      const recentConversions = conversionsByUser.get(userId) ?? 0;
      const base = { userId, openLeads, recentConversions };

      const membership = membershipByUser.get(userId);
      if (!membership || membership.status !== 'active') {
        return { ...base, eligible: false, reason: 'No longer an active member of this workspace' };
      }

      const away = awayByUser.get(userId);
      if (away) {
        return {
          ...base,
          eligible: false,
          reason: away.reason ? `Marked ${away.state}: ${away.reason}` : `Marked ${away.state}`,
        };
      }

      if (input.respectWorkingHours) {
        if (organizationHoliday) {
          return { ...base, eligible: false, reason: `Holiday: ${organizationHoliday.name}` };
        }
        const branchHoliday = membership.defaultBranchId
          ? holidayByBranch.get(membership.defaultBranchId)
          : undefined;
        if (branchHoliday) {
          return { ...base, eligible: false, reason: `Branch holiday: ${branchHoliday.name}` };
        }

        // A person's own hours win over their branch's. Someone with no hours at all is treated as
        // unavailable rather than always available: silence is not a shift pattern.
        const personal = workingHours.filter((row) => row.userId === userId);
        const applicable = personal.length > 0 ? personal : [];
        const working = applicable.some(
          (row) => row.isWorking && minuteOfDay >= row.startMinute && minuteOfDay < row.endMinute,
        );
        if (!working) {
          return {
            ...base,
            eligible: false,
            reason:
              applicable.length === 0
                ? 'No working hours set for today'
                : `Outside working hours (${formatMinute(minuteOfDay)} in ${zone})`,
          };
        }
      }

      if (input.capacityCap !== null && openLeads >= input.capacityCap) {
        return {
          ...base,
          eligible: false,
          reason: `At capacity: ${openLeads} open leads, cap is ${input.capacityCap}`,
        };
      }

      return { ...base, eligible: true };
    });
  }
}

function formatMinute(minuteOfDay: number): string {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
