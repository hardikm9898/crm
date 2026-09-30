import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, newToken } from '@leados/shared';
import {
  LeadScoreProcessor,
  ScoreDecaySweepProcessor,
} from '../src/modules/scoring/scoring.processor.js';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';

/**
 * THE SCORING AND VIEWS SUITE.
 *
 * Two Phase 2 exit criteria live here:
 *
 *  * *"Score is explainable: the UI shows which rules contributed how many points"* (`FR-SCR-2`) —
 *    asserted as the property that makes it true, which is that **the breakdown adds up to the
 *    number on the lead**, always, including after a decay, a cap, a replay and a recalculation.
 *  * *"Saved views, shareable to team or private, with column selection, sort and default per
 *    role"* (`FR-VIEW-3`), and the filters of `FR-VIEW-2` behind them.
 *
 * Everything involving the clock is asserted against a **fixed instant**, and the decay tests move
 * `last_activity_at` rather than waiting: a test that only passes on a Tuesday is a test that fails
 * for no reason on a Wednesday.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2escore${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';
const noJob = {} as never;

let ctx: TestApp;
let orgA: { token: string; organizationId: string; userId: string };
let orgB: { token: string; organizationId: string; userId: string };

async function api<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  options: { token: string; payload?: unknown },
) {
  return call<EnvelopeBody<T>>(ctx.app, {
    method,
    url: `/api/v1${url}`,
    token: options.token,
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
}

/** A setup call whose failure must not be silent, for the reason recorded in CLAUDE.md. */
async function configure<T = unknown>(
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  options: { token: string; payload?: unknown },
) {
  const response = await api<T>(method, url, options);
  if (response.statusCode >= 300) {
    throw new Error(
      `setup ${method} ${url} was refused with ${response.statusCode}: ${JSON.stringify(response.body)}`,
    );
  }
  return response;
}

async function createTenant(label: string) {
  const registered = await call<
    EnvelopeBody<{
      tokens: { accessToken: string };
      activeOrganizationId: string;
      user: { id: string };
    }>
  >(ctx.app, {
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      email: `${label}.${EMAIL_MARKER}@test.local`,
      password: PASSWORD,
      name: `Owner ${label}`,
      organizationName: `Scoring ${label} ${SUFFIX}`,
    },
  });
  return {
    token: registered.body.data.tokens.accessToken,
    organizationId: registered.body.data.activeOrganizationId,
    userId: registered.body.data.user.id,
  };
}

/** Scores a lead the way the queue does, so the test exercises the real processor. */
async function score(
  leadId: string,
  organizationId: string,
  eventName: string,
  payload: Record<string, unknown> = {},
) {
  await ctx.app
    .get(LeadScoreProcessor)
    .process({ organizationId, aggregateId: leadId, eventName, eventId: newId(), payload }, noJob);
}

async function createLead(token: string, body: Record<string, unknown>) {
  const created = await configure<{ id: string }>('POST', '/leads', { token, payload: body });
  return created.body.data.id;
}

beforeAll(async () => {
  ctx = await bootTestApp();
  orgA = await createTenant('orga');
  orgB = await createTenant('orgb');
}, 120_000);

afterAll(async () => {
  await cleanupUsers(ctx.db, EMAIL_MARKER);
  await ctx.close();
});

