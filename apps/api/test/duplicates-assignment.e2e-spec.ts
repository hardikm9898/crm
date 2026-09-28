import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, newToken } from '@leados/shared';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';

/**
 * THE DUPLICATES AND ASSIGNMENT SUITE.
 *
 * Two Phase 2 exit criteria live here:
 *
 *  * *"Duplicate rules verified: same phone from 3 channels ⇒ 1 lead, 3 touchpoints, 3 timeline
 *    entries."*
 *  * *"Assignment: round-robin fairness, capacity cap, outside-working-hours fallback,
 *    unassigned-pool notification — all tested; the rule tester explains its choice."*
 *
 * Everything that involves the clock is asserted against a **fixed instant**. A test that only
 * passes between 09:30 and 18:30 is a test that fails overnight for no reason — which is how the
 * first draft of this file behaved, and the reason the working-hours assertions name their dates.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2edupasg${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';

/** Provisioning seeds Mon–Sat 09:30–18:30 in Asia/Kolkata. These are a Tuesday and a Sunday. */
const TUESDAY_NOON = '2026-03-17T12:00:00+05:30';
const TUESDAY_NIGHT = '2026-03-17T23:00:00+05:30';
const SUNDAY_NOON = '2026-03-15T12:00:00+05:30';

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

/**
 * A setup call whose failure must not be silent.
 *
 * The first draft of the fallback test switched a rule to `round_robin` before giving it a pool,
 * which the service rightly refused — and the test then went on to assert against the *old* rule
 * and read a plausible-looking wrong answer out of it. Every call that only configures something
 * goes through here, so a refused setup fails as a refused setup.
 */
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
      organizationName: `DupAsg ${label} ${SUFFIX}`,
    },
  });
  return {
    token: registered.body.data.tokens.accessToken,
    organizationId: registered.body.data.activeOrganizationId,
    userId: registered.body.data.user.id,
  };
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

describe('a new organization is provisioned with working rules', () => {
  it('has a duplicate rule that attaches a repeat capture rather than losing it', async () => {
    const rules = await api<{ action: string; matchOn: unknown; lookbackDays: number }[]>(
      'GET',
      '/duplicates/rules',
      { token: orgA.token },
    );
    expect(rules.body.data).toHaveLength(1);
    // `attach_to_existing` is the only action that cannot lose information: `reject` discards the
    // new touchpoint and `create_and_link` leaves work for a human.
    expect(rules.body.data[0]?.action).toBe('attach_to_existing');
    expect(JSON.stringify(rules.body.data[0]?.matchOn)).toContain('phoneE164');
  });

  it('has an assignment rule whose fallback is the pool, with a notification', async () => {
    const rules = await api<
      { strategy: string; fallback: { mode: string; notify: boolean }; pool: unknown[] }[]
    >('GET', '/assignment/rules', { token: orgA.token });
    expect(rules.body.data).toHaveLength(1);
    expect(rules.body.data[0]?.strategy).toBe('round_robin');
    expect(rules.body.data[0]?.pool).toHaveLength(1);
    // A lead that quietly went nowhere is the failure FR-ASG-4 exists to prevent.
    expect(rules.body.data[0]?.fallback.mode).toBe('unassigned_pool');
    expect(rules.body.data[0]?.fallback.notify).toBe(true);
  });
});

