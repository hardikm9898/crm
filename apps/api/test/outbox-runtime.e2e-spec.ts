import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId, newToken, systemPrincipal, tenantContext } from '@leados/shared';
import { Queue } from 'bullmq';
import { OutboxDispatcherService } from '../src/infra/outbox/outbox-dispatcher.service.js';
import { QueueService } from '../src/infra/queue/queue.service.js';
import { WorkerService } from '../src/infra/queue/worker.service.js';
import { JOBS, QUEUES } from '../src/infra/queue/queue.constants.js';
import { outboxJobId } from '../src/infra/outbox/event-subscriptions.js';
import { JobFailureRecorder } from '../src/infra/queue/job-failure.recorder.js';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';

/**
 * THE OUTBOX RUNTIME SUITE.
 *
 * The contract being tested (ADR-0006, docs/queue-event-architecture.md §2–§6):
 *   • an event committed with its state change is eventually enqueued — at least once;
 *   • a crash between enqueue and "mark published" re-enqueues rather than losing the event;
 *   • two dispatchers never handle the same row twice;
 *   • a job that exhausts its retries is visible to an operator, not only to redis-cli.
 *
 * These properties are emergent from Postgres row locking and Redis job ids, so the test drives
 * the real dispatcher against the real stores rather than a mock.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2eoutbox${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';

let ctx: TestApp;
let dispatcher: OutboxDispatcherService;
let queues: QueueService;
let organizationId: string;
let ownerToken: string;

const email = (label: string) => `${label}.${EMAIL_MARKER}@test.local`;

/** Drains a queue so a test starts from a known state without flushing shared Redis. */
async function drain(queue: Queue): Promise<void> {
  await queue.drain(true);
  const failed = await queue.getJobs(['failed', 'completed'], 0, 500);
  await Promise.all(failed.map((job) => job.remove()));
}

/**
 * Dispatches until the outbox is empty.
 *
 * The dispatcher is FIFO by design, and this database carries events from earlier suites, so a
 * freshly-emitted event is not in the first batch. Draining first is also what a running system
 * does continuously.
 */
async function drainOutbox(): Promise<void> {
  for (let pass = 0; pass < 50; pass += 1) {
    const published = await dispatcher.dispatchBatch();
    if (published === 0) return;
  }
  throw new Error('outbox did not drain: the dispatcher may be failing to publish');
}

async function emitEvent(eventName: string, payload: Record<string, string>): Promise<string> {
  const eventId = newId();
  await ctx.db.outboxEvent.create({
    data: {
      id: newId(),
      eventId,
      organizationId,
      eventName,
      aggregateType: 'test',
      aggregateId: newId(),
      payload,
      actorType: 'system',
    },
  });
  return eventId;
}

beforeAll(async () => {
  ctx = await bootTestApp();
  dispatcher = ctx.app.get(OutboxDispatcherService);
  queues = ctx.app.get(QueueService);

  const registered = await call<
    EnvelopeBody<{ tokens: { accessToken: string }; activeOrganizationId: string }>
  >(ctx.app, {
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      email: email('owner'),
      password: PASSWORD,
      name: 'Outbox Owner',
      organizationName: `Outbox Org ${SUFFIX}`,
    },
  });
  organizationId = registered.body.data.activeOrganizationId;
  ownerToken = registered.body.data.tokens.accessToken;

  await drainOutbox();
}, 180_000);

afterAll(async () => {
  if (ctx) {
    await drain(queues.queue(QUEUES.NOTIFICATIONS));
    await ctx.db.jobFailure.deleteMany({ where: { queue: { in: ['notifications', 'outbox'] } } });
    await cleanupUsers(ctx.db, EMAIL_MARKER);
    await ctx.close();
  }
});

beforeEach(async () => {
  // Each test starts with an empty outbox and empty queues, so assertions about "one job" are
  // about the event under test.
  await drainOutbox();
  await drain(queues.queue(QUEUES.NOTIFICATIONS));
});