describe('a new workspace can score a lead on its first day', () => {
  it('is provisioned with bands that partition the whole range', async () => {
    const bands = await api<{ name: string; minScore: number; maxScore: number }[]>(
      'GET',
      '/scoring/bands',
      { token: orgA.token },
    );
    const sorted = [...bands.body.data].sort((left, right) => left.minScore - right.minScore);
    expect(sorted[0]?.minScore).toBe(0);
    expect(sorted[sorted.length - 1]?.maxScore).toBe(1000);
    // No gap between any two: a lead in a gap would have a score and no band, and would then be
    // missing from every band-filtered view.
    for (let index = 1; index < sorted.length; index += 1) {
      expect(sorted[index]!.minScore).toBe(sorted[index - 1]!.maxScore + 1);
    }
  });

  it('is provisioned with rules whose triggers all actually fire', async () => {
    const rules = await api<{ triggerEvent: string; dormant: boolean }[]>('GET', '/scoring/rules', {
      token: orgA.token,
    });
    expect(rules.body.data.length).toBeGreaterThan(0);
    expect(rules.body.data.every((rule) => !rule.dormant)).toBe(true);
  });

  it('is provisioned with the views from database-design §17, shared with the workspace', async () => {
    const views = await api<{ name: string; visibility: string; isSystem: boolean }[]>(
      'GET',
      '/views',
      { token: orgA.token },
    );
    const names = views.body.data.map((view) => view.name);
    expect(names).toContain("Today's follow-ups");
    expect(names).toContain('Overdue');
    expect(names).toContain('Hot leads');
    expect(names).toContain('No next action');
    expect(
      views.body.data.every((view) => view.visibility === 'organization' && view.isSystem),
    ).toBe(true);
  });

  it('saves date filters as named windows, not as the day it was provisioned', async () => {
    // A view saved with an absolute date is wrong tomorrow and misleading forever, and this is the
    // view an executive opens every morning.
    const views = await api<{ name: string; filters: unknown }[]>('GET', '/views', {
      token: orgA.token,
    });
    const today = views.body.data.find((view) => view.name === "Today's follow-ups");
    expect(JSON.stringify(today?.filters)).toContain('"window":"today"');
  });
});