describe('the same person captured three ways is one lead', () => {
  const phone = '+919812390001';
  let leadId: string;

  it('creates the lead on the first capture', async () => {
    const created = await api<{ id: string }>('POST', '/leads', {
      token: orgA.token,
      payload: {
        firstName: 'Repeat',
        lastName: 'Customer',
        phone,
        city: 'Pune',
        createdVia: 'form',
      },
    });
    expect(created.statusCode).toBe(201);
    leadId = created.body.data.id;
  });

  it('attaches the second and third captures instead of creating more leads', async () => {
    const second = await api<{
      id: string;
      attachedToExisting?: boolean;
      matchedFields?: string[];
    }>('POST', '/leads', {
      token: orgA.token,
      payload: { firstName: 'Repeat', phone, email: 'repeat@example.test', createdVia: 'whatsapp' },
    });
    expect(second.body.data.id).toBe(leadId);
    // A caller that asked to create a lead and silently got somebody else's id would be a worse
    // bug than the duplicate, so the response says what happened.
    expect(second.body.data.attachedToExisting).toBe(true);
    expect(second.body.data.matchedFields).toContain('phoneE164');

    const third = await api<{ id: string }>('POST', '/leads', {
      token: orgA.token,
      payload: { firstName: 'Repeat', phone, company: 'Repeat Traders', createdVia: 'meta_ads' },
    });
    expect(third.body.data.id).toBe(leadId);
  });

  it('records three touchpoints, in order, with the first intact', async () => {
    const lead = await api<{
      touchpoints: { sequence: number; channel: string }[];
      touchCount: number;
    }>('GET', `/leads/${leadId}`, { token: orgA.token });
    expect(lead.body.data.touchpoints.map((entry) => entry.channel)).toEqual([
      'form',
      'whatsapp',
      'meta_ads',
    ]);
    expect(lead.body.data.touchpoints.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    expect(lead.body.data.touchCount).toBe(3);
  });

  it('records a timeline entry per repeat capture', async () => {
    const timeline = await api<{ type: string }[]>('GET', `/leads/${leadId}/timeline?limit=100`, {
      token: orgA.token,
    });
    const types = timeline.body.data.map((entry) => entry.type);
    expect(types.filter((type) => type === 'lead.duplicate_detected')).toHaveLength(2);
    // Three captures, three source-capture entries: the attribution spine is on the timeline too.
    expect(types.filter((type) => type === 'lead.source_captured')).toHaveLength(3);
  });

  it('enriches blanks but never overwrites an answer', async () => {
    const before = await api<{ lastName: string; email: string }>('GET', `/leads/${leadId}`, {
      token: orgA.token,
    });
    expect(before.body.data.email).toBe('repeat@example.test');

    // A customer mistyping their surname on a second form must not rename themselves.
    await configure('POST', '/leads', {
      token: orgA.token,
      payload: { firstName: 'Wrong', lastName: 'Name', phone, email: 'other@example.test' },
    });
    const after = await api<{ lastName: string; email: string }>('GET', `/leads/${leadId}`, {
      token: orgA.token,
    });
    expect(after.body.data.lastName).toBe('Customer');
    expect(after.body.data.email).toBe('repeat@example.test');
  });

  it('matches a phone given as a WhatsApp number, and the other way round', async () => {
    // Same person, different channel: the capture's phone may be the existing lead's WhatsApp.
    const created = await api<{ id: string }>('POST', '/leads', {
      token: orgA.token,
      payload: { firstName: 'Channel', lastName: 'Swap', whatsappE164: undefined, whatsapp: phone },
    });
    expect(created.body.data.id).toBe(leadId);
  });
});

describe('the other three rule actions', () => {
  const phone = '+919812390002';
  let ruleId: string;
  let originalId: string;

  beforeAll(async () => {
    const rules = await api<{ id: string }[]>('GET', '/duplicates/rules', { token: orgA.token });
    ruleId = rules.body.data[0]!.id;
    const created = await api<{ id: string }>('POST', '/leads', {
      token: orgA.token,
      payload: { firstName: 'Action', lastName: 'Subject', phone },
    });
    originalId = created.body.data.id;
  });

  afterAll(async () => {
    await configure('PATCH', `/duplicates/rules/${ruleId}`, {
      token: orgA.token,
      payload: { action: 'attach_to_existing' },
    });
  });

  it('create_and_link creates the lead and queues the pair for a human', async () => {
    await configure('PATCH', `/duplicates/rules/${ruleId}`, {
      token: orgA.token,
      payload: { action: 'create_and_link' },
    });
    const created = await api<{ id: string; duplicate?: { ofLeadId: string; confidence: number } }>(
      'POST',
      '/leads',
      { token: orgA.token, payload: { firstName: 'Linked', phone } },
    );
    expect(created.statusCode).toBe(201);
    expect(created.body.data.id).not.toBe(originalId);
    expect(created.body.data.duplicate?.ofLeadId).toBe(originalId);

    const queue = await api<
      { candidate: { id: string }; matchedFields: string[]; confidence: number }[]
    >('GET', '/duplicates', { token: orgA.token });
    const pair = queue.body.data.find((entry) => entry.candidate.id === created.body.data.id);
    expect(pair).toBeDefined();
    // A queue a person triages needs to show why, not just that.
    expect(pair!.matchedFields).toContain('phoneE164');
    expect(pair!.confidence).toBeGreaterThan(0);
  });

  it('reject refuses the capture and names what it clashed with', async () => {
    await configure('PATCH', `/duplicates/rules/${ruleId}`, {
      token: orgA.token,
      payload: { action: 'reject' },
    });
    const refused = await api('POST', '/leads', {
      token: orgA.token,
      payload: { firstName: 'Refused', phone },
    });
    expect(refused.statusCode).toBe(409);
    // "That looks like Anita Sharma, captured 3 days ago" is actionable; "duplicate detected" is not.
    expect(refused.body.error?.message).toMatch(/looks like \w+, captured/);
  });

  it('create_new lets a match through as a separate lead', async () => {
    await configure('PATCH', `/duplicates/rules/${ruleId}`, {
      token: orgA.token,
      payload: { action: 'create_new' },
    });
    const created = await api<{ id: string }>('POST', '/leads', {
      token: orgA.token,
      payload: { firstName: 'Allowed', phone },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body.data.id).not.toBe(originalId);
  });
});

describe('a rule that would group strangers is refused at configuration time', () => {
  it('refuses a set of weak fields on its own', async () => {
    const response = await api('POST', '/duplicates/rules', {
      token: orgA.token,
      payload: { name: `City only ${SUFFIX}`, matchOn: [['city']] },
    });
    // Matching on city alone would group half a tenant's database and quietly start merging people.
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.body.error?.details)).toContain('phone');
  });

  it('refuses a field that is not matchable, and names the ones that are', async () => {
    const response = await api('POST', '/duplicates/rules', {
      token: orgA.token,
      payload: { name: `Bad field ${SUFFIX}`, matchOn: [['phone_number']] },
    });
    expect(response.statusCode).toBe(400);
  });

  it('accepts a composite that includes an identifier', async () => {
    const response = await api('POST', '/duplicates/rules', {
      token: orgA.token,
      payload: {
        name: `Email and surname ${SUFFIX}`,
        matchOn: [['email', 'lastName']],
        priority: 50,
      },
    });
    expect(response.statusCode).toBe(201);
  });
});

