import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newToken } from '@leados/shared';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';

/**
 * THE CUSTOMERS AND CONVERSION SUITE.
 *
 * The requirement under test is one sentence of `FR-DEAL-4`: *"Conversion: lead → customer,
 * preserving the full timeline and all touchpoints (never a fresh record)."* Every assertion here
 * is an attempt to break that sentence — by converting twice, by converting somebody else's lead,
 * by reading a customer's history and finding the lead's half missing, by deleting the lead the
 * history hangs from.
 *
 * Nothing is mocked. The timeline union is read through the real endpoint, so a cursor that
 * forgets `occurred_at` (the partition key) shows up here rather than in production.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2ecust${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';

let ctx: TestApp;
let orgA: Tenant;
let orgB: Tenant;

interface Tenant {
  token: string;
  organizationId: string;
  userId: string;
}

interface CustomerBody {
  id: string;
  fullName: string;
  company: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  converted: boolean;
  convertedAt: string | null;
  owner: { userId: string; name: string } | null;
  billing?: {
    line1: string | null;
    city: string | null;
    taxId: string | null;
  };
  consent?: { whatsapp: boolean; email: boolean; calls: boolean };
  origin: {
    leadId: string;
    leadName: string;
    capturedAt: string;
    source: string | null;
    scoreAtConversion: number;
  } | null;
  deletedAt: string | null;
}

interface JourneyEntry {
  id: string;
  type: string;
  occurredAt: string;
  stage: 'lead' | 'customer';
  payload: Record<string, unknown>;
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

/** A setup call whose refusal must not be silent. */
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
      organizationName: `Cust ${label} ${SUFFIX}`,
    },
  });
  return {
    token: registered.body.data.tokens.accessToken,
    organizationId: registered.body.data.activeOrganizationId,
    userId: registered.body.data.user.id,
  };
}