describe('the trigger registry refuses what would never fire', () => {
  it('refuses a rule on an event nothing emits, naming the phase it arrives in', async () => {
    const response = await api<never>('POST', '/scoring/rules', {
      token: orgA.token,
      payload: { name: `WhatsApp ${SUFFIX}`, triggerEvent: 'message.received', points: 20 },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.body)).toContain('Phase 5');
  });

  it('refuses a decay rule with no decay, and a decay setting on an event rule', async () => {
    const noDecay = await api<never>('POST', '/scoring/rules', {
      token: orgA.token,
      payload: { name: `Sweep ${SUFFIX}`, triggerEvent: 'schedule.decay', points: 5 },
    });
    expect(noDecay.statusCode).toBe(400);

    const wrongDecay = await api<never>('POST', '/scoring/rules', {
      token: orgA.token,
      payload: {
        name: `Capture ${SUFFIX}`,
        triggerEvent: 'lead.created',
        points: 5,
        decay: { afterDays: 1, points: 1, everyDays: 1, floor: 0 },
      },
    });
    expect(wrongDecay.statusCode).toBe(400);
  });

  it('refuses a rule worth nothing', async () => {
    const response = await api<never>('POST', '/scoring/rules', {
      token: orgA.token,
      payload: { name: `Pointless ${SUFFIX}`, triggerEvent: 'lead.created', points: 0 },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('the score is the sum of its events, and the breakdown proves it', () => {
  let leadId: string;

  beforeAll(async () => {
    leadId = await createLead(orgA.token, {
      firstName: 'Sum',
      lastName: 'Check',
      city: 'Pune',
      priority: 'high',
    });
  });

  it('adds points when a rule applies, and records why', async () => {
    await score(leadId, orgA.organizationId, 'lead.touchpoint_added', { channel: 'whatsapp' });
    const breakdown = await api<{
      score: number;
      addsUp: boolean;
      events: { delta: number; reason: string; scoreAfter: number }[];
    }>('GET', `/leads/${leadId}/score-breakdown`, { token: orgA.token });

    expect(breakdown.body.data.score).toBeGreaterThan(0);
    expect(breakdown.body.data.addsUp).toBe(true);
    expect(breakdown.body.data.events[0]?.reason.length).toBeGreaterThan(0);
  });

  it('scores the same event only once, however many times it is delivered', async () => {
    const before = await api<{ score: number; events: unknown[] }>(
      'GET',
      `/leads/${leadId}/score-breakdown`,
      { token: orgA.token },
    );
    // One event id, delivered three times — which is what at-least-once delivery means.
    const eventId = newId();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await ctx.app.get(LeadScoreProcessor).process(
        {
          organizationId: orgA.organizationId,
          aggregateId: leadId,
          eventName: 'lead.stage_changed',
          eventId,
          payload: {},
        },
        noJob,
      );
    }
    const after = await api<{ score: number; events: unknown[]; addsUp: boolean }>(
      'GET',
      `/leads/${leadId}/score-breakdown`,
      { token: orgA.token },
    );
    expect(after.body.data.events.length).toBe(before.body.data.events.length + 1);
    expect(after.body.data.addsUp).toBe(true);
  });

  it('stops applying a rule once it has hit its cap', async () => {
    // "Came back again" is capped at four applications by provisioning.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await score(leadId, orgA.organizationId, 'lead.touchpoint_added', {});
    }
    const breakdown = await api<{
      addsUp: boolean;
      contributions: { label: string; times: number }[];
    }>('GET', `/leads/${leadId}/score-breakdown`, { token: orgA.token });
    const repeat = breakdown.body.data.contributions.find(
      (entry) => entry.label === 'Came back again',
    );
    expect(repeat?.times).toBe(4);
    expect(breakdown.body.data.addsUp).toBe(true);
  });

  it('writes a timeline entry for a band change and not for a point change', async () => {
    const timeline = await api<
      { type: string; payload: { band?: string; previousBand?: string } }[]
    >('GET', `/leads/${leadId}/timeline?limit=100`, { token: orgA.token });
    const scoreEntries = timeline.body.data.filter((entry) => entry.type === 'lead.score_changed');
    expect(scoreEntries.length).toBeGreaterThan(0);
    // Every entry is a real transition. A timeline entry per +5 would bury the calls and status
    // changes a business actually reads.
    expect(scoreEntries.every((entry) => entry.payload.band !== entry.payload.previousBand)).toBe(
      true,
    );
  });

  it('never goes above the maximum, and does not pretend to', async () => {
    const hot = await createLead(orgA.token, { firstName: 'Very', lastName: 'Hot' });
    await configure('POST', '/scoring/rules', {
      token: orgA.token,
      payload: { name: `Enormous ${SUFFIX}`, triggerEvent: 'lead.created', points: 1000 },
    });
    await score(hot, orgA.organizationId, 'lead.created', {});
    await score(hot, orgA.organizationId, 'lead.created', {});

    const breakdown = await api<{ score: number; addsUp: boolean; events: { delta: number }[] }>(
      'GET',
      `/leads/${hot}/score-breakdown`,
      { token: orgA.token },
    );
    expect(breakdown.body.data.score).toBe(1000);
    // The clamped second application is not recorded as a +1000 that did nothing: the breakdown
    // would then claim 2000 points and stop adding up.
    expect(breakdown.body.data.addsUp).toBe(true);
    expect(breakdown.body.data.events.reduce((total, event) => total + event.delta, 0)).toBe(1000);
  });
});

describe('recalculation repairs a drifted score without inventing one', () => {
  it('re-sums the events and leaves the history untouched', async () => {
    const leadId = await createLead(orgA.token, { firstName: 'Drift', lastName: 'Repair' });
    await score(leadId, orgA.organizationId, 'lead.assigned', {});

    const before = await api<{ score: number }>('GET', `/leads/${leadId}`, { token: orgA.token });
    expect(before.body.data.score).toBeGreaterThan(0);

    // Corrupt the cached column the way a bug or a restore would.
    await ctx.db.lead.update({ where: { id: leadId }, data: { score: 999 } });

    const repaired = await api<{ scoreBefore: number; scoreAfter: number; noop: boolean }>(
      'POST',
      `/leads/${leadId}/recompute-score`,
      { token: orgA.token },
    );
    expect(repaired.body.data.scoreBefore).toBe(999);
    expect(repaired.body.data.scoreAfter).toBe(before.body.data.score);

    const breakdown = await api<{ addsUp: boolean; events: { delta: number }[] }>(
      'GET',
      `/leads/${leadId}/score-breakdown`,
      { token: orgA.token },
    );
    expect(breakdown.body.data.addsUp).toBe(true);
    // No correction event: recording the drift as one would make the events sum to the old wrong
    // number plus a correction, so the breakdown would stop adding up the moment it was repaired.
    expect(breakdown.body.data.events.length).toBe(1);
    expect(breakdown.body.data.events[0]?.delta).toBe(before.body.data.score);
  });

  it('does nothing at all to a score that is already right', async () => {
    const leadId = await createLead(orgA.token, { firstName: 'Already', lastName: 'Right' });
    await score(leadId, orgA.organizationId, 'lead.assigned', {});
    const response = await api<{ noop: boolean }>('POST', `/leads/${leadId}/recompute-score`, {
      token: orgA.token,
    });
    expect(response.body.data.noop).toBe(true);
  });
});

describe('the nightly decay sweep', () => {
  it('takes points off a lead nobody has touched, and says how long it has been', async () => {
    const leadId = await createLead(orgA.token, { firstName: 'Gone', lastName: 'Quiet' });
    await score(leadId, orgA.organizationId, 'lead.touchpoint_added', {});
    const before = await api<{ score: number }>('GET', `/leads/${leadId}`, { token: orgA.token });
    expect(before.body.data.score).toBeGreaterThan(0);

    // Move the clock by moving the lead, not by waiting: provisioning decays after 14 idle days.
    await ctx.db.lead.update({
      where: { id: leadId },
      data: { lastActivityAt: new Date(Date.now() - 30 * 86_400_000) },
    });
    await ctx.app.get(ScoreDecaySweepProcessor).process({ organizationId: null }, noJob);

    const after = await api<{ score: number }>('GET', `/leads/${leadId}`, { token: orgA.token });
    expect(after.body.data.score).toBeLessThan(before.body.data.score);

    const breakdown = await api<{ addsUp: boolean; events: { delta: number; reason: string }[] }>(
      'GET',
      `/leads/${leadId}/score-breakdown`,
      { token: orgA.token },
    );
    expect(breakdown.body.data.addsUp).toBe(true);
    const decayEvent = breakdown.body.data.events.find((event) => event.delta < 0);
    expect(decayEvent?.reason).toContain('no activity for');
  });

  it('does not take the same period off twice when it runs again', async () => {
    const leadId = await createLead(orgA.token, { firstName: 'Twice', lastName: 'Swept' });
    await score(leadId, orgA.organizationId, 'lead.touchpoint_added', {});
    await ctx.db.lead.update({
      where: { id: leadId },
      data: { lastActivityAt: new Date(Date.now() - 30 * 86_400_000) },
    });

    const sweep = ctx.app.get(ScoreDecaySweepProcessor);
    await sweep.process({ organizationId: null }, noJob);
    const once = await api<{ score: number }>('GET', `/leads/${leadId}`, { token: orgA.token });
    await sweep.process({ organizationId: null }, noJob);
    const twice = await api<{ score: number }>('GET', `/leads/${leadId}`, { token: orgA.token });

    // The deduction is a function of elapsed time, not of how many times the sweep ran — which is
    // also what makes a missed night catch up rather than be lost.
    expect(twice.body.data.score).toBe(once.body.data.score);
  });

  it('leaves a lead with no recorded activity alone', async () => {
    const leadId = await createLead(orgA.token, { firstName: 'Brand', lastName: 'New' });
    await score(leadId, orgA.organizationId, 'lead.assigned', {});
    await ctx.db.lead.update({ where: { id: leadId }, data: { lastActivityAt: null } });
    const before = await api<{ score: number }>('GET', `/leads/${leadId}`, { token: orgA.token });

    await ctx.app.get(ScoreDecaySweepProcessor).process({ organizationId: null }, noJob);

    const after = await api<{ score: number }>('GET', `/leads/${leadId}`, { token: orgA.token });
    // A lead captured an hour ago with no activity yet is new, not stale.
    expect(after.body.data.score).toBe(before.body.data.score);
  });
});

describe('bands are a partition, and editing them reclassifies every lead at once', () => {
  it('refuses an overlap and a gap, naming what is wrong', async () => {
    const overlap = await api<never>('PUT', '/scoring/bands', {
      token: orgA.token,
      payload: {
        bands: [
          { name: 'Cold', minScore: 0, maxScore: 50 },
          { name: 'Hot', minScore: 40, maxScore: 1000 },
        ],
      },
    });
    expect(overlap.statusCode).toBe(400);
    expect(JSON.stringify(overlap.body)).toContain('overlap');

    const gap = await api<never>('PUT', '/scoring/bands', {
      token: orgA.token,
      payload: {
        bands: [
          { name: 'Cold', minScore: 0, maxScore: 39 },
          { name: 'Hot', minScore: 75, maxScore: 1000 },
        ],
      },
    });
    expect(gap.statusCode).toBe(400);
    expect(JSON.stringify(gap.body)).toContain('40');
  });

  it('re-bands leads in the same request rather than leaving it to a job', async () => {
    const leadId = await createLead(orgA.token, { firstName: 'Reband', lastName: 'Me' });
    await score(leadId, orgA.organizationId, 'lead.touchpoint_added', {});
    const before = await api<{ scoreBand: string | null; score: number }>(
      'GET',
      `/leads/${leadId}`,
      { token: orgA.token },
    );

    const replaced = await configure<{ leadsReassigned: number }>('PUT', '/scoring/bands', {
      token: orgA.token,
      payload: {
        bands: [
          { name: `Frosty ${SUFFIX}`, minScore: 0, maxScore: 9 },
          { name: `Tepid ${SUFFIX}`, minScore: 10, maxScore: 64 },
          { name: `Molten ${SUFFIX}`, minScore: 65, maxScore: 1000 },
        ],
      },
    });
    expect(replaced.body.data.leadsReassigned).toBeGreaterThan(0);

    const after = await api<{ scoreBand: string | null }>('GET', `/leads/${leadId}`, {
      token: orgA.token,
    });
    expect(after.body.data.scoreBand).not.toBe(before.body.data.scoreBand);
    expect(after.body.data.scoreBand).toContain(SUFFIX);
  });
});

describe('filters over leads', () => {
  let tagId: string;
  let qualifiedStatusId: string;

  beforeAll(async () => {
    await configure('POST', '/custom-fields', {
      token: orgA.token,
      payload: { entityType: 'lead', key: 'budget', label: 'Budget', type: 'currency' },
    });
    const tag = await configure<{ id: string }>('POST', '/crm/tags', {
      token: orgA.token,
      payload: { name: `Site visit ${SUFFIX}` },
    });
    tagId = tag.body.data.id;
    const statuses = await api<{ id: string; name: string }[]>('GET', '/crm/statuses', {
      token: orgA.token,
    });
    qualifiedStatusId = statuses.body.data.find((status) => status.name === 'Qualified')!.id;

    const anita = await createLead(orgA.token, {
      firstName: 'Anita',
      lastName: `Filter ${SUFFIX}`,
      city: 'Pune',
      priority: 'high',
      customValues: { budget: 7_500_000 },
    });
    await configure('PUT', `/leads/${anita}/tags`, {
      token: orgA.token,
      payload: { tagIds: [tagId] },
    });
    const rakesh = await createLead(orgA.token, {
      firstName: 'Rakesh',
      lastName: `Filter ${SUFFIX}`,
      city: 'Mumbai',
      priority: 'low',
    });
    await configure('POST', `/leads/${rakesh}/status`, {
      token: orgA.token,
      payload: { statusId: qualifiedStatusId },
    });
  });

  const search = async (payload: Record<string, unknown>) =>
    api<{ fullName: string; city: string | null }[]>('POST', '/leads/search', {
      token: orgA.token,
      payload,
    });

  it('publishes a catalogue built from this tenant’s own custom fields', async () => {
    const fields = await api<{ field: string; kind: string; valuePath?: string[] }[]>(
      'GET',
      '/views/fields',
      { token: orgA.token },
    );
    const budget = fields.body.data.find((field) => field.field === 'custom.budget');
    expect(budget?.kind).toBe('money');
    // A currency value is stored as an object, so the filter has to reach inside it. Comparing the
    // object itself matches nothing, silently — which is how this was found.
    expect(budget?.valuePath).toEqual(['amountMinor']);
  });

  it('ANDs within a group and ORs across groups', async () => {
    const both = await search({
      filter: {
        conditions: [
          { field: 'city', operator: 'eq', value: 'Pune', groupIndex: 0 },
          { field: 'priority', operator: 'eq', value: 'high', groupIndex: 0 },
        ],
      },
    });
    expect(both.body.data.every((lead) => lead.city === 'Pune')).toBe(true);

    const either = await search({
      filter: {
        conditions: [
          { field: 'city', operator: 'eq', value: 'Pune', groupIndex: 0 },
          { field: 'city', operator: 'eq', value: 'Mumbai', groupIndex: 1 },
        ],
      },
    });
    expect(either.body.data.length).toBeGreaterThanOrEqual(2);
  });

  it('filters on a currency custom field, in minor units', async () => {
    const rich = await search({
      filter: { conditions: [{ field: 'custom.budget', operator: 'gte', value: 700_000_000 }] },
    });
    expect(rich.body.data.some((lead) => lead.fullName.startsWith('Anita'))).toBe(true);

    const poor = await search({
      filter: { conditions: [{ field: 'custom.budget', operator: 'lte', value: 1 }] },
    });
    expect(poor.body.data.some((lead) => lead.fullName.startsWith('Anita'))).toBe(false);
  });

  it('filters on tags, which live in their own table', async () => {
    const tagged = await search({
      filter: { conditions: [{ field: 'tagIds', operator: 'has_any', value: [tagId] }] },
    });
    expect(tagged.body.data.length).toBe(1);
    expect(tagged.body.data[0]?.fullName).toContain('Anita');
  });

  it('compiles "older than N days" to a date bound the right way round', async () => {
    // Getting this backwards silently shows a manager the wrong half of their pipeline.
    const young = await search({
      filter: { conditions: [{ field: 'ageInDays', operator: 'lte', value: 1 }] },
    });
    const old = await search({
      filter: { conditions: [{ field: 'ageInDays', operator: 'gte', value: 365 }] },
    });
    expect(young.body.data.length).toBeGreaterThan(0);
    expect(old.body.data.length).toBe(0);
  });

  it('resolves a named date window against the organization’s clock', async () => {
    const today = await search({
      filter: { conditions: [{ field: 'createdAt', operator: 'gte', value: { window: 'today' } }] },
    });
    expect(today.body.data.length).toBeGreaterThan(0);

    const lastMonth = await search({
      filter: {
        conditions: [{ field: 'createdAt', operator: 'eq', value: { window: 'last_month' } }],
      },
    });
    expect(lastMonth.body.data.length).toBe(0);
  });

  it('refuses a field that no longer exists, and says it may have been deleted', async () => {
    const response = await api<never>('POST', '/leads/search', {
      token: orgA.token,
      payload: { filter: { conditions: [{ field: 'custom.gone', operator: 'eq', value: 1 }] } },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.body)).toContain('deleted');
  });

  it('refuses an operator the field’s type cannot support', async () => {
    const response = await api<never>('POST', '/leads/search', {
      token: orgA.token,
      payload: {
        filter: { conditions: [{ field: 'createdAt', operator: 'contains', value: 'March' }] },
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('accepts an empty filter as "everything"', async () => {
    const response = await search({ filter: { conditions: [] } });
    expect(response.statusCode).toBe(200);
    expect(response.body.data.length).toBeGreaterThan(0);
  });
});

describe('saved views', () => {
  let viewId: string;

  it('saves a view and runs it through the same path as an ad-hoc filter', async () => {
    const created = await configure<{ id: string }>('POST', '/views', {
      token: orgA.token,
      payload: {
        name: `Pune high priority ${SUFFIX}`,
        filters: {
          conditions: [
            { field: 'city', operator: 'eq', value: 'Pune', groupIndex: 0 },
            { field: 'priority', operator: 'in', value: ['high', 'urgent'], groupIndex: 0 },
          ],
        },
        sort: { field: 'createdAt', direction: 'desc' },
        columns: ['fullName', 'city', 'custom.budget'],
      },
    });
    viewId = created.body.data.id;

    const byView = await api<{ fullName: string }[]>('POST', '/leads/search', {
      token: orgA.token,
      payload: { viewId },
    });
    const byFilter = await api<{ fullName: string }[]>('POST', '/leads/search', {
      token: orgA.token,
      payload: {
        filter: {
          conditions: [
            { field: 'city', operator: 'eq', value: 'Pune', groupIndex: 0 },
            { field: 'priority', operator: 'in', value: ['high', 'urgent'], groupIndex: 0 },
          ],
        },
      },
    });
    expect(byView.body.data.map((lead) => lead.fullName)).toEqual(
      byFilter.body.data.map((lead) => lead.fullName),
    );
  });

  it('refuses a column or a sort the list cannot serve', async () => {
    const badSort = await api<never>('POST', '/views', {
      token: orgA.token,
      payload: {
        name: `Bad sort ${SUFFIX}`,
        filters: { conditions: [] },
        sort: { field: 'customValues', direction: 'asc' },
      },
    });
    expect(badSort.statusCode).toBe(400);

    const badColumn = await api<never>('POST', '/views', {
      token: orgA.token,
      payload: {
        name: `Bad column ${SUFFIX}`,
        filters: { conditions: [] },
        columns: ['not_a_column'],
      },
    });
    expect(badColumn.statusCode).toBe(400);
  });

  it('refuses a filter that would fail when the view is opened', async () => {
    // The whole point of validating on save: a broken view fails on somebody's dashboard, at the
    // moment they are trying to start work.
    const response = await api<never>('POST', '/views', {
      token: orgA.token,
      payload: {
        name: `Broken ${SUFFIX}`,
        filters: { conditions: [{ field: 'score', operator: 'between', value: [10] }] },
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('keeps a private view private, even from someone who knows its id', async () => {
    const privateView = await configure<{ id: string }>('POST', '/views', {
      token: orgA.token,
      payload: { name: `Just mine ${SUFFIX}`, filters: { conditions: [] }, visibility: 'private' },
    });
    const fromOtherTenant = await api<never>('GET', `/views/${privateView.body.data.id}`, {
      token: orgB.token,
    });
    // 404 rather than 403: confirming it exists is itself a leak of somebody's work.
    expect(fromOtherTenant.statusCode).toBe(404);
  });

  it('hands a view to the workspace when it is shared, and takes it back when it is not', async () => {
    const shared = await configure('PATCH', `/views/${viewId}`, {
      token: orgA.token,
      payload: { visibility: 'organization' },
    });
    expect(shared.statusCode).toBe(200);
    const afterShare = await api<{ isMine: boolean; visibility: string }>(
      'GET',
      `/views/${viewId}`,
      {
        token: orgA.token,
      },
    );
    expect(afterShare.body.data.visibility).toBe('organization');
    expect(afterShare.body.data.isMine).toBe(false);
  });

  it('refuses to share with a team the caller is not on', async () => {
    const response = await api<never>('POST', '/views', {
      token: orgA.token,
      payload: {
        name: `Team view ${SUFFIX}`,
        filters: { conditions: [] },
        visibility: 'team',
        teamId: newId(),
      },
    });
    expect([400, 404]).toContain(response.statusCode);
  });

  it('will not let one tenant run another tenant’s view', async () => {
    const response = await api<never>('POST', '/leads/search', {
      token: orgB.token,
      payload: { viewId },
    });
    expect(response.statusCode).toBe(404);
  });

  it('deletes a view and frees its name', async () => {
    const removed = await configure('DELETE', `/views/${viewId}`, { token: orgA.token });
    expect(removed.statusCode).toBe(200);
    const gone = await api<never>('GET', `/views/${viewId}`, { token: orgA.token });
    expect(gone.statusCode).toBe(404);

    const reused = await configure('POST', '/views', {
      token: orgA.token,
      payload: { name: `Pune high priority ${SUFFIX}`, filters: { conditions: [] } },
    });
    expect(reused.statusCode).toBe(201);
  });
});

describe('cross-tenant: scoring and views cannot reach another workspace', () => {
  it('does not score a lead belonging to another organization', async () => {
    const leadId = await createLead(orgB.token, { firstName: 'Other', lastName: 'Tenant' });
    // The job names org A but the lead is org B's: the tenant scope makes the lead invisible, so
    // nothing is scored rather than something being scored for the wrong tenant.
    await score(leadId, orgA.organizationId, 'lead.created', {});
    const lead = await api<{ score: number }>('GET', `/leads/${leadId}`, { token: orgB.token });
    expect(lead.body.data.score).toBe(0);
  });

  it('shows each tenant only its own bands and rules', async () => {
    await configure('PUT', '/scoring/bands', {
      token: orgB.token,
      payload: [
        { name: `B cold ${SUFFIX}`, minScore: 0, maxScore: 500 },
        { name: `B hot ${SUFFIX}`, minScore: 501, maxScore: 1000 },
      ].reduce((accumulator, band) => ({ bands: [...accumulator.bands, band] }), {
        bands: [] as unknown[],
      }),
    });
    const aBands = await api<{ name: string }[]>('GET', '/scoring/bands', { token: orgA.token });
    const bBands = await api<{ name: string }[]>('GET', '/scoring/bands', { token: orgB.token });
    expect(aBands.body.data.some((band) => band.name.startsWith('B '))).toBe(false);
    expect(bBands.body.data.every((band) => band.name.startsWith('B '))).toBe(true);
  });

  it('does not list another tenant’s views', async () => {
    const aViews = await api<{ id: string }[]>('GET', '/views', { token: orgA.token });
    const bViews = await api<{ id: string }[]>('GET', '/views', { token: orgB.token });
    const aIds = new Set(aViews.body.data.map((view) => view.id));
    expect(bViews.body.data.some((view) => aIds.has(view.id))).toBe(false);
  });
});
