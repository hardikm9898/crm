import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, newToken, WORKFLOW_ACTIONS, WORKFLOW_TRIGGERS } from '@leados/shared';
import { REFERENCE_SOURCES } from '../src/modules/automation/automation.catalogue.js';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';

/**
 * THE AUTOMATION SUITE — Phase 6, step 1 (`FR-AUT-1`, `FR-AUT-4`, `FR-AUT-5`, `FR-AUT-8`).
 *
 * Nothing runs yet; the executor is step 2's. What this suite is for is the three claims the step
 * actually makes, each of which could be false while every screen looked right:
 *
 *  1. **The registry is servable and complete.** Every reference kind the catalogue declares has
 *     an endpoint behind it that answers — a `reference` with a source that 404s is a picker that
 *     renders empty, which looks exactly like a workspace with no statuses.
 *  2. **A published version is immutable.** Editing after a publish writes a new version and
 *     leaves the published one byte-for-byte alone, which is the whole of "editing a live workflow
 *     does not alter in-flight runs".
 *  3. **The dispatch index says what was published**, and nothing else: an archived or deleted
 *     workflow leaves no row for an event to find.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2eaut${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';

let ctx: TestApp;
let orgA: { token: string; organizationId: string; userId: string };
let orgB: { token: string; organizationId: string };

async function api<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  options: { token?: string; payload?: unknown } = {},
) {
  return call<EnvelopeBody<T>>(ctx.app, {
    method,
    url: `/api/v1${url}`,
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
}

/** Setup goes through a helper that throws, so a refused fixture cannot take an assertion with it. */
async function setup<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  options: { token?: string; payload?: unknown } = {},
): Promise<T> {
  const response = await api<T>(method, url, options);
  if (response.statusCode >= 300) {
    throw new Error(`${method} ${url} → ${response.statusCode} ${JSON.stringify(response.body)}`);
  }
  return response.body.data;
}

async function register(name: string) {
  const email = `${EMAIL_MARKER}${name}@test.local`;
  const registered = await setup<{
    organization: { id: string };
    user: { id: string };
    tokens: { accessToken: string };
  }>('POST', '/auth/register', {
    payload: {
      email,
      password: PASSWORD,
      name: 'Automation Owner',
      organizationName: `AUT ${name}`,
    },
  });
  return {
    token: registered.tokens.accessToken,
    organizationId: registered.organization.id,
    userId: registered.user.id,
  };
}

interface Workflow {
  id: string;
  name: string;
  status: string;
  killSwitch: boolean;
  currentVersionId: string | null;
  reentryPolicy: string;
  cooldownHours: number | null;
  problems: { field: string; code: string; message: string }[];
  publishBlockedReason: string | null;
  draft: { id: string; version: number; isDraft: boolean; definition: unknown } | null;
  current: { id: string; version: number; definition: unknown } | null;
  versions: { id: string; version: number; isDraft: boolean }[];
  trigger: { type: string; event: string | null } | null;
}

async function workflow(overrides: Record<string, unknown> = {}): Promise<Workflow> {
  return setup<Workflow>('POST', '/automation/workflows', {
    token: orgA.token,
    payload: { name: `Nurture ${newId().slice(-8)}`, ...overrides },
  });
}

/** A definition that validates: one note on a new lead, which needs nothing from the workspace. */
function readyDefinition() {
  return {
    trigger: { type: 'lead.created' },
    steps: [{ id: 'note', action: 'add_note', params: { body: 'Automation said hello.' } }],
  };
}

beforeAll(async () => {
  ctx = await bootTestApp();
  orgA = await register('a');
  orgB = await register('b');
}, 120_000);

afterAll(async () => {
  await cleanupUsers(ctx.db, `${EMAIL_MARKER}%`);
  await ctx.close();
});