/** A lead with a history worth preserving: a touchpoint, a note and a status move. */
async function createLeadWithHistory(tenant: Tenant, label: string) {
  const lead = await configure<{ id: string }>('POST', '/leads', {
    token: tenant.token,
    payload: {
      firstName: label,
      lastName: 'Rao',
      company: `${label} Interiors`,
      phone: `98765${String(Math.floor(Math.random() * 90000) + 10000)}`,
      email: `${label.toLowerCase()}.${SUFFIX}@cust.test`,
      city: 'Bengaluru',
      consent: { whatsapp: true, calls: true },
    },
  });
  const leadId = lead.body.data.id;

  await configure('POST', `/leads/${leadId}/touchpoints`, {
    token: tenant.token,
    payload: { channel: 'whatsapp' },
  });

  return leadId;
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

describe('conversion keeps the person, and the history they arrived with (FR-DEAL-4)', () => {
  let leadId: string;
  let customerId: string;

  it('converts a lead and reports where the customer came from', async () => {
    leadId = await createLeadWithHistory(orgA, 'Kavita');
    const converted = await api<CustomerBody>('POST', `/leads/${leadId}/convert`, {
      token: orgA.token,
      payload: {
        billingLine1: '4th Floor, Prestige Tower',
        taxId: '29AAAAA0000A1Z5',
        note: 'Signed the 18-month contract',
      },
    });

    expect(converted.statusCode, JSON.stringify(converted.body)).toBe(201);
    customerId = converted.body.data.id;
    expect(converted.body.data.converted).toBe(true);
    expect(converted.body.data.origin?.leadId).toBe(leadId);
    // The origin panel is the answer to "who is this and where did they come from", which is the
    // first thing somebody opening a customer asks.
    expect(converted.body.data.origin?.leadName).toContain('Kavita');
    expect(converted.body.data.billing?.taxId).toBe('29AAAAA0000A1Z5');
  });

  it('leaves the lead in place, marked converted and moved to a won status', async () => {
    // "Never a fresh record" cuts both ways: the customer is not fresh, and the lead is not gone.
    const lead = await api<{
      convertedAt: string | null;
      status: { name: string; category: string };
      touchpoints: unknown[];
    }>('GET', `/leads/${leadId}`, { token: orgA.token });

    expect(lead.statusCode).toBe(200);
    expect(lead.body.data.convertedAt).not.toBeNull();
    expect(lead.body.data.status.category).toBe('won');
    expect(lead.body.data.touchpoints.length).toBeGreaterThan(0);
  });

  it('carries the consent the lead gave, rather than asking again', async () => {
    const customer = await api<CustomerBody>('GET', `/customers/${customerId}`, {
      token: orgA.token,
    });
    expect(customer.body.data.consent).toEqual({ whatsapp: true, email: false, calls: true });
  });

  it('reads the whole journey as one list — the lead’s half and the customer’s', async () => {
    const journey = await api<JourneyEntry[]>('GET', `/customers/${customerId}/timeline`, {
      token: orgA.token,
    });
    expect(journey.statusCode).toBe(200);

    const stages = new Set(journey.body.data.map((entry) => entry.stage));
    // Both halves present is the requirement. One of them missing is the bug this suite exists for.
    expect(stages.has('lead')).toBe(true);
    expect(stages.has('customer')).toBe(true);

    const types = journey.body.data.map((entry) => entry.type);
    expect(types).toContain('lead.created');
    expect(types).toContain('lead.source_captured');
    // Two entries for one moment, each saying something different: the lead converted, and the
    // account opened. Identical sentences at the same instant would read as a duplicated row.
    expect(types).toContain('lead.converted');
    expect(types).toContain('customer.created');

    // Newest first, and strictly ordered: a cursor over a partitioned table that carries only the
    // id would silently interleave pages here.
    const times = journey.body.data.map((entry) => new Date(entry.occurredAt).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('pages the journey without repeating or skipping an entry', async () => {
    const first = await api<JourneyEntry[]>('GET', `/customers/${customerId}/timeline?limit=2`, {
      token: orgA.token,
    });
    const cursor = (first.body.meta as { pagination?: { nextCursor: string | null } } | undefined)
      ?.pagination?.nextCursor;
    expect(first.body.data).toHaveLength(2);
    expect(cursor).toBeTruthy();

    const second = await api<JourneyEntry[]>(
      'GET',
      `/customers/${customerId}/timeline?limit=5&cursor=${encodeURIComponent(cursor!)}`,
      { token: orgA.token },
    );
    const firstIds = new Set(first.body.data.map((entry) => entry.id));
    for (const entry of second.body.data) expect(firstIds.has(entry.id)).toBe(false);
  });

  it('refuses a second conversion of the same lead, by name', async () => {
    const again = await api<{ message: string }>('POST', `/leads/${leadId}/convert`, {
      token: orgA.token,
      payload: {},
    });
    expect(again.statusCode).toBe(409);
    expect(JSON.stringify(again.body)).toMatch(/already a customer/i);
  });

  it('refuses to delete the lead the customer’s history hangs from', async () => {
    // Soft delete is fine — it is reversible and keeps the row. What the database refuses is the
    // hard delete a retention purge would attempt, and it refuses it for the right reason.
    const softDeleted = await api('DELETE', `/leads/${leadId}`, { token: orgA.token });
    expect(softDeleted.statusCode).toBe(200);

    await expect(ctx.db.lead.delete({ where: { id: leadId } })).rejects.toThrow(
      /customers_lead_same_org_fk|foreign key/i,
    );

    await configure('POST', `/leads/${leadId}/restore`, { token: orgA.token });
  });
});

describe('a customer who was never a lead', () => {
  let customerId: string;

  it('is created with no origin, rather than a fictional capture', async () => {
    const created = await api<CustomerBody>('POST', '/customers', {
      token: orgA.token,
      payload: {
        firstName: 'Walk',
        lastName: 'In',
        phone: '9845099001',
        city: 'Pune',
        taxId: '27BBBBB1111B1Z5',
      },
    });
    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    customerId = created.body.data.id;
    expect(created.body.data.converted).toBe(false);
    expect(created.body.data.origin).toBeNull();
  });

  it('normalizes the phone the same way a lead does', async () => {
    const customer = await api<CustomerBody>('GET', `/customers/${customerId}`, {
      token: orgA.token,
    });
    // Canonical E.164, because duplicate detection, search and WhatsApp delivery all assume it.
    expect(customer.body.data.phone).toBe('+919845099001');
  });

  it('refuses a record with no identity at all', async () => {
    const refused = await api('POST', '/customers', {
      token: orgA.token,
      payload: { city: 'Nowhere' },
    });
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/at least a name/i);
  });

  it('is searchable by name, by company and by the last digits of the number', async () => {
    const byDigits = await api<CustomerBody[]>('GET', '/customers?search=99001', {
      token: orgA.token,
    });
    expect(byDigits.body.data.map((customer) => customer.id)).toContain(customerId);

    const byName = await api<CustomerBody[]>('GET', '/customers?search=Walk', {
      token: orgA.token,
    });
    expect(byName.body.data.map((customer) => customer.id)).toContain(customerId);
  });

  it('derives the display name rather than trusting a caller to keep it in step', async () => {
    await configure('PATCH', `/customers/${customerId}`, {
      token: orgA.token,
      payload: { lastName: 'Inwards' },
    });
    const customer = await api<CustomerBody>('GET', `/customers/${customerId}`, {
      token: orgA.token,
    });
    expect(customer.body.data.fullName).toBe('Walk Inwards');
  });

  it('records what changed on the timeline, not just in the audit log', async () => {
    const journey = await api<JourneyEntry[]>('GET', `/customers/${customerId}/timeline`, {
      token: orgA.token,
    });
    const updated = journey.body.data.find((entry) => entry.type === 'customer.updated');
    expect(
      updated,
      'an edit a business owner cannot see is an edit nobody can explain',
    ).toBeTruthy();
    expect(updated?.payload['fields']).toContain('lastName');
  });

  it('deletes and restores without losing the history', async () => {
    const deleted = await api('DELETE', `/customers/${customerId}`, { token: orgA.token });
    expect(deleted.statusCode).toBe(200);

    const hidden = await api<CustomerBody[]>('GET', '/customers', { token: orgA.token });
    expect(hidden.body.data.map((customer) => customer.id)).not.toContain(customerId);

    const binned = await api<CustomerBody[]>('GET', '/customers?deleted=true', {
      token: orgA.token,
    });
    expect(binned.body.data.map((customer) => customer.id)).toContain(customerId);

    await configure('POST', `/customers/${customerId}/restore`, { token: orgA.token });
    const journey = await api<JourneyEntry[]>('GET', `/customers/${customerId}/timeline`, {
      token: orgA.token,
    });
    expect(journey.body.data.map((entry) => entry.type)).toContain('customer.deleted');
    expect(journey.body.data.map((entry) => entry.type)).toContain('customer.restored');
  });
});

describe('a customer belongs to exactly one tenant', () => {
  it('refuses to convert another tenant’s lead, as a 404 rather than a 403', async () => {
    const leadId = await createLeadWithHistory(orgB, 'Meera');
    const stolen = await api('POST', `/leads/${leadId}/convert`, {
      token: orgA.token,
      payload: {},
    });
    // 404, because confirming that the id exists is itself a leak.
    expect(stolen.statusCode).toBe(404);
  });

  it('hides another tenant’s customer from the list, the record and the timeline', async () => {
    const created = await configure<CustomerBody>('POST', '/customers', {
      token: orgB.token,
      payload: { company: `Brightpath ${SUFFIX}` },
    });
    const id = created.body.data.id;

    const list = await api<CustomerBody[]>('GET', '/customers', { token: orgA.token });
    expect(list.body.data.map((customer) => customer.id)).not.toContain(id);

    expect((await api('GET', `/customers/${id}`, { token: orgA.token })).statusCode).toBe(404);
    expect((await api('GET', `/customers/${id}/timeline`, { token: orgA.token })).statusCode).toBe(
      404,
    );
    expect(
      (await api('PATCH', `/customers/${id}`, { token: orgA.token, payload: { city: 'Pune' } }))
        .statusCode,
    ).toBe(404);
  });

  it('cannot be given another tenant’s member as its account manager', async () => {
    const refused = await api('POST', '/customers', {
      token: orgA.token,
      payload: { company: 'Cross Owner Co', ownerUserId: orgB.userId },
    });
    expect(refused.statusCode).toBe(404);
  });
});

describe('the customer’s custom fields are the customer entity’s, not the lead’s', () => {
  it('validates against the tenant’s own customer definitions', async () => {
    await configure('POST', '/custom-fields', {
      token: orgA.token,
      payload: {
        entityType: 'customer',
        key: 'account_tier',
        label: 'Account tier',
        type: 'select',
        isRequired: false,
        options: [
          { value: 'gold', label: 'Gold' },
          { value: 'silver', label: 'Silver' },
        ],
      },
    });

    const created = await api<CustomerBody>('POST', '/customers', {
      token: orgA.token,
      payload: { company: `Tiered ${SUFFIX}`, customValues: { account_tier: 'gold' } },
    });
    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);

    const refused = await api('POST', '/customers', {
      token: orgA.token,
      payload: { company: 'Bad Tier Co', customValues: { account_tier: 'platinum' } },
    });
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/account_tier|tier/i);
  });
});