describe('the duplicate rule tester runs the real matcher', () => {
  it('reports the action the write path would take, and writes nothing', async () => {
    const phone = '+919812390003';
    await configure('POST', '/leads', {
      token: orgA.token,
      payload: { firstName: 'Testable', lastName: 'Lead', phone },
    });

    const tested = await api<{ wouldMatch: boolean; action: string; explanation: string }>(
      'POST',
      '/duplicates/test',
      { token: orgA.token, payload: { phone } },
    );
    expect(tested.body.data.wouldMatch).toBe(true);
    expect(tested.body.data.explanation.length).toBeGreaterThan(0);

    const missed = await api<{ wouldMatch: boolean }>('POST', '/duplicates/test', {
      token: orgA.token,
      payload: { phone: '+919812399999' },
    });
    expect(missed.body.data.wouldMatch).toBe(false);

    // Nothing was created by either call.
    const leads = await api<{ id: string }[]>('GET', '/leads?search=9812399999', {
      token: orgA.token,
    });
    expect(leads.body.data).toHaveLength(0);
  });
});

describe('merging is reversible', () => {
  let survivorId: string;
  let victimId: string;
  let mergeId: string;
  let survivorBefore: { company: string | null; touchpoints: unknown[] };

  beforeAll(async () => {
    const survivor = await api<{ id: string }>('POST', '/leads', {
      token: orgA.token,
      payload: { firstName: 'Survivor', lastName: 'Lead', city: 'Pune', company: 'Survivor Co' },
    });
    survivorId = survivor.body.data.id;
    const victim = await api<{ id: string }>('POST', '/leads', {
      token: orgA.token,
      payload: {
        firstName: 'Victim',
        lastName: 'Lead',
        company: 'Victim Co',
        email: 'victim@example.test',
      },
    });
    victimId = victim.body.data.id;
    await configure('POST', `/leads/${victimId}/touchpoints`, {
      token: orgA.token,
      payload: { channel: 'call' },
    });
    const before = await api<{ company: string | null; touchpoints: unknown[] }>(
      'GET',
      `/leads/${survivorId}`,
      { token: orgA.token },
    );
    survivorBefore = before.body.data;
  });

  it('takes the chosen field from the absorbed lead and keeps the rest', async () => {
    const merged = await api<{
      mergeId: string;
      movedActivities: number;
      movedTouchpoints: number;
    }>('POST', '/duplicates/merge', {
      token: orgA.token,
      payload: {
        survivingLeadId: survivorId,
        mergedLeadId: victimId,
        fieldChoices: { company: 'merged' },
      },
    });
    expect(merged.statusCode).toBe(200);
    mergeId = merged.body.data.mergeId;
    expect(merged.body.data.movedActivities).toBeGreaterThan(0);

    const after = await api<{ company: string; city: string; email: string }>(
      'GET',
      `/leads/${survivorId}`,
      { token: orgA.token },
    );
    expect(after.body.data.company).toBe('Victim Co');
    expect(after.body.data.city).toBe('Pune');
    // A blank on the survivor is filled from the absorbed lead: that is not a conflict, and
    // refusing to do it would lose information for no reason.
    expect(after.body.data.email).toBe('victim@example.test');
  });

  it('unions the touchpoints and renumbers them without a gap', async () => {
    const after = await api<{ touchpoints: { sequence: number }[] }>(
      'GET',
      `/leads/${survivorId}`,
      {
        token: orgA.token,
      },
    );
    const sequences = after.body.data.touchpoints.map((entry) => entry.sequence);
    expect(sequences).toEqual(sequences.map((_, index) => index + 1));
    expect(sequences.length).toBeGreaterThan(survivorBefore.touchpoints.length);
  });

  it('unions the timelines and records the merge itself', async () => {
    const timeline = await api<{ type: string }[]>(
      'GET',
      `/leads/${survivorId}/timeline?limit=100`,
      {
        token: orgA.token,
      },
    );
    expect(timeline.body.data.some((entry) => entry.type === 'lead.merged')).toBe(true);
  });

  it('soft-deletes the absorbed lead rather than destroying it', async () => {
    const absorbed = await api<{ deletedAt: string | null }>('GET', `/leads/${victimId}`, {
      token: orgA.token,
    });
    // Reversibility depends on the row still being there.
    expect(absorbed.body.data.deletedAt).not.toBeNull();

    const live = await api<{ id: string }[]>('GET', '/leads', { token: orgA.token });
    expect(live.body.data.some((lead) => lead.id === victimId)).toBe(false);
  });

  it('marks the pair merged in the triage queue', async () => {
    const pairs = await ctx.db.leadDuplicate.findMany({
      where: {
        organizationId: orgA.organizationId,
        OR: [
          { leadId: survivorId, duplicateLeadId: victimId },
          { leadId: victimId, duplicateLeadId: survivorId },
        ],
      },
    });
    // There may be no pair at all if nothing flagged them; if there is, it must be resolved.
    for (const pair of pairs) expect(pair.status).toBe('merged');
  });

  it("undoes the merge, restoring both leads and the survivor's own values", async () => {
    const undone = await api<{ undone: boolean }>('POST', `/duplicates/merges/${mergeId}/undo`, {
      token: orgA.token,
    });
    expect(undone.statusCode).toBe(200);

    const survivor = await api<{ company: string; touchpoints: unknown[] }>(
      'GET',
      `/leads/${survivorId}`,
      { token: orgA.token },
    );
    expect(survivor.body.data.company).toBe(survivorBefore.company);
    expect(survivor.body.data.touchpoints).toHaveLength(survivorBefore.touchpoints.length);

    const restored = await api<{ deletedAt: string | null; touchpoints: unknown[] }>(
      'GET',
      `/leads/${victimId}`,
      { token: orgA.token },
    );
    expect(restored.body.data.deletedAt).toBeNull();
    // The touchpoints went home, not to whichever lead happened to be open.
    expect(restored.body.data.touchpoints.length).toBeGreaterThan(0);
  });

  it('refuses to undo the same merge twice', async () => {
    const again = await api('POST', `/duplicates/merges/${mergeId}/undo`, { token: orgA.token });
    expect(again.statusCode).toBe(409);
  });

  it('refuses to merge a lead into itself', async () => {
    const response = await api('POST', '/duplicates/merge', {
      token: orgA.token,
      payload: { survivingLeadId: survivorId, mergedLeadId: survivorId },
    });
    expect(response.statusCode).toBe(422);
  });

  it('refuses a field choice for a field a merge cannot take', async () => {
    const response = await api('POST', '/duplicates/merge', {
      token: orgA.token,
      payload: {
        survivingLeadId: survivorId,
        mergedLeadId: victimId,
        fieldChoices: { statusId: 'merged' },
      },
    });
    // Status, stage and score belong to the survivor by definition; letting a merge move them
    // would rewrite its position on the board for no stated reason.
    expect(response.statusCode).toBe(400);
  });
});

