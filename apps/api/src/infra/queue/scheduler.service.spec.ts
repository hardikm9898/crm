import { describe, expect, it } from 'vitest';
import { SCHEDULES } from './scheduler.service.js';
import { JOBS, QUEUE_NAMES } from './queue.constants.js';

describe('schedules', () => {
  it('references declared queues and known jobs', () => {
    const jobNames = new Set<string>(Object.values(JOBS));
    for (const schedule of SCHEDULES) {
      expect(QUEUE_NAMES).toContain(schedule.queue);
      expect(jobNames).toContain(schedule.jobName);
    }
  });

  it('uses valid five-field cron expressions', () => {
    for (const schedule of SCHEDULES) {
      expect(schedule.cron.trim().split(/\s+/), schedule.jobName).toHaveLength(5);
    }
  });

  it('registers each job at most once', () => {
    const names = SCHEDULES.map((schedule) => schedule.jobName);
    expect(new Set(names).size).toBe(names.length);
  });

  it('describes every schedule, so the list is readable by an operator', () => {
    for (const schedule of SCHEDULES) {
      expect(schedule.description.length, schedule.jobName).toBeGreaterThan(10);
    }
  });

  it('avoids scheduling daily jobs exactly on the hour', () => {
    // Everything scheduled at :00 contends for the same minute; offsetting spreads the load.
    const dailyOnTheHour = SCHEDULES.filter((schedule) => /^0 \d+ \* \* \*$/.test(schedule.cron));
    expect(dailyOnTheHour.map((schedule) => schedule.jobName)).toEqual([]);
  });
});
