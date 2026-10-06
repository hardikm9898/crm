import { request } from '@/lib/api';

/** What the picker shows about each industry. */
export interface IndustryTemplateOption {
  key: string;
  name: string;
  description: string;
  statuses: number;
  stages: number;
  sources: number;
  lostReasons: number;
  tags: number;
  fields: number;
  views: number;
  fieldLabels: string[];
  /** True for the one this workspace already applied. */
  applied: boolean;
}

/**
 * The catalogue.
 *
 * Throws rather than swallowing: this is a screen whose only job is to offer a choice, and an empty
 * list is indistinguishable from a failed request — the mistake the product catalogue shipped with.
 */
export async function loadIndustryTemplates(
  token: string | null,
): Promise<IndustryTemplateOption[]> {
  return (await request<IndustryTemplateOption[]>('/organization/industry-templates', { token }))
    .data;
}
