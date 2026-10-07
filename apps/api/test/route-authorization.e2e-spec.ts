import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, newToken } from '@leados/shared';
import { RouteAuditService } from '../src/infra/authz/route-audit.service.js';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';

/**
 * THE ROUTE AUTHORIZATION SUITE.
 *
 * Generated from the application's own routing table rather than a hand-written list, so it
 * grows automatically: adding an endpoint without authorization, or one that answers a
 * foreign tenant's token, fails here without anyone remembering to extend the test
 * (NFR-SEC-1, docs/api-architecture.md §12).
 *
 * Two questions are asked of every route:
 *   1. does it declare its authorization at all?
 *   2. does it refuse a validly-authenticated caller from a different organization?
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2eroutes${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';

let ctx: TestApp;
let audit: RouteAuditService;

interface Tenant {
  token: string;
  organizationId: string;
  userId: string;
  sessionId: string;
  roleId: string;
  teamId: string;
  branchId: string;
  invitationId: string;
  notificationId: string;
  // Phase 2 — every parameterised CRM route needs a real id of this tenant's to aim at.
  leadId: string;
  statusId: string;
  sourceId: string;
  lostReasonId: string;
  tagId: string;
  pipelineId: string;
  stageId: string;
  customFieldId: string;
  customFieldSectionId: string;
  // Phase 2 — duplicates and assignment. A dismissal and an undo need a pair and a merge that
  // really exist, or the sweep would be aiming at a 404 it earned by validation, not by tenancy.
  duplicateId: string;
  mergeId: string;
  duplicateRuleId: string;
  assignmentRuleId: string;
  // Phase 2, step 3 — scoring and saved views
  scoringRuleId: string;
  savedViewId: string;
  // Phase 2, step 5 — imports and exports. An import job needs a real uploaded file behind it, or
  // every `/imports/:id/...` route would answer 404 for a reason that has nothing to do with
  // tenancy and the sweep would record a refusal it never earned.
  importJobId: string;
  exportJobId: string;
  customerId: string;
  dealId: string;
  quotationId: string;
  paymentId: string;
  paymentMethodId: string;
  productId: string;
  // Phase 3, step 1 — tasks. The vocabulary ids come from `GET /tasks/config` rather than from the
  // database, so a settings route aimed at them is aimed at something the API itself just offered.
  taskId: string;
  taskTypeId: string;
  taskOutcomeId: string;
  rescheduleReasonId: string;
}

let orgA: Tenant;
let orgB: Tenant;

const email = (label: string) => `${label}.${EMAIL_MARKER}@test.local`;

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
      email: email(label),
      password: PASSWORD,
      name: `Owner ${label}`,
      organizationName: `Routes ${label} ${SUFFIX}`,
    },
  });

  const organizationId = registered.body.data.activeOrganizationId;
  const userId = registered.body.data.user.id;
  const token = registered.body.data.tokens.accessToken;

  const [role, team, branch, session] = await Promise.all([
    ctx.db.role.findFirstOrThrow({ where: { organizationId, code: 'sales_executive' } }),
    ctx.db.team.findFirstOrThrow({ where: { organizationId } }),
    ctx.db.branch.findFirstOrThrow({ where: { organizationId } }),
    ctx.db.session.findFirstOrThrow({ where: { userId }, orderBy: { createdAt: 'desc' } }),
  ]);

  // A pending invitation gives the sweep a real :id to aim at in the other tenant.
  const invitation = await call<EnvelopeBody<{ invitationId: string }>>(ctx.app, {
    method: 'POST',
    url: '/api/v1/users/invitations',
    payload: { email: `invitee.${label}.${EMAIL_MARKER}@test.local`, roleId: role.id },
    token,
  });

  // A notification of this tenant's own gives the sweep a real :id to aim at. It is written
  // directly rather than through the outbox: what is being tested is whether another tenant can
  // reach the row, not how the row comes to exist.
  const notification = await ctx.db.notification.create({
    data: {
      id: newId(),
      organizationId,
      userId,
      type: 'sweep.fixture',
      title: `Route sweep fixture ${label}`,
    },
  });

  // The CRM vocabulary is provisioned with the organization, so these are reads rather than writes.
  const [status, source, lostReason, pipeline] = await Promise.all([
    ctx.db.leadStatus.findFirstOrThrow({ where: { organizationId, isDefault: true } }),
    ctx.db.leadSource.findFirstOrThrow({ where: { organizationId } }),
    ctx.db.lostReason.findFirstOrThrow({ where: { organizationId } }),
    ctx.db.pipeline.findFirstOrThrow({ where: { organizationId, isDefault: true } }),
  ]);
  const stage = await ctx.db.pipelineStage.findFirstOrThrow({
    where: { organizationId, pipelineId: pipeline.id },
    orderBy: { sortOrder: 'asc' },
  });

  const lead = await call<EnvelopeBody<{ id: string }>>(ctx.app, {
    method: 'POST',
    url: '/api/v1/leads',
    payload: { firstName: 'Sweep', lastName: label },
    token,
  });
  const tag = await call<EnvelopeBody<{ id: string }>>(ctx.app, {
    method: 'POST',
    url: '/api/v1/crm/tags',
    payload: { name: `Sweep ${label} ${SUFFIX}` },
    token,
  });
  const customField = await call<EnvelopeBody<{ id: string }>>(ctx.app, {
    method: 'POST',
    url: '/api/v1/custom-fields',
    payload: { entityType: 'lead', key: 'sweep_note', label: 'Sweep note', type: 'text' },
    token,
  });
  const section = await call<EnvelopeBody<{ id: string }>>(ctx.app, {
    method: 'POST',
    url: '/api/v1/custom-fields/sections',
    payload: { entityType: 'lead', name: `Sweep ${label}` },
    token,
  });

  // A duplicate pair, made the way the product makes them: the same number captured twice. The
  // seeded rule *attaches* the second capture, which resolves the pair rather than queueing it —
  // only `create_and_link` leaves a `lead_duplicates` row there is anything to dismiss. So the
  // seeded rule is flipped for the two captures and flipped back, rather than adding a competing
  // rule: rules tie-break by creation order, so a new one at the same priority would never fire.
  const seededDuplicateRule = await ctx.db.duplicateRule.findFirstOrThrow({
    where: { organizationId },
  });
  const setAction = (action: string) =>
    call(ctx.app, {
      method: 'PATCH',
      url: `/api/v1/duplicates/rules/${seededDuplicateRule.id}`,
      payload: { action },
      token,
    });
  await setAction('create_and_link');
  const repeatPhone = `+9198${String(Math.floor(Math.random() * 90_000_000) + 10_000_000)}`;
  for (const suffix of ['Pair', 'Repeat']) {
    await call(ctx.app, {
      method: 'POST',
      url: '/api/v1/leads',
      payload: { firstName: 'Sweep', lastName: suffix, phone: repeatPhone },
      token,
    });
  }
  await setAction('attach_to_existing');
  const pair = await ctx.db.leadDuplicate.findFirstOrThrow({ where: { organizationId } });

  // A merge, so `merges/:id/undo` has something undoable. Two throwaway leads: merging the sweep
  // fixture lead would soft-delete a record other routes in this suite aim at.
  const [absorbed, survivor] = await Promise.all(
    ['Absorbed', 'Survivor'].map((name) =>
      call<EnvelopeBody<{ id: string }>>(ctx.app, {
        method: 'POST',
        url: '/api/v1/leads',
        payload: { firstName: 'Sweep', lastName: `${name} ${label}` },
        token,
      }),
    ),
  );
  const merged = await call<EnvelopeBody<{ mergeId: string }>>(ctx.app, {
    method: 'POST',
    url: '/api/v1/duplicates/merge',
    payload: {
      survivingLeadId: survivor!.body.data.id,
      mergedLeadId: absorbed!.body.data.id,
    },
    token,
  });

  // An import, uploaded the way a person uploads one: the body is the file.
  const uploaded = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/imports?fileName=sweep.csv',
    payload: `Name,Mobile No.\nSweep Import ${label},98765000${label === 'orga' ? '21' : '22'}\n`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'text/csv' },
  });
  const importJobId = (uploaded.json() as EnvelopeBody<{ id: string }>).data.id;

  // An export job, left `queued`: the sweep must not depend on a worker having run.
  const exported = await call<EnvelopeBody<{ id: string }>>(ctx.app, {
    method: 'POST',
    url: '/api/v1/exports',
    payload: { filter: { conditions: [] }, columns: ['company', 'status'] },
    token,
  });

  // A customer created directly rather than by conversion: the lead fixture above is the one every
  // other lead route in this sweep uses, and converting it would move its status and add a
  // `converted_at` that a later assertion would then have to know about.
  const customer = await call<EnvelopeBody<{ id: string }>>(ctx.app, {
    method: 'POST',
    url: '/api/v1/customers',
    payload: {
      firstName: 'Sweep',
      lastName: 'Customer',
      email: `sweep-${organizationId.slice(0, 8)}@customer.test`,
    },
    token,
  });

  const product = await call<EnvelopeBody<{ id: string }>>(ctx.app, {
    method: 'POST',
    url: '/api/v1/products',
    payload: {
      name: `Sweep product ${organizationId.slice(0, 8)}`,
      priceMinor: 100_000,
      taxPercent: 18,
    },
    token,
  });
  const deal = await call<EnvelopeBody<{ id: string }>>(ctx.app, {
    method: 'POST',
    url: '/api/v1/deals',
    payload: { name: 'Sweep deal', leadId: lead.body.data.id, valueMinor: 500_000 },
    token,
  });

  const quotation = await call<EnvelopeBody<{ id: string }>>(ctx.app, {
    method: 'POST',
    url: '/api/v1/quotations',
    payload: {
      dealId: deal.body.data.id,
      items: [{ name: 'Sweep line', quantity: 1, unitPriceMinor: 500_000, taxPercent: 18 }],
    },
    token,
  });

  const paymentMethods = await call<EnvelopeBody<{ id: string }[]>>(ctx.app, {
    method: 'GET',
    url: '/api/v1/settings/payment-methods',
    token,
  });
  const payment = await call<EnvelopeBody<{ id: string }>>(ctx.app, {
    method: 'POST',
    url: '/api/v1/payments',
    payload: { dealId: deal.body.data.id, amountMinor: 25_000 },
    token,
  });

  const task = await call<EnvelopeBody<{ id: string }>>(ctx.app, {
    method: 'POST',
    url: '/api/v1/tasks',
    payload: {
      leadId: lead.body.data.id,
      title: 'Sweep follow-up',
      // Far enough out that the reminder sweep in another suite cannot pick it up mid-run.
      dueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    },
    token,
  });
  const taskConfig = await call<
    EnvelopeBody<{
      types: { id: string }[];
      outcomes: { id: string }[];
      rescheduleReasons: { id: string }[];
    }>
  >(ctx.app, { method: 'GET', url: '/api/v1/tasks/config', token });

  const [duplicateRule, assignmentRule, scoringRule, savedView] = await Promise.all([
    ctx.db.duplicateRule.findFirstOrThrow({ where: { organizationId, isActive: true } }),
    ctx.db.assignmentRule.findFirstOrThrow({ where: { organizationId } }),
    // Both are provisioned with the organization, so these are reads rather than writes.
    ctx.db.scoringRule.findFirstOrThrow({ where: { organizationId, deletedAt: null } }),
    ctx.db.savedView.findFirstOrThrow({ where: { organizationId, deletedAt: null } }),
  ]);

  return {
    token,
    organizationId,
    userId,
    sessionId: session.id,
    roleId: role.id,
    teamId: team.id,
    branchId: branch.id,
    invitationId: invitation.body.data.invitationId,
    notificationId: notification.id,
    leadId: lead.body.data.id,
    statusId: status.id,
    sourceId: source.id,
    lostReasonId: lostReason.id,
    tagId: tag.body.data.id,
    pipelineId: pipeline.id,
    stageId: stage.id,
    customFieldId: customField.body.data.id,
    customFieldSectionId: section.body.data.id,
    duplicateId: pair.id,
    mergeId: merged.body.data.mergeId,
    duplicateRuleId: duplicateRule.id,
    assignmentRuleId: assignmentRule.id,
    scoringRuleId: scoringRule.id,
    savedViewId: savedView.id,
    importJobId,
    exportJobId: exported.body.data.id,
    customerId: customer.body.data.id,
    dealId: deal.body.data.id,
    quotationId: quotation.body.data.id,
    paymentId: payment.body.data.id,
    paymentMethodId: paymentMethods.body.data[0]?.id ?? '',
    productId: product.body.data.id,
    taskId: task.body.data.id,
    taskTypeId: taskConfig.body.data.types[0]?.id ?? '',
    taskOutcomeId: taskConfig.body.data.outcomes[0]?.id ?? '',
    rescheduleReasonId: taskConfig.body.data.rescheduleReasons[0]?.id ?? '',
  };
}

beforeAll(async () => {
  ctx = await bootTestApp();
  audit = ctx.app.get(RouteAuditService);
  orgA = await createTenant('orga');
  orgB = await createTenant('orgb');
}, 120_000);

afterAll(async () => {
  if (ctx) {
    await cleanupUsers(ctx.db, EMAIL_MARKER);
    await ctx.close();
  }
});

describe('every route declares its authorization', () => {
  it('finds routes to audit at all (so a broken collector cannot pass silently)', () => {
    const routes = audit.collect();
    expect(routes.length).toBeGreaterThan(20);
  });

  it('leaves no route undeclared', () => {
    const undeclared = audit.collect().filter((route) => route.declaration === 'missing');
    expect(
      undeclared.map((route) => `${route.httpMethod} ${route.path}`),
      'add @RequirePermission, @Public or @NoPermissionRequired',
    ).toEqual([]);
  });

  it('gives every exemption a stated reason', () => {
    const exempt = audit.collect().filter((route) => route.declaration === 'exempt');
    for (const route of exempt) {
      expect(route.exemptReason, `${route.httpMethod} ${route.path}`).toBeTruthy();
    }
  });

  /**
   * Writes outside `/auth` that legitimately need no permission because they only touch the
   * caller's own record — marking your own notifications read. A permission here would have to be
   * one every role holds, which is a permission that decides nothing.
   *
   * The list is asserted below, so adding an exempt write fails this suite until someone has looked
   * at it. That is the point: this set must never grow silently.
   */
  const SELF_SCOPED_WRITES = ['POST /notifications/:id/read', 'POST /notifications/read-all'];

  it('gates every write outside /auth behind a permission', () => {
    // Authentication endpoints are necessarily public or self-scoped; everything else that
    // changes state must name the permission it needs, or appear in the reviewed set above.
    const unguardedWrites = audit
      .collect()
      .filter(
        (route) =>
          ['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.httpMethod) &&
          !route.path.startsWith('/auth') &&
          route.declaration !== 'permission' &&
          !SELF_SCOPED_WRITES.includes(`${route.httpMethod} ${route.path}`),
      )
      .map((route) => `${route.httpMethod} ${route.path}`);
    expect(unguardedWrites).toEqual([]);
  });

  it('keeps the self-scoped write exemptions honest', () => {
    const routes = audit.collect();
    for (const key of SELF_SCOPED_WRITES) {
      const route = routes.find((candidate) => `${candidate.httpMethod} ${candidate.path}` === key);
      expect(route, `${key} is listed as self-scoped but no longer exists`).toBeDefined();
      // It must be an explicit exemption with a stated reason — not merely undeclared, and not
      // public: an unauthenticated caller has no "own" record to act on.
      expect(route?.declaration, key).toBe('exempt');
      expect(route?.exemptReason, key).toBeTruthy();
    }
  });

  it('names a permission that exists in the catalogue', async () => {
    const declared = [
      ...new Set(
        audit
          .collect()
          .filter((route) => route.permission !== undefined)
          .map((route) => route.permission!),
      ),
    ];
    const known = await ctx.db.permission.findMany({ where: { key: { in: declared } } });
    expect(known.map((row) => row.key).sort()).toEqual(declared.sort());
  });
});

