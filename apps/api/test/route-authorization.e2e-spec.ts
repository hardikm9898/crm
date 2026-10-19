import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, newToken, signRequest } from '@leados/shared';
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
  // Phase 3, step 2 — SLA. The escalation is produced by backdating a clock and running the real
  // sweep, so the route is aimed at a row the product itself wrote.
  slaPolicyId: string;
  escalationId: string;
  // Phase 3, step 6 — calls. The call is *dialled* rather than logged, so the route aimed at
  // `POST /calls/:id/outcome` is aimed at a call that genuinely still owes an answer.
  callId: string;
  callOutcomeId: string;
  // Phase 4, step 1 — capture forms.
  formId: string;
  // Phase 4, step 2 — the public lead API. The payload is produced by a real signed capture, so
  // the replay route is aimed at a row the product itself wrote.
  apiKeyId: string;
  payloadId: string;
  webhookEndpointId: string;
  webhookDeliveryId: string;
  // Phase 4, step 6 — the integration framework. A `generic_webhook` connection, deliberately:
  // its provider has no probe, so building this fixture reaches nobody else's server.
  integrationConnectionId: string;
  // Phase 5, step 1 — WhatsApp. Created rather than found: a test that finds its fixture passes
  // for the wrong reason, and on a freshly migrated database there is no conversation to find.
  whatsappNumberId: string;
  conversationId: string;
  // Phase 5, step 2 — sending. An **outbound** message, because `POST …/retry` is about one we
  // sent; a template in `draft`, because the submit route is the one a draft is for.
  whatsappAccountId: string;
  whatsappTemplateId: string;
  outboundMessageId: string;
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
  // The SLA policy and an escalation of org A's own. The escalation has to be *made*, not found:
  // the sweep only writes one for a clock whose moment has passed, so the clock is backdated first
  // — `sla_clocks_instants_ordered` requires `started_at <= warn_at <= due_at`, which is why all
  // three move together.
  const slaPolicy = await ctx.db.slaPolicy.findFirstOrThrow({ where: { organizationId } });

  const taskConfig = await call<
    EnvelopeBody<{
      types: { id: string }[];
      outcomes: { id: string }[];
      rescheduleReasons: { id: string }[];
    }>
  >(ctx.app, { method: 'GET', url: '/api/v1/tasks/config', token });

  // Dialled, not logged: `POST /calls/:id/outcome` refuses a call that is already settled, and a
  // route the sweep aims at has to be able to reach the authorization check rather than a 422.
  const dialled = await call<EnvelopeBody<{ call: { id: string } }>>(ctx.app, {
    method: 'POST',
    url: '/api/v1/calls/dial',
    // The number explicitly: this fixture's lead may have none, and `POST /calls/dial` rightly
    // refuses to dial nothing — which would leave the sweep aimed at an id that does not exist.
    payload: { leadId: lead.body.data.id, to: '+919845099999' },
    token,
  });
  const callConfig = await call<EnvelopeBody<{ outcomes: { id: string }[] }>>(ctx.app, {
    method: 'GET',
    url: '/api/v1/calls/config',
    token,
  });

  // A form of org A's own, so the `/forms/:id` routes are aimed at a real row. One question, and
  // it is a contact field — the builder refuses a form that cannot reach anybody.
  const form = await call<EnvelopeBody<{ id: string }>>(ctx.app, {
    method: 'POST',
    url: '/api/v1/forms',
    payload: {
      name: `Sweep form ${label}`,
      fields: [{ standardFieldKey: 'phone', label: 'Phone', isRequired: true }],
    },
    token,
  });

  // An API key of org A's own, and a payload it sent. The payload is written by a *failed* capture
  // on purpose: `POST /ingestion/payloads/:id/replay` refuses one that already became a lead, and
  // a route the sweep aims at has to reach the authorization check rather than a 422.
  const apiKey = await call<EnvelopeBody<{ id: string; keyId: string; secret: string }>>(ctx.app, {
    method: 'POST',
    url: '/api/v1/api-keys',
    payload: { name: `Sweep key ${label}`, scopes: ['ingest:write'] },
    token,
  });
  const organizationRow = await ctx.db.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { publicKey: true },
  });
  const unusableBody = JSON.stringify({ city: 'Pune' });
  const signedAt = Math.floor(Date.now() / 1000);
  await call(ctx.app, {
    method: 'POST',
    url: `/api/v1/public/leads/${organizationRow.publicKey}`,
    payload: JSON.parse(unusableBody),
    headers: {
      'x-api-key': apiKey.body.data.keyId,
      'x-signature': signRequest(apiKey.body.data.secret, signedAt, unusableBody),
    },
  });
  const payload = await ctx.db.inboundPayload.findFirstOrThrow({
    where: { organizationId, status: 'failed' },
    orderBy: { receivedAt: 'desc' },
  });

  // A webhook endpoint of org A's own, and a delivery to it. The delivery is left `failed` so
  // `POST /webhooks/deliveries/:id/retry` reaches the authorization check rather than the 422 a
  // switched-off endpoint would answer first — the lesson the call-outcome route taught this sweep.
  const webhookEndpoint = await call<EnvelopeBody<{ id: string }>>(ctx.app, {
    method: 'POST',
    url: '/api/v1/webhooks',
    payload: {
      url: `https://hooks.example.com/sweep-${label}-${organizationId.slice(-8)}`,
      eventTypes: ['lead.created'],
    },
    token,
  });
  const webhookDeliveryId = newId();
  await ctx.db.webhookDelivery.create({
    data: {
      id: webhookDeliveryId,
      organizationId,
      endpointId: webhookEndpoint.body.data.id,
      eventId: newId(),
      eventType: 'lead.created',
      payload: { id: 'evt', type: 'lead.created' },
      status: 'failed',
      attemptCount: 1,
      nextAttemptAt: new Date(Date.now() + 600_000),
      createdAt: new Date(),
    },
  });

  // An integration connection of org A's own. `generic_webhook` because its adapter has no probe:
  // a Postmark connection would make this fixture attempt a real request to Postmark, and the
  // sweep's `POST /integrations/:id/check` would too.
  const integrationConnection = await call<EnvelopeBody<{ id: string }>>(ctx.app, {
    method: 'POST',
    url: '/api/v1/integrations',
    payload: {
      provider: 'generic_webhook',
      name: `Sweep ${label}`,
      settings: {},
      fieldMappings: [{ source: 'full_name', target: 'name' }],
    },
    token,
  });

  // A WhatsApp number and a conversation of org A's own. The connection is real (its `validate`
  // is offline, so this reaches nobody) and the rows below are written directly, because the only
  // other way to get a conversation is a signed Meta delivery and a fake Graph API — which
  // `whatsapp.e2e-spec.ts` does, and which this suite does not need in order to aim at the route.
  const whatsappConnection = await call<EnvelopeBody<{ id: string }>>(ctx.app, {
    method: 'POST',
    url: '/api/v1/integrations',
    payload: {
      provider: 'whatsapp_cloud',
      name: `Sweep WhatsApp ${label}`,
      credentials: {
        appSecret: 'd41d8cd98f00b204e9800998ecf8427e',
        accessToken: 'EAAG-a-permanent-system-user-token-value-0001',
      },
      // Digits only: the adapter refuses anything else, because a WABA id is Meta's numeric id.
      settings: { wabaId: label === 'a' ? '102938475610291' : '102938475610292', verifyToken: `verify-${SUFFIX}` },
    },
    token,
  });
  // A setup call whose status nobody asserts fails silently and takes the assertion with it.
  if (whatsappConnection.statusCode >= 300) {
    throw new Error(
      `the sweep fixture could not connect WhatsApp: ${whatsappConnection.statusCode} ${JSON.stringify(whatsappConnection.body)}`,
    );
  }
  const whatsappAccountId = newId();
  await ctx.db.whatsAppAccount.create({
    data: {
      id: whatsappAccountId,
      organizationId,
      integrationConnectionId: whatsappConnection.body.data.id,
      wabaId: label === 'a' ? '102938475610291' : '102938475610292',
      businessName: `Routes ${label}`,
      status: 'connected',
      verifiedAt: new Date(),
    },
  });
  const whatsappNumberId = newId();
  await ctx.db.whatsAppNumber.create({
    data: {
      id: whatsappNumberId,
      organizationId,
      accountId: whatsappAccountId,
      // Globally unique by design — it is the only thing an inbound delivery carries — so the two
      // tenants in this suite must not share one.
      phoneNumberId: `${Date.now()}${label === 'a' ? '1' : '2'}`,
      displayPhoneE164: `+9198450${label === 'a' ? '11111' : '22222'}`,
      verifiedName: `Routes ${label}`,
      isActive: true,
    },
  });
  const conversationId = newId();
  await ctx.db.conversation.create({
    data: {
      id: conversationId,
      organizationId,
      channel: 'whatsapp',
      channelAccountId: whatsappNumberId,
      contactE164: `+9198765${label === 'a' ? '11111' : '22222'}`,
      leadId: lead.body.data.id,
      status: 'open',
      unreadCount: 1,
      lastMessageAt: new Date(),
      lastInboundAt: new Date(),
    },
  });
  await ctx.db.message.create({
    data: {
      id: newId(),
      organizationId,
      conversationId,
      direction: 'inbound',
      type: 'text',
      body: `Swept ${label}`,
      payload: {},
      provider: 'whatsapp_cloud',
      providerMessageId: `wamid.sweep.${SUFFIX}.${label}`,
      status: 'delivered',
      sentAt: new Date(),
      deliveredAt: new Date(),
      createdAt: new Date(),
    },
  });
  // A **failed** outbound message, because the retry route refuses anything else: aimed at a row in
  // the state the endpoint expects, which is what stops the sweep recording a refusal it never
  // earned — the lesson `POST /calls/:id/outcome` paid for.
  const outboundMessageId = newId();
  await ctx.db.message.create({
    data: {
      id: outboundMessageId,
      organizationId,
      conversationId,
      direction: 'outbound',
      type: 'text',
      body: `Swept reply ${label}`,
      payload: { kind: 'text', text: `Swept reply ${label}` },
      provider: 'whatsapp_cloud',
      status: 'failed',
      errorCode: '131047',
      errorMessage: 'Swept failure',
      failedAt: new Date(),
      sendAttempts: 1,
      createdAt: new Date(),
    },
  });
  const whatsappTemplateId = newId();
  await ctx.db.whatsAppTemplate.create({
    data: {
      id: whatsappTemplateId,
      organizationId,
      accountId: whatsappAccountId,
      name: `swept_${label}_${SUFFIX}`,
      language: 'en',
      category: 'utility',
      status: 'draft',
      components: { body: 'Hello {{1}}' },
      variableMap: { '1': 'lead.firstName' },
    } as never,
  });

  const slaClock = await ctx.db.slaClock.findFirstOrThrow({
    where: { organizationId, leadId: lead.body.data.id },
  });
  const nowForSla = Date.now();
  await ctx.db.slaClock.update({
    where: { id: slaClock.id },
    data: {
      startedAt: new Date(nowForSla - 3_600_000),
      warnAt: new Date(nowForSla - 120_000),
      dueAt: new Date(nowForSla - 60_000),
    },
  });
  const { SlaService } = await import('../src/modules/sla/sla.service.js');
  await ctx.app.get(SlaService).sweep();
  const escalation = await ctx.db.escalation.findFirstOrThrow({
    where: { organizationId, clockId: slaClock.id },
  });

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
    slaPolicyId: slaPolicy.id,
    escalationId: escalation.id,
    callId: dialled.body.data.call.id,
    callOutcomeId: callConfig.body.data.outcomes[0]?.id ?? '',
    formId: form.body.data.id,
    apiKeyId: apiKey.body.data.id,
    payloadId: payload.id,
    webhookEndpointId: webhookEndpoint.body.data.id,
    webhookDeliveryId,
    integrationConnectionId: integrationConnection.body.data.id,
    whatsappNumberId,
    conversationId,
    whatsappAccountId,
    whatsappTemplateId,
    outboundMessageId,
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
   * caller's own record — marking your own notifications read, and setting your own quiet hours. A
   * permission here would have to be one every role holds, which is a permission that decides
   * nothing; and quiet hours in particular must *not* be something a role can withhold, because a
   * person whose employer can stop them silencing midnight notifications has no setting at all.
   *
   * The list is asserted below, so adding an exempt write fails this suite until someone has looked
   * at it. That is the point: this set must never grow silently — and it caught
   * `PATCH /notifications/preferences` on the commit that added it.
   */
  const SELF_SCOPED_WRITES = [
    'POST /notifications/:id/read',
    'POST /notifications/read-all',
    'PATCH /notifications/preferences',
  ];

  /**
   * Writes a **provider** calls, which have no session to carry a permission.
   *
   * Reviewed one at a time, and each authenticated by something other than a token: the email
   * delivery webhook presents `EMAIL_WEBHOOK_SECRET`, which the configuration schema makes
   * mandatory the moment a real driver is set — so there is no deployment in which it is both
   * reachable and unauthenticated. It matters because this endpoint is the only writer of the
   * suppression list, and an open one would let anybody stop a workspace's mail by posting a
   * bounce for its owner's address.
   *
   * Asserted below, so adding a public write fails this suite until somebody has looked at it.
   */
  const PROVIDER_WEBHOOK_WRITES = ['POST /webhooks/email'];

  /**
   * Writes a **member of the public** makes, from a page this product does not control.
   *
   * One route, reviewed on its own terms: a capture form's submit endpoint. Its authentication and
   * its tenant resolution are the same thing — the 32-character random `public_key` in the path,
   * globally unique, rotatable, and floored at 16 characters by `forms_public_key_long_enough` so
   * a short one cannot be stored (ADR-0029). There is no session to carry a permission, and a form
   * whose whole purpose is to be filled in by strangers cannot have one.
   *
   * What keeps it from being a hole: the key must match an **active, undeleted** form (and an
   * inactive one answers 404, exactly as a made-up key does); the submission is rate-limited per
   * form and per address before a row is written; a honeypot drops bots silently; the answers are
   * validated against the form's own field set; and nothing the caller sends can choose the
   * pipeline, the source, the assignment or the owner — those come from the form.
   */
  const PUBLIC_CAPTURE_WRITES = [
    'POST /public/forms/:key/submissions',
    /**
     * The public lead API (`FR-CAP-6`). Authenticated by **three** things rather than a session:
     * the workspace's own public key in the path, an API key in `X-Api-Key`, and an HMAC-SHA256
     * signature over the raw body in `X-Signature` whose timestamp must be within five minutes
     * (ADR-0030). A key is scoped (`ingest:write`), optionally restricted to a list of addresses,
     * rate-limited per minute, revocable and rotatable; a key belonging to another workspace is
     * refused with the same 401 as one that does not exist. Nothing the caller sends chooses the
     * pipeline, the owner or the source — the first two come from the workspace's rules and the
     * third is resolved by name against its own list.
     */
    'POST /public/leads/:organizationPublicKey',
    /**
     * An integration connection's inbound door (Phase 4 step 6). Authenticated by **two** things:
     * the connection's id in the path, and an HMAC-SHA256 signature over the raw body in
     * `X-Signature` whose timestamp must be within five minutes — the same construction and the
     * same five-minute window as the public lead API, with the secret this workspace generated and
     * showed once. There is no session, because the caller is somebody else's server.
     *
     * What keeps it from being a hole: the id alone is **not** a credential — an unsigned request
     * is a 401 whatever id it carries; the id must match a **live** connection of the provider
     * named in the path, and a disconnected one answers the same 404 as a made-up id; and nothing
     * the caller sends chooses the pipeline, the owner or the source — the first two come from the
     * workspace's rules and the third from the connection's own settings, resolved by name against
     * the workspace's own list.
     */
    'POST /wh/:provider/:connectionId',
  ];

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
          !SELF_SCOPED_WRITES.includes(`${route.httpMethod} ${route.path}`) &&
          !PROVIDER_WEBHOOK_WRITES.includes(`${route.httpMethod} ${route.path}`) &&
          !PUBLIC_CAPTURE_WRITES.includes(`${route.httpMethod} ${route.path}`),
      )
      .map((route) => `${route.httpMethod} ${route.path}`);
    expect(unguardedWrites).toEqual([]);
  });

  it('keeps the provider-webhook exemptions honest', () => {
    const routes = audit.collect();
    for (const key of PROVIDER_WEBHOOK_WRITES) {
      const route = routes.find((candidate) => `${candidate.httpMethod} ${candidate.path}` === key);
      expect(route, `${key} is listed as a provider webhook but no longer exists`).toBeDefined();
      // `public`, not `exempt`: there is no caller identity at all, which is a different claim from
      // "the caller is acting on their own record".
      expect(route?.declaration, key).toBe('public');
    }
  });

  it('keeps the public-capture exemptions honest', () => {
    const routes = audit.collect();
    for (const key of PUBLIC_CAPTURE_WRITES) {
      const route = routes.find((candidate) => `${candidate.httpMethod} ${candidate.path}` === key);
      expect(route, `${key} is listed as a public capture but no longer exists`).toBeDefined();
      expect(route?.declaration, key).toBe('public');
      // The key in the path *is* the authentication, so a public capture route that took no
      // parameter would be one anybody could post to without knowing anything at all.
      expect(route?.path.includes(':'), `${key} must identify the form in its path`).toBe(true);
    }
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
      // Phase 3, step 2 — SLA
      '/sla/policies/:id': `/sla/policies/${orgA.slaPolicyId}`,
      '/sla/escalations/:id/acknowledge': `/sla/escalations/${orgA.escalationId}/acknowledge`,
      '/exports/:id/download': `/exports/${orgA.exportJobId}/download`,
      // Phase 3, step 6 — calls
      '/calls/:id': `/calls/${orgA.callId}`,
      '/calls/:id/outcome': `/calls/${orgA.callId}/outcome`,
      '/settings/call-outcomes/:id': `/settings/call-outcomes/${orgA.callOutcomeId}`,
      // Phase 4, step 2 — the public lead API
      '/api-keys/:id': `/api-keys/${orgA.apiKeyId}`,
      '/api-keys/:id/rotate': `/api-keys/${orgA.apiKeyId}/rotate`,
      '/api-keys/:id/revoke': `/api-keys/${orgA.apiKeyId}/revoke`,
      '/ingestion/payloads/:id/replay': `/ingestion/payloads/${orgA.payloadId}/replay`,
      // Phase 4, step 3 — outbound webhooks
      '/webhooks/:id': `/webhooks/${orgA.webhookEndpointId}`,
      '/webhooks/:id/rotate-secret': `/webhooks/${orgA.webhookEndpointId}/rotate-secret`,
      '/webhooks/:id/test': `/webhooks/${orgA.webhookEndpointId}/test`,
      '/webhooks/:id/deliveries': `/webhooks/${orgA.webhookEndpointId}/deliveries`,
      '/webhooks/deliveries/:id/retry': `/webhooks/deliveries/${orgA.webhookDeliveryId}/retry`,
      // Phase 4, step 6 — the integration framework
      '/integrations/:id': `/integrations/${orgA.integrationConnectionId}`,
      '/integrations/:id/check': `/integrations/${orgA.integrationConnectionId}/check`,
      '/integrations/:id/preview': `/integrations/${orgA.integrationConnectionId}/preview`,
      '/integrations/:id/rotate-secret': `/integrations/${orgA.integrationConnectionId}/rotate-secret`,
      '/integrations/:id/disconnect': `/integrations/${orgA.integrationConnectionId}/disconnect`,
      // Phase 4, step 1 — capture forms
      '/forms/:id': `/forms/${orgA.formId}`,
      '/forms/:id/fields': `/forms/${orgA.formId}/fields`,
      '/forms/:id/rotate-key': `/forms/${orgA.formId}/rotate-key`,
      // Phase 5, step 1 — WhatsApp
      '/conversations/:id': `/conversations/${orgA.conversationId}`,
      '/conversations/:id/messages': `/conversations/${orgA.conversationId}/messages`,
      '/conversations/:id/read': `/conversations/${orgA.conversationId}/read`,
      '/whatsapp/numbers/:id': `/whatsapp/numbers/${orgA.whatsappNumberId}`,
      // Phase 5, step 2 — sending
      '/conversations/:id/messages/:messageId/retry': `/conversations/${orgA.conversationId}/messages/${orgA.outboundMessageId}/retry`,
      '/whatsapp/templates/:id': `/whatsapp/templates/${orgA.whatsappTemplateId}`,
      '/whatsapp/templates/:id/preview': `/whatsapp/templates/${orgA.whatsappTemplateId}/preview`,
      '/whatsapp/templates/:id/submit': `/whatsapp/templates/${orgA.whatsappTemplateId}/submit`,
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
      // A connection holds a credential, so "org B reached org A's connection" is the single worst
      // outcome this sweep exists to rule out.
      ['integrationConnectionId', orgA.integrationConnectionId],
      // A conversation is somebody's customer saying something to somebody's business, which is
      // the second-worst thing on this list to get wrong.
      ['conversationId', orgA.conversationId],
      ['whatsappNumberId', orgA.whatsappNumberId],
      ['whatsappTemplateId', orgA.whatsappTemplateId],
      ['outboundMessageId', orgA.outboundMessageId],
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
    // Phase 5, step 1 — WhatsApp
    case '/conversations/:id/read':
      return {};
    case '/whatsapp/accounts':
      return { connectionId: target.integrationConnectionId };
    case '/whatsapp/numbers/:id':
      // Org A's own member, so this request names something of theirs in the body as well as in
      // the path — which is what makes a 200 here a finding rather than a pass.
      return { userId: target.userId };
    case '/conversations/:id/messages':
      return { kind: 'text', body: 'A reply from another workspace' };
    case '/conversations/:id/messages/:messageId/retry':
    case '/whatsapp/templates/:id/submit':
      return {};
    case '/whatsapp/templates':
      return {
        accountId: target.whatsappAccountId,
        name: `cross_tenant_${SUFFIX}`,
        language: 'en',
        category: 'utility',
        components: { body: 'Hello {{1}}' },
        variableMap: { '1': 'lead.firstName' },
      };
    case '/whatsapp/templates/:id':
      return { components: { body: 'Renamed by another tenant' } };
    case '/whatsapp/templates/sync':
      return { accountId: target.whatsappAccountId };
    default:
      return undefined;
  }
}
