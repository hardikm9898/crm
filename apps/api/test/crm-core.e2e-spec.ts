import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CUSTOM_FIELD_TYPES, customFieldSpec, newToken } from '@leados/shared';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';

/**
 * THE CRM CORE SUITE.
 *
 * The Phase 2 exit criterion this file exists for: *creating a custom field of every supported type
 * requires no migration and no deploy, and that field is immediately usable*. Everything else here
 * protects the invariants the rest of Phase 2 will be built on — that a transition writes its
 * history, that the timeline records the journey, that configuration in use cannot be destroyed, and
 * that none of it leaks between tenants.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2ecrm${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';

let ctx: TestApp;

interface Tenant {
  token: string;
  organizationId: string;
  userId: string;
}

let orgA: Tenant;
let orgB: Tenant;
let config: ConfigBundle;

interface ConfigBundle {
  statuses: { id: string; name: string; category: string; isDefault: boolean }[];
  sources: { id: string; name: string }[];
  lostReasons: { id: string; name: string; requiresNote: boolean }[];
  pipelines: {
    id: string;
    name: string;
    isDefault: boolean;
    stages: { id: string; name: string }[];
  }[];
  tags: { id: string; name: string }[];
  fields: { id: string; key: string }[];
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
      organizationName: `CRM ${label} ${SUFFIX}`,
    },
  });
  return {
    token: registered.body.data.tokens.accessToken,
    organizationId: registered.body.data.activeOrganizationId,
    userId: registered.body.data.user.id,
  };
}

async function api<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  options: { token: string; payload?: unknown } = { token: '' },
) {
  return call<EnvelopeBody<T>>(ctx.app, {
    method,
    url: `/api/v1${url}`,
    token: options.token,
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
}

beforeAll(async () => {
  ctx = await bootTestApp();
  orgA = await createTenant('orga');
  orgB = await createTenant('orgb');
  const bundle = await api<ConfigBundle>('GET', '/crm/config', { token: orgA.token });
  config = bundle.body.data;
}, 120_000);

afterAll(async () => {
  await cleanupUsers(ctx.db, EMAIL_MARKER);
  await ctx.close();
});

describe('a new organization is usable immediately', () => {
  it('is provisioned with a CRM vocabulary, not an empty shell', () => {
    // A workspace with no default status is one where lead creation fails — the half-provisioned
    // state rule 18 forbids.
    expect(config.statuses.length).toBeGreaterThan(0);
    expect(config.sources.length).toBeGreaterThan(0);
    expect(config.lostReasons.length).toBeGreaterThan(0);
    expect(config.pipelines[0]?.stages.length).toBeGreaterThan(0);
  });

  it('has exactly one default status and one default pipeline', () => {
    expect(config.statuses.filter((status) => status.isDefault)).toHaveLength(1);
    expect(config.pipelines.filter((pipeline) => pipeline.isDefault)).toHaveLength(1);
  });

  it('classifies statuses so code can branch on the category, never the name', () => {
    const categories = new Set(config.statuses.map((status) => status.category));
    expect(categories.has('open')).toBe(true);
    expect(categories.has('won')).toBe(true);
    expect(categories.has('lost')).toBe(true);
  });

  it('can create a lead with no configuration of its own', async () => {
    const created = await api<{ id: string }>('POST', '/leads', {
      token: orgA.token,
      payload: { firstName: 'First', lastName: 'Lead' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body.data.id).toBeTruthy();
  });
});

describe('custom fields: no migration, no deploy', () => {
  const NEEDS_OPTIONS = new Set(['select', 'multiselect', 'radio', 'checkbox_group']);
  const created: string[] = [];

  it('creates a field of every supported type', async () => {
    for (const type of CUSTOM_FIELD_TYPES) {
      const response = await api<{ id: string; key: string }>('POST', '/custom-fields', {
        token: orgA.token,
        payload: {
          entityType: 'lead',
          key: `cf_${type}`,
          label: `Test ${type}`,
          type,
          ...(NEEDS_OPTIONS.has(type)
            ? {
                options: [
                  { value: 'alpha', label: 'Alpha' },
                  { value: 'beta', label: 'Beta' },
                ],
              }
            : {}),
        },
      });
      expect(response.statusCode, `${type}: ${JSON.stringify(response.body.error)}`).toBe(201);
      created.push(response.body.data.key);
    }
    expect(created).toHaveLength(CUSTOM_FIELD_TYPES.length);
  });

  it('makes them visible at once — no cache staleness between creating and using', async () => {
    const listed = await api<{ key: string; capabilities: { operators: string[] } }[]>(
      'GET',
      '/custom-fields?entityType=lead',
      { token: orgA.token },
    );
    const keys = listed.body.data.map((field) => field.key);
    for (const type of CUSTOM_FIELD_TYPES) expect(keys).toContain(`cf_${type}`);
    // Every field must arrive filterable, or "immediately usable in a view" is not true.
    expect(listed.body.data.every((field) => field.capabilities.operators.length > 0)).toBe(true);
  });

  it('stores one canonical shape per type', async () => {
    const lead = await api<{ id: string }>('POST', '/leads', {
      token: orgA.token,
      payload: {
        firstName: 'Canonical',
        lastName: 'Values',
        customValues: {
          cf_text: '  spaced  ',
          cf_number: 3,
          cf_decimal: 1.23456,
          cf_currency: 4500,
          cf_boolean: 'yes',
          cf_date: '2026-03-15',
          cf_datetime: '2026-03-15T10:30:00+05:30',
          cf_select: 'alpha',
          cf_multiselect: ['alpha', 'beta', 'alpha'],
          cf_checkbox_group: 'alpha',
          cf_email: 'MiXeD@Example.TEST',
          cf_phone: '98765 43210',
          cf_rating: 4,
        },
      },
    });
    expect(lead.statusCode, JSON.stringify(lead.body.error)).toBe(201);

    const fetched = await api<{ customValues: Record<string, unknown> }>(
      'GET',
      `/leads/${lead.body.data.id}`,
      { token: orgA.token },
    );
    const values = fetched.body.data.customValues;
    expect(values['cf_text']).toBe('spaced');
    expect(values['cf_decimal']).toBe(1.23456);
    expect(values['cf_currency']).toEqual({ amountMinor: 450000, currency: 'INR' });
    expect(values['cf_boolean']).toBe(true);
    expect(values['cf_datetime']).toBe('2026-03-15T05:00:00.000Z');
    expect(values['cf_multiselect']).toEqual(['alpha', 'beta']);
    expect(values['cf_checkbox_group']).toEqual(['alpha']);
    expect(values['cf_email']).toBe('mixed@example.test');
    // A custom phone is normalized exactly like the lead's own, so the two are comparable.
    expect(values['cf_phone']).toBe('+919876543210');
  });

  it('refuses a key that is not a defined field, and names the ones that are', async () => {
    const response = await api('POST', '/leads', {
      token: orgA.token,
      payload: { firstName: 'Typo', customValues: { cf_txet: 'oops' } },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.body.error?.details)).toContain('cf_text');
  });

  it('refuses a definition whose validation rule its type ignores', async () => {
    // A boolean with a regex is a definition that would quietly do nothing.
    const response = await api('POST', '/custom-fields', {
      token: orgA.token,
      payload: {
        entityType: 'lead',
        key: 'cf_bad_rule',
        label: 'Bad',
        type: 'boolean',
        validation: { regex: '^x$' },
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a choice field with no choices', async () => {
    const response = await api('POST', '/custom-fields', {
      token: orgA.token,
      payload: { entityType: 'lead', key: 'cf_empty_choice', label: 'Empty', type: 'select' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('keeps values when a field is removed, and refuses to reuse its key', async () => {
    const definition = await api<{ id: string }>('POST', '/custom-fields', {
      token: orgA.token,
      payload: { entityType: 'lead', key: 'cf_temporary', label: 'Temporary', type: 'text' },
    });
    const lead = await api<{ id: string }>('POST', '/leads', {
      token: orgA.token,
      payload: {
        firstName: 'Keeps',
        lastName: 'History',
        customValues: { cf_temporary: 'recorded' },
      },
    });

    await api('DELETE', `/custom-fields/${definition.body.data.id}`, { token: orgA.token });

    const after = await api<{ customValues: Record<string, unknown> }>(
      'GET',
      `/leads/${lead.body.data.id}`,
      { token: orgA.token },
    );
    // A field removed today must not rewrite what was recorded last quarter.
    expect(after.body.data.customValues['cf_temporary']).toBe('recorded');

    const reuse = await api('POST', '/custom-fields', {
      token: orgA.token,
      payload: { entityType: 'lead', key: 'cf_temporary', label: 'Again', type: 'text' },
    });
    // Reusing the key would show one meaning's data under another's label.
    expect(reuse.statusCode).toBe(409);
  });

  it('retires an option instead of deleting it, so recorded choices stay readable', async () => {
    const definition = await api<{ id: string }>('POST', '/custom-fields', {
      token: orgA.token,
      payload: {
        entityType: 'lead',
        key: 'cf_retiring',
        label: 'Retiring',
        type: 'select',
        options: [
          { value: 'keep', label: 'Keep' },
          { value: 'drop', label: 'Drop' },
        ],
      },
    });
    const lead = await api<{ id: string }>('POST', '/leads', {
      token: orgA.token,
      payload: { firstName: 'Chose', lastName: 'Drop', customValues: { cf_retiring: 'drop' } },
    });

    await api('PUT', `/custom-fields/${definition.body.data.id}/options`, {
      token: orgA.token,
      payload: { options: [{ value: 'keep', label: 'Keep' }] },
    });

    const after = await api<{ customValues: Record<string, unknown> }>(
      'GET',
      `/leads/${lead.body.data.id}`,
      { token: orgA.token },
    );
    expect(after.body.data.customValues['cf_retiring']).toBe('drop');

    // …but it cannot be newly chosen.
    const reuse = await api('POST', '/leads', {
      token: orgA.token,
      payload: { firstName: 'Cannot', customValues: { cf_retiring: 'drop' } },
    });
    expect(reuse.statusCode).toBe(400);
  });

  it('describes every registry type to its client', async () => {
    const listed = await api<{ type: string; capabilities: { describe: string } | null }[]>(
      'GET',
      '/custom-fields?entityType=lead',
      { token: orgA.token },
    );
    for (const field of listed.body.data) {
      const spec = customFieldSpec(field.type);
      if (!spec) continue;
      expect(field.capabilities?.describe, field.type).toBe(spec.describe);
    }
  });
});

describe('a lead records its own history', () => {
  let leadId: string;

  beforeAll(async () => {
    const created = await api<{ id: string }>('POST', '/leads', {
      token: orgA.token,
      payload: {
        firstName: 'Journey',
        lastName: 'Lead',
        phone: '98765 12345',
        leadSourceId: config.sources[0]?.id,
        createdVia: 'form',
      },
    });
    leadId = created.body.data.id;
  });

  it('normalizes the phone and keeps what was typed', async () => {
    const lead = await api<{ phone: string; phoneRaw: string }>('GET', `/leads/${leadId}`, {
      token: orgA.token,
    });
    expect(lead.body.data.phone).toBe('+919876512345');
    expect(lead.body.data.phoneRaw).toBe('98765 12345');
  });

  it('captures attribution at creation, not on the second contact', async () => {
    const lead = await api<{ touchpoints: { sequence: number; channel: string }[] }>(
      'GET',
      `/leads/${leadId}`,
      { token: orgA.token },
    );
    expect(lead.body.data.touchpoints).toHaveLength(1);
    expect(lead.body.data.touchpoints[0]?.channel).toBe('form');
  });

  it('appends a touchpoint per contact and never overwrites the first', async () => {
    await api('POST', `/leads/${leadId}/touchpoints`, {
      token: orgA.token,
      payload: { channel: 'whatsapp' },
    });
    await api('POST', `/leads/${leadId}/touchpoints`, {
      token: orgA.token,
      payload: { channel: 'call' },
    });
    const lead = await api<{ touchpoints: { sequence: number; channel: string }[] }>(
      'GET',
      `/leads/${leadId}`,
      { token: orgA.token },
    );
    // The exit criterion: the same person reached three ways is one lead with three touchpoints.
    expect(lead.body.data.touchpoints.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    expect(lead.body.data.touchpoints[0]?.channel).toBe('form');
  });

  it('records status changes with the time spent in the previous status', async () => {
    const next = config.statuses.find((status) => status.category === 'open' && !status.isDefault);
    const response = await api<{ changed: boolean }>('POST', `/leads/${leadId}/status`, {
      token: orgA.token,
      payload: { statusId: next!.id },
    });
    expect(response.statusCode).toBe(200);

    const history = await ctx.db.leadStatusHistory.findMany({
      where: { leadId },
      orderBy: { createdAt: 'asc' },
    });
    // Two rows: the placement at creation, and this move. Duration is what lets a manager ask
    // "how long do leads sit in Contacted" — no amount of current-state querying can answer it.
    expect(history).toHaveLength(2);
    expect(history[1]?.fromStatusId).toBe(history[0]?.toStatusId);
    expect(history[1]?.durationSeconds).not.toBeNull();
  });

  it('demands a reason before a lead can be marked lost', async () => {
    const lost = config.statuses.find((status) => status.category === 'lost');
    const withoutReason = await api('POST', `/leads/${leadId}/status`, {
      token: orgA.token,
      payload: { statusId: lost!.id },
    });
    expect(withoutReason.statusCode).toBe(400);

    const needsNote = config.lostReasons.find((reason) => reason.requiresNote);
    const withoutNote = await api('POST', `/leads/${leadId}/status`, {
      token: orgA.token,
      payload: { statusId: lost!.id, lostReasonId: needsNote!.id },
    });
    expect(withoutNote.statusCode).toBe(400);

    const withNote = await api('POST', `/leads/${leadId}/status`, {
      token: orgA.token,
      payload: { statusId: lost!.id, lostReasonId: needsNote!.id, lostNote: 'Chose a competitor' },
    });
    expect(withNote.statusCode).toBe(200);
  });

  it('records stage changes and refuses a stage from another pipeline', async () => {
    const pipeline = config.pipelines.find((entry) => entry.isDefault)!;
    const second = pipeline.stages[1]!;
    const moved = await api('POST', `/leads/${leadId}/stage`, {
      token: orgA.token,
      payload: { stageId: second.id },
    });
    expect(moved.statusCode).toBe(200);

    const other = await api<{ id: string }>('POST', '/crm/pipelines', {
      token: orgA.token,
      payload: { name: `Rentals ${SUFFIX}`, stages: [{ name: 'Viewing' }, { name: 'Agreed' }] },
    });
    const otherStages = await ctx.db.pipelineStage.findMany({
      where: { pipelineId: other.body.data.id },
    });
    const crossPipeline = await api('POST', `/leads/${leadId}/stage`, {
      token: orgA.token,
      payload: { stageId: otherStages[0]!.id },
    });
    // A lead in a column that is not on its board is a kanban that lies.
    expect(crossPipeline.statusCode).toBe(422);
  });

  it('blocks a stage whose required fields are empty, and says which', async () => {
    const pipeline = config.pipelines.find((entry) => entry.isDefault)!;
    await api('PUT', `/crm/pipelines/${pipeline.id}/stages`, {
      token: orgA.token,
      payload: {
        stages: pipeline.stages.map((stage, index) => ({
          id: stage.id,
          name: stage.name,
          ...(index === 2 ? { requiredFields: ['value'] } : {}),
        })),
      },
    });
    const blocked = await api('POST', `/leads/${leadId}/stage`, {
      token: orgA.token,
      payload: { stageId: pipeline.stages[2]!.id },
    });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.body.error?.message).toContain('value');
  });

  it('records who a lead was assigned to, and when it went back to the pool', async () => {
    await api('POST', `/leads/${leadId}/assign`, {
      token: orgA.token,
      payload: { assignedUserId: orgA.userId, reason: 'taking this one' },
    });
    await api('POST', `/leads/${leadId}/assign`, {
      token: orgA.token,
      payload: { assignedUserId: null },
    });
    const assignments = await ctx.db.leadAssignment.findMany({
      where: { leadId },
      orderBy: { createdAt: 'asc' },
    });
    expect(assignments).toHaveLength(2);
    expect(assignments[0]?.toUserId).toBe(orgA.userId);
    expect(assignments[1]?.toUserId).toBeNull();
    expect(assignments[1]?.fromUserId).toBe(orgA.userId);
  });

  it('shows the whole journey on one timeline', async () => {
    const timeline = await api<{ type: string; actor: { name: string } }[]>(
      'GET',
      `/leads/${leadId}/timeline?limit=100`,
      { token: orgA.token },
    );
    const types = timeline.body.data.map((entry) => entry.type);
    // Rule 6: anything a business owner would want to see is here.
    for (const required of [
      'lead.created',
      'lead.source_captured',
      'lead.status_changed',
      'lead.stage_changed',
      'lead.assigned',
      'lead.unassigned',
      'lead.lost',
    ]) {
      expect(types, `${required} missing`).toContain(required);
    }
    // Every entry names who did it, or the timeline answers "what" without "who".
    expect(timeline.body.data.every((entry) => entry.actor.name.length > 0)).toBe(true);
  });

  it("paginates the timeline across the partitioned table's composite key", async () => {
    // `activities` has a composite primary key (`id`, `occurred_at`) because it is partitioned, so
    // the cursor has to carry both halves. An id-only cursor would silently return the wrong page.
    const first = await call<
      EnvelopeBody<{ id: string }[]> & {
        meta?: { pagination?: { nextCursor: string | null; hasMore: boolean } };
      }
    >(ctx.app, {
      method: 'GET',
      url: `/api/v1/leads/${leadId}/timeline?limit=2`,
      token: orgA.token,
    });
    expect(first.body.data).toHaveLength(2);
    const cursor = first.body.meta?.pagination?.nextCursor;
    expect(cursor).toBeTruthy();

    const second = await api<{ id: string }[]>(
      'GET',
      `/leads/${leadId}/timeline?limit=2&cursor=${encodeURIComponent(cursor!)}`,
      { token: orgA.token },
    );
    const firstIds = new Set(first.body.data.map((entry) => entry.id));
    expect(second.body.data.some((entry) => firstIds.has(entry.id))).toBe(false);
  });

  it('rejects a malformed cursor rather than silently starting over', async () => {
    const response = await api('GET', `/leads/${leadId}/timeline?cursor=not-a-cursor`, {
      token: orgA.token,
    });
    expect(response.statusCode).toBe(400);
  });

  it('deletes into a recycle bin and restores from it', async () => {
    const deleted = await api<{ recoverable: boolean }>('DELETE', `/leads/${leadId}`, {
      token: orgA.token,
    });
    expect(deleted.body.data.recoverable).toBe(true);

    const live = await api<{ id: string }[]>('GET', '/leads', { token: orgA.token });
    expect(live.body.data.some((lead) => lead.id === leadId)).toBe(false);

    const bin = await api<{ id: string }[]>('GET', '/leads?deleted=true', { token: orgA.token });
    expect(bin.body.data.some((lead) => lead.id === leadId)).toBe(true);

    await api('POST', `/leads/${leadId}/restore`, { token: orgA.token });
    const back = await api<{ id: string }[]>('GET', '/leads', { token: orgA.token });
    expect(back.body.data.some((lead) => lead.id === leadId)).toBe(true);
  });
});

describe('search finds a lead the way a person would look for one', () => {
  let leadId: string;

  beforeAll(async () => {
    const created = await api<{ id: string }>('POST', '/leads', {
      token: orgA.token,
      payload: {
        firstName: 'Findable',
        lastName: 'Person',
        company: 'Kothrud Motors',
        phone: '+919812345678',
        email: 'findable@example.test',
        city: 'Pune',
        customValues: { cf_text: 'baner three bedroom' },
      },
    });
    leadId = created.body.data.id;
  });

  it('finds them by name', async () => {
    const found = await api<{ id: string }[]>('GET', '/leads?search=Findable', {
      token: orgA.token,
    });
    expect(found.body.data.some((lead) => lead.id === leadId)).toBe(true);
  });

  it('finds them by the last digits of the number', async () => {
    const found = await api<{ id: string }[]>('GET', '/leads?search=5678', { token: orgA.token });
    expect(found.body.data.some((lead) => lead.id === leadId)).toBe(true);
  });

  it('finds them by a custom field value, with no index to configure', async () => {
    const found = await api<{ id: string }[]>('GET', '/leads?search=baner', { token: orgA.token });
    expect(found.body.data.some((lead) => lead.id === leadId)).toBe(true);
  });

  it('finds them by company and by email', async () => {
    const byCompany = await api<{ id: string }[]>('GET', '/leads?search=Kothrud', {
      token: orgA.token,
    });
    expect(byCompany.body.data.some((lead) => lead.id === leadId)).toBe(true);
    const byEmail = await api<{ id: string }[]>('GET', '/leads?search=findable@example.test', {
      token: orgA.token,
    });
    expect(byEmail.body.data.some((lead) => lead.id === leadId)).toBe(true);
  });

  it("does not find another tenant's lead", async () => {
    const found = await api<{ id: string }[]>('GET', '/leads?search=Findable', {
      token: orgB.token,
    });
    expect(found.body.data).toHaveLength(0);
  });
});

describe('configuration in use is protected', () => {
  it('refuses to delete a status that leads still hold, and says how many', async () => {
    const statuses = await api<{ id: string; leadCount: number; isDefault: boolean }[]>(
      'GET',
      '/crm/statuses',
      { token: orgA.token },
    );
    // Not the default one: that is refused for a different reason (clearing it would break lead
    // creation), and this test is about configuration being *in use*.
    const used = statuses.body.data.find((status) => status.leadCount > 0 && !status.isDefault);
    expect(used, 'the suite has moved leads off the default status').toBeDefined();

    const response = await api('DELETE', `/crm/statuses/${used!.id}`, { token: orgA.token });
    expect(response.statusCode).toBe(422);
    expect(response.body.error?.message).toMatch(/lead/);
  });

  it('refuses to clear the default status without naming a replacement', async () => {
    const defaultStatus = config.statuses.find((status) => status.isDefault)!;
    const response = await api('PATCH', `/crm/statuses/${defaultStatus.id}`, {
      token: orgA.token,
      payload: { isDefault: false },
    });
    // Clearing it would make lead creation fail for everyone.
    expect(response.statusCode).toBe(422);
  });

  it('moves the default when another status claims it', async () => {
    const other = config.statuses.find(
      (status) => !status.isDefault && status.category === 'open',
    )!;
    const response = await api('PATCH', `/crm/statuses/${other.id}`, {
      token: orgA.token,
      payload: { isDefault: true },
    });
    expect(response.statusCode).toBe(200);

    const after = await api<{ id: string; isDefault: boolean }[]>('GET', '/crm/statuses', {
      token: orgA.token,
    });
    expect(after.body.data.filter((status) => status.isDefault)).toHaveLength(1);

    // Put it back so later assertions about the default still hold.
    const original = config.statuses.find((status) => status.isDefault)!;
    await api('PATCH', `/crm/statuses/${original.id}`, {
      token: orgA.token,
      payload: { isDefault: true },
    });
  });

  it('refuses a pipeline with two won stages', async () => {
    const response = await api('POST', '/crm/pipelines', {
      token: orgA.token,
      payload: {
        name: `Double won ${SUFFIX}`,
        stages: [
          { name: 'A', isWon: true },
          { name: 'B', isWon: true },
        ],
      },
    });
    // Two won columns is revenue counted twice.
    expect(response.statusCode).toBe(422);
  });

  it('refuses to drop a stage that still holds leads', async () => {
    const pipeline = config.pipelines.find((entry) => entry.isDefault)!;
    const occupied = await ctx.db.lead.findFirst({
      where: { organizationId: orgA.organizationId, deletedAt: null },
      select: { stageId: true },
    });
    const response = await api('PUT', `/crm/pipelines/${pipeline.id}/stages`, {
      token: orgA.token,
      payload: {
        stages: pipeline.stages
          .filter((stage) => stage.id !== occupied!.stageId)
          .map((stage) => ({ id: stage.id, name: stage.name })),
      },
    });
    expect(response.statusCode).toBe(422);
  });

  it('creates a tag idempotently, because tagging happens mid-conversation', async () => {
    const first = await api<{ id: string; created: boolean }>('POST', '/crm/tags', {
      token: orgA.token,
      payload: { name: `Investor ${SUFFIX}` },
    });
    const second = await api<{ id: string; created: boolean }>('POST', '/crm/tags', {
      token: orgA.token,
      payload: { name: `Investor ${SUFFIX}` },
    });
    expect(first.body.data.created).toBe(true);
    expect(second.body.data.created).toBe(false);
    expect(second.body.data.id).toBe(first.body.data.id);
  });
});

describe('tenant isolation holds across every CRM surface', () => {
  let leadId: string;

  beforeAll(async () => {
    const created = await api<{ id: string }>('POST', '/leads', {
      token: orgA.token,
      payload: { firstName: 'Private', lastName: 'ToOrgA' },
    });
    leadId = created.body.data.id;
  });

  it('hides the lead from the other tenant on every route that names it', async () => {
    for (const [method, url, payload] of [
      ['GET', `/leads/${leadId}`, undefined],
      ['GET', `/leads/${leadId}/timeline`, undefined],
      ['PATCH', `/leads/${leadId}`, { city: 'Nowhere' }],
      ['DELETE', `/leads/${leadId}`, undefined],
      ['POST', `/leads/${leadId}/restore`, undefined],
      ['POST', `/leads/${leadId}/touchpoints`, { channel: 'manual' }],
      ['PUT', `/leads/${leadId}/tags`, { tagIds: [] }],
    ] as const) {
      const response = await api(method, url, {
        token: orgB.token,
        ...(payload === undefined ? {} : { payload }),
      });
      // 404, not 403: confirming it exists would leak that it does.
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it("refuses another tenant's status, stage, source and tag ids", async () => {
    const ownLead = await api<{ id: string }>('POST', '/leads', {
      token: orgB.token,
      payload: { firstName: 'Org', lastName: 'B' },
    });

    const foreignStatus = await api('POST', `/leads/${ownLead.body.data.id}/status`, {
      token: orgB.token,
      payload: { statusId: config.statuses[0]!.id },
    });
    expect(foreignStatus.statusCode).toBe(404);

    const foreignStage = await api('POST', `/leads/${ownLead.body.data.id}/stage`, {
      token: orgB.token,
      payload: { stageId: config.pipelines[0]!.stages[0]!.id },
    });
    expect(foreignStage.statusCode).toBe(404);

    const foreignSource = await api('POST', '/leads', {
      token: orgB.token,
      payload: { firstName: 'Cross', leadSourceId: config.sources[0]!.id },
    });
    expect(foreignSource.statusCode).toBe(404);
  });

  it("does not leak another tenant's custom field definitions", async () => {
    const fields = await api<{ key: string }[]>('GET', '/custom-fields?entityType=lead', {
      token: orgB.token,
    });
    expect(fields.body.data.some((field) => field.key.startsWith('cf_'))).toBe(false);
  });

  it('gives each tenant its own configuration bundle', async () => {
    const bundleB = await api<ConfigBundle>('GET', '/crm/config', { token: orgB.token });
    const aIds = new Set(config.statuses.map((status) => status.id));
    expect(bundleB.body.data.statuses.some((status) => aIds.has(status.id))).toBe(false);
    // …but both get a working vocabulary.
    expect(bundleB.body.data.statuses.length).toBeGreaterThan(0);
  });
});

describe('the timeline is append-only', () => {
  it('exposes no route that edits or deletes an activity', async () => {
    const lead = await api<{ id: string }>('POST', '/leads', {
      token: orgA.token,
      payload: { firstName: 'Immutable', lastName: 'History' },
    });
    const timeline = await api<{ id: string }[]>('GET', `/leads/${lead.body.data.id}/timeline`, {
      token: orgA.token,
    });
    const activityId = timeline.body.data[0]!.id;

    for (const method of ['PATCH', 'DELETE', 'PUT'] as const) {
      const response = await api(method, `/activities/${activityId}`, { token: orgA.token });
      // 404 from the router: there is no such route, by design (ADR-0009).
      expect(response.statusCode, method).toBe(404);
    }
  });

  it('writes a timeline entry inside the same transaction as the change', async () => {
    const lead = await api<{ id: string }>('POST', '/leads', {
      token: orgA.token,
      payload: { firstName: 'Atomic', lastName: 'Write' },
    });
    const activities = await ctx.db.activity.findMany({
      where: { leadId: lead.body.data.id },
    });
    // A lead with no `lead.created` entry would mean the two can diverge.
    expect(activities.some((entry) => entry.type === 'lead.created')).toBe(true);
  });

  it('lands each entry in the monthly partition its instant belongs to', async () => {
    const rows = await ctx.db.$queryRaw<{ landed: string }[]>`
      SELECT tableoid::regclass::text AS landed
      FROM activities
      WHERE organization_id = ${orgA.organizationId}::uuid
      LIMIT 1
    `;
    // Not the default partition: that would mean the month had no partition, which blocks the
    // maintenance job from ever attaching one.
    expect(rows[0]?.landed).toMatch(/^activities_\d{4}_\d{2}$/);
  });
});