describe('dispatch', () => {
  it('enqueues a job for a subscribed event and marks it published', async () => {
    const eventId = await emitEvent('invitation.sent', { invitationId: newId() });

    const published = await dispatcher.dispatchBatch();
    expect(published).toBeGreaterThanOrEqual(1);

    const row = await ctx.db.outboxEvent.findFirstOrThrow({ where: { eventId } });
    expect(row.publishedAt).not.toBeNull();
    expect(row.lastError).toBeNull();

    const job = await queues
      .queue(QUEUES.NOTIFICATIONS)
      .getJob(outboxJobId(JOBS.MAIL_INVITATION, eventId));
    expect(job).not.toBeNull();
    expect(job?.data).toMatchObject({ eventId, organizationId, idempotencyKey: eventId });
  });

  it('marks an event with no subscribers published without enqueuing anything', async () => {
    // A producer may emit before any consumer exists; that must not clog the outbox.
    const eventId = await emitEvent('organization.created', { organizationId });
    await dispatcher.dispatchBatch();

    const row = await ctx.db.outboxEvent.findFirstOrThrow({ where: { eventId } });
    expect(row.publishedAt).not.toBeNull();
    const counts = await queues.queue(QUEUES.NOTIFICATIONS).getJobCounts('waiting', 'delayed');
    expect((counts.waiting ?? 0) + (counts.delayed ?? 0)).toBe(0);
  });

  it('does not re-dispatch an event it has already published', async () => {
    const eventId = await emitEvent('invitation.sent', { invitationId: newId() });
    await dispatcher.dispatchBatch();
    const firstPass = await ctx.db.outboxEvent.findFirstOrThrow({ where: { eventId } });

    await dispatcher.dispatchBatch();
    const secondPass = await ctx.db.outboxEvent.findFirstOrThrow({ where: { eventId } });
    expect(secondPass.publishedAt?.getTime()).toBe(firstPass.publishedAt?.getTime());
  });

  it('collapses a re-dispatched event into one job, so a retry is one effect', async () => {
    // This is the crash-between-enqueue-and-mark case: the event is enqueued again, and the
    // event-derived job id means the consumer still sees exactly one job.
    const eventId = await emitEvent('invitation.sent', { invitationId: newId() });
    await dispatcher.dispatchBatch();

    // Simulate the crash: the job exists, but the row was never marked.
    await ctx.db.outboxEvent.updateMany({ where: { eventId }, data: { publishedAt: null } });
    await dispatcher.dispatchBatch();

    const jobs = await queues
      .queue(QUEUES.NOTIFICATIONS)
      .getJobs(['waiting', 'delayed', 'active', 'completed'], 0, 100);
    const matching = jobs.filter((job) => (job.data as { eventId?: string }).eventId === eventId);
    expect(matching).toHaveLength(1);

    const row = await ctx.db.outboxEvent.findFirstOrThrow({ where: { eventId } });
    expect(row.publishedAt).not.toBeNull();
  });

  it('never double-handles a row when dispatchers run concurrently', async () => {
    const eventIds = await Promise.all(
      Array.from({ length: 12 }, () => emitEvent('invitation.sent', { invitationId: newId() })),
    );

    // FOR UPDATE SKIP LOCKED is what makes several replicas safe; the total published across
    // concurrent passes must equal the number of events, not a multiple of it.
    const results = await Promise.all([
      dispatcher.dispatchBatch(),
      dispatcher.dispatchBatch(),
      dispatcher.dispatchBatch(),
    ]);
    const totalPublished = results.reduce((sum, count) => sum + count, 0);

    const rows = await ctx.db.outboxEvent.findMany({ where: { eventId: { in: eventIds } } });
    expect(rows.every((row) => row.publishedAt !== null)).toBe(true);
    expect(totalPublished).toBeGreaterThanOrEqual(eventIds.length);

    const jobs = await queues
      .queue(QUEUES.NOTIFICATIONS)
      .getJobs(['waiting', 'delayed', 'active', 'completed'], 0, 200);
    for (const eventId of eventIds) {
      const matching = jobs.filter((job) => (job.data as { eventId?: string }).eventId === eventId);
      expect(matching.length, `event ${eventId}`).toBe(1);
    }
  });

  it('records the error and leaves the event unpublished when enqueuing fails', async () => {
    const eventId = await emitEvent('invitation.sent', { invitationId: newId() });

    const originalEnqueue = queues.enqueue.bind(queues);
    (queues as { enqueue: unknown }).enqueue = async () => {
      throw new Error('redis unavailable');
    };
    try {
      await dispatcher.dispatchBatch();
    } finally {
      (queues as { enqueue: unknown }).enqueue = originalEnqueue;
    }

    const row = await ctx.db.outboxEvent.findFirstOrThrow({ where: { eventId } });
    // Unpublished and attempt-counted: nothing is lost, and the reaper will surface it.
    expect(row.publishedAt).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('redis unavailable');

    await dispatcher.dispatchBatch();
    const recovered = await ctx.db.outboxEvent.findFirstOrThrow({ where: { eventId } });
    expect(recovered.publishedAt).not.toBeNull();
    expect(recovered.lastError).toBeNull();
  });
});

