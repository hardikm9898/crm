import { request } from '@/lib/api';
import type { TimelineEntryLike } from '@/lib/timeline-registry';

/** The deal shapes the screens read, hand-written against the documented envelope. */
export interface DealSummary {
  id: string;
  name: string;
  stage: { id: string; name?: string; colour?: string | null; isWon?: boolean; isLost?: boolean };
  pipelineId: string;
  probability: number;
  valueMinor: number;
  grossMinor: number;
  discountMinor: number;
  taxMinor: number;
  /** What has arrived, and what is still owed. Derived from the payments ledger. */
  paidMinor: number;
  outstandingMinor: number;
  weightedMinor: number;
  currency: string;
  expectedCloseDate: string | null;
  wonAt: string | null;
  lostAt: string | null;
  outcome: 'open' | 'won' | 'lost';
  lead: { id: string; fullName: string } | null;
  customer: { id: string; fullName: string } | null;
  owner: { userId: string; name: string } | null;
  lastActivityAt: string | null;
  createdAt: string;
  deletedAt: string | null;
}

export interface DealItem {
  id: string;
  position: number;
  productId: string | null;
  productName: string | null;
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

export interface DealDetail extends DealSummary {
  pipeline: { id: string; name: string };
  lostReason: { id: string; name: string } | null;
  lostNote: string | null;
  items: DealItem[];
  customValues: Record<string, unknown>;
  customFields: { key: string; label: string; type: string; isRequired: boolean }[];
  updatedAt: string;
}

export interface DealBoard {
  pipeline: { id: string; name: string };
  columns: {
    stage: {
      id: string;
      name: string;
      colour: string | null;
      probability: number;
      isWon: boolean;
      isLost: boolean;
    };
    total: number;
    valueMinor: number;
    weightedMinor: number;
    deals: DealSummary[];
  }[];
}

export interface Product {
  id: string;
  name: string;
  sku: string | null;
  description: string | null;
  category: string | null;
  priceMinor: number;
  currency: string | null;
  taxPercent: number;
  unit: string | null;
  isActive: boolean;
}

export async function loadDealBoard(query: string, token: string | null): Promise<DealBoard> {
  return (await request<DealBoard>(`/deals/board${query}`, { token })).data;
}

export async function loadDeals(
  query: string,
  token: string | null,
): Promise<{
  items: DealSummary[];
  total?: number;
  totalValueMinor: number;
  nextCursor: string | null;
}> {
  const response = await request<DealSummary[]>(`/deals${query}`, { token });
  const meta = response.meta as { totalValueMinor?: number } | undefined;
  return {
    items: response.data,
    ...(response.pagination?.total === undefined ? {} : { total: response.pagination.total }),
    totalValueMinor: meta?.totalValueMinor ?? 0,
    nextCursor: response.pagination?.nextCursor ?? null,
  };
}

export async function loadDeal(id: string, token: string | null): Promise<DealDetail> {
  return (await request<DealDetail>(`/deals/${id}`, { token })).data;
}

export async function loadDealTimeline(
  id: string,
  token: string | null,
): Promise<TimelineEntryLike[]> {
  return (await request<TimelineEntryLike[]>(`/deals/${id}/timeline?limit=60`, { token })).data;
}

/**
 * The catalogue.
 *
 * Swallows a failure on purpose: a line-items editor without a catalogue is still usable, because
 * every line can be typed by hand, and a quotation screen that refuses to render because the
 * product list was unreachable would be worse than one with an empty dropdown.
 *
 * `loadProductsOrThrow` is for the settings screen, where an empty list and a failed request look
 * identical and must not. That distinction was not academic: the settings page asked for `active=`
 * with no value, the API refused it as not one of `true`/`false`, and this `catch` turned the 400
 * into "no products yet" — for every workspace, permanently.
 */
export async function loadProducts(token: string | null, query = '?limit=200'): Promise<Product[]> {
  try {
    return await loadProductsOrThrow(token, query);
  } catch {
    return [];
  }
}

export async function loadProductsOrThrow(
  token: string | null,
  query = '?limit=200',
): Promise<Product[]> {
  return (await request<Product[]>(`/products${query}`, { token })).data;
}