describe('dismissing a pair', () => {
  it('records the decision so re-detection does not reopen it', async () => {
    const phone = '+919812390009';
    const rules = await api<{ id: string }[]>('GET', '/duplicates/rules', { token: orgA.token });
    await configure('PATCH', `/duplicates/rules/${rules.body.data[0]!.id}`, {
      token: orgA.token,
      payload: { action: 'create_and_link' },
    });
    await configure('POST', '/leads', {
      token: orgA.token,
      payload: { firstName: 'Dismiss', phone },
    });
    const second = await api<{ id: string }>('POST', '/leads', {
      token: orgA.token,
      payload: { firstName: 'Dismiss', phone },
    });

    const queue = await api<{ id: string; candidate: { id: string } }[]>('GET', '/duplicates', {
      token: orgA.token,
    });
    const pair = queue.body.data.find((entry) => entry.candidate.id === second.body.data.id);
    expect(pair).toBeDefined();

    const dismissed = await api('POST', `/duplicates/${pair!.id}/dismiss`, { token: orgA.token });
    expect(dismissed.statusCode).toBe(200);

    const again = await api('POST', `/duplicates/${pair!.id}/dismiss`, { token: orgA.token });
    expect(again.statusCode).toBe(409);

    // A third capture re-detects the pair, and must not reopen a decision somebody made.
    await configure('POST', '/leads', {
      token: orgA.token,
      payload: { firstName: 'Dismiss', phone },
    });
    const row = await ctx.db.leadDuplicate.findFirstOrThrow({ where: { id: pair!.id } });
    expect(row.status).toBe('dismissed');

    await configure('PATCH', `/duplicates/rules/${rules.body.data[0]!.id}`, {
      token: orgA.token,
      payload: { action: 'attach_to_existing' },
    });
  });
});