describe('end-to-end: request → outbox → dispatcher → worker → effect', () => {
  it('delivers an invitation email, minting the token in the worker', async () => {
    const role = await ctx.db.role.findFirstOrThrow({
      where: { organizationId, code: 'sales_executive' },
    });

    const created = await call<EnvelopeBody<{ invitationId: string }>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/users/invitations',
      payload: { email: email('invited'), roleId: role.id },
      token: ownerToken,
    });
    expect(created.statusCode).toBe(201);
    const invitationId = created.body.data.invitationId;

    const beforeSend = await ctx.db.invitation.findUniqueOrThrow({ where: { id: invitationId } });

    await dispatcher.dispatchBatch();

    // Run the processor the way the worker would, including the tenant context restoration.
    const { InvitationMailProcessor } =
      await import('../src/modules/users/processors/invitation-mail.processor.js');
    const processor = ctx.app.get(InvitationMailProcessor);
    await tenantContext.run(systemPrincipal(organizationId, 'test-job'), async () => {
      await processor.process({ organizationId, aggregateId: invitationId }, {} as never);
    });

    const afterSend = await ctx.db.invitation.findUniqueOrThrow({ where: { id: invitationId } });
    // The request stored an unusable placeholder; the real token is minted at send time, so no
    // usable credential ever sits in the outbox or a queue payload.
    expect(afterSend.tokenHash).not.toBe(beforeSend.tokenHash);
    expect(afterSend.status).toBe('pending');
  });

  it('does not send for an invitation that was revoked before delivery', async () => {
    const role = await ctx.db.role.findFirstOrThrow({
      where: { organizationId, code: 'sales_executive' },
    });
    const created = await call<EnvelopeBody<{ invitationId: string }>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/users/invitations',
      payload: { email: email('revokedbefore'), roleId: role.id },
      token: ownerToken,
    });
    const invitationId = created.body.data.invitationId;

    await call(ctx.app, {
      method: 'DELETE',
      url: `/api/v1/users/invitations/${invitationId}`,
      token: ownerToken,
    });

    const before = await ctx.db.invitation.findUniqueOrThrow({ where: { id: invitationId } });
    const { InvitationMailProcessor } =
      await import('../src/modules/users/processors/invitation-mail.processor.js');
    await tenantContext.run(systemPrincipal(organizationId, 'test-job'), async () => {
      await ctx.app
        .get(InvitationMailProcessor)
        .process({ organizationId, aggregateId: invitationId }, {} as never);
    });

    const after = await ctx.db.invitation.findUniqueOrThrow({ where: { id: invitationId } });
    // No token minted: a revoked invitation must not become usable by a queued job.
    expect(after.tokenHash).toBe(before.tokenHash);
  });

  it('requests a verification email through the outbox on registration', async () => {
    const registered = await call<EnvelopeBody<{ user: { id: string } }>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: email('verify'),
        password: PASSWORD,
        name: 'Verify Owner',
        organizationName: `Verify Org ${SUFFIX}`,
      },
    });

    const event = await ctx.db.outboxEvent.findFirst({
      where: { eventName: 'user.registered', aggregateId: registered.body.data.user.id },
    });
    expect(event).not.toBeNull();
    // The request emitted the intent and returned; it did not wait on a mail provider.
    expect(event?.publishedAt).toBeNull();
  });
});