describe('cross-tenant sweep: no route answers another organization’s caller', () => {
  /** Substitutes org A's real identifiers into parameterised paths. */
  function resolvePath(path: string): string | null {
    if (!path.includes(':')) return path;

    // Which of org A's identifiers each parameterised path takes. Substituting the wrong kind of id
    // would make the route fail validation rather than authorization, and the sweep would record a
    // refusal it never actually earned.
    const byPath: Record<string, string> = {
      '/auth/sessions/:id': `/auth/sessions/${orgA.sessionId}`,
      '/users/invitations/:id': `/users/invitations/${orgA.invitationId}`,
      '/users/:id': `/users/${orgA.userId}`,
      '/users/:id/roles': `/users/${orgA.userId}/roles`,
      '/branches/:id': `/branches/${orgA.branchId}`,
      '/teams/:id': `/teams/${orgA.teamId}`,
      '/teams/:id/members': `/teams/${orgA.teamId}/members`,
      '/teams/:id/members/:userId': `/teams/${orgA.teamId}/members/${orgA.userId}`,
      '/roles/:id': `/roles/${orgA.roleId}`,
      '/roles/:id/permissions': `/roles/${orgA.roleId}/permissions`,
      '/notifications/:id/read': `/notifications/${orgA.notificationId}/read`,
      // Phase 2 — CRM core
      '/custom-fields/:id': `/custom-fields/${orgA.customFieldId}`,
      '/custom-fields/:id/options': `/custom-fields/${orgA.customFieldId}/options`,
      '/custom-fields/sections/:id': `/custom-fields/sections/${orgA.customFieldSectionId}`,
      '/crm/statuses/:id': `/crm/statuses/${orgA.statusId}`,
      '/crm/sources/:id': `/crm/sources/${orgA.sourceId}`,
      '/crm/lost-reasons/:id': `/crm/lost-reasons/${orgA.lostReasonId}`,
      '/crm/tags/:id': `/crm/tags/${orgA.tagId}`,
      '/crm/pipelines/:id': `/crm/pipelines/${orgA.pipelineId}`,
      '/crm/pipelines/:id/stages': `/crm/pipelines/${orgA.pipelineId}/stages`,
      '/leads/:id': `/leads/${orgA.leadId}`,
      '/leads/:id/restore': `/leads/${orgA.leadId}/restore`,
      '/leads/:id/status': `/leads/${orgA.leadId}/status`,
      '/leads/:id/stage': `/leads/${orgA.leadId}/stage`,
      '/leads/:id/assign': `/leads/${orgA.leadId}/assign`,
      '/leads/:id/tags': `/leads/${orgA.leadId}/tags`,
      '/leads/:id/touchpoints': `/leads/${orgA.leadId}/touchpoints`,
      '/leads/:id/timeline': `/leads/${orgA.leadId}/timeline`,
      // Phase 2 — duplicates and assignment
      '/duplicates/:id/dismiss': `/duplicates/${orgA.duplicateId}/dismiss`,
      '/duplicates/merges/:id/undo': `/duplicates/merges/${orgA.mergeId}/undo`,
      '/duplicates/rules/:id': `/duplicates/rules/${orgA.duplicateRuleId}`,
      '/assignment/rules/:id': `/assignment/rules/${orgA.assignmentRuleId}`,
      '/assignment/rules/:id/conditions': `/assignment/rules/${orgA.assignmentRuleId}/conditions`,
      '/assignment/rules/:id/pool': `/assignment/rules/${orgA.assignmentRuleId}/pool`,
      // Phase 2, step 3 — scoring and saved views
      '/scoring/rules/:id': `/scoring/rules/${orgA.scoringRuleId}`,
      '/views/:id': `/views/${orgA.savedViewId}`,
      '/leads/:id/score-breakdown': `/leads/${orgA.leadId}/score-breakdown`,
      '/leads/:id/recompute-score': `/leads/${orgA.leadId}/recompute-score`,
      // Phase 2, step 5 — imports and exports
      '/imports/:id': `/imports/${orgA.importJobId}`,
      '/imports/:id/preview': `/imports/${orgA.importJobId}/preview`,
      '/imports/:id/mapping': `/imports/${orgA.importJobId}/mapping`,
      '/imports/:id/check': `/imports/${orgA.importJobId}/check`,
      '/imports/:id/validate': `/imports/${orgA.importJobId}/validate`,
      '/imports/:id/start': `/imports/${orgA.importJobId}/start`,
      '/imports/:id/cancel': `/imports/${orgA.importJobId}/cancel`,
      '/imports/:id/rows': `/imports/${orgA.importJobId}/rows`,
      '/imports/:id/errors.csv': `/imports/${orgA.importJobId}/errors.csv`,
      '/deals/:id': `/deals/${orgA.dealId}`,
      '/deals/:id/timeline': `/deals/${orgA.dealId}/timeline`,
      '/deals/:id/items': `/deals/${orgA.dealId}/items`,
      '/deals/:id/stage': `/deals/${orgA.dealId}/stage`,
      '/deals/:id/win': `/deals/${orgA.dealId}/win`,
      '/deals/:id/lose': `/deals/${orgA.dealId}/lose`,
      '/deals/:id/reopen': `/deals/${orgA.dealId}/reopen`,
      '/deals/:id/restore': `/deals/${orgA.dealId}/restore`,
      '/quotations/:id': `/quotations/${orgA.quotationId}`,
      '/quotations/:id/pdf': `/quotations/${orgA.quotationId}/pdf`,
      '/quotations/:id/items': `/quotations/${orgA.quotationId}/items`,
      '/quotations/:id/send': `/quotations/${orgA.quotationId}/send`,
      '/quotations/:id/accept': `/quotations/${orgA.quotationId}/accept`,
      '/quotations/:id/reject': `/quotations/${orgA.quotationId}/reject`,
      '/quotations/:id/revise': `/quotations/${orgA.quotationId}/revise`,
      '/payments/:id': `/payments/${orgA.paymentId}`,
      '/payments/:id/confirm': `/payments/${orgA.paymentId}/confirm`,
      '/payments/:id/fail': `/payments/${orgA.paymentId}/fail`,
      '/payments/:id/refund': `/payments/${orgA.paymentId}/refund`,
      '/settings/payment-methods/:id': `/settings/payment-methods/${orgA.paymentMethodId}`,
      '/products/:id': `/products/${orgA.productId}`,
      '/customers/:id': `/customers/${orgA.customerId}`,
      '/customers/:id/timeline': `/customers/${orgA.customerId}/timeline`,
      '/customers/:id/restore': `/customers/${orgA.customerId}/restore`,
      '/leads/:id/convert': `/leads/${orgA.leadId}/convert`,
      '/exports/:id': `/exports/${orgA.exportJobId}`,
      // Phase 3, step 1 — tasks and follow-ups
      '/tasks/:id': `/tasks/${orgA.taskId}`,
      '/tasks/:id/reschedules': `/tasks/${orgA.taskId}/reschedules`,
      '/tasks/:id/complete': `/tasks/${orgA.taskId}/complete`,
      '/tasks/:id/reschedule': `/tasks/${orgA.taskId}/reschedule`,
      '/tasks/:id/cancel': `/tasks/${orgA.taskId}/cancel`,
      '/settings/task-types/:id': `/settings/task-types/${orgA.taskTypeId}`,
      '/settings/task-outcomes/:id': `/settings/task-outcomes/${orgA.taskOutcomeId}`,
      '/settings/reschedule-reasons/:id': `/settings/reschedule-reasons/${orgA.rescheduleReasonId}`,
      '/exports/:id/download': `/exports/${orgA.exportJobId}/download`,
    };

    // An unmapped parameter would test nothing meaningful, so it is reported instead.
    return byPath[path] ?? null;
  }

  it('maps every parameterised route to a real org A resource', () => {
    const unmapped = audit
      .collect()
      .filter((route) => route.declaration !== 'public' && route.path.includes(':'))
      .filter((route) => resolvePath(route.path) === null)
      .map((route) => `${route.httpMethod} ${route.path}`);
    // Keeping this at zero is what stops the sweep quietly skipping new routes.
    expect(unmapped, 'add an org A identifier for this path in resolvePath()').toEqual([]);
  });

  /**
   * Routes that act only on the caller's own identity or session. A caller from another
   * organization legitimately succeeds on these — they are operating on *their own* data, not
   * reaching into org A's — so they are excluded from the cross-tenant sweep.
   *
   * The list is asserted below, so a newly-excluded route fails this suite until someone has
   * looked at it. That is the point: the exclusion set must never grow silently.
   */
  const SELF_ACTING_ROUTES = [
    'GET /auth/me',
    'GET /auth/sessions',
    'POST /auth/logout-all',
    'POST /auth/mfa/setup',
    'POST /auth/mfa/confirm',
    'POST /auth/mfa/disable',
    'GET /auth/mfa/recovery-codes/count',
  ];

  function isSelfActing(httpMethod: string, path: string): boolean {
    return SELF_ACTING_ROUTES.includes(`${httpMethod} ${path}`);
  }

  it('excludes only the reviewed set of self-acting routes', () => {
    // Every excluded route must be exempt (i.e. declared as acting on the caller) and must
    // take no resource identifier — otherwise it could be reaching into another tenant.
    const routes = audit.collect();
    for (const key of SELF_ACTING_ROUTES) {
      const route = routes.find((candidate) => `${candidate.httpMethod} ${candidate.path}` === key);
      expect(route, `${key} is listed as self-acting but no longer exists`).toBeDefined();
      expect(route?.declaration, key).toBe('exempt');
      expect(route?.path.includes(':'), `${key} takes an id, so it cannot be self-acting`).toBe(
        false,
      );
    }
  });

  it('never lets org B reach org A, on any non-public route', async () => {
    const routes = audit
      .collect()
      .filter((route) => route.declaration !== 'public')
      .filter((route) => route.httpMethod !== 'ALL')
      .filter((route) => !isSelfActing(route.httpMethod, route.path));

    expect(routes.length, 'the sweep must actually cover routes').toBeGreaterThan(3);

    const orgAIdentifiers: [string, string][] = [
      ['organizationId', orgA.organizationId],
      ['userId', orgA.userId],
      ['sessionId', orgA.sessionId],
      ['invitationId', orgA.invitationId],
      ['roleId', orgA.roleId],
      ['teamId', orgA.teamId],
      ['branchId', orgA.branchId],
      ['leadId', orgA.leadId],
      ['statusId', orgA.statusId],
      ['sourceId', orgA.sourceId],
      ['lostReasonId', orgA.lostReasonId],
      ['tagId', orgA.tagId],
      ['pipelineId', orgA.pipelineId],
      ['stageId', orgA.stageId],
      ['customFieldId', orgA.customFieldId],
      ['customFieldSectionId', orgA.customFieldSectionId],
      ['importJobId', orgA.importJobId],
      ['exportJobId', orgA.exportJobId],
    ];

    const problems: string[] = [];
    let routesAimedAtOrgA = 0;
    let collectionRoutes = 0;

    for (const route of routes) {
      const url = resolvePath(route.path);
      if (url === null) continue;

      const payload = bodyFor(route.httpMethod, route.path, orgA);
      const request = `${route.httpMethod} ${url}`;
      // Does this request actually name something of org A's? If so it must be refused. If
      // not, it addresses org B's own data and a 200 is correct — but the response must then
      // contain nothing of org A's.
      const aimedAtOrgA = orgAIdentifiers.some(
        ([, value]) => url.includes(value) || JSON.stringify(payload ?? {}).includes(value),
      );

      const response = await call<EnvelopeBody<unknown>>(ctx.app, {
        method: route.httpMethod as 'GET' | 'POST' | 'DELETE' | 'PATCH',
        url: `/api/v1${url}`,
        token: orgB.token,
        payload,
      });

      if (aimedAtOrgA) {
        routesAimedAtOrgA += 1;
        // 404 is preferred over 403 so the API does not confirm the resource exists.
        if (![400, 401, 403, 404, 409, 422].includes(response.statusCode)) {
          problems.push(`${request} reached org A → ${response.statusCode}`);
        }
      } else {
        collectionRoutes += 1;
        if (response.statusCode >= 500) problems.push(`${request} → ${response.statusCode}`);
      }

      const serialized = JSON.stringify(response.body);
      for (const [label, value] of orgAIdentifiers) {
        if (serialized.includes(value)) problems.push(`${request} leaked org A ${label}`);
      }
    }

    expect(problems).toEqual([]);
    // Both halves of the sweep must have exercised something, or a filtering mistake would
    // make this test vacuous.
    expect(routesAimedAtOrgA, 'no route was actually aimed at org A').toBeGreaterThan(2);
    expect(collectionRoutes, 'no tenant-scoped collection route was exercised').toBeGreaterThan(1);
  });

  it('confirms the sweep is meaningful: the same routes succeed for their own tenant', async () => {
    // Without this, a sweep that fails everything for an unrelated reason would look like a pass.
    const own = await call<EnvelopeBody<unknown>>(ctx.app, {
      method: 'GET',
      url: '/api/v1/users',
      token: orgA.token,
    });
    expect(own.statusCode).toBe(200);

    const ownInvitation = await call<EnvelopeBody<unknown>>(ctx.app, {
      method: 'DELETE',
      url: `/api/v1/users/invitations/${orgA.invitationId}`,
      token: orgA.token,
    });
    expect(ownInvitation.statusCode).toBe(200);
  });

  it('refuses every non-public route with no token at all', async () => {
    const failures: string[] = [];
    for (const route of audit.collect().filter((r) => r.declaration !== 'public')) {
      const url = resolvePath(route.path);
      if (url === null) continue;
      const response = await call(ctx.app, {
        method: route.httpMethod as 'GET' | 'POST' | 'DELETE' | 'PATCH',
        url: `/api/v1${url}`,
        payload: bodyFor(route.httpMethod, route.path, orgA),
      });
      if (response.statusCode !== 401)
        failures.push(`${route.httpMethod} ${url} → ${response.statusCode}`);
    }
    expect(failures).toEqual([]);
  });
});