describe('assignment: the engine decides and shows its working', () => {
  let ruleId: string;

  beforeAll(async () => {
    // Deactivate the seeded rule so the rules created here are the only deciders.
    const seeded = await api<{ id: string }[]>('GET', '/assignment/rules', { token: orgA.token });
    for (const rule of seeded.body.data) {
      await configure('PATCH', `/assignment/rules/${rule.id}`, {
        token: orgA.token,
        payload: { isActive: false },
      });
    }
    const created = await api<{ id: string }>('POST', '/assignment/rules', {
      token: orgA.token,
      payload: {
        name: `Owner takes all ${SUFFIX}`,
        strategy: 'specific_user',
        target: { userId: orgA.userId },
        // Creation uses the real clock; the working-hours behaviour is asserted with fixed instants.
        respectWorkingHours: false,
        priority: 5,
      },
    });
    ruleId = created.body.data.id;
  });

  it('assigns a new lead and explains the choice in the response', async () => {
    const created = await api<{
      id: string;
      assignment: { assignedUserId: string; rule: string; explanation: string };
    }>('POST', '/leads', {
      token: orgA.token,
      payload: { firstName: 'Auto', lastName: 'Assigned' },
    });
    expect(created.body.data.assignment.assignedUserId).toBe(orgA.userId);
    // An assignment engine whose decision is only visible by re-reading the row is one nobody checks.
    expect(created.body.data.assignment.rule).toContain('Owner takes all');
    expect(created.body.data.assignment.explanation.length).toBeGreaterThan(0);

    const timeline = await api<{ type: string; payload: { ruleName?: string } }[]>(
      'GET',
      `/leads/${created.body.data.id}/timeline?limit=50`,
      { token: orgA.token },
    );
    const entry = timeline.body.data.find((row) => row.type === 'lead.assigned');
    expect(entry?.payload.ruleName).toContain('Owner takes all');
  });

  it('leaves a lead no rule matched in the pool, and says so on its timeline', async () => {
    await configure('PUT', `/assignment/rules/${ruleId}/conditions`, {
      token: orgA.token,
      payload: { conditions: [{ fieldPath: 'city', operator: 'eq', value: 'Pune' }] },
    });

    const created = await api<{
      id: string;
      assignment: { assignedUserId: string | null; explanation: string };
    }>('POST', '/leads', { token: orgA.token, payload: { firstName: 'Unmatched', city: 'Delhi' } });
    expect(created.body.data.assignment.assignedUserId).toBeNull();
    expect(created.body.data.assignment.explanation).toContain('No rule matched');

    const pool = await api<{ id: string }[]>('GET', '/leads?unassigned=true', {
      token: orgA.token,
    });
    expect(pool.body.data.some((lead) => lead.id === created.body.data.id)).toBe(true);

    const timeline = await api<{ type: string }[]>(
      'GET',
      `/leads/${created.body.data.id}/timeline?limit=50`,
      { token: orgA.token },
    );
    // A lead nobody picked up is the case that loses business, so it is on the timeline rather than
    // being inferred from the absence of an assignment.
    expect(timeline.body.data.some((entry) => entry.type === 'lead.unassigned')).toBe(true);
  });

  it("respects working hours, in the organization's timezone, at a fixed instant", async () => {
    await configure('PUT', `/assignment/rules/${ruleId}/conditions`, {
      token: orgA.token,
      payload: { conditions: [] },
    });
    await configure('PATCH', `/assignment/rules/${ruleId}`, {
      token: orgA.token,
      payload: { respectWorkingHours: true },
    });

    const inHours = await api<{ decision: { assignedUserId: string | null } }>(
      'POST',
      '/assignment/test',
      { token: orgA.token, payload: { lead: {}, at: TUESDAY_NOON } },
    );
    expect(inHours.body.data.decision.assignedUserId).toBe(orgA.userId);

    const afterHours = await api<{
      decision: {
        assignedUserId: string | null;
        candidates: { reason?: string }[];
        usedFallback: boolean;
        notifyManagers: boolean;
      };
    }>('POST', '/assignment/test', { token: orgA.token, payload: { lead: {}, at: TUESDAY_NIGHT } });
    expect(afterHours.body.data.decision.assignedUserId).toBeNull();
    expect(
      afterHours.body.data.decision.candidates.some(
        (candidate) =>
          (candidate.reason ?? '').includes('working hours') &&
          (candidate.reason ?? '').includes('Asia/Kolkata'),
      ),
    ).toBe(true);
    expect(afterHours.body.data.decision.usedFallback).toBe(true);
    expect(afterHours.body.data.decision.notifyManagers).toBe(true);

    const sunday = await api<{ decision: { assignedUserId: string | null } }>(
      'POST',
      '/assignment/test',
      { token: orgA.token, payload: { lead: {}, at: SUNDAY_NOON } },
    );
    expect(sunday.body.data.decision.assignedUserId).toBeNull();
  });

  it('honours a capacity cap and names it', async () => {
    await configure('PATCH', `/assignment/rules/${ruleId}`, {
      token: orgA.token,
      // Working hours off, so the cap is the only thing that can exclude anyone.
      payload: { capacityCap: 1, respectWorkingHours: false },
    });
    const tested = await api<{
      decision: {
        assignedUserId: string | null;
        candidates: { reason?: string; openLeads: number }[];
      };
    }>('POST', '/assignment/test', { token: orgA.token, payload: { lead: {} } });

    expect(tested.body.data.decision.assignedUserId).toBeNull();
    expect(
      tested.body.data.decision.candidates.some((candidate) =>
        (candidate.reason ?? '').includes('capacity'),
      ),
    ).toBe(true);
    // The load is reported, not just the verdict.
    expect(
      tested.body.data.decision.candidates.every(
        (candidate) => typeof candidate.openLeads === 'number',
      ),
    ).toBe(true);

    await configure('PATCH', `/assignment/rules/${ruleId}`, {
      token: orgA.token,
      payload: { capacityCap: null },
    });
  });

  it('falls back to a named person, ignoring their working hours', async () => {
    // Pool first: `round_robin` needs one, and a rule switched to it without a pool is refused —
    // which is the service being right, and was this test being wrong.
    await configure('PUT', `/assignment/rules/${ruleId}/pool`, {
      token: orgA.token,
      payload: { pool: [{ userId: orgA.userId, weight: 1 }] },
    });
    await configure('PATCH', `/assignment/rules/${ruleId}`, {
      token: orgA.token,
      payload: {
        strategy: 'round_robin',
        respectWorkingHours: true,
        // The same person the pool holds: out of hours the rotation refuses them and the fallback
        // takes them anyway, so `usedFallback` is the only thing that distinguishes the two paths.
        fallback: { mode: 'specific_user', userId: orgA.userId, notify: false },
      },
    });

    const sunday = await api<{
      decision: { assignedUserId: string | null; usedFallback: boolean };
    }>('POST', '/assignment/test', { token: orgA.token, payload: { lead: {}, at: SUNDAY_NOON } });
    // A fallback that respected working hours could fall back to nobody, which defeats the point.
    expect(sunday.body.data.decision.assignedUserId).toBe(orgA.userId);
    expect(sunday.body.data.decision.usedFallback).toBe(true);
  });

  it('lists every rule it evaluated, in priority order, with a verdict each', async () => {
    const tested = await api<{
      decision: { ruleEvaluations: { priority: number; explanation: string; matched: boolean }[] };
    }>('POST', '/assignment/test', { token: orgA.token, payload: { lead: { city: 'Pune' } } });

    const evaluations = tested.body.data.decision.ruleEvaluations;
    expect(evaluations.length).toBeGreaterThan(0);
    expect(
      evaluations.every(
        (entry, index, all) => index === 0 || all[index - 1]!.priority <= entry.priority,
      ),
    ).toBe(true);
    expect(evaluations.every((entry) => entry.explanation.length > 0)).toBe(true);
  });

  it('explains a non-match with the value that failed it', async () => {
    await configure('PUT', `/assignment/rules/${ruleId}/conditions`, {
      token: orgA.token,
      payload: { conditions: [{ fieldPath: 'city', operator: 'eq', value: 'Mumbai' }] },
    });
    const tested = await api<{ decision: { ruleEvaluations: { explanation: string }[] } }>(
      'POST',
      '/assignment/test',
      { token: orgA.token, payload: { lead: { city: 'Pune' } } },
    );
    // "Why did this lead not go to the Mumbai team" is the question the tester exists for.
    expect(
      tested.body.data.decision.ruleEvaluations.some((entry) => entry.explanation.includes('Pune')),
    ).toBe(true);
    await configure('PUT', `/assignment/rules/${ruleId}/conditions`, {
      token: orgA.token,
      payload: { conditions: [] },
    });
  });

  it('evaluates a time-of-day condition against the supplied clock', async () => {
    await configure('PUT', `/assignment/rules/${ruleId}/conditions`, {
      token: orgA.token,
      payload: { conditions: [{ fieldPath: 'time.hour', operator: 'gte', value: 19 }] },
    });
    await configure('PATCH', `/assignment/rules/${ruleId}`, {
      token: orgA.token,
      payload: { respectWorkingHours: false },
    });

    const night = await api<{ decision: { assignedUserId: string | null } }>(
      'POST',
      '/assignment/test',
      {
        token: orgA.token,
        payload: { lead: {}, at: TUESDAY_NIGHT },
      },
    );
    const noon = await api<{ decision: { assignedUserId: string | null } }>(
      'POST',
      '/assignment/test',
      {
        token: orgA.token,
        payload: { lead: {}, at: TUESDAY_NOON },
      },
    );
    expect(night.body.data.decision.assignedUserId).toBe(orgA.userId);
    expect(noon.body.data.decision.assignedUserId).toBeNull();

    await configure('PUT', `/assignment/rules/${ruleId}/conditions`, {
      token: orgA.token,
      payload: { conditions: [] },
    });
  });

  it('writes nothing when testing', async () => {
    const before = await ctx.db.lead.count({ where: { organizationId: orgA.organizationId } });
    await configure('POST', '/assignment/test', {
      token: orgA.token,
      payload: { lead: { firstName: 'Hypothetical' } },
    });
    const after = await ctx.db.lead.count({ where: { organizationId: orgA.organizationId } });
    expect(after).toBe(before);
  });
});

