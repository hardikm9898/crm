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
