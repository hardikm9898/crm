import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newToken } from '@leados/shared';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';
import { CallsService } from '../src/modules/calls/calls.service.js';

/**
 * THE CALLS SUITE.
 *
 * `FR-CALL-1..3` asks for click-to-call, call logging with an outcome, duration and notes, a
 * provider abstraction the CRM does not depend on, and outcomes that are a configurable list
 * feeding scoring, SLA and reports.
 *
 * The assertions that matter are the ones that would pass for the wrong reason if written loosely:
 *
 *  * that a call which **reached** somebody writes `leads.first_contacted_at` and satisfies the
 *    first-response promise, and that one which only rang does neither;
 *  * that "spoke to them" cannot be recorded against a call that did not connect, over HTTP and
 *    not only in a schema;
 *  * that a dialled call stays open until somebody says what happened, that the nudge sweep asks
 *    exactly once however many times it runs, and that it stops asking once the outcome is there;
 *  * that logging a call can close the follow-up it was made for, in one request;
 *  * that an outcome calls still carry cannot be deleted, and the last active one cannot be removed.
 *
 * Nothing is mocked: the telephony port is the real manual driver, and the sweep is the same method
 * the cron tick calls.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2ecall${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';

let ctx: TestApp;
let orgA: Tenant;
let orgB: Tenant;

interface Tenant {
  token: string;
  organizationId: string;
  userId: string;
}

interface CallBody {
  id: string;
  leadId: string | null;
  taskId: string | null;
  direction: string;
  status: string;
  toE164: string | null;
  fromE164: string | null;
  outcomeId: string | null;
  outcome: { id: string; name: string; category: string } | null;
  reached: boolean;
  durationSeconds: number | null;
  duration: string;
  notes: string | null;
  agentUserId: string;
  startedAt: string;
  endedAt: string | null;
  deletedAt: string | null;
}

interface CallConfigBody {
  outcomes: {
    id: string;
    name: string;
    category: string;
    requiresNote: boolean;
    isContact: boolean;
  }[];
  telephony: { driver: string; placesCalls: boolean };
}

interface LeadBody {
  id: string;
  firstContactedAt: string | null;
  lastContactedAt: string | null;
  phone: string | null;
}

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

/** A setup call whose status nobody asserts fails silently and takes the assertion with it. */
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

async function createTenant(label: string): Promise<Tenant> {
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
      organizationName: `Call ${label} ${SUFFIX}`,
    },
  });
  return {
    token: registered.body.data.tokens.accessToken,
    organizationId: registered.body.data.activeOrganizationId,
    userId: registered.body.data.user.id,
  };
}

/**
 * Each test creates its own lead.
 *
 * A fixture shared between tests in one file trips the rules it is not testing — and here it would
 * be worse than a constraint: `first_contacted_at` is written once and never again, so the second
 * test to reach a shared lead would assert against the first test's contact.
 */
let leadCounter = 0;
async function createLead(tenant: Tenant, phone = true): Promise<LeadBody> {
  leadCounter += 1;
  const digits = String(9845000000 + leadCounter);
  const created = await configure<{ id: string }>('POST', '/leads', {
    token: tenant.token,
    payload: {
      firstName: `Caller${leadCounter}`,
      lastName: 'Prospect',
      email: `caller${leadCounter}.${SUFFIX}@call.test`,
      ...(phone ? { phone: `+91${digits}` } : {}),
    },
  });
  // Read back rather than trusting the create response: `POST /leads` answers the capture's own
  // shape, which does not carry every column the detail presenter does — and a test asserting
  // `undefined` is null passes for the wrong reason the day one of them is added.
  return lead(tenant, created.body.data.id);
}

async function lead(tenant: Tenant, id: string): Promise<LeadBody> {
  const response = await api<LeadBody>('GET', `/leads/${id}`, { token: tenant.token });
  expect(response.statusCode).toBe(200);
  return response.body.data;
}

async function callConfig(tenant: Tenant): Promise<CallConfigBody> {
  const response = await api<CallConfigBody>('GET', '/calls/config', { token: tenant.token });
  expect(response.statusCode).toBe(200);
  return response.body.data;
}

function outcomeOf(config: CallConfigBody, category: string): string {
  const found = config.outcomes.find((outcome) => outcome.category === category);
  if (!found) throw new Error(`no seeded outcome in category ${category}`);
  return found.id;
}

async function timelineTypes(tenant: Tenant, leadId: string): Promise<string[]> {
  const response = await api<{ type: string }[]>('GET', `/leads/${leadId}/timeline`, {
    token: tenant.token,
  });
  expect(response.statusCode).toBe(200);
  return response.body.data.map((entry) => entry.type);
}

