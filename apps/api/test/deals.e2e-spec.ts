import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newToken } from '@leados/shared';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';

/**
 * THE DEALS SUITE.
 *
 * `FR-DEAL-1` asks for "deals with value, currency, expected close, probability (from stage),
 * products/line items, won/lost with reason". The assertions that matter are the ones about money:
 * that a deal's header total always equals its own line items, that a line records what was agreed
 * rather than what the catalogue says today, and that a forecast is weighted by the stage's
 * probability rather than being a sum of hopes.
 *
 * Nothing is mocked. The totals come back from PostgreSQL, where `deals_totals_add_up` and
 * `deal_items_total_is_net_plus_tax` would refuse them if the arithmetic drifted.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2edeal${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';

let ctx: TestApp;
let orgA: Tenant;
let orgB: Tenant;

interface Tenant {
  token: string;
  organizationId: string;
  userId: string;
}

interface DealBody {
  id: string;
  name: string;
  valueMinor: number;
  grossMinor: number;
  discountMinor: number;
  taxMinor: number;
  weightedMinor: number;
  currency: string;
  probability: number;
  outcome: 'open' | 'won' | 'lost';
  wonAt: string | null;
  lostAt: string | null;
  stage: { id: string; name?: string; isWon?: boolean; isLost?: boolean };
  lead: { id: string; fullName: string } | null;
  customer: { id: string; fullName: string } | null;
  owner: { userId: string; name: string } | null;
  items?: {
    position: number;
    name: string;
    productId: string | null;
    quantity: number;
    unitPriceMinor: number;
    discountMinor: number;
    taxPercent: number;
    grossMinor: number;
    netMinor: number;
    taxMinor: number;
    totalMinor: number;
  }[];
  lostReason?: { id: string; name: string } | null;
}

interface BoardBody {
  pipeline: { id: string; name: string };
  columns: {
    stage: { id: string; name: string; probability: number };
    total: number;
    valueMinor: number;
    weightedMinor: number;
    deals: DealBody[];
  }[];
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
      organizationName: `Deals ${label} ${SUFFIX}`,
    },
  });
  return {
    token: registered.body.data.tokens.accessToken,
    organizationId: registered.body.data.activeOrganizationId,
    userId: registered.body.data.user.id,
  };
}

async function createLead(tenant: Tenant, label: string): Promise<string> {
  const lead = await configure<{ id: string }>('POST', '/leads', {
    token: tenant.token,
    payload: {
      firstName: label,
      lastName: 'Deal',
      company: `${label} Co`,
      email: `${label.toLowerCase()}.${SUFFIX}@deal.test`,
    },
  });
  return lead.body.data.id;
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

describe('a workspace can record a sale on its first day', () => {
  it('has a deal pipeline without anybody configuring one', async () => {
    // A workspace that must set up a pipeline before it can record a sale is one where the first
    // sale is recorded in a spreadsheet instead.
    const board = await api<BoardBody>('GET', '/deals/board', { token: orgA.token });
    expect(board.statusCode, JSON.stringify(board.body)).toBe(200);
    expect(board.body.data.pipeline.name).toBe('Deals');
    expect(board.body.data.columns.length).toBeGreaterThan(3);
    expect(board.body.data.columns.map((column) => column.stage.probability)).toContain(100);
  });
});

describe('a deal’s value is the sum of its line items (FR-DEAL-1)', () => {
  let leadId: string;
  let productId: string;
  let dealId: string;

  it('fills a line from the catalogue when the client only names a product', async () => {
    leadId = await createLead(orgA, 'Kavita');
    const product = await configure<{ id: string }>('POST', '/products', {
      token: orgA.token,
      payload: {
        name: 'Consulting hour',
        sku: `CONS-${SUFFIX}`,
        priceMinor: 500_000,
        taxPercent: 18,
        unit: 'hour',
      },
    });
    productId = product.body.data.id;

    const created = await api<DealBody>('POST', '/deals', {
      token: orgA.token,
      payload: {
        name: 'Consulting retainer',
        leadId,
        items: [{ productId, quantity: 2 }],
      },
    });
    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    dealId = created.body.data.id;

    const line = created.body.data.items?.[0];
    expect(line?.name).toBe('Consulting hour');
    expect(line?.unitPriceMinor).toBe(500_000);
    expect(line?.taxPercent).toBe(18);
    expect(line?.grossMinor).toBe(1_000_000);
    expect(line?.taxMinor).toBe(180_000);
    expect(line?.totalMinor).toBe(1_180_000);
  });

  it('totals the header from the lines, and the parts add up', async () => {
    const deal = await api<DealBody>('GET', `/deals/${dealId}`, { token: orgA.token });
    expect(deal.body.data.grossMinor).toBe(1_000_000);
    expect(deal.body.data.taxMinor).toBe(180_000);
    expect(deal.body.data.valueMinor).toBe(1_180_000);
    // The database refuses a header that disagrees with this, so reaching here means it agrees.
    expect(deal.body.data.valueMinor).toBe(
      deal.body.data.grossMinor - deal.body.data.discountMinor + deal.body.data.taxMinor,
    );
  });

  it('takes the probability from the stage it lands in', async () => {
    const board = await api<BoardBody>('GET', '/deals/board', { token: orgA.token });
    const first = board.body.data.columns[0]!;
    const deal = await api<DealBody>('GET', `/deals/${dealId}`, { token: orgA.token });
    expect(deal.body.data.probability).toBe(first.stage.probability);
    // The forecast is weighted, not a sum of hopes.
    expect(deal.body.data.weightedMinor).toBe(
      Math.round((deal.body.data.valueMinor * deal.body.data.probability) / 100),
    );
  });

  it('recomputes the header when the lines are replaced', async () => {
    const updated = await api<DealBody>('PUT', `/deals/${dealId}/items`, {
      token: orgA.token,
      payload: {
        items: [
          { productId, quantity: 3 },
          {
            name: 'Setup fee',
            quantity: 1,
            unitPriceMinor: 250_000,
            discountMinor: 50_000,
            taxPercent: 18,
          },
          { name: 'Bundled handbook', quantity: 1, unitPriceMinor: 0, taxPercent: 5 },
        ],
      },
    });
    expect(updated.statusCode, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.data.items).toHaveLength(3);
    // 1 500 000 + 200 000 net = 1 700 000; tax 270 000 + 36 000 = 306 000.
    expect(updated.body.data.grossMinor).toBe(1_750_000);
    expect(updated.body.data.discountMinor).toBe(50_000);
    expect(updated.body.data.taxMinor).toBe(306_000);
    expect(updated.body.data.valueMinor).toBe(2_006_000);
  });

  it('keeps the price a line was quoted at when the catalogue changes', async () => {
    // A line states what was agreed. Re-reading today's price at display time would rewrite last
    // quarter's quotations every time somebody adjusts a price list.
    await configure('PATCH', `/products/${productId}`, {
      token: orgA.token,
      payload: { priceMinor: 900_000 },
    });
    const deal = await api<DealBody>('GET', `/deals/${dealId}`, { token: orgA.token });
    expect(deal.body.data.items?.[0]?.unitPriceMinor).toBe(500_000);
    expect(deal.body.data.valueMinor).toBe(2_006_000);
  });

  it('refuses to set a total on a deal that has lines', async () => {
    // Quietly ignoring it would teach the caller nothing about which one is the source of truth.
    const refused = await api('PATCH', `/deals/${dealId}`, {
      token: orgA.token,
      payload: { valueMinor: 1 },
    });
    expect(refused.statusCode).toBe(422);
    expect(JSON.stringify(refused.body)).toMatch(/comes from its line items/i);
  });

  it('refuses a line whose discount is larger than the line', async () => {
    const refused = await api('PUT', `/deals/${dealId}/items`, {
      token: orgA.token,
      payload: {
        items: [{ name: 'Too generous', quantity: 1, unitPriceMinor: 100, discountMinor: 500 }],
      },
    });
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/larger than the line/i);
    expect(JSON.stringify(refused.body)).toMatch(/items\.0\.discountMinor/);
  });

  it('refuses to delete a product that has been sold, and says what to do instead', async () => {
    const refused = await api('DELETE', `/products/${productId}`, { token: orgA.token });
    expect(refused.statusCode).toBe(422);
    expect(JSON.stringify(refused.body)).toMatch(/deactivate it instead/i);
  });

  it('refuses a second product with the same code', async () => {
    const refused = await api('POST', '/products', {
      token: orgA.token,
      payload: { name: 'Another', sku: `CONS-${SUFFIX}` },
    });
    expect(refused.statusCode).toBe(409);
  });

  it('allows any number of products with no code at all', async () => {
    // The unique index is partial; a plain one would allow exactly one product without a SKU.
    for (const name of ['No code one', 'No code two']) {
      const created = await api('POST', '/products', { token: orgA.token, payload: { name } });
      expect(created.statusCode, name).toBe(201);
    }
  });
});

describe('won, lost and reopened', () => {
  let leadId: string;
  let dealId: string;

  it('moves a deal along the board and takes the stage’s probability with it', async () => {
    leadId = await createLead(orgA, 'Suresh');
    const created = await configure<DealBody>('POST', '/deals', {
      token: orgA.token,
      payload: { name: 'Steel supply', leadId, valueMinor: 4_000_000 },
    });
    dealId = created.body.data.id;

    const board = await api<BoardBody>('GET', '/deals/board', { token: orgA.token });
    const third = board.body.data.columns[2]!;
    const moved = await api<DealBody>('POST', `/deals/${dealId}/stage`, {
      token: orgA.token,
      payload: { stageId: third.stage.id },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.body.data.probability).toBe(third.stage.probability);
  });

  it('refuses a stage from a different pipeline', async () => {
    // `deals_stage_in_pipeline_fk` makes this unrepresentable; the service answers before the
    // constraint does, so the message is a sentence rather than a constraint name.
    const leadPipeline = await api<{ id: string; stages: { id: string }[] }[]>(
      'GET',
      '/crm/pipelines',
      { token: orgA.token },
    );
    const leadStageId = leadPipeline.body.data[0]?.stages[0]?.id;
    expect(leadStageId).toBeTruthy();
    const refused = await api('POST', `/deals/${dealId}/stage`, {
      token: orgA.token,
      payload: { stageId: leadStageId },
    });
    expect(refused.statusCode).toBe(404);
  });

  it('marks a deal won, moves it to the won stage and carries the value in the event', async () => {
    const won = await api<DealBody>('POST', `/deals/${dealId}/win`, {
      token: orgA.token,
      payload: { note: 'Signed the supply contract' },
    });
    expect(won.statusCode).toBe(200);
    expect(won.body.data.outcome).toBe('won');
    expect(won.body.data.probability).toBe(100);
    expect(won.body.data.stage.isWon).toBe(true);

    const events = await ctx.db.outboxEvent.findMany({
      where: { organizationId: orgA.organizationId, eventName: 'deal.won' },
      orderBy: { occurredAt: 'desc' },
      take: 1,
    });
    // Phase 9's attribution reads this to tie spend to revenue, so it must not have to read the
    // deal back to learn how much was won.
    expect((events[0]?.payload as { valueMinor?: number }).valueMinor).toBe(4_000_000);
    expect((events[0]?.payload as { currency?: string }).currency).toBe('INR');
  });

  it('writes the win on the deal and on the lead, because that is the screen somebody opens', async () => {
    const onDeal = await api<{ type: string; stage: string }[]>(
      'GET',
      `/deals/${dealId}/timeline`,
      { token: orgA.token },
    );
    expect(onDeal.body.data.map((entry) => entry.type)).toContain('deal.won');
    expect(
      onDeal.body.data.map((entry) => `${entry.type}:${entry.stage}`),
      'every row on a deal timeline names the deal as its subject',
    ).toEqual(onDeal.body.data.map((entry) => `${entry.type}:deal`));

    const onLead = await api<{ type: string }[]>('GET', `/leads/${leadId}/timeline`, {
      token: orgA.token,
    });
    expect(onLead.body.data.map((entry) => entry.type)).toContain('deal.won');
    expect(onLead.body.data.map((entry) => entry.type)).toContain('deal.created');
  });

  it('refuses to mark a won deal lost without reopening it', async () => {
    const refused = await api('POST', `/deals/${dealId}/lose`, { token: orgA.token, payload: {} });
    expect(refused.statusCode).toBe(422);
    expect(JSON.stringify(refused.body)).toMatch(/reopen/i);
  });

  it('reopens without erasing the history, because it happened', async () => {
    const reopened = await api<DealBody>('POST', `/deals/${dealId}/reopen`, { token: orgA.token });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.body.data.outcome).toBe('open');
    expect(reopened.body.data.wonAt).toBeNull();

    const timeline = await api<{ type: string }[]>('GET', `/deals/${dealId}/timeline`, {
      token: orgA.token,
    });
    const types = timeline.body.data.map((entry) => entry.type);
    expect(types).toContain('deal.won');
    expect(types).toContain('deal.reopened');
  });

  it('marks a deal lost with a reason from the tenant’s own list', async () => {
    const reasons = await api<{ id: string; name: string }[]>('GET', '/crm/lost-reasons', {
      token: orgA.token,
    });
    const reasonId = reasons.body.data[0]?.id;
    const lost = await api<DealBody>('POST', `/deals/${dealId}/lose`, {
      token: orgA.token,
      payload: { lostReasonId: reasonId, note: 'Went with a cheaper supplier' },
    });
    expect(lost.statusCode).toBe(200);
    expect(lost.body.data.outcome).toBe('lost');
    expect(lost.body.data.probability).toBe(0);
    expect(lost.body.data.lostReason?.id).toBe(reasonId);
  });

  it('refuses a lost reason this workspace does not have', async () => {
    await configure('POST', `/deals/${dealId}/reopen`, { token: orgA.token });
    const refused = await api('POST', `/deals/${dealId}/lose`, {
      token: orgA.token,
      payload: { lostReasonId: '01a10000-0000-7000-8000-000000000000' },
    });
    expect(refused.statusCode).toBe(404);
  });

  it('keeps a closed deal off the board but inside the revenue filter', async () => {
    await configure('POST', `/deals/${dealId}/win`, { token: orgA.token });
    const board = await api<BoardBody>('GET', '/deals/board', { token: orgA.token });
    const onBoard = board.body.data.columns.flatMap((column) =>
      column.deals.map((deal) => deal.id),
    );
    expect(onBoard).not.toContain(dealId);

    const wonList = await api<DealBody[]>('GET', '/deals?outcome=won', { token: orgA.token });
    expect(wonList.body.data.map((deal) => deal.id)).toContain(dealId);
  });

  it('reports the value of the whole filtered set, not of the page', async () => {
    const list = await api<DealBody[]>('GET', '/deals?outcome=won&limit=1', { token: orgA.token });
    const meta = list.body.meta as { totalValueMinor?: number } | undefined;
    // A per-page sum would change as somebody paged, which is not a number a manager can act on.
    expect(meta?.totalValueMinor).toBe(4_000_000);
  });
});

describe('a deal belongs to exactly one tenant', () => {
  it('refuses a deal attached to nobody', async () => {
    const refused = await api('POST', '/deals', {
      token: orgA.token,
      payload: { name: 'Orphan', valueMinor: 1_000 },
    });
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/who the deal is with/i);
  });

  it('refuses a deal against another tenant’s lead, as a 404', async () => {
    const leadId = await createLead(orgB, 'Meera');
    const refused = await api('POST', '/deals', {
      token: orgA.token,
      payload: { name: 'Stolen', leadId },
    });
    expect(refused.statusCode).toBe(404);
  });

  it('hides another tenant’s deal from the list, the record and the timeline', async () => {
    const leadId = await createLead(orgB, 'Imran');
    const created = await configure<DealBody>('POST', '/deals', {
      token: orgB.token,
      payload: { name: `Brightpath deal ${SUFFIX}`, leadId, valueMinor: 10_000 },
    });
    const id = created.body.data.id;

    const list = await api<DealBody[]>('GET', '/deals', { token: orgA.token });
    expect(list.body.data.map((deal) => deal.id)).not.toContain(id);
    expect((await api('GET', `/deals/${id}`, { token: orgA.token })).statusCode).toBe(404);
    expect((await api('GET', `/deals/${id}/timeline`, { token: orgA.token })).statusCode).toBe(404);
    expect(
      (await api('POST', `/deals/${id}/win`, { token: orgA.token, payload: {} })).statusCode,
    ).toBe(404);
  });

  it('hides another tenant’s products', async () => {
    const created = await configure<{ id: string }>('POST', '/products', {
      token: orgB.token,
      payload: { name: `Brightpath product ${SUFFIX}` },
    });
    const list = await api<{ id: string }[]>('GET', '/products', { token: orgA.token });
    expect(list.body.data.map((product) => product.id)).not.toContain(created.body.data.id);
    expect(
      (await api('GET', `/products/${created.body.data.id}`, { token: orgA.token })).statusCode,
    ).toBe(404);
  });
});

describe('a deal against a customer', () => {
  it('inherits the account manager and appears on the customer’s timeline', async () => {
    const leadId = await createLead(orgA, 'Anil');
    const customer = await configure<{ id: string; owner: { userId: string } | null }>(
      'POST',
      `/leads/${leadId}/convert`,
      { token: orgA.token, payload: {} },
    );
    const customerId = customer.body.data.id;

    const deal = await configure<DealBody>('POST', '/deals', {
      token: orgA.token,
      payload: { name: 'Repeat order', customerId, valueMinor: 750_000 },
    });
    expect(deal.body.data.customer?.id).toBe(customerId);
    expect(deal.body.data.owner?.userId).toBe(customer.body.data.owner?.userId);

    const journey = await api<{ type: string; stage: string }[]>(
      'GET',
      `/customers/${customerId}/timeline`,
      { token: orgA.token },
    );
    expect(journey.body.data.map((entry) => entry.type)).toContain('deal.created');
  });
});
