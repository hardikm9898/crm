import { describeError, request } from '@/lib/api';
import { can, readAccessToken, requireCurrentUser } from '@/lib/session';
import {
  Badge,
  Card,
  DataTable,
  EmptyState,
  ErrorNotice,
  PageHeader,
  StatCard,
} from '@/components/ui';
import { InviteForm } from './invite-form';
import { InvitationActions } from './invitation-actions';
import { MemberRoles } from './member-roles';

/**
 * The people in the workspace.
 *
 * What this page shows depends on the caller's data scope, not on a filter chosen here: a branch
 * manager's `user:read` grant is scoped to their branch, so the API returns their branch and the
 * page renders whatever it gets. That is the point of scoping being server-side — there is no client
 * filter to forget (docs/security.md §4).
 */
interface MemberRow {
  userId: string;
  membershipId: string;
  name: string;
  email: string;
  status: string;
  isOwner: boolean;
  branchId: string | null;
  teamIds: string[];
  roles: { id: string; code: string; name: string }[];
  lastLoginAt: string | null;
  joinedAt: string | null;
}

interface InvitationRow {
  id: string;
  email: string;
  roleId: string;
  status: string;
  expiresAt: string;
  createdAt: string;
}

interface RoleRow {
  id: string;
  code: string;
  name: string;
  isSystem: boolean;
  memberCount: number;
}

export default async function MembersPage() {
  const user = await requireCurrentUser();
  const token = await readAccessToken();
  const mayManage = can(user, 'user:manage');

  // Seat usage is deliberately organization-wide, so the API requires an organization-scoped
  // `user:read` grant. Asking for it with a branch-scoped grant would earn a 403, so the request is
  // only made when the reported scope allows it.
  const maySeeSeats = can(user, 'user:read') && user.scopes['user:read'] === 'organization';

  const [members, seats, invitations, roles] = await Promise.all([
    load<unknown>('/users?limit=50', token),
    maySeeSeats
      ? load<{ used: number; limit: number | null; pendingInvitations: number }>(
          '/users/seats',
          token,
        )
      : skipped<{ used: number; limit: number | null; pendingInvitations: number }>(),
    mayManage ? load<unknown>('/users/invitations', token) : skipped<unknown>(),
    // Role names are needed to label an invitation; reading roles needs its own permission.
    can(user, 'role:read') ? load<unknown>('/roles', token) : skipped<unknown>(),
  ]);

  const memberRows = asItems<MemberRow>(members.data);
  const invitationRows = asItems<InvitationRow>(invitations.data);
  const roleRows = asItems<RoleRow>(roles.data);
  const roleNameById = new Map(roleRows.map((role) => [role.id, role.name]));

  return (
    <>
      <PageHeader
        title="People"
        description={
          mayManage
            ? 'Invite people, change what they may do, and suspend access when someone leaves.'
            : 'The people you have access to see.'
        }
      />

      {members.error && <ErrorNotice>{members.error}</ErrorNotice>}

      {seats.data && (
        <div className="mb-5 grid gap-3 sm:grid-cols-3">
          <StatCard
            label="Seats used"
            value={
              seats.data.limit === null ? seats.data.used : `${seats.data.used}/${seats.data.limit}`
            }
            hint={seats.data.limit === null ? 'Unlimited on this plan' : 'Active members'}
          />
          <StatCard label="Invitations pending" value={seats.data.pendingInvitations} />
          <StatCard label="Roles defined" value={roleRows.length} />
        </div>
      )}

      <div className="flex flex-col gap-5">
        <Card title="Members" description={`${memberRows.length} shown`}>
          {memberRows.length === 0 ? (
            <EmptyState
              title="Nobody to show"
              description={
                mayManage
                  ? 'Invite your first colleague below.'
                  : 'Your access covers only your own record so far.'
              }
            />
          ) : (
            <DataTable columns={['Person', 'Roles', 'Status', 'Last signed in']}>
              {memberRows.map((member) => (
                <tr key={member.membershipId} className="align-top">
                  <td className="py-2.5 pr-4">
                    <p className="font-medium">
                      {member.name}
                      {member.isOwner && (
                        <span className="ml-2">
                          <Badge>Owner</Badge>
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-[var(--color-text-muted)]">{member.email}</p>
                  </td>
                  <td className="py-2.5 pr-4">
                    {mayManage && roleRows.length > 0 ? (
                      <MemberRoles
                        userId={member.userId}
                        name={member.name}
                        status={member.status}
                        isSelf={member.userId === user.user.id}
                        assignedRoleIds={member.roles.map((role) => role.id)}
                        roles={roleRows.map((role) => ({ id: role.id, name: role.name }))}
                      />
                    ) : (
                      <span className="text-sm">
                        {member.roles.map((role) => role.name).join(', ') || '—'}
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 pr-4">
                    <Badge tone={member.status === 'active' ? 'success' : 'warning'}>
                      {member.status}
                    </Badge>
                  </td>
                  <td className="numeric py-2.5 pr-4 text-xs text-[var(--color-text-muted)]">
                    {formatDateTime(member.lastLoginAt)}
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </Card>

        {mayManage && (
          <Card
            title="Invite someone"
            description="They receive a link that expires in 72 hours. A pending invitation holds a seat."
          >
            {roleRows.length === 0 ? (
              <EmptyState
                title="No roles to assign"
                description="Define a role first — an invitation has to grant something."
              />
            ) : (
              <InviteForm roles={roleRows.map((role) => ({ id: role.id, name: role.name }))} />
            )}
          </Card>
        )}

        {mayManage && (
          <Card title="Pending invitations" description={`${invitationRows.length} outstanding`}>
            {invitations.error && <ErrorNotice>{invitations.error}</ErrorNotice>}
            {invitationRows.length === 0 ? (
              <EmptyState title="No invitations outstanding" />
            ) : (
              <DataTable columns={['Email', 'Role', 'Expires', '']}>
                {invitationRows.map((invitation) => (
                  <tr key={invitation.id}>
                    <td className="py-2.5 pr-4">{invitation.email}</td>
                    <td className="py-2.5 pr-4">{roleNameById.get(invitation.roleId) ?? '—'}</td>
                    <td className="numeric py-2.5 pr-4 text-xs text-[var(--color-text-muted)]">
                      {formatDateTime(invitation.expiresAt)}
                    </td>
                    <td className="py-2.5 pr-4 text-right">
                      <InvitationActions invitationId={invitation.id} email={invitation.email} />
                    </td>
                  </tr>
                ))}
              </DataTable>
            )}
          </Card>
        )}
      </div>
    </>
  );
}

/**
 * One list failing must not take the page with it: a 403 on seats (a plan-limited endpoint) is a
 * reason to hide one card, not to show an error page instead of the member list.
 */
async function load<T>(
  path: string,
  token: string | null,
): Promise<{ data: T | null; error: string | null }> {
  if (!token) return { data: null, error: 'Please sign in again.' };
  try {
    const response = await request<T>(path, { token });
    return { data: response.data, error: null };
  } catch (error) {
    return { data: null, error: describeError(error) };
  }
}

/**
 * Collections come back as `data: [...]` with pagination in `meta` (docs/api-architecture.md §2),
 * so an array *is* the payload; the `{ items }` shape only survives for endpoints that add fields
 * alongside the list.
 */
function skipped<T>(): { data: T | null; error: string | null } {
  return { data: null, error: null };
}

function asItems<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  const items = (payload as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? (items as T[]) : [];
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
}