let config: CallConfigBody;

beforeAll(async () => {
  ctx = await bootTestApp();
  orgA = await createTenant('orga');
  orgB = await createTenant('orgb');
  config = await callConfig(orgA);
}, 120_000);

afterAll(async () => {
  await cleanupUsers(ctx.db, EMAIL_MARKER);
  await ctx.close();
});

describe('the outcome vocabulary a workspace starts with (FR-CALL-3, rule 4)', () => {
  it('seeds one outcome per category, so the form has something to offer on day one', () => {
    expect(config.outcomes.length).toBeGreaterThanOrEqual(6);
    expect(config.outcomes.map((outcome) => outcome.name)).toContain('Spoke — interested');
    expect(new Set(config.outcomes.map((outcome) => outcome.category)).size).toBe(6);
  });

  it('says which of them mean somebody was actually reached', () => {
    // Derived by the API so no screen reimplements it — and "not interested" counts, because a
    // business that rang and was turned down has answered the enquiry.
    const byCategory = new Map(config.outcomes.map((o) => [o.category, o.isContact]));
    expect(byCategory.get('connected')).toBe(true);
    expect(byCategory.get('callback')).toBe(true);
    expect(byCategory.get('not_interested')).toBe(true);
    expect(byCategory.get('no_answer')).toBe(false);
    expect(byCategory.get('busy')).toBe(false);
    // Somebody answered, but not this person.
    expect(byCategory.get('wrong_number')).toBe(false);
  });

  it('says what the dial button will actually do, rather than letting a screen guess', () => {
    expect(config.telephony.driver).toBe('manual');
    expect(config.telephony.placesCalls).toBe(false);
  });

  it('orders the list so the common answers come first', () => {
    const names = config.outcomes.map((outcome) => outcome.name);
    expect(names[0]).toBe('Spoke — interested');
  });
});

