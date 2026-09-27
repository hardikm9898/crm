import { describeError, request } from '@/lib/api';
import { can, readAccessToken, requireCurrentUser } from '@/lib/session';
import { Badge, Card, EmptyState, ErrorNotice, PageHeader } from '@/components/ui';

/**
 * Roles and what they may do.
 *
 * Roles are rows, not code: a workspace can rename "Sales Executive", invent "Telecaller", or give a
 * branch manager organization-wide reporting, and no deployment is involved (rule 4). This screen
 * shows the catalogue grouped by module, with each role's scope per permission — because "can read
 * leads" means something very different at `own` than at `organization`.
 */
interface RoleDetail {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  isEditable: boolean;
  memberCount: number;
  grants: { permission: string; scope: string }[];
}

interface PermissionDetail {
  key: string;
  description: string;
  supportsScope: boolean;
}

/** The catalogue arrives already grouped by module, which is the order this table wants. */
interface PermissionModule {
  module: string;
  permissions: PermissionDetail[];
}

export default async function RolesPage() {
  const user = await requireCurrentUser();
  const token = await readAccessToken();

  let roles: RoleDetail[] = [];
  let modules: PermissionModule[] = [];
  let error: string | null = null;
  try {
    const [roleResponse, permissionResponse] = await Promise.all([
      request<RoleDetail[]>('/roles', { token }),
      request<{ modules: PermissionModule[] }>('/permissions', { token }),
    ]);
    roles = asArray<RoleDetail>(roleResponse.data);
    modules = permissionResponse.data.modules ?? [];
  } catch (failure) {
    error = describeError(failure);
  }

  return (
    <>
      <PageHeader
        title="Roles"
        description="What each role may do, and how widely. Editing roles from this screen arrives with the CRM permissions matrix; for now it shows exactly what the API enforces."
      />

      {error && <ErrorNotice>{error}</ErrorNotice>}

      <div className="flex flex-col gap-5">
        <Card title="Roles in this workspace" description={`${roles.length} defined`}>
          {roles.length === 0 ? (
            <EmptyState title="No roles yet" />
          ) : (
            <ul className="flex flex-col divide-y divide-[var(--color-border)]">
              {roles.map((role) => (
                <li key={role.id} className="flex flex-wrap items-baseline gap-2 py-2.5">
                  <span className="text-sm font-medium">{role.name}</span>
                  <code className="text-xs text-[var(--color-text-muted)]">{role.code}</code>
                  {role.isSystem && <Badge>Built in</Badge>}
                  {!role.isEditable && <Badge tone="warning">Locked</Badge>}
                  <span className="ml-auto text-xs text-[var(--color-text-muted)]">
                    {role.memberCount === 1 ? '1 person' : `${role.memberCount} people`} ·{' '}
                    {role.grants.length} permissions
                  </span>
                  {role.description && (
                    <p className="w-full text-sm text-[var(--color-text-muted)]">
                      {role.description}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        {modules.length > 0 && roles.length > 0 && (
          <Card
            title="Permission matrix"
            description="A blank cell means the role cannot do it at all; otherwise the cell is the widest set of records it applies to."
          >
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)]">
                    <th
                      scope="col"
                      className="sticky left-0 bg-[var(--color-surface-raised)] py-2 pr-4 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]"
                    >
                      Permission
                    </th>
                    {roles.map((role) => (
                      <th
                        key={role.id}
                        scope="col"
                        className="py-2 pr-4 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]"
                      >
                        {role.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {modules.map((group) => (
                    <PermissionGroup
                      key={group.module}
                      module={group.module}
                      permissions={group.permissions}
                      roles={roles}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {!can(user, 'role:manage') && (
          <p className="text-sm text-[var(--color-text-muted)]">
            You can see roles but not change them. That needs the “manage roles” permission.
          </p>
        )}
      </div>
    </>
  );
}

function PermissionGroup({
  module,
  permissions,
  roles,
}: {
  module: string;
  permissions: PermissionDetail[];
  roles: RoleDetail[];
}) {
  return (
    <>
      <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface-muted)]">
        <th
          scope="colgroup"
          colSpan={roles.length + 1}
          className="py-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]"
        >
          {module}
        </th>
      </tr>
      {permissions.map((permission) => (
        <tr key={permission.key} className="border-b border-[var(--color-border)]">
          <th
            scope="row"
            className="sticky left-0 bg-[var(--color-surface-raised)] py-2 pr-4 text-left font-normal"
          >
            <span title={permission.description}>{permission.key}</span>
          </th>
          {roles.map((role) => {
            const grant = role.grants.find((entry) => entry.permission === permission.key);
            return (
              <td key={role.id} className="py-2 pr-4">
                {grant ? (
                  <span className="text-xs text-[var(--color-text-muted)]">
                    {permission.supportsScope ? grant.scope : 'yes'}
                  </span>
                ) : (
                  <span aria-label="not granted" className="text-[var(--color-text-muted)]/50">
                    —
                  </span>
                )}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}

function asArray<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  const items = (payload as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? (items as T[]) : [];
}
