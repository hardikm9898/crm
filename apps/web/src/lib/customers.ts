import { request } from '@/lib/api';
import type { TimelineEntryLike } from '@/lib/timeline-registry';

/**
 * The customer shapes the screens read.
 *
 * Hand-written against the documented envelope, like the rest of this client, until the generated
 * OpenAPI client arrives in Phase 4.
 */
export interface CustomerSummary {
  id: string;
  fullName: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  jobTitle: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  city: string | null;
  converted: boolean;
  convertedAt: string | null;
  owner: { userId: string; name: string; email: string } | null;
  branch: { id: string; name: string } | null;
  team: { id: string; name: string } | null;
  lastActivityAt: string | null;
  createdAt: string;
  deletedAt: string | null;
}

export interface CustomerDetail extends CustomerSummary {
  billing: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
    postalCode: string | null;
    taxId: string | null;
  };
  consent: { whatsapp: boolean; email: boolean; calls: boolean };
  customValues: Record<string, unknown>;
  customFields: {
    key: string;
    label: string;
    type: string;
    isRequired: boolean;
    isPii: boolean;
  }[];
  /** Where they came from, or null for somebody who was never a lead. */
  origin: {
    leadId: string;
    leadName: string;
    capturedAt: string;
    capturedVia: string;
    source: string | null;
    scoreAtConversion: number;
    scoreBand: string | null;
  } | null;
  updatedAt: string;
}

export interface CustomerPage {
  items: CustomerSummary[];
  total?: number;
  nextCursor: string | null;
}

export async function loadCustomers(query: string, token: string | null): Promise<CustomerPage> {
  const response = await request<CustomerSummary[]>(`/customers${query}`, { token });
  return {
    items: response.data,
    ...(response.pagination?.total === undefined ? {} : { total: response.pagination.total }),
    nextCursor: response.pagination?.nextCursor ?? null,
  };
}

export async function loadCustomer(id: string, token: string | null): Promise<CustomerDetail> {
  return (await request<CustomerDetail>(`/customers/${id}`, { token })).data;
}

/** The whole journey: the lead's half and the customer's, already merged by the API. */
export async function loadJourney(id: string, token: string | null): Promise<TimelineEntryLike[]> {
  return (await request<TimelineEntryLike[]>(`/customers/${id}/timeline?limit=60`, { token })).data;
}
