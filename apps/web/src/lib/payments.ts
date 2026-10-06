import { request } from '@/lib/api';

/** The payment shapes the screens read, hand-written against the documented envelope. */
export interface PaymentSummary {
  id: string;
  number: string;
  amountMinor: number;
  currency: string;
  status: 'pending' | 'succeeded' | 'failed' | 'refunded';
  reference: string | null;
  paidAt: string | null;
  failedAt: string | null;
  refundedAt: string | null;
  outcomeNote: string | null;
  methodId: string | null;
  method: { id: string; name: string } | null;
  dealId: string | null;
  deal: { id: string; name: string } | null;
  quotationId: string | null;
  quotation: { id: string; number: string; version: number; label: string } | null;
  leadId: string | null;
  lead: { id: string; fullName: string } | null;
  customerId: string | null;
  customer: { id: string; fullName: string } | null;
  createdAt: string;
  deletedAt: string | null;
}

export interface PaymentMethod {
  id: string;
  name: string;
  sortOrder: number;
  requiresReference: boolean;
  isActive: boolean;
}

export async function loadPayments(
  query: string,
  token: string | null,
): Promise<{
  items: PaymentSummary[];
  total?: number;
  totalMinor: number;
  receivedMinor: number;
  nextCursor: string | null;
}> {
  const response = await request<PaymentSummary[]>(`/payments${query}`, { token });
  const meta = response.meta as { totalMinor?: number; receivedMinor?: number } | undefined;
  return {
    items: response.data,
    ...(response.pagination?.total === undefined ? {} : { total: response.pagination.total }),
    totalMinor: meta?.totalMinor ?? 0,
    receivedMinor: meta?.receivedMinor ?? 0,
    nextCursor: response.pagination?.nextCursor ?? null,
  };
}

export async function loadPayment(id: string, token: string | null): Promise<PaymentSummary> {
  return (await request<PaymentSummary>(`/payments/${id}`, { token })).data;
}

/**
 * The payments against one deal.
 *
 * Swallows a failure, like `loadProducts`: the deal screen is worth rendering without its payments
 * panel, and a deal that will not open because one panel's request failed is worse than a deal with
 * one panel missing.
 */
export async function loadDealPayments(
  dealId: string,
  token: string | null,
): Promise<PaymentSummary[]> {
  try {
    return (await request<PaymentSummary[]>(`/payments?dealId=${dealId}&limit=50`, { token })).data;
  } catch {
    return [];
  }
}

/**
 * The methods a workspace accepts.
 *
 * `loadPaymentMethodsOrThrow` is for the settings screen, where an empty list and a failed request
 * look identical and must not — the distinction the product catalogue had to learn the hard way.
 */
export async function loadPaymentMethods(
  token: string | null,
  query = '',
): Promise<PaymentMethod[]> {
  try {
    return await loadPaymentMethodsOrThrow(token, query);
  } catch {
    return [];
  }
}

export async function loadPaymentMethodsOrThrow(
  token: string | null,
  query = '',
): Promise<PaymentMethod[]> {
  return (await request<PaymentMethod[]>(`/settings/payment-methods${query}`, { token })).data;
}

export const PAYMENT_STATUS_LABELS: Record<PaymentSummary['status'], string> = {
  pending: 'Not cleared',
  succeeded: 'Received',
  failed: 'Failed',
  refunded: 'Refunded',
};

/** Received is the only green: it is the only one that is money in the bank. */
export const PAYMENT_STATUS_CLASSES: Record<PaymentSummary['status'], string> = {
  pending: 'bg-amber-100 text-amber-900',
  succeeded: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-rose-100 text-rose-800',
  refunded: 'bg-slate-100 text-slate-700',
};