describe('the catalogue (`FR-AUT-1`)', () => {
  it('serves every trigger, condition and action the registry declares', async () => {
    const response = await api<{
      triggers: { key: string; event: string | null }[];
      actions: { key: string; control: boolean }[];
      conditionFields: { key: string }[];
      references: { kind: string; source: string }[];
      limits: { maxSteps: number; maxBranchDepth: number };
    }>('GET', '/automation/catalogue', { token: orgA.token });

    expect(response.statusCode).toBe(200);
    expect(response.body.data.triggers).toHaveLength(WORKFLOW_TRIGGERS.length);
    expect(response.body.data.actions).toHaveLength(WORKFLOW_ACTIONS.length);
    expect(response.body.data.limits.maxSteps).toBeGreaterThan(0);
  });

  /**
   * The assertion that makes "no frontend release" more than a claim: every reference kind has a
   * list endpoint, and every one of those answers. A declaration the screen cannot act on is half
   * a feature — the one-click "make this a field" lesson, in a picker.
   */
  it('names a list endpoint for every reference kind, and each one answers', async () => {
    const sources = new Set(Object.values(REFERENCE_SOURCES));
    for (const source of sources) {
      const response = await api('GET', source, { token: orgA.token });
      expect(response.statusCode, `${source} → ${response.statusCode}`).toBe(200);
    }
    // And no kind is left without one, which a `Record` type enforces at compile time and this
    // asserts at run time for anything cast along the way.
    for (const kind of Object.keys(REFERENCE_SOURCES)) {
      expect(REFERENCE_SOURCES[kind as keyof typeof REFERENCE_SOURCES]).toMatch(/^\//);
    }
  });

  it('refuses a caller without the permission', async () => {
    const response = await api('GET', '/automation/catalogue');
    expect(response.statusCode).toBe(401);
  });
});

describe('a workflow and its draft', () => {
  it('starts as a draft with an empty graph, and says what is missing', async () => {
    const created = await workflow();
    expect(created.status).toBe('draft');
    expect(created.currentVersionId).toBeNull();
    expect(created.draft?.version).toBe(1);
    expect(created.draft?.isDraft).toBe(true);
    // An empty graph is not publishable, and the reason is a sentence rather than a code.
    expect(created.problems.map((problem) => problem.code)).toContain('TRIGGER_MISSING');
    expect(created.publishBlockedReason).toContain('correct');
  });

  it('saves an incomplete draft rather than refusing it', async () => {
    const created = await workflow();
    const saved = await setup<Workflow>('PUT', `/automation/workflows/${created.id}/definition`, {
      token: orgA.token,
      payload: { definition: { trigger: { type: 'lead.created' }, steps: [] } },
    });
    // Saved — and honest about what is still wrong, which is the editor's whole affordance.
    expect(saved.draft?.version).toBe(1);
    expect(saved.problems.map((problem) => problem.code)).toContain('STEPS_MISSING');
  });

  it('updates the draft in place rather than minting a version per keystroke', async () => {
    const created = await workflow();
    for (const body of ['one', 'two', 'three']) {
      await setup('PUT', `/automation/workflows/${created.id}/definition`, {
        token: orgA.token,
        payload: {
          definition: { trigger: { type: 'lead.created' }, steps: [{ id: 'n', action: 'add_note', params: { body } }] },
        },
      });
    }
    const read = await setup<Workflow>('GET', `/automation/workflows/${created.id}`, {
      token: orgA.token,
    });
    expect(read.versions).toHaveLength(1);
    expect(read.draft?.definition).toMatchObject({ steps: [{ params: { body: 'three' } }] });
  });

  it('refuses a name a live workflow already has', async () => {
    const name = `Twice ${newId().slice(-8)}`;
    await workflow({ name });
    const second = await api('POST', '/automation/workflows', {
      token: orgA.token,
      payload: { name },
    });
    expect(second.statusCode).toBe(409);
  });

  it('frees the name when the workflow is deleted', async () => {
    const name = `Reused ${newId().slice(-8)}`;
    const first = await workflow({ name });
    await setup('DELETE', `/automation/workflows/${first.id}`, { token: orgA.token });
    // The partial unique is what makes this possible; a plain unique would make the name
    // unusable for ever.
    const again = await workflow({ name });
    expect(again.name).toBe(name);
  });

  it('pairs a cooldown policy with its hours, and refuses half of it', async () => {
    const created = await workflow({ reentryPolicy: 'cooldown', cooldownHours: 48 });
    expect(created.cooldownHours).toBe(48);

    const cleared = await setup<Workflow>('PATCH', `/automation/workflows/${created.id}`, {
      token: orgA.token,
      payload: { reentryPolicy: 'always' },
    });
    // `always` with hours would be a number nothing reads, which the CHECK refuses — so moving
    // the policy clears it rather than failing with a constraint name.
    expect(cleared.cooldownHours).toBeNull();

    const halved = await api('PATCH', `/automation/workflows/${created.id}`, {
      token: orgA.token,
      payload: { reentryPolicy: 'cooldown', cooldownHours: null },
    });
    expect(halved.statusCode).toBe(400);
  });
});

describe('publishing (`FR-AUT-5`)', () => {
  it('refuses to publish a workflow with problems, listing them', async () => {
    const created = await workflow();
    const refused = await api<never>('POST', `/automation/workflows/${created.id}/publish`, {
      token: orgA.token,
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.body.error?.code).toBe('VALIDATION_FAILED');
    expect((refused.body.error?.details as { code: string }[])[0]?.code).toBe('TRIGGER_MISSING');
  });

  it('publishes, goes live, and writes the dispatch index from the published version', async () => {
    const created = await workflow();
    await setup('PUT', `/automation/workflows/${created.id}/definition`, {
      token: orgA.token,
      payload: { definition: readyDefinition() },
    });
    const published = await setup<Workflow>(
      'POST',
      `/automation/workflows/${created.id}/publish`,
      { token: orgA.token },
    );

    expect(published.status).toBe('active');
    expect(published.currentVersionId).toBe(published.current?.id);
    expect(published.draft).toBeTruthy();
    expect(published.current?.version).toBe(1);
    expect(published.trigger).toEqual({ type: 'lead.created', event: 'lead.created' });

    // The index row, read from the database rather than from the response: it is what an event
    // will look at, and the response could be right while the row is wrong.
    const rows = await ctx.db.workflowTrigger.findMany({
      where: { organizationId: orgA.organizationId, workflowId: created.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event).toBe('lead.created');
    expect(rows[0]?.versionId).toBe(published.currentVersionId);
  });

  it('leaves the published version untouched when the workflow is edited again', async () => {
    const created = await workflow();
    await setup('PUT', `/automation/workflows/${created.id}/definition`, {
      token: orgA.token,
      payload: { definition: readyDefinition() },
    });
    const published = await setup<Workflow>(
      'POST',
      `/automation/workflows/${created.id}/publish`,
      { token: orgA.token },
    );
    const pinned = published.currentVersionId;

    await setup('PUT', `/automation/workflows/${created.id}/definition`, {
      token: orgA.token,
      payload: {
        definition: {
          trigger: { type: 'lead.created' },
          steps: [{ id: 'note', action: 'add_note', params: { body: 'Changed my mind.' } }],
        },
      },
    });

    const read = await setup<Workflow>(`GET` as 'GET', `/automation/workflows/${created.id}`, {
      token: orgA.token,
    });
    // A new draft, version 2, and the live version is still 1 — this is the whole of "editing a
    // live workflow does not alter in-flight runs".
    expect(read.draft?.version).toBe(2);
    expect(read.draft?.isDraft).toBe(true);
    expect(read.currentVersionId).toBe(pinned);

    const pinnedVersion = await setup<{ definition: { steps: { params: { body: string } }[] } }>(
      'GET',
      `/automation/workflows/${created.id}/versions/${pinned}`,
      { token: orgA.token },
    );
    expect(pinnedVersion.definition.steps[0]?.params.body).toBe('Automation said hello.');
    // And the index still points at what was published, not at the draft.
    const rows = await ctx.db.workflowTrigger.findMany({ where: { workflowId: created.id } });
    expect(rows[0]?.versionId).toBe(pinned);
  });

  it('answers that there is nothing to publish when the draft is already live', async () => {
    const created = await workflow();
    await setup('PUT', `/automation/workflows/${created.id}/definition`, {
      token: orgA.token,
      payload: { definition: readyDefinition() },
    });
    await setup('POST', `/automation/workflows/${created.id}/publish`, { token: orgA.token });
    const again = await api('POST', `/automation/workflows/${created.id}/publish`, {
      token: orgA.token,
    });
    expect(again.statusCode).toBe(422);
  });

  it('keeps a paused workflow paused when a later version is published', async () => {
    const created = await workflow();
    await setup('PUT', `/automation/workflows/${created.id}/definition`, {
      token: orgA.token,
      payload: { definition: readyDefinition() },
    });
    await setup('POST', `/automation/workflows/${created.id}/publish`, { token: orgA.token });
    await setup('PATCH', `/automation/workflows/${created.id}`, {
      token: orgA.token,
      payload: { status: 'paused' },
    });
    await setup('PUT', `/automation/workflows/${created.id}/definition`, {
      token: orgA.token,
      payload: { definition: readyDefinition() },
    });
    const republished = await setup<Workflow>(
      'POST',
      `/automation/workflows/${created.id}/publish`,
      { token: orgA.token },
    );
    // Publishing is not a way to restart something somebody deliberately stopped.
    expect(republished.status).toBe('paused');
    expect(republished.current?.version).toBe(2);
  });

  it('refuses to switch on a workflow that has nothing published', async () => {
    const created = await workflow();
    const refused = await api('PATCH', `/automation/workflows/${created.id}`, {
      token: orgA.token,
      payload: { status: 'active' },
    });
    expect(refused.statusCode).toBe(422);
    expect((refused.body as { error?: { message: string } }).error?.message).toContain('Publish');
  });

  it('refuses to turn a published workflow back into a draft', async () => {
    const created = await workflow();
    await setup('PUT', `/automation/workflows/${created.id}/definition`, {
      token: orgA.token,
      payload: { definition: readyDefinition() },
    });
    await setup('POST', `/automation/workflows/${created.id}/publish`, { token: orgA.token });
    const refused = await api('PATCH', `/automation/workflows/${created.id}`, {
      token: orgA.token,
      payload: { status: 'draft' },
    });
    expect(refused.statusCode).toBe(422);
  });
});

describe('the dispatch index, and what empties it', () => {
  async function live() {
    const created = await workflow();
    await setup('PUT', `/automation/workflows/${created.id}/definition`, {
      token: orgA.token,
      payload: { definition: readyDefinition() },
    });
    return setup<Workflow>('POST', `/automation/workflows/${created.id}/publish`, {
      token: orgA.token,
    });
  }

  it('carries no status of its own, so the kill switch is read from the workflow', async () => {
    const published = await live();
    const stopped = await setup<Workflow>('PATCH', `/automation/workflows/${published.id}`, {
      token: orgA.token,
      payload: { killSwitch: true },
    });
    expect(stopped.killSwitch).toBe(true);
    // The row stays: `status` and `kill_switch` live in one place, and a projection carrying a
    // copy of them would be a second answer to "is this workflow live".
    const rows = await ctx.db.workflowTrigger.findMany({ where: { workflowId: published.id } });
    expect(rows).toHaveLength(1);
  });

  it('empties on archive and on delete', async () => {
    const archived = await live();
    await setup('PATCH', `/automation/workflows/${archived.id}`, {
      token: orgA.token,
      payload: { status: 'archived' },
    });
    expect(await ctx.db.workflowTrigger.count({ where: { workflowId: archived.id } })).toBe(0);

    const deleted = await live();
    await setup('DELETE', `/automation/workflows/${deleted.id}`, { token: orgA.token });
    expect(await ctx.db.workflowTrigger.count({ where: { workflowId: deleted.id } })).toBe(0);
  });

  it('refuses to publish an archived workflow, and says to copy it', async () => {
    const published = await live();
    await setup('PATCH', `/automation/workflows/${published.id}`, {
      token: orgA.token,
      payload: { status: 'archived' },
    });
    const refused = await api('PUT', `/automation/workflows/${published.id}/definition`, {
      token: orgA.token,
      payload: { definition: readyDefinition() },
    });
    expect(refused.statusCode).toBe(422);
    expect((refused.body as { error?: { message: string } }).error?.message).toContain('Copy it');
  });
});

describe('references are checked against the workspace, not against a schema (`FR-AUT-8`)', () => {
  it('refuses a status that does not exist, naming the field', async () => {
    const created = await workflow();
    const saved = await setup<Workflow>('PUT', `/automation/workflows/${created.id}/definition`, {
      token: orgA.token,
      payload: {
        definition: {
          trigger: { type: 'lead.created' },
          steps: [{ id: 'move', action: 'change_status', params: { statusId: newId() } }],
        },
      },
    });
    const problem = saved.problems.find((entry) => entry.code === 'REFERENCE_MISSING');
    expect(problem?.field).toBe('definition.steps[0].params.statusId');
    expect(problem?.message).toContain('status');
  });

  it("refuses another workspace's status, which is the same answer as one that never existed", async () => {
    const theirs = await setup<{ id: string }[]>('GET', '/crm/statuses', { token: orgB.token });
    const created = await workflow();
    const saved = await setup<Workflow>('PUT', `/automation/workflows/${created.id}/definition`, {
      token: orgA.token,
      payload: {
        definition: {
          trigger: { type: 'lead.created' },
          steps: [{ id: 'move', action: 'change_status', params: { statusId: theirs[0]!.id } }],
        },
      },
    });
    expect(saved.problems.map((entry) => entry.code)).toContain('REFERENCE_MISSING');
  });

  it('accepts a status this workspace really has', async () => {
    const mine = await setup<{ id: string }[]>('GET', '/crm/statuses', { token: orgA.token });
    const created = await workflow();
    const saved = await setup<Workflow>('PUT', `/automation/workflows/${created.id}/definition`, {
      token: orgA.token,
      payload: {
        definition: {
          trigger: { type: 'lead.created' },
          steps: [{ id: 'move', action: 'change_status', params: { statusId: mine[0]!.id } }],
        },
      },
    });
    expect(saved.problems).toEqual([]);
    expect(saved.publishBlockedReason).toBeNull();
  });

  it('refuses a workflow that starts itself', async () => {
    const created = await workflow();
    const saved = await setup<Workflow>('PUT', `/automation/workflows/${created.id}/definition`, {
      token: orgA.token,
      payload: {
        definition: {
          trigger: { type: 'lead.created' },
          steps: [{ id: 'again', action: 'enroll', params: { workflowId: created.id } }],
        },
      },
    });
    expect(saved.problems[0]?.code).toBe('WORKFLOW_SELF_ENROL');
  });
});

describe('the list', () => {
  it('counts what the filter counts, not the whole workspace', async () => {
    await workflow();
    const all = await api<{ id: string }[]>('GET', '/automation/workflows', { token: orgA.token });
    const drafts = await api<{ id: string }[]>('GET', '/automation/workflows?status=draft', {
      token: orgA.token,
    });
    const pagination = (meta: Record<string, unknown> | undefined) =>
      (meta?.['pagination'] as { total: number }).total;
    // A total counting every workflow beside a filtered page is the recurring bug in this
    // codebase; the two differ here because some of the fixtures above were published.
    expect(pagination(drafts.body.meta)).toBeLessThan(pagination(all.body.meta));
    expect(drafts.body.data.length).toBe(pagination(drafts.body.meta));
  });

  it('pages with a cursor that carries both halves of the sort key', async () => {
    const first = await api<{ id: string }[]>('GET', '/automation/workflows?limit=2', {
      token: orgA.token,
    });
    const meta = first.body.meta?.['pagination'] as { nextCursor: string | null; hasMore: boolean };
    expect(first.body.data).toHaveLength(2);
    expect(meta.hasMore).toBe(true);
    expect(meta.nextCursor).toMatch(/_/);

    const second = await api<{ id: string }[]>(
      'GET',
      `/automation/workflows?limit=2&cursor=${encodeURIComponent(meta.nextCursor!)}`,
      { token: orgA.token },
    );
    const ids = new Set(first.body.data.map((row) => row.id));
    for (const row of second.body.data) expect(ids.has(row.id)).toBe(false);
  });

  it('filters by trigger, through the index rather than by reading JSON', async () => {
    const byTrigger = await api<{ id: string }[]>(
      'GET',
      '/automation/workflows?trigger=lead.created',
      { token: orgA.token },
    );
    expect(byTrigger.statusCode).toBe(200);
    expect(byTrigger.body.data.length).toBeGreaterThan(0);
    const none = await api<{ id: string }[]>('GET', '/automation/workflows?trigger=manual', {
      token: orgA.token,
    });
    expect(none.body.data).toEqual([]);
  });
});

describe('another workspace cannot see any of it', () => {
  it('answers 404 for a workflow belonging to somebody else', async () => {
    const mine = await workflow();
    for (const [method, url] of [
      ['GET', `/automation/workflows/${mine.id}`],
      ['PATCH', `/automation/workflows/${mine.id}`],
      ['DELETE', `/automation/workflows/${mine.id}`],
      ['GET', `/automation/workflows/${mine.id}/versions`],
    ] as const) {
      const response = await api(method, url, {
        token: orgB.token,
        ...(method === 'PATCH' ? { payload: { name: 'Stolen workflow' } } : {}),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it('leaves its own list empty', async () => {
    const theirs = await api<{ id: string }[]>('GET', '/automation/workflows', {
      token: orgB.token,
    });
    expect(theirs.body.data).toEqual([]);
  });
});
