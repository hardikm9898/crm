/**
 * The lead shapes this app renders, and the reads that fetch them.
 *
 * Types are hand-written against the documented envelope for the same reason the API client is: the
 * generated OpenAPI client arrives in Phase 4, and a hand-written type that says what the screen
 * actually uses is more honest than a generated one that does not exist yet.
 */

import { request } from './api';

export interface LeadSummary {
  id: string;
  fullName: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  city: string | null;
  status: { id: string; name?: string; colour?: string | null; category?: string };
  stage: { id: string; name?: string; colour?: string | null; isWon?: boolean; isLost?: boolean };
  pipelineId: string;
  leadSourceId: string | null;
  priority: string;
  score: number;
  scoreBand: string | null;
  valueMinor: number | null;
  currency: string | null;
  customValues: Record<string, unknown>;
  assignedUserId: string | null;
  branchId: string | null;
  teamId: string | null;
  openTasksCount: number;
  touchCount: number;
  nextActionAt: string | null;
  lastActivityAt: string | null;
  tags: { id: string; name: string; colour: string | null }[];
  createdAt: string;
  updatedAt: string;
}

export interface Touchpoint {
  id: string;
  sequence: number;
  occurredAt: string;
  channel: string;
  leadSourceId: string | null;
  landingPageUrl: string | null;
  utm: Record<string, unknown>;
  costAttributable: boolean;
}

export interface FieldDefinition {
  id: string;
  key: string;
  label: string;
  type: string;
  helpText?: string | null;
  isRequired?: boolean;
  sectionId?: string | null;
  sectionName?: string | null;
  options?: { value: string; label: string; colour?: string | null }[];
  capabilities?: { multiValue?: boolean; requiresOptions?: boolean };
}

export interface LeadDetail extends LeadSummary {
  jobTitle: string | null;
  phoneRaw: string | null;
  state: string | null;
  country: string | null;
  postalCode: string | null;
  landingPageUrl: string | null;
  utm: Record<string, unknown>;
  pipeline: { id: string; name: string } | null;
  lostReason: { id: string; name: string } | null;
  lostNote: string | null;
  convertedAt: string | null;
  lostAt: string | null;
  firstContactedAt: string | null;
  lastContactedAt: string | null;
  consent: { whatsapp: boolean; email: boolean; calls: boolean };
  createdVia: string;
  createdById: string | null;
  deletedAt: string | null;
  touchpoints: Touchpoint[];
  fieldDefinitions: FieldDefinition[];
}

export interface SavedView {
  id: string;
  name: string;
  entityType: string;
  filters: { conditions?: unknown[] };
  columns: string[];
  sort: { field?: string; direction?: string };
  visibility: string;
  teamId: string | null;
  defaultForRoleId: string | null;
  isSystem: boolean;
  sortOrder: number;
  isMine: boolean;
}

export interface ScoreBand {
  id: string;
  name: string;
  minScore: number;
  maxScore: number;
  colour: string | null;
}

export interface ScoreBreakdown {
  leadId: string;
  score: number;
  band: string | null;
  bands: { name: string; minScore: number; maxScore: number; colour?: string | null }[];
  addsUp: boolean;
  contributions: { ruleId: string | null; label: string; total: number; times: number }[];
  events: {
    id: string;
    at: string;
    delta: number;
    reason: string;
    scoreAfter: number;
    ruleId: string | null;
    ruleName: string | null;
  }[];
}

export interface DuplicatePair {
  id: string;
  lead: { id: string; fullName: string } | null;
  duplicateLead: { id: string; fullName: string } | null;
  confidence: number;
  status: string;
  matchFields: unknown;
  createdAt: string;
}

export interface StageSummary {
  id: string;
  name: string;
  colour: string | null;
  sortOrder: number;
  probability: number;
  isWon: boolean;
  isLost: boolean;
  requiredFields: string[];
  targetDurationHours: number | null;
}

export interface PipelineSummary {
  id: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  leadCount: number;
  stages: StageSummary[];
}

export interface Option {
  id: string;
  name: string;
  colour?: string | null;
  category?: string;
}

export interface MemberOption {
  userId: string;
  name: string;
  email: string;
}

/** A reference list, tolerating absence: a missing option list must not blank the whole screen. */
export async function loadOptions(path: string, token: string | null): Promise<Option[]> {
  if (!token) return [];
  try {
    const response = await request<Option[]>(path, { token });
    return response.data;
  } catch {
    return [];
  }
}

export async function loadMembers(token: string | null): Promise<MemberOption[]> {
  if (!token) return [];
  try {
    const response = await request<MemberOption[]>('/users?limit=100', { token });
    return response.data;
  } catch {
    return [];
  }
}

/** Builds `id → name` for resolving the ids a filter chip or a table cell carries. */
export function labelsOf(
  ...lists: readonly { id: string; name: string }[][]
): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const list of lists) {
    for (const entry of list) labels[entry.id] = entry.name;
  }
  return labels;
}

export function membersLabels(members: readonly MemberOption[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const member of members) labels[member.userId] = member.name;
  return labels;
}