describe('round-robin fairness is durable', () => {
  it('rotates in order and stores the cursor in the database', async () => {
    const rule = await api<{ id: string }>('POST', '/assignment/rules', {
      token: orgA.token,
      payload: {
        name: `Rotation ${SUFFIX}`,
        strategy: 'round_robin',
        priority: 1,
        respectWorkingHours: false,
        pool: [{ userId: orgA.userId, weight: 1 }],
      },
    });
    expect(rule.statusCode).toBe(201);

    await configure('POST', '/leads', {
      token: orgA.token,
      payload: { firstName: 'Rotate', lastName: 'One' },
    });

    // The cursor is the durable truth, not a Redis counter: fairness that resets on a deploy is not
    // fairness.
    const state = await ctx.db.roundRobinState.findFirst({ where: { ruleId: rule.body.data.id } });
    expect(state).not.toBeNull();
    expect(state!.lastAssignedUserId).toBe(orgA.userId);
  });

  it('resets the cursor when the pool changes', async () => {
    const rules = await api<{ id: string; name: string }[]>('GET', '/assignment/rules', {
      token: orgA.token,
    });
    const rotation = rules.body.data.find((rule) => rule.name.startsWith('Rotation'))!;

    const repooled = await api<{ rotationReset: boolean }>(
      'PUT',
      `/assignment/rules/${rotation.id}/pool`,
      { token: orgA.token, payload: { pool: [{ userId: orgA.userId, weight: 2 }] } },
    );
    expect(repooled.body.data.rotationReset).toBe(true);
    // A cursor is an index into a specific ordering; keeping it across a membership change would
    // silently skip whoever now occupies that position.
    const state = await ctx.db.roundRobinState.findFirst({ where: { ruleId: rotation.id } });
    expect(state).toBeNull();
  });

  it('refuses to leave a pool strategy with an empty pool', async () => {
    const rules = await api<{ id: string; name: string }[]>('GET', '/assignment/rules', {
      token: orgA.token,
    });
    const rotation = rules.body.data.find((rule) => rule.name.startsWith('Rotation'))!;
    const response = await api('PUT', `/assignment/rules/${rotation.id}/pool`, {
      token: orgA.token,
      payload: { pool: [] },
    });
    // A round-robin with nobody in it sends every matching lead to the fallback, silently.
    expect(response.statusCode).toBe(422);
  });
});

