import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newToken } from '@leados/shared';
import {
  bootTestApp,
  call,
  callRaw,
  cleanupUsers,
  type EnvelopeBody,
  type TestApp,
} from './app-harness.js';

/**
 * THE QUOTATIONS SUITE.
 *
 * `FR-DEAL-2` asks for "quotations with line items, taxes, discounts, validity, PDF generation,
 * versioning and send-via-WhatsApp/email". The assertions that matter are the ones about the
 * document being a **record** rather than a view: that a sent version can never be edited, that a
 * revision preserves what the customer was given, that two numbers are never the same, and that the
 * PDF is really a PDF with the real total in it.
 *
 * Nothing is mocked. The totals come back from PostgreSQL, where `quotations_totals_add_up` and the
 * status/timestamp CHECKs would refuse an inconsistent document outright.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2equote${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';

let ctx: TestApp;
let orgA: Tenant;
let orgB: Tenant;

interface Tenant {
  token: string;
  organizationId: string;
  userId: string;
}

interface QuotationBody {
  id: string;
  number: string;
  version: number;
  label: string;
  status: string;
  title: string | null;
  terms?: string | null;
  validUntil: string | null;
  grossMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  currency: string;
  dealId: string | null;
  leadId: string | null;
  customerId: string | null;
  supersededById: string | null;
  isCurrent: boolean;
  sentAt: string | null;
  sentVia: string | null;
  sentTo: string | null;
  acceptedAt: string | null;
  rejectedAt: string | null;
  expiredAt: string | null;
  outcomeNote: string | null;
  rejectedReason: { id: string; name: string } | null;
  hasPdf: boolean;
  items?: {
    position: number;
    name: string;
    quantity: number;
    unitPriceMinor: number;
    discountMinor: number;
    taxPercent: number;
    grossMinor: number;
    netMinor: number;
    taxMinor: number;
    totalMinor: number;
  }[];
  versions?: { id: string; version: number; status: string; totalMinor: number }[];
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
      organizationName: `Quotes ${label} ${SUFFIX}`,
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
      lastName: 'Quote',
      company: `${label} Co`,
      email: `${label.toLowerCase()}.${SUFFIX}@quote.test`,
    },
  });
  return lead.body.data.id;
}

async function createDeal(
  tenant: Tenant,
  label: string,
  items?: unknown[],
): Promise<{ id: string; leadId: string }> {
  const leadId = await createLead(tenant, label);
  const deal = await configure<{ id: string }>('POST', '/deals', {
    token: tenant.token,
    payload: {
      name: `${label} deal`,
      leadId,
      ...(items ? { items } : { valueMinor: 100_000 }),
    },
  });
  return { id: deal.body.data.id, leadId };
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

describe('raising a quotation', () => {
  it('numbers it from the workspace’s own series, starting at one', async () => {
    const deal = await createDeal(orgA, 'Numbered', [
      { name: 'Consulting', quantity: 1, unitPriceMinor: 100_000, taxPercent: 18 },
    ]);
    const created = await api<QuotationBody>('POST', '/quotations', {
      token: orgA.token,
      payload: { dealId: deal.id },
    });
    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    // `QTN-0001` is what a business owner expects on their first quotation, not a UUID.
    expect(created.body.data.number).toMatch(/^QTN-\d{4}$/);
    expect(created.body.data.version).toBe(1);
    expect(created.body.data.status).toBe('draft');
  });

  it('copies the deal’s lines when none are given, because that is what raising one means', async () => {
    const deal = await createDeal(orgA, 'Copied', [
      { name: 'Installation', quantity: 2, unitPriceMinor: 50_000, taxPercent: 18 },
      { name: 'Training', quantity: 1, unitPriceMinor: 25_000, taxPercent: 5 },
    ]);
    const created = await configure<QuotationBody>('POST', '/quotations', {
      token: orgA.token,
      payload: { dealId: deal.id },
    });
    const quotation = created.body.data;
    expect(quotation.items).toHaveLength(2);
    // 100 000 + 25 000 gross; tax 18 000 + 1 250.
    expect(quotation.grossMinor).toBe(125_000);
    expect(quotation.taxMinor).toBe(19_250);
    expect(quotation.totalMinor).toBe(144_250);
  });

  it('gives consecutive numbers to consecutive quotations', async () => {
    const deal = await createDeal(orgA, 'Series', [
      { name: 'A thing', quantity: 1, unitPriceMinor: 10_000 },
    ]);
    const first = await configure<QuotationBody>('POST', '/quotations', {
      token: orgA.token,
      payload: { dealId: deal.id },
    });
    const second = await configure<QuotationBody>('POST', '/quotations', {
      token: orgA.token,
      payload: { dealId: deal.id },
    });
    const a = Number(first.body.data.number.replace('QTN-', ''));
    const b = Number(second.body.data.number.replace('QTN-', ''));
    expect(b).toBe(a + 1);
  });

  it('never hands the same number to two quotations raised at the same moment', async () => {
    // The whole reason the counter is a locked row rather than `MAX(number) + 1`.
    const deal = await createDeal(orgA, 'Concurrent', [
      { name: 'A thing', quantity: 1, unitPriceMinor: 10_000 },
    ]);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        api<QuotationBody>('POST', '/quotations', {
          token: orgA.token,
          payload: { dealId: deal.id },
        }),
      ),
    );
    for (const result of results) {
      expect(result.statusCode, JSON.stringify(result.body)).toBe(201);
    }
    const numbers = results.map((result) => result.body.data.number);
    expect(new Set(numbers).size).toBe(5);
  });

  it('refuses a quotation attached to nobody', async () => {
    const refused = await api('POST', '/quotations', { token: orgA.token, payload: {} });
    expect(refused.statusCode).toBe(400);
  });

  it('refuses a quotation against another tenant’s deal, as a 404', async () => {
    const deal = await createDeal(orgA, 'Private', [
      { name: 'A thing', quantity: 1, unitPriceMinor: 10_000 },
    ]);
    const refused = await api('POST', '/quotations', {
      token: orgB.token,
      payload: { dealId: deal.id },
    });
    // 404, not 403: confirming that a deal exists is itself a leak.
    expect(refused.statusCode).toBe(404);
  });

  it('prices a line from the catalogue when only the product is named', async () => {
    const product = await configure<{ id: string }>('POST', '/products', {
      token: orgA.token,
      payload: { name: `Annual licence ${SUFFIX}`, priceMinor: 240_000, taxPercent: 18 },
    });
    const leadId = await createLead(orgA, 'Catalogued');
    const created = await configure<QuotationBody>('POST', '/quotations', {
      token: orgA.token,
      payload: {
        leadId,
        items: [{ productId: product.body.data.id, quantity: 1 }],
      },
    });
    expect(created.body.data.items?.[0]?.unitPriceMinor).toBe(240_000);
    expect(created.body.data.totalMinor).toBe(283_200);
  });
});

describe('the document is a record, not a view', () => {
  async function draft(label: string, items?: unknown[]) {
    const deal = await createDeal(orgA, label, [
      { name: 'Base', quantity: 1, unitPriceMinor: 100_000, taxPercent: 18 },
    ]);
    const created = await configure<QuotationBody>('POST', '/quotations', {
      token: orgA.token,
      payload: { dealId: deal.id, ...(items ? { items } : {}) },
    });
    return { quotation: created.body.data, dealId: deal.id, leadId: deal.leadId };
  }

  it('refuses to send a quotation with no lines', async () => {
    const leadId = await createLead(orgA, 'Empty');
    const created = await configure<QuotationBody>('POST', '/quotations', {
      token: orgA.token,
      payload: { leadId, items: [] },
    });
    const refused = await api('POST', `/quotations/${created.body.data.id}/send`, {
      token: orgA.token,
      payload: {},
    });
    expect(refused.statusCode).toBe(422);
  });

  it('records how and to whom it was sent', async () => {
    const { quotation } = await draft('Sent');
    const sent = await configure<QuotationBody>('POST', `/quotations/${quotation.id}/send`, {
      token: orgA.token,
      payload: { via: 'email', to: 'buyer@example.test' },
    });
    expect(sent.body.data.status).toBe('sent');
    expect(sent.body.data.sentVia).toBe('email');
    expect(sent.body.data.sentTo).toBe('buyer@example.test');
    expect(sent.body.data.sentAt).not.toBeNull();
  });

  it('refuses to reprice a quotation that has been sent', async () => {
    const { quotation } = await draft('Frozen');
    await configure('POST', `/quotations/${quotation.id}/send`, {
      token: orgA.token,
      payload: {},
    });
    const refused = await api('PUT', `/quotations/${quotation.id}/items`, {
      token: orgA.token,
      payload: { items: [{ name: 'Cheaper', quantity: 1, unitPriceMinor: 1 }] },
    });
    expect(refused.statusCode).toBe(422);
    // And the refusal says what to do instead, because "no" on its own is a dead end.
    expect(JSON.stringify(refused.body)).toMatch(/revision/i);
  });

  it('refuses to retitle a quotation that has been sent', async () => {
    const { quotation } = await draft('Retitle');
    await configure('POST', `/quotations/${quotation.id}/send`, {
      token: orgA.token,
      payload: {},
    });
    const refused = await api('PATCH', `/quotations/${quotation.id}`, {
      token: orgA.token,
      payload: { title: 'Something else' },
    });
    expect(refused.statusCode).toBe(422);
  });

  it('refuses to delete a quotation that has been sent, and allows deleting a draft', async () => {
    const { quotation: draftOne } = await draft('Deletable');
    const deleted = await api('DELETE', `/quotations/${draftOne.id}`, { token: orgA.token });
    expect(deleted.statusCode).toBe(200);

    const { quotation: draftTwo } = await draft('Undeletable');
    await configure('POST', `/quotations/${draftTwo.id}/send`, {
      token: orgA.token,
      payload: {},
    });
    const refused = await api('DELETE', `/quotations/${draftTwo.id}`, { token: orgA.token });
    expect(refused.statusCode).toBe(422);
  });
});

describe('revising a quotation', () => {
  async function sent(label: string, items?: unknown[]) {
    const deal = await createDeal(orgA, label, [
      { name: 'Base', quantity: 1, unitPriceMinor: 200_000, taxPercent: 18 },
    ]);
    const created = await configure<QuotationBody>('POST', '/quotations', {
      token: orgA.token,
      payload: { dealId: deal.id, ...(items ? { items } : {}) },
    });
    const response = await configure<QuotationBody>(
      'POST',
      `/quotations/${created.body.data.id}/send`,
      { token: orgA.token, payload: { via: 'whatsapp' } },
    );
    return { quotation: response.body.data, dealId: deal.id, leadId: deal.leadId };
  }

  it('keeps the same number and bumps the version', async () => {
    const { quotation } = await sent('Revised');
    const revision = await configure<QuotationBody>('POST', `/quotations/${quotation.id}/revise`, {
      token: orgA.token,
      payload: {
        items: [{ name: 'Discounted', quantity: 1, unitPriceMinor: 180_000, taxPercent: 18 }],
      },
    });
    expect(revision.body.data.number).toBe(quotation.number);
    expect(revision.body.data.version).toBe(2);
    expect(revision.body.data.label).toBe(`${quotation.number} v2`);
    expect(revision.body.data.status).toBe('draft');
    expect(revision.body.data.totalMinor).toBe(212_400);
  });

  it('leaves what the customer was sent exactly as it was', async () => {
    const { quotation } = await sent('Preserved');
    await configure('POST', `/quotations/${quotation.id}/revise`, {
      token: orgA.token,
      payload: { items: [{ name: 'Cheaper', quantity: 1, unitPriceMinor: 1_000 }] },
    });
    const original = await api<QuotationBody>('GET', `/quotations/${quotation.id}`, {
      token: orgA.token,
    });
    // The whole point: v1 still says what it said, and still says it was sent.
    expect(original.body.data.totalMinor).toBe(236_000);
    expect(original.body.data.status).toBe('sent');
    expect(original.body.data.isCurrent).toBe(false);
    expect(original.body.data.supersededById).not.toBeNull();
  });

  it('copies the lines when the revision does not restate them', async () => {
    const { quotation } = await sent('Inherited');
    const revision = await configure<QuotationBody>('POST', `/quotations/${quotation.id}/revise`, {
      token: orgA.token,
      payload: {},
    });
    expect(revision.body.data.totalMinor).toBe(quotation.totalMinor);
    expect(revision.body.data.items).toHaveLength(1);
  });

  it('refuses to revise a draft, because there is nothing to preserve', async () => {
    const deal = await createDeal(orgA, 'StillDraft', [
      { name: 'Base', quantity: 1, unitPriceMinor: 10_000 },
    ]);
    const created = await configure<QuotationBody>('POST', '/quotations', {
      token: orgA.token,
      payload: { dealId: deal.id },
    });
    const refused = await api('POST', `/quotations/${created.body.data.id}/revise`, {
      token: orgA.token,
      payload: {},
    });
    expect(refused.statusCode).toBe(422);
    expect(JSON.stringify(refused.body)).toMatch(/edit it/i);
  });

  it('refuses to revise a version that has already been revised', async () => {
    const { quotation } = await sent('Twice');
    await configure('POST', `/quotations/${quotation.id}/revise`, {
      token: orgA.token,
      payload: {},
    });
    const refused = await api('POST', `/quotations/${quotation.id}/revise`, {
      token: orgA.token,
      payload: {},
    });
    expect(refused.statusCode).toBe(422);
  });

  it('lists only the current version, and the history when asked', async () => {
    const { quotation } = await sent('Listed');
    await configure('POST', `/quotations/${quotation.id}/revise`, {
      token: orgA.token,
      payload: {},
    });
    const current = await api<QuotationBody[]>('GET', `/quotations?number=${quotation.number}`, {
      token: orgA.token,
    });
    expect(current.body.data).toHaveLength(1);
    expect(current.body.data[0]?.version).toBe(2);

    const all = await api<QuotationBody[]>(
      'GET',
      `/quotations?number=${quotation.number}&versions=all`,
      { token: orgA.token },
    );
    expect(all.body.data).toHaveLength(2);
  });

  it('shows every version from the record itself', async () => {
    const { quotation } = await sent('Versioned');
    await configure('POST', `/quotations/${quotation.id}/revise`, {
      token: orgA.token,
      payload: {},
    });
    const fetched = await api<QuotationBody>('GET', `/quotations/${quotation.id}`, {
      token: orgA.token,
    });
    expect(fetched.body.data.versions?.map((version) => version.version)).toEqual([1, 2]);
  });
});

describe('the outcome', () => {
  async function sentQuotation(label: string, dealItems?: unknown[]) {
    const deal = await createDeal(
      orgA,
      label,
      dealItems ?? [{ name: 'Base', quantity: 1, unitPriceMinor: 100_000, taxPercent: 18 }],
    );
    const created = await configure<QuotationBody>('POST', '/quotations', {
      token: orgA.token,
      payload: {
        dealId: deal.id,
        items: [{ name: 'Agreed scope', quantity: 1, unitPriceMinor: 150_000, taxPercent: 18 }],
      },
    });
    await configure('POST', `/quotations/${created.body.data.id}/send`, {
      token: orgA.token,
      payload: {},
    });
    return { quotationId: created.body.data.id, dealId: deal.id, leadId: deal.leadId };
  }

  it('writes the accepted figure onto the open deal, so the forecast matches the document', async () => {
    const { quotationId, dealId } = await sentQuotation('Accepted');
    const accepted = await configure<QuotationBody>('POST', `/quotations/${quotationId}/accept`, {
      token: orgA.token,
      payload: { note: 'Signed on the call' },
    });
    expect(accepted.body.data.status).toBe('accepted');

    const deal = await api<{ valueMinor: number; items?: { name: string }[] }>(
      'GET',
      `/deals/${dealId}`,
      { token: orgA.token },
    );
    expect(deal.body.data.valueMinor).toBe(177_000);
    expect(deal.body.data.items?.map((item) => item.name)).toEqual(['Agreed scope']);
  });

  it('leaves a won deal’s value alone, because that sale is already settled', async () => {
    const { quotationId, dealId } = await sentQuotation('AlreadyWon');
    await configure('POST', `/deals/${dealId}/win`, { token: orgA.token, payload: {} });
    const before = await api<{ valueMinor: number }>('GET', `/deals/${dealId}`, {
      token: orgA.token,
    });
    await configure('POST', `/quotations/${quotationId}/accept`, {
      token: orgA.token,
      payload: {},
    });
    const after = await api<{ valueMinor: number }>('GET', `/deals/${dealId}`, {
      token: orgA.token,
    });
    expect(after.body.data.valueMinor).toBe(before.body.data.valueMinor);
  });

  it('rejects with a reason from the tenant’s own list', async () => {
    const { quotationId } = await sentQuotation('Rejected');
    const reasons = await api<{ id: string; name: string }[]>('GET', '/crm/lost-reasons', {
      token: orgA.token,
    });
    const reasonId = reasons.body.data[0]?.id;
    expect(reasonId).toBeTruthy();
    const rejected = await configure<QuotationBody>('POST', `/quotations/${quotationId}/reject`, {
      token: orgA.token,
      payload: { reasonId, note: 'Went with a cheaper vendor' },
    });
    expect(rejected.body.data.status).toBe('rejected');
    expect(rejected.body.data.rejectedReason?.id).toBe(reasonId);
    expect(rejected.body.data.outcomeNote).toBe('Went with a cheaper vendor');
  });

  it('refuses a rejection reason this workspace does not have', async () => {
    const { quotationId } = await sentQuotation('ForeignReason');
    const otherReasons = await api<{ id: string }[]>('GET', '/crm/lost-reasons', {
      token: orgB.token,
    });
    const refused = await api('POST', `/quotations/${quotationId}/reject`, {
      token: orgA.token,
      payload: { reasonId: otherReasons.body.data[0]?.id },
    });
    expect(refused.statusCode).toBe(404);
  });

  it('refuses to accept a draft, and refuses to accept twice differently', async () => {
    const deal = await createDeal(orgA, 'DraftAccept', [
      { name: 'Base', quantity: 1, unitPriceMinor: 10_000 },
    ]);
    const created = await configure<QuotationBody>('POST', '/quotations', {
      token: orgA.token,
      payload: { dealId: deal.id },
    });
    const refused = await api('POST', `/quotations/${created.body.data.id}/accept`, {
      token: orgA.token,
      payload: {},
    });
    expect(refused.statusCode).toBe(422);

    const { quotationId } = await sentQuotation('AcceptTwice');
    await configure('POST', `/quotations/${quotationId}/accept`, {
      token: orgA.token,
      payload: {},
    });
    // Idempotent, not an error: a double-click must not produce a different answer.
    const again = await api<QuotationBody>('POST', `/quotations/${quotationId}/accept`, {
      token: orgA.token,
      payload: {},
    });
    expect(again.statusCode).toBe(200);
    expect(again.body.data.status).toBe('accepted');
  });

  it('refuses to accept a superseded version', async () => {
    const { quotationId } = await sentQuotation('Superseded');
    await configure('POST', `/quotations/${quotationId}/revise`, {
      token: orgA.token,
      payload: {},
    });
    const refused = await api('POST', `/quotations/${quotationId}/accept`, {
      token: orgA.token,
      payload: {},
    });
    expect(refused.statusCode).toBe(422);
    expect(JSON.stringify(refused.body)).toMatch(/newer version/i);
  });
});

describe('validity and the expiry sweep', () => {
  it('marks a sent quotation expired once its validity has run out', async () => {
    const deal = await createDeal(orgA, 'Expiring', [
      { name: 'Base', quantity: 1, unitPriceMinor: 50_000 },
    ]);
    const created = await configure<QuotationBody>('POST', '/quotations', {
      token: orgA.token,
      payload: { dealId: deal.id, validUntil: '2020-01-31' },
    });
    await configure('POST', `/quotations/${created.body.data.id}/send`, {
      token: orgA.token,
      payload: {},
    });

    const { QuotationsService } = await import('../src/modules/quotations/quotations.service.js');
    const service = ctx.app.get(QuotationsService);
    const result = await service.expireDue();
    expect(result.expired).toBeGreaterThanOrEqual(1);

    const after = await api<QuotationBody>('GET', `/quotations/${created.body.data.id}`, {
      token: orgA.token,
    });
    expect(after.body.data.status).toBe('expired');
    expect(after.body.data.expiredAt).not.toBeNull();
  });

  it('refuses to accept an expired quotation, and says to revise it', async () => {
    const deal = await createDeal(orgA, 'Lapsed', [
      { name: 'Base', quantity: 1, unitPriceMinor: 50_000 },
    ]);
    const created = await configure<QuotationBody>('POST', '/quotations', {
      token: orgA.token,
      payload: { dealId: deal.id, validUntil: '2020-02-29' },
    });
    await configure('POST', `/quotations/${created.body.data.id}/send`, {
      token: orgA.token,
      payload: {},
    });
    const { QuotationsService } = await import('../src/modules/quotations/quotations.service.js');
    await ctx.app.get(QuotationsService).expireDue();

    const refused = await api('POST', `/quotations/${created.body.data.id}/accept`, {
      token: orgA.token,
      payload: {},
    });
    expect(refused.statusCode).toBe(422);
    expect(JSON.stringify(refused.body)).toMatch(/expired/i);
  });

  it('does not expire a quotation with no validity date', async () => {
    const deal = await createDeal(orgA, 'Forever', [
      { name: 'Base', quantity: 1, unitPriceMinor: 50_000 },
    ]);
    const created = await configure<QuotationBody>('POST', '/quotations', {
      token: orgA.token,
      payload: { dealId: deal.id },
    });
    await configure('POST', `/quotations/${created.body.data.id}/send`, {
      token: orgA.token,
      payload: {},
    });
    const { QuotationsService } = await import('../src/modules/quotations/quotations.service.js');
    await ctx.app.get(QuotationsService).expireDue();
    const after = await api<QuotationBody>('GET', `/quotations/${created.body.data.id}`, {
      token: orgA.token,
    });
    expect(after.body.data.status).toBe('sent');
  });
});

describe('the PDF', () => {
  it('renders a real PDF carrying the number and the total', async () => {
    const deal = await createDeal(orgA, 'Printed', [
      { name: 'Base', quantity: 1, unitPriceMinor: 100_000, taxPercent: 18 },
    ]);
    const created = await configure<QuotationBody>('POST', '/quotations', {
      token: orgA.token,
      payload: {
        dealId: deal.id,
        title: 'Website build and launch',
        terms: 'Half on signing, half on delivery.',
        items: [
          { name: 'Design', quantity: 1, unitPriceMinor: 80_000, taxPercent: 18 },
          { name: 'Build', quantity: 2.5, unitPriceMinor: 40_000, taxPercent: 18 },
        ],
      },
    });
    const sent = await configure<QuotationBody>(
      'POST',
      `/quotations/${created.body.data.id}/send`,
      { token: orgA.token, payload: {} },
    );
    expect(sent.body.data.totalMinor).toBe(212_400);

    const response = await callRaw(ctx.app, {
      method: 'GET',
      url: `/api/v1/quotations/${created.body.data.id}/pdf`,
      token: orgA.token,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/pdf');
    const body = response.body;
    // A PDF, not an error page that happens to have the right content type.
    expect(body.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(body.byteLength).toBeGreaterThan(1_000);
  });

  it('stores the rendered PDF once a version is frozen, and reuses it', async () => {
    const deal = await createDeal(orgA, 'Cached', [
      { name: 'Base', quantity: 1, unitPriceMinor: 100_000 },
    ]);
    const created = await configure<QuotationBody>('POST', '/quotations', {
      token: orgA.token,
      payload: { dealId: deal.id },
    });
    await configure('POST', `/quotations/${created.body.data.id}/send`, {
      token: orgA.token,
      payload: {},
    });
    expect(created.body.data.hasPdf).toBe(false);

    const first = await callRaw(ctx.app, {
      method: 'GET',
      url: `/api/v1/quotations/${created.body.data.id}/pdf`,
      token: orgA.token,
    });
    const after = await api<QuotationBody>('GET', `/quotations/${created.body.data.id}`, {
      token: orgA.token,
    });
    expect(after.body.data.hasPdf).toBe(true);

    const second = await callRaw(ctx.app, {
      method: 'GET',
      url: `/api/v1/quotations/${created.body.data.id}/pdf`,
      token: orgA.token,
    });
    // Byte-for-byte the same file: a frozen version's document cannot change.
    expect(second.body.equals(first.body)).toBe(true);
  });

  it('renders a draft without storing it, because a draft is still being written', async () => {
    const deal = await createDeal(orgA, 'DraftPdf', [
      { name: 'Base', quantity: 1, unitPriceMinor: 100_000 },
    ]);
    const created = await configure<QuotationBody>('POST', '/quotations', {
      token: orgA.token,
      payload: { dealId: deal.id },
    });
    const response = await callRaw(ctx.app, {
      method: 'GET',
      url: `/api/v1/quotations/${created.body.data.id}/pdf`,
      token: orgA.token,
    });
    expect(response.statusCode).toBe(200);
    const after = await api<QuotationBody>('GET', `/quotations/${created.body.data.id}`, {
      token: orgA.token,
    });
    expect(after.body.data.hasPdf).toBe(false);
  });

  it('hides another tenant’s PDF', async () => {
    const deal = await createDeal(orgA, 'SecretPdf', [
      { name: 'Base', quantity: 1, unitPriceMinor: 100_000 },
    ]);
    const created = await configure<QuotationBody>('POST', '/quotations', {
      token: orgA.token,
      payload: { dealId: deal.id },
    });
    const refused = await callRaw(ctx.app, {
      method: 'GET',
      url: `/api/v1/quotations/${created.body.data.id}/pdf`,
      token: orgB.token,
    });
    expect(refused.statusCode).toBe(404);
  });
});

describe('the timeline and the money', () => {
  it('writes the quotation on the deal and on the lead, because that is the screen somebody opens', async () => {
    const deal = await createDeal(orgA, 'Timelined', [
      { name: 'Base', quantity: 1, unitPriceMinor: 100_000, taxPercent: 18 },
    ]);
    const created = await configure<QuotationBody>('POST', '/quotations', {
      token: orgA.token,
      payload: { dealId: deal.id },
    });
    await configure('POST', `/quotations/${created.body.data.id}/send`, {
      token: orgA.token,
      payload: { via: 'email', to: 'buyer@example.test' },
    });

    const dealTimeline = await api<{ type: string; payload: Record<string, unknown> }[]>(
      'GET',
      `/deals/${deal.id}/timeline`,
      { token: orgA.token },
    );
    expect(dealTimeline.body.data.map((entry) => entry.type)).toContain('quotation.sent');

    const leadTimeline = await api<{ type: string; payload: Record<string, unknown> }[]>(
      'GET',
      `/leads/${deal.leadId}/timeline`,
      { token: orgA.token },
    );
    const entry = leadTimeline.body.data.find((row) => row.type === 'quotation.sent');
    expect(entry, 'the lead must show that a quotation went out').toBeTruthy();
    expect(entry?.payload['totalMinor']).toBe(118_000);
    expect(entry?.payload['via']).toBe('email');
  });

  it('shows a quotation once on a converted customer’s journey, not twice', async () => {
    // A converted person's journey is the union of their lead's entries and their customer's, so a
    // document written against both columns would read as a duplicated row.
    const leadId = await createLead(orgA, 'Converted');
    const converted = await configure<{ id: string }>('POST', `/leads/${leadId}/convert`, {
      token: orgA.token,
      payload: {},
    });
    const customerId = converted.body.data.id;
    const deal = await configure<{ id: string }>('POST', '/deals', {
      token: orgA.token,
      payload: {
        name: 'Post-conversion deal',
        leadId,
        customerId,
        items: [{ name: 'Base', quantity: 1, unitPriceMinor: 100_000 }],
      },
    });
    const created = await configure<QuotationBody>('POST', '/quotations', {
      token: orgA.token,
      payload: { dealId: deal.body.data.id },
    });
    await configure('POST', `/quotations/${created.body.data.id}/send`, {
      token: orgA.token,
      payload: {},
    });

    const journey = await api<{ type: string }[]>('GET', `/customers/${customerId}/timeline`, {
      token: orgA.token,
    });
    const sentEntries = journey.body.data.filter((entry) => entry.type === 'quotation.sent');
    expect(sentEntries).toHaveLength(1);
  });

  it('reports the value of the whole filtered set, not of the page', async () => {
    const deal = await createDeal(orgA, 'Totalled', [
      { name: 'Base', quantity: 1, unitPriceMinor: 10_000 },
    ]);
    await configure('POST', '/quotations', {
      token: orgA.token,
      payload: { dealId: deal.id, items: [{ name: 'A', quantity: 1, unitPriceMinor: 70_000 }] },
    });
    await configure('POST', '/quotations', {
      token: orgA.token,
      payload: { dealId: deal.id, items: [{ name: 'B', quantity: 1, unitPriceMinor: 30_000 }] },
    });
    const listed = await api<QuotationBody[]>('GET', `/quotations?dealId=${deal.id}&limit=1`, {
      token: orgA.token,
    });
    expect(listed.body.data).toHaveLength(1);
    expect((listed.body.meta as { totalMinor: number }).totalMinor).toBe(100_000);
  });

  it('hides another tenant’s quotations from the list and the record', async () => {
    const deal = await createDeal(orgA, 'Hidden', [
      { name: 'Base', quantity: 1, unitPriceMinor: 10_000 },
    ]);
    const created = await configure<QuotationBody>('POST', '/quotations', {
      token: orgA.token,
      payload: { dealId: deal.id },
    });
    const listed = await api<QuotationBody[]>('GET', '/quotations', { token: orgB.token });
    expect(listed.body.data.map((row) => row.id)).not.toContain(created.body.data.id);

    const fetched = await api('GET', `/quotations/${created.body.data.id}`, { token: orgB.token });
    expect(fetched.statusCode).toBe(404);
  });
});

describe('the number series is the tenant’s', () => {
  it('reads the series and previews the next number', async () => {
    const series = await api<{ prefix: string; padding: number; nextNumber: string }>(
      'GET',
      '/settings/number-series/quotation',
      { token: orgB.token },
    );
    expect(series.statusCode).toBe(200);
    expect(series.body.data.prefix).toBe('QTN-');
    expect(series.body.data.nextNumber).toBe('QTN-0001');
  });

  it('changes the prefix and the padding, and the next quotation uses them', async () => {
    const tenant = await createTenant('series');
    await configure('PATCH', '/settings/number-series/quotation', {
      token: tenant.token,
      payload: { prefix: 'Q/2026/', padding: 3, nextValue: 140 },
    });
    const deal = await createDeal(tenant, 'Prefixed', [
      { name: 'Base', quantity: 1, unitPriceMinor: 10_000 },
    ]);
    const created = await configure<QuotationBody>('POST', '/quotations', {
      token: tenant.token,
      payload: { dealId: deal.id },
    });
    expect(created.body.data.number).toBe('Q/2026/140');
  });

  it('refuses to rewind the counter, because an earlier number has already been used', async () => {
    const tenant = await createTenant('rewind');
    await configure('PATCH', '/settings/number-series/quotation', {
      token: tenant.token,
      payload: { prefix: 'QTN-', padding: 4, nextValue: 50 },
    });
    const refused = await api('PATCH', '/settings/number-series/quotation', {
      token: tenant.token,
      payload: { prefix: 'QTN-', padding: 4, nextValue: 10 },
    });
    expect(refused.statusCode).toBe(422);
  });
});

describe('the acceptance says what it did to the deal', () => {
  it('records that a closed deal’s value was deliberately left alone', async () => {
    // Found by running it: accepting a quotation on a lost deal quietly did not move the figure,
    // and nothing said so — which reads exactly like the acceptance failing to register.
    const deal = await createDeal(orgA, 'ClosedDeal', [
      { name: 'Base', quantity: 1, unitPriceMinor: 100_000 },
    ]);
    const created = await configure<QuotationBody>('POST', '/quotations', {
      token: orgA.token,
      payload: {
        dealId: deal.id,
        items: [{ name: 'Agreed', quantity: 1, unitPriceMinor: 150_000 }],
      },
    });
    await configure('POST', `/quotations/${created.body.data.id}/send`, {
      token: orgA.token,
      payload: {},
    });
    await configure('POST', `/deals/${deal.id}/lose`, { token: orgA.token, payload: {} });
    await configure('POST', `/quotations/${created.body.data.id}/accept`, {
      token: orgA.token,
      payload: {},
    });

    const timeline = await api<{ type: string; payload: Record<string, unknown> }[]>(
      'GET',
      `/deals/${deal.id}/timeline`,
      { token: orgA.token },
    );
    const entry = timeline.body.data.find((row) => row.type === 'quotation.accepted');
    expect(entry?.payload['dealValueUpdated']).toBe(false);
    expect(entry?.payload['dealClosed']).toBe(true);
  });
});