describe('logging a call that already happened (FR-CALL-1)', () => {
  it('records the outcome, the length and the note, and reads the duration back as a sentence', async () => {
    const subject = await createLead(orgA);
    const response = await api<{ call: CallBody; followUpCompleted: boolean }>('POST', '/calls', {
      token: orgA.token,
      payload: {
        leadId: subject.id,
        status: 'completed',
        outcomeId: outcomeOf(config, 'connected'),
        durationSeconds: 252,
        notes: 'Wants a site visit on Saturday',
      },
    });
    expect(response.statusCode).toBe(201);
    const logged = response.body.data.call;
    expect(logged.status).toBe('completed');
    expect(logged.outcome?.category).toBe('connected');
    expect(logged.durationSeconds).toBe(252);
    // The sentence, not only the number: "252" is not what a person reads.
    expect(logged.duration).toBe('4 min 12 sec');
    expect(logged.notes).toBe('Wants a site visit on Saturday');
    expect(logged.reached).toBe(true);
    // The lead's own number, taken from the record rather than demanded again.
    expect(logged.toE164).toBe(subject.phone);
    expect(logged.endedAt).not.toBeNull();
  });

  it('writes it to the lead’s timeline, because rule 6 is the product', async () => {
    const subject = await createLead(orgA);
    await configure('POST', '/calls', {
      token: orgA.token,
      payload: {
        leadId: subject.id,
        status: 'no_answer',
        outcomeId: outcomeOf(config, 'no_answer'),
      },
    });
    expect(await timelineTypes(orgA, subject.id)).toContain('call.logged');
  });

  it('refuses a call with no outcome at all', async () => {
    const subject = await createLead(orgA);
    const response = await api('POST', '/calls', {
      token: orgA.token,
      payload: { leadId: subject.id, status: 'completed' },
    });
    // A logged call with no outcome is the row that makes "what happened on those forty calls"
    // unanswerable a month later, which is the whole thing this feature exists to answer.
    expect(response.statusCode).toBe(400);
    expect(response.body.error?.code).toBe('VALIDATION_FAILED');
  });

  it('refuses `dialing` as a logged status, because a logged call is one that is over', async () => {
    const subject = await createLead(orgA);
    const response = await api('POST', '/calls', {
      token: orgA.token,
      payload: {
        leadId: subject.id,
        status: 'dialing',
        outcomeId: outcomeOf(config, 'connected'),
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a duration on a call that did not connect', async () => {
    const subject = await createLead(orgA);
    const response = await api('POST', '/calls', {
      token: orgA.token,
      payload: {
        leadId: subject.id,
        status: 'no_answer',
        outcomeId: outcomeOf(config, 'no_answer'),
        durationSeconds: 240,
      },
    });
    // A no-answer lasting four minutes is a contradiction somebody would later average into a
    // report. The database says so too; this says it with a field attached.
    expect(response.statusCode).toBe(400);
    expect(
      (response.body.error?.details as { field?: string }[] | undefined)?.some(
        (detail) => detail.field === 'durationSeconds',
      ),
    ).toBe(true);
  });

  it('refuses “spoke to them” on a call that did not connect', async () => {
    const subject = await createLead(orgA);
    const response = await api('POST', '/calls', {
      token: orgA.token,
      payload: {
        leadId: subject.id,
        status: 'no_answer',
        outcomeId: outcomeOf(config, 'connected'),
      },
    });
    // Otherwise the lead is marked contacted and a response promise is answered by a conversation
    // that never happened — the pair decides both.
    expect(response.statusCode).toBe(400);
    expect(
      (response.body.error?.details as { code?: string }[] | undefined)?.some(
        (detail) => detail.code === 'OUTCOME_NEEDS_A_CONNECTED_CALL',
      ),
    ).toBe(true);
  });

  it('refuses a number that is not E.164, rather than storing one nothing can join on', async () => {
    const response = await api('POST', '/calls', {
      token: orgA.token,
      payload: {
        toE164: '9845012345',
        status: 'completed',
        outcomeId: outcomeOf(config, 'connected'),
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('asks which number the call was with when the lead has none on record', async () => {
    const subject = await createLead(orgA, false);
    const response = await api('POST', '/calls', {
      token: orgA.token,
      payload: {
        leadId: subject.id,
        status: 'completed',
        outcomeId: outcomeOf(config, 'connected'),
      },
    });
    expect(response.statusCode).toBe(400);
    expect(
      (response.body.error?.details as { code?: string }[] | undefined)?.some(
        (detail) => detail.code === 'NUMBER_REQUIRED',
      ),
    ).toBe(true);
  });

  it('demands a note when the tenant’s outcome says so', async () => {
    const subject = await createLead(orgA);
    const added = await configure<{ id: string }>('POST', '/settings/call-outcomes', {
      token: orgA.token,
      payload: { name: `Other ${SUFFIX}`, category: 'connected', requiresNote: true },
    });
    const refused = await api('POST', '/calls', {
      token: orgA.token,
      payload: { leadId: subject.id, status: 'completed', outcomeId: added.body.data.id },
    });
    expect(refused.statusCode).toBe(400);
    expect(
      (refused.body.error?.details as { code?: string }[] | undefined)?.some(
        (detail) => detail.code === 'NOTE_REQUIRED',
      ),
    ).toBe(true);

    const accepted = await api('POST', '/calls', {
      token: orgA.token,
      payload: {
        leadId: subject.id,
        status: 'completed',
        outcomeId: added.body.data.id,
        notes: 'Asked us to email instead',
      },
    });
    expect(accepted.statusCode).toBe(201);
  });
});

describe('a call that reached somebody is a contact (FR-CALL-3)', () => {
  it('writes first and last contact, and satisfies the first-response promise', async () => {
    const subject = await createLead(orgA);
    expect(subject.firstContactedAt).toBeNull();

    await configure('POST', '/calls', {
      token: orgA.token,
      payload: {
        leadId: subject.id,
        status: 'completed',
        outcomeId: outcomeOf(config, 'connected'),
        durationSeconds: 90,
      },
    });

    const after = await lead(orgA, subject.id);
    expect(after.firstContactedAt).not.toBeNull();
    expect(after.lastContactedAt).not.toBeNull();

    const clocks = await api<{ target: string; state: string; satisfiedBy: string | null }[]>(
      'GET',
      `/sla/clocks?leadId=${subject.id}&limit=10`,
      { token: orgA.token },
    );
    expect(clocks.statusCode).toBe(200);
    // Asserted to exist, not guarded with an `if`: a workspace is seeded with a first-response
    // promise, and a conditional assertion would pass hardest on the day the clock stopped being
    // created at all.
    const first = clocks.body.data.find((clock) => clock.target === 'first_response');
    expect(first).toBeDefined();
    expect(first!.state).toBe('satisfied');
    // The sentence names the call, so a manager reading the clock knows what answered it.
    expect(first!.satisfiedBy).toContain('Call —');
  });

  it('counts a conversation that went nowhere, because the business did respond', async () => {
    const subject = await createLead(orgA);
    await configure('POST', '/calls', {
      token: orgA.token,
      payload: {
        leadId: subject.id,
        status: 'completed',
        outcomeId: outcomeOf(config, 'not_interested'),
      },
    });
    expect((await lead(orgA, subject.id)).firstContactedAt).not.toBeNull();
  });

  it('does not count a ringing phone', async () => {
    const subject = await createLead(orgA);
    await configure('POST', '/calls', {
      token: orgA.token,
      payload: {
        leadId: subject.id,
        status: 'no_answer',
        outcomeId: outcomeOf(config, 'no_answer'),
      },
    });
    // "Attempted" and "reached" have to be different things in a CRM: a lead rung four times and
    // never reached is still waiting for its first response.
    expect((await lead(orgA, subject.id)).firstContactedAt).toBeNull();
  });

  it('does not count the wrong person answering', async () => {
    const subject = await createLead(orgA);
    await configure('POST', '/calls', {
      token: orgA.token,
      payload: {
        leadId: subject.id,
        status: 'completed',
        outcomeId: outcomeOf(config, 'wrong_number'),
      },
    });
    expect((await lead(orgA, subject.id)).firstContactedAt).toBeNull();
  });

  it('never moves the last contact backwards', async () => {
    const subject = await createLead(orgA);
    const recent = new Date(Date.now() - 60 * 60 * 1000);
    await configure('POST', '/calls', {
      token: orgA.token,
      payload: {
        leadId: subject.id,
        status: 'completed',
        outcomeId: outcomeOf(config, 'connected'),
        startedAt: recent.toISOString(),
        endedAt: recent.toISOString(),
      },
    });
    const first = await lead(orgA, subject.id);

    const older = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await configure('POST', '/calls', {
      token: orgA.token,
      payload: {
        leadId: subject.id,
        status: 'completed',
        outcomeId: outcomeOf(config, 'connected'),
        startedAt: older.toISOString(),
        endedAt: older.toISOString(),
      },
    });
    const second = await lead(orgA, subject.id);

    // Logging an older call afterwards must not make the lead look staler than the most recent
    // contact really was.
    expect(second.lastContactedAt).toBe(first.lastContactedAt);
    // But the first contact *does* move back: the earliest known contact is the true one.
    expect(new Date(second.firstContactedAt!).getTime()).toBeLessThan(
      new Date(first.firstContactedAt!).getTime(),
    );
  });
});

describe('click-to-call (FR-CALL-2, FR-CALL-3)', () => {
  it('logs the attempt and hands the device a tel: link', async () => {
    const subject = await createLead(orgA);
    const response = await api<{
      call: CallBody;
      dial: { mode: string; href?: string };
    }>('POST', '/calls/dial', { token: orgA.token, payload: { leadId: subject.id } });

    expect(response.statusCode).toBe(201);
    expect(response.body.data.dial.mode).toBe('device');
    expect(response.body.data.dial.href).toBe(`tel:${subject.phone}`);
    // The row exists before the port is asked, so a provider failure leaves an attempt rather
    // than nothing.
    expect(response.body.data.call.status).toBe('dialing');
    expect(response.body.data.call.endedAt).toBeNull();
    expect(response.body.data.call.outcomeId).toBeNull();
  });

  it('writes an attempt to the timeline, distinctly from a logged call', async () => {
    const subject = await createLead(orgA);
    await configure('POST', '/calls/dial', {
      token: orgA.token,
      payload: { leadId: subject.id },
    });
    const types = await timelineTypes(orgA, subject.id);
    expect(types).toContain('call.attempted');
    // Two facts, not one: nobody knows yet whether they spoke.
    expect(types).not.toContain('call.logged');
  });

  it('does not mark the lead contacted, because nobody knows whether they spoke', async () => {
    const subject = await createLead(orgA);
    await configure('POST', '/calls/dial', {
      token: orgA.token,
      payload: { leadId: subject.id },
    });
    expect((await lead(orgA, subject.id)).firstContactedAt).toBeNull();
  });

  it('refuses to dial a lead with no number, in words a person can act on', async () => {
    const subject = await createLead(orgA, false);
    const response = await api('POST', '/calls/dial', {
      token: orgA.token,
      payload: { leadId: subject.id },
    });
    expect(response.statusCode).toBe(422);
    expect(response.body.error?.message).toMatch(/no phone number/i);
  });

  it('records the outcome afterwards, and only then counts as a contact', async () => {
    const subject = await createLead(orgA);
    const dialled = await configure<{ call: CallBody }>('POST', '/calls/dial', {
      token: orgA.token,
      payload: { leadId: subject.id },
    });
    const id = dialled.body.data.call.id;

    const settled = await api<CallBody>('POST', `/calls/${id}/outcome`, {
      token: orgA.token,
      payload: {
        status: 'completed',
        outcomeId: outcomeOf(config, 'connected'),
        durationSeconds: 65,
        notes: 'Booked a demo',
      },
    });
    expect(settled.statusCode).toBe(200);
    expect(settled.body.data.status).toBe('completed');
    expect(settled.body.data.reached).toBe(true);
    expect(settled.body.data.endedAt).not.toBeNull();
    expect((await lead(orgA, subject.id)).firstContactedAt).not.toBeNull();
    expect(await timelineTypes(orgA, subject.id)).toContain('call.logged');
  });

  it('refuses a second outcome on the same call', async () => {
    const subject = await createLead(orgA);
    const dialled = await configure<{ call: CallBody }>('POST', '/calls/dial', {
      token: orgA.token,
      payload: { leadId: subject.id },
    });
    const id = dialled.body.data.call.id;
    await configure('POST', `/calls/${id}/outcome`, {
      token: orgA.token,
      payload: { status: 'busy', outcomeId: outcomeOf(config, 'busy') },
    });
    const again = await api('POST', `/calls/${id}/outcome`, {
      token: orgA.token,
      payload: { status: 'completed', outcomeId: outcomeOf(config, 'connected') },
    });
    // Rewriting what happened on a call that is already recorded is not a correction, it is a
    // second call — and the history has to be able to say so.
    expect(again.statusCode).toBe(422);
  });
});

describe('the nudge that makes the log honest', () => {
  it('asks the person who dialled, exactly once, however many times the sweep runs', async () => {
    const subject = await createLead(orgA);
    const dialled = await configure<{ call: CallBody }>('POST', '/calls/dial', {
      token: orgA.token,
      payload: { leadId: subject.id },
    });

    // Dialled "twenty minutes ago": the grace period is fifteen, and a fixture inside it would
    // assert that the sweep does nothing — which it also must, so both are checked.
    await ctx.db.$executeRawUnsafe(
      `UPDATE calls SET started_at = now() - interval '20 minutes' WHERE id = $1`,
      dialled.body.data.call.id,
    );

    const calls = ctx.app.get(CallsService);
    const first = await calls.sweepUnrecordedOutcomes();
    expect(first.asked).toBeGreaterThanOrEqual(1);
    const second = await calls.sweepUnrecordedOutcomes();
    // `outcome_prompted_at` is the record of the question, exactly as `overdue_notified_at` is.
    expect(second.asked).toBe(0);

    const inbox = await api<{ type: string; title: string; data: Record<string, unknown> }[]>(
      'GET',
      '/notifications?limit=50',
      { token: orgA.token },
    );
    expect(inbox.statusCode).toBe(200);
    const nudges = inbox.body.data.filter(
      (row) =>
        row.type === 'call.outcome_missing' && row.data?.['callId'] === dialled.body.data.call.id,
    );
    expect(nudges).toHaveLength(1);
    expect(nudges[0]!.title).toContain('Caller');
  });

  it('leaves a call inside its grace period alone', async () => {
    const subject = await createLead(orgA);
    await configure('POST', '/calls/dial', { token: orgA.token, payload: { leadId: subject.id } });
    const before = await api<{ type: string }[]>('GET', '/notifications?limit=50', {
      token: orgA.token,
    });
    const count = before.body.data.filter((row) => row.type === 'call.outcome_missing').length;

    await ctx.app.get(CallsService).sweepUnrecordedOutcomes();

    const after = await api<{ type: string }[]>('GET', '/notifications?limit=50', {
      token: orgA.token,
    });
    // A nudge that arrives while somebody is still on the phone is the one time it is certainly
    // wrong.
    expect(after.body.data.filter((row) => row.type === 'call.outcome_missing')).toHaveLength(
      count,
    );
  });

  it('stops asking about a call whose outcome has been recorded', async () => {
    const subject = await createLead(orgA);
    const dialled = await configure<{ call: CallBody }>('POST', '/calls/dial', {
      token: orgA.token,
      payload: { leadId: subject.id },
    });
    await configure('POST', `/calls/${dialled.body.data.call.id}/outcome`, {
      token: orgA.token,
      payload: { status: 'busy', outcomeId: outcomeOf(config, 'busy') },
    });
    await ctx.db.$executeRawUnsafe(
      `UPDATE calls SET started_at = now() - interval '20 minutes' WHERE id = $1`,
      dialled.body.data.call.id,
    );

    const result = await ctx.app.get(CallsService).sweepUnrecordedOutcomes();
    const inbox = await api<{ type: string; data: Record<string, unknown> }[]>(
      'GET',
      '/notifications?limit=50',
      { token: orgA.token },
    );
    expect(
      inbox.body.data.filter(
        (row) =>
          row.type === 'call.outcome_missing' && row.data?.['callId'] === dialled.body.data.call.id,
      ),
    ).toHaveLength(0);
    expect(result.examined).toBeGreaterThanOrEqual(0);
  });
});

describe('closing the loop FR-TSK-6 opened', () => {
  it('logs the call and finishes the follow-up in one request', async () => {
    const subject = await createLead(orgA);
    const taskConfig = await api<{
      outcomes: { id: string; name: string; requiresNote: boolean }[];
    }>('GET', '/tasks/config', { token: orgA.token });
    const taskOutcome = taskConfig.body.data.outcomes.find((o) => !o.requiresNote)!;

    const task = await configure<{ id: string }>('POST', '/tasks', {
      token: orgA.token,
      payload: {
        leadId: subject.id,
        title: 'Ring about the quotation',
        dueAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    });

    const response = await api<{ call: CallBody; followUpCompleted: boolean }>('POST', '/calls', {
      token: orgA.token,
      payload: {
        leadId: subject.id,
        taskId: task.body.data.id,
        status: 'completed',
        outcomeId: outcomeOf(config, 'connected'),
        durationSeconds: 120,
        finishFollowUp: { outcomeId: taskOutcome.id, note: 'Said yes' },
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.body.data.followUpCompleted).toBe(true);
    expect(response.body.data.call.taskId).toBe(task.body.data.id);

    const finished = await api<{ status: string }>('GET', `/tasks/${task.body.data.id}`, {
      token: orgA.token,
    });
    expect(finished.body.data.status).toBe('completed');

    const types = await timelineTypes(orgA, subject.id);
    // Both facts, separately: the call is what happened, the completion is what it closed.
    expect(types).toContain('call.logged');
    expect(types).toContain('task.completed');
  });

  it('refuses a follow-up that belongs to a different lead', async () => {
    const one = await createLead(orgA);
    const other = await createLead(orgA);
    const task = await configure<{ id: string }>('POST', '/tasks', {
      token: orgA.token,
      payload: {
        leadId: other.id,
        title: 'Somebody else’s follow-up',
        dueAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    });
    const response = await api('POST', '/calls', {
      token: orgA.token,
      payload: {
        leadId: one.id,
        taskId: task.body.data.id,
        status: 'completed',
        outcomeId: outcomeOf(config, 'connected'),
      },
    });
    expect(response.statusCode).toBe(422);
  });

  it('refuses to finish a follow-up without saying which one', async () => {
    const subject = await createLead(orgA);
    const response = await api('POST', '/calls', {
      token: orgA.token,
      payload: {
        leadId: subject.id,
        status: 'completed',
        outcomeId: outcomeOf(config, 'connected'),
        finishFollowUp: { outcomeId: outcomeOf(config, 'connected') },
      },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('the log, and the figures on it', () => {
  it('totals the whole filter rather than the page', async () => {
    const subject = await createLead(orgA);
    for (const seconds of [60, 120, 180]) {
      await configure('POST', '/calls', {
        token: orgA.token,
        payload: {
          leadId: subject.id,
          status: 'completed',
          outcomeId: outcomeOf(config, 'connected'),
          durationSeconds: seconds,
        },
      });
    }
    await configure('POST', '/calls', {
      token: orgA.token,
      payload: {
        leadId: subject.id,
        status: 'no_answer',
        outcomeId: outcomeOf(config, 'no_answer'),
      },
    });

    const page = await api<CallBody[]>('GET', `/calls?leadId=${subject.id}&limit=2`, {
      token: orgA.token,
    });
    expect(page.statusCode).toBe(200);
    expect(page.body.data).toHaveLength(2);
    expect((page.body.meta?.['pagination'] as { total?: number }).total).toBe(4);
    // A panel that summed the two rows it loaded would report a third of the time on the phone.
    expect(page.body.meta?.['totalTalkTimeSeconds']).toBe(360);
    expect(page.body.meta?.['connected']).toBe(3);
  });

  it('finds the calls that still owe an answer', async () => {
    const subject = await createLead(orgA);
    await configure('POST', '/calls/dial', { token: orgA.token, payload: { leadId: subject.id } });
    const open = await api<CallBody[]>('GET', `/calls?leadId=${subject.id}&open=true`, {
      token: orgA.token,
    });
    expect(open.body.data).toHaveLength(1);
    expect(open.body.data[0]!.status).toBe('dialing');

    const closed = await api<CallBody[]>('GET', `/calls?leadId=${subject.id}&open=false`, {
      token: orgA.token,
    });
    expect(closed.body.data).toHaveLength(0);
  });

  it('answers “both” when the three-way filter is absent, rather than half the list', async () => {
    const subject = await createLead(orgA);
    await configure('POST', '/calls/dial', { token: orgA.token, payload: { leadId: subject.id } });
    await configure('POST', '/calls', {
      token: orgA.token,
      payload: {
        leadId: subject.id,
        status: 'busy',
        outcomeId: outcomeOf(config, 'busy'),
      },
    });
    const all = await api<CallBody[]>('GET', `/calls?leadId=${subject.id}`, { token: orgA.token });
    expect(all.body.data).toHaveLength(2);
  });

  it('filters by what the call meant, not only by what the telephony saw', async () => {
    const subject = await createLead(orgA);
    await configure('POST', '/calls', {
      token: orgA.token,
      payload: {
        leadId: subject.id,
        status: 'completed',
        outcomeId: outcomeOf(config, 'callback'),
      },
    });
    const byCategory = await api<CallBody[]>(
      'GET',
      `/calls?leadId=${subject.id}&category=callback`,
      { token: orgA.token },
    );
    expect(byCategory.body.data).toHaveLength(1);
    const other = await api<CallBody[]>(
      'GET',
      `/calls?leadId=${subject.id}&category=wrong_number`,
      { token: orgA.token },
    );
    expect(other.body.data).toHaveLength(0);
  });

  it('removes a call that was logged against the wrong person, without unmaking the contact', async () => {
    const subject = await createLead(orgA);
    const logged = await configure<{ call: CallBody }>('POST', '/calls', {
      token: orgA.token,
      payload: {
        leadId: subject.id,
        status: 'completed',
        outcomeId: outcomeOf(config, 'connected'),
      },
    });
    const contacted = (await lead(orgA, subject.id)).firstContactedAt;

    const removed = await api('DELETE', `/calls/${logged.body.data.call.id}`, {
      token: orgA.token,
    });
    expect(removed.statusCode).toBe(200);
    const live = await api<CallBody[]>('GET', `/calls?leadId=${subject.id}`, { token: orgA.token });
    expect(live.body.data.map((row) => row.id)).not.toContain(logged.body.data.call.id);
    // A mistyped log is not evidence nobody was reached, and the SLA clock it satisfied is not
    // un-satisfied — making the report disagree with the clock would be a worse lie.
    expect((await lead(orgA, subject.id)).firstContactedAt).toBe(contacted);
  });
});

describe('an unattributed call, and the attribution that fixes it', () => {
  it('logs a call against a number nobody recognises', async () => {
    const response = await api<{ call: CallBody }>('POST', '/calls', {
      token: orgA.token,
      payload: {
        direction: 'inbound',
        fromE164: '+919000000001',
        status: 'completed',
        outcomeId: outcomeOf(config, 'connected'),
      },
    });
    // `calls.lead_id` is nullable because an enquiry from somebody nobody recognises is exactly
    // the call most worth keeping.
    expect(response.statusCode).toBe(201);
    expect(response.body.data.call.leadId).toBeNull();
    expect(response.body.data.call.fromE164).toBe('+919000000001');

    const unlinked = await api<CallBody[]>('GET', '/calls?linked=false', { token: orgA.token });
    expect(unlinked.body.data.map((row) => row.id)).toContain(response.body.data.call.id);
  });

  it('writes the lead’s history only when somebody says who it was', async () => {
    const unknown = await configure<{ call: CallBody }>('POST', '/calls', {
      token: orgA.token,
      payload: {
        direction: 'inbound',
        fromE164: '+919000000002',
        status: 'completed',
        outcomeId: outcomeOf(config, 'connected'),
      },
    });
    const subject = await createLead(orgA);
    expect(await timelineTypes(orgA, subject.id)).not.toContain('call.logged');

    const linked = await api<CallBody>('PATCH', `/calls/${unknown.body.data.call.id}`, {
      token: orgA.token,
      payload: { leadId: subject.id },
    });
    expect(linked.statusCode).toBe(200);
    expect(linked.body.data.leadId).toBe(subject.id);
    // The moment `call.logged` becomes true *of a lead* is the moment it is attributed — which is
    // where the timeline entry and the event are written, not before.
    expect(await timelineTypes(orgA, subject.id)).toContain('call.logged');
  });
});

describe('the outcome list is configuration in use (rule 4)', () => {
  it('adds one in the tenant’s own words, with the category the product understands', async () => {
    const added = await api<{ id: string; name: string }>('POST', '/settings/call-outcomes', {
      token: orgB.token,
      payload: { name: `Wants a test drive ${SUFFIX}`, category: 'connected' },
    });
    expect(added.statusCode).toBe(201);

    const list = await api<{ id: string; name: string; category: string; callCount: number }[]>(
      'GET',
      '/settings/call-outcomes',
      { token: orgB.token },
    );
    expect(list.body.data.map((row) => row.name)).toContain(`Wants a test drive ${SUFFIX}`);
  });

  it('refuses to destroy an outcome calls still carry', async () => {
    const subject = await createLead(orgA);
    const added = await configure<{ id: string }>('POST', '/settings/call-outcomes', {
      token: orgA.token,
      payload: { name: `In use ${SUFFIX}`, category: 'no_answer' },
    });
    await configure('POST', '/calls', {
      token: orgA.token,
      payload: { leadId: subject.id, status: 'no_answer', outcomeId: added.body.data.id },
    });

    const refused = await api('DELETE', `/settings/call-outcomes/${added.body.data.id}`, {
      token: orgA.token,
    });
    expect(refused.statusCode).toBe(422);
    // The sentence tells somebody what to do instead, which is the whole difference between a
    // refusal and a dead end.
    expect(refused.body.error?.message).toMatch(/Deactivate it instead/);

    const deactivated = await api('PATCH', `/settings/call-outcomes/${added.body.data.id}`, {
      token: orgA.token,
      payload: { isActive: false },
    });
    expect(deactivated.statusCode).toBe(200);
    // Deactivating hides it from new calls and leaves history readable.
    const offered = await callConfig(orgA);
    expect(offered.outcomes.map((row) => row.id)).not.toContain(added.body.data.id);
  });

  it('refuses to leave a workspace with no outcome left to choose', async () => {
    const list = await api<{ id: string; isActive: boolean }[]>('GET', '/settings/call-outcomes', {
      token: orgB.token,
    });
    const active = list.body.data.filter((row) => row.isActive);
    for (const row of active.slice(0, -1)) {
      await configure('PATCH', `/settings/call-outcomes/${row.id}`, {
        token: orgB.token,
        payload: { isActive: false },
      });
    }
    const last = active.at(-1)!;
    const refused = await api('PATCH', `/settings/call-outcomes/${last.id}`, {
      token: orgB.token,
      payload: { isActive: false },
    });
    // Otherwise the workspace reaches a state where no call can ever be logged again, and the
    // error names a constraint rather than the setting somebody changed five minutes earlier.
    expect(refused.statusCode).toBe(422);
    expect(refused.body.error?.message).toMatch(/only outcome left/);
  });
});

describe('a call belongs to one workspace (rule 1)', () => {
  it('hides another tenant’s call behind a 404, not a 403', async () => {
    const subject = await createLead(orgA);
    const logged = await configure<{ call: CallBody }>('POST', '/calls', {
      token: orgA.token,
      payload: {
        leadId: subject.id,
        status: 'completed',
        outcomeId: outcomeOf(config, 'connected'),
      },
    });
    const response = await api('GET', `/calls/${logged.body.data.call.id}`, {
      token: orgB.token,
    });
    // A 403 would confirm the id exists, which makes the id an oracle.
    expect(response.statusCode).toBe(404);
  });

  it('refuses another tenant’s outcome on a call', async () => {
    const subject = await createLead(orgB);
    const theirs = await callConfig(orgA);
    const response = await api('POST', '/calls', {
      token: orgB.token,
      payload: {
        leadId: subject.id,
        status: 'completed',
        outcomeId: outcomeOf(theirs, 'connected'),
      },
    });
    expect(response.statusCode).toBe(404);
  });

  it('keeps one tenant’s log out of another’s list', async () => {
    const mine = await api<CallBody[]>('GET', '/calls?limit=100', { token: orgB.token });
    const theirs = await api<CallBody[]>('GET', '/calls?limit=100', { token: orgA.token });
    const overlap = mine.body.data
      .map((row) => row.id)
      .filter((id) => theirs.body.data.some((row) => row.id === id));
    expect(overlap).toEqual([]);
  });
});