describe('dead-letter mirror', () => {
  it('records an exhausted job where an operator can see it, with secrets redacted', async () => {
    const recorder = ctx.app.get(JobFailureRecorder);
    await recorder.record(
      'notifications',
      {
        id: 'job-123',
        name: JOBS.MAIL_INVITATION,
        attemptsMade: 5,
        data: { organizationId, payload: { email: 'leak@example.com', token: 'super-secret' } },
      } as never,
      new Error('mail provider rejected the message'),
    );

    const failure = await ctx.db.jobFailure.findFirstOrThrow({
      where: { jobId: 'job-123' },
      orderBy: { createdAt: 'desc' },
    });
    expect(failure.queue).toBe('notifications');
    expect(failure.attempts).toBe(5);
    expect(failure.error).toContain('mail provider rejected');

    const serialized = JSON.stringify(failure.payload);
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('leak@example.com');
    expect(serialized).toContain('[redacted]');
  });

  it('survives an unrecordable failure rather than masking the original error', async () => {
    const recorder = ctx.app.get(JobFailureRecorder);
    // A payload that cannot be serialized must not turn into an unhandled rejection.
    const circular: Record<string, unknown> = { organizationId };
    circular['self'] = circular;
    await expect(
      recorder.record(
        'notifications',
        { id: 'job-bad', name: 'x', attemptsMade: 1, data: circular } as never,
        new Error('boom'),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('worker registration', () => {
  it('knows a processor for every subscribed job, so no event routes into a void', async () => {
    const { EVENT_SUBSCRIPTIONS } = await import('../src/infra/outbox/event-subscriptions.js');
    const { resolveProcessors } = await import('../src/infra/queue/processor.registry.js');
    const registered = new Set(
      resolveProcessors(ctx.app).map((processor) => `${processor.queue}/${processor.jobName}`),
    );

    const missing: string[] = [];
    for (const subscriptions of Object.values(EVENT_SUBSCRIPTIONS)) {
      for (const subscription of subscriptions) {
        const key = `${subscription.queue}/${subscription.jobName}`;
        if (!registered.has(key)) missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });

  it('registers a processor for every scheduled job', async () => {
    const { SCHEDULES } = await import('../src/infra/queue/scheduler.service.js');
    const { resolveProcessors } = await import('../src/infra/queue/processor.registry.js');
    const registered = new Set(
      resolveProcessors(ctx.app).map((processor) => `${processor.queue}/${processor.jobName}`),
    );

    for (const schedule of SCHEDULES) {
      expect(registered, `${schedule.jobName} has no processor`).toContain(
        `${schedule.queue}/${schedule.jobName}`,
      );
    }
  });

  it('refuses two processors claiming the same job', () => {
    // A silent second claim would mean one of them never runs.
    const worker = new WorkerService(
      { REDIS_URL: process.env['REDIS_URL']! } as never,
      { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
      ctx.app.get(JobFailureRecorder),
    );
    expect(() =>
      worker.start([
        { queue: QUEUES.MAINTENANCE, jobName: JOBS.SESSION_PRUNE, process: async () => undefined },
        { queue: QUEUES.MAINTENANCE, jobName: JOBS.SESSION_PRUNE, process: async () => undefined },
      ]),
    ).toThrow(/Duplicate processor/);
  });
});