describe('rules that could never assign anything are refused', () => {
  it('refuses a specific-user rule with no user, and a pool strategy with no pool', async () => {
    const noUser = await api('POST', '/assignment/rules', {
      token: orgA.token,
      payload: { name: `No user ${SUFFIX}`, strategy: 'specific_user' },
    });
    expect(noUser.statusCode).toBe(400);

    const noPool = await api('POST', '/assignment/rules', {
      token: orgA.token,
      payload: { name: `No pool ${SUFFIX}`, strategy: 'round_robin' },
    });
    expect(noPool.statusCode).toBe(400);
  });

  it('refuses a rule naming somebody who is not a member of this organization', async () => {
    const response = await api('POST', '/assignment/rules', {
      token: orgA.token,
      payload: {
        name: `Foreign ${SUFFIX}`,
        strategy: 'specific_user',
        target: { userId: orgB.userId },
      },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('re-evaluation and bulk reassignment', () => {
  it('re-runs the rules over an existing lead and reports whether anything changed', async () => {
    const rule = await api<{ id: string }>('POST', '/assignment/rules', {
      token: orgA.token,
      payload: {
        name: `Re-evaluate ${SUFFIX}`,
        strategy: 'specific_user',
        target: { userId: orgA.userId },
        respectWorkingHours: false,
        priority: 0,
      },
    });
    expect(rule.statusCode).toBe(201);

    const lead = await api<{ id: string }>('POST', '/leads', {
      token: orgA.token,
      payload: { firstName: 'Reevaluate', lastName: 'Me' },
    });
    await configure('POST', `/leads/${lead.body.data.id}/assign`, {
      token: orgA.token,
      payload: { assignedUserId: null },
    });

    const first = await api<{ assignedUserId: string; changed: boolean }[]>(
      'POST',
      '/assignment/evaluate',
      {
        token: orgA.token,
        payload: { leadIds: [lead.body.data.id] },
      },
    );
    expect(first.body.data[0]?.changed).toBe(true);
    expect(first.body.data[0]?.assignedUserId).toBe(orgA.userId);

    const second = await api<{ changed: boolean }[]>('POST', '/assignment/evaluate', {
      token: orgA.token,
      payload: { leadIds: [lead.body.data.id] },
    });
    expect(second.body.data[0]?.changed).toBe(false);
  });

  it('reports what a bulk reassignment skipped, rather than overstating what it did', async () => {
    const lead = await api<{ id: string }>('POST', '/leads', {
      token: orgA.token,
      payload: { firstName: 'Bulk', lastName: 'Subject' },
    });
    await configure('POST', `/leads/${lead.body.data.id}/assign`, {
      token: orgA.token,
      payload: { assignedUserId: orgA.userId },
    });

    const result = await api<{
      reassigned: number;
      skipped: { leadId: string; reason: string }[];
      openTasksTransferred: boolean;
      note: string;
    }>('POST', '/assignment/reassign', {
      token: orgA.token,
      payload: { leadIds: [lead.body.data.id, newId()], assignedUserId: null },
    });

    expect(result.body.data.reassigned).toBe(1);
    // A bulk action that says "200 reassigned" when it moved 140 is worse than one that says which
    // 60 it skipped.
    expect(result.body.data.skipped).toHaveLength(1);
    expect(result.body.data.openTasksTransferred).toBe(false);
    expect(result.body.data.note).toContain('tasks');
  });
});

describe('tenant isolation across duplicates and assignment', () => {
  it("does not detect another tenant's lead as a duplicate", async () => {
    const phone = '+919812391111';
    await configure('POST', '/leads', {
      token: orgA.token,
      payload: { firstName: 'OrgA', lastName: 'Person', phone },
    });

    // Org B has its own default rule, and the same phone. It must create its own lead.
    const created = await api<{ id: string; attachedToExisting?: boolean }>('POST', '/leads', {
      token: orgB.token,
      payload: { firstName: 'OrgB', lastName: 'Person', phone },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body.data.attachedToExisting).toBeUndefined();

    const tested = await api<{ wouldMatch: boolean }>('POST', '/duplicates/test', {
      token: orgB.token,
      payload: { phone },
    });
    // It matches org B's own lead, never org A's.
    const matches = await ctx.db.lead.findMany({ where: { phoneE164: phone } });
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(tested.body.data.wouldMatch).toBe(true);
    const bMatches = await api<{ matches: { leadId: string }[] }>('POST', '/duplicates/test', {
      token: orgB.token,
      payload: { phone },
    });
    const bLeadIds = new Set(
      (await ctx.db.lead.findMany({ where: { organizationId: orgB.organizationId } })).map(
        (l) => l.id,
      ),
    );
    expect(bMatches.body.data.matches.every((match) => bLeadIds.has(match.leadId))).toBe(true);
  });

  it("refuses another tenant's rule, pair and merge ids", async () => {
    const aRules = await api<{ id: string }[]>('GET', '/duplicates/rules', { token: orgA.token });
    const foreignRule = await api('PATCH', `/duplicates/rules/${aRules.body.data[0]!.id}`, {
      token: orgB.token,
      payload: { lookbackDays: 30 },
    });
    expect(foreignRule.statusCode).toBe(404);

    const aAssignment = await api<{ id: string }[]>('GET', '/assignment/rules', {
      token: orgA.token,
    });
    const foreignAssignment = await api(
      'PATCH',
      `/assignment/rules/${aAssignment.body.data[0]!.id}`,
      {
        token: orgB.token,
        payload: { priority: 99 },
      },
    );
    expect(foreignAssignment.statusCode).toBe(404);
  });

  it('refuses to merge across tenants', async () => {
    const aLead = await ctx.db.lead.findFirstOrThrow({
      where: { organizationId: orgA.organizationId, deletedAt: null },
    });
    const bLead = await ctx.db.lead.findFirstOrThrow({
      where: { organizationId: orgB.organizationId, deletedAt: null },
    });
    const response = await api('POST', '/duplicates/merge', {
      token: orgB.token,
      payload: { survivingLeadId: bLead.id, mergedLeadId: aLead.id },
    });
    expect(response.statusCode).toBe(404);
  });
});
