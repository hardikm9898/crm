import { request } from '@/lib/api';

/** The quotation shapes the screens read, hand-written against the documented envelope. */
export interface QuotationSummary {
  id: string;
  number: string;
  version: number;
  /** `QTN-0007 v2` once there is more than one version — what a person says out loud. */
  label: string;
  status: 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired';
  title: string | null;
  validUntil: string | null;
  grossMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  currency: string;
  dealId: string | null;
  deal: { id: string; name: string } | null;
  leadId: string | null;
  lead: { id: string; fullName: string } | null;
  customerId: string | null;
  customer: { id: string; fullName: string } | null;
  supersededById: string | null;
  supersededAt: string | null;
  isCurrent: boolean;
  sentAt: string | null;
  sentVia: string | null;
  sentTo: string | null;
  acceptedAt: string | null;
  rejectedAt: string | null;
  rejectedReason: { id: string; name: string } | null;
  expiredAt: string | null;
  outcomeNote: string | null;
  hasPdf: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface QuotationLine {
  id: string;
  productId: string | null;
  position: number;
  name: string;
  description: string | null;
  quantity: number;
  unit: string | null;
  unitPriceMinor: number;
  discountMinor: number;
  taxPercent: number;
  grossMinor: number;
  netMinor: number;
  taxMinor: number;
  totalMinor: number;
}

export interface QuotationDetail extends QuotationSummary {
  terms: string | null;
  items: QuotationLine[];
  versions: {
    id: string;
    version: number;
    status: string;
    totalMinor: number;
    createdAt: string;
  }[];
}

export interface NumberSeries {
  kind: string;
  prefix: string;
  padding: number;
  nextValue: number;
  nextNumber: string;
}

export async function loadQuotations(
  query: string,
  token: string | null,
): Promise<{
  items: QuotationSummary[];
  total?: number;
  totalMinor: number;
  nextCursor: string | null;
}> {
  const response = await request<QuotationSummary[]>(`/quotations${query}`, { token });
  const meta = response.meta as { totalMinor?: number } | undefined;
  return {
    items: response.data,
    ...(response.pagination?.total === undefined ? {} : { total: response.pagination.total }),
    totalMinor: meta?.totalMinor ?? 0,
    nextCursor: response.pagination?.nextCursor ?? null,
  };
}

export async function loadQuotation(id: string, token: string | null): Promise<QuotationDetail> {
  return (await request<QuotationDetail>(`/quotations/${id}`, { token })).data;
}

/**
 * The quotations raised against one deal.
 *
 * Swallows a failure, like `loadProducts`: the deal screen is still worth rendering without its
 * quotation panel, and a deal that will not open because one panel's request failed is worse than a
 * deal with one panel missing. **Every version**, not just the current one, because the panel's job
 * on a deal is the history — "we quoted 2.5 lakh, then 2.2".
 */
export async function loadDealQuotations(
  dealId: string,
  token: string | null,
): Promise<QuotationSummary[]> {
  try {
    return (
      await request<QuotationSummary[]>(`/quotations?dealId=${dealId}&versions=all&limit=50`, {
        token,
      })
    ).data;
  } catch {
    return [];
  }
}

export async function loadNumberSeries(token: string | null): Promise<NumberSeries> {
  return (await request<NumberSeries>('/settings/number-series/quotation', { token })).data;
}

export const QUOTATION_STATUS_LABELS: Record<QuotationSummary['status'], string> = {
  draft: 'Draft',
  sent: 'Sent',
  accepted: 'Accepted',
  rejected: 'Rejected',
  expired: 'Expired',
};

/** Tailwind classes per status. Accepted is the only green: it is the only one that is money. */
export const QUOTATION_STATUS_CLASSES: Record<QuotationSummary['status'], string> = {
  draft: 'bg-slate-100 text-slate-700',
  sent: 'bg-sky-100 text-sky-800',
  accepted: 'bg-emerald-100 text-emerald-800',
  rejected: 'bg-rose-100 text-rose-800',
  expired: 'bg-amber-100 text-amber-900',
};
