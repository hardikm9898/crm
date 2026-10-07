import { Injectable } from '@nestjs/common';
import {
  alwaysOpen,
  dateKeyInZone,
  type BusinessCalendar,
  type BusinessWindow,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';

/**
 * Builds the workspace's working calendar from the rows that have held it since Phase 1.
 *
 * `working_hours` and `holidays` have existed since the first migration with **one reader** — the
 * assignment engine, which asks "is this person on shift right now". Nothing has ever read them as
 * a *calendar*, which is what an SLA needs: not "are we open" but "when will we next be, and for
 * how long". This is that reader.
 *
 * Three decisions, each of which the alternative gets wrong:
 *
 *  * **Branch hours win over workspace hours.** A business with a Mumbai branch open on Saturday
 *    and a Pune branch closed has two calendars, and a lead belongs to one of them. Falling back to
 *    the workspace-wide rows (`branch_id IS NULL`) when a branch has none of its own is what keeps
 *    the common case — one set of hours for everybody — a single row set.
 *  * **A workspace with no hours at all is treated as always open**, not as never open. Never open
 *    would make every clock's due date `null` and every SLA silently inert; always open is wrong in
 *    a different direction but it is *visible* — the board fills up and somebody fixes the hours.
 *  * **Holidays are read as a window around the clock's own span**, not for all time. A policy
 *    measured in days needs next month's holidays; nothing needs 2019's.
 */
@Injectable()
export class SlaCalendarService {
  constructor(private readonly db: DbService) {}

  /**
   * The calendar a clock on this branch runs against.
   *
   * `horizonDays` is how far ahead holidays are loaded. The default covers a quarter, which is
   * further than any first-response target and far enough for a resolution target measured in
   * working weeks.
   */
  async forBranch(
    timeZone: string,
    branchId: string | null,
    from: Date,
    horizonDays = 120,
  ): Promise<BusinessCalendar> {
    const [hours, holidays] = await Promise.all([
      this.db.client.workingHours.findMany({
        // Workspace-wide rows and this branch's, in one read; the branch's win below. Rows that
        // belong to a *person* are the assignment engine's business, not the workspace's calendar.
        where: {
          userId: null,
          ...(branchId ? { OR: [{ branchId: null }, { branchId }] } : { branchId: null }),
        },
        select: {
          branchId: true,
          dayOfWeek: true,
          startMinute: true,
          endMinute: true,
          isWorking: true,
        },
      }),
      this.db.client.holiday.findMany({
        where: {
          ...(branchId ? { OR: [{ branchId: null }, { branchId }] } : { branchId: null }),
          date: {
            gte: new Date(`${dateKeyInZone(from, timeZone)}T00:00:00.000Z`),
            lte: new Date(
              `${dateKeyInZone(new Date(from.getTime() + horizonDays * 86_400_000), timeZone)}T00:00:00.000Z`,
            ),
          },
        },
        select: { date: true, isWorking: true },
      }),
    ]);

    const branchRows = hours.filter((row) => row.branchId === branchId && branchId !== null);
    const applicable =
      branchRows.length > 0 ? branchRows : hours.filter((row) => row.branchId === null);
    const windows: BusinessWindow[] = applicable
      .filter((row) => row.isWorking && row.endMinute > row.startMinute)
      .map((row) => ({
        dayOfWeek: row.dayOfWeek,
        startMinute: row.startMinute,
        endMinute: row.endMinute,
      }));

    if (windows.length === 0) {
      // See the class comment: visible-and-wrong beats invisible-and-inert.
      return alwaysOpen(timeZone);
    }

    const closed = new Set<string>();
    const working = new Set<string>();
    for (const holiday of holidays) {
      // `holidays.date` is a `date` column, so its instant is midnight UTC and reading the key off
      // it in the workspace's zone would shift it a day west of Greenwich.
      const key = holiday.date.toISOString().slice(0, 10);
      (holiday.isWorking ? working : closed).add(key);
    }

    return { timeZone, windows, holidays: closed, workingDates: working };
  }

  /** What `business_hours_only = false` means: the clock runs on the wall of the world. */
  alwaysOpenFor(timeZone: string): BusinessCalendar {
    return alwaysOpen(timeZone);
  }
}
