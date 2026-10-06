import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newToken } from '@leados/shared';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';

/**
 * THE PAYMENTS SUITE.
 *
 * `FR-DEAL-3` asks for "payments recorded manually or via a payment provider adapter, partial
 * payments supported; payment events feed automation and attribution". The assertions that matter
 * are the ones about **derived money**: that `deals.paid_minor` and the three `customers` rollups
 * always equal the ledger, including after a refund, a bounced cheque, a corrected amount and a
 * deleted row — and that concurrent payments do not lose each other, which is the bug an
 * incremented running total would have.
 *
 * Nothing is mocked. The totals come back from PostgreSQL, where `payments_amount_positive` and the
 * three status/timestamp CHECKs would refuse an inconsistent row outright.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2epay${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';

let ctx: TestApp;
let orgA: Tenant;
let orgB: Tenant;

interface Tenant {
  token: string;
  organizationId: string;
  userId: string;
}

interface PaymentBody {
  id: string;
  number: string;
  amountMinor: number;
  currency: string;
  status: string;
  reference: string | null;
  paidAt: string | null;
  failedAt: string | null;
  refundedAt: string | null;
  outcomeNote: string | null;
  method: { id: string; name: string } | null;
  dealId: string | null;
  quotationId: string | null;
  leadId: string | null;
  customerId: string | null;
}

interface DealBody {
  id: string;
  valueMinor: number;
  paidMinor: number;
  outstandingMinor: number;
}

interface CustomerBody {
  id: string;
  lifetimeValueMinor: number;
  firstPurchaseAt: string | null;
  lastPurchaseAt: string | null;
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
      organizationName: `Pay ${label} ${SUFFIX}`,
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
      lastName: 'Payer',
      company: `${label} Co`,
      email: `${label.toLowerCase()}.${SUFFIX}@pay.test`,
    },
  });
  return lead.body.data.id;
}

async function createDeal(
  tenant: Tenant,
  label: string,
  valueMinor = 100_000,
): Promise<{ id: string; leadId: string }> {
  const leadId = await createLead(tenant, label);
  const deal = await configure<{ id: string }>('POST', '/deals', {
    token: tenant.token,
    payload: { name: `${label} deal`, leadId, valueMinor },
  });
  return { id: deal.body.data.id, leadId };
}

async function methodNamed(tenant: Tenant, name: string): Promise<{ id: string; name: string }> {
  const methods = await api<{ id: string; name: string; requiresReference: boolean }[]>(
    'GET',
    '/settings/payment-methods',
    { token: tenant.token },
  );
  const found = methods.body.data.find((method) => method.name === name);
  if (!found) {
    throw new Error(
      `no seeded payment method called ${name}; got ${methods.body.data.map((m) => m.name).join(', ')}`,
    );
  }
  return found;
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

describe('a workspace can take money on its first day', () => {
  it('is seeded with the methods a business actually uses', async () => {
    const methods = await api<{ name: string; requiresReference: boolean }[]>(
      'GET',
      '/settings/payment-methods',
      { token: orgA.token },
    );
    expect(methods.statusCode).toBe(200);
    const names = methods.body.data.map((method) => method.name);
    expect(names).toContain('Cash');
    expect(names).toContain('UPI');
    // The ones that cannot be reconciled without a number say so.
    expect(methods.body.data.find((m) => m.name === 'Cheque')?.requiresReference).toBe(true);
    expect(methods.body.data.find((m) => m.name === 'Cash')?.requiresReference).toBe(false);
  });

  it('numbers a receipt from the workspace’s own series', async () => {
    const deal = await createDeal(orgA, 'Numbered');
    const payment = await api<PaymentBody>('POST', '/payments', {
      token: orgA.token,
      payload: { dealId: deal.id, amountMinor: 50_000 },
    });
    expect(payment.statusCode, JSON.stringify(payment.body)).toBe(201);
    expect(payment.body.data.number).toMatch(/^RCPT-\d{4}$/);
    expect(payment.body.data.status).toBe('succeeded');
    expect(payment.body.data.paidAt).not.toBeNull();
  });

  it('refuses a payment for nobody', async () => {
    const refused = await api('POST', '/payments', {
      token: orgA.token,
      payload: { amountMinor: 1_000 },
    });
    expect(refused.statusCode).toBe(400);
  });

  it('refuses a payment of nothing, and of a negative amount', async () => {
    const deal = await createDeal(orgA, 'Zero');
    for (const amountMinor of [0, -500]) {
      const refused = await api('POST', '/payments', {
        token: orgA.token,
        payload: { dealId: deal.id, amountMinor },
      });
      expect(refused.statusCode).toBe(400);
    }
  });

  it('asks for a reference when the method cannot be reconciled without one', async () => {
    const deal = await createDeal(orgA, 'Cheque');
    const cheque = await methodNamed(orgA, 'Cheque');
    const refused = await api('POST', '/payments', {
      token: orgA.token,
      payload: { dealId: deal.id, amountMinor: 10_000, methodId: cheque.id },
    });
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/cheque number/i);

    const accepted = await api<PaymentBody>('POST', '/payments', {
      token: orgA.token,
      payload: {
        dealId: deal.id,
        amountMinor: 10_000,
        methodId: cheque.id,
        reference: '004213',
      },
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.body.data.reference).toBe('004213');
    expect(accepted.body.data.method?.name).toBe('Cheque');
  });

  it('refuses another tenant’s payment method', async () => {
    const deal = await createDeal(orgA, 'ForeignMethod');
    const theirs = await methodNamed(orgB, 'Cash');
    const refused = await api('POST', '/payments', {
      token: orgA.token,
      payload: { dealId: deal.id, amountMinor: 1_000, methodId: theirs.id },
    });
    expect(refused.statusCode).toBe(404);
  });

  it('refuses a payment against another tenant’s deal, as a 404', async () => {
    const deal = await createDeal(orgA, 'Private');
    const refused = await api('POST', '/payments', {
      token: orgB.token,
      payload: { dealId: deal.id, amountMinor: 1_000 },
    });
    expect(refused.statusCode).toBe(404);
  });
});

describe('what was agreed and what arrived are different numbers', () => {
  it('adds up partial payments and reports what is still owed', async () => {
    const deal = await createDeal(orgA, 'Instalments', 300_000);
    for (const amount of [100_000, 50_000, 25_000]) {
      await configure('POST', '/payments', {
        token: orgA.token,
        payload: { dealId: deal.id, amountMinor: amount },
      });
    }
    const after = await api<DealBody>('GET', `/deals/${deal.id}`, { token: orgA.token });
    expect(after.body.data.valueMinor).toBe(300_000);
    expect(after.body.data.paidMinor).toBe(175_000);
    expect(after.body.data.outstandingMinor).toBe(125_000);
  });

  it('allows an overpayment and does not report a negative debt', async () => {
    // An advance for next year's work is real, and refusing it would make the system disagree with
    // the bank statement.
    const deal = await createDeal(orgA, 'Overpaid', 100_000);
    await configure('POST', '/payments', {
      token: orgA.token,
      payload: { dealId: deal.id, amountMinor: 150_000 },
    });
    const after = await api<DealBody>('GET', `/deals/${deal.id}`, { token: orgA.token });
    expect(after.body.data.paidMinor).toBe(150_000);
    expect(after.body.data.outstandingMinor).toBe(0);
  });

  it('does not count a pending cheque as money received', async () => {
    const deal = await createDeal(orgA, 'Pending', 100_000);
    const pending = await configure<PaymentBody>('POST', '/payments', {
      token: orgA.token,
      payload: { dealId: deal.id, amountMinor: 40_000, status: 'pending' },
    });
    expect(pending.body.data.status).toBe('pending');
    expect(pending.body.data.paidAt).toBeNull();
    let deal1 = await api<DealBody>('GET', `/deals/${deal.id}`, { token: orgA.token });
    expect(deal1.body.data.paidMinor).toBe(0);

    await configure('POST', `/payments/${pending.body.data.id}/confirm`, {
      token: orgA.token,
      payload: {},
    });
    deal1 = await api<DealBody>('GET', `/deals/${deal.id}`, { token: orgA.token });
    expect(deal1.body.data.paidMinor).toBe(40_000);
  });

  it('takes a bounced cheque back out of the total', async () => {
    const deal = await createDeal(orgA, 'Bounced', 100_000);
    const payment = await configure<PaymentBody>('POST', '/payments', {
      token: orgA.token,
      payload: { dealId: deal.id, amountMinor: 60_000 },
    });
    await configure('POST', `/payments/${payment.body.data.id}/fail`, {
      token: orgA.token,
      payload: { note: 'Returned unpaid' },
    });
    const after = await api<DealBody>('GET', `/deals/${deal.id}`, { token: orgA.token });
    expect(after.body.data.paidMinor).toBe(0);

    // And the record of having received it stays, with the reason.
    const failed = await api<PaymentBody>('GET', `/payments/${payment.body.data.id}`, {
      token: orgA.token,
    });
    expect(failed.body.data.status).toBe('failed');
    expect(failed.body.data.paidAt).toBeNull();
    expect(failed.body.data.failedAt).not.toBeNull();
    expect(failed.body.data.outcomeNote).toBe('Returned unpaid');
  });

  it('takes a refund back out of the total without erasing the receipt', async () => {
    const deal = await createDeal(orgA, 'Refunded', 100_000);
    const payment = await configure<PaymentBody>('POST', '/payments', {
      token: orgA.token,
      payload: { dealId: deal.id, amountMinor: 80_000 },
    });
    await configure('POST', `/payments/${payment.body.data.id}/refund`, {
      token: orgA.token,
      payload: { note: 'Customer cancelled' },
    });
    const after = await api<DealBody>('GET', `/deals/${deal.id}`, { token: orgA.token });
    expect(after.body.data.paidMinor).toBe(0);

    const refunded = await api<PaymentBody>('GET', `/payments/${payment.body.data.id}`, {
      token: orgA.token,
    });
    expect(refunded.body.data.status).toBe('refunded');
    // A refund reverses something that arrived, so it keeps the date it arrived on.
    expect(refunded.body.data.paidAt).not.toBeNull();
    expect(refunded.body.data.refundedAt).not.toBeNull();
  });

  it('corrects a transposed amount and moves the total with it', async () => {
    const deal = await createDeal(orgA, 'Typo', 500_000);
    const payment = await configure<PaymentBody>('POST', '/payments', {
      token: orgA.token,
      payload: { dealId: deal.id, amountMinor: 450_000 },
    });
    await configure('PATCH', `/payments/${payment.body.data.id}`, {
      token: orgA.token,
      payload: { amountMinor: 45_000 },
    });
    const after = await api<DealBody>('GET', `/deals/${deal.id}`, { token: orgA.token });
    expect(after.body.data.paidMinor).toBe(45_000);
  });

  it('takes a deleted payment out of the total', async () => {
    const deal = await createDeal(orgA, 'Deleted', 100_000);
    const payment = await configure<PaymentBody>('POST', '/payments', {
      token: orgA.token,
      payload: { dealId: deal.id, amountMinor: 30_000 },
    });
    await configure('DELETE', `/payments/${payment.body.data.id}`, { token: orgA.token });
    const after = await api<DealBody>('GET', `/deals/${deal.id}`, { token: orgA.token });
    expect(after.body.data.paidMinor).toBe(0);
  });

  it('does not lose a payment when several arrive at once', async () => {
    // The reason the rollup is recomputed from the ledger rather than incremented: two writers
    // reading the same "before" figure is how a running total silently loses money.
    const deal = await createDeal(orgA, 'Concurrent', 1_000_000);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        api<PaymentBody>('POST', '/payments', {
          token: orgA.token,
          payload: { dealId: deal.id, amountMinor: 10_000 },
        }),
      ),
    );
    for (const result of results) {
      expect(result.statusCode, JSON.stringify(result.body)).toBe(201);
    }
    expect(new Set(results.map((r) => r.body.data.number)).size).toBe(6);
    const after = await api<DealBody>('GET', `/deals/${deal.id}`, { token: orgA.token });
    expect(after.body.data.paidMinor).toBe(60_000);
  });

  it('refuses the transitions that make no sense', async () => {
    const deal = await createDeal(orgA, 'Transitions', 100_000);
    const payment = await configure<PaymentBody>('POST', '/payments', {
      token: orgA.token,
      payload: { dealId: deal.id, amountMinor: 10_000 },
    });
    // Already succeeded: confirming is a no-op, not an error.
    const confirmed = await api<PaymentBody>('POST', `/payments/${payment.body.data.id}/confirm`, {
      token: orgA.token,
      payload: {},
    });
    expect(confirmed.statusCode).toBe(200);

    await configure('POST', `/payments/${payment.body.data.id}/refund`, {
      token: orgA.token,
      payload: {},
    });
    const refusedFail = await api('POST', `/payments/${payment.body.data.id}/fail`, {
      token: orgA.token,
      payload: {},
    });
    expect(refusedFail.statusCode).toBe(422);
    const refusedEdit = await api('PATCH', `/payments/${payment.body.data.id}`, {
      token: orgA.token,
      payload: { amountMinor: 1 },
    });
    expect(refusedEdit.statusCode).toBe(422);
  });
});

describe('the customer’s lifetime value, at last', () => {
  async function convertedCustomer(label: string) {
    const leadId = await createLead(orgA, label);
    const converted = await configure<{ id: string }>('POST', `/leads/${leadId}/convert`, {
      token: orgA.token,
      payload: {},
    });
    return { leadId, customerId: converted.body.data.id };
  }

  it('sums everything a customer has paid, with the first and last dates', async () => {
    const { customerId } = await convertedCustomer('Lifetime');
    await configure('POST', '/payments', {
      token: orgA.token,
      payload: { customerId, amountMinor: 120_000, paidAt: '2026-03-04T10:00:00.000Z' },
    });
    await configure('POST', '/payments', {
      token: orgA.token,
      payload: { customerId, amountMinor: 80_000, paidAt: '2026-06-18T10:00:00.000Z' },
    });

    const customer = await api<CustomerBody>('GET', `/customers/${customerId}`, {
      token: orgA.token,
    });
    expect(customer.body.data.lifetimeValueMinor).toBe(200_000);
    expect(customer.body.data.firstPurchaseAt).toContain('2026-03-04');
    expect(customer.body.data.lastPurchaseAt).toContain('2026-06-18');
  });

  it('counts a deposit taken before the sale closed, because conversion loses nothing', async () => {
    // A payment recorded against the lead is still this customer's money: conversion does not
    // re-parent anything (`FR-DEAL-4`), so the rollup is a union, exactly like the timeline.
    const leadId = await createLead(orgA, 'Deposit');
    await configure('POST', '/payments', {
      token: orgA.token,
      payload: { leadId, amountMinor: 25_000, paidAt: '2026-01-10T10:00:00.000Z' },
    });
    const converted = await configure<{ id: string }>('POST', `/leads/${leadId}/convert`, {
      token: orgA.token,
      payload: {},
    });
    // The conversion itself does not recompute, so a later payment is what refreshes it — which is
    // also the honest behaviour: the figure is derived, and derived figures are recomputed on write.
    await configure('POST', '/payments', {
      token: orgA.token,
      payload: {
        customerId: converted.body.data.id,
        amountMinor: 75_000,
        paidAt: '2026-02-01T10:00:00.000Z',
      },
    });

    const customer = await api<CustomerBody>('GET', `/customers/${converted.body.data.id}`, {
      token: orgA.token,
    });
    expect(customer.body.data.lifetimeValueMinor).toBe(100_000);
    expect(customer.body.data.firstPurchaseAt).toContain('2026-01-10');
  });

  it('drops a refund out of the lifetime value', async () => {
    const { customerId } = await convertedCustomer('RefundLtv');
    const first = await configure<PaymentBody>('POST', '/payments', {
      token: orgA.token,
      payload: { customerId, amountMinor: 100_000 },
    });
    await configure('POST', '/payments', {
      token: orgA.token,
      payload: { customerId, amountMinor: 50_000 },
    });
    await configure('POST', `/payments/${first.body.data.id}/refund`, {
      token: orgA.token,
      payload: {},
    });
    const customer = await api<CustomerBody>('GET', `/customers/${customerId}`, {
      token: orgA.token,
    });
    expect(customer.body.data.lifetimeValueMinor).toBe(50_000);
  });

  it('clears the dates when every payment is reversed', async () => {
    const { customerId } = await convertedCustomer('AllGone');
    const only = await configure<PaymentBody>('POST', '/payments', {
      token: orgA.token,
      payload: { customerId, amountMinor: 10_000 },
    });
    await configure('POST', `/payments/${only.body.data.id}/refund`, {
      token: orgA.token,
      payload: {},
    });
    const customer = await api<CustomerBody>('GET', `/customers/${customerId}`, {
      token: orgA.token,
    });
    expect(customer.body.data.lifetimeValueMinor).toBe(0);
    expect(customer.body.data.firstPurchaseAt).toBeNull();
    expect(customer.body.data.lastPurchaseAt).toBeNull();
  });
});

describe('a payment against a quotation', () => {
  it('inherits the deal and the party from the quotation it pays', async () => {
    const deal = await createDeal(orgA, 'Quoted', 200_000);
    const quotation = await configure<{ id: string; number: string }>('POST', '/quotations', {
      token: orgA.token,
      payload: {
        dealId: deal.id,
        items: [{ name: 'Agreed scope', quantity: 1, unitPriceMinor: 200_000 }],
      },
    });
    await configure('POST', `/quotations/${quotation.body.data.id}/send`, {
      token: orgA.token,
      payload: {},
    });
    const payment = await configure<PaymentBody>('POST', '/payments', {
      token: orgA.token,
      payload: { quotationId: quotation.body.data.id, amountMinor: 100_000 },
    });
    expect(payment.body.data.dealId).toBe(deal.id);
    expect(payment.body.data.leadId).toBe(deal.leadId);
    expect(payment.body.data.quotationId).toBe(quotation.body.data.id);

    // And the deal it belongs to follows.
    const after = await api<DealBody>('GET', `/deals/${deal.id}`, { token: orgA.token });
    expect(after.body.data.paidMinor).toBe(100_000);
  });
});

describe('the timeline and the list', () => {
  it('writes the payment on the deal and on the lead, because that is what a business owner looks for', async () => {
    const deal = await createDeal(orgA, 'Timelined', 100_000);
    const cash = await methodNamed(orgA, 'Cash');
    await configure('POST', '/payments', {
      token: orgA.token,
      payload: { dealId: deal.id, amountMinor: 70_000, methodId: cash.id, note: 'Collected' },
    });

    const dealTimeline = await api<{ type: string; payload: Record<string, unknown> }[]>(
      'GET',
      `/deals/${deal.id}/timeline`,
      { token: orgA.token },
    );
    expect(dealTimeline.body.data.map((e) => e.type)).toContain('payment.received');

    const leadTimeline = await api<{ type: string; payload: Record<string, unknown> }[]>(
      'GET',
      `/leads/${deal.leadId}/timeline`,
      { token: orgA.token },
    );
    const entry = leadTimeline.body.data.find((row) => row.type === 'payment.received');
    expect(entry, 'the lead must show that they paid').toBeTruthy();
    expect(entry?.payload['amountMinor']).toBe(70_000);
    expect(entry?.payload['method']).toBe('Cash');
  });

  it('shows a payment once on a converted customer’s journey, not twice', async () => {
    const leadId = await createLead(orgA, 'ConvertedPay');
    const converted = await configure<{ id: string }>('POST', `/leads/${leadId}/convert`, {
      token: orgA.token,
      payload: {},
    });
    await configure('POST', '/payments', {
      token: orgA.token,
      payload: { leadId, customerId: converted.body.data.id, amountMinor: 10_000 },
    });
    const journey = await api<{ type: string }[]>(
      'GET',
      `/customers/${converted.body.data.id}/timeline`,
      { token: orgA.token },
    );
    expect(journey.body.data.filter((e) => e.type === 'payment.received')).toHaveLength(1);
  });

  it('reports the filter’s total and its received total separately', async () => {
    const deal = await createDeal(orgA, 'Totals', 500_000);
    const succeeded = await configure<PaymentBody>('POST', '/payments', {
      token: orgA.token,
      payload: { dealId: deal.id, amountMinor: 100_000 },
    });
    expect(succeeded.body.data.status).toBe('succeeded');
    await configure('POST', '/payments', {
      token: orgA.token,
      payload: { dealId: deal.id, amountMinor: 40_000, status: 'pending' },
    });

    const listed = await api<PaymentBody[]>('GET', `/payments?dealId=${deal.id}&limit=1`, {
      token: orgA.token,
    });
    const meta = listed.body.meta as { totalMinor: number; receivedMinor: number };
    // A screen that showed only the first figure would count a cheque that has not cleared.
    expect(meta.totalMinor).toBe(140_000);
    expect(meta.receivedMinor).toBe(100_000);
  });

  it('hides another tenant’s payments from the list and the record', async () => {
    const deal = await createDeal(orgA, 'Hidden', 100_000);
    const payment = await configure<PaymentBody>('POST', '/payments', {
      token: orgA.token,
      payload: { dealId: deal.id, amountMinor: 5_000 },
    });
    const listed = await api<PaymentBody[]>('GET', '/payments', { token: orgB.token });
    expect(listed.body.data.map((row) => row.id)).not.toContain(payment.body.data.id);
    const fetched = await api('GET', `/payments/${payment.body.data.id}`, { token: orgB.token });
    expect(fetched.statusCode).toBe(404);
  });

  it('lets two workspaces use the same receipt number', async () => {
    const mine = await createDeal(orgA, 'SameNumberA', 10_000);
    const theirs = await createDeal(orgB, 'SameNumberB', 10_000);
    const a = await configure<PaymentBody>('POST', '/payments', {
      token: orgA.token,
      payload: { dealId: mine.id, amountMinor: 1_000 },
    });
    const b = await configure<PaymentBody>('POST', '/payments', {
      token: orgB.token,
      payload: { dealId: theirs.id, amountMinor: 1_000 },
    });
    expect(a.body.data.number).toBeTruthy();
    expect(b.body.data.number).toBeTruthy();
    // Both counters are their own, so org B's first receipt is RCPT-0001 whatever org A has done.
    expect(b.body.data.number).toBe('RCPT-0001');
  });
});

describe('the methods are the workspace’s own', () => {
  it('adds, renames and deactivates a method', async () => {
    const created = await configure<{ id: string }>('POST', '/settings/payment-methods', {
      token: orgA.token,
      payload: { name: `Wallet ${SUFFIX}`, requiresReference: true },
    });
    const renamed = await configure('PATCH', `/settings/payment-methods/${created.body.data.id}`, {
      token: orgA.token,
      payload: { name: `Wallet renamed ${SUFFIX}`, isActive: false },
    });
    expect(renamed.statusCode).toBe(200);

    const active = await api<{ id: string }[]>('GET', '/settings/payment-methods', {
      token: orgA.token,
    });
    expect(active.body.data.map((m) => m.id)).not.toContain(created.body.data.id);
    const all = await api<{ id: string }[]>(
      'GET',
      '/settings/payment-methods?includeInactive=true',
      { token: orgA.token },
    );
    expect(all.body.data.map((m) => m.id)).toContain(created.body.data.id);
  });

  it('refuses to delete a method that has been used, and says what to do instead', async () => {
    const deal = await createDeal(orgA, 'UsedMethod', 10_000);
    const created = await configure<{ id: string }>('POST', '/settings/payment-methods', {
      token: orgA.token,
      payload: { name: `Barter ${SUFFIX}` },
    });
    await configure('POST', '/payments', {
      token: orgA.token,
      payload: { dealId: deal.id, amountMinor: 1_000, methodId: created.body.data.id },
    });
    const refused = await api('DELETE', `/settings/payment-methods/${created.body.data.id}`, {
      token: orgA.token,
    });
    expect(refused.statusCode).toBe(422);
    expect(JSON.stringify(refused.body)).toMatch(/Deactivate it instead/);
  });

  it('deletes a method nobody has used', async () => {
    const created = await configure<{ id: string }>('POST', '/settings/payment-methods', {
      token: orgA.token,
      payload: { name: `Unused ${SUFFIX}` },
    });
    const deleted = await api('DELETE', `/settings/payment-methods/${created.body.data.id}`, {
      token: orgA.token,
    });
    expect(deleted.statusCode).toBe(200);
  });

  it('refuses two methods with the same name', async () => {
    const name = `Twice ${SUFFIX}`;
    await configure('POST', '/settings/payment-methods', {
      token: orgA.token,
      payload: { name },
    });
    const refused = await api('POST', '/settings/payment-methods', {
      token: orgA.token,
      payload: { name },
    });
    expect(refused.statusCode).toBeGreaterThanOrEqual(400);
  });
});