/**
 * Plausible request bodies, so a route rejects on authorization rather than validation.
 * Keyed on method *and* path: a GET sharing a path with a POST must not inherit its body,
 * or the sweep misclassifies which requests actually reference another tenant's data.
 */
function bodyFor(
  httpMethod: string,
  path: string,
  target: Tenant,
): Record<string, unknown> | undefined {
  if (!['POST', 'PUT', 'PATCH'].includes(httpMethod)) return undefined;
  switch (path) {
    case '/users/invitations':
      return { email: `sweep.${EMAIL_MARKER}@test.local`, roleId: target.roleId };
    case '/organization':
      return { name: `Swept ${SUFFIX}` };
    case '/organization/onboarding':
      return { step: 'business_info' };
    case '/branches':
    case '/branches/:id':
      return { name: `Swept branch ${SUFFIX}` };
    case '/teams':
    case '/teams/:id':
      return { name: `Swept team ${SUFFIX}` };
    case '/teams/:id/members':
      return { userId: target.userId };
    case '/roles':
      return { code: `swept_${SUFFIX}`, name: `Swept role ${SUFFIX}` };
    case '/roles/:id':
      return { name: `Swept role ${SUFFIX}` };
    case '/roles/:id/permissions':
      return { grants: [{ permission: 'lead:read', scope: 'own' }] };
    case '/users/:id':
      return { status: 'suspended' };
    case '/users/:id/roles':
      return { roleIds: [target.roleId] };
    case '/notifications/:id/read':
    case '/notifications/read-all':
      return {};
    // Phase 2 — CRM core
    case '/custom-fields':
      return { entityType: 'lead', key: 'swept_field', label: 'Swept', type: 'text' };
    case '/custom-fields/:id':
      return { label: `Swept ${SUFFIX}` };
    case '/custom-fields/:id/options':
      return { options: [{ value: 'a', label: 'A' }] };
    case '/custom-fields/sections':
      return { entityType: 'lead', name: `Swept ${SUFFIX}` };
    case '/custom-fields/sections/:id':
      return { name: `Swept ${SUFFIX}` };
    case '/crm/statuses':
      return { name: `Swept status ${SUFFIX}`, category: 'open' };
    case '/crm/statuses/:id':
      return { name: `Swept status ${SUFFIX}` };
    case '/crm/sources':
    case '/crm/sources/:id':
      return { name: `Swept source ${SUFFIX}` };
    case '/crm/lost-reasons':
    case '/crm/lost-reasons/:id':
      return { name: `Swept reason ${SUFFIX}` };
    case '/crm/tags':
    case '/crm/tags/:id':
      return { name: `Swept tag ${SUFFIX}` };
    case '/crm/pipelines':
      return { name: `Swept pipeline ${SUFFIX}`, stages: [{ name: 'One' }] };
    case '/crm/pipelines/:id':
      return { name: `Swept pipeline ${SUFFIX}` };
    case '/crm/pipelines/:id/stages':
      return { stages: [{ name: 'One' }] };
    case '/leads':
      return { firstName: 'Swept', lastName: 'Lead' };
    case '/leads/:id':
      return { city: 'Swept' };
    case '/leads/:id/status':
      return { statusId: target.statusId };
    case '/leads/:id/stage':
      return { stageId: target.stageId };
    case '/leads/:id/assign':
      return { assignedUserId: target.userId };
    case '/leads/:id/tags':
      return { tagIds: [target.tagId] };
    case '/leads/:id/touchpoints':
      return { channel: 'manual' };
    case '/leads/:id/restore':
      return {};
    // Phase 2 — duplicates and assignment
    case '/duplicates/:id/dismiss':
    case '/duplicates/merges/:id/undo':
      return {};
    case '/duplicates/rules':
      return { name: `Swept rule ${SUFFIX}`, matchOn: [['phoneE164']] };
    case '/duplicates/rules/:id':
      return { name: `Swept rule ${SUFFIX}` };
    case '/duplicates/merge':
      return { survivingLeadId: target.leadId, mergedLeadId: target.leadId };
    case '/duplicates/test':
      return { lead: { phoneE164: '+919800000000' } };
    case '/assignment/rules':
      return {
        name: `Swept assignment ${SUFFIX}`,
        strategy: 'specific_user',
        target: { userId: target.userId },
      };
    case '/assignment/rules/:id':
      return { name: `Swept assignment ${SUFFIX}` };
    case '/assignment/rules/:id/conditions':
      return { conditions: [] };
    case '/assignment/rules/:id/pool':
      return { pool: [{ userId: target.userId }] };
    case '/assignment/test':
      return { lead: { city: 'Swept' } };
    case '/assignment/evaluate':
      return { leadIds: [target.leadId] };
    case '/assignment/reassign':
      return { leadIds: [target.leadId], assignedUserId: target.userId };
    // Phase 2, step 3 — scoring and saved views
    case '/scoring/rules':
      return { name: `Swept scoring ${SUFFIX}`, triggerEvent: 'lead.created', points: 5 };
    case '/scoring/rules/:id':
      return { name: `Swept scoring ${SUFFIX}` };
    case '/scoring/bands':
      return {
        bands: [
          { name: `Swept low ${SUFFIX}`, minScore: 0, maxScore: 500 },
          { name: `Swept high ${SUFFIX}`, minScore: 501, maxScore: 1000 },
        ],
      };
    case '/scoring/test':
      return { lead: { city: 'Swept' } };
    case '/views':
      return { name: `Swept view ${SUFFIX}`, filters: { conditions: [] } };
    case '/views/:id':
      return { name: `Swept view ${SUFFIX}` };
    case '/leads/search':
      return { filter: { conditions: [] } };
    case '/leads/:id/recompute-score':
      return {};
    // Phase 2, step 5 — imports and exports
    case '/imports':
      // The upload's body is the file itself, not JSON. A JSON body here is refused as an empty
      // file, which is a 400 and therefore a legitimate sweep outcome for a collection route.
      return {};
    case '/imports/:id/mapping':
      return { mapping: { Name: 'fullName', 'Mobile No.': 'phone' }, mode: 'create_only' };
    case '/imports/:id/validate':
    case '/imports/:id/start':
    case '/imports/:id/cancel':
      return {};
    case '/exports':
      return { filter: { conditions: [] }, columns: ['company'] };
    // Phase 2, step 7 — deals, products and line items
    case '/deals':
      return { name: 'Cross tenant deal', leadId: target.leadId, valueMinor: 1_000 };
    case '/deals/:id':
      return { name: 'Renamed by another tenant' };
    case '/deals/:id/items':
      return { items: [{ name: 'A line', quantity: 1, unitPriceMinor: 1_000 }] };
    case '/deals/:id/stage':
      return { stageId: target.stageId };
    case '/deals/:id/win':
    case '/deals/:id/lose':
    case '/deals/:id/reopen':
    case '/deals/:id/restore':
      return {};
    // Phase 2, step 8 — quotations
    case '/quotations':
      return {
        dealId: target.dealId,
        items: [{ name: 'A line', quantity: 1, unitPriceMinor: 1_000 }],
      };
    case '/quotations/:id':
      return { title: 'Retitled by another tenant' };
    case '/quotations/:id/items':
      return { items: [{ name: 'A line', quantity: 1, unitPriceMinor: 1_000 }] };
    case '/quotations/:id/send':
    case '/quotations/:id/accept':
    case '/quotations/:id/reject':
    case '/quotations/:id/revise':
      return {};
    case '/settings/number-series/quotation':
      return { prefix: 'HACK-', padding: 4 };
    // Phase 2, step 9 — payments
    case '/payments':
      return { dealId: target.dealId, amountMinor: 1_000 };
    case '/payments/:id':
      return { amountMinor: 2_000 };
    case '/payments/:id/confirm':
    case '/payments/:id/fail':
    case '/payments/:id/refund':
      return {};
    case '/settings/payment-methods':
      return { name: 'Cross tenant method' };
    case '/settings/payment-methods/:id':
      return { name: 'Renamed by another tenant' };
    case '/products':
      return { name: 'Cross tenant product', priceMinor: 100 };
    case '/products/:id':
      return { name: 'Renamed by another tenant' };
    // Phase 2, step 6 — customers and conversion
    case '/customers':
      return { firstName: 'Cross', lastName: 'Tenant', email: 'cross@tenant.test' };
    case '/customers/:id':
      return { company: 'Renamed By Another Tenant' };
    case '/customers/:id/restore':
    case '/leads/:id/convert':
      return {};
    case '/auth/switch-org':
      return { organizationId: target.organizationId };
    case '/auth/mfa/confirm':
      return { code: '123456' };
    case '/auth/mfa/disable':
      return { password: PASSWORD };
    case '/auth/logout-all':
    case '/auth/mfa/setup':
      return {};
    default:
      return undefined;
  }
}
