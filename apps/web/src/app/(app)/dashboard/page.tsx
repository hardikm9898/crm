import Link from 'next/link';
import { request, describeError } from '@/lib/api';
import { readAccessToken, requireCurrentUser, can } from '@/lib/session';
import { Badge, Card, EmptyState, PageHeader, StatCard } from '@/components/ui';
import { onboardingProgress, type OnboardingState } from '@/lib/onboarding';

/**
 * The dashboard.
 *
 * In Phase 1 there are no leads yet, so this shows what genuinely exists — the workspace, its plan,
 * its people, and what is left to finish setting up. It deliberately does not render placeholder
 * charts of invented numbers: a dashboard that lies about having data is worse than one that admits
 * the CRM arrives in Phase 2.
 */
interface OrganizationSummary {
  name: string;
  slug: string;
  timezone: string;
  defaultCurrency: string;
  status: string;
  onboarding: OnboardingState | null;
  counts: { branches: number; teams: number; activeMembers: number };
  subscription: {
    status: string;
    planCode: string;
    planName: string;
    trialEndsAt: string | null;
    currentPeriodEnd: string | null;
  } | null;
}

export default async function DashboardPage() {
  const user = await requireCurrentUser();
  const token = await readAccessToken();

  // The dashboard is readable by everyone who can sign in; the organization card is only fetched
  // for someone allowed to read it, so a sales executive gets a working page rather than a 403.
  let organization: OrganizationSummary | null = null;
  let organizationError: string | null = null;
  if (token && can(user, 'organization:read')) {
    try {
      const response = await request<OrganizationSummary>('/organization', { token });
      organization = response.data;
    } catch (error) {
      organizationError = describeError(error);
    }
  }

  const activeOrganization = user.organizations.find(
    (candidate) => candidate.id === user.activeOrganizationId,
  );
  const progress = onboardingProgress(organization?.onboarding ?? null);
  const setupComplete = progress.every((entry) => entry.status === 'done');

  return (
    <>
      <PageHeader
        title={`Good to see you, ${user.user.name.split(' ')[0] ?? user.user.name}`}
        description={
          organization
            ? `${organization.name} · ${organization.timezone} · ${organization.defaultCurrency}`
            : (activeOrganization?.name ?? 'Your workspace')
        }
      />

      {!user.user.emailVerified && (
        <div className="mb-5 rounded-[var(--radius-card)] border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-4 py-3 text-sm">
          Your email address is not confirmed yet. Check your inbox for the confirmation link — some
          features stay locked until it is.
        </div>
      )}

      {organizationError && (
        <div className="mb-5 rounded-[var(--radius-card)] border border-[var(--color-border)] px-4 py-3 text-sm text-[var(--color-text-muted)]">
          {organizationError}
        </div>
      )}

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="People"
          value={organization?.counts.activeMembers ?? '—'}
          hint="Active members"
        />
        <StatCard label="Branches" value={organization?.counts.branches ?? '—'} />
        <StatCard label="Teams" value={organization?.counts.teams ?? '—'} />
        <StatCard
          label="Plan"
          value={organization?.subscription?.planName ?? '—'}
          hint={organization?.subscription?.status ?? undefined}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card
          title="Finish setting up"
          description="Each step unlocks part of the product."
          action={
            can(user, 'organization:manage') ? (
              <Link href="/settings" className="text-sm text-[var(--color-primary)]">
                Open settings
              </Link>
            ) : undefined
          }
        >
          {organization === null ? (
            <EmptyState
              title="Setup is managed by an administrator"
              description="Ask whoever owns this workspace to finish the remaining steps."
            />
          ) : setupComplete ? (
            <EmptyState
              title="Setup is complete"
              description="Leads, pipelines and the WhatsApp inbox arrive in the next phases."
            />
          ) : (
            <ul className="flex flex-col gap-2.5">
              {progress.map(({ step, status }) => (
                <li key={step.key} className="flex items-start justify-between gap-3 text-sm">
                  <span
                    className={status === 'done' ? 'text-[var(--color-text-muted)]' : undefined}
                  >
                    {step.label}
                  </span>
                  {status === 'done' ? (
                    <Badge tone="success">Done</Badge>
                  ) : status === 'current' ? (
                    <Badge tone="warning">Next</Badge>
                  ) : (
                    <Badge>To do</Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="What you can do here" description="Shaped by the access you have been given.">
          <ul className="flex flex-col gap-1.5 text-sm">
            {SUMMARY_LINES.filter((line) => can(user, line.permission)).map((line) => (
              <li key={line.permission} className="flex items-baseline justify-between gap-3">
                <span>{line.label}</span>
                <span className="text-xs text-[var(--color-text-muted)]">
                  {user.scopes[line.permission] ?? 'organization'}
                </span>
              </li>
            ))}
            {SUMMARY_LINES.every((line) => !can(user, line.permission)) && (
              <EmptyState
                title="No management access yet"
                description="Your role covers day-to-day work rather than workspace settings."
              />
            )}
          </ul>
        </Card>
      </div>
    </>
  );
}

const SUMMARY_LINES = [
  { permission: 'user:read', label: 'See the people in this workspace' },
  { permission: 'user:manage', label: 'Invite people and change their access' },
  { permission: 'role:manage', label: 'Define roles and what they may do' },
  { permission: 'branch:manage', label: 'Manage branches' },
  { permission: 'team:manage', label: 'Manage teams' },
  { permission: 'organization:manage', label: 'Change workspace settings' },
  { permission: 'billing:manage', label: 'Manage the subscription' },
] as const;
